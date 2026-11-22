#!/usr/bin/env python
"""Footprint size against ground truth: where the light of a footprint lies (settle-size study, 22 Nov 2026).

    settle_size.py score  SIM_DIR RUN_DIR OUT.tsv [--lib NAME] [--all-det]   one sim run -> per-cell rows
    settle_size.py tree   LABEL=RUN_TREE ... --out DIR [--names a,b] [--lib NAME]   every run of the trees
    settle_size.py report DIR BASE NEW [--names a,b]        paired table NEW minus BASE (95 % CI over sims)
    settle_size.py real   LABEL=LIBRARY ... [--pair A,B]    libraries without truth (`.bin` CALAFP01 or app `.json`)

Needs numpy and scipy (the minisim venv). GT loading, matching and the motion offset are `demix_metrics`'.

Per matched cell (Hungarian on footprint r >= 0.7, detectable units): the true footprint `g` is scaled to peak 1 and
the estimate `a` is scaled onto it by least squares over the true core (g >= 0.5), so a bitten or noisy peak does not
set the scale. Columns:

* `npos`, `n10`, `n01`: pixels of the scaled estimate above 0, 0.10 and 0.01; `g10`, `g01`: the same for the truth.
* `faintE`: share of the estimate's energy on pixels below 10 % of its own peak (the beta gate's measure);
  `g_faintE`: the same for the truth.
* `missed`: share of the true light (sum g) on pixels where the estimate is 0 (truncation: light left behind).
* `deficit`, `excess`: sum max(g - a, 0) and sum max(a - g, 0) over sum g (light the estimate lacks / has too much).
* `excess_nb`: the part of `excess` on pixels inside another unit's core (that unit's g >= 0.5 of its peak).
* `err_core`, `err_skirt`, `err_far`: squared error sum (a - g)^2 over the zones g >= 0.10, 0.01 <= g < 0.10 and
  g < 0.01, each over the true energy sum g^2. `cos_core`, `cos_skirt`: cosine of a and g inside the first two zones.
* `L_own10`, `L_own01`: share of the estimate's light on the unit's own true support at floors 0.10 and 0.01;
  `L_nbcore`: share on another unit's core and outside the own support at 0.10.
* `pa*`, `pg*`: mean of a and g in rings of 0.25 D around the true centre, out to 3 D.
* `nn_diam`: distance (D) to the nearest other unit's centre; isolated >= 1.5, close < 1.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

NB = 12  # radial bins of 0.25 D
BASE_COLS = [
    "sim", "u", "i", "nn_diam", "r", "npos", "n10", "n01", "g10", "g01", "faintE", "g_faintE", "missed", "deficit",
    "excess", "excess_nb", "err_core", "err_skirt", "err_far", "cos_core", "cos_skirt", "L_own10", "L_own01",
    "L_nbcore",
]  # fmt: skip
COLS = BASE_COLS + [f"pa{k}" for k in range(NB)] + [f"pg{k}" for k in range(NB)]


def _cos(a, g):
    d = float(np.sqrt((a * a).sum() * (g * g).sum()))
    return float((a * g).sum() / d) if d > 0 else float("nan")


def score_run(sim: Path, run: Path, lib: str = "footprints.bin", all_det: bool = False) -> list[dict]:
    import demix_metrics as M
    from scipy.ndimage import shift as nd_shift

    h, w, units, _ = M.read_oracle(sim / "oracle.bin")
    _, _, _ids, cells, _ = M.read_library(run / lib)
    nonempty = np.array([u["full"][2].max() > 0 for u in units])
    det_idx = [k for k, u in enumerate(units) if (u["det"] or all_det) and nonempty[k]]
    G = np.stack([M.dense_patch(units[k]["full"], h, w).ravel() for k in det_idx])
    diam = float(np.median([2 * np.sqrt((g > 0.5 * g.max()).sum() / np.pi) for g in G]))
    cen = np.array([[u["cy"], u["cx"]] for u in units], dtype=np.float64)
    R = M.pearson_matrix(cells, G, h, w)
    dy, dx = M.estimate_offset(cells, units, M.match(R, det_idx, M.LOOSE_R), w)
    moved = np.hypot(dy, dx) >= M.MIN_OFFSET_PX
    if moved:
        for r in range(G.shape[0]):
            G[r] = nd_shift(G[r].reshape(h, w), (dy, dx), order=1).ravel()
        cen = cen + np.array([dy, dx])
        R = M.pearson_matrix(cells, G, h, w)
    match_i = M.match(R, det_idx, M.MATCH_R)
    col = {u: c for c, u in enumerate(det_idx)}
    # per pixel: the largest and second largest peak-normalised true value over all non-empty units, and whose
    m1 = np.zeros(h * w, np.float32)
    m2 = np.zeros(h * w, np.float32)
    who = np.full(h * w, -1, np.int32)
    for k in np.where(nonempty)[0]:
        if k in col:
            g = G[col[k]]
        else:
            g = M.dense_patch(units[k]["full"], h, w)
            g = (nd_shift(g, (dy, dx), order=1) if moved else g).ravel()
        g = g / g.max()
        up = g > m1
        m2 = np.where(up, m1, np.maximum(m2, g))
        who[up] = k
        m1 = np.where(up, g, m1)
    ne = np.where(nonempty)[0]
    yy, xx = np.divmod(np.arange(h * w), w)
    rows = []
    for i, u in sorted(match_i.items()):
        idx, val = cells[i]
        g = G[col[u]].astype(np.float64)
        g = g / g.max()
        a = np.zeros(h * w)
        a[idx] = val
        core = g >= 0.5
        den = float((a[core] ** 2).sum())
        if den <= 0:
            continue
        a *= float((a[core] * g[core]).sum()) / den
        sup = np.where((a > 0) | (g > 0))[0]
        a, g = a[sup], g[sup]
        other = np.where(who[sup] == u, m2[sup], m1[sup])
        gL, gE, aL = g.sum(), (g * g).sum(), a.sum()
        z_core, z_skirt, z_far = g >= 0.10, (g >= 0.01) & (g < 0.10), g < 0.01
        ex = np.maximum(a - g, 0)
        d = np.hypot(cen[ne, 0] - cen[u, 0], cen[ne, 1] - cen[u, 1]) / diam
        d = d[ne != u]
        rad = np.hypot(yy[sup] - cen[u, 0], xx[sup] - cen[u, 1]) / diam
        b = np.minimum((rad / 0.25).astype(int), NB)
        cnt = np.maximum(np.bincount(b, minlength=NB + 1)[:NB], 1)
        pa = np.bincount(b, a, NB + 1)[:NB] / cnt
        pg = np.bincount(b, g, NB + 1)[:NB] / cnt
        own_peak = a.max()
        row = {
            "sim": sim.name, "u": int(u), "i": int(i), "nn_diam": float(d.min()) if d.size else np.inf,
            "r": float(R[i, col[u]]),
            "npos": int((a > 0).sum()), "n10": int((a >= 0.10).sum()), "n01": int((a >= 0.01).sum()),
            "g10": int(z_core.sum()), "g01": int((g >= 0.01).sum()),
            "faintE": float((a[a < 0.1 * own_peak] ** 2).sum() / (a * a).sum()),
            "g_faintE": float((g[g < 0.1] ** 2).sum() / gE),
            "missed": float(g[a <= 0].sum() / gL),
            "deficit": float(np.maximum(g - a, 0).sum() / gL),
            "excess": float(ex.sum() / gL),
            "excess_nb": float(ex[other >= 0.5].sum() / gL),
            "err_core": float(((a - g)[z_core] ** 2).sum() / gE),
            "err_skirt": float(((a - g)[z_skirt] ** 2).sum() / gE),
            "err_far": float(((a - g)[z_far] ** 2).sum() / gE),
            "cos_core": _cos(a[z_core], g[z_core]),
            "cos_skirt": _cos(a[z_skirt], g[z_skirt]),
            "L_own10": float(a[z_core].sum() / aL),
            "L_own01": float(a[g >= 0.01].sum() / aL),
            "L_nbcore": float(a[(other >= 0.5) & ~z_core].sum() / aL),
        }  # fmt: skip
        row.update({f"pa{k}": float(pa[k]) for k in range(NB)})
        row.update({f"pg{k}": float(pg[k]) for k in range(NB)})
        rows.append(row)
    return rows


def write_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        wr = csv.DictWriter(f, COLS, delimiter="\t")
        wr.writeheader()
        for r in rows:
            wr.writerow({k: (f"{v:.6g}" if isinstance(v, float) else v) for k, v in r.items()})


def read_rows(path: Path) -> dict[int, dict]:
    with path.open() as f:
        return {int(r["u"]): {k: (v if k == "sim" else float(v)) for k, v in r.items()} for r in csv.DictReader(f, delimiter="\t")}


def sim_of(name: str) -> Path:
    import os

    root = Path(os.environ.get("CALA_DATA", str(Path.home() / "Projects/cala-data")))
    if name.startswith("pairs_"):
        return root / "demix-bench/measure/pairsim_v2191" / name
    if name.startswith(("v3_", "size6_", "size16_")):
        return root / "sims-v3" / name
    return root / "sims-gt110" / name


def cmd_tree(a) -> int:
    out = Path(a.out)
    for t in a.trees:
        lab, _, p = t.partition("=")
        for run in sorted(Path(p).iterdir()):
            if not (run / a.lib).exists() or (a.names and run.name not in a.names.split(",")):
                continue
            dst = out / lab / f"{run.name}.tsv"
            if dst.exists():
                continue
            rows = score_run(sim_of(run.name), run, a.lib, all_det=run.name.startswith("pairs_"))
            write_rows(dst, rows)
            print(f"{lab} {run.name}: {len(rows)} matched", flush=True)
    return 0


STRATA = {"all": lambda d: True, "isolated": lambda d: d >= 1.5, "close": lambda d: d < 1.0}
REPORT = ["r", "npos", "n10", "n01", "faintE", "missed", "deficit", "excess", "excess_nb", "err_core", "err_skirt",
          "err_far", "cos_core", "cos_skirt", "L_own10", "L_own01", "L_nbcore"]  # fmt: skip


def boot(x: np.ndarray, n=4000, seed=0) -> tuple[float, float]:
    if len(x) < 2:
        return float("nan"), float("nan")
    rng = np.random.default_rng(seed)
    m = x[rng.integers(0, len(x), (n, len(x)))].mean(1)
    return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))


def cmd_report(a) -> int:
    d = Path(a.dir)
    names = sorted({p.stem for p in (d / a.base).glob("*.tsv")} & {p.stem for p in (d / a.new).glob("*.tsv")})
    if a.names:
        names = [n for n in names if n in a.names.split(",")]
    per = {s: {m: ([], [], []) for m in REPORT + ["g10", "g01", "g_faintE"]} for s in STRATA}
    prof = {s: ([], [], []) for s in STRATA}
    ncell = {s: 0 for s in STRATA}
    for nm in names:
        A, B = read_rows(d / a.base / f"{nm}.tsv"), read_rows(d / a.new / f"{nm}.tsv")
        both = sorted(set(A) & set(B))
        for s, keep in STRATA.items():
            us = [u for u in both if keep(A[u]["nn_diam"])]
            if not us:
                continue
            ncell[s] += len(us)
            for m in per[s]:
                va, vb = np.array([A[u][m] for u in us]), np.array([B[u][m] for u in us])
                per[s][m][0].append(np.nanmean(va))
                per[s][m][1].append(np.nanmean(vb))
                per[s][m][2].append(np.nanmean(vb - va))
            prof[s][0].append([np.mean([A[u][f"pa{k}"] for u in us]) for k in range(NB)])
            prof[s][1].append([np.mean([B[u][f"pa{k}"] for u in us]) for k in range(NB)])
            prof[s][2].append([np.mean([A[u][f"pg{k}"] for u in us]) for k in range(NB)])
    print(f"## {a.new} minus {a.base}: {len(names)} sims ({', '.join(names)})\n")
    print("Cells matched to the same true unit in both arms; per-sim means, then the mean over sims; CI over sims.\n")
    for s in STRATA:
        if not ncell[s]:
            continue
        g = per[s]
        print(f"**{s}** ({ncell[s]} cells; truth: {np.mean(g['g10'][0]):.0f} px >= 10 %, {np.mean(g['g01'][0]):.0f} px >= 1 %, "
              f"faint energy {np.mean(g['g_faintE'][0]):.4f})\n")  # fmt: skip
        print(f"| measure | {a.base} | {a.new} | difference [95 % CI] |\n| --- | ---: | ---: | --- |")
        for m in REPORT:
            x = np.array(g[m][2])
            lo, hi = boot(x)
            f = ".0f" if m in ("npos", "n10", "n01") else ".4f"
            print(f"| {m} | {np.mean(g[m][0]):{f}} | {np.mean(g[m][1]):{f}} | {x.mean():+{f}} [{lo:+{f}}, {hi:+{f}}] |")
        pa, pb, pg = (np.mean(prof[s][k], 0) for k in range(3))
        print("\n| ring (D) | " + " | ".join(f"{0.25 * k:.2f}" for k in range(NB)) + " |")
        print("| --- |" + " ---: |" * NB)
        for lab, p in ((a.base, pa), (a.new, pb), ("truth", pg)):
            print(f"| {lab} | " + " | ".join(f"{v:.3f}" for v in p) + " |")
        print()
    return 0


# ----------------------------------------------------------------------------- libraries without truth


def load_any(path: Path):
    """(h, w, [(idx, val)]) from a CALAFP01 `.bin` or an app library `.json`; zero-valued pixels dropped."""
    if path.suffix == ".json":
        d = json.loads(path.read_text())
        px, va, st = np.asarray(d["pixels"], np.int64), np.asarray(d["values"], np.float64), d["starts"]
        cells = [(px[st[s] : st[s + 1]], va[st[s] : st[s + 1]]) for s in range(len(d["ids"]))]
        h, w = d["height"], d["width"]
    else:
        import demix_metrics as M

        h, w, cells = M.read_footprints(path)
    return h, w, [(i[v > 0], v[v > 0]) for i, v in cells if (v > 0).any()], [len(i) for i, _ in cells]


def lib_stats(h, w, cells) -> dict:
    from scipy.ndimage import label

    core = np.zeros(h * w, np.int32)  # how many cells have a pixel in their core (>= 0.5 of peak)
    for idx, v in cells:
        core[idx[v >= 0.5 * v.max()]] += 1
    out = {k: [] for k in ("npos", "n10", "n01", "n50", "faintE", "faintL", "comp", "comp10", "L_oncore", "r90")}
    prof = []
    for idx, v in cells:
        p = v.max()
        y, x = idx // w, idx % w
        out["npos"].append(len(v))
        out["n10"].append(int((v >= 0.1 * p).sum()))
        out["n01"].append(int((v >= 0.01 * p).sum()))
        out["n50"].append(int((v >= 0.5 * p).sum()))
        out["faintE"].append(float((v[v < 0.1 * p] ** 2).sum() / (v * v).sum()))
        out["faintL"].append(float(v[v < 0.1 * p].sum() / v.sum()))
        y0, x0 = y.min(), x.min()
        img = np.zeros((y.max() - y0 + 1, x.max() - x0 + 1))
        img[y - y0, x - x0] = v
        out["comp"].append(label(img > 0, np.ones((3, 3)))[1])
        out["comp10"].append(label(img >= 0.1 * p, np.ones((3, 3)))[1])
        mine = v >= 0.5 * p
        others = (core[idx] - mine) > 0
        out["L_oncore"].append(float(v[others & ~mine].sum() / v.sum()))
        cm = v >= 0.5 * p
        cy, cx = (y[cm] * v[cm]).sum() / v[cm].sum(), (x[cm] * v[cm]).sum() / v[cm].sum()
        rad = np.hypot(y - cy, x - cx)
        o = np.argsort(rad)
        out["r90"].append(float(rad[o][np.searchsorted(np.cumsum(v[o]) / v.sum(), 0.9)]))
        b = np.minimum((rad / 2).astype(int), 15)
        # mean value over the full ring area (pixels outside the support count as 0), over the peak
        ring = np.pi * ((2 * np.arange(1, 16)) ** 2 - (2 * np.arange(15)) ** 2)
        prof.append(np.bincount(b, v, 16)[:15] / ring / p)
    res = {k: float(np.median(v)) for k, v in out.items()}
    res["multi_comp"] = float(np.mean(np.array(out["comp"]) > 1))
    res["multi_comp10"] = float(np.mean(np.array(out["comp10"]) > 1))
    res["cells"] = len(cells)
    res["prof"] = np.median(np.array(prof), 0)
    return res


def cmd_real(a) -> int:
    libs = {}
    for t in a.libs:
        lab, _, p = t.partition("=")
        h, w, cells, stored = load_any(Path(p))
        libs[lab] = (h, w, cells)
        s = lib_stats(h, w, cells)
        if not libs or len(libs) == 1:
            print("| library | cells | stored px | px > 0 | px >= 1 % | px >= 10 % | px >= 50 % | faint energy | faint light | "
                  "radius of 90 % light | light on other cells' cores | > 1 piece | > 1 piece at 10 % |")  # fmt: skip
            print("| --- |" + " ---: |" * 12)
        print(f"| {lab} | {s['cells']} | {np.median(stored):.0f} | {s['npos']:.0f} | {s['n01']:.0f} | {s['n10']:.0f} | "
              f"{s['n50']:.0f} | {s['faintE']:.4f} | {s['faintL']:.3f} | {s['r90']:.1f} | {s['L_oncore']:.3f} | "
              f"{100 * s['multi_comp']:.1f} % | {100 * s['multi_comp10']:.1f} % |", flush=True)  # fmt: skip
        libs[lab] = (h, w, cells, s)
    if a.profile:
        print("\nMedian radial profile (mean value in 2 px rings around the core centroid, over the peak):\n")
        print("| library | " + " | ".join(f"{2 * k}-{2 * k + 2}" for k in range(15)) + " |")
        print("| --- |" + " ---: |" * 15)
        for lab, (_, _, _, s) in libs.items():
            print(f"| {lab} | " + " | ".join(f"{v:.3f}" for v in s["prof"]) + " |")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("score")
    p.add_argument("sim")
    p.add_argument("run")
    p.add_argument("out")
    p.add_argument("--lib", default="footprints.bin")
    p.add_argument("--all-det", action="store_true")
    p = sub.add_parser("tree")
    p.add_argument("trees", nargs="+")
    p.add_argument("--out", required=True)
    p.add_argument("--names", default="")
    p.add_argument("--lib", default="footprints.bin")
    p = sub.add_parser("report")
    p.add_argument("dir")
    p.add_argument("base")
    p.add_argument("new")
    p.add_argument("--names", default="")
    p = sub.add_parser("real")
    p.add_argument("libs", nargs="+")
    p.add_argument("--profile", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "score":
        write_rows(Path(a.out), score_run(Path(a.sim), Path(a.run), a.lib, a.all_det))
        return 0
    return {"tree": cmd_tree, "report": cmd_report, "real": cmd_real}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
