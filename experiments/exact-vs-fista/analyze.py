"""Tables for NOTES-exact-vs-fista.md from sweep.csv (python3 analyze.py sweep.csv)."""
import sys
import numpy as np
import pandas as pd

pd.set_option("display.width", 250)
pd.set_option("display.max_columns", 50)
pd.set_option("display.max_rows", 500)
d = pd.read_csv(sys.argv[1] if len(sys.argv) > 1 else "sweep.csv")
d["band"] = pd.cut(d.snr, [0, 6, 13, 100], labels=["lo(3-5)", "mid(8-12)", "hi(20-50)"])
d["fsl"] = d.fs.astype(int)
P = ["f", "i"]


def agg(g):
    o = {"cells": len(g), "true": g.true_count.sum()}
    for p in P:
        o[f"{p}_ratio"] = g[f"{p}_count"].sum() / max(g.true_count.sum(), 1)
        o[f"{p}_f1"] = g[f"{p}_f1"].mean()
        o[f"{p}_pve"] = g[f"{p}_pve"].mean()
    o["dF1"] = o["i_f1"] - o["f_f1"]
    o["dRatio"] = o["i_ratio"] - o["f_ratio"]
    o["same%"] = 100 * g.same.mean()
    o["f_ms"] = g.f_ms.mean()
    o["i_ms"] = g.i_ms.mean()
    return pd.Series(o)


def show(title, df, keys):
    print(f"\n### {title}")
    print(df.groupby(keys, observed=True).apply(agg, include_groups=False).round(3).to_string())


show("per dataset", d, ["ds"])
show("regime x preset x fs", d, ["regime", "preset", "fsl"])
show("preset x fs", d, ["preset", "fsl"])
show("preset x fs x SNR band", d, ["preset", "fsl", "band"])
show("regime x preset x fs x SNR band (30 Hz)", d[d.fsl == 30], ["regime", "preset", "band"])
show("pooled by SNR (30 Hz)", d[d.fsl == 30], ["preset", "snr"])


def diag(g):
    o = {"cells": len(g), "true": g.true_count.sum()}
    for p in P:
        tc = max(g.true_count.sum(), 1)
        o[f"{p}_n_ev/cell"] = g[f"{p}_n_ev"].mean()
        o[f"{p}_live"] = g[f"{p}_n_live"].mean()
        o[f"{p}_medEv"] = g[f"{p}_med_ev"].median()
        o[f"{p}_lenLive"] = g[f"{p}_len_live"].mean()
        o[f"{p}_pos"] = g[f"{p}_n_pos"].mean()
        o[f"{p}_crumb%"] = 100 * g[f"{p}_crumb_mass"].sum() / g[f"{p}_mass"].sum()
        o[f"{p}_tinyfr%"] = 100 * g[f"{p}_tiny_frames"].sum() / max(g[f"{p}_n_pos"].sum(), 1)
        o[f"{p}_off/true"] = g[f"{p}_off"].sum() / tc
        o[f"{p}_miss/true"] = g[f"{p}_miss"].sum() / tc
        o[f"{p}_capLim%"] = 100 * g[f"{p}_cap_limited"].mean()
        o[f"{p}_noFit%"] = 100 * g[f"{p}_no_size_fit"].mean()
        o[f"{p}_a/floor"] = g[f"{p}_a_over_floor"].median()
        o[f"{p}_iters"] = g[f"{p}_iters"].mean()
    o["evcount_eq%"] = 100 * g.ev_match.mean()
    return pd.Series(o)


def showd(title, df, keys):
    print(f"\n### {title}")
    t = df.groupby(keys, observed=True).apply(diag, include_groups=False).round(3)
    print(t.T.to_string())


showd("diagnostics preset x fs x band", d, ["preset", "fsl", "band"])
showd("diagnostics (markov, 30 Hz) preset x band", d[(d.regime == "markov") & (d.fsl == 30)], ["preset", "band"])

# counterfactual variants
if "iz1_count" in d.columns:
    print("\n### Ipm counterfactuals (edit relaxed masses before binarization)")

    def var(g):
        o = {"cells": len(g)}
        tc = max(g.true_count.sum(), 1)
        o["F_ratio"] = g.f_count.sum() / tc
        o["F_f1"] = g.f_f1.mean()
        o["I_ratio"] = g.i_count.sum() / tc
        o["I_f1"] = g.i_f1.mean()
        for v in ["iz1", "iz5", "ie5"]:
            o[f"{v}_ratio"] = g[f"{v}_count"].sum() / tc
            o[f"{v}_f1"] = g[f"{v}_f1"].mean()
            o[f"{v}_nev"] = g[f"{v}_n_ev"].mean()
        o["I_nev"] = g.i_n_ev.mean()
        o["F_nev"] = g.f_n_ev.mean()
        return pd.Series(o)

    print(d.groupby(["preset", "fsl", "band"], observed=True).apply(var, include_groups=False).round(3).to_string())

# worst cells
d["dF1"] = d.i_f1 - d.f_f1
print("\n### correlation of dF1 with deltas (gcamp6s 30 Hz, all regimes)")
g = d[(d.preset == "gcamp6s") & (d.fsl == 30)].copy()
for nm, a, b in [
    ("d n_ev", "i_n_ev", "f_n_ev"),
    ("d n_live", "i_n_live", "f_n_live"),
    ("d crumb_mass", "i_crumb_mass", "f_crumb_mass"),
    ("d tiny_frames", "i_tiny_frames", "f_tiny_frames"),
    ("d a/floor", "i_a_over_floor", "f_a_over_floor"),
    ("d count", "i_count", "f_count"),
    ("d off", "i_off", "f_off"),
    ("d miss", "i_miss", "f_miss"),
    ("d len_live", "i_len_live", "f_len_live"),
    ("d med_ev", "i_med_ev", "f_med_ev"),
]:
    print(f"{nm:16s} corr with dF1: {np.corrcoef(g[a] - g[b], g.dF1)[0, 1]:+.3f}")

