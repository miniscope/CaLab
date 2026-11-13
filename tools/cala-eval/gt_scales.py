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
- `ring sigma`, the radial-profile edge statistic of `fp_scales.py` (S2.4 P1), on the same
  footprint; no smoothing to remove. `fp_scales.py` compares cala's footprints against these.
- the detectable count in a 3 x 3 grid over the frame (spatial uniformity of detectable cells).

`measure_units(path)` returns the per-unit values (for `fp_scales.py --gt`).
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fp_scales  # noqa: E402


def quant(v: np.ndarray) -> str:
    q = np.percentile(v, [10, 25, 50, 75, 90])
    return f"n={len(v):<5d} q10 {q[0]:.2f}  q25 {q[1]:.2f}  med {q[2]:.2f}  q75 {q[3]:.2f}  q90 {q[4]:.2f}"


def iter_units(path: str):
    """(frame dims, [(unit index, detectable, (cy, cx), full footprint patch)])."""
    units = []
    with open(path, "rb") as f:
        assert f.read(8) == b"CALAORC1"
        h, w, n, _t = struct.unpack("<IIII", f.read(16))
        for u in range(n):
            f.read(4)  # id
            flags = f.read(4)
            cy, cx = struct.unpack("<ff", f.read(8))
            y0, x0, ph, pw = struct.unpack("<iiII", f.read(16))
            a = np.frombuffer(f.read(4 * ph * pw), "<f4").reshape(ph, pw).clip(0)
            y0, x0, ph, pw = struct.unpack("<iiII", f.read(16))  # core footprint, skipped
            f.read(4 * ph * pw)
            units.append((u, bool(flags[0]), (cy, cx), a))
    return (h, w), units


def measure_units(path: str) -> dict[int, dict]:
    """Per unit index (oracle order): d, edge, ring, centre, detectable."""
    _, units = iter_units(path)
    out = {}
    for u, det, (cy, cx), a in units:
        if not a.max() > 0:
            continue
        pa = np.pad(a, 2)
        s, _se, _nr = fp_scales.ring_edge(pa, np.ones(pa.shape, bool))
        out[u] = {
            "d": fp_scales.half_max_diameter(a),
            "edge": fp_scales.grad_edge(a),
            "ring": s,
            "cy": cy,
            "cx": cx,
            "detectable": det,
        }
    return out


def measure(path: str) -> dict:
    (h, w), units = iter_units(path)
    m = measure_units(path)
    det = [v for v in m.values() if v["detectable"]]
    grid = np.zeros((3, 3), int)
    for v in det:
        grid[min(int(3 * v["cy"] / h), 2), min(int(3 * v["cx"] / w), 2)] += 1
    return {
        "units": len(units),
        "d": np.array([v["d"] for v in det]),
        "edge": np.array([v["edge"] for v in det]),
        "ring": np.array([v["ring"] for v in det]),
        "grid": grid,
    }


def main() -> None:
    for p in sys.argv[1:]:
        m = measure(p)
        print(p, "units", m["units"], "detectable", len(m["d"]))
        print("  d (half-max diameter, px)  ", quant(m["d"]))
        print("  edge sigma (px)            ", quant(m["edge"]))
        print("  ring sigma (px)            ", quant(m["ring"][np.isfinite(m["ring"])]))
        g = m["grid"]
        print("  detectable per 3x3 cell    ", g.ravel().tolist(), f"(min/max {g.min() / max(g.max(), 1):.2f})")


if __name__ == "__main__":
    main()
