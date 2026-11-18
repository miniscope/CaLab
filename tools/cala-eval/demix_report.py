#!/usr/bin/env python
"""Baseline-versus-candidate demixing report from `demix_metrics.py` outputs (numpy only).

    python tools/cala-eval/demix_report.py --base RUNS/base --new RUNS/new [--title T] [--md OUT.md]

`RUNS/<arm>/<sim>/` holds one run each (`demix_pairs.tsv`, `demix_corr.tsv`, `demix_det.json`).
`demix_suite.py` calls this after a tier has run.

Two kinds of metric, two kinds of error bar:

* Pair metrics (bite share, bite ratio, control ring, leak_sd, trace-correlation excess): the pairs of
  all sims are pooled per arm and each arm is bootstrapped over its own pairs (5000 resamples; the two
  arms are independent because the matched sets differ). The difference CI is the percentile CI of the
  paired draws. "+-" is the sd of the per-sim values (spread across seeds).
* Run metrics (matched, false, net, merges, splits, support area, ms/frame): one value per sim; the
  difference is the per-sim paired difference with a t CI (needs >= 3 sims).

Lookback metrics (17 Nov 2026), judged with the same bootstrap and seed rule:

* Birth order. Within a close pair of matched estimates, the later-born one (birth gap > 3 % of the recording,
  `BIRTH_TIE_FRAC`) against the earlier-born one: bite share and leak_sd are computed on the rows whose cell i is
  the later (or earlier) member. The bite hypothesis is that the later-born cell never fills where its older
  neighbour sits, so its share is high and the earlier one's low.
* Late-born cells: i born in the last 20 % of the recording (`LATE_FRAC`): bite share, leak, and the correlation
  excess of pairs whose later member is late-born (same 1.5-3 D reference as the headline).
* Undetected neighbours: matched cell i with a detectable GT neighbour j within 1 D that no estimate matches.
  est/true at j's centre above 1.3 means i's footprint has absorbed the undetected cell's light (over-fill).
* Overlap clusters (`demix_clusters.py`): cluster-size distribution of the final library (rho >= 0.05, K_max 6).

Flag. `better` / `worse` needs the difference CI to exclude 0 AND at least 2/3 of the sims to move in the
same direction (a pooled bootstrap alone treats the pairs of one sim as independent, which they are not).
Anything else is `within noise` (`seeds disagree` when only the second condition failed). Metrics with
no good direction (control ring, merges, splits, area) say `changed` instead of better/worse.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path

import numpy as np

BINS = [(0.0, 0.5), (0.5, 0.75), (0.75, 1.0)]
BITE_THR = 0.5
OVERFILL_THR = 1.3  # est/true at an undetected neighbour's centre above this = over-fill (design: Stage 2 criterion)
BIRTH_TIE_FRAC = 0.03  # birth gaps below this share of the recording count as simultaneous (about 15 s of a 480 s sim)
LATE_FRAC = 0.2  # late-born = born in the last fifth of the recording
MIN_N = 5  # fewest pairs for a statistic
N_BOOT = 5000
ISOLATED_D, CLOSE_D = 1.5, 1.0  # as demix_metrics.cell_accuracy rows are split
FP_LOW = 0.9  # footprint r with GT below this = a poor footprint
CHUNK = 250
SEED_AGREE = 2 / 3

T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131,
        2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042]  # fmt: skip


def t_crit(df):
    return T975[df - 1] if 1 <= df <= 30 else 1.96


# ----------------------------------------------------------------- loading


def _read(path: Path):
    if not path.exists():
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def _col(rows, key):
    out = []
    for r in rows:
        try:
            out.append(float(r[key]))
        except (KeyError, ValueError):
            out.append(math.nan)
    return np.array(out)


def load_run(run: Path):
    """Arrays of one run, with the pair filters of the refine-gate analysis applied."""
    pairs = _read(run / "demix_pairs.tsv")
    d = _col(pairs, "d_diam")
    true_c, est_c = _col(pairs, "true_at_cj"), _col(pairs, "est_at_cj")
    ok = (true_c > 0.1) & (_col(pairs, "jmatched") == 1)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = est_c / true_c
        tr = _col(pairs, "true_ring")
        ring = np.where(tr > 0, _col(pairs, "est_ring") / tr, math.nan)
    leak = np.abs(_col(pairs, "leak_sd"))
    corr = _read(run / "demix_corr.tsv")
    det = json.loads((run / "demix_det.json").read_text()) if (run / "demix_det.json").exists() else {}
    T = float(det.get("frames", math.nan))
    bi, bj = _col(pairs, "born_i"), _col(pairs, "born_j")
    gap = (bi - bj)[ok] / T  # > 0: i is the later-born of the pair (needs both births)
    und = (true_c > 0.1) & (_col(pairs, "jmatched") == 0) & (_col(pairs, "jdet") == 1)
    cmax = _col(corr, "born_max") / T
    cells = _read(run / "demix_cells.tsv") if (run / "demix_cells.tsv").exists() else []
    nn = _col(cells, "nn_diam") if cells else np.array([])
    return {
        "name": run.name, "d": d[ok], "ratio": ratio[ok], "excess": (est_c - true_c)[ok], "ring": ring[ok], "leak": leak[ok],
        "cd": _col(corr, "d_diam"), "cc": _col(corr, "c_est"), "det": det,
        # birth order and late birth, aligned with d / ratio / leak (nan birth: in neither group)
        "later": gap > BIRTH_TIE_FRAC, "earlier": gap < -BIRTH_TIE_FRAC,
        "late_i": (bi[ok] / T) >= 1 - LATE_FRAC, "early_i": (bi[ok] / T) < 1 - LATE_FRAC,
        "c_late": cmax >= 1 - LATE_FRAC,
        # undetected GT neighbours of matched cells: distance and est/true at their centre
        "und_d": d[und], "und_ratio": ratio[und],
        # matched cells' footprint and trace accuracy against their GT unit, by nearest GT neighbour distance
        "fp_r": _col(cells, "fp_r") if cells else np.array([]), "tr_r": _col(cells, "tr_r") if cells else np.array([]),
        "nn": nn,
    }  # fmt: skip


def load_arm(arm_dir: Path):
    return [load_run(p) for p in sorted(arm_dir.iterdir()) if (p / "demix_det.json").exists()]


# ----------------------------------------------------------------- statistics


def med(x):
    return np.median(x, axis=-1)


def share_below(x):
    return np.mean(x < BITE_THR, axis=-1)


def share_leak(x):
    return np.mean(x > 0.1, axis=-1)


def excess(near, far):
    return np.median(near, axis=-1) - np.median(far, axis=-1)


def finite(x):
    return x[np.isfinite(x)]


def point(stat, arrays):
    if any(len(a) < MIN_N for a in arrays):
        return math.nan
    return float(stat(*arrays))


def boot(stat, arrays, rng, n_boot=N_BOOT):
    """Bootstrap draws of stat over the arrays (each resampled on its own)."""
    if any(len(a) < MIN_N for a in arrays):
        return np.full(n_boot, math.nan)
    out = []
    for lo in range(0, n_boot, CHUNK):
        k = min(CHUNK, n_boot - lo)
        out.append(stat(*[a[rng.integers(0, len(a), (k, len(a)))] for a in arrays]))
    return np.concatenate(out)


def pct(draws, q):
    return float(np.percentile(draws, q)) if np.isfinite(draws).all() else math.nan


def t_ci(deltas):
    """(mean, lo, hi) of paired per-sim differences; CI nan below 3 sims."""
    x = np.array([v for v in deltas if np.isfinite(v)])
    if len(x) == 0:
        return math.nan, math.nan, math.nan
    m = float(x.mean())
    if len(x) < 3:
        return m, math.nan, math.nan
    h = t_crit(len(x) - 1) * float(x.std(ddof=1)) / math.sqrt(len(x))
    return m, m - h, m + h


def classify(lo, hi, deltas, better):
    """(flag, agree text). better: 'lower' | 'higher' | None (no direction)."""
    ds = [v for v in deltas if np.isfinite(v)]
    if not np.isfinite(lo) or not np.isfinite(hi) or not ds:
        return "n/a", ""
    mid = (lo + hi) / 2
    sgn = 1 if mid > 0 else -1
    agree = sum(1 for v in ds if v * sgn > 0)
    txt = f"{agree}/{len(ds)}"
    if lo <= 0 <= hi:
        return "within noise", txt
    if agree < math.ceil(SEED_AGREE * len(ds)):
        return "within noise (seeds disagree)", txt
    if better is None:
        return "changed", txt
    good = (mid < 0) if better == "lower" else (mid > 0)
    return ("better" if good else "worse"), txt


# ------------------------------------------------------------ metric table


def _bin(r, lo, hi, key):
    m = (r["d"] >= lo) & (r["d"] < hi)
    return finite(r[key][m])


def _late_corr(r):
    c = _g(r, "c_late")
    if len(c) != len(r["cd"]):
        return np.array([])
    return finite(r["cc"][(r["cd"] < 1.0) & c])


def _near_far(r, hi_near=1.0):
    near = finite(r["cc"][r["cd"] < hi_near])
    far = finite(r["cc"][(r["cd"] >= 1.5) & (r["cd"] < 3.0)])
    return near, far


def _g(r, key):
    """Array `key` of a run, empty when the run predates the lookback metrics (tests, old trees)."""
    return r.get(key, np.array([]))


def _sel(r, lo, hi, key, group):
    """Finite `key` values of the pairs of `group` (bool array aligned with r['d']) with lo <= d < hi."""
    g = _g(r, group)
    if len(g) != len(r["d"]):
        return np.array([])
    m = (r["d"] >= lo) & (r["d"] < hi) & g
    return finite(r[key][m])


def share_over(x):
    return np.mean(x > OVERFILL_THR, axis=-1)


def _overabs(r):
    """1 where a pair < 1 D is over-filled by ratio AND by an absolute excess above 0.05 of the peak, else 0."""
    if "excess" not in r:
        return np.array([])
    m = r["d"] < 1.0
    x, e = r["ratio"][m], r["excess"][m]
    ok = np.isfinite(x) & np.isfinite(e)
    return ((x[ok] > OVERFILL_THR) & (e[ok] > 0.05)).astype(float)


def share_pos(x):
    return np.mean(x > 0.5, axis=-1)


def _und(r, lo, hi):
    d, v = _g(r, "und_d"), _g(r, "und_ratio")
    return finite(v[(d >= lo) & (d < hi)]) if len(d) == len(v) else np.array([])


def _acc(r, key, group):
    v, nn = r.get(key, np.array([])), r.get("nn", np.array([]))
    if len(v) != len(nn) or not len(v):
        return np.array([])
    m = {"all": np.ones(len(v), bool), "isolated": nn >= ISOLATED_D, "close": nn < CLOSE_D}[group]
    return finite(v[m])


def share_fp_low(x):
    return np.mean(x < FP_LOW, axis=-1)


def pair_metrics():
    """[(name, group, getter(run) -> arrays, stat, better, fmt)]."""
    ms = []
    # footprint and trace accuracy of ALL matched cells vs GT (Refine's purpose), isolated vs close-pair cells
    for grp, label in (("all", "all matched cells"), ("isolated", f"isolated (no GT unit within {ISOLATED_D} D)"), ("close", f"close-pair (GT unit within {CLOSE_D} D)")):
        ms.append((f"Footprint r with GT, median, {label}", "accuracy", lambda r, g=grp: (_acc(r, "fp_r", g),), med, "higher", "{:.4f}"))
        ms.append((f"Footprint r with GT < {FP_LOW}, share, {label}", "accuracy", lambda r, g=grp: (_acc(r, "fp_r", g),), share_fp_low, "lower", "{:.3f}"))
        ms.append((f"Trace r with GT, median, {label}", "accuracy", lambda r, g=grp: (_acc(r, "tr_r", g),), med, "higher", "{:.4f}"))
    ms.append(("Trace corr excess < 1 D (15 s high-pass; vs 1.5-3 D) HEADLINE", "headline", lambda r: _near_far(r), excess, "lower", "{:+.3f}"))
    ms.append(("Trace corr excess 0.5-1 D", "corr", lambda r: (finite(r["cc"][(r["cd"] >= 0.5) & (r["cd"] < 1)]), _near_far(r)[1]), excess, "lower", "{:+.3f}"))
    for lo, hi in BINS:
        ms.append((f"Bite share ratio < 0.5, {lo}-{hi} D", "bite", lambda r, lo=lo, hi=hi: (_bin(r, lo, hi, "ratio"),), share_below, "lower", "{:.3f}"))
    for lo, hi in BINS:
        ms.append((f"Bite ratio median, {lo}-{hi} D (secondary)", "bite_med", lambda r, lo=lo, hi=hi: (_bin(r, lo, hi, "ratio"),), med, "higher", "{:.3f}"))
    # over-fill toward a matched neighbour (the mirror of a bite): ratio, and with an absolute excess
    for lo, hi in BINS + [(0.0, 1.0)]:
        ms.append((f"Over-fill share est/true > 1.3, matched neighbour, {lo}-{hi} D", "overfill", lambda r, lo=lo, hi=hi: (_bin(r, lo, hi, "ratio"),), share_over, "lower", "{:.3f}"))
    ms.append(("Over-fill share est/true > 1.3 and est - true > 0.05 of peak, matched neighbour, < 1 D", "overfill", lambda r: (_overabs(r),), share_pos, "lower", "{:.3f}"))
    ms.append(("Control ring ratio median, < 1 D", "control", lambda r: (finite(r["ring"][r["d"] < 1.0]),), med, None, "{:.3f}"))
    ms.append(("leak_sd median, < 1 D", "leak", lambda r: (finite(r["leak"][r["d"] < 1.0]),), med, "lower", "{:.4f}"))
    ms.append(("leak_sd share > 0.1, < 1 D", "leak", lambda r: (finite(r["leak"][r["d"] < 1.0]),), share_leak, "lower", "{:.3f}"))
    # birth order within a matched pair: rows whose cell i is the later / earlier born of the two
    for grp, label in (("later", "later-born cell"), ("earlier", "earlier-born cell")):
        for lo, hi in BINS:
            ms.append((f"Bite share ratio < 0.5, {label}, {lo}-{hi} D", "birth", lambda r, lo=lo, hi=hi, g=grp: (_sel(r, lo, hi, "ratio", g),), share_below, "lower", "{:.3f}"))
        ms.append((f"leak_sd share > 0.1, {label}, < 1 D", "birth", lambda r, g=grp: (_sel(r, 0.0, 1.0, "leak", g),), share_leak, "lower", "{:.3f}"))
    # late-born cells (born in the last fifth of the recording)
    for lo, hi in BINS:
        ms.append((f"Bite share ratio < 0.5, late-born cell, {lo}-{hi} D", "late", lambda r, lo=lo, hi=hi: (_sel(r, lo, hi, "ratio", "late_i"),), share_below, "lower", "{:.3f}"))
    ms.append(("leak_sd share > 0.1, late-born cell, < 1 D", "late", lambda r: (_sel(r, 0.0, 1.0, "leak", "late_i"),), share_leak, "lower", "{:.3f}"))
    ms.append(("Trace corr excess < 1 D, pairs with a late-born member", "late", lambda r: (_late_corr(r), _near_far(r)[1]), excess, "lower", "{:+.3f}"))
    # undetected GT neighbour (detectable, matched by no estimate) of a matched cell
    for lo, hi in BINS:
        ms.append((f"Over-fill share est/true > 1.3 at undetected neighbour, {lo}-{hi} D", "undet", lambda r, lo=lo, hi=hi: (_und(r, lo, hi),), share_over, "lower", "{:.3f}"))
    ms.append(("Over-fill share est/true > 1.3 at undetected neighbour, < 1 D", "undet", lambda r: (_und(r, 0.0, 1.0),), share_over, "lower", "{:.3f}"))
    ms.append(("est/true at undetected neighbour's centre, median, < 1 D", "undet", lambda r: (_und(r, 0.0, 1.0),), med, "lower", "{:.3f}"))
    return ms


RUN_METRICS = [
    ("Matched cells", "matched", "higher", "{:.1f}"),
    ("False cells", "false", "lower", "{:.1f}"),
    ("Net (matched - false)", "net", "higher", "{:.1f}"),
    ("Final cells matching 2+ GT units (footprint r >= 0.5)", "multi_gt", "lower", "{:.1f}"),
    ("... of which absorption (est/true > 1.3 at another of its GT units)", "multi_gt_absorb", "lower", "{:.1f}"),
    ("... of which light regained (matched, est/true <= 1.3 at its other GT units)", "multi_gt_regained", None, "{:.1f}"),
    ("Close GT pairs, both matched, 0-0.25 D", "both_0.0-0.25", "higher", "{:.1f}"),
    ("Close GT pairs, both matched, 0.25-0.5 D", "both_0.25-0.5", "higher", "{:.1f}"),
    ("Close GT pairs, both matched, 0.5-0.75 D", "both_0.5-0.75", "higher", "{:.1f}"),
    ("Close GT pairs, both matched, 0.75-1 D", "both_0.75-1.0", "higher", "{:.1f}"),
    ("Late-born cells in the final library (born in the last 20 %)", "n_late", None, "{:.1f}"),
    ("Late-born cells matched", "matched_late", "higher", "{:.1f}"),
    ("Cells in an overlap cluster of 2+ (rho >= 0.05, K_max 6)", "clusters/cells_in_2plus", None, "{:.1f}"),
    ("Largest overlap component (before the K_max cut)", "clusters/max_component", None, "{:.1f}"),
    ("Merge edits (about 2/3 harmless folds; see two-GT cells)", "merges", None, "{:.1f}"),
    ("Splits", "splits", None, "{:.1f}"),
    ("Median support area (px)", "area_support", None, "{:.0f}"),
    ("Median half-max area (px)", "area_halfmax", None, "{:.0f}"),
    ("QC ms/frame", "ms_per_frame", "lower", "{:.3f}"),
    ("Slow loop ms/frame, last pass (observe + step; wall, 2 runs at a time)", "slow_ms", "lower", "{:.3f}"),
    ("Slow loop observe ms/frame, last pass", "slow_obs_ms", "lower", "{:.3f}"),
    ("Slow loop step ms/frame, last pass", "slow_step_ms", "lower", "{:.3f}"),
    ("Slow loop work units/frame, last pass (deterministic)", "slow_work", "lower", "{:.0f}"),
    ("Cluster stores, peak MB", "store_mb", "lower", "{:.1f}"),
    ("Peak RSS (GB)", "rss_gb", "lower", "{:.2f}"),
]


def pair_res_totals(arm, names):
    """{bin: [both, one, neither]} summed over the named sims of one arm (load_arm output)."""
    tot = {}
    for run in arm:
        if run["name"] not in names:
            continue
        for k, v in ((run["det"].get("pair_res")) or {}).items():
            t = tot.setdefault(k, [0, 0, 0])
            for n in range(3):
                t[n] += v[n]
    return tot


def common_sims(base, new):
    nb = {r["name"] for r in base}
    return [r["name"] for r in base if r["name"] in {x["name"] for x in new}] if nb else []


def compare(base, new, seed=0):
    """List of row dicts for the report; base/new are load_arm() outputs."""
    rng = np.random.default_rng(seed)
    names = common_sims(base, new)
    B = {r["name"]: r for r in base if r["name"] in names}
    N = {r["name"]: r for r in new if r["name"] in names}
    rows = []
    for name, group, get, stat, better, fmt in pair_metrics():
        ab = [np.concatenate(x) if len(x) else np.array([]) for x in zip(*[get(B[s]) for s in names])]
        an = [np.concatenate(x) if len(x) else np.array([]) for x in zip(*[get(N[s]) for s in names])]
        vb, vn = point(stat, ab), point(stat, an)
        db, dn = boot(stat, ab, rng), boot(stat, an, rng)
        diff = dn - db
        per_b = [point(stat, get(B[s])) for s in names]
        per_n = [point(stat, get(N[s])) for s in names]
        deltas = [n_ - b_ for b_, n_ in zip(per_b, per_n)]
        lo, hi = pct(diff, 2.5), pct(diff, 97.5)
        flag, agree = classify(lo, hi, deltas, better)
        rows.append({
            "name": name, "group": group, "fmt": fmt, "base": vb, "new": vn,
            "base_ci": (pct(db, 2.5), pct(db, 97.5)), "new_ci": (pct(dn, 2.5), pct(dn, 97.5)),
            "base_sd": _sd(per_b), "new_sd": _sd(per_n), "diff": vn - vb, "lo": lo, "hi": hi,
            "agree": agree, "flag": flag, "n_base": len(ab[0]), "n_new": len(an[0]), "per_base": per_b, "per_new": per_n,
        })  # fmt: skip
    for name, key, better, fmt in RUN_METRICS:
        per_b = [_num(_dig(B[s]["det"], key)) for s in names]
        per_n = [_num(_dig(N[s]["det"], key)) for s in names]
        deltas = [n_ - b_ for b_, n_ in zip(per_b, per_n)]
        m, lo, hi = t_ci(deltas)
        flag, agree = classify(lo, hi, deltas, better)
        rows.append({
            "name": name, "group": "run", "fmt": fmt, "base": _mean(per_b), "new": _mean(per_n), "base_ci": None, "new_ci": None,
            "base_sd": _sd(per_b), "new_sd": _sd(per_n), "diff": m, "lo": lo, "hi": hi, "agree": agree, "flag": flag,
            "n_base": len(names), "n_new": len(names), "per_base": per_b, "per_new": per_n,
        })  # fmt: skip
    return names, rows


def _dig(d, key):
    """d[key], where key may be 'a/b' for d['a']['b'] (keys such as 'both_0.5-0.75' contain dots); None when missing."""
    for k in ([key] if key in d else key.split("/")):
        d = d.get(k) if isinstance(d, dict) else None
    return d


def cluster_totals(arm, names):
    """Cluster-size histogram summed over the named sims of one arm: {size: clusters}, cells, cells in 2+, cut edges."""
    tot = {"hist": {}, "cells": 0, "in2": 0, "edges": 0, "cut": 0, "big": 0, "maxc": 0}
    for run in arm:
        c = run["det"].get("clusters")
        if run["name"] not in names or not c:
            continue
        for k, v in c["hist"].items():
            tot["hist"][k] = tot["hist"].get(k, 0) + v
        tot["cells"] += c["n_cells"]
        tot["in2"] += c["cells_in_2plus"]
        tot["edges"] += c["edges"]
        tot["cut"] += c["edges_cut"]
        tot["big"] += c["cells_in_big_component"]
        tot["maxc"] = max(tot["maxc"], c["max_component"])
    return tot


def cluster_section(arms, labels):
    """Markdown table of the cluster-size distribution, one column per arm (cluster_totals outputs)."""
    if not any(a["cells"] for a in arms):
        return []
    sizes = sorted({int(k) for a in arms for k in a["hist"]})
    out = ["", "## Overlap clusters of the final library (rho >= 0.05, greedy K_max 6; pooled over sims)", "",
           "Cluster = group of cells whose filtered footprints overlap (normalised Gram rho >= 0.05), cut to at most 6 members "
           "(design_joint_update.md 2.1). Size 1 = a cell with no overlapping neighbour (keeps the per-cell path).", "",
           "| | " + " | ".join(labels) + " |", "|---|" + "---|" * len(arms)]  # fmt: skip
    for s in sizes:
        out.append(f"| clusters of size {s} | " + " | ".join(str(a["hist"].get(str(s), 0)) for a in arms) + " |")
    out.append("| cells | " + " | ".join(str(a["cells"]) for a in arms) + " |")
    out.append("| cells in a cluster of 2+ | " + " | ".join(f"{a['in2']} ({a['in2'] / max(a['cells'], 1):.0%})" for a in arms) + " |")
    out.append("| edges (rho >= 0.05) / cut by K_max | " + " | ".join(f"{a['edges']} / {a['cut']}" for a in arms) + " |")
    out.append("| cells whose component exceeds K_max | " + " | ".join(str(a["big"]) for a in arms) + " |")
    out.append("| largest component (any sim) | " + " | ".join(str(a["maxc"]) for a in arms) + " |")
    return out


def _num(x):
    try:
        return float(x) if x is not None else math.nan
    except (TypeError, ValueError):
        return math.nan


def _mean(v):
    v = [x for x in v if np.isfinite(x)]
    return float(np.mean(v)) if v else math.nan


def _sd(v):
    v = [x for x in v if np.isfinite(x)]
    return float(np.std(v, ddof=1)) if len(v) > 1 else math.nan


# ----------------------------------------------------------------- markdown


def _f(fmt, x):
    return "n/a" if x is None or not np.isfinite(x) else fmt.format(x)


def _cell(r, which):
    v, sd, ci = r[which], r[which + "_sd"], r[which + "_ci"]
    s = _f(r["fmt"], v)
    if ci is not None and np.isfinite(ci[0]):
        s += f" [{_f(r['fmt'], ci[0])}, {_f(r['fmt'], ci[1])}]"
    if np.isfinite(sd):
        s += f" (sd {_f(r['fmt'], sd)})"
    return s


def render(names, rows, base_label="base", new_label="new", title="Demixing evaluation", meta=None, res=None, clusters=None):
    sgn = lambda f: ("+" if f > 0 else "") if np.isfinite(f) else ""  # noqa: E731
    out = [f"# {title}", ""]
    if meta:
        out += [f"- {k}: {v}" for k, v in meta.items()] + [""]
    out += [f"Sims ({len(names)}): {', '.join(names)}. Baseline = `{base_label}`, candidate = `{new_label}`.", ""]
    head = next(r for r in rows if r["group"] == "headline")
    flags = [r["flag"] for r in rows]
    out += [
        f"**Headline** (trace correlation excess < 1 D, lower is better): {_f(head['fmt'], head['base'])} -> {_f(head['fmt'], head['new'])}, "
        f"diff {sgn(head['diff'])}{_f(head['fmt'], head['diff'])} [{_f(head['fmt'], head['lo'])}, {_f(head['fmt'], head['hi'])}]: **{head['flag']}**. "
        f"Across all {len(rows)} metrics: {flags.count('better')} better, {flags.count('worse')} worse, "
        f"{flags.count('changed')} changed (no direction), {sum(f.startswith('within') for f in flags)} within noise.",
        "",
        "Pair metrics: pooled over sims, `[..]` = 95 % bootstrap CI over pairs, `sd` = spread of the per-sim values. "
        "Run metrics: mean over sims, `sd` across sims. Diff CI: bootstrap (pair metrics) or paired t over sims (run metrics, needs >= 3). "
        "Flag: the CI excludes 0 and >= 2/3 of the sims agree in sign; `seeds` = sims that moved the same way as the pooled difference.",
        "",
        f"| metric | n pairs ({base_label} / {new_label}) | {base_label} | {new_label} | diff [95 % CI] | seeds | flag |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        npairs = f"{r['n_base']} / {r['n_new']}" if r["group"] != "run" else f"{r['n_base']} sims"
        name = f"**{r['name']}**" if r["group"] == "headline" else r["name"]
        diff = f"{sgn(r['diff'])}{_f(r['fmt'], r['diff'])}"
        if np.isfinite(r["lo"]):
            diff += f" [{_f(r['fmt'], r['lo'])}, {_f(r['fmt'], r['hi'])}]"
        flag = f"**{r['flag']}**" if r["flag"] in ("better", "worse") else r["flag"]
        out.append(f"| {name} | {npairs} | {_cell(r, 'base')} | {_cell(r, 'new')} | {diff} | {r['agree']} | {flag} |")
    if res:
        out += ["", "## Close-pair resolution (GT neuron pairs pooled over sims; matched in the final library: both / one / neither)", "",
                f"| distance | {base_label} | {new_label} |", "|---|---|---|"]
        for key in res[0]:
            out.append(f"| {key} D | " + " | ".join("/".join(map(str, a[key])) for a in res) + " |")
    if clusters:
        out += cluster_section(clusters, [base_label, new_label])
    out += ["", "## Per sim", "", f"| sim | metric | {base_label} | {new_label} | diff |", "|---|---|---|---|---|"]
    show = ("Trace corr excess < 1 D", "Bite share ratio < 0.5, 0.75-1.0", "Matched cells", "False cells", "Merges", "Splits", "QC ms/frame", "Slow loop ms/frame")
    for r in rows:
        if not any(r["name"].startswith(s) for s in show):
            continue
        for k, s in enumerate(names):
            b, n = r["per_base"][k], r["per_new"][k]
            out.append(f"| {s} | {r['name'].replace(' HEADLINE', '')} | {_f(r['fmt'], b)} | {_f(r['fmt'], n)} | {sgn(n - b)}{_f(r['fmt'], n - b)} |")
    return "\n".join(out) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", type=Path, required=True)
    ap.add_argument("--new", type=Path, required=True)
    ap.add_argument("--title", default="Demixing evaluation")
    ap.add_argument("--md", type=Path)
    a = ap.parse_args(argv)
    names, rows = compare(load_arm(a.base), load_arm(a.new))
    if not names:
        sys.exit("no sims in common between the two arms (missing demix_det.json?)")
    b, n = load_arm(a.base), load_arm(a.new)
    md = render(names, rows, a.base.name, a.new.name, a.title, None, [pair_res_totals(b, names), pair_res_totals(n, names)],
                [cluster_totals(b, names), cluster_totals(n, names)])
    if a.md:
        a.md.write_text(md)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
