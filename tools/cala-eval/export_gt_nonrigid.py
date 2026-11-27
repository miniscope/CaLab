"""Export a minisim recording's motion ground truth for `motion_eval minisim`.

    $MINISIM_PY tools/cala-eval/export_gt_nonrigid.py <sim dir> <out dir>

Reads `<sim>/daq/ground_truth/ground_truth.zarr` and writes `shifts.npy`,
`nonrigid_field.npy`, `nonrigid_nodes_y.npy` and `nonrigid_nodes_x.npy` (float64)
into `<out dir>`, the layout `motion_eval minisim <daq> <gt dir>` reads. With
`--prnu`, also writes every 2-D sensor-pattern array it finds in the ground truth
(`*prnu*`, `*gain*`, `*fpn*`) as `<name>.npy` for scoring a learned flat field.
"""

import sys
from pathlib import Path

import numpy as np
import zarr


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        return 2
    sim, out = Path(args[0]), Path(args[1])
    gt = zarr.open(str(sim / "daq" / "ground_truth" / "ground_truth.zarr"), mode="r")["ground_truth"]
    out.mkdir(parents=True, exist_ok=True)
    for k in ("shifts", "nonrigid_field", "nonrigid_nodes_y", "nonrigid_nodes_x"):
        np.save(out / f"{k}.npy", np.asarray(gt[k], dtype=np.float64))
    if "--prnu" in sys.argv:
        for k in gt.array_keys():
            if any(s in k.lower() for s in ("prnu", "gain", "fpn")) and gt[k].ndim == 2:
                np.save(out / f"{k}.npy", np.asarray(gt[k], dtype=np.float64))
                print("sensor pattern:", k, gt[k].shape)
    return 0


if __name__ == "__main__":
    sys.exit(main())
