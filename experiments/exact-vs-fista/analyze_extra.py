"""Floor-mode 2/3 counterfactuals and the kernel-loop table (python3 analyze_extra.py)."""
import pandas as pd
import numpy as np

pd.set_option("display.width", 250)
pd.set_option("display.max_columns", 50)
pd.set_option("display.max_rows", 500)
d = pd.read_csv("sweep.csv")
d["fsl"] = d.fs.astype(int)
d["band"] = pd.cut(d.snr, [0, 6, 13, 100], labels=["lo(3-5)", "mid(8-12)", "hi(20-50)"])
d["key"] = d.ds + "#" + d.cell.astype(str)
fl = pd.read_csv("floor23.csv")
fl["key"] = fl.ds + "#" + fl.cell.astype(str)
for m in ["I2", "I3"]:
    x = fl[fl.m == m].set_index("key")
    for c in ["count", "f1", "off", "miss", "cap_limited"]:
        d[f"{m}_{c}"] = d.key.map(x[c])


def agg(g):
    tc = g.true_count.sum()
    o = {"cells": len(g)}
    for nm, pre in [("F0", "f"), ("I0", "i"), ("I2", "I2"), ("I3", "I3")]:
        o[f"{nm}_ratio"] = g[f"{pre}_count"].sum() / tc
        o[f"{nm}_f1"] = g[f"{pre}_f1"].mean()
    o["I2_cap%"] = 100 * g.I2_cap_limited.mean()
    o["I3_cap%"] = 100 * g.I3_cap_limited.mean()
    return pd.Series(o)


print("### mode 2 = event-span floor + argmin-E fallback; mode 3 = shipped floor + argmin-E fallback (Ipm)")
print(d.groupby(["preset", "fsl"]).apply(agg, include_groups=False).round(3).to_string())
print(d.groupby(["regime", "preset", "fsl"]).apply(agg, include_groups=False).round(3).to_string())
print(d.groupby(["preset", "fsl", "band"], observed=True).apply(agg, include_groups=False).round(3).to_string())

k = pd.read_csv("kernel.csv")
k["dtr"] = k.tau_r / k.mean_true_tau_r - 1
k["dtd"] = k.tau_d / k.mean_true_tau_d - 1
print("\n### kernel loop (per run)")
print(k.drop(columns=["trail"]).round(4).to_string())
k["f1"] = k.final_f1
k["ratio"] = k.final_count / k.true_count
k["conv"] = k.conv_at > 0
print("\n### kernel loop summary by regime/preset/method (mean over seeds x snr)")
print(
    k.groupby(["regime", "preset", "method"])
    .agg(
        runs=("f1", "size"),
        tau_r_err=("dtr", "mean"),
        tau_d_err=("dtd", "mean"),
        abs_tau_d_err=("dtd", lambda v: v.abs().mean()),
        iters=("iters", "mean"),
        conv=("conv", "mean"),
        f1=("f1", "mean"),
        ratio=("ratio", "mean"),
        wall_s=("wall_s", "mean"),
    )
    .round(3)
    .to_string()
)
print("\n### by snr")
print(
    k.groupby(["preset", "snr", "method"])
    .agg(
        tau_r_err=("dtr", "mean"),
        tau_d_err=("dtd", "mean"),
        iters=("iters", "mean"),
        conv=("conv", "mean"),
        f1=("f1", "mean"),
        ratio=("ratio", "mean"),
    )
    .round(3)
    .to_string()
)
