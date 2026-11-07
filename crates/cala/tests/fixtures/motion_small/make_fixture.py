"""Regenerate crates/cala/tests/fixtures/motion_small from spec.json.

Usage: python make_fixture.py <out_dir>  (see README.md)

Simulates the committed spec (minisim commit 81e680d, the content-calibrated
V4/CA1 parameters) and keeps the first 180 frames so the fixture stays under
3 MB.
"""

import sys
from pathlib import Path

import numpy as np
from minisim import simulate
from minisim.spec import Spec

here = Path(__file__).parent
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
N = 180
spec = Spec.model_validate_json((here / "spec.json").read_text())
rec = simulate(spec)
gt = rec.ground_truth
mov = np.clip(np.rint(np.asarray(rec.observed)), 0, 255).astype(np.uint8)[:N]
np.save(out / "movie.npy", mov)
np.save(out / "shifts.npy", np.asarray(gt.shifts, dtype=np.float64)[:N])
np.save(out / "nonrigid_field.npy", np.asarray(gt.nonrigid_field, dtype=np.float64)[:N])
np.save(out / "nonrigid_nodes_y.npy", np.asarray(gt.nonrigid_nodes_y, dtype=np.float64))
np.save(out / "nonrigid_nodes_x.npy", np.asarray(gt.nonrigid_nodes_x, dtype=np.float64))
print(mov.shape, mov.mean(), np.asarray(gt.shifts)[:N].std(0))