# ---- mechanism: spike-size floor (frame_max / cap) vs event masses ----
if "f_a_pick" in d.columns:
    print("\n### count decomposition (event-mass count, placement ignored)")

    def mech(g):
        o = {"cells": len(g)}
        o["a_I/a_F med"] = (g.i_a_pick / g.f_a_pick).median()
        o["fmax_I/F med"] = (g.i_frame_max / g.f_frame_max).median()
        o["mass_I/F med"] = (g.i_mass_abs / g.f_mass_abs).median()
        o["peakshare F"] = g.f_peak_share.mean()
        o["peakshare I"] = g.i_peak_share.mean()
        o["cnt F"] = g.f_count.sum()
        o["cnt I"] = g.i_count.sum()
        o["I/F"] = g.i_count.sum() / g.f_count.sum()
        o["I@aF/F"] = g.i_cnt_at_aF.sum() / g.f_count.sum()
        o["I/F@aI"] = g.i_count.sum() / g.f_cnt_at_aI.sum()
        return pd.Series(o)

    for nm, sel in [("markov", d.regime == "markov"), ("all regimes", d.regime != "")]:
        print(f"\n[{nm}]")
        print(d[sel].groupby(["preset", "fsl", "band"], observed=True).apply(mech, include_groups=False).round(3).to_string())
    g = d[(d.preset == "gcamp6s") & (d.fsl == 30)].copy()
    g["la"] = np.log(g.i_a_pick / g.f_a_pick)
    g["lf"] = np.log(g.i_frame_max / g.f_frame_max)
    g["lm"] = np.log(g.i_mass_abs / g.f_mass_abs)
    print("\ncorr(dF1, log a ratio) %.3f  corr(dF1, log fmax ratio) %.3f  corr(dF1, log mass ratio) %.3f" % (
        np.corrcoef(g.dF1, g.la)[0, 1], np.corrcoef(g.dF1, g.lf)[0, 1], np.corrcoef(g.dF1, g.lm)[0, 1]))
    print("corr(dCount/true, log a ratio) %.3f" % np.corrcoef((g.i_count - g.f_count) / g.true_count, g.la)[0, 1])

# ---- timing totals (sum of per-solve wall ms measured inside 16 worker threads) ----
print("\n### timing totals: summed per-solve ms (s) over all cells")
tt = d.groupby(["preset", "fsl"]).agg(cells=("f_ms", "size"), fista_s=("f_ms", lambda v: v.sum() / 1e3), ipm_s=("i_ms", lambda v: v.sum() / 1e3))
tt["speedup"] = tt.fista_s / tt.ipm_s
print(tt.round(2).to_string())
print("TOTAL fista %.0f s, ipm %.0f s, speedup %.2fx" % (d.f_ms.sum() / 1e3, d.i_ms.sum() / 1e3, d.f_ms.sum() / d.i_ms.sum()))

# ---- floor counterfactual ----
import os

fp = os.path.join(os.path.dirname(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "sweep.csv")), "floor.csv")
if os.path.exists(fp):
    fl = pd.read_csv(fp)
    d["key"] = d.ds + "#" + d.cell.astype(str)
    fl["key"] = fl.ds + "#" + fl.cell.astype(str)
    out = []
    for m, pre in [("I1", "i1"), ("F1", "f1x")]:
        x = fl[fl.m == m].set_index("key")
        for c in ["count", "f1", "off", "miss", "cap_limited", "a_over_floor", "ms"]:
            d[f"{pre}_{c}"] = d.key.map(x[c])
    print("\n### event-span floor (floor = max_e mass_e / (cap * len_e)) vs shipped floor (frame_max / cap)")

    def fl_agg(g):
        tc = max(g.true_count.sum(), 1)
        o = {"cells": len(g)}
        for nm, pre in [("F0", "f"), ("I0", "i"), ("F1", "f1x"), ("I1", "i1")]:
            if f"{pre}_count" not in g.columns or g[f"{pre}_count"].isna().all():
                continue
            c = g[f"{pre}_count"] if pre not in ("f", "i") else g[f"{pre}_count"]
            o[f"{nm}_ratio"] = c.sum() / tc
            o[f"{nm}_f1"] = g[f"{pre}_f1"].mean()
        o["I0_off"] = g.i_off.sum() / tc
        o["I1_off"] = g.i1_off.sum() / tc
        o["I0_miss"] = g.i_miss.sum() / tc
        o["I1_miss"] = g.i1_miss.sum() / tc
        o["I0_cap%"] = 100 * g.i_cap_limited.mean()
        o["I1_cap%"] = 100 * g.i1_cap_limited.mean()
        return pd.Series(o)

    print(d.groupby(["preset", "fsl"], observed=True).apply(fl_agg, include_groups=False).round(3).to_string())
    print(d.groupby(["preset", "fsl", "band"], observed=True).apply(fl_agg, include_groups=False).round(3).to_string())
    print("\n[gcamp6s by regime]")
    print(d[d.preset == "gcamp6s"].groupby(["regime", "fsl"], observed=True).apply(fl_agg, include_groups=False).round(3).to_string())
    print("\n[jgcamp8f by regime]")
    print(d[d.preset == "jgcamp8f"].groupby(["regime", "fsl"], observed=True).apply(fl_agg, include_groups=False).round(3).to_string())
