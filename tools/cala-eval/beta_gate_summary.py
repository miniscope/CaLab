#!/usr/bin/env python
"""Beta gate: look-back Discover + Final settle (main, `?lookback`) against v2.20.0's Discover + Refine.

    python tools/cala-eval/beta_gate_summary.py <dir> [--recs sa,sb,ws]

`<dir>` holds `apps/cala/scripts/memory-measure.mjs --single [--lookback] --headed` outputs tagged
`<rec>-old-<n>` (v2.20.0, Discover then one Refine) and `<rec>-new-<n>` (main, look-back Discover and its Final
settle): `<tag>-final.json` (the final library), `<tag>-probe.json` (exact times), `<tag>.json` (memory samples),
`<tag>.log` and `<tag>.out`. Plan and pass lines: `results/2026-11-22-beta-gate-plan.md`.

Matching is `csettle_app_summary.agreement`'s rule: one-to-one, greedy by footprint cosine, centroids within 12 px,
a match at cosine >= 0.7. Every footprint comparison is a single pair of runs (no averaging of cosines). Needs numpy.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from itertools import permutations
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from csettle_app_summary import load_lib  # noqa: E402

RADIUS, MIN_COS = 12.0, 0.7


def match(a, b):
    """{index in a: (index in b, cosine)} by the greedy one-to-one rule."""
    if not a or not b:
        return {}
    cb = np.array([[p[0], p[1]] for p in b])
    cand = []
    for i, (cy, cx, fa, na) in enumerate(a):
        d = np.hypot(cb[:, 0] - cy, cb[:, 1] - cx)
        for j in np.nonzero(d <= RADIUS)[0]:
            fb, nb = b[j][2], b[j][3]
            dot = sum(v * fb[k] for k, v in fa.items() if k in fb)
            cand.append((dot / (na * nb), i, int(j)))
    cand.sort(reverse=True)
    ua, ub, out = set(), set(), {}
    for c, i, j in cand:
        if c < MIN_COS:
            break
        if i in ua or j in ub:
            continue
        ua.add(i)
        ub.add(j)
        out[i] = (j, c)
    return out


def tags(d: Path, rec: str, arm: str) -> list[str]:
    return sorted(p.name[: -len("-final.json")] for p in d.glob(f"{rec}-{arm}-*-final.json"))


def times(d: Path, tag: str) -> dict:
    """Discover, end stage (Refine or Final settle) and their sum, in s, from the 100 ms probe."""
    p = json.loads((d / f"{tag}-probe.json").read_text())["probe"]
    disc = (p["framesDone"] - p["t0"]) / 1000
    if p.get("refineDone") is not None:
        end = (p["refineDone"] - p["refineStart"]) / 1000
    else:
        end = (p["final"] - p["framesDone"]) / 1000
    return {"discover": disc, "end": end, "total": disc + end, "frames": p["frames"]}


def memory(d: Path, tag: str) -> dict:
    s = json.loads((d / f"{tag}.json").read_text())
    tab = max(max(x.get("rendererFoot") or 0, x.get("rendererRss") or 0) for x in s)
    gpu = max(max(x.get("gpuFoot") or 0, x.get("gpuRss") or 0) for x in s)
    return {"tab": tab / 1024, "gpu": gpu / 1024}


def errors(d: Path, tag: str) -> dict:
    txt = (d / f"{tag}.log").read_text()
    pe = len(re.findall(r"\[pageerror\]|\[PAGE CRASH\]", txt))
    stop = re.search(r"^STOP (.*)$", txt, re.M)
    lb = re.search(r"LOOKBACK_CHECK (\w+)", txt)
    drop = re.findall(r"drop (\d+)/(\d+)", txt)
    return {
        "pageerrors": pe,
        "stop": stop.group(1) if stop else "?",
        "lookback_check": lb.group(1) if lb else "-",
        "dropped": f"{drop[-1][0]}/{drop[-1][1]}" if drop else "-",
    }


def q(x, f):
    return float(np.quantile(np.asarray(x), f)) if len(x) else float("nan")


def rec_report(d: Path, rec: str) -> dict | None:
    old, new = tags(d, rec, "old"), tags(d, rec, "new")
    if len(old) < 2 or not new:
        return None
    L = {t: load_lib(d / f"{t}-final.json") for t in old + new}
    M = {}

    def m(a, b):
        if (a, b) not in M:
            M[(a, b)] = match(L[a], L[b])
        return M[(a, b)]

    print(f"\n## {rec}: old {old}, new {new}\n")
    print("| run | cells | Discover s | end stage s | total s | peak tab GB | GPU GB | page errors | stop | look-back check | dropped |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |")
    rows = {}
    for t in old + new:
        tm, mem, er = times(d, t), memory(d, t), errors(d, t)
        rows[t] = (tm, mem, er)
        print(
            f"| {t} | {len(L[t])} | {tm['discover']:.1f} | {tm['end']:.1f} | {tm['total']:.1f} | {mem['tab']:.2f} | "
            f"{mem['gpu']:.2f} | {er['pageerrors']} | {er['stop']} | {er['lookback_check']} | {er['dropped']} |"
        )

    # Footprint agreement: anchor old a, comparison old b, new k; cells of a matched in b and in k.
    null_med, null_p10, diffs, side_old, side_new = {}, {}, [], [], []
    for a, b in permutations(old, 2):
        cb = [c for _, c in m(a, b).values()]
        null_med[(a, b)] = float(np.median(cb))
        null_p10[(a, b)] = q(cb, 0.1)
        for k in new:
            mk = m(a, k)
            for i, (_, c_old) in m(a, b).items():
                if i in mk:
                    side_old.append(c_old)
                    side_new.append(mk[i][1])
                    diffs.append(mk[i][1] - c_old)
    # The null statistics are symmetric in a, b up to the anchor's cell set: one value per unordered pair.
    und_med = sorted({tuple(sorted(k)): v for k, v in null_med.items()}.items())
    und_p10 = sorted({tuple(sorted(k)): v for k, v in null_p10.items()}.items())
    meds = [v for _, v in und_med]
    p10s = [v for _, v in und_p10]
    spread_med = max(meds) - min(meds) if len(meds) > 1 else 0.0
    spread_p10 = max(p10s) - min(p10s) if len(p10s) > 1 else 0.0
    M_med, M_p10 = max(spread_med, 0.002), max(spread_p10, 0.01)
    med_d = float(np.median(diffs))
    p10_d = q(side_new, 0.1) - q(side_old, 0.1)
    print("\nFootprint agreement (single pairs; cells of the anchor old run found by the other old run and by the new run):\n")
    print(f"- old-old median cosine per pair: {', '.join(f'{v:.4f}' for v in meds)} (spread {spread_med:.4f})")
    print(f"- old-old 10th percentile per pair: {', '.join(f'{v:.4f}' for v in p10s)} (spread {spread_p10:.4f})")
    print(f"- pooled over {len(diffs)} cell comparisons: old side median {np.median(side_old):.4f}, new side {np.median(side_new):.4f}")
    print(f"- A1 median paired difference (new - old) {med_d:+.4f}; line >= -{M_med:.4f}: {'pass' if med_d >= -M_med else 'FAIL'}")
    print(f"- A2 10th percentile, old {q(side_old, 0.1):.4f} new {q(side_new, 0.1):.4f}, difference {p10_d:+.4f}; line >= -{M_p10:.4f}: {'pass' if p10_d >= -M_p10 else 'FAIL'}")
    print(f"- share of cells lower on the new side: {np.mean(np.asarray(diffs) < 0):.0%}")

    # Missing and extra cells, as shares of the run they are measured against.
    miss_old = {(a, b): 1 - len(m(a, b)) / len(L[a]) for a, b in permutations(old, 2)}
    miss_new = {(a, k): 1 - len(m(a, k)) / len(L[a]) for a in old for k in new}
    extra_old = {(b, a): 1 - len(m(b, a)) / len(L[b]) for a, b in permutations(old, 2)}
    extra_new = {(k, a): 1 - len(m(k, a)) / len(L[k]) for a in old for k in new}
    mo, mn = np.mean(list(miss_old.values())), np.mean(list(miss_new.values()))
    eo, en = np.mean(list(extra_old.values())), np.mean(list(extra_new.values()))
    spread_miss = max(miss_old.values()) - min(miss_old.values())
    M_miss = max(spread_miss, 0.02)
    print("\nCells (match at cosine >= 0.7 within 12 px):\n")
    print(f"- counts: old {[len(L[t]) for t in old]}, new {[len(L[t]) for t in new]}")
    print(f"- B1 missing: share of an old run's cells not found, by another old run {mo:.1%} (per pair {', '.join(f'{v:.1%}' for v in miss_old.values())}; spread {spread_miss:.1%}), by a new run {mn:.1%}; difference {mn - mo:+.1%}; line <= +{M_miss:.1%}: {'pass' if mn - mo <= M_miss else 'FAIL'}")
    print(f"- extra (reported): share of a run's cells no old run (the anchor) has: old {eo:.1%}, new {en:.1%}; difference {en - eo:+.1%}")
    # Repeatable cells: found in every old run (anchor = first old run); missed by each new run.
    if len(old) >= 3:
        a0 = old[0]
        rep = [i for i in range(len(L[a0])) if all(i in m(a0, b) for b in old[1:])]
        loo = []
        for a, b, c in [(old[0], old[1], old[2]), (old[0], old[2], old[1]), (old[1], old[2], old[0])]:
            both = [i for i in range(len(L[a])) if i in m(a, b)]
            loo.append(np.mean([i in m(a, c) for i in both]))
        present = [np.mean([i in m(a0, k) for i in rep]) for k in new]
        print(f"- repeatable old cells (in all {len(old)} old runs): {len(rep)}; present in each new run {', '.join(f'{v:.1%}' for v in present)}; leave-one-out (cells two old runs share, present in the third) {', '.join(f'{v:.1%}' for v in loo)}")

    t_old = [rows[t][0]["total"] for t in old]
    t_new = [rows[t][0]["total"] for t in new]
    M_t = max(max(t_old) - min(t_old), 0.05 * np.mean(t_old))
    dt = np.mean(t_new) - np.mean(t_old)
    g_old = [rows[t][1]["tab"] for t in old]
    g_new = [rows[t][1]["tab"] for t in new]
    M_g = max(max(g_old) - min(g_old), 0.10 * np.mean(g_old))
    dg = np.mean(g_new) - np.mean(g_old)
    print("\nTime and memory:\n")
    print(f"- C1 total wall time: old {np.mean(t_old):.1f} s, new {np.mean(t_new):.1f} s ({dt:+.1f} s, {dt / np.mean(t_old):+.0%}); line <= +{M_t:.1f} s: {'pass' if dt <= M_t else 'FAIL'}")
    print(f"- D1 peak tab memory: old {np.mean(g_old):.2f} GB, new {np.mean(g_new):.2f} GB ({dg:+.2f}); line <= +{M_g:.2f} GB and < 6 GB: {'pass' if dg <= M_g and max(g_new) < 6 else 'FAIL'}")
    errs = [
        t
        for t in old + new
        if rows[t][2]["pageerrors"] or rows[t][2]["stop"] != "done" or rows[t][2]["lookback_check"] == "FAIL"
    ]
    print(f"- E1 errors: {'none' if not errs else ', '.join(errs)}: {'pass' if not errs else 'FAIL'}")
    return {
        "A1": med_d >= -M_med,
        "A2": p10_d >= -M_p10,
        "B1": mn - mo <= M_miss,
        "C1": dt <= M_t,
        "D1": dg <= M_g and max(g_new) < 6,
        "E1": not errs,
    }


def _core(lib, frac=0.1):
    """Each footprint cut to its pixels at >= `frac` of its peak (renormalised)."""
    out = []
    for cy, cx, fp, _ in lib:
        mx = max(fp.values())
        k = {px: v for px, v in fp.items() if v >= frac * mx}
        out.append((cy, cx, k, float(np.sqrt(sum(v * v for v in k.values())))))
    return out


def _skirt(fp):
    v = np.array(list(fp.values()))
    return float((v[v < 0.1 * v.max()] ** 2).sum() / (v**2).sum())


def diagnostics(d: Path, rec: str) -> None:
    """POST HOC (added after the runs): self-agreement, footprint size, cores, and the main ?lookback-off control."""
    old, new = tags(d, rec, "old"), tags(d, rec, "new")
    ctl = tags(d, rec, "mainoff")
    L = {t: load_lib(d / f"{t}-final.json") for t in old + new + ctl}

    def pooled(xs, ys, lib=L):
        c = [v for a in xs for b in ys if a != b for _, v in match(lib[a], lib[b]).values()]
        miss = [1 - len(match(lib[a], lib[b])) / len(lib[a]) for a in xs for b in ys if a != b]
        return np.median(c), q(c, 0.1), np.mean(miss)

    print(f"\n## {rec}: diagnostics (post hoc)\n")
    print("| comparison | median cosine | 10th percentile | anchor cells missed |")
    print("| --- | ---: | ---: | ---: |")
    for name, xs, ys in [("old vs old", old, old), ("new vs new", new, new), ("old vs new", old, new)] + (
        [("old vs main ?lookback off", old, ctl)] if ctl else []
    ):
        m_, p_, mi = pooled(xs, ys)
        print(f"| {name} | {m_:.4f} | {p_:.4f} | {mi:.1%} |")
    C = {t: _core(v) for t, v in L.items()}
    for name, xs, ys in [("cores: old vs old", old, old), ("cores: old vs new", old, new)]:
        m_, p_, _ = pooled(xs, ys, C)
        print(f"| {name} | {m_:.4f} | {p_:.4f} | - |")
    print("\n| run | stage | cells | median pixels per footprint | median energy below 10 % of peak |")
    print("| --- | --- | ---: | ---: | ---: |")
    for t in old + new + ctl:
        for k in ("live", "final"):
            f = d / f"{t}-{k}.json"
            if f.exists():
                lib = L[t] if k == "final" else load_lib(f)
                print(
                    f"| {t} | {k} | {len(lib)} | {int(np.median([len(c[2]) for c in lib]))} | "
                    f"{np.median([_skirt(c[2]) for c in lib]):.3f} |"
                )


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path)
    ap.add_argument("--recs", default="sa,sb,ws")
    ap.add_argument("--diag", action="store_true", help="post-hoc diagnostics (added after the runs)")
    a = ap.parse_args(argv)
    if a.diag:
        for rec in a.recs.split(","):
            diagnostics(a.dir, rec)
        return 0
    res = {}
    for rec in a.recs.split(","):
        r = rec_report(a.dir, rec)
        if r:
            res[rec] = r
    if res:
        print("\n## Lines\n")
        keys = list(next(iter(res.values())))
        print("| recording | " + " | ".join(keys) + " |")
        print("| --- | " + " | ".join("---" for _ in keys) + " |")
        for rec, r in res.items():
            print(f"| {rec} | " + " | ".join("pass" if r[k] else "**FAIL**" for k in keys) + " |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
