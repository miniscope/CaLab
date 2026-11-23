#!/usr/bin/env python
"""Tables of the settle-during-Discover app measurement (headed Chrome).

    python tools/cala-eval/csettle_app_summary.py <dir> [--recs sa,sb,ws] [--arms off,on]

`<dir>` holds the outputs of `apps/cala/scripts/memory-measure.mjs --single --lookback [--csettle]` with tags
`<rec>-<arm>-<rep>`: `<tag>-probe.json` (exact times, counters at the last frame, settle checkpoints, how far the end
settle moved the library), `<tag>.json` (memory samples), `<tag>-live.json` and `<tag>-final.json` (the library at the
end of Discover's frames and the settled one).

Prints one row per run, then per recording the run-to-run agreement of the libraries: cells of two runs are matched
one-to-one, greedily by the cosine of their footprints (candidates: centroids within 12 px, as `seed_jaccard.py`); a
pair counts at cosine >= 0.7; the agreement is the median cosine of the matched pairs. Needs numpy.
"""

from __future__ import annotations

import argparse
import json
import sys
from itertools import combinations
from pathlib import Path

import numpy as np


def load_lib(path: Path):
    """Per cell: centroid (y, x), {pixel: value}, norm."""
    d = json.loads(path.read_text())
    w = d["width"]
    px = np.asarray(d["pixels"], dtype=np.int64)
    va = np.asarray(d["values"], dtype=np.float64)
    st = d["starts"]
    out = []
    for s in range(len(d["ids"])):
        idx, a = px[st[s] : st[s + 1]], va[st[s] : st[s + 1]]
        tot = a.sum() or 1.0
        out.append(
            (
                float(((idx // w) * a).sum() / tot),
                float(((idx % w) * a).sum() / tot),
                dict(zip(idx.tolist(), a.tolist())),
                float(np.sqrt((a * a).sum()) or 1.0),
            )
        )
    return out


def agreement(a, b, radius=12.0, min_cos=0.7):
    """(matched pairs, median cosine of them, cells in a, cells in b)."""
    if not a or not b:
        return 0, float("nan"), len(a), len(b)
    cb = np.array([[p[0], p[1]] for p in b])
    cand = []
    for i, (cy, cx, fa, na) in enumerate(a):
        d = np.hypot(cb[:, 0] - cy, cb[:, 1] - cx)
        for j in np.nonzero(d <= radius)[0]:
            fb, nb = b[j][2], b[j][3]
            dot = sum(v * fb[k] for k, v in fa.items() if k in fb)
            cand.append((dot / (na * nb), i, int(j)))
    cand.sort(reverse=True)
    ua, ub, cos = set(), set(), []
    for c, i, j in cand:
        if c < min_cos:
            break
        if i in ua or j in ub:
            continue
        ua.add(i)
        ub.add(j)
        cos.append(c)
    return len(cos), float(np.median(cos)) if cos else float("nan"), len(a), len(b)


def run_row(d: Path, tag: str) -> dict | None:
    pf = d / f"{tag}-probe.json"
    if not pf.exists():
        return None
    j = json.loads(pf.read_text())
    p, ch = j["probe"], j["endSettleChange"]
    samples = json.loads((d / f"{tag}.json").read_text()) if (d / f"{tag}.json").exists() else []
    peak = max((max(s.get("rendererRss", 0), s.get("rendererFoot", 0)) for s in samples), default=float("nan"))
    gpu = max((s.get("gpuFoot", 0) for s in samples), default=float("nan"))
    at = p["atFramesDone"] or {}
    lb = at.get("lb") or {}
    cs = lb.get("csettle")
    disc = (p["framesDone"] - p["t0"]) / 1000
    settle = (p["final"] - p["framesDone"]) / 1000 if p["final"] else float("nan")
    final_cells = ch["cellsAfter"] if ch else float("nan")
    return {
        "tag": tag,
        "frames": p["frames"],
        "discover_s": disc,
        "fps": p["frames"] / disc,
        "settle_s": settle,
        "total_s": disc + settle,
        "cells_live": at.get("cells"),
        "cells": final_cells,
        "peak_gb": peak / 1024,
        "gpu_gb": gpu / 1024,
        "max_gap_ms": p["maxGapMs"],
        "gaps250": p["gaps250"],
        "fwd": at.get("fwd", 0),
        "drop": at.get("drop", 0),
        "need_req": lb.get("requested", 0),
        "need_fit": lb.get("pushed", 0),
        "in_need": lb.get("inNeed", 0),
        "cs": cs,
        "jobs": (at.get("slow") or {}).get("jobs", 0),
        "refines": (at.get("slow") or {}).get("refines", 0),
        "ch": ch,
        "checkpoints": p["checkpoints"],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path)
    ap.add_argument("--recs", default="ws,sa,sb")
    ap.add_argument("--arms", default="off,on")
    args = ap.parse_args(argv)
    d = args.dir
    recs, arms = args.recs.split(","), args.arms.split(",")
    rows: dict[tuple[str, str], list[dict]] = {}
    for rec in recs:
        for arm in arms:
            for f in sorted(d.glob(f"{rec}-{arm}-*-probe.json")):
                r = run_row(d, f.name[: -len("-probe.json")])
                if r:
                    rows.setdefault((rec, arm), []).append(r)

    print("## Runs\n")
    print(
        "| run | frames | Discover s (fps) | end settle s | total s | cells at last frame / final | peak tab GB | GPU GB "
        "| dropped for the slow loop | longest stretch without a new frame, ms (over 250 ms) | visit jobs / refines in Discover |"
    )
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for (rec, arm), rs in rows.items():
        for r in rs:
            tot = r["fwd"] + r["drop"]
            print(
                f"| {r['tag']} | {r['frames']} | {r['discover_s']:.1f} ({r['fps']:.0f}) | {r['settle_s']:.1f} | {r['total_s']:.1f} "
                f"| {r['cells_live']} / {r['cells']} | {r['peak_gb']:.2f} | {r['gpu_gb']:.2f} "
                f"| {r['drop']} of {tot} ({100 * r['drop'] / max(1, tot):.1f} %) | {r['max_gap_ms']:.0f} ({r['gaps250']}) "
                f"| {r['jobs']} / {r['refines']} |"
            )

    print("\n## Look-back worker during Discover\n")
    print(
        "| run | need-driven frames asked (fitted) | cells still in need | settle frames re-read: fitted + held out + dropped "
        "| per live frame | answers | slow worker ms per answer (longest block) |"
    )
    print("|---|---|---|---|---|---|---|")
    for (rec, arm), rs in rows.items():
        for r in rs:
            cs = r["cs"]
            if cs:
                n = cs["fit"] + cs["heldOut"] + cs["dropped"]
                c = (
                    f"{n} = {cs['fit']} + {cs['heldOut']} + {cs['dropped']} | {n / max(1, cs['live']):.2f} | {cs['answers']} "
                    f"| {cs['answerMs'] / max(1, cs['answers']):.1f} ({cs['maxBlockMs']:.0f}) |"
                )
            else:
                c = "- | - | - | - |"
            print(f"| {r['tag']} | {r['need_req']} ({r['need_fit']}) | {r['in_need']} | {c}")

    print("\n## What the end settle still moves\n")
    print(
        "| run | cells compared | moved more than 1x their noise | more than 2x | median change | median change / noise "
        "| cells still moving at the checkpoints (frames fed: moving) |"
    )
    print("|---|---|---|---|---|---|---|")
    for (rec, arm), rs in rows.items():
        for r in rs:
            ch = r["ch"]
            cps = " ".join(f"{c['fed']}:{c['above']}" for c in r["checkpoints"])
            if ch and ch["cells"]:
                print(
                    f"| {r['tag']} | {ch['cells']} | {100 * ch['above1'] / ch['cells']:.0f} % | {100 * ch['aboveK'] / ch['cells']:.0f} % "
                    f"| {100 * ch['medianChange']:.1f} % | {ch['medianRatio']:.2f} | {cps} |"
                )

    print("\n## Run-to-run agreement of the libraries (median cosine of matched footprints; matched pairs)\n")
    print("| recording | pair | at the last frame of Discover | after the end settle |")
    print("|---|---|---|---|")
    for rec in recs:
        tags = {arm: [r["tag"] for r in rows.get((rec, arm), [])] for arm in arms}
        libs: dict[tuple[str, str], list] = {}

        def lib(tag: str, kind: str):
            if (tag, kind) not in libs:
                f = d / f"{tag}-{kind}.json"
                libs[(tag, kind)] = load_lib(f) if f.exists() else []
            return libs[(tag, kind)]

        pairs = []
        for arm in arms:
            pairs += [(a, b) for a, b in combinations(tags[arm], 2)]
        for a_arm, b_arm in combinations(arms, 2):
            pairs += [(a, b) for a in tags[a_arm] for b in tags[b_arm]]
        for a, b in pairs:
            cells = []
            for kind in ("live", "final"):
                m, med, na, nb = agreement(lib(a, kind), lib(b, kind))
                cells.append(f"{med:.4f} ({m} of {na} / {nb})")
            print(f"| {rec} | {a} vs {b} | {cells[0]} | {cells[1]} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
