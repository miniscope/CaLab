#!/usr/bin/env python
"""Cut a `qc_eval --passes N` run into one run directory per pass.

    python tools/cala-eval/split_passes.py <run> [<run> ...] [--out-suffix _pass]

`qc_eval --passes N` writes virtual frames (pass k, 0-based, recording frame t
is k * F + t, F = frames per pass). For each pass k (1-based) this writes
`<run>_pass<k>/` with the rows of that pass and frames shifted back to
recording frames, so `summarize.py` reads it as an ordinary single-pass run
(P8 = precision at the end of pass k, the convergence columns at the end of
pass k, the churn rates over the last 4 minutes of pass k). `footprints.bin`
and `final.tsv` come from `footprints_pass<k>.bin` / `final_pass<k>.tsv`
(the fast loop's library at the end of the pass, before
`SlowLoop::finalize`). The held-out score (`S8`, `ho_marginal_z`) is held
out in pass 1 only. Standard library only.
"""

import argparse
import csv
import shutil
import sys
from pathlib import Path

# File -> frame columns to cut on (first) and shift (all).
FRAME_COLS = {
    "cells.tsv": ["frame"],
    "convergence.tsv": ["frame"],
    "ho_cells.tsv": ["frame"],
    "adds.tsv": ["recording_frame"],
    "removals.tsv": ["recording_frame", "born_recording"],
}
COPY = ["gt.tsv", "run.json", "passes.tsv"]


def read(path: Path) -> tuple[list[str], list[dict]]:
    with open(path, newline="") as f:
        r = csv.DictReader(f, delimiter="\t")
        return list(r.fieldnames or []), list(r)


def write(path: Path, fields: list[str], rows: list[dict]) -> None:
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fields, delimiter="\t", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def fmt_like(orig: str, v: float) -> str:
    if "." in orig:
        return f"{v:.{len(orig.split('.')[1])}f}"
    return str(int(round(v)))


def split(run: Path, suffix: str) -> list[Path]:
    _, passes = read(run / "passes.tsv")
    ends = [int(p["frame"]) for p in passes]
    n = len(ends)
    f_pass = ends[0]
    # `global.tsv` counts frames after the slow loop's start; align it on the
    # last checkpoint as `summarize.py` does.
    gf, grows = read(run / "global.tsv")
    _, crows = read(run / "cells.tsv")
    last_cells = max(float(r["frame"]) for r in crows)
    last_g = max(float(r["frames"]) for r in grows)
    shift = last_cells - last_g
    out = []
    for k in range(1, n + 1):
        lo, hi = (k - 1) * f_pass, k * f_pass
        d = run.parent / f"{run.name}{suffix}{k}"
        d.mkdir(exist_ok=True)
        rows = []
        for r in grows:
            v = float(r["frames"]) + shift
            if lo < v <= hi:
                r = dict(r)
                r["frames"] = fmt_like(r["frames"], float(r["frames"]) - lo)
                rows.append(r)
        write(d / "global.tsv", gf, rows)
        for name, cols in FRAME_COLS.items():
            if not (run / name).exists():
                continue
            fields, src = read(run / name)
            rows = []
            for r in src:
                v = float(r[cols[0]])
                if lo < v <= hi:
                    r = dict(r)
                    for c in cols:
                        if r.get(c) not in (None, "", "nan"):
                            r[c] = fmt_like(r[c], float(r[c]) - lo)
                    rows.append(r)
            write(d / name, fields, rows)
        for name in COPY:
            if (run / name).exists():
                shutil.copy(run / name, d / name)
        for base, ext in (("footprints", "bin"), ("final", "tsv")):
            src = run / f"{base}_pass{k}.{ext}"
            if src.exists():
                shutil.copy(src, d / f"{base}.{ext}")
        (d / "SPLIT").write_text(f"pass {k} of {n} from {run}; frames ({lo}, {hi}] shifted by -{lo}\n")
        out.append(d)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--out-suffix", default="_pass")
    a = ap.parse_args()
    for run in a.runs:
        for d in split(run, a.out_suffix):
            print(d)
    return 0


if __name__ == "__main__":
    sys.exit(main())
