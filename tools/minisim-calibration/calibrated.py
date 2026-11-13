"""A minisim Spec calibrated to the workshop V4 CA1 recording (prerecorded/raw).

Built only through minisim's public API: ``build_spec(miniscope_v4(), ca1(), ...)``
with field overrides via ``model_copy``. Nothing in minisim itself changes. The
calibrated full-frame (600 x 600 px, the DAQ frame size) spec is stored as
``ca1_workshop_calibrated.spec.json`` next to this file; :func:`calibrated_spec`
loads it and adjusts sampling, size and motion.

``ca1_workshop_v2.spec.json`` (``calibrated_spec(..., version="v2")``) keeps v1's
optics, sensor, illumination, vessels and motion, and recalibrates the cells and
background to the real recording's activity: Markov bursts with long bouts (per-cell
peak SNR, event rate and event widths of cala's traces), a lower cell density (cells
found in 2 min), activity-driven bleaching with fast recovery (the first minute's
dimming), and a broader, mostly global neuropil whose fluctuation matches the real
frame-mean wander. v1 stays as it is for the motion fixtures.

Regenerate the JSONs with ``python calibrated.py`` (v1) and ``python calibrated.py
v2``. See ``CALIBRATION.md`` for the target numbers and what was matched.

Needs a minisim that has the ``"miniscope"`` brain-motion model (PR #33,
``feat/realistic-motion``).
"""

from __future__ import annotations

import math
from pathlib import Path

from minisim import Spec, presets
from minisim.spec import Bleaching, CellActivity, Sensor

HERE = Path(__file__).resolve().parent
SPEC_JSON = HERE / "ca1_workshop_calibrated.spec.json"
SPEC_V2_JSON = HERE / "ca1_workshop_v2.spec.json"

N_PX = 600  # the workshop DAQ frames are 600 x 600 (V4 sensor windowed from 608)
FPS = 20.0

# --- the calibrated values (everything else = miniscope_v4() / ca1() defaults) ---
# Target: the first 300 frames of prerecorded/raw/0.avi (CALIBRATION.md has the
# table). Values marked * are the ones that moved the registration statistics.
#
# * Sensor gain. Real noise-vs-brightness (variance = slope*mean + intercept over
#   the frame-difference variance) has slope 0.12-0.13 grey levels per e- (0.117-0.16
#   across the session); the library default of 1 ADU/e- gave ~7x too much shot
#   noise. Read noise is set from the intercept: 0.12^2 * 12.5^2 + 1/12 ~ 2.3 grey^2.
GAIN_ADU_PER_E = 0.12
READ_NOISE_E = 12.5
# * Photons per unit, scaled up with the lower gain so grey levels stay real
#   (centre ~118, mean inside the FOV ~80 early in the session).
PHOTONS_PER_UNIT = 6500.0
# * Cell baseline. f0 = 1 makes a burst a dF/F of ~10 and leaves almost no static
#   cell structure in the mean image; f0 = 8 puts a single spike at dF/F ~0.1 and
#   gives the bright, static somata that dominate the real registration band.
#   A wider cell-to-cell expression spread (CV 0.3 -> 0.6) gives the few very
#   bright static cells the real mean image has.
F0 = 8.0
BRIGHTNESS_CV = 0.6
# * Neuropil haze 0.4 -> 0.25: at 0.4 the diffuse haze made the frame ~35% brighter
#   than real for the same cell structure (extra shot noise, too little contrast).
NEUROPIL_AMPLITUDE = 0.25
# Field of view: the GRIN aperture is round and the bright centre is off-centre.
# Both falloffs go to 0 at the farthest corner (exponent 2.5, fitted to the real
# radial profile), centred (+21, +67) um = (12.9, 40.3) px off the frame centre
# (fitted to the real mean image).
FALLOFF_EXPONENT = 2.5
FIELD_CENTER_OFFSET_UM = (21.3, 66.7)
LEAKAGE_LEVEL = 0.08  # library default, unchanged
# * Focal plane pinned (default "auto"). "auto" picks the plane that maximizes the
#   detectable-cell yield, which depends on the activity over the whole recording
#   (the trace's max under minisim 1.0.3, its transient energy under 1.1.0): a 15 s sim resolved to ~183 um and a 2-min one to ~230 um, which
#   defocuses the cells and cuts the static content ~8x. 180 um (effective depth,
#   field curvature included) is what the short calibration runs resolved to.
FOCAL_DEPTH_UM = 180.0


