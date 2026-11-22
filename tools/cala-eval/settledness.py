#!/usr/bin/env python
"""Per-cell settledness during the Final settle, and stop levels (results/2026-11-22-settledness-plan.md).

    $MINISIM_PY tools/cala-eval/settledness.py dist  [--root R]   # measure distributions only (no quality)
    $MINISIM_PY tools/cala-eval/settledness.py score [--root R] > results.md

Offline, on the saved runs of PR #464 (`slider_tier1.sh`): `<root>/{real,sims}/<run>/B100/footprints_settle{c}.bin`
are the libraries at checkpoint c of the in-order full Final settle (every 1,200 frames; c = 0 is its start).

Two per-cell measures, each from the cell's last K + 1 checkpoint footprints only (computable online in the app):

* M1 `step`: the size of the last step, |f_c - f_{c-1}| on unit-L2 footprints (change relative to the footprint's
  own scale; magnitude only).
* M2 `drift`: the consistent (directional) part of the last K steps, per region (core and edge ring). With steps
  d_1..d_K on a region's pixels, S = sum_{i<j} d_i.d_j estimates C(K,2) |mu|^2 for a steady drift mu per step and is
  0 in expectation for wobble with no direction (independent or anti-correlated steps).
  drift_r = sqrt(max(0, S) / C(K,2)) / max(|f_c on r|, 0.1); the cell's value is the larger of core and edge.
* M2b `ucb`: the same with S + 2 Q, Q = sqrt(sum_{i<j} (d_i.d_j)^2) the sd of S under random step-sign flips (the
  no-direction null): a "confidently settled" bound that also penalises large wobble.

RAM: sparse libraries plus one dense ground-truth stack per sim at a time (a few hundred MB).
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_dilation

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_metrics as DM  # noqa: E402

ROOT = Path.home() / "Projects/cala-data/runs/work-slider-tier1"
SIMDIR = Path.home() / "Projects/cala-data/sims-gt110"
PAIRDIR = Path.home() / "Projects/cala-data/demix-bench/measure/pairsim_v2191"
ARMS = ["REF", "P30", "S30"]
RECS = {"sa": "10_43_21", "sb": "14_57_02"}
SEEDS = [1, 2, 3]
K = 3  # steps in the window (K + 1 checkpoints)
CORE = 0.5  # core = pixels at >= half the footprint's peak
RING = 2  # edge ring: the window's union support minus the core, dilated by this many px
NORM_FLOOR = 0.1
CHECK = 1200  # frames between checkpoints

# Pre-registered grid (plan file): thresholds per measure, and shares of settled cells.
RULES = [("step", t, q) for t in (0.08, 0.12) for q in (0.80, 0.90)] + \
    [("drift", t, q) for t in (0.01, 0.02, 0.03) for q in (0.90, 0.95)] + \
    [("ucb", t, q) for t in (0.05, 0.08) for q in (0.80, 0.90)]
COL = {"step": 0, "ucb": 1, "drift": 4}  # columns of cell_measures


# ------------------------------------------------------------------------------------------- libraries


def read_lib(path: Path):
    """footprints*.bin -> (h, w, {id: (idx, unit-L2 values)})."""
    h, w, ids, cells, _f = DM.read_library(path)
    out = {}
    for cid, (idx, v) in zip(ids, cells):
        n = float(np.sqrt((v * v).sum()))
        if n > 0:
            out[int(cid)] = (idx, v / n)
    return h, w, out


def checkpoints(d: Path):
    """[(c, frames at c, path)] of a B100 dir; c = 0 is the start of the pass. The last one is the end."""
    out = []
    c = 0
    while (d / f"footprints_settle{c}.bin").exists():
        out.append((c, c * CHECK, d / f"footprints_settle{c}.bin"))
        c += 1
    rows = DM.read_tsv(d / "settle_checks.tsv")
    fr = {int(r["check"]): int(r["frames"]) for r in rows}
    return [(c, fr.get(c, f), p) for c, f, p in out]


# ------------------------------------------------------------------------------------------- measures


def window_dense(fps, w):
    """Dense patches of a list of sparse footprints over their joint bbox padded by RING + 1."""
    ys = np.concatenate([i // w for i, _ in fps])
    xs = np.concatenate([i % w for i, _ in fps])
    y0, x0 = ys.min() - RING - 1, xs.min() - RING - 1
    H, W = ys.max() - y0 + RING + 2, xs.max() - x0 + RING + 2
    A = np.zeros((len(fps), H, W))
    for k, (i, v) in enumerate(fps):
        A[k, i // w - y0, i % w - x0] = v
    return A


def cell_measures(fps, w):
    """fps: the cell's K + 1 footprints (oldest first). -> (step, drift_ucb, drift_core, drift_edge, drift_point)."""
    A = window_dense(fps, w)
    f = A[-1]
    D = np.diff(A, axis=0)  # K steps
    step = float(np.sqrt((D[-1] ** 2).sum()))
    core = f >= CORE * f.max()
    edge = binary_dilation((A != 0).any(0), iterations=RING) & ~core
    res = []
    for reg in (core, edge):
        d = D[:, reg]
        G = d @ d.T
        iu = np.triu_indices(len(d), 1)
        S, Q = float(G[iu].sum()), float(np.sqrt((G[iu] ** 2).sum()))
        nr = max(float(np.sqrt((f[reg] ** 2).sum())), NORM_FLOOR)
        res.append((math.sqrt(max(0.0, S + 2 * Q) / len(iu[0])) / nr, math.sqrt(max(0.0, S) / len(iu[0])) / nr))
    (uc, pc), (ue, pe) = res
    return step, max(uc, ue), uc, ue, max(pc, pe)


