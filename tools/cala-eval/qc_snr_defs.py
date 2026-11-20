"""QC SNR definitions vs truth on a `qc_eval --dump` run (signed-trace build).
usage: qc_snr_defs.py RUN [fps]   (real runs: Minian agreement as the reference)"""
import os
import sys

import numpy as np
import pandas as pd
from scipy.stats import spearmanr, rankdata

run = sys.argv[1]
fps = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
MAD = 0.6744897501960817
W = 1200  # QcConfig::default().window_frames

fin = pd.read_csv(f"{run}/final.tsv", sep="\t")
n = len(fin)
clip = np.fromfile(f"{run}/dump_trace.f32", "<f4")
T = clip.size // n
clip = clip.reshape(T, n)
signed = np.fromfile(f"{run}/dump_signed.f32", "<f4").reshape(T, n)
cells = pd.read_csv(f"{run}/cells.tsv", sep="\t")
p1 = cells[cells.frame == cells.frame.max()].set_index("id")
p2 = pd.read_csv(f"{run}/cells_pass2.tsv", sep="\t").set_index("id")
is_sim = os.path.exists(f"{run}/gt.tsv")


def top_minus_med(x):
    k = max(len(x) // 100, 3)
    s = np.sort(x)
    return s[-k:].mean() - np.median(x)


def med_hi(v):
    """Rust's median_inplace: the element at len/2 (upper median)."""
    return np.partition(v, len(v) // 2)[len(v) // 2]


def rust_stat(x, tol, ms):
    x = x.astype(np.float32)
    d = np.abs(np.diff(x))
    d = d[~((x[:-1] <= tol) & (x[1:] <= tol))]
    sg = med_hi(d) / np.float32(MAD) / np.float32(np.sqrt(2)) if d.size >= 8 else np.nan
    if not sg > 0:
        sg = ms
    k = max(len(x) // 100, 3)
    return (np.sort(x)[-k:].astype(np.float64).mean() - med_hi(x)) / sg


def sig_skip(x, tol):
    d = np.abs(np.diff(x))
    keep = ~((x[:-1] <= tol) & (x[1:] <= tol))
    d = d[keep]
    return np.median(d) / MAD / np.sqrt(2) if d.size >= 8 else np.nan


def sig_all(x):
    return np.median(np.abs(np.diff(x))) / MAD / np.sqrt(2)


def detrend(x, fs, win_s=60.0, q=0.2):
    """Centred rolling 20th percentile over 60 s (block approximation: the
    quantile of each window centred on a 1-s grid, linearly interpolated)."""
    w = int(round(win_s * fs))
    if w < 2 or w >= len(x):
        return x
    step = max(int(fs), 1)
    cs = np.arange(0, len(x), step)
    b = np.array([np.quantile(x[max(c - w // 2, 0):c + w // 2], q) for c in cs])
    return x - np.interp(np.arange(len(x)), cs, b)


rows = []
for s in range(n):
    cid = int(fin.id[s])
    ms = float(p2.model_sigma.get(cid, np.nan))
    tol = 0.01 * ms
    c, g = clip[:, s].astype(np.float64), signed[:, s].astype(np.float64)
    r = dict(slot=s, id=cid, model_sigma=ms)
    r["a_disc"] = p1.peak_snr.get(cid, np.nan)  # app: Discover end, last 60 s
    r["a_ext"] = p2.peak_snr.get(cid, np.nan)  # same window at end of Extract
    cw = c[-W:]
    sw = sig_skip(cw, tol)
    # identity check: the monitor refreshes round-robin (each cell at most
    # refresh_frames = 100 frames before the end), so match the best end offset
    best = np.inf
    for k in range(0, 121):
        e = T - k
        v = rust_stat(c[e - W:e], np.float32(tol), ms)
        if abs(v - r["a_ext"]) < abs(best - r["a_ext"]):
            best = v
    r["a_ext_py"] = best
    sb = sig_skip(c, tol)
    r["sig_skip_full"] = sb
    r["b_full"] = top_minus_med(c) / (sb if sb > 0 else ms)
    r["sig_all_clip"] = sig_all(c)
    sg = sig_all(g)
    r["sig_signed"] = sg
    r["c_clip_sigsigned"] = top_minus_med(c) / sg
    r["c_signed"] = top_minus_med(g) / sg
    r["c_signed_win"] = top_minus_med(g[-W:]) / sig_all(g[-W:])
    r["c_signed_lab"] = top_minus_med(detrend(g, fps)) / sg  # CaLab measured_snr
    r["c_model"] = top_minus_med(c) / ms
    r["zero_frac"] = float((c <= tol).mean())
    rows.append(r)
df = pd.DataFrame(rows)
df["inflate"] = df.sig_skip_full / df.sig_signed

DEFS = ["a_disc", "a_ext", "b_full", "c_clip_sigsigned", "c_signed", "c_signed_win", "c_signed_lab", "c_model"]


def auc(score, lab):
    ok = np.isfinite(score)
    s, l = score[ok], lab[ok]
    if l.sum() == 0 or (~l).sum() == 0:
        return np.nan
    rk = rankdata(s)
    return (rk[l].sum() - l.sum() * (l.sum() + 1) / 2) / (l.sum() * (~l).sum())


print(f"run {run}: {n} cells x {T} frames")
rel = np.abs(df.a_ext - df.a_ext_py) / np.maximum(df.a_ext.abs(), 1)
print("identity a_ext vs python (best refresh offset): max rel %.2e, cells > 1e-4: %d" % (np.nanmax(rel), int((rel > 1e-4).sum())))
if is_sim:
    sg = pd.read_csv(f"{run}/traces_signed_gt.tsv", sep="\t")
    gt = pd.read_csv(f"{run}/gt.tsv", sep="\t").set_index("gt")
    df = df.merge(sg[["id", "gt", "r_clipped", "r_signed"]], on="id", how="left")
    df["matched"] = fin.matched.values.astype(bool)
    df["gt_snr"] = [gt.snr.get(int(g), np.nan) for g in fin.best_gt]
    lab, rr = df.matched.values, df.r_clipped.values
    ref = "GT-matched"
else:
    mr = pd.read_csv(f"{run}/minian.tsv", sep="\t")
    df = df.merge(mr, on="id", how="left")
    lab, rr = (df.mr >= 0.5).values, df.minian_tr.values
    ref = "Minian fp r>=.5"
out = []
for d in DEFS:
    v = df[d].values
    ok = np.isfinite(v) & np.isfinite(rr)
    row = dict(defn=d, median=np.nanmedian(v), pass5=int((v >= 5).sum()), auc=auc(v, lab),
               rho_r=spearmanr(v[ok], rr[ok]).correlation)
    if is_sim:
        m = lab & np.isfinite(v) & np.isfinite(df.gt_snr.values)
        row["rho_gtsnr_tp"] = spearmanr(v[m], df.gt_snr.values[m]).correlation
        row["pass5_fp"] = int(((v >= 5) & ~lab).sum())
        row["pass5_tp"] = int(((v >= 5) & lab).sum())
    out.append(row)
res = pd.DataFrame(out)
print(f"reference: {ref}; {int(lab.sum())} of {n}")
print(res.round(3).to_string(index=False))
base = df.a_disc >= 5
for d in DEFS[1:]:
    p = df[d] >= 5
    print(f"flips vs a_disc -> {d}: fail->pass {int((~base & p).sum())}, pass->fail {int((base & ~p).sum())}")
print("sigma inflation (skip-zero full / signed): median %.2f, p10 %.2f, p90 %.2f" % tuple(np.nanquantile(df.inflate, [.5, .1, .9])))
print("rho(inflation, zero_frac) = %.2f" % spearmanr(df.inflate, df.zero_frac, nan_policy="omit").correlation)
# Window effect on a clean cell: a_disc vs b_full among reference-good cells
good = lab & (rr >= 0.8)
print(f"good cells (ref & r>=.8): {int(good.sum())}; fail a_disc {int((good & (df.a_disc < 5)).sum())}, fail b_full {int((good & (df.b_full < 5)).sum())}, fail c_signed {int((good & (df.c_signed < 5)).sum())}, fail c_signed_lab {int((good & (df.c_signed_lab < 5)).sum())}")
for d in ["a_disc", "b_full", "c_signed", "c_signed_lab", "c_model"]:
    v = df[d].values
    ths = np.unique(np.nanquantile(v, np.linspace(0, 1, 201)))
    j = [((v >= t) & lab).sum() / lab.sum() - ((v >= t) & ~lab).sum() / max((~lab).sum(), 1) for t in ths]
    t = ths[int(np.argmax(j))]
    print(f"  {d}: Youden threshold {t:.1f} (J {max(j):.2f}); ref-negative median {np.nanmedian(v[~lab]):.1f}, ref-positive p10 {np.nanquantile(v[lab], .1):.1f}")
df.to_csv(f"{run}/snr_defs.tsv", sep="\t", index=False)
res.to_csv(f"{run}/snr_summary.tsv", sep="\t", index=False)
