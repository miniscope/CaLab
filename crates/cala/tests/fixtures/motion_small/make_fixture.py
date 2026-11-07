"""Generate crates/cala/tests/fixtures/motion_small with minisim (feat/realistic-motion).

Usage: python make_fixture.py <out_dir>  (see README.md)
"""

import sys
from pathlib import Path

import numpy as np
from minisim import presets, simulate

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
H = W = 128
N = 180
scope = presets.miniscope_v4()
scope = scope.model_copy(
    update={
        "image_sensor": scope.image_sensor.model_copy(
            update={"n_px_height": H, "n_px_width": W}
        )
    }
)
spec = presets.build_spec(
    scope,
    presets.ca1(),
    duration_s=N / 20.0,
    fps=20.0,
    seed=7,
    extra_steps=[presets.realistic_motion()],
)
rec = simulate(spec)
mov = np.clip(np.rint(np.asarray(rec.observed)), 0, 255).astype(np.uint8)
assert mov.shape == (N, H, W), mov.shape
gt = rec.ground_truth
np.save(out / "movie.npy", mov)
np.save(out / "shifts.npy", np.asarray(gt.shifts, dtype=np.float64))
np.save(out / "nonrigid_field.npy", np.asarray(gt.nonrigid_field, dtype=np.float64))
np.save(out / "nonrigid_nodes_y.npy", np.asarray(gt.nonrigid_nodes_y, dtype=np.float64))
np.save(out / "nonrigid_nodes_x.npy", np.asarray(gt.nonrigid_nodes_x, dtype=np.float64))
(out / "spec.json").write_text(spec.model_dump_json(indent=1))
s = np.asarray(gt.shifts)
print(
    "cells",
    len(gt.amplitude_per_cell),
    "detectable",
    int(np.asarray(gt.detectable).sum()),
    "shift std",
    s.std(0),
    "max",
    np.abs(s).max(0),
    "nonrigid std",
    np.asarray(gt.nonrigid_field).std(),
    "mean px",
    mov.mean(),
)