def run_measures(d: Path):
    """Per checkpoint c >= K: {id: measures} for cells present in all K + 1 libraries; plus cell counts.
    Cells not in the whole window (new or merged) count as not settled."""
    cps = checkpoints(d)
    libs = []
    out = []
    for c, fr, p in cps:
        h, w, lib = read_lib(p)
        libs.append(lib)
        if len(libs) > K + 1:
            libs.pop(0)
        if c < K:
            continue
        m = {}
        for cid in lib:
            if all(cid in L for L in libs):
                m[cid] = cell_measures([L[cid] for L in libs], w)
        out.append({"c": c, "frames": fr, "n": len(lib), "m": m})
    return cps, out


def share_settled(row, meas, tau):
    k = COL[meas]
    return sum(1 for v in row["m"].values() if v[k] < tau) / max(row["n"], 1)


def stop_at(rows, meas, tau, q):
    """First checkpoint with a share of settled cells >= q; None = the full pass."""
    for r in rows:
        if share_settled(r, meas, tau) >= q:
            return r["c"]
    return None


# ------------------------------------------------------------------------------------------- dist


def runs(root: Path):
    for rec in RECS:
        for arm in ARMS:
            for s in SEEDS:
                d = root / "real" / f"{rec}_{arm}_s{s}" / "B100"
                if (d / "footprints_settle0.bin").exists():
                    yield "real", f"{rec}_{arm}_s{s}", d
    for p in sorted((root / "sims").glob("*_s1")):
        if (p / "B100" / "footprints_settle0.bin").exists():
            yield "sims", p.name, p / "B100"


