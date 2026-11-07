"""Render a calibrated minisim recording (streamed) and export oracle footprints.

python make_trace_sim.py OUT --f 0.45 --dur 60 --npx 600 [--motion] [--seed 0]

Writes OUT/daq/... (AVI files, streamed), and OUT/oracle.bin:
  header: magic b"CALAORC1", u32 H, W, n_units, n_frames
  per unit: u32 id, u8 detectable, u8 in_focus, 2 pad, f32 cy, cx (FOV px),
            then two footprints (full = with halo, core = core-only), each:
              i32 y0, x0, u32 h, w, f32[h*w]   (FOV coords, unfiltered, ADU per unit of C)
  then C: f32[n_units * n_frames] (row-major, unit-major)
Input for crates/cala/examples/trace_eval.rs (needs minisim c243dca or later for
the scatter halo). Peak RAM ~2.3 GB for 60 s at 600 px.
Footprints are multiplied by the static sensor-fixed gains (illumination, vignette,
vessel transmission) and photons_per_unit * QE * gain_adu, so trace units = C.
"""

import argparse
import struct
import sys
from pathlib import Path

import numpy as np
import zarr

sys.path.insert(0, str(Path(__file__).resolve().parent))
from calibrated import calibrated_spec  # noqa: E402
from minisim import write_miniscope_daq  # noqa: E402
from minisim.footprint import degrade_footprint  # noqa: E402
from minisim.recording import load_ground_truth  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--f", type=float, default=0.0)
ap.add_argument("--dur", type=float, default=60.0)
ap.add_argument("--npx", type=int, default=600)
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--motion", action="store_true")
ap.add_argument("--p-q2a", type=float, default=None, help="cell_activity p_quiescent_to_active (per frame)")
ap.add_argument("--q-rate", type=float, default=None, help="cell_activity quiescent_rate_hz")
a = ap.parse_args()
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)

spec = calibrated_spec(a.dur, seed=a.seed, n_px=None if a.npx == 600 else a.npx, motion=a.motion)
acq = spec.acquisition
if a.f > 0:
    acq = acq.model_copy(update={"tissue": acq.tissue.model_copy(update={"scatter_halo_fraction": a.f})})
    spec = spec.model_copy(update={"acquisition": acq})
# Firing overrides (cell_activity spec params), e.g. sparse firing so that many
# cells stay silent for the first half (late-born cells for the slow loop).
act = {}
if a.p_q2a is not None:
    act["p_quiescent_to_active"] = a.p_q2a
if a.q_rate is not None:
    act["quiescent_rate_hz"] = a.q_rate
if act:
    steps = [st.model_copy(update=act) if st.kind == "cell_activity" else st for st in spec.steps]
    spec = spec.model_copy(update={"steps": steps})
(out / "spec.json").write_text(spec.model_dump_json(indent=1))

daq = out / "daq"
f = write_miniscope_daq(spec, daq, progress=False, overwrite=True, chunk_frames=32, write_npz=False)
print("rendered", f.device_dir, f.n_frames, flush=True)

gt, _ = load_ground_truth(daq / "ground_truth/ground_truth.zarr")
top, left = gt.fov_offset
H, W = gt.fov_shape
sens = spec.acquisition.image_sensor
ppu = [st for st in spec.steps if st.kind == "sensor"][0].photons_per_unit
K = ppu * sens.quantum_efficiency * sens.gain_adu_per_e
gain_map = np.full((H, W), K)
for name in ("illumination", "vignette", "vasculature_mask"):
    m = getattr(gt, name)
    if m is not None:
        assert m.shape == (H, W), (name, m.shape)
        gain_map = gain_map * m
print("K", K, "gain map range", gain_map.min(), gain_map.max(), "units", gt.n_units, flush=True)

def crop(fp):
    fp = fp.crop(top, left, H, W)
    if fp.is_empty:
        return (0, 0, 0, 0, np.zeros(0, np.float32))
    y0, x0 = fp.offset
    ph, pw = fp.patch.shape
    vals = fp.patch.astype(np.float64) * gain_map[y0:y0 + ph, x0:x0 + pw]
    return (y0, x0, ph, pw, vals.astype(np.float32).ravel())

R = 24


def window(fp, wy0, wx0, wy1, wx1):
    canvas = np.zeros((wy1 - wy0, wx1 - wx0))
    f2 = fp.crop(top, left, H, W)
    if not f2.is_empty:
        y0, x0 = f2.offset
        ph, pw = f2.patch.shape
        ay0, ax0 = max(y0, wy0), max(x0, wx0)
        ay1, ax1 = min(y0 + ph, wy1), min(x0 + pw, wx1)
        if ay1 > ay0 and ax1 > ax0:
            canvas[ay0 - wy0:ay1 - wy0, ax0 - wx0:ax1 - wx0] = f2.patch[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0]
    vals = canvas * gain_map[wy0:wy1, wx0:wx1]
    return (wy0, wx0, wy1 - wy0, wx1 - wx0, vals.astype(np.float32).ravel())


C = np.asarray(gt.C, dtype=np.float32)
n, T = C.shape
with open(out / "oracle.bin", "wb") as fh:
    fh.write(b"CALAORC1" + struct.pack("<4I", H, W, n, T))
    for i, fp in enumerate(gt.planted):
        sig = float(gt.observed_sigma_px[i])
        gain = float(gt.observed_gain[i])
        hf = 0.0 if gt.observed_halo_fraction is None else float(gt.observed_halo_fraction[i])
        hs = 0.0 if gt.observed_halo_sigma_px is None else float(gt.observed_halo_sigma_px[i])
        if np.isnan(sig):
            full = core = fp
        elif hf > 0 and not np.isnan(hf):
            full = degrade_footprint(fp, sig, gain, hs, hf)
            core = degrade_footprint(fp, sig, gain * (1.0 - hf))
        else:
            full = core = degrade_footprint(fp, sig, gain)
        cc = crop(core)
        if cc[2] == 0:
            cy = cx = -1.0
            cf = cc
        else:
            d = cc[4].reshape(cc[2], cc[3])
            yy, xx = np.unravel_index(np.argmax(d), d.shape)
            cy, cx = cc[0] + yy, cc[1] + xx
            # Window of radius R around the core peak (the library keeps a tighter
            # support; the halo tail beyond it is not estimable anyway).
            wy0, wx0 = max(cy - R, 0), max(cx - R, 0)
            wy1, wx1 = min(cy + R + 1, H), min(cx + R + 1, W)
            cf = window(full, wy0, wx0, wy1, wx1)
            cc = window(core, wy0, wx0, wy1, wx1)
        fh.write(struct.pack("<IBBxxff", i, bool(gt.detectable[i]), bool(gt.in_focus[i]), cy, cx))
        for (y0, x0, ph, pw, v) in (cf, cc):
            fh.write(struct.pack("<iiII", y0, x0, ph, pw))
            fh.write(v.tobytes())
    fh.write(C.tobytes())
print("exported", n, "units", T, "frames; detectable", int(np.sum(gt.detectable)),
      "in_focus", int(np.sum(gt.in_focus)), "size MB", (out / "oracle.bin").stat().st_size / 1e6, flush=True)
