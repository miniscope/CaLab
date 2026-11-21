#!/usr/bin/env python
"""Which cells does one arm have that another does not (concurrent settle, round 3)?

    python tools/cala-eval/concsettle3_cells.py --base V30=DIR1,DIR2,DIR3 --arm CS2F=DIR1,DIR2,DIR3 \
        [--arm CS2=...] [--minian MINIAN_OUT] [--tag settle0] --md OUT.md [--tsv OUT.tsv]

Run directories are listed per arm in seed order. Libraries are matched as `lookback_settled.py` does it (Hungarian
on whole-frame footprint Pearson r, a match at r >= 0.7).

For every seed the base library is matched to the arm's library of the same seed; a cell without a match is
"base only" or "arm only". Two baseline runs with different seeds also disagree on many cells, so the same is done
between base seeds (the null): only what differs from the null is an effect of the arm. A "core" one-sided cell is
one that at least two base seeds have and no arm seed has (or the reverse).

Per group it reports the birth time, the QC monitor's peak z and transient count at the end of the stream, the
held-out marginal z, footprint radius, neighbours and overlap (the last `cells.tsv` row), the share on probation,
the share that matches a Minian unit (agreement with a reference that has wrong and missing cells; not recall), and
what the other run did at the same place (a cell there with another shape, a cell added there and merged or deleted,
never added).
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_metrics as DM  # noqa: E402
import lookback_settled as LS  # noqa: E402

NEAR_PX = 4.0  # "the same place": centres closer than this


def pearson(A, B):
    N = A.shape[1]

    def mom(X):
        m = np.asarray(X.sum(1)).ravel() / N
        s = np.sqrt(np.maximum(np.asarray(X.multiply(X).sum(1)).ravel() / N - m * m, 0)) + 1e-12
        return m, s

    ma, sa = mom(A)
    mb, sb = mom(B)
    return (np.asarray((A @ B.T).todense()) / N - np.outer(ma, mb)) / np.outer(sa, sb)


def match(R, thresh=DM.MATCH_R):
    """Per row the matched column or -1, and per column the matched row or -1."""
    ri, ci = linear_sum_assignment(-R)
    a = np.full(R.shape[0], -1)
    b = np.full(R.shape[1], -1)
    ok = R[ri, ci] >= thresh
    a[ri[ok]] = ci[ok]
    b[ci[ok]] = ri[ok]
    return a, b


class Run:
    def __init__(self, d: Path, tag: str):
        self.dir = d
        h, w, ids, cells, _ = DM.read_library(LS.lib_path(d, tag))
        self.h, self.w, self.ids = h, w, np.array(ids)
        self.csr = LS.to_csr(cells, h * w)
        cen = []
        for idx, val in cells:
            v = np.maximum(val, 0)
            s = v.sum() or 1.0
            cen.append(((idx // w) @ v / s, (idx % w) @ v / s))
        self.cen = np.array(cen)
        self.area = np.array([(v > 0).sum() for _, v in cells])
        fin = {int(r["id"]): r for r in DM.read_tsv(d / f"final_{tag}.tsv")}
        last = {}
        rows = DM.read_tsv(d / "cells.tsv")
        end = max(int(float(r["frame"])) for r in rows)
        for r in rows:
            if int(float(r["frame"])) == end:
                last[int(float(r["id"]))] = r
        self.adds = [(int(r["recording_frame"]), int(r["id"]), float(r["cy"]), float(r["cx"]), r["class"])
                     for r in DM.read_tsv(d / "adds.tsv")]  # fmt: skip
        self.rems = [(int(r["recording_frame"]), int(r["id"]), float(r["cy"]), float(r["cx"]), r["kind"])
                     for r in DM.read_tsv(d / "removals.tsv")]  # fmt: skip
        born = {}
        for f, i, *_ in self.adds:
            born.setdefault(i, f)

        def col(src, key, i):
            r = src.get(int(i))
            try:
                return float(r[key]) if r is not None else math.nan
            except (KeyError, ValueError):
                return math.nan

        self.f = {
            "born": np.array([born.get(int(i), math.nan) for i in self.ids]),
            "peak_z": np.array([col(fin, "peak_z", i) for i in self.ids]),
            "transients": np.array([col(fin, "transients", i) for i in self.ids]),
            "ho_z": np.array([col(fin, "ho_marginal_z", i) for i in self.ids]),
            "probation": np.array([1.0 if fin.get(int(i), {}).get("status") == "probation" else 0.0 for i in self.ids]),
            "peak_snr": np.array([col(last, "peak_snr", i) for i in self.ids]),
            "radius": np.array([col(last, "fp_radius_px", i) for i in self.ids]),
            "neighbours": np.array([col(last, "n_neighbours", i) for i in self.ids]),
            "overlap": np.array([col(last, "max_overlap", i) for i in self.ids]),
            "neighbour_r": np.array([col(last, "max_neighbour_r", i) for i in self.ids]),
            "area": self.area.astype(float),
        }

    def fate_of(self, cy, cx, R_row):
        """What this run did at (cy, cx), where another run has a cell this one has no match for."""
        d = np.hypot(self.cen[:, 0] - cy, self.cen[:, 1] - cx)
        if d.min() < NEAR_PX:
            return "cell there, other shape"
        near_add = [a for a in self.adds if math.hypot(a[2] - cy, a[3] - cx) < NEAR_PX]
        near_rem = [r for r in self.rems if math.hypot(r[2] - cy, r[3] - cx) < NEAR_PX]
        if near_rem:
            kinds = {r[4] for r in near_rem}
            return "added there, merged away" if "merge" in kinds else "added there, deleted"
        if near_add:
            return "added there, moved"
        if R_row.max() >= 0.3:
            return "never added; a neighbour holds its light (r >= 0.3)"
        return "never added"


def summarize(name, runs_idx, feats, minian, fates=None):
    """One table row for a group: a list of (Run, cell indices)."""
    n = sum(len(ix) for _, ix in runs_idx)
    if n == 0:
        return f"| {name} | 0 |" + " |" * (len(feats) + 2)
    cells = [f"{n / len(runs_idx):.1f}"]
    for k in feats:
        v = np.concatenate([r.f[k][ix] for r, ix in runs_idx])
        v = v[np.isfinite(v)]
        if k == "probation":
            cells.append(f"{100 * v.mean():.0f} %" if len(v) else "n/a")
        elif len(v):
            cells.append(f"{np.median(v):.3g} [{np.percentile(v, 25):.3g}, {np.percentile(v, 75):.3g}]")
        else:
            cells.append("n/a")
    if minian is not None:
        m = np.concatenate([minian[id(r)][ix] for r, ix in runs_idx])
        cells.append(f"{100 * m.mean():.0f} %")
    else:
        cells.append("n/a")
    if fates:
        tot = sum(fates.values())
        cells.append("; ".join(f"{k} {100 * v / tot:.0f} %" for k, v in sorted(fates.items(), key=lambda kv: -kv[1])))
    else:
        cells.append("")
    return f"| {name} | " + " | ".join(cells) + " |"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, help="NAME=DIR,DIR,... (seed order)")
    ap.add_argument("--arm", action="append", required=True, help="NAME=DIR,DIR,...")
    ap.add_argument("--minian", type=Path)
    ap.add_argument("--tag", default="settle0")
    ap.add_argument("--md", type=Path)
    ap.add_argument("--tsv", type=Path, help="one row per one-sided cell")
    a = ap.parse_args(argv)

    def load(spec):
        name, dirs = spec.split("=", 1)
        return name, [Run(Path(d), a.tag) for d in dirs.split(",")]

    bname, base = load(a.base)
    arms = [load(s) for s in a.arm]
    allruns = base + [r for _, rs in arms for r in rs]
    minian = None
    if a.minian:
        M = LS.read_minian(a.minian, base[0].h * base[0].w, base[0].w)
        minian = {}
        for r in allruns:
            am, _ = match(pearson(r.csr, M))
            minian[id(r)] = (am >= 0).astype(float)
    feats = ["born", "peak_z", "transients", "ho_z", "probation", "peak_snr", "radius", "area", "neighbours", "overlap", "neighbour_r"]  # fmt: skip
    head = "| group | cells per run | " + " | ".join(feats) + " | matches a Minian unit | what the other run did there |"
    sep = "|" + " --- |" * (len(feats) + 4)
    L = [f"Libraries: `{a.tag}`. Median [IQR] per group; a match is Hungarian on footprint r >= {DM.MATCH_R}.", ""]
    tsv = ["arm\tseed\tside\tid\tcy\tcx\tcore\tfate\t" + "\t".join(feats) + "\tminian"]

    # The null: base seed against base seed.
    ns = len(base)
    null_only, null_fates = [], {}
    for i in range(ns):
        for j in range(ns):
            if i == j:
                continue
            R = pearson(base[i].csr, base[j].csr)
            ai, _ = match(R)
            ix = np.flatnonzero(ai < 0)
            null_only.append((base[i], ix))
            for c in ix:
                k = base[j].fate_of(*base[i].cen[c], R[c])
                null_fates[k] = null_fates.get(k, 0) + 1
    L += [f"## Null: {bname} seed against {bname} seed", "", head, sep]
    L.append(summarize(f"{bname} cells with a match in the other seed", [(b, np.setdiff1d(np.arange(len(b.ids)), ix)) for b, ix in null_only], feats, minian))  # fmt: skip
    L.append(summarize(f"{bname} cells with no match in the other seed", null_only, feats, minian, null_fates))
    L.append("")

    for aname, runs in arms:
        assert len(runs) == ns
        # Presence of every base cell in every arm seed and every other base seed (and the reverse).
        Rba = [[pearson(b.csr, r.csr) for r in runs] for b in base]
        in_arm = [np.array([(match(Rba[i][j])[0] >= 0) for j in range(ns)]).sum(0) for i in range(ns)]
        in_base_of_arm = [np.array([(match(Rba[i][j])[1] >= 0) for i in range(ns)]).sum(0) for j in range(ns)]
        in_base = []
        for i in range(ns):
            c = np.ones(len(base[i].ids), int)
            for j in range(ns):
                if j != i:
                    c += match(pearson(base[i].csr, base[j].csr))[0] >= 0
            in_base.append(c)
        in_arm_self = []
        for i in range(ns):
            c = np.ones(len(runs[i].ids), int)
            for j in range(ns):
                if j != i:
                    c += match(pearson(runs[i].csr, runs[j].csr))[0] >= 0
            in_arm_self.append(c)
        groups = {"both": [], "base_only": [], "arm_only": [], "base_core": [], "arm_core": [], "arm_both": []}
        fates = {"base_only": {}, "arm_only": {}, "base_core": {}, "arm_core": {}}
        counts = []
        for s in range(ns):
            R = Rba[s][s]
            ab, ba = match(R)
            bo, ao = np.flatnonzero(ab < 0), np.flatnonzero(ba < 0)
            bcore = np.flatnonzero((in_base[s] >= 2) & (in_arm[s] == 0))
            acore = np.flatnonzero((in_arm_self[s] >= 2) & (in_base_of_arm[s] == 0))
            groups["both"].append((base[s], np.flatnonzero(ab >= 0)))
            groups["arm_both"].append((runs[s], np.flatnonzero(ba >= 0)))
            groups["base_only"].append((base[s], bo))
            groups["arm_only"].append((runs[s], ao))
            groups["base_core"].append((base[s], bcore))
            groups["arm_core"].append((runs[s], acore))
            counts.append((len(base[s].ids), len(runs[s].ids), int((ab >= 0).sum()), len(bo), len(ao), len(bcore), len(acore)))  # fmt: skip
            for side, own, other, ix, core, Rm in (("base", base[s], runs[s], bo, bcore, R), ("arm", runs[s], base[s], ao, acore, R.T)):  # fmt: skip
                for c in np.union1d(ix, core):
                    k = other.fate_of(*own.cen[c], Rm[c])
                    if c in ix:
                        fates[f"{side}_only"][k] = fates[f"{side}_only"].get(k, 0) + 1
                    if c in core:
                        fates[f"{side}_core"][k] = fates[f"{side}_core"].get(k, 0) + 1
                    mn = minian[id(own)][c] if minian is not None else math.nan
                    tsv.append(f"{aname}\t{s + 1}\t{side}\t{own.ids[c]}\t{own.cen[c][0]:.1f}\t{own.cen[c][1]:.1f}\t{int(c in core)}\t{k}\t"
                               + "\t".join(f"{own.f[f][c]:.4g}" for f in feats) + f"\t{mn:.0f}")  # fmt: skip
        L += [f"## {aname} against {bname}, same seed", "",
              f"| seed | cells {bname} | cells {aname} | matched | {bname} only | {aname} only | core {bname} only (>= 2 {bname} seeds, no {aname} seed) | core {aname} only |",
              "| --- | --- | --- | --- | --- | --- | --- | --- |"]  # fmt: skip
        for s, c in enumerate(counts):
            L.append(f"| {s + 1} | " + " | ".join(str(v) for v in c) + " |")
        nb = np.mean([len(ix) for _, ix in null_only])
        L += ["", f"Null for the one-sided columns: a {bname} run has {nb:.0f} cells with no match in another {bname} seed.", "", head, sep]  # fmt: skip
        L.append(summarize(f"matched, {bname} side", groups["both"], feats, minian))
        L.append(summarize(f"matched, {aname} side", groups["arm_both"], feats, minian))
        L.append(summarize(f"{bname} only", groups["base_only"], feats, minian, fates["base_only"]))
        L.append(summarize(f"{aname} only", groups["arm_only"], feats, minian, fates["arm_only"]))
        L.append(summarize(f"core {bname} only", groups["base_core"], feats, minian, fates["base_core"]))
        L.append(summarize(f"core {aname} only", groups["arm_core"], feats, minian, fates["arm_core"]))
        L.append("")
    md = "\n".join(L)
    print(md)
    if a.md:
        a.md.write_text(md + "\n")
    if a.tsv:
        a.tsv.write_text("\n".join(tsv) + "\n")


if __name__ == "__main__":
    main()