def _build(n_px: int = N_PX, **over) -> Spec:
    """The calibrated spec at full frame (``over`` overrides the module constants)."""
    p = dict(
        gain=GAIN_ADU_PER_E,
        read_noise=READ_NOISE_E,
        ppu=PHOTONS_PER_UNIT,
        f0=F0,
        cv=BRIGHTNESS_CV,
        exponent=FALLOFF_EXPONENT,
        offset=FIELD_CENTER_OFFSET_UM,
        leak=LEAKAGE_LEVEL,
        neuropil=NEUROPIL_AMPLITUDE,
        focal=FOCAL_DEPTH_UM,
    )
    p.update(over)
    scope = presets.miniscope_v4()
    field = dict(
        falloff=0.0, exponent=p["exponent"], center_offset_um=tuple(p["offset"])
    )
    assert (
        scope.illumination is not None
        and scope.vignette is not None
        and scope.leakage is not None
    )
    scope = scope.model_copy(
        update={
            "image_sensor": scope.image_sensor.model_copy(
                update={
                    "n_px_height": n_px,
                    "n_px_width": n_px,
                    "gain_adu_per_e": p["gain"],
                    "read_noise_e": p["read_noise"],
                }
            ),
            "illumination": scope.illumination.model_copy(update=field),
            "vignette": scope.vignette.model_copy(update=field),
            "leakage": scope.leakage.model_copy(update={"level": p["leak"]}),
            "photons_per_unit": p["ppu"],
            "focal_depth_in_tissue_um": p["focal"],
        }
    )
    region = presets.ca1()
    assert region.neuropil is not None
    region = region.model_copy(
        update={
            "neuropil": region.neuropil.model_copy(update={"amplitude": p["neuropil"]})
        }
    )
    return presets.build_spec(
        scope,
        region,
        duration_s=120.0,
        fps=FPS,
        seed=0,
        activity=CellActivity(f0=p["f0"], brightness_cv=p["cv"]),
        sensor=Sensor(photons_per_unit=p["ppu"]),
        extra_steps=[presets.realistic_motion()],
    )


# --- v2: activity and background (CALIBRATION.md, "v2"). The targets are measured
# on cala's own traces (discover_eval + activity_stats.py) of 2-min windows of the
# real recording, so the cell selection and the trace model match on both sides.
#
# * Markov bursts with long bouts. The mean bout is 1/0.02 = 50 frames (2.5 s,
#   geometric, so a minority are multi-second plateaus: ~12 % of events are wider
#   than 2 s at half height, as in real CA1 traces) at 18 Hz in-bout. A bout starts
#   every ~25 s per cell, over a sparse 0.05 Hz single-spike background. v1's 0.17 s
#   bouts at 150 Hz made 25-spike bursts and twice the real peak SNR and event rate.
# * tau_decay 0.7 s (v1 0.5): the real half-height widths and decays run slightly
#   longer than v1's.
# * brightness_cv 0.9 (v1 0.6): the real peak-SNR spread across cells is wider.
V2_ACTIVITY = dict(
    p_quiescent_to_active=0.002,
    p_active_to_quiescent=0.02,
    active_rate_hz=18.0,
    quiescent_rate_hz=0.05,
    tau_decay_s=0.7,
    brightness_cv=0.9,
)
# * 3/4 of v1's cell density: a 2-min window then yields as many cala cells as real.
V2_DENSITY_SCALE = 0.75
# * Bleaching with fast recovery: the real frame dims ~9 % over the first minute
#   and then holds. The 33 s turnover is not protein turnover. It stands in for the
#   reversible (dark-state) part of 1p bleaching: B settles at ~0.88 within ~1 min,
#   and lower for bright, central, busy cells.
V2_BLEACHING = dict(
    bleach_susceptibility=6.3e-6, turnover_tau_s=33.0, excitation_intensity=100.0
)
# * Neuropil: the real background is ~90 % one global mode plus a smooth field with
#   a ~100-120 px (1/e) correlation length, and the frame mean wanders 1.4-1.8 %
#   (1 s means). sigma 190 um gives a ~95-100 px residual field, and 5 components
#   leave ~5 % of the variance local. Coupling 0.85 brings the frame-mean wander
#   down from ~4 % to ~1.5 %.
V2_NEUROPIL = dict(spatial_sigma_um=190.0, n_components=5, population_coupling=0.85)


