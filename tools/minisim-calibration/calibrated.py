"""A minisim Spec calibrated to the workshop V4 CA1 recording (prerecorded/raw).

Built only through minisim's public API: ``build_spec(miniscope_v4(), ca1(), ...)``
with field overrides via ``model_copy``. Nothing in minisim itself changes. The
calibrated full-frame (600 x 600 px, the DAQ frame size) spec is stored as
``ca1_workshop_calibrated.spec.json`` next to this file; :func:`calibrated_spec`
loads it and adjusts sampling, size and motion.

Regenerate the JSON with ``python calibrated.py`` (prints the overrides). See
``CALIBRATION.md`` for the target numbers and what was matched.

Needs a minisim that has the ``"miniscope"`` brain-motion model (PR #33,
``feat/realistic-motion``).
"""

from __future__ import annotations

import math
from pathlib import Path

from minisim import Spec, presets
from minisim.spec import CellActivity, Sensor

HERE = Path(__file__).resolve().parent
SPEC_JSON = HERE / "ca1_workshop_calibrated.spec.json"

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
#   detectable-cell yield, which depends on each trace's max over the whole
#   recording: a 15 s sim resolved to ~183 um and a 2-min one to ~230 um, which
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
) -> Spec:
    """The calibrated V4 CA1 spec, re-timed / resized.

    ``n_px`` (square) crops the field to its centre (``None`` = the full 600 px
    frame); the illumination/vignette falloffs and leakage glow are re-expressed
    so the crop sees the centre of the calibrated field, not a shrunken copy.
    ``motion=False`` drops brain motion; ``nonrigid=False`` keeps rigid motion only.
    ``vasculature=False`` drops the vessels (for a content ablation). ``base``
    replaces the stored JSON (used while calibrating).
    """
    if base is None:
        base = Spec.model_validate_json(SPEC_JSON.read_text())
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
    spec = _build()
    SPEC_JSON.write_text(spec.model_dump_json(indent=1))
    print(f"wrote {SPEC_JSON}")
