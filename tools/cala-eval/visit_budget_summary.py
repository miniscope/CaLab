#!/usr/bin/env python
"""Visit budget sweep (results/2026-11-24-visit-budget-sweep.md): one row per run, then per budget the mean over runs.

    $MINISIM_PY tools/cala-eval/visit_budget_summary.py [--root R] [--ref-budget B]

Runs are `visit_budget_sweep.sh` outputs `<root>/<sim>_s<seed>_b<budget>/` (with `demix_metrics.py`'s files). Per run:
visits per observed Discover frame and per Final-settle frame, cells, matched / false (demix_metrics: Hungarian on the
footprint correlation, r >= 0.7, detectable GT units), precision = matched / cells, recall = matched / detectable
units, mean footprint r of the matched cells (all, and those whose nearest GT neighbour is < 1 D away), median trace r
(demix_metrics `tr_r`, the dumped traces), bitten share (matched pairs within reach whose estimated footprint at the
neighbour's centre is < 0.5 of the truth's; slider_tier1_summary's definition), and wall seconds (Discover, Final
settle) and peak RSS. Per budget and metric: the mean of the paired differences against `--ref-budget` (the app
calibration) over the (sim, seed) runs, with a t 95 % CI, and the seed-to-seed spread at the reference budget (mean
|seed 1 - seed 2| over sims). Needs numpy.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_metrics as DM  # noqa: E402

T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179]
SIMS_V3 = Path.home() / "Projects/cala-data/sims-v3"
_ndet: dict[str, int] = {}


def n_det(sim: str) -> int:
    if sim not in _ndet:
        _h, _w, units, _c = DM.read_oracle(SIMS_V3 / sim / "oracle.bin")
        _ndet[sim] = sum(1 for u in units if u["det"])
    return _ndet[sim]


def one(run: Path) -> dict | None:
    m = re.match(r"(.+)_s(\d+)_b(\d+)_k(\d+)(?:_f(\d+))?$", run.name)
    if not m or not (run / "demix_det.json").exists():
        return None
    sim, seed, budget = m.group(1), int(m.group(2)), int(m.group(3))
    arm = f"b{budget / 1.3e7:.2f}x k{int(m.group(4)) / 100:.1f}" + (f" f{m.group(5)}" if m.group(5) else "")
    log = Path(str(run) + ".log").read_text()
    st = re.search(r"settle: (\d+) frames in ([\d.]+) s .*?, (\d+) visits", log)
    fed, settle_s, settle_v = int(st.group(1)), float(st.group(2)), int(st.group(3))
    pass_s = float(re.search(r"pass 1 done: .*?; (\d+) s", log).group(1))
    rows = DM.read_tsv(run / "global.tsv")
    last = rows[-1]
    slow_frames, visits = float(last["slow_frames"]), float(last["slow_visits"])
    disc_frames = slow_frames - fed
    det = json.loads((run / "demix_det.json").read_text())
    cells = DM.read_tsv(run / "demix_cells.tsv")
    fr = np.array([float(c["fp_r"]) for c in cells])
    nn = np.array([float(c["nn_diam"]) for c in cells])
    tr = np.array([float(c["tr_r"]) for c in cells])
    pr = DM.read_tsv(run / "demix_pairs.tsv")
    ok = [float(p["est_at_cj"]) / float(p["true_at_cj"]) for p in pr
          if float(p["true_at_cj"]) > 0.1 and int(float(p["jmatched"])) == 1]  # fmt: skip
    rss = re.search(r"(\d+)\s+maximum resident", Path(str(run) + ".time").read_text())
    nd = n_det(sim)
    return {
        "sim": sim, "seed": seed, "budget": budget, "arm": arm, "scale": budget / 1.3e7, "steps": int(m.group(4)) / 100,
        "frames": int(m.group(5) or 3000),
        "v_disc": (visits - settle_v) / max(disc_frames, 1), "v_settle": settle_v / max(fed, 1),
        "cells": det["cells"], "matched": det["matched"], "false": det["false"],
        "prec": det["matched"] / max(det["cells"], 1), "rec": det["matched"] / max(nd, 1),
        "fp_r": float(np.mean(fr)) if len(fr) else math.nan,
        "fp_r_close": float(np.mean(fr[nn < 1.0])) if (nn < 1.0).any() else math.nan,
        "tr_r": float(np.nanmedian(tr)) if np.isfinite(tr).any() else math.nan,
        "bitten": float(np.mean([x < 0.5 for x in ok])) if ok else math.nan,
        "gt_prec": float(last["gt_precision"]), "gt_rec": float(last["gt_recall"]),
        "gt_tr_r": float(last["gt_median_true_r"]),
        "disc_s": pass_s - settle_s, "settle_s": settle_s, "rss_gb": int(rss.group(1)) / 1e9 if rss else math.nan,
    }  # fmt: skip


COLS = [("v_disc", "{:.3f}"), ("v_settle", "{:.3f}"), ("cells", "{:.0f}"), ("matched", "{:.0f}"), ("false", "{:.0f}"),
        ("prec", "{:.4f}"), ("rec", "{:.4f}"), ("fp_r", "{:.4f}"), ("fp_r_close", "{:.4f}"), ("tr_r", "{:.4f}"),
        ("bitten", "{:.3f}"), ("gt_prec", "{:.4f}"), ("gt_rec", "{:.4f}"), ("gt_tr_r", "{:.4f}"), ("disc_s", "{:.0f}"),
        ("settle_s", "{:.0f}"), ("rss_gb", "{:.2f}")]  # fmt: skip


def fmt_d(f: str, d: list[float]) -> str:
    """Mean of paired differences with a t 95 % CI."""
    d = [x for x in d if math.isfinite(x)]
    if len(d) < 2:
        return "-"
    h = T975[min(len(d) - 2, len(T975) - 1)] * float(np.std(d, ddof=1)) / math.sqrt(len(d))
    fd = f.replace(":.", ":+.")
    return f"{fd.format(np.mean(d))} [{fd.format(np.mean(d) - h)}, {fd.format(np.mean(d) + h)}]"


def trend(runs: list[dict], c: str):
    """OLS of metric c on log2(budget scale) with one intercept per sim: (slope per doubling, its 95 % half-width),
    and the seed SD pooled over every (sim, arm) seed pair."""
    rs = [r for r in runs if math.isfinite(r[c])]
    sims = sorted({r["sim"] for r in rs})
    X = np.array([[math.log2(r["scale"])] + [float(r["sim"] == s) for s in sims] for r in rs])
    y = np.array([r[c] for r in rs])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    res = y - X @ beta
    dof = len(y) - X.shape[1]
    cov = np.linalg.inv(X.T @ X) * float(res @ res) / max(dof, 1)
    by = {(r["sim"], r["seed"], r["arm"]): r[c] for r in rs}
    d = [by[(s, 1, a)] - by[(s, 2, a)] for (s, k, a) in by if k == 1 and (s, 2, a) in by]
    sd = math.sqrt(float(np.mean(np.square(d))) / 2) if d else math.nan
    return float(beta[0]), T975[min(dof - 1, len(T975) - 1)] * math.sqrt(cov[0, 0]), sd, len(d)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path.home() / "Projects/cala-data/runs/visit-sweep"))
    ap.add_argument("--ref", default="b1.00x k1.2")
    a = ap.parse_args()
    runs = [r for r in (one(p) for p in sorted(Path(a.root).iterdir()) if p.is_dir()) if r]
    runs.sort(key=lambda r: (r["sim"], r["seed"], r["frames"], r["budget"], r["steps"]))
    dirs = [p for p in Path(a.root).iterdir() if p.is_dir() and re.match(r".+_s\d+_b\d+_k\d+", p.name)]
    print(f"Runs scored: {len(runs)} of {len(dirs)} run directories.\n")
    print("| sim | seed | arm | " + " | ".join(c for c, _ in COLS) + " |")
    print("|---" * (len(COLS) + 3) + "|")
    for r in runs:
        print(f"| {r['sim']} | {r['seed']} | {r['arm']} | " + " | ".join(f.format(r[c]) for c, f in COLS) + " |")
    by = {(r["sim"], r["seed"], r["arm"]): r for r in runs}
    arms = sorted({r["arm"] for r in runs}, key=lambda x: (" f" in x, x.split()[1], float(x[1:].split("x")[0])))
    keys = sorted({(r["sim"], r["seed"]) for r in runs})
    print(f"\nPer arm: mean over runs; below it the mean paired difference against `{a.ref}` [t 95 % CI].\n")
    print("| arm | n | " + " | ".join(c for c, _ in COLS) + " |")
    print("|---" * (len(COLS) + 2) + "|")
    for arm in arms:
        if " f" in arm:
            continue
        v = {c: [by[(s, k, arm)][c] for s, k in keys if (s, k, arm) in by] for c, _ in COLS}
        n = len(v["cells"])
        print(f"| {arm} | {n} | " + " | ".join(f.format(np.nanmean(v[c])) for c, f in COLS) + " |")
        if arm != a.ref:
            d = {c: [by[(s, k, arm)][c] - by[(s, k, a.ref)][c] for s, k in keys if (s, k, arm) in by and (s, k, a.ref) in by]
                 for c, _ in COLS}  # fmt: skip
            print("| - ref | | " + " | ".join(fmt_d(f, d[c]) for c, f in COLS) + " |")
    main_runs = [r for r in runs if r["steps"] == 1.2 and r["frames"] == 3000]
    print("\nTrend over the main sweep (Final settle steps 1.2, 3000 frames): slope per doubling of the budget, one")
    print("intercept per sim; 0.5x -> 2x = 2 doublings; seed SD pooled over every (sim, arm) seed pair.\n")
    print("| metric | slope per doubling [95 % CI] | change 0.5x -> 2x | seed SD (pairs) | change / seed SD |")
    print("|---|---|---|---|---|")
    for c, f in COLS:
        if c in ("rss_gb",):
            continue
        b, h, sd, n = trend(main_runs, c)
        fd = f.replace(":.", ":+.")
        print(f"| {c} | {fd.format(b)} [{fd.format(b - h)}, {fd.format(b + h)}] | {fd.format(2 * b)} | {f.format(sd)} ({n}) | "
              f"{2 * b / sd if sd else math.nan:+.1f} |")
    longs = [r for r in runs if r["frames"] != 3000]
    if longs:
        print("\nFull-length runs: per arm mean over seeds.\n")
        print("| arm | n | " + " | ".join(c for c, _ in COLS) + " |")
        print("|---" * (len(COLS) + 2) + "|")
        for arm in sorted({r["arm"] for r in longs}, key=lambda x: float(x[1:].split("x")[0])):
            rs = [r for r in longs if r["arm"] == arm]
            print(f"| {arm} | {len(rs)} | " + " | ".join(f.format(np.nanmean([r[c] for r in rs])) for c, f in COLS) + " |")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
