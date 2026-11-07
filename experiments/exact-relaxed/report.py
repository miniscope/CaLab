"""Markdown tables for NOTES-exact-relaxed.md from experiments/exact-relaxed/data.

usage: python3 report.py   (run from the repo root)
Labels: F0 shipped FISTA (frame floor, floor fallback); I0..I5 interior point with
pick rule mode 0..5 (see event_mass.rs `DEFAULT_MODE`). Default shipped now = I3.
"""
import sys

import pandas as pd

sys.path.insert(0, "experiments/exact-relaxed")
import analyze as A  # noqa: E402

D = "experiments/exact-relaxed/data/"
ORDER = ["F0", "I0", "I1", "I2", "I3", "I4", "I5"]


def md(t, nd=3):
    t = t.copy()
    cols = [c for c in ORDER if c in t.columns]
    t = t[cols]
    idx = t.index.to_frame(index=False) if isinstance(t.index, pd.MultiIndex) else t.index.to_frame(index=False)
    head = list(idx.columns) + cols
    out = ["| " + " | ".join(map(str, head)) + " |", "|" + "---|" * len(head)]
    for (_, r), (_, v) in zip(idx.iterrows(), t.iterrows()):
        out.append("| " + " | ".join(map(str, r.tolist())) + " | " + " | ".join("" if pd.isna(x) else f"{x:.{nd}f}" for x in v) + " |")
    return "\n".join(out)


def tables(files, tag):
    df = A.load([D + f for f in files])
    df = df[df.m.isin(ORDER)]
    ag = lambda keys: df.groupby(keys + ["m"]).apply(A.agg, include_groups=False)
    print(f"\n### {tag}: pooled over all cells\n")
    t = ag(["all"])
    for c, nd in (("f1", 3), ("ratio", 2), ("cap%", 1), ("nofit%", 1)):
        print(f"{c}:\n")
        print(md(t[c].unstack("m"), nd) + "\n")
    for keys, name in ((["regime", "preset", "fs"], "regime x preset x fs"), (["preset", "fs"], "preset x fs (regimes pooled)")):
        t = ag(keys)
        for c, nd in (("f1", 3), ("ratio", 2), ("cap%", 0)):
            print(f"\n#### {tag} {c} by {name}\n")
            print(md(t[c].unstack("m"), nd))
    print(f"\n#### {tag} SNR bands (lo 3-5, mid 8-12, hi 20-50), F1 and count ratio, preset x fs x band, regimes pooled\n")
    t = ag(["preset", "fs", "band"])
    print("F1\n")
    print(md(t["f1"].unstack("m")))
    print("\ncount ratio\n")
    print(md(t["ratio"].unstack("m"), 2))
    sub = df[df.regime == "markov"]
    t = sub.groupby(["preset", "fs", "band", "m"]).apply(A.agg, include_groups=False)
    print(f"\n#### {tag} markov regime only, F1 by preset x fs x band\n")
    print(md(t["f1"].unstack("m")))
    ipm = df[df.m.str.startswith("I")]
    print(f"\nIpm solves: {len(ipm)}; FISTA fallback fired in {int(ipm.fb.sum())} ({int(ipm[ipm.m == 'I0'].fb.sum())} distinct cells)")


if __name__ == "__main__":
    tables(["ipm300.csv.gz", "fista300.csv.gz", "ipm300_45.csv.gz"], "rate 300")
    tables(["ipm100.csv.gz", "ipm100_45.csv.gz"], "rate 100, 30 Hz datasets")
