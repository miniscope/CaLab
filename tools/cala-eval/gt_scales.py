#!/usr/bin/env python
"""Cell size and edge blur of the ground-truth footprints of minisim recordings.

    python tools/cala-eval/gt_scales.py <sims>/static_s5/oracle.bin [...]

Reads `oracle.bin` only (format in `tools/minisim-calibration/make_trace_sim.py`), over the
detectable units, with their `full` footprint (unfiltered, ADU per unit of C):

- `d`, the half-max equivalent diameter `2 sqrt(A_half / pi)`, `A_half` = pixels >= half the
  peak. This is the quantity cala's `support_per_hwhm` uses; it measures 9.8-10.2 px on the
  workshop recording's cala footprints.
- `edge sigma`, `peak / (sqrt(2 pi) max|grad|)`: the sigma of a Gaussian edge with this peak
  and steepest slope. An upper bound on the optical blur (the object has its own edge); it
  measures about 1.5 px on the workshop recording once cala's 1 px smoothing is removed in
  quadrature.
- the detectable count in a 3 x 3 grid over the frame (spatial uniformity of detectable cells).
"""

from __future__ import annotations

import struct
import sys

import numpy as np


def quant(v: np.ndarray) -> str:
    q = np.percentile(v, [10, 25, 50, 75, 90])
    return f"n={len(v):<5d} q10 {q[0]:.2f}  q25 {q[1]:.2f}  med {q[2]:.2f}  q75 {q[3]:.2f}  q90 {q[4]:.2f}"


def measure(path: str) -> dict:
    d_det, e_det, d_all, cells = [], [], [], []
    with open(path, "rb") as f:
        assert f.read(8) == b"CALAORC1"
        h, w, n, _t = struct.unpack("<IIII", f.read(16))
        for _ in range(n):
            f.read(4)  # id
            flags = f.read(4)
            cy, cx = struct.unpack("<ff", f.read(8))
            y0, x0, ph, pw = struct.unpack("<iiII", f.read(16))
            a = np.frombuffer(f.read(4 * ph * pw), "<f4").reshape(ph, pw).clip(0)
            y0, x0, ph, pw = struct.unpack("<iiII", f.read(16))  # core footprint, skipped
            f.read(4 * ph * pw)
            pk = a.max()
            if pk <= 0:
                continue
            d = 2 * np.sqrt((a >= 0.5 * pk).sum() / np.pi)
            d_all.append(d)
            if flags[0]:
                gy, gx = np.gradient(a)
                d_det.append(d)
                e_det.append(pk / (np.hypot(gy, gx).max() * np.sqrt(2 * np.pi)))
                cells.append((cy, cx))
    grid = np.zeros((3, 3), int)
    for cy, cx in cells:
        grid[min(int(3 * cy / h), 2), min(int(3 * cx / w), 2)] += 1
    return {"units": n, "d": np.array(d_det), "edge": np.array(e_det), "grid": grid}


def main() -> None:
    for p in sys.argv[1:]:
        m = measure(p)
        print(p, "units", m["units"], "detectable", len(m["d"]))
        print("  d (half-max diameter, px)  ", quant(m["d"]))
        print("  edge sigma (px)            ", quant(m["edge"]))
        g = m["grid"]
        print("  detectable per 3x3 cell    ", g.ravel().tolist(), f"(min/max {g.min() / max(g.max(), 1):.2f})")


if __name__ == "__main__":
    main()
