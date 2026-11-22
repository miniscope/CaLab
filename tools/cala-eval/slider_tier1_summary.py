#!/usr/bin/env python
"""Work-slider tier 1 (results/2026-11-22-slider-tier1-plan.md): parity, Final-settle saving, stop test, sizing.

    $MINISIM_PY tools/cala-eval/slider_tier1_summary.py real [--root R] > real.md
    $MINISIM_PY tools/cala-eval/slider_tier1_summary.py sims [--root R] > sims.md
    $MINISIM_PY tools/cala-eval/slider_tier1_summary.py chrome [--root R] > chrome.md

Runs are `slider_tier1.sh` outputs: `<root>/real/<rec>_<ARM>_s<seed>/<branch>/` and `<root>/sims/<sim>_<ARM>_s<seed>/`.
Agreement between two libraries is `csettle_app_summary.agreement` (greedy by footprint cosine within 12 px, a match at
cosine >= 0.7; the median cosine of the matched pairs), on model and Chrome libraries alike. RAM: libraries are
sparse; a few hundred MB.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import csettle_app_summary as CA  # noqa: E402
import demix_metrics as DM  # noqa: E402

ROOT = Path.home() / "Projects/cala-data/runs/work-slider-tier1"
ARMS = ["REF", "P30", "S30", "P60", "S60"]
BRANCHES = ["B0", "B25", "B50", "B75", "B100"]
FRAC = {"B0": 0, "B25": 0.25, "B50": 0.5, "B75": 0.75, "B100": 1.0}
RECS = {"sa": "10_43_21", "sb": "14_57_02"}
SEEDS = [1, 2, 3]
TOL_AGREE, TOL_REP = 0.003, 3.0  # plan: B* tolerance against the arm's own B100; L2 / L2b margins
_cache: dict = {}


def model_lib(path: Path):
    """footprints.bin -> csettle_app_summary's library form [(cy, cx, {px: v}, norm)]."""
    key = str(path)
    if key not in _cache:
        h, w, _ids, cells, _f = DM.read_library(path)
        out = []
        for idx, v in cells:
            tot = v.sum() or 1.0
            out.append((float(((idx // w) * v).sum() / tot), float(((idx % w) * v).sum() / tot),
                        dict(zip(idx.tolist(), v.tolist())), float(np.sqrt((v * v).sum()) or 1.0)))
        _cache[key] = out
    return _cache[key]


def match_pairs(a, b, radius=12.0, min_cos=0.7):
    """One-to-one matches (i, j, cos) by the same greedy rule as CA.agreement."""
    if not a or not b:
        return []
    cb = np.array([[p[0], p[1]] for p in b])
    cand = []
    for i, (cy, cx, fa, na) in enumerate(a):
        d = np.hypot(cb[:, 0] - cy, cb[:, 1] - cx)
        for j in np.nonzero(d <= radius)[0]:
            fb, nb = b[j][2], b[j][3]
            cand.append((sum(v * fb[k] for k, v in fa.items() if k in fb) / (na * nb), i, int(j)))
    cand.sort(reverse=True)
    ua, ub, out = set(), set(), []
    for c, i, j in cand:
        if c < min_cos:
            break
        if i in ua or j in ub:
            continue
        ua.add(i)
        ub.add(j)
        out.append((i, j, c))
    return out


def agree(a, b) -> float:
    m = match_pairs(a, b)
    return float(np.median([c for *_, c in m])) if m else math.nan


def boot_ci(x, n=10000, seed=0):
    x = np.asarray([v for v in x if np.isfinite(v)])
    if len(x) < 2:
        return (math.nan, math.nan)
    rng = np.random.default_rng(seed)
    m = rng.choice(x, (n, len(x))).mean(1)
    return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))


def t_ci(x):
    from scipy import stats

    x = np.asarray([v for v in x if np.isfinite(v)])
    if len(x) < 2:
        return (math.nan, math.nan)
    h = stats.t.ppf(0.975, len(x) - 1) * x.std(ddof=1) / math.sqrt(len(x))
    return float(x.mean() - h), float(x.mean() + h)


def fmt(v, p=4):
    return "-" if v is None or (isinstance(v, float) and not math.isfinite(v)) else f"{v:.{p}f}"


def sched(run: Path) -> dict:
    """Scheduler numbers of a run's Discover (first `timed` lines of its log)."""
    log = Path(str(run) + ".log").read_text()
    m = re.search(r"forwarded (\d+) frames, dropped (\d+), observed \d+; visits \d+ \((\d+) jobs\)", log)
    fwd, drop, jobs = (int(x) for x in m.groups())
    need = re.search(r"look-back gate: (\d+) need-driven", log)
    cs = re.search(r"timed settle jobs: (\d+) frames re-read", log)
    lbb = re.search(r"look-back worker busy ([\d.]+)%", log)
    cells = re.search(r"pass 1 done: (\d+) cells", log)
    return {"missed": 100 * drop / (fwd + drop), "jobs": jobs, "need": int(need.group(1)) if need else 0,
            "dose": int(cs.group(1)) / fwd if cs else 0.0, "lb_busy": float(lbb.group(1)) if lbb else math.nan,
            "cells": int(cells.group(1)) if cells else 0}  # fmt: skip


# ------------------------------------------------------------------------------------------------ real


def real(root: Path) -> None:
    R = root / "real"
    run = lambda rec, arm, s: R / f"{rec}_{arm}_s{s}"  # noqa: E731
    have = lambda rec, arm, s: (run(rec, arm, s) / "B100" / "footprints.bin").exists()  # noqa: E731
    lib = lambda rec, arm, s, b="B100": model_lib(run(rec, arm, s) / b / "footprints.bin")  # noqa: E731
    print("# Work slider tier 1, real (model)\n")
    pooled: dict = {}
    for rec, name in RECS.items():
        seeds = [s for s in SEEDS if have(rec, "REF", s)]
        if len(seeds) < 2:
            print(f"## {name}: REF has {len(seeds)} seeds, skipped\n")
            continue
        print(f"## Samara {name} (REF seeds {seeds})\n")
        # Null: REF-REF agreement across seeds.
        nulls = [agree(lib(rec, "REF", a), lib(rec, "REF", b)) for i, a in enumerate(seeds) for b in seeds[i + 1 :]]
        null = float(np.mean(nulls))
        # Repeatable REF cells (per seed s: cells of REF s matched in another REF seed) and the leave-one-out null.
        rep = {}
        for s in seeds:
            hit = set()
            for o in seeds:
                if o != s:
                    hit |= {i for i, _, _ in match_pairs(lib(rec, "REF", s), lib(rec, "REF", o))}
            rep[s] = hit
        loo = []
        for s in seeds:
            others = [o for o in seeds if o != s]
            if len(others) < 2:
                continue
            a, b = others
            agreed = {i for i, _, _ in match_pairs(lib(rec, "REF", a), lib(rec, "REF", b))}
            found = {i for i, _, _ in match_pairs(lib(rec, "REF", a), lib(rec, "REF", s))}
            loo.append(100 * len(agreed & found) / max(len(agreed), 1))
        loo_null = float(np.mean(loo)) if loo else math.nan
        print(f"REF-REF agreement (null) {fmt(null)} (pairs: {', '.join(fmt(x) for x in nulls)}); "
              f"leave-one-out repeatable-cell null {fmt(loo_null, 1)} %\n")  # fmt: skip

        def score(arm, s, b):
            """(agreement with REF B100 of seed s, % of REF s's repeatable cells present, extra cells, arm cells)."""
            L, Rf = lib(rec, arm, s, b), lib(rec, "REF", s)
            m = match_pairs(Rf, L)
            got = {i for i, _, _ in m}
            ag = float(np.median([c for *_, c in m])) if m else math.nan
            reps = 100 * len(rep[s] & got) / max(len(rep[s]), 1)
            # extra: arm cells matching no REF seed's cell
            matched_any = set()
            for o in seeds:
                matched_any |= {j for _, j, _ in match_pairs(lib(rec, "REF", o), L)}
            return ag, reps, [j for j in range(len(L)) if j not in matched_any], len(L)

        def score_x(arm, s, b):
            """Against the REF B100 of the other seeds (mean): agreement, % of that seed's repeatable cells present."""
            L = lib(rec, arm, s, b)
            ag, rp = [], []
            for o in seeds:
                if o == s:
                    continue
                m = match_pairs(lib(rec, "REF", o), L)
                ag.append(float(np.median([c for *_, c in m])) if m else math.nan)
                rp.append(100 * len(rep[o] & {i for i, _, _ in m}) / max(len(rep[o]), 1))
            return float(np.mean(ag)), float(np.mean(rp))

        rows = {}
        print("| arm | seed | cells (Discover end / B100) | agreement with REF | REF repeatable present % | extra cells | "
              "missed % | visit jobs | need-driven | bg settle per frame | look-back busy % | moving share at last check |")
        print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for arm in ARMS:
            for s in seeds:
                if not have(rec, arm, s):
                    continue
                sc = sched(run(rec, arm, s))
                ag, reps, extra, n = score(arm, s, "B100")
                chk = DM.read_tsv(run(rec, arm, s) / "B100" / "settle_checks.tsv")
                mv = 100 * float(chk[-1]["share_gt2"]) if chk else math.nan
                xa, xr = score_x(arm, s, "B100")
                rows[(arm, s)] = {"ag": ag, "rep": reps, "xag": xa, "xrep": xr, "extra": extra, "n": n, "mv": mv, **sc}
                print(f"| {arm} | {s} | {sc['cells']} / {n} | {fmt(ag)} | {fmt(reps, 1)} | {len(extra)} | {fmt(sc['missed'], 2)} | "
                      f"{sc['jobs']} | {sc['need']} | {fmt(sc['dose'], 2)} | {fmt(sc['lb_busy'], 0)} | {fmt(mv, 1)} |")  # fmt: skip
        print()
        # Parity lines per arm.
        print("| arm | n seeds | agreement with REF, mean (range) | L2: >= null - 0.003 | repeatable present % mean | L2b: >= LOO null - 3 | "
              "L4b missed <= 0.1 % | L5 moving <= 4 % | extra cells, median ho z (REF single-seed cells) | cross-seed: agreement / repeatable % |")
        print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        # Held-out z of REF cells found by one REF seed only (L2c comparison).
        single_z = []
        for s in seeds:
            fz = {i: float(r["ho_marginal_z"]) for i, r in enumerate(DM.read_tsv(run(rec, "REF", s) / "B100" / "final.tsv"))}
            single_z += [fz[i] for i in range(len(lib(rec, "REF", s))) if i not in rep[s] and math.isfinite(fz.get(i, math.nan))]
        for arm in ARMS:
            ss = [s for s in seeds if (arm, s) in rows]
            if not ss:
                continue
            ag = [rows[(arm, s)]["ag"] for s in ss]
            rp = [rows[(arm, s)]["rep"] for s in ss]
            ez = []
            for s in ss:
                fz = [float(r["ho_marginal_z"]) for r in DM.read_tsv(run(rec, arm, s) / "B100" / "final.tsv")]
                ez += [fz[j] for j in rows[(arm, s)]["extra"] if j < len(fz) and math.isfinite(fz[j])]
            l2 = np.mean(ag) >= null - TOL_AGREE
            l2b = np.mean(rp) >= loo_null - TOL_REP
            l4b = max(rows[(arm, s)]["missed"] for s in ss) <= 0.1
            l5 = max(rows[(arm, s)]["mv"] for s in ss) <= 4.0
            same = "(self)" if arm == "REF" else ""
            print(f"| {arm} {same} | {len(ss)} | {fmt(np.mean(ag))} ({fmt(min(ag))}-{fmt(max(ag))}) | {'pass' if l2 else 'FAIL'} | "
                  f"{fmt(np.mean(rp), 1)} | {'pass' if l2b else 'FAIL'} | {'pass' if l4b else ('n/a' if arm == 'REF' else 'FAIL')} | "
                  f"{'pass' if l5 else 'FAIL'} | {sum(len(rows[(arm, s)]['extra']) for s in ss) / len(ss):.0f} per run, z {fmt(np.median(ez) if ez else math.nan, 1)} "
                  f"({fmt(np.median(single_z) if single_z else math.nan, 1)}) | "
                  f"{fmt(np.mean([rows[(arm, s)]['xag'] for s in ss]))} / {fmt(np.mean([rows[(arm, s)]['xrep'] for s in ss]), 1)} |")  # fmt: skip
            for s in ss:
                if arm != "REF":
                    pooled.setdefault(arm, []).append((rows[(arm, s)]["ag"] - null, rows[(arm, s)]["rep"] - loo_null,
                                                       rows[(arm, s)]["xag"] - rows[("REF", s)]["xag"], rows[(arm, s)]["xrep"] - rows[("REF", s)]["xrep"]))
        print()
        # Diagnostic added after the runs (not a pre-registered line): footprint agreement on the same cells only,
        # those that every REF seed and the arm all have, so the arms' extra matches of weaker REF cells drop out.
        print("Diagnostic (added after the runs): median cosine on cells that all three REF seeds and the arm have "
              "(REF cell of seed s against the other REF seeds, and against the arm of seed s):\n")  # fmt: skip
        print("| arm | cells per seed | REF vs REF | arm vs REF | difference |")
        print("| --- | --- | --- | --- | --- |")
        for arm in ARMS[1:]:
            ss = [s for s in seeds if (arm, s) in rows]
            if len(ss) < len(seeds):
                continue
            dref, darm, nc = [], [], []
            for s in seeds:
                mo = [{i: c for i, _, c in match_pairs(lib(rec, "REF", s), lib(rec, "REF", o))} for o in seeds if o != s]
                ma = {i: c for i, _, c in match_pairs(lib(rec, "REF", s), lib(rec, arm, s))}
                common = set(ma).intersection(*[set(m) for m in mo])
                nc.append(len(common))
                dref.append(float(np.median([np.mean([m[i] for m in mo]) for i in common])))
                darm.append(float(np.median([ma[i] for i in common])))
            print(f"| {arm} | {' '.join(map(str, nc))} | {fmt(np.mean(dref))} | {fmt(np.mean(darm))} | {fmt(np.mean(darm) - np.mean(dref))} |")
        print()
        # Extra cells, scored apart from parity (PI): held-out z, peak z, birth (share of the recording).
        def cell_stats(arm, s, idx):
            d = run(rec, arm, s) / "B100"
            fin = DM.read_tsv(d / "final.tsv")
            born = {}
            for r in DM.read_tsv(d / "adds.tsv"):
                born.setdefault(r["id"], float(r["recording_frame"]))
            T = 17879 if rec == "sa" else 17875
            out = []
            for j in idx:
                if j < len(fin):
                    f = fin[j]
                    out.append((float(f["ho_marginal_z"]), float(f["peak_z"]), born.get(f["id"], math.nan) / T))
            return out

        def stat_row(label, xs):
            z = np.array([x[0] for x in xs])
            pz = np.array([x[1] for x in xs])
            b = np.array([x[2] for x in xs])
            fz = z[np.isfinite(z)]
            return (f"| {label} | {len(xs)} | {fmt(np.median(fz) if fz.size else math.nan, 1)} | "
                    f"{fmt(100 * np.mean(fz > 2) if fz.size else math.nan, 0)} | {fmt(np.nanmedian(pz), 1)} | "
                    f"{fmt(np.nanmedian(b), 2)} | {fmt(100 * np.nanmean(b >= 0.5), 0)} |")  # fmt: skip

        print("Extra cells (in no REF seed's library), scored apart from parity; references: REF cells found by one REF "
              "seed only, and the arm's own cells that match REF:\n")  # fmt: skip
        print("| group | cells (all seeds) | median held-out z | held-out z > 2 % | median peak z | median birth (share of recording) | born in 2nd half % |")
        print("| --- | --- | --- | --- | --- | --- | --- |")
        single = []
        for s in seeds:
            single += cell_stats("REF", s, [i for i in range(len(lib(rec, "REF", s))) if i not in rep[s]])
        print(stat_row("REF, one seed only", single))
        for arm in ARMS[1:]:
            ss = [s for s in seeds if (arm, s) in rows]
            if not ss:
                continue
            ex, mt = [], []
            for s in ss:
                e = set(rows[(arm, s)]["extra"])
                ex += cell_stats(arm, s, sorted(e))
                mt += cell_stats(arm, s, [j for j in range(rows[(arm, s)]["n"]) if j not in e])
            print(stat_row(f"{arm} extra", ex))
            print(stat_row(f"{arm} matching REF", mt))
        print()
        # Final-settle dose-response and B*.
        print("Final-settle budget (agreement with the other seeds' REF B100 / their repeatable cells present %), mean over "
              "seeds; B* = smallest budget within 0.003 and 3 points of the arm's own B100:\n")  # fmt: skip
        print("| arm | " + " | ".join(BRANCHES) + " | B* (mean) | B* per seed | frames saved |")
        print("| --- | " + " | ".join("---" for _ in BRANCHES) + " | --- | --- | --- |")
        bstar_all = {}
        for arm in ARMS:
            ss = [s for s in seeds if (arm, s) in rows]
            if not ss:
                continue
            per = {b: [score_x(arm, s, b) for s in ss] for b in BRANCHES}
            mean = {b: (np.mean([x[0] for x in per[b]]), np.mean([x[1] for x in per[b]])) for b in BRANCHES}
            ok = lambda v, full: v[0] >= full[0] - TOL_AGREE and v[1] >= full[1] - TOL_REP  # noqa: E731
            bstar = next(b for b in BRANCHES if ok(mean[b], mean["B100"]))
            per_seed = [next(b for b in BRANCHES if ok(per[b][k], per["B100"][k])) for k in range(len(ss))]
            bstar_all[arm] = bstar
            T = 17879 if rec == "sa" else 17875
            print(f"| {arm} | " + " | ".join(f"{fmt(mean[b][0])} / {fmt(mean[b][1], 1)}" for b in BRANCHES)
                  + f" | {bstar} | {' '.join(per_seed)} | {int(round((1 - FRAC[bstar]) * T))} ({100 * (1 - FRAC[bstar]):.0f} %) |")  # fmt: skip
        print()
        # Live library: gap closed at the last frame (L3), per seed.
        print("Live library at the last frame (B0): agreement with REF B100 of the same seed, and the share of REF's "
              "live-to-settled gap closed:\n")  # fmt: skip
        print("| arm | agreement (per seed) | gap closed % (per seed) | mean |")
        print("| --- | --- | --- | --- |")
        gaps = {}
        for arm in ARMS:
            ss = [s for s in seeds if (arm, s) in rows]
            if not ss:
                continue
            a = [agree(lib(rec, arm, s, "B0"), lib(rec, "REF", s)) for s in ss]
            r0 = [agree(lib(rec, "REF", s, "B0"), lib(rec, "REF", s)) for s in ss]
            g = [100 * (x - y) / (1 - y) for x, y in zip(a, r0)]
            gaps[arm] = dict(zip(ss, g))
            print(f"| {arm} | {' '.join(fmt(x) for x in a)} | {' '.join(fmt(x, 0) for x in g)} | {fmt(np.mean(g), 0)} |")
        for x, y in (("S30", "P30"), ("S60", "P60")):
            if x in gaps and y in gaps:
                pooled.setdefault(f"gap {x}-{y}", []).extend(gaps[x][s] - gaps[y][s] for s in gaps[x] if s in gaps[y])
        print()
        stop_test(rec, seeds, run, lib)
    print("## Pooled over recording-seeds (arm minus null; paired bootstrap 95 % CI; seeds of one recording are not independent)\n")
    print("| arm | n | agreement - REF null | repeatable present - LOO null (points) | cross-seed agreement - REF's | cross-seed repeatable - REF's (points) |")
    print("| --- | --- | --- | --- | --- | --- |")
    for arm, v in pooled.items():
        if arm.startswith("gap"):
            continue
        cols = list(zip(*v))
        txt = [f"{fmt(np.mean(c), p)} [{', '.join(fmt(x, p) for x in boot_ci(c))}]" for c, p in zip(cols, (4, 1, 4, 1))]
        print(f"| {arm} | {len(v)} | " + " | ".join(txt) + " |")
    for k, v in pooled.items():
        if k.startswith("gap"):
            print(f"\n{k} in gap closed (points): mean {fmt(np.mean(v), 1)}, n {len(v)}, 95 % CI "
                  f"[{', '.join(fmt(c, 1) for c in boot_ci(v))}]")  # fmt: skip


def unit_peak(fp):
    idx, v = fp
    m = v.max() if v.size else 1.0
    return dict(zip(idx.tolist(), (v / (m or 1.0)).tolist()))


def stop_test(rec, seeds, run, lib) -> None:
    """Design section 3 part B on the B100 checkpoint libraries: the first checkpoint with share_gt2 <= 4 % at two
    checkpoints in a row and the median drift ratio R over the last three steps <= 0.8."""
    print("Stop test (design section 3, part B) on the in-order full pass, checkpoints every 1,200 frames:\n")
    print("| arm | seed | fires at frame | share moving > 2x noise there | median R there | agreement with REF there - at B100 end |")
    print("| --- | --- | --- | --- | --- | --- |")
    for arm in ARMS:
        for s in seeds:
            d = run(rec, arm, s) / "B100"
            if not (d / "settle_checks.tsv").exists():
                continue
            chk = DM.read_tsv(d / "settle_checks.tsv")
            libs = {}
            for k in range(0, len(chk) + 1):
                p = d / f"footprints_settle{k}.bin"
                if p.exists():
                    _, _, ids, cells, _ = DM.read_library(p)
                    libs[k] = dict(zip(ids, (unit_peak(c) for c in cells)))
            fire = None
            traj = []
            for k in range(2, len(chk) + 1):
                if not (float(chk[k - 1]["share_gt2"]) <= 0.04 and float(chk[k - 2]["share_gt2"]) <= 0.04):
                    continue
                if k < 3 or any(j not in libs for j in (k - 3, k - 2, k - 1, k)):
                    continue
                Rs = []
                for cid in libs[k]:
                    if not all(cid in libs[j] for j in (k - 3, k - 2, k - 1)):
                        continue
                    keys = set().union(*(set(libs[j][cid]) for j in (k - 3, k - 2, k - 1, k)))
                    keys = sorted(keys)
                    vec = [np.array([libs[j][cid].get(x, 0.0) - libs[j - 1][cid].get(x, 0.0) for x in keys]) for j in (k - 2, k - 1, k)]
                    den = math.sqrt(sum(float((v * v).sum()) for v in vec))
                    if den > 0:
                        Rs.append(float(np.linalg.norm(sum(vec))) / den)
                medR = float(np.median(Rs)) if Rs else math.nan
                traj.append(medR)
                if medR <= 0.8:
                    fire = (k, medR)
                    break
            if fire is None:
                print(f"| {arm} | {s} | does not fire | - | median R at floor-passing checkpoints {fmt(min(traj), 2) if traj else '-'}-{fmt(max(traj), 2) if traj else '-'} | - |")
                continue
            k, medR = fire
            fr = int(chk[k - 1]["frames"])
            here = model_lib(d / f"footprints_settle{k}.bin")
            diff = agree(here, lib(rec, "REF", s)) - agree(lib(rec, arm, s), lib(rec, "REF", s))
            print(f"| {arm} | {s} | {fr} | {100 * float(chk[k - 1]['share_gt2']):.1f} % | {medR:.2f} | {fmt(diff)} |")
    print()


# ------------------------------------------------------------------------------------------------ sims


def sims(root: Path) -> None:
    S = root / "sims"
    simdir = Path.home() / "Projects/cala-data/sims-gt110"
    pairdir = Path.home() / "Projects/cala-data/demix-bench/measure/pairsim_v2191"
    names = sorted({p.name.split("_REF_")[0] for p in S.glob("*_REF_s1")})
    print("# Work slider tier 1, sims (model, quick tier; screen only)\n")
    vals: dict = {}
    for sim in names:
        for arm in ARMS:
            r = S / f"{sim}_{arm}_s1"
            if not (r / "B100" / "footprints.bin").exists():
                continue
            for b in BRANCHES:
                d = r / b
                sp = (pairdir if sim.startswith("pairs") else simdir) / sim
                det = DM.compute_run(sp, d)
                cells = DM.read_tsv(d / "demix_cells.tsv")
                T = det["frames"]
                fr = [float(c["fp_r"]) for c in cells]
                late = [float(c["fp_r"]) for c in cells if math.isfinite(float(c["born"])) and float(c["born"]) >= T / 2]
                pr = DM.read_tsv(d / "demix_pairs.tsv")
                ok = [float(p["est_at_cj"]) / float(p["true_at_cj"]) for p in pr if float(p["true_at_cj"]) > 0.1 and int(float(p["jmatched"])) == 1]
                vals[(sim, arm, b)] = {"r": float(np.mean(fr)) if fr else math.nan, "late": float(np.mean(late)) if late else math.nan,
                                       "bitten": float(np.mean([x < 0.5 for x in ok])) if ok else math.nan,
                                       "false": det["false"], "matched": det["matched"]}  # fmt: skip
    print(f"Sims: {', '.join(names)} (n = {len(names)}); paired t 95 % CI over sims.\n")
    print("| arm | footprint r (all) - REF | L1 screen (mean >= -0.001) | late-born (2nd half) r - REF | bitten share - REF | false cells - REF | matched - REF |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for arm in ARMS[1:]:
        ss = [s for s in names if (s, arm, "B100") in vals and (s, "REF", "B100") in vals]
        if not ss:
            continue
        dd = {k: [vals[(s, arm, "B100")][k] - vals[(s, "REF", "B100")][k] for s in ss] for k in ("r", "late", "bitten", "false", "matched")}
        ci = lambda k, p=4: f"{fmt(np.mean(dd[k]), p)} [{', '.join(fmt(c, p) for c in t_ci(dd[k]))}]"  # noqa: E731
        print(f"| {arm} | {ci('r')} | {'pass' if np.mean(dd['r']) >= -0.001 else 'STOP'} | {ci('late')} | {ci('bitten', 3)} | {ci('false', 1)} | {ci('matched', 1)} |")
    print("\nFinal-settle budget, footprint r (all) / late-born r, mean over sims; B* = smallest budget within 0.001 (all) and "
          "0.005 (late) of the arm's own B100, per sim:\n")  # fmt: skip
    print("| arm | " + " | ".join(BRANCHES) + " | B* per sim |")
    print("| --- | " + " | ".join("---" for _ in BRANCHES) + " | --- |")
    for arm in ARMS:
        ss = [s for s in names if (s, arm, "B100") in vals]
        if not ss:
            continue
        cells = []
        for b in BRANCHES:
            cells.append(f"{fmt(np.mean([vals[(s, arm, b)]['r'] for s in ss]))} / {fmt(np.nanmean([vals[(s, arm, b)]['late'] for s in ss]))}")
        bs = []
        for s in ss:
            full = vals[(s, arm, "B100")]
            for b in BRANCHES:
                v = vals[(s, arm, b)]
                if v["r"] >= full["r"] - 0.001 and (not math.isfinite(full["late"]) or v["late"] >= full["late"] - 0.005):
                    bs.append(b)
                    break
        print(f"| {arm} | " + " | ".join(cells) + f" | {' '.join(bs)} |")
    print("\nScheduler (Discover):\n")
    print("| arm | missed % | bg settle per frame | look-back busy % |")
    print("| --- | --- | --- | --- |")
    for arm in ARMS:
        sc = [sched(S / f"{s}_{arm}_s1") for s in names if Path(str(S / f"{s}_{arm}_s1") + ".log").exists()]
        if sc:
            print(f"| {arm} | {fmt(np.mean([x['missed'] for x in sc]), 2)} | {fmt(np.mean([x['dose'] for x in sc]), 2)} | {fmt(np.mean([x['lb_busy'] for x in sc]), 0)} |")


# ------------------------------------------------------------------------------------------------ chrome


def chrome(root: Path) -> None:
    """Chrome anchor, n = 1 per arm: final libraries of the app (with today's Final settle)."""
    old = Path.home() / "Projects/cala-data/runs/work-slider-refit/chrome"
    new = root / "chrome"
    L = lambda d, t: CA.load_lib(d / f"{t}-final.json")  # noqa: E731
    Lv = lambda d, t: CA.load_lib(d / f"{t}-live.json")  # noqa: E731
    print("# Chrome anchor (n = 1 per arm; app's Final settle)\n")
    for rec, refs, arms in (
        ("sa", [(old, "sa-max-off"), (new, "sa-max-off-r2")], [(old, "sa-p30-off", "P-30"), (old, "sa-p30-on", "S-30"), (new, "sa-p60-off", "P-60"), (new, "sa-p60-on", "S-60")]),
        ("sb", [(old, "sb-max-off"), (new, "sb-max-off-r2")], [(old, "sb-p30-off", "P-30"), (old, "sb-p30-on", "S-30"), (new, "sb-p60-off", "P-60"), (new, "sb-p60-on", "S-60")]),
    ):  # fmt: skip
        print(f"## {RECS[rec]}\n")
        R = [L(d, t) for d, t in refs]
        if len(R) == 2:
            mp = match_pairs(R[0], R[1])
            print(f"REF-REF agreement (null, n = 1 pair) {fmt(float(np.median([c for *_, c in mp])))}; "
                  f"cells {len(R[0])} / {len(R[1])}, matched {len(mp)}\n")  # fmt: skip
        print("| arm | cells | agreement with REF (each REF run) | REF cells present % (each) | REF cells matched by both REF runs present % | live agreement with REF final |")
        print("| --- | --- | --- | --- | --- | --- |")
        both = None
        if len(R) == 2:
            both = {i for i, _, _ in match_pairs(R[0], R[1])}
        for d, t, name in arms:
            A = L(d, t)
            ags, pres = [], []
            for Rr in R:
                m = match_pairs(Rr, A)
                ags.append(float(np.median([c for *_, c in m])) if m else math.nan)
                pres.append(100 * len(m) / max(len(Rr), 1))
            bp = "-"
            if both is not None:
                got = {i for i, _, _ in match_pairs(R[0], A)}
                bp = fmt(100 * len(both & got) / max(len(both), 1), 1)
            live = agree(Lv(d, t), R[0])
            pa = json.loads((d / f"{t}-probe.json").read_text())["probe"]["atFramesDone"]
            cs = pa["lb"].get("csettle") or {}
            name = f"{name} (dose {cs.get('requested', 0) / max(pa['fwd'], 1):.2f}, missed {100 * pa['drop'] / max(pa['fwd'] + pa['drop'], 1):.1f} %)"
            print(f"| {name} | {len(A)} | {' / '.join(fmt(x) for x in ags)} | {' / '.join(fmt(x, 1) for x in pres)} | {bp} | {fmt(live)} |")
        live_ref = agree(Lv(*refs[0]), R[0])
        print(f"\nREF live vs REF final (same run): {fmt(live_ref)}\n")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["real", "sims", "chrome"])
    ap.add_argument("--root", type=Path, default=ROOT)
    a = ap.parse_args(argv)
    {"real": real, "sims": sims, "chrome": chrome}[a.what](a.root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
