#!/usr/bin/env python
"""Score the runs of the settle-on-factors evaluation (results/2026-11-24-settle-factors-plan.md).

    settle_factors_score.py RUN_ROOT SIM_ROOT [--cut 12000] [--diam 10]

RUN_ROOT holds `motion_s5/`, `motion_s6/` and `wl24_20251201/`, each with `ARM-sSEED/` run folders
(`settle_factors.sh run`) and, for the real recording, their `hold-*` fixed-library runs
(`settle_factors.sh hold`). SIM_ROOT holds the sims (`motion_s5/`, ...). Prints Markdown tables:

* sims: per run, cells, matched true cells, unmatched cells, and the medians of `missed`, `excess`,
  `excess_nb` and `err_core` (`settle_size.py score`). `STR-0` is `STR-F`'s `footprints_settle0.bin`.
* real: the held-out proxies of each fixed-library run on the frames after `--cut`
  (`settle_size.proxies`), and repeatability: the median cosine of matched cells between the two seeds.
* speed: the settle's frames per second and seconds, and the compressor's ms per frame, from `run.log`.

Needs numpy and scipy.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import settle_size as S  # noqa: E402

SIMS = ("motion_s5", "motion_s6")
REAL = "wl24_20251201"
ARMS = ("SET-R", "SET-F", "STR-0", "STR-F")
SEEDS = (1, 2)


def run_dir(root: Path, rec: str, arm: str, seed: int) -> tuple[Path, str]:
    """The run folder and the library name of an arm (`STR-0` is `STR-F`'s library at the settle start)."""
    if arm == "STR-0":
        return root / rec / f"STR-F-s{seed}", "footprints_settle0"
    return root / rec / f"{arm}-s{seed}", "footprints"


def sim_row(sim: Path, run: Path, lib: str) -> dict[str, float]:
    rows = S.score_run(sim, run, f"{lib}.bin")
    _, _, cells, _ = S.load_any(run / f"{lib}.bin")
    out: dict[str, float] = {
        "cells": len(cells),
        "matched": len(rows),
        "unmatched": len(cells) - len(rows),
    }
    for k in ("missed", "excess", "excess_nb", "err_core"):
        out[k] = float(np.median([float(r[k]) for r in rows])) if rows else float("nan")
    return out


def repeatability(a: Path, b: Path) -> tuple[float, int]:
    """Median cosine of the one-to-one matched cells (cosine >= 0.7) of two libraries, and their count."""
    from scipy.optimize import linear_sum_assignment
    from scipy.sparse import csr_matrix

    h, w, A, _ = S.load_any(a)
    _, _, B, _ = S.load_any(b)

    def mat(cells: list) -> csr_matrix:
        r = np.concatenate([np.full(len(i), k) for k, (i, _) in enumerate(cells)])
        c = np.concatenate([i for i, _ in cells])
        v = np.concatenate([v / np.sqrt((v * v).sum()) for _, v in cells])
        return csr_matrix((v, (r, c)), shape=(len(cells), h * w))

    C = (mat(A) @ mat(B).T).toarray()
    ri, ci = linear_sum_assignment(-C)
    cos = [C[i, j] for i, j in zip(ri, ci, strict=True) if C[i, j] >= 0.7]
    return float(np.median(cos)), len(cos)


def speed(run: Path) -> dict[str, float]:
    log = (run / "run.log").read_text(errors="replace")
    out = {
        "settle_fps": float("nan"),
        "settle_s": float("nan"),
        "compress_ms": float("nan"),
    }
    m = re.search(r"^settle: (\d+) frames in ([\d.]+) s \((\d+) frames/s\)", log, re.M)
    if m:
        out["settle_s"], out["settle_fps"] = float(m.group(2)), float(m.group(3))
    m = re.search(r"^factors: \d+ frames, ([\d.]+) ms per frame", log, re.M)
    if m:
        out["compress_ms"] = float(m.group(1))
    return out


def fmt(v: float, d: int = 4) -> str:
    return "-" if v != v else f"{v:.{d}f}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("runs")
    ap.add_argument("sims")
    ap.add_argument("--cut", type=int, default=12000)
    ap.add_argument("--diam", type=float, default=10.0)
    a = ap.parse_args(argv)
    root, sims = Path(a.runs), Path(a.sims)

    print("## Sims (medians over matched cells)\n")
    print(
        "| sim | arm | seed | cells | matched | unmatched | missed | excess | excess_nb | err_core |"
    )
    print("| --- | --- | ---: |" + " ---: |" * 7)
    for rec in SIMS:
        for arm in ARMS:
            for seed in SEEDS:
                run, lib = run_dir(root, rec, arm, seed)
                if not (run / f"{lib}.bin").exists():
                    print(f"| {rec} | {arm} | {seed} | missing |" + " |" * 6)
                    continue
                r = sim_row(sims / rec, run, lib)
                print(
                    f"| {rec} | {arm} | {seed} | {r['cells']:.0f} | {r['matched']:.0f} | {r['unmatched']:.0f} | "
                    f"{fmt(r['missed'])} | {fmt(r['excess'])} | {fmt(r['excess_nb'])} | {fmt(r['err_core'], 5)} |"
                )

    print(f"\n## Real, {REAL}: held-out frames after {a.cut} (D = {a.diam} px)\n")
    print(
        "| arm | seed | cells | held-out score | share of signal | close-pair excess | repeatability (cos, n) |"
    )
    print("| --- | ---: |" + " ---: |" * 5)
    for arm in ARMS:
        libs = [run_dir(root, REAL, arm, s) for s in SEEDS]
        rep = "-"
        if all((d / f"{lib}.bin").exists() for d, lib in libs):
            c, n = repeatability(*(d / f"{lib}.bin" for d, lib in libs))
            rep = f"{c:.4f} ({n})"
        for seed, (d, lib) in zip(SEEDS, libs, strict=True):
            hold = d / f"hold-{lib}"
            if not (hold / "final.tsv").exists():
                print(f"| {arm} | {seed} | missing |" + " |" * 4)
                continue
            p = S.proxies(hold, a.cut, a.diam)
            n = len(S._tsv(hold / "final.tsv"))
            print(
                f"| {arm} | {seed} | {n} | {p['new']['score']:.0f} | {p['new']['frac']:.4f} | "
                f"{p['corr_close'] - p['corr_far']:+.3f} | {rep} |"
            )

    print("\n## Speed (settle and compressor, from run.log)\n")
    print(
        "| recording | arm | seed | settle frames/s | settle s | compressor ms/frame |"
    )
    print("| --- | --- | ---: | ---: | ---: | ---: |")
    for rec in (*SIMS, REAL):
        for arm in ("SET-R", "SET-F", "STR-F"):
            for seed in SEEDS:
                run = root / rec / f"{arm}-s{seed}"
                if not (run / "run.log").exists():
                    continue
                s = speed(run)
                print(
                    f"| {rec} | {arm} | {seed} | {fmt(s['settle_fps'], 0)} | {fmt(s['settle_s'], 1)} | "
                    f"{fmt(s['compress_ms'], 2)} |"
                )
    return 0


if __name__ == "__main__":
    sys.exit(main())
