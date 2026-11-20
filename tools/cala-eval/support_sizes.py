#!/usr/bin/env python
"""Footprint support sizes per pass of `qc_eval --passes N` runs (S2.1).

    python tools/cala-eval/support_sizes.py LABEL=RUN_TREE [LABEL=RUN_TREE ...] \
        [--names motion_s5,static_s7,...] [--count pos|disk]

A run tree holds one run directory per recording (`<arm>_s<seed>`), as
`run_arms.py` writes them. Each run's `footprints_pass<k>.bin` (or
`footprints.bin` for a single pass) is read with `seed_jaccard.load`. Per
label and pass the table gives the mean over runs of the median and p99
support, the median over runs of the largest support, the runs with a
footprint above 50 000 px, and the pass-k / pass-1 ratios of the median and
p99 (mean over runs of the per-run ratio). `--count pos` (default) counts the
pixels with a positive value; `--count disk` counts every published pixel of
the support disk (zeros included), the measure of the S2.3 notes. Only the
recordings every label has are used, unless `--names` lists them. Needs
numpy.
"""

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from seed_jaccard import load  # noqa: E402


def passes(run: Path) -> list[Path]:
    ks = sorted(run.glob("footprints_pass*.bin"), key=lambda p: int(p.stem.split("pass")[1]))
    if ks:
        return ks
    one = run / "footprints.bin"
    return [one] if one.exists() else []


def sizes(path: Path, count: str) -> np.ndarray:
    _, _, cells = load(path)
    if count == "disk":
        return np.array([len(c[1]) for c in cells])
    return np.array([int((c[2] > 0).sum()) for c in cells])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("trees", nargs="+")
    ap.add_argument("--names", default="")
    ap.add_argument("--count", choices=["pos", "disk"], default="pos")
    a = ap.parse_args()
    trees = {}
    for t in a.trees:
        lab, _, p = t.partition("=")
        trees[lab] = Path(p)
    if a.names:
        names = a.names.split(",")
    else:
        sets = [{d.name for d in t.iterdir() if d.is_dir() and passes(d)} for t in trees.values()]
        names = sorted(set.intersection(*sets))
    print(f"runs ({len(names)}): {', '.join(names)}; count: {a.count}\n")
    print("| label | pass | median px | p99 px | largest px (median over runs) | runs > 50k px | median / pass 1 | p99 / pass 1 |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for lab, t in trees.items():
        per = {}
        for n in names:
            for k, p in enumerate(passes(t / n), 1):
                per.setdefault(k, {})[n] = sizes(p, a.count)
        for k in sorted(per):
            med = [float(np.median(per[k][n])) for n in per[k]]
            p99 = [float(np.percentile(per[k][n], 99)) for n in per[k]]
            mx = [int(per[k][n].max()) for n in per[k]]
            big = sum(int(m > 50_000) for m in mx)
            rm = [np.median(per[k][n]) / np.median(per[1][n]) for n in per[k] if n in per[1]]
            rp = [np.percentile(per[k][n], 99) / np.percentile(per[1][n], 99) for n in per[k] if n in per[1]]
            print(
                f"| {lab} | {k} | {np.mean(med):.0f} | {np.mean(p99):.0f} | {np.median(mx):.0f} | "
                f"{big}/{len(mx)} | {np.mean(rm):.2f} | {np.mean(rp):.2f} |"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
