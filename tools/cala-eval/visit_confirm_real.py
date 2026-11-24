#!/usr/bin/env python
"""Visit budget confirmation on real data (results/2026-11-24-visit-budget-sweep.md, "Confirmation").

    $MINISIM_PY tools/cala-eval/visit_confirm_real.py [--root R] [--md OUT] [--png-dir DIR]

Runs are `visit_budget_real.sh` outputs `<root>/10_43_21_s<seed>_b<budget>_k<..>/` (untimed qc_eval real runs of a Samara
recording; the recording is read-only, everything here reads only the run directories). No ground truth. Per run:
cells (final library), the app's QC colours from the last Discover checkpoint of `cells.tsv` (pass = SNR >= 5 and not a
likely duplicate: the run's own `pass` column; low SNR = flag 1; likely duplicate = flag 4), QC peak SNR quantiles, and a
texture proxy from the footprint (there is no validated metric in the repo): smooth the footprint with a 3x3 mean, take the
connected components above half its peak; `core share` = mass of the largest component / mass of the footprint; textured
= core share < 0.35 (no single dominant core; scattered or ring-like light). Across arms: Hungarian assignment of footprints (cosine similarity, non-negative footprints, >= 0.7) between
two runs; cells without a partner are new cells or extra pieces of a split, and those with no cell at cosine >= 0.5 have no
counterpart at all. Different seeds of one arm give the run-to-run baseline. Writes one contour overlay PNG per arm (no mean image is kept by the runs, so the
background is the summed footprints of the 1x seed-1 arm): cyan = has a 1-to-1 partner in the same-seed 1x run, red = none (new or a split piece).
Needs numpy, scipy.
"""

from __future__ import annotations

import argparse
import re
import struct
import sys
import zlib
from pathlib import Path

import numpy as np
from scipy.ndimage import label, uniform_filter
from scipy.optimize import linear_sum_assignment
from scipy.sparse import csr_matrix

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_metrics as DM  # noqa: E402

FLAG_LOW_SNR, FLAG_DUP = 1, 4
ABSENT_R = 0.5
MATCH_R = 0.7
CORE_TEXTURED = 0.35


def sparse_mat(cells, hw):
    r, c, v = [], [], []
    for i, (idx, val) in enumerate(cells):
        r.append(np.full(len(idx), i))
        c.append(idx)
        v.append(val / (np.linalg.norm(val) + 1e-12))
    return csr_matrix((np.concatenate(v), (np.concatenate(r), np.concatenate(c))), shape=(len(cells), hw))


def core_share(idx, val, h, w):
    ys, xs = idx // w, idx % w
    y0, y1, x0, x1 = max(ys.min() - 2, 0), min(ys.max() + 3, h), max(xs.min() - 2, 0), min(xs.max() + 3, w)
    img = np.zeros((y1 - y0, x1 - x0), np.float32)
    img[ys - y0, xs - x0] = val
    sm = uniform_filter(img, 3, mode="constant")
    pk = sm.max()
    if pk <= 0:
        return 0.0
    lab, n = label(sm > 0.5 * pk)
    if n == 0:
        return 0.0
    mass = np.bincount(lab.ravel(), weights=sm.ravel(), minlength=n + 1)[1:]
    return float(mass.max() / sm.sum())


