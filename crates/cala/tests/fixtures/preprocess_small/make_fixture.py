"""Generate crates/cala/tests/fixtures/preprocess_small with minisim.

Needs minisim with the SensorDefects step (branch feat/sensor-defects, PR #32).
Usage: python make_fixture.py <out_dir>   (see README.md for the exact command)
"""
import argparse
import json
import os
import subprocess

import numpy as np
from minisim import (
    IlluminationProfile,
    Leakage,
    Neuropil,
    Sensor,
    SensorDefects,
    Vignette,
)
from minisim.testing import make_recording

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--photons", type=float, default=45.0)
ap.add_argument("--neuropil", type=float, default=1.8)
ap.add_argument("--leakage", type=float, default=2.2)
ap.add_argument("--frames", type=int, default=160)
ap.add_argument("--n-px", type=int, default=128)
args = ap.parse_args()

FPS = 20.0
N_PX = args.n_px
SEED = 7
defects = SensorDefects(
    n_hot_pixels=40,
    stuck_pixel_fraction=4.0e-4,
    stuck_pixel_value=255.0,
    column_fpn_sd=1.0,
    row_fpn_sd=0.0,
)
extra = [
    Neuropil(amplitude=args.neuropil),
    IlluminationProfile(falloff=0.6, exponent=2.0),
    Vignette(falloff=0.05, exponent=2.5),
    Leakage(profile="gaussian", level=args.leakage),
    defects,
]
rec = make_recording(
    n_cells=36,
    n_px=N_PX,
    pixel_size_um=1.0,
    duration_s=args.frames / FPS,
    fps=FPS,
    seed=SEED,
    sensor=Sensor(photons_per_unit=args.photons),
    extra_steps=extra,
    save_intermediates=True,
)
movie = np.asarray(rec.observed)
assert movie.min() >= 0 and movie.max() <= 255
movie_u8 = movie.astype(np.uint8)
gt = rec.ground_truth
os.makedirs(args.out, exist_ok=True)

np.save(f"{args.out}/movie_u8.npy", movie_u8)
np.save(f"{args.out}/hot_pixel_mask.npy", np.asarray(gt.hot_pixel_mask, dtype=np.uint8))
np.save(f"{args.out}/stuck_pixel_mask.npy", np.asarray(gt.stuck_pixel_mask, dtype=np.uint8))
A = np.asarray(gt.A_observed, dtype=np.float32)
np.save(f"{args.out}/A_observed_max.npy", A.max(axis=0).astype(np.float32))
# Per-cell label of the dominant footprint (0 = none), for cell-contrast tests.
lab = (A.argmax(axis=0) + 1).astype(np.uint16)
lab[A.max(axis=0) <= 0.5 * A.max(axis=(1, 2)).min()] = 0
np.save(f"{args.out}/cell_label.npy", lab)
np.save(f"{args.out}/C.npy", np.asarray(gt.C, dtype=np.float32))
for name in ("illumination", "vignette", "leakage"):
    arr = getattr(gt, name)
    np.save(f"{args.out}/{name}.npy", np.asarray(arr, dtype=np.float32))
np.save(f"{args.out}/fpn_column.npy", np.asarray(gt.fpn_column, dtype=np.float32))

# Expected (noiseless) mean counts, split into cell light and everything else
# (neuropil, leakage, through illumination and vignette): the "glow" that
# flattening should remove. Intensity -> counts is photons_per_unit * QE * gain.
sens0 = rec.spec.acquisition.image_sensor
k_counts = args.photons * sens0.quantum_efficiency * sens0.gain_adu_per_e
print("snapshots", sorted(rec.snapshots))
cells_only = np.asarray(rec.stage("composite")).mean(axis=0)
pre_sensor = np.asarray(rec.stage("leakage")).mean(axis=0)
field = np.asarray(gt.illumination) * np.asarray(gt.vignette)
cells_counts = k_counts * cells_only * field
glow_counts = k_counts * pre_sensor - cells_counts
np.save(f"{args.out}/cells_mean.npy", cells_counts.astype(np.float32))
np.save(f"{args.out}/glow_mean.npy", glow_counts.astype(np.float32))

# Known per-pixel noise: the sensor model is Normal(lambda, sqrt(lambda + read^2))
# electrons, times gain, floored. lambda is recovered from the time-mean counts
# with the column offset removed; floor quantization adds 1/12 ADU^2.
sens = rec.spec.acquisition.image_sensor
g = sens.gain_adu_per_e
mean_counts = movie.mean(axis=0) - np.asarray(gt.fpn_column)[None, :] + 0.5
lam = np.clip(mean_counts / g, 0, None)
sigma = np.sqrt(g * g * (lam + sens.read_noise_e**2) + 1.0 / 12.0).astype(np.float32)
np.save(f"{args.out}/noise_sigma.npy", sigma)

commit = subprocess.check_output(
    ["git", "-C", os.path.dirname(os.path.dirname(__import__("minisim").__file__)), "rev-parse", "HEAD"],
    text=True,
).strip()
meta = {
    "minisim_commit": commit,
    "seed": SEED,
    "fps": FPS,
    "frames": int(movie.shape[0]),
    "height": int(movie.shape[1]),
    "width": int(movie.shape[2]),
    "n_cells": int(A.shape[0]),
    "photons_per_unit": args.photons,
    "neuropil_amplitude": args.neuropil,
    "leakage_level": args.leakage,
    "read_noise_e": sens.read_noise_e,
    "gain_adu_per_e": g,
    "n_hot": int(np.asarray(gt.hot_pixel_mask).sum()),
    "n_stuck": int(np.asarray(gt.stuck_pixel_mask).sum()),
}
with open(f"{args.out}/meta.json", "w") as f:
    json.dump(meta, f, indent=2)
print(json.dumps(meta, indent=2))
m = movie.mean(0)
print("mean pct", np.percentile(m, [0, 1, 10, 50, 90, 99, 100]).round(1))
print("noise sigma median", np.median(sigma), "range", sigma.min(), sigma.max())
