#!/usr/bin/env python
"""Final-settle readers (PR "Final settle reads frames ahead"): main against the branch, per run.

    python tools/cala-eval/settle_readers_summary.py <dir> --oracle <oracle.bin> TAG [TAG ...]

`<dir>` holds `apps/cala/scripts/memory-measure.mjs --lookback --headed` outputs: `<tag>.log` (the PROBE lines:
settle time, counters at the last frame and at the final library, end-settle change) and `<tag>-final.json` (the
settled library). Tags are grouped by their prefix before the last `-` (`main-1`, `main-2` -> `main`).

Per run: Final settle seconds and frames/s, visits and refines over the settle (the rise of the slow loop's `jobs` and
`refines` counters from the last frame to the final library, the last round included), the share of cells moving at
the last checkpoint, the end-settle change (median over cells, in noise units), and a ground-truth score: the final
footprints matched one-to-one to the sim's oracle units (greedy by footprint cosine, centroids within 12 px, a match
at cosine >= 0.7, `csettle_app_summary`'s rule), recall over the oracle's detectable units, cells unmatched, and the
median cosine of the matched pairs. Then per group the median and range. Needs numpy.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from csettle_app_summary import load_lib  # noqa: E402
from demix_metrics import read_oracle  # noqa: E402

RADIUS, MIN_COS = 12.0, 0.7


def oracle_units(path: Path):
    h, w, units, _c = read_oracle(path)
    out = []
    for u in units:
        y0, x0, v = u["full"]
        ys, xs = np.nonzero(v > 0)
        vals = v[ys, xs].astype(np.float64)
        idx = (ys + y0) * w + (xs + x0)
        tot = vals.sum() or 1.0
        out.append(
            (
                float(((ys + y0) * vals).sum() / tot),
                float(((xs + x0) * vals).sum() / tot),
                dict(zip(idx.tolist(), vals.tolist())),
                float(np.sqrt((vals * vals).sum()) or 1.0),
                u["det"],
            )
        )
    return out


def cosine(a, b) -> float:
    small, big = (a, b) if len(a[2]) < len(b[2]) else (b, a)
    dot = sum(v * big[2].get(k, 0.0) for k, v in small[2].items())
    return dot / (a[3] * b[3])


def gt_score(cells, gt):
    pairs = []
    for i, c in enumerate(cells):
        for j, g in enumerate(gt):
            if (c[0] - g[0]) ** 2 + (c[1] - g[1]) ** 2 <= RADIUS * RADIUS:
                cs = cosine(c, g)
                if cs >= MIN_COS:
                    pairs.append((cs, i, j))
    pairs.sort(reverse=True)
    ui, uj, got = set(), set(), []
    for cs, i, j in pairs:
        if i in ui or j in uj:
            continue
        ui.add(i)
        uj.add(j)
        got.append((cs, j))
    det = [j for j, g in enumerate(gt) if g[4]]
    hit = sum(1 for _, j in got if gt[j][4])
    return {
        "recall": hit / max(1, len(det)),
        "unmatched": len(cells) - len(ui),
        "cos": float(np.median([cs for cs, _ in got])) if got else float("nan"),
    }


def probe(log: str, name: str):
    m = re.search(rf"PROBE {name} (.*)", log)
    return json.loads(m.group(1)) if m else None


def run_row(d: Path, tag: str, gt) -> dict | None:
    log_p = d / f"{tag}.log"
    if not log_p.exists():
        return None
    log = log_p.read_text()
    m = re.search(r"end settle ([\d.]+)s", log)
    at = probe(log, "at-frames-done")
    work = probe(log, "settle-work")
    ch = probe(log, "end-settle-change")
    if not m or not at or not work:
        return None
    lb = re.findall(r'"settle":\{"fed":(\d+),"total":\d+,"recording":\d+,"moving":(null|\{[^}]*\})', log)
    fed, moving = (int(lb[-1][0]), json.loads(lb[-1][1])) if lb else (0, None)
    row = {
        "tag": tag,
        "settle_s": float(m.group(1)),
        "fed": fed,
        "cells": at["cells"],
        "visits": work["slow"]["jobs"] - at["slow"]["jobs"],
        "refines": work["slow"]["refines"] - at["slow"]["refines"],
        "moving": moving["above"] / moving["cells"] if moving and moving["cells"] else float("nan"),
        "change": ch.get("medianChange", float("nan")) if isinstance(ch, dict) else float("nan"),
        "reader_frames": work["end"].get("readerFrames", 0),
    }
    row["fps"] = fed / row["settle_s"] if row["settle_s"] > 0 else float("nan")
    fin = d / f"{tag}-final.json"
    if gt is not None and fin.exists():
        cells = load_lib(fin)
        row["final_cells"] = len(cells)
        row.update(gt_score(cells, gt))
    return row


COLS = [
    ("settle_s", "{:.1f}"),
    ("fps", "{:.0f}"),
    ("visits", "{:d}"),
    ("refines", "{:d}"),
    ("moving", "{:.3f}"),
    ("change", "{:.2f}"),
    ("final_cells", "{:d}"),
    ("recall", "{:.3f}"),
    ("unmatched", "{:d}"),
    ("cos", "{:.3f}"),
    ("reader_frames", "{:d}"),
]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path)
    ap.add_argument("tags", nargs="+")
    ap.add_argument("--oracle", type=Path)
    a = ap.parse_args(argv)
    gt = oracle_units(a.oracle) if a.oracle else None
    rows = [r for t in a.tags if (r := run_row(a.dir, t, gt))]
    print("| run | " + " | ".join(c for c, _ in COLS) + " |")
    print("|---" * (len(COLS) + 1) + "|")
    for r in rows:
        print(f"| {r['tag']} | " + " | ".join(f.format(r[c]) if c in r else "-" for c, f in COLS) + " |")
    groups: dict[str, list[dict]] = {}
    for r in rows:
        groups.setdefault(r["tag"].rsplit("-", 1)[0], []).append(r)
    print()
    print("| group (median, min-max) | n | " + " | ".join(c for c, _ in COLS) + " |")
    print("|---" * (len(COLS) + 2) + "|")
    for g, rs in groups.items():
        cells = []
        for c, f in COLS:
            xs = [r[c] for r in rs if c in r and r[c] == r[c]]
            if not xs:
                cells.append("-")
                continue
            med = float(np.median(xs))
            fmt = f if "d}" not in f else "{:.0f}"
            cells.append(f"{fmt.format(med)} ({fmt.format(min(xs))}-{fmt.format(max(xs))})")
        print(f"| {g} | {len(rs)} | " + " | ".join(cells) + " |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
