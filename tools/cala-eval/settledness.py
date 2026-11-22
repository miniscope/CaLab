#!/usr/bin/env python
"""Per-cell settledness during the Final settle, and stop levels (results/2026-11-22-settledness-plan.md).

    $MINISIM_PY tools/cala-eval/settledness.py dist  [--root R]   # measure distributions only (no quality)
    $MINISIM_PY tools/cala-eval/settledness.py score [--root R] > results.md

Offline, on the saved runs of PR #464 (`slider_tier1.sh`): `<root>/{real,sims}/<run>/B100/footprints_settle{c}.bin`
are the libraries at checkpoint c of the in-order full Final settle (every 1,200 frames; c = 0 is its start).

Two per-cell measures, each from the cell's last K + 1 checkpoint footprints only (computable online in the app):

* M1 `step`: the size of the last step, |f_c - f_{c-1}| on unit-L2 footprints (change relative to the footprint's
  own scale; magnitude only).
* M2 `drift`: the consistent (directional) part of the last K steps, per region (core and edge ring). With steps
  d_1..d_K on a region's pixels, S = sum_{i<j} d_i.d_j estimates C(K,2) |mu|^2 for a steady drift mu per step and is
  0 in expectation for wobble with no direction (independent or anti-correlated steps).
  drift_r = sqrt(max(0, S) / C(K,2)) / max(|f_c on r|, 0.1); the cell's value is the larger of core and edge.
* M2b `ucb`: the same with S + 2 Q, Q = sqrt(sum_{i<j} (d_i.d_j)^2) the sd of S under random step-sign flips (the
  no-direction null): a "confidently settled" bound that also penalises large wobble.

RAM: sparse libraries plus one dense ground-truth stack per sim at a time (a few hundred MB).
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_dilation

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_metrics as DM  # noqa: E402

ROOT = Path.home() / "Projects/cala-data/runs/work-slider-tier1"
SIMDIR = Path.home() / "Projects/cala-data/sims-gt110"
PAIRDIR = Path.home() / "Projects/cala-data/demix-bench/measure/pairsim_v2191"
ARMS = ["REF", "P30", "S30"]
RECS = {"sa": "10_43_21", "sb": "14_57_02"}
SEEDS = [1, 2, 3]
K = 3  # steps in the window (K + 1 checkpoints)
CORE = 0.5  # core = pixels at >= half the footprint's peak
RING = 2  # edge ring: the window's union support minus the core, dilated by this many px
NORM_FLOOR = 0.1
CHECK = 1200  # frames between checkpoints

# Pre-registered grid (plan file): thresholds per measure, and shares of settled cells.
RULES = [("step", t, q) for t in (0.08, 0.12) for q in (0.80, 0.90)] + \
    [("drift", t, q) for t in (0.01, 0.02, 0.03) for q in (0.90, 0.95)] + \
    [("ucb", t, q) for t in (0.05, 0.08) for q in (0.80, 0.90)]
COL = {"step": 0, "ucb": 1, "drift": 4}  # columns of cell_measures


# ------------------------------------------------------------------------------------------- libraries


def read_lib(path: Path):
    """footprints*.bin -> (h, w, {id: (idx, unit-L2 values)})."""
    h, w, ids, cells, _f = DM.read_library(path)
    out = {}
    for cid, (idx, v) in zip(ids, cells):
        n = float(np.sqrt((v * v).sum()))
        if n > 0:
            out[int(cid)] = (idx, v / n)
    return h, w, out


def checkpoints(d: Path):
    """[(c, frames at c, path)] of a B100 dir; c = 0 is the start of the pass. The last one is the end."""
    out = []
    c = 0
    while (d / f"footprints_settle{c}.bin").exists():
        out.append((c, c * CHECK, d / f"footprints_settle{c}.bin"))
        c += 1
    rows = DM.read_tsv(d / "settle_checks.tsv")
    fr = {int(r["check"]): int(r["frames"]) for r in rows}
    return [(c, fr.get(c, f), p) for c, f, p in out]


# ------------------------------------------------------------------------------------------- measures


def window_dense(fps, w):
    """Dense patches of a list of sparse footprints over their joint bbox padded by RING + 1."""
    ys = np.concatenate([i // w for i, _ in fps])
    xs = np.concatenate([i % w for i, _ in fps])
    y0, x0 = ys.min() - RING - 1, xs.min() - RING - 1
    H, W = ys.max() - y0 + RING + 2, xs.max() - x0 + RING + 2
    A = np.zeros((len(fps), H, W))
    for k, (i, v) in enumerate(fps):
        A[k, i // w - y0, i % w - x0] = v
    return A


def cell_measures(fps, w):
    """fps: the cell's K + 1 footprints (oldest first). -> (step, drift_ucb, drift_core, drift_edge, drift_point)."""
    A = window_dense(fps, w)
    f = A[-1]
    D = np.diff(A, axis=0)  # K steps
    step = float(np.sqrt((D[-1] ** 2).sum()))
    core = f >= CORE * f.max()
    edge = binary_dilation((A != 0).any(0), iterations=RING) & ~core
    res = []
    for reg in (core, edge):
        d = D[:, reg]
        G = d @ d.T
        iu = np.triu_indices(len(d), 1)
        S, Q = float(G[iu].sum()), float(np.sqrt((G[iu] ** 2).sum()))
        nr = max(float(np.sqrt((f[reg] ** 2).sum())), NORM_FLOOR)
        res.append((math.sqrt(max(0.0, S + 2 * Q) / len(iu[0])) / nr, math.sqrt(max(0.0, S) / len(iu[0])) / nr))
    (uc, pc), (ue, pe) = res
    return step, max(uc, ue), uc, ue, max(pc, pe)


