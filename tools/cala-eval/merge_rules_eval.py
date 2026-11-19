"""Score candidate merge rules offline on merge_labels.py output.

Per unique (run, lo, hi) at overlap >= 0.5, a pair counts as merged under a rule
when any of its logged tests would be accepted. Classes: `dup` (same GT unit, merged
now: should stay merged), `harm` (different units, the gone cell's unit unmatched at
the end: should be blocked), `pairok` (different units merged without losing a unit).
Caveat: offline replays the logged trajectory; a blocked merge changes later tests.
Usage: merge_rules_eval.py LABELS.tsv
"""
import sys
import numpy as np
import pandas as pd

d = pd.read_csv(sys.argv[1], sep="\t")
d["arm"] = d.run.str.split("/").str[0]
d["kind"] = d.run.str.split("/").str[1].str.replace(r"_s\d+$", "", regex=True)
d["chi_acc"] = d.z > -2.0  # held-out test alone (merge_z = 2)

RULES = {
    "current": lambda t: t.accept == 1,
    "no-one": lambda t: (t.accept == 1) & t.chi_acc,
    "shape-gate": lambda t: (t.accept == 1) & ~(t["shape"] > 0),
    "no-one+shape": lambda t: (t.accept == 1) & t.chi_acc & ~(t["shape"] > 0),
}
EXTRA = {}  # filled by callers via exec of --rule "name=expr" (expr over t)
for a in sys.argv[2:]:
    k, e = a.split("=", 1)
    RULES[k] = eval("lambda t: (t.accept == 1) & (" + e + ")")

g = d.groupby(["run", "lo", "hi"])
pairs = g.agg(lab=("lab", "last"), harm=("harm", "max"), acc=("accept", "max"), arm=("arm", "first"),
              kind=("kind", "first")).reset_index()
pairs["cls"] = np.where(pairs.lab == "dup", "dup", np.where(pairs.harm == 1, "harm",
                        np.where((pairs.lab == "pair") & (pairs.acc == 1), "pairok", "other")))
out = []
for name, f in RULES.items():
    d["_r"] = f(d)
    m = d.groupby(["run", "lo", "hi"])._r.max().reset_index()
    p = pairs.merge(m, on=["run", "lo", "hi"])
    p = p[(p.acc == 1)]
    for (kind, cls), q in p.groupby(["kind", "cls"]):
        out.append(dict(rule=name, kind=kind, cls=cls, n=len(q), still_merged=int(q._r.sum())))
t = pd.DataFrame(out).pivot_table(index="rule", columns=["kind", "cls"], values="still_merged", aggfunc="sum")
n = pd.DataFrame(out).groupby(["kind", "cls"]).n.first()
print("pairs merged now (n):")
print(n.to_string())
print("\nstill merged under each rule (want dup = n, harm = 0):")
print(t.to_string())
