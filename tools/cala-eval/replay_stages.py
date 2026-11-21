#!/usr/bin/env python
"""Where the cluster replay's fix is lost: per-stage values on a fixed set of GT neighbour pairs.

    python -I tools/cala-eval/replay_stages.py BASE_RUN RUN STAGES_TSV [--bins 0.5,1.0]

BASE_RUN: the main (flag-off) qc_eval run of the same sim, with demix_pairs.tsv (demix_metrics.py) and
  final.tsv; its bitten pairs (est/true at the neighbour's centre < 0.5) and healthy pairs (0.7-1.3) at
  the chosen distance bins are the fixed set. Cell ids are the same in every arm (pass 1 is identical
  and Refine freezes the cell set).
RUN: the replay run (its own demix_pairs.tsv gives the published ratio).
STAGES_TSV: `CALA_REPLAY_STAGES` rows (diagnostics build; `cluster.rs::dump_stages`), one per
  replay and ordered member pair (i, j).

For each pair, over the Refine pass's replays of its cluster: the share of replays ending at each
exit (none / lowsnr / conv / fnone / rej / acc), and at the last replay that reached the finish path
member i's value at c_j over its value at c_i after each step: the raw replay estimate, the smoothed
target, the PSF-smoothed light q (and q / tol, the significance), in S0, in X, the inverted light,
the new footprint (unfiltered and filtered) and the current one. Then the first step at which a
bitten pair's value at c_j is lost.
"""
import argparse
import csv
import math
import statistics as st
from collections import Counter, defaultdict
from pathlib import Path

EXITS = ("none", "lowsnr", "conv", "fnone", "rej", "acc")


def read(p):
    with open(p, newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def pair_set(run, lo, hi):
    """{(cell id i, GT unit j): (d_diam, ratio)} for matched neighbours j, plus cell id of each GT unit."""
    final = read(run / "final.tsv")
    id_of_slot = {int(r["slot"]): int(r["id"]) for r in final}
    unit_of = {int(r["gt"]): int(r["unit"]) for r in read(run / "gt.tsv")} if (run / "gt.tsv").exists() else {}
    cell_of_unit = {}
    for r in final:
        if r["matched"] == "1":
            g = int(r["best_gt"])
            cell_of_unit[unit_of.get(g, g)] = int(r["id"])
    out = {}
    for r in read(run / "demix_pairs.tsv"):
        d, t = float(r["d_diam"]), float(r["true_at_cj"])
        if not (lo <= d < hi) or t <= 0.05 or r.get("jmatched") != "1":
            continue
        i = id_of_slot.get(int(r["i"]))
        j = cell_of_unit.get(int(r["j"]))
        if i is None or j is None or i == j:
            continue
        out[(i, j)] = (d, float(r["est_at_cj"]) / t)
    return out


def ratio(a, b):
    return b / a if a > 0 and math.isfinite(a) and math.isfinite(b) else math.nan


def stage_values(p):
    """Member i's values at c_j over c_i at each finish-path step, from one stages row."""
    f = [float(x) for x in p[8:30]]
    indisk, r_rep = f[0], f[1]
    pi, pj = f[2:10], f[10:18]
    h, tgt, q, tol, s0, x, a, mask = range(8)
    return {
        "in_disk": indisk,
        "raw": r_rep,
        "h": ratio(pi[h], pj[h]),
        "target": ratio(pi[tgt], pj[tgt]),
        "q": ratio(pi[q], pj[q]),
        "q/tol": pj[q] / pj[tol] if pj[tol] > 0 else math.nan,
        "in_S0": pj[s0],
        "in_X": pj[x],
        "inverted": ratio(pi[a], pj[a]),
        "new_raw": f[18],
        "new_col": f[19],
        "cur_raw": f[20],
        "cur_col": f[21],
    }


def first_loss(v, exit_):
    """The first step at which member i's light at c_j is gone (bitten pairs)."""
    if exit_ in ("none", "lowsnr", "conv"):
        return f"exit:{exit_}"
    if v["in_disk"] < 0.5:
        return "c_j off i's statistics disk"
    if not (v["raw"] > 0.05):
        return "raw replay estimate ≤ 0.05"
    if exit_ == "fnone":
        return "finish path gave no footprint"
    if not (v["q/tol"] > 1.0):
        return "significance (q ≤ tol at c_j)"
    if v["in_S0"] < 0.5:
        return "single-peak basin (significant, not in S0)"
    if not (v["inverted"] > 0.05):
        return "inversion"
    if not (v["new_raw"] > 0.05):
        return "Cell::from_canvas (support cut)"
    if exit_ == "rej":
        return "gate rejected"
    return "kept (accepted)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", type=Path)
    ap.add_argument("run", type=Path)
    ap.add_argument("stages", type=Path)
    ap.add_argument("--bins", default="0.5,1.0")
    a = ap.parse_args()
    lo, hi = (float(x) for x in a.bins.split(","))
    base = pair_set(a.base, lo, hi)
    new = pair_set(a.run, lo, hi) if (a.run / "demix_pairs.tsv").exists() else {}
    rows = defaultdict(list)
    with open(a.stages) as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            key = (int(p[1]), int(p[2]))
            if key in base:
                rows[key].append(p)
    groups = {"bitten": [], "healthy": []}
    for key, (d, r) in base.items():
        g = "bitten" if r < 0.5 else ("healthy" if 0.7 <= r <= 1.3 else None)
        if g:
            groups[g].append(key)
    for g, keys in groups.items():
        seen = [k for k in keys if rows.get(k)]
        print(f"\n== {g} pairs at {lo}-{hi} D in main: {len(keys)}, with replay rows: {len(seen)}")
        ex = Counter()
        for k in seen:
            ex.update(p[5] for p in rows[k])
        tot = sum(ex.values()) or 1
        print("  replay exits (share of replays): " + ", ".join(f"{e} {ex[e] / tot:.2f}" for e in EXITS))
        vals = defaultdict(list)
        loss = Counter()
        pub = []
        for k in seen:
            fin = [p for p in rows[k] if p[5] in ("fnone", "rej", "acc")]
            last = fin[-1] if fin else rows[k][-1]
            v = stage_values(last)
            for n, x in v.items():
                if math.isfinite(x):
                    vals[n].append(x)
            loss[first_loss(v, last[5])] += 1
            if k in new:
                pub.append(new[k][1])
        print("  last finish-path replay, member i at c_j over c_i (median [IQR]):")
        for n, xs in vals.items():
            if xs:
                q = st.quantiles(xs, n=4) if len(xs) > 1 else [xs[0]] * 3
                print(f"    {n:9s} {st.median(xs):+.3f} [{q[0]:+.3f}, {q[2]:+.3f}]  n {len(xs)}")
        if pub:
            print(f"  published est/true in RUN: median {st.median(pub):.2f}, still < 0.5: {sum(x < 0.5 for x in pub) / len(pub):.2f}")
        print("  first loss step:")
        for s, c in loss.most_common():
            print(f"    {c:4d} ({c / max(len(seen), 1):.2f})  {s}")


if __name__ == "__main__":
    main()
