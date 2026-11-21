#!/usr/bin/env python
"""The live library at checkpoints of a run (the concurrent-settle study): quality and footprint change.

    $MINISIM_PY tools/cala-eval/concsettle_checkpoints.py --root $CALA_DATA/demix-suite/cs-t30 --arms T30,T30-CS \
        [--old 1200] [--md out.md]
    $MINISIM_PY tools/cala-eval/concsettle_checkpoints.py --runs LABEL=dir,dir,.. --runs LABEL2=dir,..   # real data

Reads what `qc_eval --lib-at 0.25,0.5,0.75` writes in each run directory (`footprints_t{F}.bin`, with ground truth
also `final_t{F}.tsv`) plus the final library, and `adds.tsv` for the cells' birth frames. Per checkpoint:

* with ground truth: median footprint r of the matched cells, all and those born at least `--old` frames before the
  checkpoint, and the matched / unmatched counts;
* footprint change since the previous checkpoint, per cell present at both: relative L2 change on the union of the two
  supports; the median and the share of cells above 10 %.

Each value is the mean over the arm's runs; with two or more arms the last column block is each arm minus the first,
paired by run name, with a 95 % CI (paired t over runs, `demix_report.t_ci`).
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_metrics as DM  # noqa: E402
import demix_report as DR  # noqa: E402


def rows(path: Path):
    with open(path) as f:
        return list(csv.DictReader(f, delimiter="\t"))


def births(run: Path) -> dict[int, int]:
    p = run / "adds.tsv"
    if not p.exists():
        return {}
    return {int(r["id"]): int(r["recording_frame"]) for r in rows(p)}


def library(path: Path) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    _h, _w, ids, cells, _f = DM.read_library(path)
    return {int(i): (c[0], c[1]) if isinstance(c, tuple) else (np.array([p for p, _ in c]), np.array([v for _, v in c])) for i, c in zip(ids, cells)}


def change(a, b) -> float:
    """Relative L2 change from footprint a to b (each scaled to unit norm first: shape, not gain)."""
    ia, va = a
    ib, vb = b
    na, nb = np.linalg.norm(va), np.linalg.norm(vb)
    if na == 0 or nb == 0:
        return float("nan")
    da = dict(zip(ia.tolist(), (va / na).tolist()))
    d2 = 0.0
    for p, v in zip(ib.tolist(), (vb / nb).tolist()):
        d2 += (v - da.pop(p, 0.0)) ** 2
    d2 += sum(v * v for v in da.values())
    return float(np.sqrt(d2))


def run_metrics(run: Path, old: int) -> dict[tuple[int, str], float]:
    """{(checkpoint frame, metric): value}; the final library is checkpoint `END` = the run's last frame."""
    cps = sorted(int(m.group(1)) for p in run.glob("footprints_t*.bin") if (m := re.fullmatch(r"footprints_t(\d+)\.bin", p.name)))
    born = births(run)
    last = max(born.values(), default=0)
    out: dict[tuple[int, str], float] = {}
    prev = None
    for k, f in enumerate([*cps, None]):
        tag = f if f is not None else -1
        suffix = f"_t{f}" if f is not None else ""
        t_now = f if f is not None else max(last, cps[-1] if cps else 0) + 1
        tsv = run / f"final{suffix}.tsv"
        if tsv.exists():
            rs = rows(tsv)
            if rs and "best_r" in rs[0]:
                m = [r for r in rs if r.get("matched") == "1"]
                r_all = [float(r["best_r"]) for r in m]
                r_old = [float(r["best_r"]) for r in m if born.get(int(r["id"]), 0) <= t_now - old]
                out[(tag, "r all")] = float(np.median(r_all)) if r_all else float("nan")
                out[(tag, "r old")] = float(np.median(r_old)) if r_old else float("nan")
                out[(tag, "matched")] = len(m)
                out[(tag, "unmatched")] = len(rs) - len(m)
        lib = library(run / f"footprints{suffix}.bin")
        out[(tag, "cells")] = len(lib)
        if prev is not None:
            ch = np.array([change(prev[i], lib[i]) for i in lib if i in prev])
            ch = ch[np.isfinite(ch)]
            if len(ch):
                out[(tag, "change med")] = float(np.median(ch))
                out[(tag, "change >10%")] = float((ch > 0.10).mean())
        prev = lib
        del k
    return out


METRICS = [("r all", 4), ("r old", 4), ("matched", 1), ("unmatched", 1), ("cells", 1), ("change med", 3), ("change >10%", 3)]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path)
    ap.add_argument("--arms", help="comma list under --root; the first is the reference")
    ap.add_argument("--runs", action="append", default=[], help="LABEL=dir,dir,.. (instead of --root/--arms)")
    ap.add_argument("--old", type=int, default=1200)
    ap.add_argument("--md", type=Path)
    a = ap.parse_args(argv)
    arms: list[tuple[str, dict[str, Path]]] = []
    if a.root:
        for label in a.arms.split(","):
            arms.append((label, {d.name: d for d in sorted((a.root / label).iterdir()) if (d / "footprints.bin").exists()}))
    for spec in a.runs:
        label, _, dirs = spec.partition("=")
        arms.append((label, {f"run{k}": Path(d) for k, d in enumerate(dirs.split(","))}))
    data = {label: {name: run_metrics(d, a.old) for name, d in runs.items()} for label, runs in arms}
    ref = arms[0][0]
    tags = sorted({t for runs in data.values() for m in runs.values() for t, _ in m}, key=lambda t: (t == -1, t))
    lines = [f"| checkpoint | measure | {' | '.join(l for l, _ in arms)} | {' | '.join(f'{l} minus {ref} [95 % CI]' for l, _ in arms[1:])} |",
             "|" + " --- |" * (2 + len(arms) + len(arms) - 1)]  # fmt: skip
    for t in tags:
        for name, dg in METRICS:
            vals = {l: {n: m[(t, name)] for n, m in runs.items() if (t, name) in m} for l, runs in data.items()}
            if not any(vals.values()):
                continue
            cells = [f"{np.nanmean(list(v.values())):.{dg}f}" if v else "-" for v in vals.values()]
            diffs = []
            for l, _ in arms[1:]:
                common = [n for n in vals[l] if n in vals[ref]]
                m, lo, hi = DR.t_ci([vals[l][n] - vals[ref][n] for n in common])
                diffs.append(f"{m:+.{dg}f} [{lo:+.{dg}f}, {hi:+.{dg}f}] (n={len(common)})")
            lines.append(f"| {'end' if t == -1 else t} | {name} | {' | '.join(cells)} | {' | '.join(diffs)} |")
    text = "\n".join(lines) + "\n"
    print(text)
    if a.md:
        a.md.write_text(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
