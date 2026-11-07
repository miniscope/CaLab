"""Regenerate the calibrated motion fixtures (see README.md).

python make_fixtures.py <fixtures_dir>
  daq_v4_2min_realmotion_v2  600x600, 120 s, rigid + non-rigid realistic motion, seed 0 (DAQ layout,
                             streamed; arrays.npz without the dense footprints)
  small_realmotion_v2        128x128, 300 frames, rigid + non-rigid, seed 7 (.npy GT)
"""

import sys
from pathlib import Path

import numpy as np
import zarr

sys.path.insert(0, str(Path(__file__).resolve().parent))
from minisim import simulate, write_miniscope_daq  # noqa: E402

from calibrated import calibrated_spec  # noqa: E402

root = Path(sys.argv[1])
# Streamed in 32-frame chunks. The dense arrays.npz (A_observed / A_planted for ~960
# cells at 600 px) needs ~9 GB to write, so it is skipped; the full ground truth is
# in ground_truth/ground_truth.zarr, and a light arrays.npz with every non-footprint
# field (shifts, nonrigid_field, C, S, ...) is written from it below.
daq = root / "daq_v4_2min_realmotion_v2"
f = write_miniscope_daq(
    calibrated_spec(120.0, seed=0),
    daq,
    progress=False,
    overwrite=True,
    chunk_frames=32,
    write_npz=False,
)
g = zarr.open_group(str(daq / "ground_truth/ground_truth.zarr"), "r")["ground_truth"]
light = {k: np.asarray(g[k]) for k in g.array_keys() if k not in ("planted",)}
np.savez(daq / "ground_truth/arrays.npz", **light)
print(
    "daq",
    f.device_dir,
    f.n_frames,
    "focal",
    g.attrs.get("focal_depth_um"),
    "npz keys",
    sorted(light),
)

out = root / "small_realmotion_v2"
out.mkdir(parents=True, exist_ok=True)
spec = calibrated_spec(300 / 20.0, seed=7, n_px=128)
rec = simulate(spec)
mov = np.clip(np.rint(np.asarray(rec.observed)), 0, 255).astype(np.uint8)
gt = rec.ground_truth
np.save(out / "movie.npy", mov)
np.save(out / "shifts.npy", np.asarray(gt.shifts, dtype=np.float64))
np.save(out / "nonrigid_field.npy", np.asarray(gt.nonrigid_field, dtype=np.float64))
np.save(out / "nonrigid_nodes_y.npy", np.asarray(gt.nonrigid_nodes_y, dtype=np.float64))
np.save(out / "nonrigid_nodes_x.npy", np.asarray(gt.nonrigid_nodes_x, dtype=np.float64))
np.save(out / "A_observed.npy", np.asarray(gt.A_observed, dtype=np.float32))
np.save(out / "C.npy", np.asarray(gt.C, dtype=np.float32))
(out / "spec.json").write_text(spec.model_dump_json(indent=1))
print(
    "small",
    mov.shape,
    "mean",
    mov.mean().round(1),
    "cells",
    gt.C.shape[0],
    "shift std",
    np.asarray(gt.shifts).std(0).round(2),
)
