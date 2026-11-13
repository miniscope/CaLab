#!/usr/bin/env python
"""Cell diameter (D1) and PSF width (P1) of cala's published footprints, offline (S2.4 M0).

    python tools/cala-eval/fp_scales.py <run>/footprints.bin [...] [--cell-diameter 10]
        [--final <run>/final.tsv] [--gt <sim>/oracle.bin] [--alpha 0.05] [--json out.json]

Reads `footprints.bin` (`CALAFP01`: height, width, n; per cell id, pixel count, pixels, unfiltered
values, filtered values) and uses the unfiltered values: the published footprint, which cala smooths
at `max(d / 10, 0.6)` px before inverting the flattener (`finish_cell`, `--cell-diameter` gives `d`).

Per cell:

- `d = 2 sqrt(A_half / pi)`, `A_half` = support pixels at or above half the peak (S2.4 section 2.1).
- `edge` = `peak / (sqrt(2 pi) max |grad|)` on the pixel grid (the statistic of section 1).
- `ring`: the azimuthally averaged profile `p(r)` in 1 px rings around the half-max centroid, over
  the rings the support covers completely; `s = p_core / (sqrt(2 pi) max_r (p(r) - p(r + 1)))`.
  For a sharp disk blurred by a Gaussian this is its sigma (plus the ring width, 1/12 px^2 in
  quadrature). A support cut before the profile reaches zero is not used (incomplete rings), and
  `p_tail` is taken as 0 because published footprints are background-free.
- cala's own smoothing is removed in quadrature from both edge statistics (`*_dq` columns).
- `se_s`: a standard-error proxy for `s` from the scatter within each ring (`sd / sqrt(n)`)
  propagated through the slope and the plateau. The scatter includes non-roundness, so this is an
  upper proxy of the noise SE; the dumps carry no measured SE.

Population estimates:

- D1: median of `d` with a distribution-free 95 % CI from order statistics.
- P1: `min_i (s_i + z SE_i)`, `z = Phi^-1(1 - alpha / N)` (section 2.3), on the `ring_dq` statistic,
  reported with `min s_i` and quantiles.

With `--final` (qc_eval `final.tsv`) and `--gt` (the sim's `oracle.bin`), matched cells are paired
with their ground-truth unit (`best_gt`) and the per-cell ratio `d_cala / d_gt` is reported.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np

SQRT2PI = math.sqrt(2 * math.pi)


def read_footprints(path: str | Path) -> tuple[tuple[int, int], dict[int, tuple[np.ndarray, np.ndarray]]]:
    """`{id: (pixel indices, unfiltered values)}` of a `footprints.bin`."""
    cells = {}
    with open(path, "rb") as f:
        assert f.read(8) == b"CALAFP01", f"{path}: not a footprints.bin"
        h, w, n = struct.unpack("<III", f.read(12))
        for _ in range(n):
            cid, k = struct.unpack("<II", f.read(8))
            pix = np.frombuffer(f.read(4 * k), "<u4").astype(np.int64)
            raw = np.frombuffer(f.read(4 * k), "<f4").astype(np.float64)
            f.read(4 * k)  # filtered values
            cells[cid] = (pix, raw)
    return (h, w), cells


def to_patch(pix: np.ndarray, val: np.ndarray, w: int, pad: int = 2):
    """Dense patch (values, support mask) around a sparse footprint, `pad` px of empty border."""
    y, x = pix // w, pix % w
    y0, x0 = y.min() - pad, x.min() - pad
    ph, pw = y.max() - y0 + 1 + pad, x.max() - x0 + 1 + pad
    a = np.zeros((ph, pw))
    m = np.zeros((ph, pw), bool)
    a[y - y0, x - x0] = val
    m[y - y0, x - x0] = True
    return a, m


def half_max_diameter(a: np.ndarray) -> float:
    pk = a.max()
    return 2 * math.sqrt((a >= 0.5 * pk).sum() / math.pi) if pk > 0 else float("nan")


def grad_edge(a: np.ndarray) -> float:
    pk = a.max()
    gy, gx = np.gradient(a)
    g = np.hypot(gy, gx).max()
    return pk / (SQRT2PI * g) if g > 0 else float("nan")


def ring_edge(a: np.ndarray, m: np.ndarray) -> tuple[float, float, int]:
    """(s, se_s, complete rings) from the radial profile around the half-max centroid."""
    pk = a.max()
    if not pk > 0:
        return float("nan"), float("nan"), 0
    hm = a >= 0.5 * pk
    yy, xx = np.nonzero(hm)
    wts = a[hm]
    cy, cx = (yy * wts).sum() / wts.sum(), (xx * wts).sum() / wts.sum()
    gy, gx = np.mgrid[0 : a.shape[0], 0 : a.shape[1]]
    r = np.floor(np.hypot(gy - cy, gx - cx)).astype(int)
    p, se = [], []
    for k in range(r.max() + 1):
        ring = r == k
        if not ring.any() or not m[ring].all():
            break  # first ring the support does not cover completely
        v = a[ring]
        p.append(v.mean())
        se.append(v.std(ddof=1) / math.sqrt(len(v)) if len(v) > 1 else 0.0)
    if len(p) < 3:
        return float("nan"), float("nan"), len(p)
    p, se = np.array(p), np.array(se)
    slopes = p[:-1] - p[1:]
    j = int(np.argmax(slopes))
    g = slopes[j]
    core = p.max()
    if not g > 0:
        return float("nan"), float("nan"), len(p)
    s = core / (SQRT2PI * g)
    se_g = math.hypot(se[j], se[j + 1])
    se_c = se[int(np.argmax(p))]
    se_s = s * math.hypot(se_g / g, se_c / core)
    return s, se_s, len(p)


def norm_ppf(q: float) -> float:
    """Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9)."""
    a = [-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02, 1.383577518672690e02,
         -3.066479806614716e01, 2.506628277459239e00]  # fmt: skip
    b = [-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02, 6.680131188771972e01,
         -1.328068155288572e01]  # fmt: skip
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00, -2.549732539343734e00,
         4.374664141464968e00, 2.938163982698783e00]  # fmt: skip
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00, 3.754408661907416e00]
    if q < 0.02425:
        t = math.sqrt(-2 * math.log(q))
        return (((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / (
            (((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1)
    if q > 1 - 0.02425:
        return -norm_ppf(1 - q)
    t = q - 0.5
    u = t * t
    return (((((a[0] * u + a[1]) * u + a[2]) * u + a[3]) * u + a[4]) * u + a[5]) * t / (
        ((((b[0] * u + b[1]) * u + b[2]) * u + b[3]) * u + b[4]) * u + 1)


def median_ci(v: np.ndarray, level: float = 0.95) -> tuple[float, float, float]:
    """Median and its distribution-free CI from order statistics (NaN bounds when n is too small)."""
    v = np.sort(v[np.isfinite(v)])
    n = len(v)
    if n == 0:
        return float("nan"), float("nan"), float("nan")
    z = norm_ppf(0.5 + level / 2)
    lo = int(math.floor(n / 2 - z * math.sqrt(n) / 2))
    hi = int(math.ceil(n / 2 + z * math.sqrt(n) / 2))
    med = float(np.median(v))
    if lo < 0 or hi > n - 1:
        return med, float("nan"), float("nan")
    return med, float(v[lo]), float(v[hi])


def psf_bound(s: np.ndarray, se: np.ndarray, alpha: float) -> tuple[float, float, int]:
    """(min_i s_i + z SE_i, min_i s_i, N), z = Phi^-1(1 - alpha / N)."""
    ok = np.isfinite(s) & np.isfinite(se)
    n = int(ok.sum())
    if n == 0:
        return float("nan"), float("nan"), 0
    z = norm_ppf(1 - alpha / n)
    return float((s[ok] + z * se[ok]).min()), float(s[ok].min()), n


def quad_remove(s: np.ndarray, sm: float) -> np.ndarray:
    """`sqrt(s^2 - sm^2)`, NaN where `s <= sm`."""
    with np.errstate(invalid="ignore"):
        return np.sqrt(np.where(s > sm, s * s - sm * sm, np.nan))


def measure_cells(cells: dict, w: int, smooth: float) -> dict[int, dict]:
    out = {}
    for cid, (pix, raw) in cells.items():
        a, m = to_patch(pix, np.clip(raw, 0, None), w)
        if not a.max() > 0:
            continue
        s, se_s, nr = ring_edge(a, m)
        e = grad_edge(a)
        out[cid] = {
            "d": half_max_diameter(a),
            "edge": e,
            "ring": s,
            "se_ring": se_s,
            "rings": nr,
            "npix": len(pix),
        }
    ids = list(out)
    if smooth > 0 and ids:
        e_dq = quad_remove(np.array([out[i]["edge"] for i in ids]), smooth)
        r_dq = quad_remove(np.array([out[i]["ring"] for i in ids]), smooth)
        for i, cid in enumerate(ids):
            out[cid]["edge_dq"] = float(e_dq[i])
            out[cid]["ring_dq"] = float(r_dq[i])
    else:
        for cid in ids:
            out[cid]["edge_dq"] = out[cid]["edge"]
            out[cid]["ring_dq"] = out[cid]["ring"]
    return out


def quant(v) -> dict:
    v = np.asarray(v, float)
    v = v[np.isfinite(v)]
    if len(v) == 0:
        return {"n": 0}
    q = np.percentile(v, [1, 5, 10, 25, 50, 75, 90])
    return {"n": int(len(v)), "min": float(v.min()), **{f"q{p}": float(x) for p, x in zip([1, 5, 10, 25, 50, 75, 90], q)}}


def summarize(m: dict[int, dict], alpha: float) -> dict:
    ids = list(m)
    col = lambda k: np.array([m[i][k] for i in ids], float)  # noqa: E731
    d = col("d")
    med, lo, hi = median_ci(d)
    s, se = col("ring_dq"), col("se_ring")
    bound, smin, n = psf_bound(s, se, alpha)
    return {
        "cells": len(ids),
        "d_median": med,
        "d_ci": [lo, hi],
        "d": quant(d),
        "edge_dq": quant(col("edge_dq")),
        "ring_dq": quant(s),
        "psf_bound": bound,
        "psf_min": smin,
        "psf_bound_n": n,
    }


def read_final(path: str | Path) -> dict[int, dict]:
    with open(path) as f:
        return {int(r["id"]): r for r in csv.DictReader(f, delimiter="\t")}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("footprints", nargs="+")
    ap.add_argument("--cell-diameter", type=float, default=10.0, help="the run's --cell-diameter (sets cala's smoothing)")
    ap.add_argument("--final", help="qc_eval final.tsv (sim): pair matched cells with their GT unit")
    ap.add_argument("--gt", help="the sim's oracle.bin, with --final")
    ap.add_argument("--alpha", type=float, default=0.05)
    ap.add_argument("--json", help="write the summaries here")
    args = ap.parse_args()
    smooth = max(args.cell_diameter / 10.0, 0.6)
    res = {}
    for p in args.footprints:
        (h, w), cells = read_footprints(p)
        m = measure_cells(cells, w, smooth)
        r = summarize(m, args.alpha)
        if args.final and args.gt:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import gt_scales  # noqa: PLC0415

            gt = gt_scales.measure_units(args.gt)
            fin = read_final(args.final)
            # `best_gt` indexes qc_eval's kept units (`gt.tsv` beside final.tsv, footprint
            # centroids); map each to the nearest oracle unit centre.
            gt_rows = list(csv.DictReader(open(Path(args.final).with_name("gt.tsv")), delimiter="\t"))
            units = list(gt.values())
            uc = np.array([[v["cy"], v["cx"]] for v in units])
            kept = {}
            for g in gt_rows:
                dist = np.hypot(uc[:, 0] - float(g["cy"]), uc[:, 1] - float(g["cx"]))
                j = int(np.argmin(dist))
                if dist[j] <= 3.0:
                    kept[int(g["gt"])] = units[j]
            ratio_d, ratio_e = [], []
            for cid, v in m.items():
                row = fin.get(cid)
                if row is None or row.get("matched") != "1":
                    continue
                u = kept.get(int(row["best_gt"]))
                if u is None:
                    continue
                ratio_d.append(v["d"] / u["d"])
                ratio_e.append(v["ring_dq"] / u["ring"])
            r["matched"] = len(ratio_d)
            r["d_ratio_matched"] = quant(ratio_d)
            r["ring_ratio_matched"] = quant(ratio_e)
        res[p] = r
        dq = r["d"]
        print(f"{p}: {r['cells']} cells")
        print(f"  D1 d median {r['d_median']:.2f} (95% CI {r['d_ci'][0]:.2f}-{r['d_ci'][1]:.2f}), q25 {dq['q25']:.2f} q75 {dq['q75']:.2f}")
        rq, eq = r["ring_dq"], r["edge_dq"]
        if rq.get("n"):
            print(f"  P1 ring s (smoothing {smooth:.2f} removed) n={rq['n']} min {rq['min']:.2f} q5 {rq['q5']:.2f} q10 {rq['q10']:.2f} med {rq['q50']:.2f}; bound {r['psf_bound']:.2f}")
        if eq.get("n"):
            print(f"  grad edge (smoothing removed) n={eq['n']} q10 {eq['q10']:.2f} med {eq['q50']:.2f}")
        if "matched" in r and r["matched"]:
            print(f"  matched {r['matched']}: d/d_gt median {r['d_ratio_matched']['q50']:.3f} (q25 {r['d_ratio_matched']['q25']:.3f}, q75 {r['d_ratio_matched']['q75']:.3f}); ring/ring_gt median {r['ring_ratio_matched'].get('q50', float('nan')):.3f}")
    if args.json:
        Path(args.json).write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
