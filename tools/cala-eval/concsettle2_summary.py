#!/usr/bin/env python
"""Per-recording table of the concurrent-settle study, round 2 (results/2026-11-20-concurrent-settle2.md).

    python tools/cala-eval/concsettle2_summary.py --root $CALA_DATA/runs/concsettle2/real --prefix ws --seeds 1,2,3

Reads what `concsettle2_real.sh report` wrote for the recording (`PREFIX_agreement.md`, `PREFIX_checkpoints.md`) and
each run's log, `csettle.txt` and `settle_checks.tsv`. Per arm (the first, `V30`, is the reference):

* dropped frames per seed, busy shares, achieved re-read frames per forwarded frame, settle jobs;
* cells, ordinary visits and adds (targets R4: within 5 % of the reference);
* seed-to-seed median footprint r of the live library (`settle0`), mean over seed pairs, and the share of the gap to
  the reference's settled library (`final`) it closes (R2);
* the end-settle dose (frames) at which the arm's seed-to-seed r reaches the reference's settled value minus 0.002,
  and the slow-loop work of Discover plus that dose against the reference's Discover plus the full pass (R5);
* median footprint change between checkpoints in the second half of the session (R3).

Prints Markdown, and with `--json` also the numbers (for the pooled paired CI over recordings).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

import numpy as np

ARMS = ["V30", "CS2", "CS2-Q", "CS1", "CS2-Q18"]
KEYS = dict(zip("ABCDE", ARMS))
DOSE = {"settle0": 0, "settle1": 1800, "settle2": 3600, "settle3": 5400, "settle5": 9000, "settle7": 12600, "final": 18000}


def pairs_table(md: Path) -> dict[tuple[str, str, str], list[float]]:
    """(arm, tag, kind) -> median r of each pair; kind: `seed` (two seeds of the arm) or `ref` (against V30 settled)."""
    out: dict[tuple[str, str, str], list[float]] = {}
    for line in md.read_text().splitlines():
        m = re.match(r"\| ([A-E])(\d):(\w+) \| ([A-E])(\d):(\w+) \|.*\| ([0-9.]+) \|\s*$", line)
        if not m:
            continue
        ka, sa, ta, kb, sb, tb, r = m.groups()
        if ka == kb and ta == tb and sa != sb:
            out.setdefault((KEYS[ka], ta, "seed"), []).append(float(r))
        elif sa == sb and ta == "settle0" and tb == "final" and kb == "A":
            out.setdefault((KEYS[ka], "settle0", "ref"), []).append(float(r))
    return out


def movement(md: Path, arms: list[str]) -> dict[str, list[float]]:
    """arm -> median change at each checkpoint (in order), from the checkpoints table."""
    out: dict[str, list[float]] = {a: [] for a in arms}
    head: list[str] = []
    for line in md.read_text().splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if cells and cells[0] == "checkpoint":
            head = cells
        elif len(cells) > 2 and cells[1] == "change med":
            for a in arms:
                if a in head:
                    out[a].append(float(cells[head.index(a)]))
    return out


def run_info(root: Path, prefix: str, arm: str, seed: str) -> dict | None:
    d = root / f"{prefix}_{arm}_s{seed}"
    log = root / f"{prefix}_{arm}_s{seed}.log"
    if not (d / "settle_checks.tsv").exists():
        return None
    text = log.read_text()
    g = lambda pat, cast=float: cast(re.search(pat, text).group(1)) if re.search(pat, text) else float("nan")  # noqa: E731
    cs = (d / "csettle.txt").read_text()
    checks = list(csv.DictReader((d / "settle_checks.tsv").open(), delimiter="\t"))
    total = float(re.search(r"work [0-9.e+-]+ of ([0-9.e+-]+)", cs).group(1))
    settle_work = {int(c["frames"]): float(c["work"]) for c in checks}
    end = max(settle_work.values())
    return {
        "dropped": g(r"dropped (\d+)", int),
        "forwarded": g(r"forwarded (\d+) frames", int),
        "owner": g(r"owner busy (\d+)%"),
        "workers": g(r"visit workers busy (\d+)%"),
        "visits": g(r"; visits (\d+) \("),
        "jobs": g(r"\((\d+) jobs\)"),
        "per_frame": g(r"requests \(([0-9.]+) per forwarded frame"),
        "reread": g(r"jobs: (\d+) frames re-read"),
        "settle_jobs": g(r"(\d+) settle jobs"),
        "lb_busy": g(r"look-back worker busy ([0-9.]+)%"),
        "wait": g(r"longest batch wait ([0-9.]+) ms"),
        "cells": g(r"pass 1 done: (\d+) cells", int),
        "adds": g(r"pass 1 done: \d+ cells, adds (\d+)", int),
        "cs_work": float(re.search(r"work ([0-9.e+-]+) of", cs).group(1)),
        "cs_refines": float(re.search(r"(\d+) refines", cs).group(1)),
        # The end pass's work is in the total; Discover's is the rest.
        "discover_work": total - end,
        "settle_work": settle_work,
        "noise0": float(checks[0]["noise_med"]),
        "noise_end": float(checks[-1]["noise_med"]),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--seeds", required=True)
    ap.add_argument("--json", type=Path)
    a = ap.parse_args(argv)
    seeds = a.seeds.split(",")
    runs = {arm: {s: i for s in seeds if (i := run_info(a.root, a.prefix, arm, s))} for arm in ARMS}
    arms = [arm for arm in ARMS if runs[arm]]
    pt = pairs_table(a.root / f"{a.prefix}_agreement.md")
    mv = movement(a.root / f"{a.prefix}_checkpoints.md", arms)
    ref = runs["V30"]
    mean = lambda v: float(np.mean(v)) if len(v) else float("nan")  # noqa: E731
    live0, settled = mean(pt[("V30", "settle0", "seed")]), mean(pt[("V30", "final", "seed")])
    gap = settled - live0
    ref_work = mean([i["discover_work"] + max(i["settle_work"].values()) for i in ref.values()])
    out = {"recording": a.prefix, "gap": gap, "live": live0, "settled": settled, "arms": {}}
    rows = []
    for arm in arms:
        rs = list(runs[arm].values())
        live = pt.get((arm, "settle0", "seed"), [])
        ladder = {t: mean(pt[(arm, t, "seed")]) for t in DOSE if (arm, t, "seed") in pt}
        dose = next((DOSE[t] for t in DOSE if t in ladder and ladder[t] >= settled - 0.002), None)
        work = (
            mean([i["discover_work"] + (i["settle_work"].get(dose, 0.0) if dose else 0.0) for i in rs])
            if dose is not None
            else float("nan")
        )
        half = mv[arm][-4:]
        o = {
            "dropped": [i["dropped"] for i in rs],
            "live_pairs": live,
            "share": (mean(live) - live0) / gap if live else float("nan"),
            "ladder": ladder,
            "dose": dose,
            "work_ratio": work / ref_work,
            "discover_work_ratio": mean([i["discover_work"] for i in rs]) / mean([i["discover_work"] for i in ref.values()]),
            "move_half2": mean(half),
            "move": mv[arm],
            "visits": mean([i["visits"] for i in rs]),
            "adds": mean([i["adds"] for i in rs]),
            "cells": [i["cells"] for i in rs],
            "vs_ref_settled": mean(pt.get((arm, "settle0", "ref"), [])),
            "noise0": mean([i["noise0"] for i in rs]),
        }
        out["arms"][arm] = o
        v0, a0 = mean([i["visits"] for i in ref.values()]), mean([i["adds"] for i in ref.values()])
        rows.append(
            f"| `{arm}` ({len(rs)}) | {' / '.join(str(i['dropped']) for i in rs)} | {mean([i['owner'] for i in rs]):.0f} % / "
            f"{mean([i['workers'] for i in rs]):.0f} % / {mean([i['lb_busy'] for i in rs]):.0f} % | {max(i['wait'] for i in rs):.1f} | "
            f"{mean([i['per_frame'] for i in rs]):.2f}; {mean([i['settle_jobs'] for i in rs]):.0f}; {mean([i['cs_refines'] for i in rs]):.0f} | "
            f"{' / '.join(str(i['cells']) for i in rs)} | {o['visits']:.0f} ({100 * (o['visits'] / v0 - 1):+.1f} %); "
            f"{o['adds']:.0f} ({100 * (o['adds'] / a0 - 1):+.1f} %) | {' / '.join(f'{r:.4f}' for r in live)} | "
            f"{100 * o['share']:.0f} % | {o['vs_ref_settled']:.4f} | "
            f"{' / '.join(f'{ladder[t]:.4f}' for t in ('settle1', 'settle3', 'settle5', 'final') if t in ladder)} | "
            f"{'not reached' if dose is None else dose} | {o['discover_work_ratio']:.2f} x; {o['work_ratio']:.2f} x | "
            f"{100 * o['move_half2']:.1f} % ({' / '.join(f'{100 * m:.0f}' for m in half)}) | {100 * o['noise0']:.1f} % |"
        )
    print(f"`{a.prefix}`: seed-to-seed r, `V30` live {live0:.4f}, settled {settled:.4f}, gap {gap:+.4f}\n")
    print(
        "| arm (runs) | dropped frames per seed | busy: slow worker / visit workers / look-back worker | longest batch wait, ms | "
        "re-read frames per live frame; settle jobs; their refinements | cells per seed | ordinary visits; adds (against `V30`) | "
        "seed-to-seed r, live, per pair | share of gap | live against `V30` settled (same seed) | "
        "seed-to-seed r after 1800 / 5400 / 9000 / 18000 end-settle frames | end dose to reach settled - 0.002 | "
        "work: Discover; Discover + that dose (against `V30` + full pass) | footprint change per 2250 frames, second half (4 checkpoints) | "
        "split-half noise, live |"
    )
    print("|" + " --- |" * 15)
    print("\n".join(rows))
    if a.json:
        a.json.write_text(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
