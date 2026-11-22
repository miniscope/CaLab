#!/usr/bin/env python
"""Equivalence table of the settle delta in qc_eval (`csdelta.sh eq`; results/2026-11-22-settle-delta.md).

    python tools/cala-eval/csdelta_eq.py ROOT/eq REC SEEDS

REC is `sim` or a Samara recording; SEEDS like `1,2,3`. Arms: `off` (observe_settle), `eqv` (--csdelta charged
observe_settle's cost), `on` (--csdelta at its own cost). Per arm, the mean over seeds of: final cells, GT precision,
recall and median r of the true positives (sims), live frames dropped, the slow worker's share on settle answers.
Then the final libraries against each other: Jaccard (one-to-one greedy match on unfiltered footprint cosine >= 0.5
within 12 px) and the median cosine of the matched pairs, for the same seed across arms, and for two seeds of the
same arm (the run-to-run noise, `off` only).
"""

from __future__ import annotations

import itertools
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from seed_jaccard import load, prep  # noqa: E402

ARMS = ["off", "eqv", "on"]


def run_info(d: Path) -> dict:
    text = (d.parent / f"{d.name}.log").read_text()
    g = lambda pat, cast=float: cast(m.group(1)) if (m := re.search(pat, text)) else float("nan")  # noqa: E731
    gt = re.findall(r"frame \d+: \d+ cells,.*GT \[([^\]]*)\]", text)
    p = r = mr = float("nan")
    if gt:
        v = [float(x) for x in gt[-1].split(",")[:3]]
        p, r, mr = v
    return {
        "cells": g(r"pass 1 done: (\d+) cells", int),
        "precision": p,
        "recall": r,
        "tp_r": mr,
        "dropped": g(r"dropped (\d+), observed"),
        "settle_share": g(r"owner busy ([0-9.]+)% on settle answers"),
        "visits": g(r"; visits (\d+) \("),
    }


def compare(a: Path, b: Path, min_cos=0.5, radius=12.0) -> tuple[float, float]:
    _, w, A = load(a / "footprints.bin")
    _, _, B = load(b / "footprints.bin")
    PA, PB = prep(A, w), prep(B, w)
    cb = np.array([[q[0], q[1]] for q in PB])
    cand = []
    for i, (cy, cx, fa, na) in enumerate(PA):
        d = np.hypot(cb[:, 0] - cy, cb[:, 1] - cx)
        for j in np.nonzero(d <= radius)[0]:
            fb, nb = PB[j][2], PB[j][3]
            dot = sum(v * fb[k] for k, v in fa.items() if k in fb)
            cand.append((dot / (na * nb), i, int(j)))
    cand.sort(reverse=True)
    ua, ub, cos = set(), set(), []
    for c, i, j in cand:
        if c < min_cos:
            break
        if i in ua or j in ub:
            continue
        ua.add(i)
        ub.add(j)
        cos.append(c)
    m = len(cos)
    return m / (len(A) + len(B) - m), float(np.median(cos)) if cos else float("nan")


def main() -> int:
    root, rec, seeds = Path(sys.argv[1]), sys.argv[2], sys.argv[3].split(",")
    run = lambda arm, s: root / f"{rec}_s{s}_{arm}"  # noqa: E731
    print(f"### {rec}, seeds {','.join(seeds)}\n")
    keys = ["cells", "precision", "recall", "tp_r", "dropped", "settle_share", "visits"]
    print("| arm | " + " | ".join(keys) + " |")
    print("|---|" + "---|" * len(keys))
    for arm in ARMS:
        infos = [run_info(run(arm, s)) for s in seeds if (run(arm, s) / "footprints.bin").exists()]
        if not infos:
            continue
        cols = []
        for k in keys:
            v = [i[k] for i in infos]
            cols.append(f"{np.mean(v):.4g} ({', '.join(f'{x:.4g}' for x in v)})")
        print(f"| {arm} (n={len(infos)}) | " + " | ".join(cols) + " |")
    print("\n| pair | Jaccard | median cos |")
    print("|---|---|---|")
    for arm in ["eqv", "on"]:
        for s in seeds:
            a, b = run("off", s), run(arm, s)
            if (a / "footprints.bin").exists() and (b / "footprints.bin").exists():
                j, c = compare(a, b)
                print(f"| off vs {arm}, seed {s} | {j:.3f} | {c:.4f} |")
    for arm in ARMS:
        for s1, s2 in itertools.combinations(seeds, 2):
            a, b = run(arm, s1), run(arm, s2)
            if (a / "footprints.bin").exists() and (b / "footprints.bin").exists():
                j, c = compare(a, b)
                print(f"| {arm}: seed {s1} vs {s2} (noise) | {j:.3f} | {c:.4f} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
