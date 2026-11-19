"""Summarise a CALA_MERGE_LOG (diagnostics build): accepted merges of cells on two different GT units, by clause."""
import json, sys
from collections import Counter
for path in sys.argv[1:]:
    rows = [json.loads(l) for l in open(path)]
    acc = [r for r in rows if r["accept"]]
    def two(r, thr=0.5):
        a, b = r["a"], r["b"]
        return a.get("gt", -1) >= 0 and b.get("gt", -1) >= 0 and a["gt"] != b["gt"] and a["gt_r"] >= thr and b["gt_r"] >= thr
    c = Counter()
    for r in acc:
        c[("false" if two(r) else "ok", "ovl>=.5" if r["ovl"] >= 0.5 else "ovl<.5", "one" if r["one"] else "chi2", "forced" if r["forced"] else "")] += 1
    print(path, "tests", len(rows), "accepted", len(acc))
    for k, v in sorted(c.items()):
        print("  ", k, v)
    rej = [r for r in rows if not r["accept"] and two(r)]
    print("  rejected two-unit tests:", len(rej), "ovl>=.5:", sum(r["ovl"] >= 0.5 for r in rej))
