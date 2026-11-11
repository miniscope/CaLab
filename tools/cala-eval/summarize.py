#!/usr/bin/env python
"""Paired comparison of two `run_arms.py` result trees (PLAN sections 3.3, 3.4).

    python tools/cala-eval/summarize.py --base <runs>/base --new <runs>/new \
        --primary P8 [--arms static,motion] [--claim-arms motion] > results/<date>-<task>.md

For every arm and metric: per-seed paired differences `d_s = new_s - base_s`,
`mean(d) +- t(S-1, .975) * sd(d) / sqrt(S)`, and the sign count. An effect is
claimed only when the CI excludes 0 for the one pre-declared `--primary` metric
on the `--claim-arms` (default: all arms listed). Pooling over arms is shown but
never used for the claim. Standard library only.
"""

from __future__ import annotations

import argparse
import csv
import math
import statistics
import sys
from pathlib import Path

CHECKPOINT_STEP = 300
AUC_FROM = 1200
SLOPE_N = 5
CHURN_WINDOW_FRAMES = 4 * 60 * 20  # last four minutes at 20 fps

# t quantiles, two-sided 95 %, df = 1..30.
T975 = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
]  # fmt: skip

METRICS = [
    "P2", "R2", "P8", "R8", "P8x", "AUC_P", "AUC_R", "slope_P", "cells",
    "fp_noise", "fp_adjacent", "fp_partial", "fp_dup", "fp_nondet", "fp_edge10",
    "r_fp", "r_tr", "adds_pm", "deletes_pm", "readds_pm",
]  # fmt: skip
PRECISION_LIKE = {"P2", "P8", "P8x", "AUC_P"}


def t_crit(df: int) -> float:
    return T975[df - 1] if 1 <= df <= 30 else 1.96