def load(run: Path) -> dict:
    h, w, ids, cells, _f = DM.read_library(run / "footprints.bin")
    rows = DM.read_tsv(run / "cells.tsv")
    last = max(int(float(r["frame"])) for r in rows)
    qc = {int(float(r["id"])): r for r in rows if int(float(r["frame"])) == last}
    n = len(ids)
    snr = np.full(n, np.nan)
    flags = np.zeros(n, int)
    ok = np.full(n, np.nan)
    for i, cid in enumerate(ids):
        q = qc.get(cid)
        if q:
            snr[i] = float(q["peak_snr"])
            flags[i] = int(float(q["flags"]))
            ok[i] = float(q["pass"])
    core = np.array([core_share(idx, val, h, w) for idx, val in cells])
    log = Path(str(run) + ".log").read_text()
    st = re.search(r"settle: (\d+) frames in ([\d.]+) s .*?, (\d+) visits", log)
    g = DM.read_tsv(run / "global.tsv")[-1]
    fed, settle_v = int(st.group(1)), int(st.group(3))
    v_disc = (float(g["slow_visits"]) - settle_v) / max(float(g["slow_frames"]) - fed, 1)
    t = Path(str(run) + ".time").read_text()
    rss = int(re.search(r"(\d+)\s+maximum resident", t).group(1)) / 1e9
    wall = float(re.search(r"([\d.]+) real", t).group(1))
    return dict(run=run, h=h, w=w, ids=ids, cells=cells, snr=snr, flags=flags, ok=ok, core=core, n=n, v_disc=v_disc,
                v_settle=settle_v / max(fed, 1), rss=rss, wall=wall, qc_n=int(np.isfinite(ok).sum()))  # fmt: skip


def absent(a: dict, bs: list[dict]) -> np.ndarray:
    """Cells of a with no footprint cosine >= ABSENT_R to any cell of any run in bs."""
    A = sparse_mat(a["cells"], a["h"] * a["w"])
    best = np.zeros(a["n"])
    for b in bs:
        best = np.maximum(best, (A @ sparse_mat(b["cells"], b["h"] * b["w"]).T).toarray().max(1))
    return best < ABSENT_R


def png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))  # fmt: skip


def overlay(path, ref: dict, arm: dict, ab: np.ndarray):
    h, w = ref["h"], ref["w"]
    bg = np.zeros(h * w)
    for idx, val in ref["cells"]:
        bg[idx] = np.maximum(bg[idx], val / val.max())
    bg = (bg.reshape(h, w) * 90).astype(np.uint8)
    img = np.stack([bg] * 3, -1).repeat(2, 0).repeat(2, 1)
    for k, (idx, val) in enumerate(arm["cells"]):
        m = np.zeros(h * w, bool)
        m[idx[val > 0.3 * val.max()]] = True
        m = m.reshape(h, w)
        edge = m & ~(uniform_filter(m.astype(np.float32), 3, mode="constant") > 0.99)
        e2 = edge.repeat(2, 0).repeat(2, 1)
        img[e2] = (230, 60, 60) if ab[k] else (60, 200, 220)
    png(path, img)