def _build_v2(base: Spec | None = None) -> Spec:
    """The v2 spec: the v1 JSON with the activity and background above."""
    if base is None:
        base = Spec.model_validate_json(SPEC_JSON.read_text())
    steps = []
    for st in base.steps:
        if st.kind == "place_neurons":
            pops = [
                p.model_copy(
                    update={"density_per_mm3": p.density_per_mm3 * V2_DENSITY_SCALE}
                )
                for p in st.populations
            ]
            st = st.model_copy(update={"populations": pops})
        elif st.kind == "cell_activity":
            steps.append(st.model_copy(update=V2_ACTIVITY))
            steps.append(Bleaching(**V2_BLEACHING))
            continue
        elif st.kind == "neuropil":
            st = st.model_copy(update=V2_NEUROPIL)
        steps.append(st)
    spec = base.model_copy(update={"steps": steps})
    return Spec.model_validate(spec.model_dump())


def _crop_falloff(step, n_px: int, px_um: float):
    """Re-express a full-frame radial falloff on a centred ``n_px`` crop.

    minisim normalizes the falloff radius to the frame's farthest corner, so a
    smaller frame would otherwise squeeze the whole round aperture into it. This
    keeps the crop showing the centre of the calibrated 600 px field.
    """

    def r_max(n):
        c = (
            (n - 1) / 2 + step.center_offset_um[0] / px_um,
            (n - 1) / 2 + step.center_offset_um[1] / px_um,
        )
        return max(
            math.hypot(c[0] - y, c[1] - x) for y in (0, n - 1) for x in (0, n - 1)
        )

    k = (r_max(n_px) / r_max(N_PX)) ** step.exponent
    return step.model_copy(update={"falloff": min(1.0, 1.0 - (1.0 - step.falloff) * k)})


def calibrated_spec(
    duration_s: float,
    fps: float = FPS,
    seed: int = 0,
    n_px: int | None = None,
    motion: bool = True,
    nonrigid: bool = True,
    vasculature: bool = True,
    base: Spec | None = None,
    version: str = "v1",
) -> Spec:
    """The calibrated V4 CA1 spec, re-timed / resized.

    ``n_px`` (square) crops the field to its centre (``None`` = the full 600 px
    frame); the illumination/vignette falloffs and leakage glow are re-expressed
    so the crop sees the centre of the calibrated field, not a shrunken copy.
    ``motion=False`` drops brain motion; ``nonrigid=False`` keeps rigid motion only.
    ``vasculature=False`` drops the vessels (for a content ablation). ``base``
    replaces the stored JSON (used while calibrating). ``version="v2"`` loads the
    activity-calibrated ``ca1_workshop_v2.spec.json`` instead of v1.
    """
    if base is None:
        path = {"v1": SPEC_JSON, "v2": SPEC_V2_JSON}[version]
        base = Spec.model_validate_json(path.read_text())
    acq = base.acquisition
    px_um = acq.pixel_size_um
    acq_upd: dict = {"fps": fps, "duration_s": duration_s}
    if n_px is not None:
        acq_upd["image_sensor"] = acq.image_sensor.model_copy(
            update={"n_px_height": n_px, "n_px_width": n_px}
        )
    steps = []
    for st in base.steps:
        if st.kind == "brain_motion":
            if not motion:
                continue
            st = st.model_copy(update={"nonrigid": nonrigid})
        elif st.kind == "vasculature" and not vasculature:
            continue
        elif n_px is not None and st.kind in ("illumination_profile", "vignette"):
            st = _crop_falloff(st, n_px, px_um)
        elif n_px is not None and st.kind == "leakage" and st.sigma_um is None:
            # pin the glow width to the full frame's default (a quarter of the FOV)
            st = st.model_copy(update={"sigma_um": N_PX * px_um / 4})
        steps.append(st)
    spec = base.model_copy(
        update={
            "acquisition": acq.model_copy(update=acq_upd),
            "steps": steps,
            "seed": seed,
        }
    )
    return Spec.model_validate(spec.model_dump())  # re-validate the edited copy


if __name__ == "__main__":
    import sys

    if sys.argv[1:] == ["v2"]:
        SPEC_V2_JSON.write_text(_build_v2().model_dump_json(indent=1))
        print(f"wrote {SPEC_V2_JSON}")
    else:
        spec = _build()
        SPEC_JSON.write_text(spec.model_dump_json(indent=1))
        print(f"wrote {SPEC_JSON}")
