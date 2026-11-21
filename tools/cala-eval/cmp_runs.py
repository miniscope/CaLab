#!/usr/bin/env python
"""Are two qc_eval run directories the same apart from wall-time fields?

    python tools/cala-eval/cmp_runs.py RUN_A RUN_B

Every file of RUN_A is compared with RUN_B's. A file that differs is compared again with its wall-time fields masked:
TSV columns named for a time, and in text files numbers followed by a time unit or a percent sign and the p50 / p99 /
max values of a timing line. Prints which files needed the mask and which still differ; exit code 1 if any does.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

TIME_COL = re.compile(r"(wall|_s$|_ms|^ms|secs|_ns$|ns$|time|_us$)")
TIME_TEXT = re.compile(r"[0-9]+(\.[0-9]+)?(e[-+]?[0-9]+)? ?(s wall|ms|us|s\b|%)|(p50|p99|max) [0-9.]+|\[[0-9., ]+\] s")


def masked(path: Path) -> tuple[str | bytes, list[str]]:
    """The file's content without wall-time fields, and the TSV columns that were dropped."""
    raw = path.read_bytes()
    if path.suffix == ".tsv":
        rows = [line.split("\t") for line in raw.decode().splitlines()]
        if not rows:
            return raw, []
        keep = [i for i, h in enumerate(rows[0]) if not TIME_COL.search(h)]
        text = "\n".join("\t".join(r[i] for i in keep if i < len(r)) for r in rows)
        return text, [h for h in rows[0] if TIME_COL.search(h)]
    if path.suffix in (".txt", ".log"):
        return TIME_TEXT.sub("T", raw.decode(errors="replace")), []
    return raw, []


def main(argv: list[str]) -> int:
    a, b = Path(argv[1]), Path(argv[2])
    files = sorted(p.name for p in a.iterdir() if p.is_file())
    differ: list[str] = []
    needed_mask: list[str] = []
    for name in files:
        if not (b / name).exists():
            differ.append(f"{name} (missing)")
            continue
        if (a / name).read_bytes() == (b / name).read_bytes():
            continue
        ma, mb = masked(a / name), masked(b / name)
        if ma[0] != mb[0]:
            differ.append(name)
        else:
            needed_mask.append(name + (f" [{','.join(ma[1])}]" if ma[1] else ""))
    print(f"{a} vs {b}: {len(files)} files; identical after masking wall-time fields in: {needed_mask}; DIFFER: {differ}")
    return 1 if differ else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