def run_measures(d: Path):
    """Per checkpoint c >= K: {id: measures} for cells present in all K + 1 libraries; plus cell counts.
    Cells not in the whole window (new or merged) count as not settled."""
    cps = checkpoints(d)
    libs = []
    out = []
    for c, fr, p in cps:
        h, w, lib = read_lib(p)
        libs.append(lib)
        if len(libs) > K + 1:
            libs.pop(0)
        if c < K:
            continue
        m = {}
        for cid in lib:
            if all(cid in L for L in libs):
                m[cid] = cell_measures([L[cid] for L in libs], w)
        out.append({"c": c, "frames": fr, "n": len(lib), "m": m})
    return cps, out


def share_settled(row, meas, tau):
    k = COL[meas]
    return sum(1 for v in row["m"].values() if v[k] < tau) / max(row["n"], 1)


def stop_at(rows, meas, tau, q):
    """First checkpoint with a share of settled cells >= q; None = the full pass."""
    for r in rows:
        if share_settled(r, meas, tau) >= q:
            return r["c"]
    return None


# ------------------------------------------------------------------------------------------- dist


def runs(root: Path):
    for rec in RECS:
        for arm in ARMS:
            for s in SEEDS:
                d = root / "real" / f"{rec}_{arm}_s{s}" / "B100"
                if (d / "footprints_settle0.bin").exists():
                    yield "real", f"{rec}_{arm}_s{s}", d
    for p in sorted((root / "sims").glob("*_s1")):
        if (p / "B100" / "footprints_settle0.bin").exists():
            yield "sims", p.name, p / "B100"


def dist(root: Path) -> None:
    print("| kind | run | checkpoint | frames | cells | in window | step p50 / p80 / p95 | drift p50 / p80 / p95 |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for kind, name, d in runs(root):
        _, rows = run_measures(d)
        for r in rows:
            v = np.array(list(r["m"].values())) if r["m"] else np.zeros((0, 5))
            q = lambda j: " / ".join(f"{np.percentile(v[:, j], p):.4f}" for p in (50, 80, 95)) if len(v) else "-"  # noqa: E731
            print(f"| {kind} | {name} | {r['c']} | {r['frames']} | {r['n']} | {len(v)} | {q(0)} | {q(1)} |")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["dist", "score"])
    ap.add_argument("--root", type=Path, default=ROOT)
    a = ap.parse_args(argv)
    if a.what == "dist":
        dist(a.root)
    else:
        score(a.root)  # noqa: F821
    return 0


if __name__ == "__main__":
    sys.exit(main())
