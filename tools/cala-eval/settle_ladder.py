#!/usr/bin/env python
"""Several arms of a demix-suite run tree against one reference, as one compact table (the look-back settle study).

    $MINISIM_PY tools/cala-eval/settle_ladder.py --root $CALA_DATA/demix-suite/lbsettle-q --ref COMBO+R \
        --arms COMBO,COMBO-SA9600,ST-stats,ST-frozen,ST-full-due,ST-full [--steps] [--md out.md]

Per arm: the suite's metrics that the settle targets name (footprint r by group, bites, headline, matched / false
cells), as `value (diff to the reference [95 % CI])` with the suite's statistics (`demix_report.compare`: bootstrap
over pairs for pair metrics, paired t over sims for run metrics), on the sims both arms have. With `--steps` a second
table gives each arm against the arm before it in `--arms` (the ladder's rungs). A third table gives what each
settle tail did, read from `stdout.log` (the `settle:` line) and `settle_checks.tsv`: frames fed, wall, visits,
accepted refinements, publishes and work units, mean per sim.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_report as DR  # noqa: E402

# (short label, the suite's metric name, digits)
ROWS = [
    ("fp r all", "Footprint r with GT, median, all matched cells", 4),
    ("fp r isolated", "Footprint r with GT, median, isolated (no GT unit within 1.5 D)", 4),
    ("fp r close-pair", "Footprint r with GT, median, close-pair (GT unit within 1.0 D)", 4),
    ("fp r born 2nd half", "Footprint r with GT, median, born in the second half", 4),
    ("fp r born last 20 %", "Footprint r with GT, median, born in the last 20%", 4),
    ("share r < 0.9", "Footprint r with GT < 0.9, share, all matched cells", 3),
    ("headline", "HEADLINE", 3),
    ("bite share 0.75-1 D", "Bite share ratio < 0.5, 0.75-1.0 D", 3),
    ("bite share later-born 0.5-0.75 D", "Bite share ratio < 0.5, later-born cell, 0.5-0.75 D", 3),
]
RUN_ROWS = [("matched", ("matched",), 1), ("false", ("false", "unmatched", "false cells"), 1)]

SETTLE_RE = re.compile(
    r"settle: (\d+) frames in ([\d.]+) s \((\d+) frames/s\), (\d+) visits, (\d+) refines, (\d+) publishes, work ([\d.e+]+)(.*)"
)


def pick(rows, name):
    for r in rows:
        if r["name"] == name or (name == "HEADLINE" and name in r["name"]):
            return r
    return None


def pick_run(rows, keys):
    for r in rows:
        if r["group"] == "run" and any(k in r["name"].lower() for k in keys):
            return r
    return None


def cell(r, digits):
    if r is None:
        return "n/a"
    f = f"{{:.{digits}f}}"
    flag = {"**better**": " B", "**worse**": " W"}.get(r["flag"], "")
    return f"{f.format(r['new'])} ({r['diff']:+.{digits}f} [{f.format(r['lo'])}, {f.format(r['hi'])}]{flag})"


def table(root: Path, pairs):
    """pairs: [(label, base arm, new arm)] -> markdown rows."""
    head = "| arm | sims | " + " | ".join(lab for lab, _, _ in ROWS) + " | " + " | ".join(lab for lab, _, _ in RUN_ROWS) + " |"
    L = [head, "|" + " --- |" * (2 + len(ROWS) + len(RUN_ROWS))]
    cache = {}

    def arm(a):
        if a not in cache:
            cache[a] = DR.load_arm(root / a)
        return cache[a]

    for label, base, new in pairs:
        if not (root / new).is_dir() or not (root / base).is_dir():
            continue
        names, rows = DR.compare(arm(base), arm(new))
        if not names:
            continue
        cells = [cell(pick(rows, name), d) for _, name, d in ROWS]
        cells += [cell(pick_run(rows, keys), d) for _, keys, d in RUN_ROWS]
        L.append(f"| {label} | {len(names)} | " + " | ".join(cells) + " |")
    return L


def tails(root: Path, arms):
    L = ["| arm | sims | frames fed | wall s | frames/s | visits | visits / frame | refinements | publishes | work / frame (M) | stop |",
         "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]  # fmt: skip
    for a in arms:
        S = []
        for run in sorted((root / a).glob("*/stdout.log")):
            m = None
            for line in run.read_text(errors="replace").splitlines():
                m = SETTLE_RE.match(line) or m
            if m:
                S.append([float(m.group(i)) for i in range(1, 8)] + [1.0 if "rule" in m.group(8) else 0.0])
        if not S:
            continue
        n = len(S)
        mean = [sum(s[i] for s in S) / n for i in range(8)]
        L.append(
            f"| {a} | {n} | {mean[0]:.0f} | {mean[1]:.0f} | {mean[0] / mean[1]:.0f} | {mean[3]:.0f} | {mean[3] / mean[0]:.2f} | "
            f"{mean[4]:.0f} | {mean[5]:.0f} | {mean[6] / mean[0] / 1e6:.1f} | {'rule' if mean[7] == 1 else 'cap' if mean[7] == 0 else f'rule {mean[7]:.0%}'} |"
        )
    return L


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--arms", required=True, help="comma list, in ladder order")
    ap.add_argument("--steps", action="store_true", help="also each arm against the one before it")
    ap.add_argument("--md", type=Path)
    a = ap.parse_args(argv)
    arms = a.arms.split(",")
    L = [f"### Arms against `{a.ref}` (value (diff [95 % CI]); B / W = the suite's better / worse flag)", ""]
    L += table(a.root, [(x, a.ref, x) for x in arms])
    if a.steps:
        L += ["", "### Each arm against the one before it", ""]
        L += table(a.root, [(f"{p} -> {x}", p, x) for p, x in zip(arms, arms[1:])])
    L += ["", "### What the tails did (mean per sim)", ""] + tails(a.root, arms)
    md = "\n".join(L) + "\n"
    if a.md:
        a.md.write_text(md)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
