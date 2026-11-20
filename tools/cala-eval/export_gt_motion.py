"""Export a minisim recording's true rigid motion for qc_eval's GT alignment.

    $MINISIM_PY tools/cala-eval/export_gt_motion.py <sim dir> [<sim dir> ...]

Writes `<sim>/shifts.npy`: `(frames, 2)` float64, minisim's ground-truth `shifts`
(rigid content motion, dy and dx in px) from `daq/ground_truth/ground_truth.zarr`.
`qc_eval sim|oracle --motion` reads it to estimate the offset between cala's registered
frame and the sim's tissue frame (`motion_offset.tsv`), and moves the GT footprints by
it before scoring. `make_trace_sim.py` writes the same file for new recordings; this
backfills older ones. A sim without motion gets no file. Needs numpy and zarr (the
minisim venv).
"""

import sys
from pathlib import Path

import numpy as np
import zarr


def export(sim: Path) -> str:
    g = zarr.open(str(sim / "daq" / "ground_truth" / "ground_truth.zarr" / "ground_truth"), mode="r")
    if "shifts" not in g:
        return "no motion"
    s = np.asarray(g["shifts"], dtype=np.float64)
    assert s.ndim == 2 and s.shape[1] == 2, s.shape
    out = sim / "shifts.npy"
    if out.exists() and np.array_equal(np.load(out), s):
        return "have"
    np.save(out, s)
    return f"wrote {s.shape[0]} frames"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    for d in sys.argv[1:]:
        print(d, export(Path(d)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
