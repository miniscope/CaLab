"""Follow-up to match_diff.py: swaps vs two-to-one collapses, and whether the arm with two cells has two real traces."""
import sys
from pathlib import Path
import numpy as np, pandas as pd
sys.argv = sys.argv[:1]
exec(open(Path(__file__).with_name("match_diff.py")).read().split("rows = []")[0])
d = pd.read_csv(Path.home() / "Projects/cala-data/demix-suite/discloss/classify.tsv", sep="\t")
c = d[(d.cls == "c:conflict") & d.y_cell_matched_to.notna()]
keys = {(r.sim, r.dir, int(r.g), int(r.y_cell_matched_to)) for r in c.itertuples()}
swap = {(s, dr, g, nb) for (s, dr, g, nb) in keys if (s, "gained" if dr == "lost" else "lost", nb, g) in keys}
out = []
for s in c.sim.unique():
    ra, rb = ROOT / A / s, ROOT / B / s
    h, w, units, Ct = DM.read_oracle(simdir(s) / "oracle.bin")
    gt = tsv(ra / "gt.tsv"); gtu = [int(float(r["unit"])) for r in gt]
    G = np.stack([DM.dense_patch(units[u]["full"], h, w).ravel() for u in gtu])
    arms = {}
    for nm, rr in (("main", ra), ("rep", rb)):
        L = load(rr, h, w, G, gtu)
        L["tr"] = np.fromfile(rr / "dump_trace.f32", "<f4").reshape(-1, len(L["cells"])).T.astype(np.float64)
        arms[nm] = L
    T = arms["main"]["tr"].shape[1]
    hp = lambda x: DM.highpass(x[None, :])[0] if hasattr(DM, "highpass") else x
    for r in c[c.sim == s].itertuples():
        X = arms["main"] if r.dir == "lost" else arms["rep"]
        g, nb = int(r.g), int(r.y_cell_matched_to)
        if nb not in X["matched"]:
            continue
        cg, cn = X["matched"][g], X["matched"][nb]
        tg, tn = Ct[gtu[g], :T].astype(np.float64), Ct[gtu[nb], :T].astype(np.float64)
        cr = lambda a, b: float(np.corrcoef(hp(a), hp(b))[0, 1])
        out.append(dict(sim=s, dir=r.dir, g=g, nb=nb, swap=(s, r.dir, g, nb) in swap,
                        own_g=cr(X["tr"][cg], tg), cross_g=cr(X["tr"][cg], tn),
                        own_nb=cr(X["tr"][cn], tn), cross_nb=cr(X["tr"][cn], tg), true_gn=cr(tg, tn)))
o = pd.DataFrame(out)
print("conflicts with neighbour matched:", c.groupby("dir").size().to_dict(), " swaps:", len(swap))
print("two-cell side (lost: main has both; gained: replay has both), excluding swaps:")
print(o.groupby("dir")[["own_g", "cross_g", "own_nb", "cross_nb", "true_gn"]].median().round(3).to_string())
print("share own_g > cross_g + 0.2:", o.assign(ok=o.own_g > o.cross_g + 0.2).groupby("dir").ok.mean().round(2).to_dict())
