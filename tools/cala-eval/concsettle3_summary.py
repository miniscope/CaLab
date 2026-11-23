#!/usr/bin/env python
"""Phase B of the concurrent-settle study, round 3: arms against round 2's baseline on lines F1-F4.

    python tools/cala-eval/concsettle3_summary.py --r2 ROOT2/real --r3 ROOT3/real [--md OUT.md]

Per recording and arm: visit jobs in the stream and cells at the end of the stream against `V30` of the same seed,
dropped frames, re-read frames per live frame, the longest wait of a batch, and the share of the gap closed (live
seed-to-seed footprint r, `lookback_settled.agreement`, against round 2's `V30` live and settled values).
"""

from __future__ import annotations

import argparse
import gc
import itertools
import re
import sys
from pathlib import Path

import numpy as np
from scipy import stats

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_metrics as DM  # noqa: E402
import lookback_settled as LS  # noqa: E402

RECS = {"ws": [1, 2, 3], "10_43_21": [1, 2], "14_57_02": [1, 2]}


def run_line(d: Path):
    t = (d / "timed.txt").read_text()
    log = Path(str(d) + ".log").read_text()
    m = re.search(r"visits (\d+) \((\d+) jobs\)", t)
    sj = re.search(r"(\d+) settle jobs", t)
    jobs = int(m.group(2)) - (int(sj.group(1)) if sj else 0)
    cells = int(re.search(r"pass 1 done: (\d+) cells", log).group(1))
    per = re.search(r"\(([\d.]+) per forwarded frame", t)
    wait = re.search(r"longest batch wait ([\d.]+) ms", t)
    return {
        "jobs": jobs,
        "cells": cells,
        "dropped": int(re.search(r"dropped (\d+)", t).group(1)),
        "reread": float(per.group(1)) if per else 0.0,
        "wait": float(wait.group(1)) if wait else float("nan"),
        "busy": int(re.search(r"visit workers busy (\d+)%", t).group(1)),
    }


def lib(d: Path, tag: str):
    h, w, _ids, cells, _ = DM.read_library(LS.lib_path(d, tag))
    return LS.to_csr(cells, h * w)


def pair_r(dirs, tag):
    """Mean seed-to-seed median r over the seed pairs, and the per-pair values."""
    out = []
    for a, b in itertools.combinations(dirs, 2):
        A, B = lib(a, tag), lib(b, tag)
        out.append(LS.agreement(A, B)[3])
        del A, B
        gc.collect()
    return float(np.mean(out)), out


def ci(v):
    v = np.asarray(v, float)
    if len(v) < 3:
        return ""
    h = stats.t.ppf(0.975, len(v) - 1) * v.std(ddof=1) / np.sqrt(len(v))
    return f" [{v.mean() - h:+.1f}, {v.mean() + h:+.1f}]"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--r2", type=Path, required=True)
    ap.add_argument("--r3", type=Path, required=True)
    ap.add_argument("--arms", default="CS2F,CS2F-Y1,CS2F-free,V30-W3")
    ap.add_argument("--md", type=Path)
    a = ap.parse_args(argv)

    def find(rec, arm, s):
        for root in (a.r3, a.r2):
            d = root / f"{rec}_{arm}_s{s}"
            if Path(str(d) + ".done").exists() and (d / "timed.txt").exists():
                return d
        return None

    L = ["| recording | arm (seeds) | visit jobs in the stream, against `V30` same seed | cells at the end of the stream, against `V30` | dropped frames | re-read frames per live frame | longest wait of a batch | visit workers busy | live seed-to-seed r (pairs) | share of the gap |",
         "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]  # fmt: skip
    pooled = {}
    for rec, seeds in RECS.items():
        base = {s: run_line(a.r2 / f"{rec}_V30_s{s}") for s in seeds}
        bdirs = [a.r2 / f"{rec}_V30_s{s}" for s in seeds]
        live, lp = pair_r(bdirs, "settle0")
        settled, _ = pair_r(bdirs, "final")
        L.append(f"| {rec} | `V30` ({len(seeds)}) | {' / '.join(str(base[s]['jobs']) for s in seeds)} | {' / '.join(str(base[s]['cells']) for s in seeds)} | {sum(base[s]['dropped'] for s in seeds)} | 0 | {max(base[s]['wait'] for s in seeds):.1f} ms | {np.mean([base[s]['busy'] for s in seeds]):.0f} % | {live:.4f} ({' / '.join(f'{x:.4f}' for x in lp)}); settled {settled:.4f} | 0 |")  # fmt: skip
        for arm in a.arms.split(","):
            dirs = {s: find(rec, arm, s) for s in seeds}
            have = [s for s in seeds if dirs[s] is not None]
            if not have:
                continue
            r = {s: run_line(dirs[s]) for s in have}
            dj = [100 * (r[s]["jobs"] / base[s]["jobs"] - 1) for s in have]
            dc = [100 * (r[s]["cells"] / base[s]["cells"] - 1) for s in have]
            pooled.setdefault(arm, {"dj": [], "dc": []})
            pooled[arm]["dj"] += dj
            pooled[arm]["dc"] += dc
            if len(have) >= 2:
                al, alp = pair_r([dirs[s] for s in have], "settle0")
                share = f"{100 * (al - live) / (settled - live):.0f} %"
                ltxt = f"{al:.4f} ({' / '.join(f'{x:.4f}' for x in alp)})"
            else:
                share, ltxt = "n/a (one seed)", "n/a"
            L.append(f"| | `{arm}` ({len(have)}) | {np.mean(dj):+.1f} % ({' / '.join(f'{x:+.1f}' for x in dj)}) | {np.mean(dc):+.1f} % ({' / '.join(str(r[s]['cells']) for s in have)}) | {sum(r[s]['dropped'] for s in have)} | {np.mean([r[s]['reread'] for s in have]):.2f} | {max(r[s]['wait'] for s in have):.1f} ms | {np.mean([r[s]['busy'] for s in have]):.0f} % | {ltxt} | {share} |")  # fmt: skip
    L += ["", "Paired with `V30` of the same seed, over every recording-seed the arm has (mean [95 % CI], paired t):", ""]
    for arm, p in pooled.items():
        L.append(f"- `{arm}` (n = {len(p['dj'])}): visit jobs {np.mean(p['dj']):+.1f} %{ci(p['dj'])}; cells {np.mean(p['dc']):+.1f} %{ci(p['dc'])}")
    md = "\n".join(L)
    print(md)
    if a.md:
        a.md.write_text(md + "\n")


if __name__ == "__main__":
    main()