def dist(root: Path) -> None:
    print("| kind | run | checkpoint | frames | cells | in window | step p50 / p80 / p95 | drift p50 / p80 / p95 |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for kind, name, d in runs(root):
        _, rows = run_measures(d)
        for r in rows:
            v = np.array(list(r["m"].values())) if r["m"] else np.zeros((0, 5))
            q = lambda j: " / ".join(f"{np.percentile(v[:, j], p):.4f}" for p in (50, 80, 95)) if len(v) else "-"  # noqa: E731
            print(f"| {kind} | {name} | {r['c']} | {r['frames']} | {r['n']} | {len(v)} | {q(0)} | {q(1)} |")


# ------------------------------------------------------------------------------------------- quality


def centroid(fp, w):
    idx, v = fp
    return float((idx // w * v).sum() / v.sum()), float((idx % w * v).sum() / v.sum())


def cos(a, b):
    ia, va = a
    ib, vb = b
    _, x, y = np.intersect1d(ia, ib, assume_unique=True, return_indices=True)
    return float(va[x] @ vb[y])  # unit-L2 footprints


def match_libs(A: dict, B: dict, w, radius=12.0, min_cos=0.7):
    """Greedy one-to-one by footprint cosine within `radius` px (#464's rule): [(id_a, id_b, cos)]."""
    if not A or not B:
        return []
    kb = list(B)
    cb = np.array([centroid(B[k], w) for k in kb])
    cand = []
    for ka, fa in A.items():
        cy, cx = centroid(fa, w)
        for j in np.nonzero(np.hypot(cb[:, 0] - cy, cb[:, 1] - cx) <= radius)[0]:
            c = cos(fa, B[kb[j]])
            if c >= min_cos:
                cand.append((c, ka, kb[j]))
    cand.sort(reverse=True)
    ua, ub, out = set(), set(), []
    for c, a, b in cand:
        if a in ua or b in ub:
            continue
        ua.add(a)
        ub.add(b)
        out.append((a, b, c))
    return out


def real_quality(root: Path, rec, arm, s, cps):
    """Per checkpoint: pooled single-pair cosines against the other seeds' REF B100, the share of their repeatable
    cells present, and per cell the cosine with the partner it has at the end (per reference)."""
    refs = {}
    for t in SEEDS:
        p = root / "real" / f"{rec}_REF_s{t}" / "B100" / "footprints.bin"
        if p.exists():
            refs[t] = read_lib(p)[2]
    w = read_lib(cps[0][2])[1]
    rep = {}
    for t in refs:
        rep[t] = set()
        for u in refs:
            if u != t:
                rep[t] |= {b for _a, b, _c in match_libs(refs[u], refs[t], w)}
    others = [t for t in refs if not (arm == "REF" and t == s)]
    end = read_lib(cps[-1][2])[2]
    partner = {t: {a: b for a, b, _c in match_libs(end, refs[t], w)} for t in others}
    out = {}
    for c, fr, p in cps:
        lib = read_lib(p)[2]
        cs, present, per = [], [], {}
        for t in others:
            m = match_libs(lib, refs[t], w)
            cs += [x for *_, x in m]
            got = {b for _a, b, _c in m}
            present.append(len(rep[t] & got) / max(len(rep[t]), 1))
            per[t] = {a: cos(lib[a], refs[t][b]) for a, b in partner[t].items() if a in lib}
        out[c] = {"med": float(np.median(cs)), "p10": float(np.percentile(cs, 10)), "rep": 100 * float(np.mean(present)),
                  "per": per}  # fmt: skip
    return out


class Truth:
    """A sim's true footprints as sparse patches (no dense stack)."""

    def __init__(self, sim_dir: Path):
        h, w, units, Ct = DM.read_oracle(sim_dir / "oracle.bin")
        self.h, self.w, self.T = h, w, Ct.shape[1]
        del Ct
        self.units = units
        self.ok = [k for k, u in enumerate(units) if u["det"] and u["full"][2].max() > 0]
        self.diam = float(np.median([2 * np.sqrt((units[k]["full"][2] > 0.5 * units[k]["full"][2].max()).sum() / np.pi) for k in self.ok]))
        self.cen0 = np.array([[u["cy"], u["cx"]] for u in units])

    def patch(self, k, off):
        y0, x0, v = self.units[k]["full"]
        if off != (0.0, 0.0):
            from scipy.ndimage import shift as nd_shift

            v = np.pad(v, 2)
            y0, x0 = y0 - 2, x0 - 2
            v = np.maximum(nd_shift(v, off, order=1), 0)
        return y0, x0, v


def pearson_full(fp, g, N, w):
    """Pearson r over the whole frame of a sparse estimate and a true patch."""
    idx, val = fp
    y0, x0, v = g
    gy, gx = np.nonzero(v)
    gi = (gy + y0) * w + (gx + x0)
    gv = v[gy, gx].astype(np.float64)
    _, x, y = np.intersect1d(idx, gi, assume_unique=True, return_indices=True)
    sab = float(val[x] @ gv[y])
    ma, mb = val.sum() / N, gv.sum() / N
    sa = math.sqrt(max((val**2).sum() / N - ma * ma, 0)) + 1e-12
    sb = math.sqrt(max((gv**2).sum() / N - mb * mb, 0)) + 1e-12
    return (sab / N - ma * mb) / (sa * sb)


def sim_match(T: Truth, end: dict):
    """End library -> ({id: unit}, offset) by #464's rule (loose match for the offset, then strict Hungarian)."""
    from scipy.optimize import linear_sum_assignment

    N, w = T.h * T.w, T.w
    ids = list(end)

    def R_of(off):
        cen = T.cen0[T.ok] + np.array(off)
        R = np.zeros((len(ids), len(T.ok)))
        for i, cid in enumerate(ids):
            cy, cx = centroid(end[cid], w)
            for j in np.nonzero(np.hypot(cen[:, 0] - cy, cen[:, 1] - cx) <= 3 * T.diam)[0]:
                R[i, j] = pearson_full(end[cid], T.patch(T.ok[j], off), N, w)
        return R

    def hung(R, th):
        ri, ci = linear_sum_assignment(-R)
        return {ids[i]: T.ok[c] for i, c in zip(ri, ci) if R[i, c] >= th}

    R = R_of((0.0, 0.0))
    loose = hung(R, DM.LOOSE_R)
    d = []
    for cid, k in loose.items():
        ey, ex = centroid(end[cid], w)
        gy, gx = DM.centroid_patch(T.units[k]["full"])
        d.append((ey - gy, ex - gx))
    off = (0.0, 0.0)
    if len(d) >= 10:
        dy, dx = np.median(np.array(d), axis=0)
        if math.hypot(dy, dx) >= DM.MIN_OFFSET_PX:
            off = (float(dy), float(dx))
            R = R_of(off)
    return hung(R, DM.MATCH_R), off


def gt_cell(fp, g, N, w):
    """(r, core error, edge error) of a sparse estimate against a true patch (unit-free: a fitted by LSQ)."""
    idx, val = fp
    y0, x0, v = g
    ey, ex = idx // w - y0, idx % w - x0
    Y0, X0 = min(0, ey.min()) - RING - 1, min(0, ex.min()) - RING - 1
    Y1, X1 = max(v.shape[0], ey.max() + 1) + RING + 1, max(v.shape[1], ex.max() + 1) + RING + 1
    G = np.zeros((Y1 - Y0, X1 - X0))
    G[-Y0 : -Y0 + v.shape[0], -X0 : -X0 + v.shape[1]] = v
    E = np.zeros_like(G)
    E[ey - Y0, ex - X0] = val
    a = float((E * G).sum() / max((E * E).sum(), 1e-12))
    core = G >= 0.5 * G.max()
    edge = binary_dilation(G > 0.02 * G.max(), iterations=RING) & ~core
    err = lambda m: float(np.sqrt(((a * E[m] - G[m]) ** 2).sum() / max((G[m] ** 2).sum(), 1e-12)))  # noqa: E731
    return pearson_full(fp, g, N, w), err(core), err(edge)


def sim_quality(T: Truth, cps, births):
    """Per checkpoint: per matched cell (r, core err, edge err), bites {(id, unit j): est/true at j's centre}."""
    N, w = T.h * T.w, T.w
    end = read_lib(cps[-1][2])[2]
    mi, off = sim_match(T, end)
    unit_cell = {k: cid for cid, k in mi.items()}
    cen = T.cen0 + np.array(off)
    patches = {k: T.patch(k, off) for k in set(mi.values())}
    # bite candidates: matched i, matched true neighbour j within 3 diameters, true value at j's centre > 0.1
    pairs = []
    for cid, ui in mi.items():
        y0, x0, v = patches[ui]
        gn = v / v.max()
        for j in np.nonzero(np.hypot(*(cen - cen[ui]).T) < DM.NEIGHBOUR_D * T.diam)[0]:
            if j == ui or j not in unit_cell:
                continue
            cy, cx = int(round(cen[j, 0])), int(round(cen[j, 1]))
            if 0 <= cy - y0 < v.shape[0] and 0 <= cx - x0 < v.shape[1] and gn[cy - y0, cx - x0] > 0.1:
                pairs.append((cid, int(j), cy * w + cx, float(gn[cy - y0, cx - x0])))
    out = {}
    for c, fr, p in cps:
        lib = read_lib(p)[2]
        cells = {cid: gt_cell(lib[cid], patches[k], N, w) for cid, k in mi.items() if cid in lib}
        bites = {}
        for cid, j, pix, tv in pairs:
            if cid not in lib:
                continue
            idx, val = lib[cid]
            hit = np.nonzero(idx == pix)[0]
            ev = float(val[hit[0]]) / val.max() if hit.size else 0.0
            bites[(cid, j)] = ev / tv
        out[c] = {"cells": cells, "bites": bites}
    late = {cid for cid in mi if births.get(cid, -1) >= T.T / 2}
    return out, late


def sim_dir(name):
    sim = name.split("_REF_")[0].split("_P30_")[0].split("_S30_")[0]
    return (PAIRDIR if sim.startswith("pairs") else SIMDIR) / sim, sim


def collect(root: Path, cache: Path):
    """Measures and quality for every run, cached (pickle) for the report."""
    import pickle

    if cache.exists():
        return pickle.loads(cache.read_bytes())
    data = {}
    truths = {}
    for kind, name, d in runs(root):
        cps, rows = run_measures(d)
        e = {"kind": kind, "cps": [(c, f) for c, f, _ in cps], "rows": rows}
        if kind == "real":
            rec, arm, s = name.split("_")
            e["q"] = real_quality(root, rec, arm, int(s[1:]), cps)
            e["rec"], e["arm"] = rec, arm
        else:
            sd, sim = sim_dir(name)
            if sim not in truths:
                truths.clear()
                truths[sim] = Truth(sd)
            e["q"], e["late"] = sim_quality(truths[sim], cps, DM.read_births(d))
            e["rec"], e["arm"] = sim, name.split("_")[-2]
        data[name] = e
        print(f"collected {name}", file=sys.stderr, flush=True)
    cache.write_bytes(pickle.dumps(data))
    return data


# ------------------------------------------------------------------------------------------- report


def t_ci(x):
    from scipy import stats

    x = np.asarray([v for v in x if np.isfinite(v)])
    if len(x) < 2:
        return (math.nan, math.nan)
    hw = stats.t.ppf(0.975, len(x) - 1) * x.std(ddof=1) / math.sqrt(len(x))
    return float(x.mean() - hw), float(x.mean() + hw)


def mci(x, p=4):
    x = [v for v in x if np.isfinite(v)]
    if not x:
        return "-"
    lo, hi = t_ci(x)
    return f"{np.mean(x):.{p}f} [{lo:.{p}f}, {hi:.{p}f}]"


def lib_stats(e, c):
    """Library figures at checkpoint c (signed so that larger = better for all)."""
    q = e["q"][c]
    if e["kind"] == "real":
        return {"med": q["med"], "p10": q["p10"], "rep": q["rep"]}
    v = np.array(list(q["cells"].values()))
    b = [x < 0.5 for x in q["bites"].values()]
    return {"r": float(v[:, 0].mean()), "core": -float(np.median(v[:, 1])), "edge": -float(np.median(v[:, 2])),
            "edge90": -float(np.percentile(v[:, 2], 90)), "bit": -float(np.mean(b)) if b else 0.0}  # fmt: skip


REAL_KEYS = [("med", "median cosine vs Max", 0.001, 0.003), ("p10", "10th pct cosine vs Max", 0.003, 0.01),
             ("rep", "Max repeatable cells present (points)", 1.0, 3.0)]  # fmt: skip
SIM_KEYS = [("r", "mean footprint r vs truth", 0.001, 0.003), ("edge", "median edge error", 0.005, 0.015),
            ("bit", "bitten share", 0.01, 0.03), ("core", "median core error", None, None),
            ("edge90", "90th pct edge error", None, None)]  # fmt: skip


def losses(e, c):
    last = e["cps"][-1][0]
    a, b = lib_stats(e, last), lib_stats(e, c)
    return {k: a[k] - b[k] for k in a}


def rule_stop(e, meas, tau, q):
    c = stop_at(e["rows"], meas, tau, q)
    return e["cps"][-1][0] if c is None else c


def saved(e, c):
    fr = dict(e["cps"])
    return 1 - fr[c] / e["cps"][-1][1]


def fixed_stop(e, frac):
    """The first checkpoint at or after (1 - frac) of the pass (fixed in-order truncation saving at most frac)."""
    tot = e["cps"][-1][1]
    return next(c for c, f in e["cps"] if f >= (1 - frac) * tot - 1)


def late_loss(e, c):
    last = e["cps"][-1][0]
    d, de = e["q"][c]["cells"], e["q"][last]["cells"]
    v = [de[i][0] - d[i][0] for i in e["late"] if i in d and i in de]
    return float(np.mean(v)) if v else math.nan


def heals_after(e, c):
    last = e["cps"][-1][0]
    bs, be = e["q"][c]["bites"], e["q"][last]["bites"]
    return sum(1 for p in bs if bs[p] < 0.5 and be.get(p, 0) >= 0.5)


def score(root: Path) -> None:
    from scipy.stats import spearmanr

    cache = root.parent / "settledness_cache.pkl"  # outside #464's run tree
    data = collect(root, cache)
    real = {k: e for k, e in data.items() if e["kind"] == "real"}
    sims = {k: e for k, e in data.items() if e["kind"] == "sims"}
    P = print
    P("# Settledness study: generated tables (`settledness.py score`)\n")
    P(f"Runs: real {len(real)} (2 recordings x 3 arms x 3 seeds), sims {len(sims)} (5 sims x 3 arms). Losses = full pass "
      "minus stopped (positive = worse); mean [95 % t CI] over runs.\n")  # fmt: skip
    # ---- cells with no committed change
    for nm, D in (("real", real), ("sims", sims)):
        z = [np.mean([(v[0] == 0 and v[4] == 0) for v in r["m"].values()]) for e in D.values() for r in e["rows"] if r["m"]]
        P(f"- {nm}: cells with no committed change in their 3-step window: {100 * np.mean(z):.0f} % (mean over checkpoints)")
    P()
    # ---- rules
    results = {}
    P("## Stop rules\n")
    for meas, tau, q in RULES:
        res = {}
        for nm, D, keys in (("real", real, REAL_KEYS), ("sims", sims, SIM_KEYS)):
            st = {k: rule_stop(e, meas, tau, q) for k, e in D.items()}
            sv = [saved(D[k], c) for k, c in st.items()]
            L = {key: [losses(D[k], c)[key] for k, c in st.items()] for key, *_ in keys}
            never = sum(1 for k, c in st.items() if c == D[k]["cps"][-1][0])
            res[nm] = {"saved": sv, "L": L, "never": never, "stop": st}
        results[(meas, tau, q)] = res
    hdr = "| rule | frames saved % (mean, range) | never stops (of n) | " + " | ".join(lbl for _k, lbl, *_ in REAL_KEYS) + " |"
    P("### Real (vs the other seeds' Max B100; n = 18 runs)\n")
    P(hdr)
    P("|" + " --- |" * (3 + len(REAL_KEYS)))
    for r, res in results.items():
        x = res["real"]
        P(f"| {r[0]} {r[1]} q{r[2]} | {100 * np.mean(x['saved']):.0f} ({100 * min(x['saved']):.0f}-{100 * max(x['saved']):.0f}) | "
          f"{x['never']} / 18 | " + " | ".join(mci(x["L"][k], 4 if k != "rep" else 1) for k, *_ in REAL_KEYS) + " |")  # fmt: skip
    P("\n### Sims (vs truth; n = 15 runs)\n")
    P("| rule | frames saved % (mean, range) | never stops (of n) | " + " | ".join(lbl for _k, lbl, *_ in SIM_KEYS) + " |")
    P("|" + " --- |" * (3 + len(SIM_KEYS)))
    for r, res in results.items():
        x = res["sims"]
        P(f"| {r[0]} {r[1]} q{r[2]} | {100 * np.mean(x['saved']):.0f} ({100 * min(x['saved']):.0f}-{100 * max(x['saved']):.0f}) | "
          f"{x['never']} / 15 | " + " | ".join(mci(x["L"][k]) for k, *_ in SIM_KEYS) + " |")  # fmt: skip
    # ---- fixed truncation baseline at the same mean frames
    P("\n## Against fixed in-order truncation at the same mean frames saved\n")
    P("Fixed = every run stops at the first checkpoint at or after (1 - mean saved) of its pass. Difference = rule "
      "loss minus fixed loss (negative = the rule is better), paired per run.\n")  # fmt: skip
    P("| rule | real: saved rule / fixed % | real median cos | real p10 cos | real rep | sims: saved rule / fixed % | sims r | sims edge err | sims bitten |")
    P("|" + " --- |" * 9)
    for r, res in results.items():
        row = [f"{r[0]} {r[1]} q{r[2]}"]
        for nm, D, keys in (("real", real, ["med", "p10", "rep"]), ("sims", sims, ["r", "edge", "bit"])):
            x = res[nm]
            frac = float(np.mean(x["saved"]))
            fx = {k: fixed_stop(e, frac) for k, e in D.items()}
            row.append(f"{100 * frac:.0f} / {100 * np.mean([saved(D[k], c) for k, c in fx.items()]):.0f}")
            for key in keys:
                row.append(mci([losses(D[k], x["stop"][k])[key] - losses(D[k], fx[k])[key] for k in D], 4 if key != "rep" else 1))
        P("| " + " | ".join(row) + " |")
    # ---- fixed truncation curve
    P("\n## Fixed in-order truncation (the baseline curve)\n")
    P("| share of pass read | real: median cos loss | p10 loss | rep loss | sims: r loss | edge err loss | bitten loss | late-born r loss | heals after the stop |")
    P("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for frac in (0.25, 0.4, 0.5, 0.6, 0.75, 0.9):
        cr = {k: fixed_stop(e, 1 - frac) for k, e in real.items()}
        cs = {k: fixed_stop(e, 1 - frac) for k, e in sims.items()}
        P(f"| {100 * frac:.0f} % | " + " | ".join(mci([losses(real[k], c)[key] for k, c in cr.items()], 4 if key != "rep" else 1) for key in ("med", "p10", "rep"))
          + " | " + " | ".join(mci([losses(sims[k], c)[key] for k, c in cs.items()]) for key in ("r", "edge", "bit"))
          + f" | {mci([late_loss(sims[k], c) for k, c in cs.items()])} | {sum(heals_after(sims[k], c) for k, c in cs.items())} |")  # fmt: skip
    # ---- level selection
    P("\n## Level selection (plan rule)\n")
    for lvl, j in (("Standard", 2), ("Quick", 3)):
        ok = []
        for r, res in results.items():
            pass_ = all(np.mean(res["real"]["L"][k]) <= (a if j == 2 else b)
                        for k, _l, a, b in REAL_KEYS) and \
                all(np.mean(res["sims"]["L"][k]) <= (a if j == 2 else b) for k, _l, a, b in SIM_KEYS if a is not None)  # fmt: skip
            if pass_:
                ok.append((0.5 * (np.mean(res["real"]["saved"]) + np.mean(res["sims"]["saved"])), r))
        ok.sort(reverse=True)
        P(f"- {lvl}: passing rules (mean saved, real+sims): " + (", ".join(f"{r[0]} {r[1]} q{r[2]} ({100 * s:.0f} %)" for s, r in ok) or "none"))
    # ---- prediction of the remaining gain
    P("\n## Does the measure predict a cell's remaining gain? (Spearman per checkpoint, mean over checkpoints, then over runs)\n")
    P("| measure | real: gain in cosine vs Max partner | sims: drop in total error (1 - r) | sims: drop in edge error | sims: drop in core error |")
    P("| --- | --- | --- | --- | --- |")
    for meas in ("step", "drift", "ucb"):
        j = COL[meas]
        rr, s1, s2, s3 = [], [], [], []
        for e in real.values():
            last = e["cps"][-1][0]
            per = []
            for r in e["rows"]:
                if r["c"] == last:
                    continue
                for t, d in e["q"][r["c"]]["per"].items():
                    de = e["q"][last]["per"][t]
                    ids = [i for i in r["m"] if i in d and i in de]
                    if len(ids) > 10:
                        per.append(spearmanr([r["m"][i][j] for i in ids], [de[i] - d[i] for i in ids])[0])
            rr.append(np.nanmean(per))
        for e in sims.values():
            last = e["cps"][-1][0]
            pa, pb, pc = [], [], []
            de = e["q"][last]["cells"]
            for r in e["rows"]:
                if r["c"] == last:
                    continue
                d = e["q"][r["c"]]["cells"]
                ids = [i for i in r["m"] if i in d and i in de]
                if len(ids) > 10:
                    x = [r["m"][i][j] for i in ids]
                    pa.append(spearmanr(x, [de[i][0] - d[i][0] for i in ids])[0])
                    pb.append(spearmanr(x, [d[i][2] - de[i][2] for i in ids])[0])
                    pc.append(spearmanr(x, [d[i][1] - de[i][1] for i in ids])[0])
            s1.append(np.nanmean(pa))
            s2.append(np.nanmean(pb))
            s3.append(np.nanmean(pc))
        P(f"| {meas} | {mci(rr, 3)} | {mci(s1, 3)} | {mci(s2, 3)} | {mci(s3, 3)} |")
    # ---- tails at the stop (sims)
    P("\n## Sims: where the loss sits at the stop (mean over runs; loss = error at stop minus at end, edge error)\n")
    P("| rule | cells unsettled at stop % | edge-err loss, unsettled cells | edge-err loss, settled cells | r loss, late-born cells | bitten pairs healed after the stop |")
    P("| --- | --- | --- | --- | --- | --- |")
    for r, res in results.items():
        meas, tau, q = r
        j = COL[meas]
        un, lu, ls, ll, hb = [], [], [], [], []
        for k, e in sims.items():
            c = res["sims"]["stop"][k]
            last = e["cps"][-1][0]
            row = next((x for x in e["rows"] if x["c"] == c), None)
            d, de = e["q"][c]["cells"], e["q"][last]["cells"]
            uns = {i for i in d if row is None or i not in row["m"] or row["m"][i][j] >= tau}
            un.append(100 * len(uns) / max(len(d), 1))
            lu.append(np.mean([d[i][2] - de[i][2] for i in uns if i in de]) if uns else math.nan)
            ls.append(np.mean([d[i][2] - de[i][2] for i in d if i not in uns and i in de]))
            ll.append(np.mean([de[i][0] - d[i][0] for i in e["late"] if i in d and i in de]) if e["late"] else math.nan)
            bs, be = e["q"][c]["bites"], e["q"][last]["bites"]
            hb.append(sum(1 for p in bs if bs[p] < 0.5 and be.get(p, 0) >= 0.5))
        P(f"| {meas} {tau} q{q} | {np.mean(un):.0f} | {mci(lu)} | {mci(ls)} | {mci(ll)} | {np.sum(hb)} (of {sum(1 for e in sims.values() for p, v in e['q'][e['cps'][-1][0]]['bites'].items() if v >= 0.5 and any(e['q'][c]['bites'].get(p, 1) < 0.5 for c, _ in e['cps']))}) |")
    # ---- bite check
    P("\n## Sims: bites that heal during the pass, seen the checkpoint before they heal (c >= 3)\n")
    P("| measure | pairs | median percentile of the cell among all cells | share above tau (each tau) |")
    P("| --- | --- | --- | --- |")
    for meas in ("step", "drift", "ucb"):
        j = COL[meas]
        pct, vals = [], []
        for e in sims.values():
            cs = [c for c, _ in e["cps"]]
            for p in e["q"][cs[-1]]["bites"]:
                seq = [e["q"][c]["bites"].get(p, math.nan) for c in cs]
                for a in range(1, len(cs)):
                    if seq[a - 1] < 0.5 and seq[a] >= 0.5 and all(x >= 0.5 for x in seq[a:] if np.isfinite(x)):
                        row = next((x for x in e["rows"] if x["c"] == cs[a - 1]), None)
                        if row and p[0] in row["m"]:
                            allv = np.array([v[j] for v in row["m"].values()])
                            v = row["m"][p[0]][j]
                            pct.append(100 * (allv < v).mean())
                            vals.append(v)
                        break
        taus = sorted({t for m, t, _q in RULES if m == meas})
        P(f"| {meas} | {len(vals)} | {np.median(pct) if pct else math.nan:.0f} | " +
          ", ".join(f"{t}: {100 * np.mean([v >= t for v in vals]) if vals else math.nan:.0f} %" for t in taus) + " |")  # fmt: skip

    # ---- (after the runs) coverage: how much of the cell's life the in-order pass has re-read
    P("\n## (After the runs) A structural predictor: re-read coverage of the cell's life\n")
    P("coverage = (frames re-read so far - Discover birth frame) / (recording length - birth frame), clipped to [0, 1]. "
      "Spearman of (1 - coverage) with the remaining gain, as above.\n")  # fmt: skip
    P("| predictor | real: gain in cosine vs Max partner | sims: drop in total error (1 - r) | sims: drop in edge error |")
    P("| --- | --- | --- | --- |")
    rr, s1, s2 = [], [], []
    for name, e in data.items():
        d = root / e["kind"] / name / "B100"
        born = DM.read_births(d)
        tot = e["cps"][-1][1]
        last = e["cps"][-1][0]
        fr = dict(e["cps"])
        per_a, per_b = [], []
        for r in e["rows"]:
            if r["c"] == last:
                continue
            F = fr[r["c"]]
            unc = lambda i: 1 - min(1.0, max(0.0, (F - born.get(i, 0)) / max(tot - born.get(i, 0), 1)))  # noqa: E731
            if e["kind"] == "real":
                for t, dd in e["q"][r["c"]]["per"].items():
                    de = e["q"][last]["per"][t]
                    ids = [i for i in r["m"] if i in dd and i in de]
                    if len(ids) > 10:
                        per_a.append(spearmanr([unc(i) for i in ids], [de[i] - dd[i] for i in ids])[0])
            else:
                dd, de = e["q"][r["c"]]["cells"], e["q"][last]["cells"]
                ids = [i for i in r["m"] if i in dd and i in de]
                if len(ids) > 10:
                    x = [unc(i) for i in ids]
                    per_a.append(spearmanr(x, [de[i][0] - dd[i][0] for i in ids])[0])
                    per_b.append(spearmanr(x, [dd[i][2] - de[i][2] for i in ids])[0])
        if e["kind"] == "real":
            rr.append(np.nanmean(per_a))
        else:
            s1.append(np.nanmean(per_a))
            s2.append(np.nanmean(per_b))
    P(f"| 1 - coverage | {mci(rr, 3)} | {mci(s1, 3)} | {mci(s2, 3)} |")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["dist", "score"])
    ap.add_argument("--root", type=Path, default=ROOT)
    a = ap.parse_args(argv)
    if a.what == "dist":
        dist(a.root)
    else:
        score(a.root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
