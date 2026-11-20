"""Build the v3 specs (cell size and optical blur of the real recording) from v2.

    $MINISIM_PY tools/minisim-calibration/make_v3_specs.py

Writes `ca1_workshop_v3.spec.json` (10 px cells), `ca1_workshop_v3_size6.spec.json` and
`ca1_workshop_v3_size16.spec.json` next to `ca1_workshop_v2.spec.json`. Every change
from v2 is listed below with its reason; the measurements are in
`tools/cala-eval/results/2026-11-12-sim-v3-scales.md` (statistics: `tools/cala-eval/gt_scales.py`)
and `CALIBRATION.md` ("v3").

The pixel size (4.8 um / 2.9 = 1.655 um) is NOT changed, so the vessels, neuropil field,
illumination, leakage, motion, activity and the 600 px frame stay as in v2, in pixels.
Only the cells, the tissue blur, the focal geometry and the exposure change.
"""

from __future__ import annotations

from pathlib import Path

from minisim import Spec

HERE = Path(__file__).resolve().parent
V2 = HERE / "ca1_workshop_v2.spec.json"

# v2 cytosolic population (the only one that places cells; the step-level fields are
# unused defaults): soma radius 5 um, 33750 /mm3 (v1 45000 x 0.75), depth 140-160 um.
V2_SOMA_RADIUS_UM = 5.0
V2_DENSITY = 33750.0

# Shared by every v3 arm.
#
# 1. optics.scatter_blur_per_um is the tissue.scatter_blur_per_um 0.05 -> 0.010. In v2 the
#    scatter blur (sigma = 0.05 um/um x depth, ~9 um = 5.4 px at the 180 um cell layer) is what
#    makes the footprints 3.3-3.8 px soft; the real workshop footprints have ~1.5 px edges.
# 2. optics.field_curvature_radius_um 2500 -> None (flat field). With a sharp PSF, minisim's
#    detectable flag (minisim <= 1.0.3: a point-source test, sigma_0^2 / sigma_tot^2; 1.1.0
#    replaced it with a matched-filter SNR) only passes cells within
#    a few um of the focal surface, which with field curvature is a bowl: in a trial all
#    detectable cells sat in a ring (centre 13 of 888, edge 130). A flat field puts the
#    in-focus layer at one depth, so detectable cells cover the frame (min/max over a 3 x 3
#    grid 0.5, v2 0.7). v2's wide blur hid this.
# 3. The cells are placed in a 16 um layer straddling the focal depth (172-188 um around
#    focal_depth_in_tissue_um = 180), not v2's 140-160 um layer.
V3_COMMON = dict(
    scatter_blur_per_um=0.010,
    field_curvature_radius_um=None,
    depth_range_um=(172.0, 188.0),
    # The pinned focal depth stays 180 um (v2).
    # photons_per_unit 6500 -> 1800 (4): a sharper, bigger cell concentrates its light;
    # at 6500 the median peak SNR (footprint peak x event amplitude / pixel noise, MAD of
    # frame differences) would be ~4x v2's. 1800 gives ~1.2x, and keeps the detectable
    # flag, which also scales with it, passing across the frame.
    ppu=1800.0,
)

# Per arm: soma radius factor k (x V2_SOMA_RADIUS_UM), the density factor (x V2_DENSITY) that
# keeps ~v2's 635 detectable cells per 600 px frame at 480 s, and the neuropil amplitude
# (relative to the f0 = 1 cell baseline) that holds the mean grey level (v2 64 over the
# recording; the haze dominates it, and cells add more of it the larger they are).
SIZE_ARMS = {
    # d = 10 px, radius 8.3 um (1.66x v2's 5 um): the half-max diameter of a ~8 px
    # soma blurred by ~1.4 px, measured 10.1 px (v2 14.4).
    "v3": dict(k=1.66, density=1.5, neuropil=1.5),
    # d = 6 px, radius 4.6 um.
    "v3_size6": dict(k=0.92, density=1.5, neuropil=1.5),
    # d = 16 px, radius 13.1 um.
    "v3_size16": dict(k=2.62, density=0.97, neuropil=1.65),
}


def build(base: Spec, k: float, density: float, neuropil: float) -> Spec:
    steps = []
    for st in base.steps:
        if st.kind == "place_neurons":
            pop = st.populations[0].model_copy(
                update={
                    "soma_radius_um": round(V2_SOMA_RADIUS_UM * k, 4),
                    "density_per_mm3": round(V2_DENSITY * density, 1),
                    "depth_range_um": V3_COMMON["depth_range_um"],
                }
            )
            st = st.model_copy(update={"populations": [pop]})
        elif st.kind == "neuropil":
            st = st.model_copy(update={"amplitude": neuropil})
        elif st.kind == "sensor":
            st = st.model_copy(update={"photons_per_unit": V3_COMMON["ppu"]})
        steps.append(st)
    acq = base.acquisition
    acq = acq.model_copy(
        update={
            "tissue": acq.tissue.model_copy(
                update={"scatter_blur_per_um": V3_COMMON["scatter_blur_per_um"]}
            ),
            "optics": acq.optics.model_copy(
                update={"field_curvature_radius_um": V3_COMMON["field_curvature_radius_um"]}
            ),
        }
    )
    return Spec.model_validate(
        base.model_copy(update={"acquisition": acq, "steps": steps}).model_dump()
    )


if __name__ == "__main__":
    base = Spec.model_validate_json(V2.read_text())
    for name, kw in SIZE_ARMS.items():
        path = HERE / f"ca1_workshop_{name}.spec.json"
        path.write_text(build(base, **kw).model_dump_json(indent=1))
        print("wrote", path)
