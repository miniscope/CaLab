#!/usr/bin/env python
"""Per-arm baseline table of one or more `run_arms.py` result trees.

    python tools/cala-eval/baseline_table.py main=<runs>/base [more LABEL=DIR ...] \
        [--arms static,motion,halo,oof]

For every arm and metric: mean, sample sd over seeds (and n) per tree. Used for
the reference numbers that later PRs are compared against (`results/*baseline*`).
Standard library only; reads the runs through `summarize.collect`.
"""

from __future__ import annotations

import argparse
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import summarize as S  # noqa: E402


COUNTS = {"cells", "fp_noise", "fp_adjacent", "fp_partial", "fp_dup", "fp_nondet", "fp_edge10", "adds_pm", "deletes_pm", "readds_pm"}


def cell(vals: list[float], metric: str = "") -> str:
    vals = [v for v in vals if v == v]
    if not vals:
        return "n/a"
    m = statistics.mean(vals)
    sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
    nd = 1 if metric in COUNTS else (4 if metric == "slope_P" else 3)
    return f"{S.fmt(m, nd)} +- {S.fmt(sd, nd)} ({len(vals)})"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trees", nargs="+", help="LABEL=DIR")
    ap.add_argument("--arms", default=None)
    a = ap.parse_args()
    arms = a.arms.split(",") if a.arms else None
    named = []
    for t in a.trees:
        label, d = t.split("=", 1)
        named.append((label, S.collect(Path(d), arms)))
    arm_list = arms or sorted({arm for _, c in named for arm in c})
    print("Cells are mean +- sd over seeds (n seeds).\n")
    print("| arm | metric | " + " | ".join(l for l, _ in named) + " |")
    print("| --- | --- | " + " | ".join("---" for _ in named) + " |")
    for arm in arm_list:
        for m in S.METRICS:
            row = []
            for _, c in named:
                runs = c.get(arm, {})
                row.append(cell([r.get(m, float("nan")) for r in runs.values()], m) if runs else "n/a")
            print(f"| {arm} | {m} | " + " | ".join(row) + " |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
