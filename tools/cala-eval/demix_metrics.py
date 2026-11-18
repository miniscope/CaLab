#!/usr/bin/env python
"""Per-run demixing metrics of a `qc_eval sim --dump` run against the sim's ground truth.

    python tools/cala-eval/demix_metrics.py SIM_DIR RUN_DIR [--all-det] [--force]

Needs numpy and scipy (the minisim venv has both). Reads `SIM_DIR/oracle.bin` and
`RUN_DIR/{footprints.bin,dump_trace.f32,final.tsv,passes.tsv,stdout.log}`; writes
`RUN_DIR/demix_pairs.tsv`, `demix_corr.tsv` and `demix_det.json`, which `demix_report.py` pools.

Definitions (the measure scripts of the 17 Nov 2026 refine-gate work, folded in):

* Match: Hungarian assignment on the unfiltered footprint correlation against the GT full footprint,
  r >= 0.7. Detectable GT units only, unless `--all-det` (the designed pairs sims carry no flags).
  Soma diameter D = median half-max equivalent diameter of the GT footprints.
* Motion sims: cala registers to its warm-up template, a pixel or two off the sim's tissue frame. The
  offset is estimated here from the matched footprints' centroids (median, loose r >= 0.5 match) and the
  GT is moved into cala's frame before the strict match; it is stored in `demix_det.json` (`offset`).
* Bite pair (i, j): matched estimate i, GT neighbour j with 0 < centre distance < 3 D and the true A_i at
  j's centre above 0.1 of its peak. ratio = peak-normalised estimated A_i at c_j over the true one; the
  control `ring` is the same ratio on the circle of radius |c_i - c_j| around c_i on the side facing away
  from j (skirt truncation, not a bite). `leak_sd` = beta_j sd(C_j) / (beta_i sd(C_i)) of the OLS
  C_i_est ~ beta_i C_i + beta_j C_j + 1.
* Trace correlation pairs: all matched pairs closer than 3 D, Pearson r of the estimated traces after a
  15 s (300 frame) moving-average high-pass; excess = median r at < 1 D minus median r at 1.5-3 D.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import shift as nd_shift
from scipy.ndimage import uniform_filter1d
from scipy.optimize import linear_sum_assignment

MATCH_R = 0.7
LOOSE_R = 0.5  # for the motion-offset estimate
NEIGHBOUR_D = 3.0  # neighbours within this many diameters
HP_FRAMES = 300  # 15 s at 20 fps
MIN_OFFSET_PX = 0.2  # smaller estimated offsets are ignored

PAIR_COLS = [
    "sim", "i", "ui", "j", "jdet", "jmatched", "d_px", "d_diam", "true_ring", "est_ring",
    "true_at_cj", "est_at_cj", "r_fp", "leak_sd", "corr_CiCj",
]  # fmt: skip
CORR_COLS = ["sim", "ui", "uj", "d_diam", "c_est", "c_true"]


# --------------------------------------------------------------------------- I/O


def read_oracle(path):
    """CALAORC1: (h, w, units, C). Each unit: det flag, centre, full-footprint patch (y0, x0, v)."""
    b = Path(path).read_bytes()
    assert b[:8] == b"CALAORC1", "not a CALAORC1 file"
    h, w, n, t = struct.unpack("<4I", b[8:24])
    o = 24
    units = []
    for _ in range(n):
        o += 4
        flags = b[o : o + 4]
        o += 4
        cy, cx = struct.unpack("<2f", b[o : o + 8])
        o += 8
        fps = []
        for _k in range(2):
            y0, x0, ph, pw = struct.unpack("<4I", b[o : o + 16])
            o += 16
            v = np.frombuffer(b, "<f4", ph * pw, o).reshape(ph, pw)
            o += 4 * ph * pw
            fps.append((y0, x0, np.maximum(v, 0)))
        units.append({"det": flags[0] != 0, "cy": cy, "cx": cx, "full": fps[0]})
    C = np.frombuffer(b, "<f4", n * t, o).reshape(n, t)
    return h, w, units, C


def read_footprints(path):
    """CALAFP01: (h, w, [(flat pixel index, value)]) per cell, library order."""
    b = Path(path).read_bytes()
    assert b[:8] == b"CALAFP01", "not a CALAFP01 file"
    h, w, n = struct.unpack("<3I", b[8:20])
    o = 20
    cells = []
    for _ in range(n):
        _cid, m = struct.unpack("<2I", b[o : o + 8])
        o += 8
        idx = np.frombuffer(b, "<u4", m, o).astype(np.int64)
        o += 4 * m
        val = np.frombuffer(b, "<f4", m, o).astype(np.float64)
        o += 8 * m  # values then a second per-pixel array (unused here)
        cells.append((idx, val))
    return h, w, cells


def dense_patch(fp, h, w):
    y0, x0, v = fp
    img = np.zeros((h, w), np.float32)
    y1, x1 = min(h, y0 + v.shape[0]), min(w, x0 + v.shape[1])
    img[y0:y1, x0:x1] = v[: y1 - y0, : x1 - x0]
    return img


# ----------------------------------------------------------------- matching


def pearson_matrix(cells, G, h, w):
    """Pearson r between each sparse estimate (rows) and each dense GT image (columns of G.T).

    G is (n_gt, h*w). Uses sum-of-products identities so no dense copy of the estimates is made.
    """
    N = h * w
    mg = np.array([r.mean(dtype=np.float64) for r in G])
    sg = np.sqrt(np.maximum(np.array([np.square(r, dtype=np.float64).mean() for r in G]) - mg**2, 0)) + 1e-12
    R = np.zeros((len(cells), G.shape[0]))
    for i, (idx, val) in enumerate(cells):
        ma = val.sum() / N
        sa = np.sqrt(max((val**2).sum() / N - ma * ma, 0)) + 1e-12
        sab = G[:, idx].astype(np.float64) @ val
        R[i] = (sab / N - ma * mg) / (sa * sg)
    return R


def match(R, det_idx, thresh):
    """Hungarian on R (cells x det units): {cell index: unit index} for r >= thresh."""
    if R.size == 0:
        return {}
    ri, ci = linear_sum_assignment(-R)
    return {int(i): det_idx[c] for i, c in zip(ri, ci) if R[i, c] >= thresh}


def centroid_sparse(idx, val, w):
    m = val > 0.5 * val.max()
    ww = val[m]
    return (idx[m] // w * ww).sum() / ww.sum(), (idx[m] % w * ww).sum() / ww.sum()


def centroid_patch(fp):
    y0, x0, v = fp
    m = v > 0.5 * v.max()
    ys, xs = np.nonzero(m)
    ww = v[m]
    return y0 + (ys * ww).sum() / ww.sum(), x0 + (xs * ww).sum() / ww.sum()


def estimate_offset(cells, units, loose_match, w):
    """Median (dy, dx) from GT to estimate over loosely matched cells; (0, 0) when few matches."""
    if len(loose_match) < 10:
        return 0.0, 0.0
    d = []
    for i, ui in loose_match.items():
        idx, val = cells[i]
        if val.max() <= 0:
            continue
        ey, ex = centroid_sparse(idx, val, w)
        gy, gx = centroid_patch(units[ui]["full"])
        d.append((ey - gy, ex - gx))
    if len(d) < 10:
        return 0.0, 0.0
    dy, dx = np.median(np.array(d), axis=0)
    return float(dy), float(dx)


# ------------------------------------------------------------ pair metrics


def corr(a, b):
    a = a - a.mean()
    b = b - b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d > 0 else 0.0


def leak_sd(est, Ci, Cj):
    """beta_j sd(Cj) / (|beta_i| sd(Ci)) of est ~ beta_i Ci + beta_j Cj + 1."""
    X = np.stack([Ci, Cj, np.ones_like(Ci)], 1)
    beta, *_ = np.linalg.lstsq(X, est, rcond=None)
    return float(beta[1] * Cj.std() / (abs(beta[0]) * Ci.std() + 1e-12))


def bite_rows(sim_name, cells, G, units, cen, nonempty, diam, match_i, matched_units, h, w, R, det_idx, est_tr, gt_tr):
    """One dict per (matched i, GT neighbour j). est_tr / gt_tr may be None (footprint metrics only)."""
    rows = []
    col_of = {u: k for k, u in enumerate(det_idx)}
    half = int(np.ceil(5 * diam))
    for i, ui in match_i.items():
        idx, val = cells[i]
        if val.max() <= 0:
            continue
        cy0, cx0 = cen[ui]
        y0, y1 = max(0, int(cy0) - half), min(h, int(cy0) + half + 1)
        x0, x1 = max(0, int(cx0) - half), min(w, int(cx0) + half + 1)
        # estimate and GT of cell i, cropped to the window around its centre
        ai = np.zeros(h * w)
        ai[idx] = val
        ai = ai.reshape(h, w)[y0:y1, x0:x1]
        gi = G[col_of[ui]].reshape(h, w)[y0:y1, x0:x1]
        gin = gi / gi.max()
        ain = ai / ai.max()
        yy, xx = np.mgrid[y0:y1, x0:x1]
        ry, rx = yy - cy0, xx - cx0
        rad = np.hypot(ry, rx)
        d_all = np.hypot(cen[:, 0] - cy0, cen[:, 1] - cx0)
        for j in np.where((d_all < NEIGHBOUR_D * diam) & (d_all > 0))[0]:
            if j == ui or not nonempty[j]:
                continue
            cyj, cxj = int(round(cen[j, 0])), int(round(cen[j, 1]))
            if not (y0 <= cyj < y1 and x0 <= cxj < x1):
                continue
            dj = d_all[j]
            ang = np.cos(np.arctan2(ry, rx) - np.arctan2(cen[j, 0] - cy0, cen[j, 1] - cx0))
            ring = (np.abs(rad - dj) < 1.0) & (ang < 0.0)
            row = {
                "sim": sim_name, "i": i, "ui": ui, "j": int(j), "jdet": int(units[j]["det"]),
                "jmatched": int(j in matched_units), "d_px": dj, "d_diam": dj / diam,
                "true_ring": gin[ring].mean() if ring.any() else np.nan,
                "est_ring": ain[ring].mean() if ring.any() else np.nan,
                "true_at_cj": gin[cyj - y0, cxj - x0], "est_at_cj": ain[cyj - y0, cxj - x0],
                "r_fp": R[i, col_of[ui]] if ui in col_of else np.nan,
                "leak_sd": np.nan, "corr_CiCj": np.nan,
            }  # fmt: skip
            if est_tr is not None:
                row["leak_sd"] = leak_sd(est_tr[:, i], gt_tr[ui], gt_tr[j])
                row["corr_CiCj"] = corr(gt_tr[ui], gt_tr[j])
            rows.append(row)
    return rows


def highpass(X, frames=HP_FRAMES):
    return X - uniform_filter1d(X, frames, axis=-1, mode="nearest")


def zscore_rows(X):
    X = np.nan_to_num(X.astype(np.float64))
    X = X - X.mean(1, keepdims=True)
    return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-12)


def corr_pairs(sim_name, est, gt, cen_u, diam, units_u):
    """Matched pairs closer than 3 D: estimated-trace and true-trace correlation after high-pass.

    est, gt: (n, T) traces of the matched estimates and their GT units; cen_u: (n, 2) GT centres.
    """
    ze, zg = zscore_rows(highpass(est)), zscore_rows(highpass(gt))
    ce, cg = ze @ ze.T, zg @ zg.T
    d = np.hypot(cen_u[:, None, 0] - cen_u[None, :, 0], cen_u[:, None, 1] - cen_u[None, :, 1]) / diam
    iu = np.triu_indices(len(est), 1)
    keep = d[iu] < NEIGHBOUR_D
    a, b = iu[0][keep], iu[1][keep]
    return [
        {"sim": sim_name, "ui": units_u[x], "uj": units_u[y], "d_diam": d[x, y], "c_est": ce[x, y], "c_true": cg[x, y]}
        for x, y in zip(a, b)
    ]


# ------------------------------------------------------------ detection row


def footprint_areas(cells):
    nnz = [int((v > 0).sum()) for _, v in cells]
    hm = [int((v >= 0.5 * v.max()).sum()) if v.size and v.max() > 0 else 0 for _, v in cells]
    return float(np.median(nnz)), float(np.median(hm))


def read_tsv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def qc_ms_per_frame(run: Path):
    """`QC cost per frame: mean X ms` from stdout.log (run_arms) or cost.txt (qc_eval)."""
    for name in ("cost.txt", "stdout.log"):
        p = run / name
        if p.exists():
            m = re.search(r"QC cost per frame: mean ([\d.]+) ms", p.read_text())
            if m:
                return float(m.group(1))
    return float("nan")


RES_BINS = [(0.0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.0)]


def pair_resolution(run: Path, diam, all_det=False):
    """GT neuron pairs by centre distance (D): [both, one, neither] matched in the final library.

    Uses qc_eval's own match (`final.tsv` matched / best_gt) and `gt.tsv` (detectable units, or all).
    Returns None when gt.tsv is missing.
    """
    if not (run / "gt.tsv").exists():
        return None
    final = read_tsv(run / "final.tsv")
    got = {int(float(r["best_gt"])) for r in final if int(float(r["matched"])) == 1}
    gt = [r for r in read_tsv(run / "gt.tsv") if all_det or int(float(r["detectable"])) == 1]
    ids = np.array([int(float(r["gt"])) for r in gt])
    P = np.array([[float(r["cy"]), float(r["cx"])] for r in gt]).reshape(-1, 2)
    hit = np.array([i in got for i in ids], dtype=int)
    d = np.hypot(P[:, None, 0] - P[None, :, 0], P[:, None, 1] - P[None, :, 1]) / diam
    both = hit[:, None] + hit[None, :]
    iu = np.triu_indices(len(ids), 1)
    out = {}
    for lo, hi in RES_BINS:
        m = (d[iu] >= lo) & (d[iu] < hi)
        n = both[iu][m]
        out[f"{lo}-{hi}"] = [int((n == 2).sum()), int((n == 1).sum()), int((n == 0).sum())]
    return out


def detection_row(run: Path, cells):
    final = read_tsv(run / "final.tsv")
    matched = sum(int(float(r["matched"])) for r in final)
    passes = read_tsv(run / "passes.tsv")[-1] if (run / "passes.tsv").exists() else {}
    a_nnz, a_hm = footprint_areas(cells)
    out = {
        "cells": len(final), "matched": matched, "false": len(final) - matched, "net": matched - (len(final) - matched),
        "merges": int(float(passes.get("merges", "nan"))) if passes else None,
        "splits": int(float(passes.get("splits", "nan"))) if passes else None,
        "area_support": a_nnz, "area_halfmax": a_hm, "ms_per_frame": qc_ms_per_frame(run),
    }  # fmt: skip
    return out


# --------------------------------------------------------------- run driver


def write_tsv(path, cols, rows):
    with open(path, "w") as f:
        f.write("\t".join(cols) + "\n")
        for r in rows:
            f.write("\t".join(("%.5g" % r[c]) if isinstance(r[c], (float, np.floating)) else str(r[c]) for c in cols) + "\n")


def compute_run(sim: Path, run: Path, all_det=False, force=False):
    if not force and (run / "demix_det.json").exists():
        return json.loads((run / "demix_det.json").read_text())
    h, w, units, Ct = read_oracle(sim / "oracle.bin")
    cells_h, cells_w, cells = read_footprints(run / "footprints.bin")
    assert (cells_h, cells_w) == (h, w), "footprints and oracle disagree on frame size"
    n = len(cells)
    # ground-truth images of all non-empty units, flat float32 (n_gt, h*w)
    nonempty = np.array([u["full"][2].max() > 0 for u in units])
    det_idx = [k for k, u in enumerate(units) if (u["det"] or all_det) and nonempty[k]]
    G = np.stack([dense_patch(units[k]["full"], h, w).ravel() for k in det_idx])  # the one big array
    diam = float(np.median([2 * np.sqrt((g > 0.5 * g.max()).sum() / np.pi) for g in G]))
    cen = np.array([[u["cy"], u["cx"]] for u in units], dtype=np.float64)
    R = pearson_matrix(cells, G, h, w)
    # motion offset: loose match, centroid shift, rebuild the GT in cala's frame, strict match
    dy, dx = estimate_offset(cells, units, match(R, det_idx, LOOSE_R), w)
    if np.hypot(dy, dx) >= MIN_OFFSET_PX:
        for r in range(G.shape[0]):  # in place, one image at a time
            G[r] = nd_shift(G[r].reshape(h, w), (dy, dx), order=1).ravel()
        cen = cen + np.array([dy, dx])
        R = pearson_matrix(cells, G, h, w)
    match_i = match(R, det_idx, MATCH_R)
    matched_units = set(match_i.values())
    est_tr = gt_tr = None
    tr_path = run / "dump_trace.f32"
    if tr_path.exists() and tr_path.stat().st_size > 0:
        est_tr = np.fromfile(tr_path, "<f4").reshape(-1, n).astype(np.float64)
        gt_tr = Ct[:, : est_tr.shape[0]].astype(np.float64)
    pairs = bite_rows(sim.name, cells, G, units, cen, nonempty, diam, match_i, matched_units, h, w, R, det_idx, est_tr, gt_tr)
    corr_rows = []
    if est_tr is not None and len(match_i) >= 2:
        I = np.array(list(match_i.keys()))
        U = [match_i[i] for i in I]
        corr_rows = corr_pairs(sim.name, est_tr[:, I].T, gt_tr[U], cen[U], diam, U)
    write_tsv(run / "demix_pairs.tsv", PAIR_COLS, pairs)
    write_tsv(run / "demix_corr.tsv", CORR_COLS, corr_rows)
    det = detection_row(run, cells)
    # cells that look like two neurons: footprint r >= 0.5 to two or more GT units (mlog.py's `diff`)
    det["multi_gt"] = int(((R >= LOOSE_R).sum(1) >= 2).sum())
    det["pair_res"] = pair_resolution(run, diam, all_det)
    for k, v in (det["pair_res"] or {}).items():
        det[f"both_{k}"] = v[0]
    det.update({"sim": sim.name, "diam_px": diam, "offset": [dy, dx], "n_cells": n, "n_matched_strict": len(match_i),
                "n_pairs": len(pairs), "n_corr_pairs": len(corr_rows), "traces": est_tr is not None})  # fmt: skip
    (run / "demix_det.json").write_text(json.dumps(det, indent=1))
    return det


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sim", type=Path)
    ap.add_argument("run", type=Path)
    ap.add_argument("--all-det", action="store_true", help="treat every GT unit as detectable (pairs sims)")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    d = compute_run(a.sim, a.run, a.all_det, a.force)
    print(f"{d['sim']}: {d['n_cells']} cells, {d['n_matched_strict']} matched (r>=0.7), D {d['diam_px']:.1f}px, "
          f"offset ({d['offset'][0]:+.2f}, {d['offset'][1]:+.2f}), {d['n_pairs']} bite pairs, {d['n_corr_pairs']} corr pairs")  # fmt: skip
    return 0


if __name__ == "__main__":
    sys.exit(main())
