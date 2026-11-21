#!/usr/bin/env python
"""The settle's checkpoints: footprint change against split-half noise, and (sims) footprint r with ground truth.

    $MINISIM_PY tools/cala-eval/settle_checks.py RUN_DIR [RUN_DIR ...] [--frames 9600] [--md out.md]

Reads what `qc_eval --settle-frames N [--settle-libs]` writes into each run directory:

- `settle_checks.tsv`: per checkpoint, the change of every footprint since the last checkpoint (relative L2 on
  unit-peak weights, the app's Refine readout) over the cell's split-half noise: median, upper quantiles and the share
  of cells that moved more than 1, 1.5, 2 and 3 times their noise;
- `final_settle{k}.tsv` (with `--settle-libs`; k = 0 is the library the settle started from): on sims, each cell's
  best footprint r with a ground-truth unit; `adds.tsv` gives the birth frame.

Output: one table per run group (the directory's parent name), mean over its runs per checkpoint: the change
summaries, and on sims the median footprint r of matched cells (r >= 0.7), all and born in the second half of the
recording (`--frames`). The stop rule of the settle is a threshold on one of the change columns; this table is what it
was chosen from.
"""

from __future__ import annotations

import argparse
import csv
import statistics
import sys
from collections import defaultdict
from pathlib import Path

COLS = ["ratio_med", "ratio_p90", "share_gt1", "share_gt1p5", "share_gt2", "share_gt3", "rel_l2_med", "noise_med"]


def read_tsv(p: Path):
    with open(p) as f:
        return list(csv.DictReader(f, delimiter="\t"))


def lib_r(run: Path, k: int, frames: int):
    """(median r all, median r born in the second half) of matched cells of checkpoint library k, or None."""
    p = run / f"final_settle{k}.tsv"
    if not p.exists():
        return None
    born = {}
    if (run / "adds.tsv").exists():
        for r in read_tsv(run / "adds.tsv"):
            born[r["id"]] = float(r["recording_frame"])
    allr, late = [], []
    for r in read_tsv(p):
        try:
            v = float(r["best_r"])
        except ValueError:
            continue
        if v != v or v < 0.7:
            continue
        allr.append(v)
        if born.get(r["id"], 0.0) >= 0.5 * frames:
            late.append(v)
    if not allr:
        return None
    return statistics.median(allr), (statistics.median(late) if late else float("nan"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--frames", type=int, default=9600, help="recording length, for the born-late split")
    ap.add_argument("--per-run", action="store_true", help="one table per run instead of per group")
    ap.add_argument("--md", type=Path)
    a = ap.parse_args(argv)
    groups = defaultdict(list)
    for run in a.runs:
        if (run / "settle_checks.tsv").exists():
            groups[f"{run.parent.name}/{run.name}" if a.per_run else run.parent.name].append(run)
    L = []
    for g, runs in groups.items():
        rows = defaultdict(lambda: defaultdict(list))
        for run in runs:
            r0 = lib_r(run, 0, a.frames)
            if r0:
                rows[0]["frames"].append(0.0)
                rows[0]["r_all"].append(r0[0])
                rows[0]["r_late"].append(r0[1])
            for r in read_tsv(run / "settle_checks.tsv"):
                k = int(r["check"])
                rows[k]["frames"].append(float(r["frames"]))
                rows[k]["wall_s"].append(float(r["wall_s"]))
                rows[k]["stop"].append(float(r["stop"]))
                for c in COLS:
                    rows[k][c].append(float(r[c]))
                rr = lib_r(run, k, a.frames)
                if rr:
                    rows[k]["r_all"].append(rr[0])
                    rows[k]["r_late"].append(rr[1])
        L += [f"### {g} ({len(runs)} runs)", "",
              "| check | runs | frames fed | wall s | change / noise median | p90 | share > 1 x | > 1.5 x | > 2 x | > 3 x | change median | noise median | fp r all | fp r born 2nd half | stopped |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]  # fmt: skip

        def m(d, key, fmt):
            v = [x for x in d.get(key, []) if x == x]
            return fmt.format(sum(v) / len(v)) if v else "-"

        for k in sorted(rows):
            d = rows[k]
            L.append(
                f"| {k} | {len(d['frames'])} | {m(d, 'frames', '{:.0f}')} | {m(d, 'wall_s', '{:.0f}')} | {m(d, 'ratio_med', '{:.2f}')} | {m(d, 'ratio_p90', '{:.2f}')} | "
                f"{m(d, 'share_gt1', '{:.3f}')} | {m(d, 'share_gt1p5', '{:.3f}')} | {m(d, 'share_gt2', '{:.3f}')} | {m(d, 'share_gt3', '{:.3f}')} | "
                f"{m(d, 'rel_l2_med', '{:.3f}')} | {m(d, 'noise_med', '{:.3f}')} | {m(d, 'r_all', '{:.4f}')} | {m(d, 'r_late', '{:.4f}')} | {m(d, 'stop', '{:.0%}')} |"
            )
        L.append("")
    md = "\n".join(L)
    if a.md:
        a.md.write_text(md)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
