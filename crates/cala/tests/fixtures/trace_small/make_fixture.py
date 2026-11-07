"""Regenerate crates/cala/tests/fixtures/trace_small (see README.md).

Usage: python make_fixture.py <out_dir>

A 64 x 64 crop of the calibrated CA1 spec (tools/minisim-calibration, focal
depth pinned at 180 um), no brain motion, scatter halo fraction 0.45, 80
frames. Writes the movie and, per ground-truth unit, the oracle footprints
(with the halo, and its core component only) in a window around the core peak,
multiplied by the static gains (illumination, vignette, vessels) and the
photon-to-ADU factor so the trace units are those of C.
"""

import sys
from pathlib import Path

import numpy as np
from minisim import simulate
from minisim.footprint import degrade_footprint

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / "tools/minisim-calibration"))
from calibrated import calibrated_spec  # noqa: E402

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
FRAMES, NPX, HALO, R = 80, 64, 0.45, 10

spec = calibrated_spec(FRAMES / 20.0, seed=3, n_px=NPX, motion=False)
acq = spec.acquisition
acq = acq.model_copy(
    update={"tissue": acq.tissue.model_copy(update={"scatter_halo_fraction": HALO})}
)
spec = spec.model_copy(update={"acquisition": acq})
rec = simulate(spec)
gt = rec.ground_truth
mov = np.clip(np.rint(np.asarray(rec.observed)), 0, 255).astype(np.uint8)

top, left = gt.fov_offset
H, W = gt.fov_shape
sens = spec.acquisition.image_sensor
ppu = [st for st in spec.steps if st.kind == "sensor"][0].photons_per_unit
gain_map = np.full((H, W), ppu * sens.quantum_efficiency * sens.gain_adu_per_e)
for name in ("illumination", "vignette", "vasculature_mask"):
    m = getattr(gt, name)
    if m is not None:
        gain_map = gain_map * m


def window(fp, wy0, wx0):
    """(2R+1)^2 window at (wy0, wx0) of the FOV-cropped footprint, zero-padded."""
    s = 2 * R + 1
    win = np.zeros((s, s))
    f2 = fp.crop(top, left, H, W)
    if f2.is_empty:
        return win
    dense = np.zeros((H, W))
    y0, x0 = f2.offset
    ph, pw = f2.patch.shape
    dense[y0 : y0 + ph, x0 : x0 + pw] = f2.patch
    dense *= gain_map
    ys = slice(max(wy0, 0), min(wy0 + s, H))
    xs = slice(max(wx0, 0), min(wx0 + s, W))
    win[ys.start - wy0 : ys.stop - wy0, xs.start - wx0 : xs.stop - wx0] = dense[ys, xs]
    return win


fps, meta = [], []
for i, fp in enumerate(gt.planted):
    sig, gain = float(gt.observed_sigma_px[i]), float(gt.observed_gain[i])
    hf, hs = float(gt.observed_halo_fraction[i]), float(gt.observed_halo_sigma_px[i])
    full = degrade_footprint(fp, sig, gain, hs, hf)
    core = degrade_footprint(fp, sig, gain * (1.0 - hf))
    c = core.crop(top, left, H, W)
    if c.is_empty:
        continue
    yy, xx = np.unravel_index(np.argmax(c.patch), c.patch.shape)
    cy, cx = c.offset[0] + yy, c.offset[1] + xx
    fps.append(np.stack([window(full, cy - R, cx - R), window(core, cy - R, cx - R)]))
    meta.append([i, cy - R, cx - R, float(gt.detectable[i]), float(gt.in_focus[i])])

np.save(out / "movie.npy", mov)
np.save(out / "footprints.npy", np.asarray(fps, dtype=np.float32))
np.save(out / "meta.npy", np.asarray(meta, dtype=np.float64))
np.save(out / "C.npy", np.asarray(gt.C, dtype=np.float32)[[int(m[0]) for m in meta]])
(out / "spec.json").write_text(spec.model_dump_json(indent=1))
print(mov.shape, "units", len(meta), "detectable", int(sum(m[3] for m in meta)))