def pct(x, q):
    x = x[np.isfinite(x)]
    return float(np.percentile(x, q)) if len(x) else float("nan")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path.home() / "Projects/cala-data/runs/visit-sweep/real"))
    ap.add_argument("--md", default=None)
    ap.add_argument("--png-dir", default=None)
    a = ap.parse_args()
    root = Path(a.root)
    runs = {}
    for d in sorted(root.glob("10_43_21_s*_b*_k*")):
        m = re.match(r"10_43_21_s(\d+)_b(\d+)_k(\d+)$", d.name)
        if m and d.is_dir() and Path(str(d) + ".done").exists() and (d / "footprints.bin").exists():
            runs[(float(m.group(2)) / 1.3e7, int(m.group(1)))] = load(d)
    out = []
    P = out.append
    P("| arm | seed | visits / Discover frame | visits / settle frame | cells | QC pass | pass share | low SNR (< 5) | likely duplicate | "
      "peak SNR p25 / median / p75 | textured (core share < 0.35) | median core share | wall (min) | RSS GB |")
    P("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |")
    for (sc, seed), r in sorted(runs.items()):
        okm = np.isfinite(r["ok"])
        P(f"| {sc:g}x | {seed} | {r['v_disc']:.3f} | {r['v_settle']:.3f} | {r['n']} | {int(np.nansum(r['ok']))} | "
          f"{np.nansum(r['ok']) / max(okm.sum(), 1):.2f} | {int((r['snr'][okm] < 5).sum())} | {int(((r['flags'] & FLAG_DUP) > 0).sum())} | "
          f"{pct(r['snr'], 25):.1f} / {pct(r['snr'], 50):.1f} / {pct(r['snr'], 75):.1f} | "
          f"{int((r['core'] < CORE_TEXTURED).sum())} ({(r['core'] < CORE_TEXTURED).mean():.1%}) | {np.median(r['core']):.2f} | "
          f"{r['wall'] / 60:.0f} | {r['rss']:.2f} |")  # fmt: skip
    # cross-arm
    P("")
    P(f"Cell correspondence between two runs (footprint cosine). *No 1-to-1 partner* = unmatched in a Hungarian assignment at cosine >= {MATCH_R} "
      f"(a new cell or an extra piece of a split); *no counterpart* = also no cell of the other run with cosine >= {ABSENT_R}. "
      "Rows A vs a different seed of the same arm give the run-to-run baseline.")
    P("")
    P("| A | B | cells in A | 1-to-1 matched | no 1-to-1 partner | share | no counterpart | peak SNR median: no partner / matched | "
      "QC pass share: no partner / matched | textured share: no partner / matched |")
    P("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |")
    cache = {}

    def pair(ka, kb):
        if (ka, kb) in cache:
            return cache[(ka, kb)]
        A, B = runs[ka], runs[kb]
        S = (sparse_mat(A["cells"], A["h"] * A["w"]) @ sparse_mat(B["cells"], B["h"] * B["w"]).T).toarray()
        ri, ci = linear_sum_assignment(-S)
        m11 = np.zeros(A["n"], bool)
        m11[[i for i, c in zip(ri, ci) if S[i, c] >= MATCH_R]] = True
        cache[(ka, kb)] = (~m11, S.max(1) < ABSENT_R)
        return cache[(ka, kb)]

    def row(ka, kb):
        A = runs[ka]
        un, ab = pair(ka, kb)
        ok = np.isfinite(A["ok"])
        tx = (A["core"] < CORE_TEXTURED).astype(float)

        def med(m):
            return float(np.nanmedian(A["snr"][m])) if m.any() else float("nan")

        def sh(x, m):
            return float(np.nanmean(x[m])) if m.any() else float("nan")

        nm = lambda k: f"{k[0]:g}x s{k[1]}"  # noqa: E731
        P(f"| {nm(ka)} | {nm(kb)} | {A['n']} | {int((~un).sum())} | {int(un.sum())} | {un.mean():.1%} | {int(ab.sum())} | "
          f"{med(un):.1f} / {med(~un):.1f} | {sh(A['ok'], un & ok):.2f} / {sh(A['ok'], ~un & ok):.2f} | "
          f"{sh(tx, un):.1%} / {sh(tx, ~un):.1%} |")  # fmt: skip

    scales = sorted({k[0] for k in runs})
    for sc in scales:
        if (sc, 1) in runs and (sc, 2) in runs:
            row((sc, 1), (sc, 2))
            row((sc, 2), (sc, 1))
    for sc in scales:
        if sc == 1.0:
            continue
        for seed in (1, 2):
            if (sc, seed) in runs and (1.0, seed) in runs:
                row((sc, seed), (1.0, seed))
                row((1.0, seed), (sc, seed))
    # overlays
    if a.png_dir and (1.0, 1) in runs:
        Path(a.png_dir).mkdir(parents=True, exist_ok=True)
        for sc in scales:
            if sc != 1.0 and (sc, 1) in runs:
                overlay(Path(a.png_dir) / f"overlay_{sc:g}x_vs_1x.png", runs[(1.0, 1)], runs[(sc, 1)], pair((sc, 1), (1.0, 1))[0])
    text = "\n".join(out)
    print(text)
    if a.md:
        Path(a.md).write_text(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
