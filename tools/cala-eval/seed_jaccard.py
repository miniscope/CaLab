#!/usr/bin/env python
"""Seed-to-seed reproducibility of two `qc_eval real` runs (same data, different --slow-seed).

    python tools/cala-eval/seed_jaccard.py <runA> <runB> [--min-cos 0.5]

Reads `footprints.bin` (CALAFP01: height, width, n; per cell id, npx, u32 pixel
indices, f32 unfiltered amplitudes, f32 filtered amplitudes). Cells are matched
one-to-one, greedily by the cosine similarity of their unfiltered footprints
(candidates: centroids within --radius px); a pair counts when cos >= --min-cos.
The Jaccard is matched / (nA + nB - matched). Whole library, no ground truth.
Needs numpy.
"""

import argparse
import struct
import sys
from pathlib import Path

import numpy as np


def load(path: Path):
    b = path.read_bytes()
    assert b[:8] == b"CALAFP01", "bad magic"
    h, w, n = struct.unpack_from("<III", b, 8)
    o = 20
    cells = []
    for _ in range(n):
        cid, npx = struct.unpack_from("<II", b, o)
        o += 8
        idx = np.frombuffer(b, "<u4", npx, o)
        o += 4 * npx
        a = np.frombuffer(b, "<f4", npx, o)
        o += 8 * npx  # unfiltered, then filtered
        cells.append((cid, idx, a))
    return h, w, cells


def prep(cells, w):
    out = []
    for _cid, idx, a in cells:
        a = a.astype(np.float64)
        y, x = idx // w, idx % w
        s = a.sum() or 1.0
        norm = float(np.sqrt((a * a).sum()) or 1.0)
        out.append((float((y * a).sum() / s), float((x * a).sum() / s), dict(zip(idx.tolist(), a.tolist())), norm))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("a", type=Path)
    ap.add_argument("b", type=Path)
    ap.add_argument("--min-cos", type=float, default=0.5)
    ap.add_argument("--radius", type=float, default=12.0)
    args = ap.parse_args()
    _, w, A = load(args.a / "footprints.bin")
    _, _, B = load(args.b / "footprints.bin")
    PA, PB = prep(A, w), prep(B, w)
    cb = np.array([[p[0], p[1]] for p in PB])
    cand = []
    for i, (cy, cx, fa, na) in enumerate(PA):
        d = np.hypot(cb[:, 0] - cy, cb[:, 1] - cx)
        for j in np.nonzero(d <= args.radius)[0]:
            fb, nb = PB[j][2], PB[j][3]
            dot = sum(v * fb[k] for k, v in fa.items() if k in fb)
            cand.append((dot / (na * nb), i, int(j)))
    cand.sort(reverse=True)
    ua, ub, cos = set(), set(), []
    for c, i, j in cand:
        if c < args.min_cos:
            break
        if i in ua or j in ub:
            continue
        ua.add(i)
        ub.add(j)
        cos.append(c)
    m, na, nb = len(cos), len(A), len(B)
    print(
        f"cells A={na} B={nb} matched={m} (cos>={args.min_cos}) jaccard={m / (na + nb - m):.3f} "
        f"median_cos={np.median(cos):.3f} frac_A={m / na:.3f} frac_B={m / nb:.3f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