def read_tsv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def num(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return math.nan


def median(v: list[float]) -> float:
    v = [x for x in v if math.isfinite(x)]
    return statistics.median(v) if v else math.nan


def lstsq_slope(xs: list[float], ys: list[float]) -> float:
    if len(xs) < 2:
        return math.nan
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else math.nan


def run_metrics(run: Path) -> dict[str, float]:
    """All per-run metrics of one `qc_eval sim` output directory."""
    out = {m: math.nan for m in METRICS}
    cps = []  # (frame, P, R, true_r) at GT checkpoints
    for r in read_tsv(run / "global.tsv"):
        p = num(r.get("gt_precision"))
        if math.isfinite(p):
            cps.append((num(r["frames"]), p, num(r["gt_recall"]), num(r.get("gt_median_true_r"))))
    if not cps:
        return out
    cps.sort()
    cell_rows = read_tsv(run / "cells.tsv")
    # `global.tsv` counts frames after the slow loop's start (50); `cells.tsv`,
    # `adds.tsv` and `removals.tsv` use recording frames. Align on the last
    # checkpoint (both files have one at the end of the recording).
    last_rec = max((num(r["frame"]) for r in cell_rows), default=cps[-1][0] + 50)
    shift = last_rec - cps[-1][0]
    cps = [(f + shift, p, r, t) for f, p, r, t in cps]
    final = cps[-1][0]

    def at(frame: float):
        c = [x for x in cps if x[0] <= frame]
        return c[-1] if c else None

    for tag, frame in (("2", 2400), ("8", 9600)):
        c = at(frame)
        if c is not None and c[0] >= frame - CHECKPOINT_STEP:
            out["P" + tag], out["R" + tag] = c[1], c[2]
    auc = [c for c in cps if c[0] >= AUC_FROM and c[0] % CHECKPOINT_STEP == 0]
    if auc:
        out["AUC_P"] = sum(c[1] for c in auc) / len(auc)
        out["AUC_R"] = sum(c[2] for c in auc) / len(auc)
    last = cps[-SLOPE_N:]
    if len(last) == SLOPE_N:
        out["slope_P"] = lstsq_slope([c[0] / 1000 for c in last], [c[1] for c in last])
    out["r_tr"] = cps[-1][3]

    rows = [r for r in cell_rows if num(r["frame"]) == final]
    out["cells"] = float(len(rows))
    if rows and "fp_class" in rows[0]:
        cls = [r["fp_class"] for r in rows]
        for key, name in (
            ("fp_noise", "noise"), ("fp_adjacent", "adjacent"), ("fp_partial", "partial"),
            ("fp_dup", "dup"), ("fp_nondet", "nondetectable"),
        ):  # fmt: skip
            out[key] = float(cls.count(name))
        out["fp_edge10"] = float(
            sum(1 for r in rows if r["fp_class"] != "tp" and num(r["edge_px"]) <= 10)
        )
        n_det_fp = len(rows) - cls.count("nondetectable")
        out["P8x"] = cls.count("tp") / n_det_fp if n_det_fp else math.nan
        out["r_fp"] = median([num(r["fp_r"]) for r in rows if r["fp_class"] == "tp"])

    t_lo = final - CHURN_WINDOW_FRAMES
    minutes = CHURN_WINDOW_FRAMES / 20 / 60
    adds = [r for r in read_tsv(run / "adds.tsv") if num(r["recording_frame"]) > t_lo]
    rem = [r for r in read_tsv(run / "removals.tsv") if num(r["recording_frame"]) > t_lo]
    out["adds_pm"] = len(adds) / minutes
    out["readds_pm"] = sum(1 for r in adds if r["class"] == "readd") / minutes
    out["deletes_pm"] = sum(1 for r in rem if r["kind"] == "delete") / minutes
    return out


def seed_of(name: str) -> int | None:
    return int(name.rsplit("_s", 1)[1]) if "_s" in name and name.rsplit("_s", 1)[1].isdigit() else None


def collect(tree: Path, arms: list[str] | None) -> dict[str, dict[int, dict[str, float]]]:
    res: dict[str, dict[int, dict[str, float]]] = {}
    for d in sorted(p for p in tree.iterdir() if p.is_dir()):
        arm, seed = d.name.rsplit("_s", 1)[0], seed_of(d.name)
        if seed is None or (arms and arm not in arms) or not (d / "global.tsv").exists():
            continue
        res.setdefault(arm, {})[seed] = run_metrics(d)
    return res


def paired(base: list[float], new: list[float]) -> dict:
    """Paired statistics of per-seed values (same seed order)."""
    d = [n - b for b, n in zip(base, new) if math.isfinite(b) and math.isfinite(n)]
    n = len(d)
    if n == 0:
        return {"n": 0, "mean": math.nan, "half": math.nan, "pos": 0, "neg": 0, "zero": 0}
    mean = sum(d) / n
    half = t_crit(n - 1) * statistics.stdev(d) / math.sqrt(n) if n > 1 else math.nan
    return {
        "n": n, "mean": mean, "half": half,
        "pos": sum(1 for x in d if x > 0), "neg": sum(1 for x in d if x < 0),
        "zero": sum(1 for x in d if x == 0),
    }  # fmt: skip


def excludes_zero(st: dict) -> bool:
    return st["n"] > 1 and math.isfinite(st["half"]) and abs(st["mean"]) > st["half"]


def fmt(x: float, nd: int = 3) -> str:
    return "nan" if not math.isfinite(x) else f"{x:.{nd}f}"


def report(base, new, arms, primary, claim_arms) -> str:
    lines = [
        f"Primary metric (pre-declared): **{primary}**; claim arms: {', '.join(claim_arms)}.",
        "Cells: mean over seeds base -> new; d = paired new - base, mean +- 95 % t-CI "
        "(n seeds); signs = seeds with d > 0 / < 0 / = 0. `binSE` is the per-run "
        "binomial SE of a precision, sqrt(P(1-P)/cells), at the base mean.",
        "",
        "| arm | metric | base | new | d (mean +- CI) | n | signs +/-/0 | binSE | claim |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    verdicts = []
    pooled: dict[str, list[float]] = {}
    for arm in arms:
        seeds = sorted(set(base.get(arm, {})) & set(new.get(arm, {})))
        if not seeds:
            lines.append(f"| {arm} | (no paired seeds) | | | | 0 | | | |")
            continue
        for m in METRICS:
            b = [base[arm][s][m] for s in seeds]
            n = [new[arm][s][m] for s in seeds]
            st = paired(b, n)
            if st["n"] == 0:
                continue
            bm = statistics.fmean([x for x in b if math.isfinite(x)])
            nm = statistics.fmean([x for x in n if math.isfinite(x)])
            nd = 4 if m in ("slope_P",) else 3
            if m in ("cells",) or m.startswith("fp_") or m.endswith("_pm"):
                nd = 1
            se = ""
            if m in PRECISION_LIKE:
                cells = statistics.fmean([base[arm][s]["cells"] for s in seeds])
                se = fmt(math.sqrt(max(bm * (1 - bm), 0) / max(cells, 1)), 3)
            claim = ""
            if m == primary and arm in claim_arms:
                ok = excludes_zero(st)
                claim = "EXCLUDES 0" if ok else "covers 0"
                verdicts.append((arm, ok, st))
            name = f"**{m}**" if m == primary else m
            lines.append(
                f"| {arm} | {name} | {fmt(bm, nd)} | {fmt(nm, nd)} | "
                f"{fmt(st['mean'], nd)} +- {fmt(st['half'], nd)} | {st['n']} | "
                f"{st['pos']}/{st['neg']}/{st['zero']} | {se} | {claim} |"
            )
            pooled.setdefault(m, []).extend(d for d in [n_ - b_ for b_, n_ in zip(b, n)] if math.isfinite(d))
    if primary in pooled and len(pooled[primary]) > 1:
        d = pooled[primary]
        half = t_crit(len(d) - 1) * statistics.stdev(d) / math.sqrt(len(d))
        lines += [
            "",
            f"Pooled over arms ({primary}, not used for the claim): "
            f"d = {fmt(statistics.fmean(d), 4)} +- {fmt(half, 4)} (n = {len(d)} arm-seeds).",
        ]
    lines.append("")
    for arm, ok, st in verdicts:
        sign = "up" if st["mean"] > 0 else "down"
        lines.append(
            f"- {arm}: {primary} {sign} by {fmt(abs(st['mean']), 4)} (CI half-width {fmt(st['half'], 4)}): "
            + ("effect claimed." if ok else "no effect claimed (CI covers 0).")
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, type=Path)
    ap.add_argument("--new", required=True, type=Path)
    ap.add_argument("--primary", required=True, choices=METRICS)
    ap.add_argument("--arms", default=None, help="comma list (default: every arm in both trees)")
    ap.add_argument("--claim-arms", default=None, help="arms the claim is made on (default: --arms)")
    a = ap.parse_args()
    arms = a.arms.split(",") if a.arms else None
    base, new = collect(a.base, arms), collect(a.new, arms)
    arm_list = arms or sorted(set(base) & set(new))
    claim = a.claim_arms.split(",") if a.claim_arms else arm_list
    sys.stdout.write(report(base, new, arm_list, a.primary, claim))
    return 0


if __name__ == "__main__":
    sys.exit(main())
