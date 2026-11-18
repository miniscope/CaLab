"""Seconds per stage of a cala browser run, from its export.

    python stage_times.py EXPORT.npz [EXPORT.npz ...]

Reads `meta_json.stages` (export format 3 and later): each Discover, Refine and
Extract run with its start and end time. Prints a Markdown table per export.
Needs numpy.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np

Row = dict[str, float | str]


def parse(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp)  # Python 3.11+ reads the trailing "Z"


def stages(npz: Path) -> list[Row]:
    """One row per stage run: stage, index, outcome, seconds, frames, cells, fps."""
    meta = json.loads(np.load(npz)["meta_json"].tobytes().decode())
    rows: list[Row] = []
    for s in meta.get("stages", []):
        ended = s.get("ended_at")
        seconds = (
            (parse(ended) - parse(s["started_at"])).total_seconds()
            if ended
            else float("nan")
        )
        frames = float(s.get("frames") or 0)
        rows.append(
            {
                "stage": str(s["stage"]),
                "index": float(s.get("index") or 0),
                "outcome": str(s.get("outcome", "")),
                "seconds": seconds,
                "frames": frames,
                "cells": float(s.get("cells") or 0),
                "fps": frames / seconds if seconds > 0 else float("nan"),
            }
        )
    return rows


def table(npz: Path) -> str:
    rows = stages(npz)
    out = [f"`{npz.name}`", ""]
    if not rows:
        return "\n".join(out + ["no stage records in this export", ""])
    out += [
        "| stage | run | outcome | seconds | frames | cells | frames per second |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        out.append(
            f"| {r['stage']} | {r['index']:.0f} | {r['outcome']} | {r['seconds']:.1f} | "
            f"{r['frames']:.0f} | {r['cells']:.0f} | {r['fps']:.0f} |"
        )
    return "\n".join(out + [""])


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for p in sys.argv[1:]:
        print(table(Path(p)))


if __name__ == "__main__":
    main()
