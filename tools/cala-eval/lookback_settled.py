#!/usr/bin/env python
"""What does a Refine pass do to a library: how far does each footprint move, and does it move toward the truth?

    # sims (ground truth): libraries of one run written by `qc_eval --wrap-libs` (wrap k = after pass k)
    $MINISIM_PY tools/cala-eval/lookback_settled.py sims --root $CALA_DATA/demix-suite/lbreview-full \
        --step "COMBO->COMBO+R=COMBO+R:wrap1:final" --step "D->D+R=DRR:wrap1:wrap2" \
        --step "D+R->D+2R=DRR:wrap2:final" --null "D+R->D+2R" --md out.md
    # real data (no ground truth): the same steps on run directories, plus agreement between libraries
    $MINISIM_PY tools/cala-eval/lookback_settled.py real --run COMBO+R_s1=DIR --run DRR_s1=DIR ... --md out.md

A step is `NAME=ARM:BEFORE:AFTER` with BEFORE/AFTER one of `wrapK` (`footprints_wrapK.bin`) or `final`
(`footprints.bin`). Per cell present in both libraries (same id):

- `rel_l2`: the app's Refine readout, `|a' - a| / |a|` on the footprint weights over the union of the two supports
  (`apps/cala/src/lib/refine-metrics.ts` `footprintChanges`; published footprints are unit-peak, so a change of the
  peak pixel rescales the whole footprint and counts here);
- `shape`: 1 - cosine of the two footprints (scale removed);
- `noise`: the split-half footprint noise before the step (`fp_noise_wrapK.tsv`, `qc_eval --noise-dump`);
- sims: `r0`, `r1`, the Pearson r with the cell's ground-truth unit before and after (the suite's footprint r), and
  the suite's groups (isolated: no other unit within 1.5 D; close-pair: one within 1 D; late: born in the last 20 %).

Per sim the median (or mean) of each number; over sims the mean and a paired t 95 % CI (the suite's rule for run
metrics). RAM: one sim and step at a time; the ground-truth stack is 0.7-1.5 GB (peak about 3.5 GB on a motion sim).
"""

from __future__ import annotations

import argparse
import gc
import math
import sys
from pathlib import Path

import numpy as np
from scipy import sparse, stats
from scipy.ndimage import shift as nd_shift
from scipy.optimize import linear_sum_assignment

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_metrics as DM  # noqa: E402
import demix_suite as DS  # noqa: E402


def lib_path(run: Path, tag: str) -> Path:
    return run / ("footprints.bin" if tag == "final" else f"footprints_{tag}.bin")


def noise_of(run: Path, tag: str) -> dict:
    p = run / ("fp_noise.tsv" if tag == "final" else f"fp_noise_{tag}.tsv")
    if not p.exists():
        return {}
    return {int(r["id"]): float(r["noise"]) for r in DM.read_tsv(p)}


def change(a, b):
    """(rel_l2, shape) of sparse footprints a -> b ((idx, val) each)."""
    ia, va = a
    ib, vb = b
    un = np.union1d(ia, ib)
    xa = np.zeros(len(un))
    xb = np.zeros(len(un))
    xa[np.searchsorted(un, ia)] = va
    xb[np.searchsorted(un, ib)] = vb
    na, nb = np.linalg.norm(xa), np.linalg.norm(xb)
    if na == 0 or nb == 0:
        return math.nan, math.nan
    return float(np.linalg.norm(xb - xa) / na), float(1 - xa @ xb / (na * nb))


def gt_frame(sim: Path, cells, all_det: bool):
    """The suite's ground truth in cala's frame (as `demix_metrics.compute_run`): G, det_idx, cen, nonempty, diam."""
    h, w, units, Ct = DM.read_oracle(sim / "oracle.bin")
    nonempty = np.array([u["full"][2].max() > 0 for u in units])
    det_idx = [k for k, u in enumerate(units) if (u["det"] or all_det) and nonempty[k]]
    G = np.stack([DM.dense_patch(units[k]["full"], h, w).ravel() for k in det_idx])
    diam = float(np.median([2 * np.sqrt((g > 0.5 * g.max()).sum() / np.pi) for g in G]))
    cen = np.array([[u["cy"], u["cx"]] for u in units], dtype=np.float64)
    R = DM.pearson_matrix(cells, G, h, w)
    dy, dx = DM.estimate_offset(cells, units, DM.match(R, det_idx, DM.LOOSE_R), w)
    if np.hypot(dy, dx) >= DM.MIN_OFFSET_PX:
        for r in range(G.shape[0]):
            G[r] = nd_shift(G[r].reshape(h, w), (dy, dx), order=1).ravel()
        cen = cen + np.array([dy, dx])
    return G, det_idx, cen, nonempty, diam, h, w, Ct.shape[1]


def step_rows(run: Path, before: str, after: str, sim: Path | None = None, all_det=False):
    """Per-cell rows of one step in one run."""
    _, _, ids0, c0, _ = DM.read_library(lib_path(run, before))
    h, w, ids1, c1, _ = DM.read_library(lib_path(run, after))
    noise = noise_of(run, before)
    s1 = {c: i for i, c in enumerate(ids1)}
    rows = []
    for i0, cid in enumerate(ids0):
        if cid not in s1:
            continue
        rel, shp = change(c0[i0], c1[s1[cid]])
        rows.append({"id": cid, "i0": i0, "i1": s1[cid], "rel_l2": rel, "shape": shp, "noise": noise.get(cid, math.nan)})
    info = {"n0": len(ids0), "n1": len(ids1), "both": len(rows)}
    if sim is None:
        return rows, info
    # ground truth: the after library fixes the motion offset and the match; r of the same cell before and after
    G, det_idx, cen, nonempty, diam, h, w, T = gt_frame(sim, c1, all_det)
    R1 = DM.pearson_matrix(c1, G, h, w)
    R0 = DM.pearson_matrix(c0, G, h, w)
    m1 = DM.match(R1, det_idx, DM.MATCH_R)
    col = {u: c for c, u in enumerate(det_idx)}
    births = DM.read_births(run)
    ne = np.where(nonempty)[0]
    for r in rows:
        u = m1.get(r["i1"])
        r["r0"] = r["r1"] = r["nn"] = math.nan
        r["born"] = births.get(r["id"], math.nan)
        r["late"] = bool(np.isfinite(r["born"]) and r["born"] >= (1 - DM.LATE_FRAC) * T)
        if u is None:
            continue
        r["r0"], r["r1"] = float(R0[r["i0"], col[u]]), float(R1[r["i1"], col[u]])
        d = np.hypot(cen[ne, 0] - cen[u, 0], cen[ne, 1] - cen[u, 1]) / diam
        d = d[ne != u]
        r["nn"] = float(d.min()) if d.size else math.inf
    del G, R0, R1
    gc.collect()  # the ground-truth stack is 0.7-1.5 GB; without this, steps pile up (9.9 GB peak over the full tier)
    return rows, info


GROUPS = {
    "all": lambda r: True,
    "isolated": lambda r: r.get("nn", math.nan) >= DM.ISOLATED_D,
    "close-pair": lambda r: r.get("nn", math.nan) < DM.CLOSE_D,
    "late-born": lambda r: r.get("late", False),
}


def sim_summary(rows, group="all"):
    """One sim's numbers for a group of cells."""
    g = [r for r in rows if GROUPS[group](r) and np.isfinite(r["rel_l2"])]
    if not g:
        return None
    rel = np.array([r["rel_l2"] for r in g])
    shp = np.array([r["shape"] for r in g])
    noi = np.array([r["noise"] for r in g])
    out = {"n": len(g), "moved": float((rel > 0).mean()), "rel_l2": float(np.median(rel)), "shape": float(np.median(shp)),
           "noise": float(np.nanmedian(noi)) if np.isfinite(noi).any() else math.nan,
           "rel_over_noise": float(np.nanmedian(rel / noi)) if np.isfinite(noi).any() else math.nan}  # fmt: skip
    m = [r for r in g if np.isfinite(r.get("r0", math.nan))]
    if m:
        d = np.array([r["r1"] - r["r0"] for r in m])
        out.update({"n_gt": len(m), "dr_mean": float(d.mean()), "dr_median": float(np.median(d)), "up": float((d > 0).mean()),
                    "r0": float(np.median([r["r0"] for r in m])), "r1": float(np.median([r["r1"] for r in m]))})  # fmt: skip
    return out


def ci(v):
    """mean and paired t 95 % CI over sims."""
    v = np.array([x for x in v if x is not None and np.isfinite(x)], float)
    if len(v) == 0:
        return math.nan, math.nan, math.nan, 0
    if len(v) < 3:
        return float(v.mean()), math.nan, math.nan, len(v)
    hw = stats.t.ppf(0.975, len(v) - 1) * v.std(ddof=1) / math.sqrt(len(v))
    return float(v.mean()), float(v.mean() - hw), float(v.mean() + hw), len(v)


def fmt(v, pct=False, digits=4):
    m, lo, hi, n = ci(v)
    if n == 0:
        return "n/a"
    k = 100 if pct else 1
    f = f"{{:.{1 if pct else digits}f}}"
    s = f.format(k * m) + (" %" if pct else "")
    return s if not np.isfinite(lo) else f"{s} [{f.format(k * lo)}, {f.format(k * hi)}]"


def render(per, steps, null, groups):
    """per[step][sim][group] -> markdown."""
    L = []
    for g in groups:
        L += [f"### {g} cells", "",
              "| step | sims | cells / sim | moved at all | change, app metric (rel. L2) | shape-only change (1 - cos) | split-half noise before | change / noise | r with GT before -> after | mean change in r | share with r up |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]  # fmt: skip
        for name in steps:
            S = [per[name][s].get(g) for s in per[name]]
            S = [x for x in S if x]
            if not S:
                continue
            col = lambda k: [x.get(k) for x in S]  # noqa: E731
            r01 = "n/a"
            if any("r0" in x for x in S):
                r01 = f"{ci(col('r0'))[0]:.4f} -> {ci(col('r1'))[0]:.4f}"
            L.append(f"| {name} | {len(S)} | {np.mean(col('n')):.0f} | {fmt(col('moved'), True)} | {fmt(col('rel_l2'), True)} | {fmt(col('shape'), digits=5)} | {fmt(col('noise'), True)} | {fmt(col('rel_over_noise'), digits=2)} | {r01} | {fmt(col('dr_mean'), digits=5)} | {fmt(col('up'), True)} |")  # fmt: skip
        if null in per:
            L += ["", f"Ratio to the null step ({null}), per sim then mean [95 % CI]:", ""]
            for name in steps:
                if name == null:
                    continue
                for k in ("rel_l2", "shape"):
                    v = [per[name][s][g][k] / per[null][s][g][k] for s in per[name]
                         if s in per[null] and per[name][s].get(g) and per[null][s].get(g) and per[null][s][g][k] > 0]  # fmt: skip
                    L.append(f"- {name}, {k}: {fmt(v, digits=2)} x")
        L.append("")
    return "\n".join(L)


def parse_step(s):
    name, rest = s.split("=", 1)
    arm, before, after = rest.split(":")
    return name, arm, before, after


def cmd_sims(a):
    sims = DS.tier_sims(a.tier, a.only)
    steps = [parse_step(s) for s in a.step]
    per = {name: {} for name, *_ in steps}
    for kind, seed in sims:
        sim = DS.sim_dir(kind, seed, None, None)
        for name, arm, before, after in steps:
            run = a.root / arm / sim.name
            if not lib_path(run, before).exists() or not lib_path(run, after).exists():
                print(f"missing {run} {before}/{after}", file=sys.stderr)
                continue
            rows, info = step_rows(run, before, after, sim, all_det=kind == "pairs")
            per[name][sim.name] = {g: sim_summary(rows, g) for g in GROUPS}
            x = per[name][sim.name]["all"]
            print(f"{sim.name} {name}: {info} rel_l2 {x['rel_l2']:.4f} shape {x['shape']:.5f} dr {x.get('dr_mean', math.nan):+.5f}", flush=True)
    md = render(per, [s[0] for s in steps], a.null, list(GROUPS))
    print(md)
    if a.md:
        a.md.write_text(md + "\n")


# ------------------------------------------------------------------ real data


def to_csr(cells, n_px):
    rows = np.concatenate([np.full(len(i), k) for k, (i, _) in enumerate(cells)])
    cols = np.concatenate([i for i, _ in cells])
    vals = np.concatenate([np.maximum(v, 0) for _, v in cells])
    return sparse.csr_matrix((vals, (rows, cols)), shape=(len(cells), n_px))


def agreement(A, B, thresh=DM.MATCH_R):
    """Hungarian match on whole-frame Pearson r between two sparse libraries (CSR, cells x pixels):
    (matched, len A, len B, median r of the matches)."""
    N = A.shape[1]

    def mom(X):
        m = np.asarray(X.sum(1)).ravel() / N
        s = np.sqrt(np.maximum(np.asarray(X.multiply(X).sum(1)).ravel() / N - m * m, 0)) + 1e-12
        return m, s

    ma, sa = mom(A)
    mb, sb = mom(B)
    R = (np.asarray((A @ B.T).todense()) / N - np.outer(ma, mb)) / np.outer(sa, sb)
    ri, ci_ = linear_sum_assignment(-R)
    ok = R[ri, ci_] >= thresh
    return int(ok.sum()), A.shape[0], B.shape[0], float(np.median(R[ri, ci_][ok])) if ok.any() else math.nan


def read_minian(path: Path, n_px: int, w: int, dy=1):
    """Minian A (units x H x W zarr) as CSR in cala's frame: cala (y, x) is Minian (y + dy, x)."""
    import zarr

    A = zarr.open(str(path / "A.zarr"), mode="r")["A"]
    out = []
    for s in range(0, A.shape[0], 20):
        blk = np.nan_to_num(np.asarray(A[s : s + 20], dtype=np.float64))
        for k in range(blk.shape[0]):
            img = np.roll(blk[k], -dy, axis=0)
            nz = np.flatnonzero(img.ravel() > 0)
            out.append((nz, img.ravel()[nz]))
    return to_csr([c for c in out if len(c[0])], n_px)


def cmd_real(a):
    runs = dict(r.split("=", 1) for r in a.run)
    libs, L = {}, []
    for name, d in runs.items():
        d = Path(d)
        for tag in a.tags.split(","):
            p = lib_path(d, tag)
            if p.exists():
                h, w, ids, cells, _ = DM.read_library(p)
                libs[f"{name}:{tag}"] = (ids, cells, h, w)
    L += ["### Change by id within a run", "",
          "| run | step | cells before / after / in both | moved at all | change, app metric (rel. L2), median [IQR] | shape-only change, median [IQR] | split-half noise before, median | change / noise, median |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |"]  # fmt: skip
    for name, d in runs.items():
        tags = [t for t in a.tags.split(",") if f"{name}:{t}" in libs]
        for b, af in zip(tags, tags[1:]):
            rows, info = step_rows(Path(d), b, af)
            rel = np.array([r["rel_l2"] for r in rows])
            shp = np.array([r["shape"] for r in rows])
            noi = np.array([r["noise"] for r in rows])
            q = lambda v, p: np.nanpercentile(v, p)  # noqa: E731
            hasn = np.isfinite(noi).any()
            L.append(f"| {name} | {b} -> {af} | {info['n0']} / {info['n1']} / {info['both']} | {100 * (rel > 0).mean():.1f} % | {100 * q(rel, 50):.1f} % [{100 * q(rel, 25):.1f}, {100 * q(rel, 75):.1f}] | {q(shp, 50):.4f} [{q(shp, 25):.4f}, {q(shp, 75):.4f}] | {f'{100 * q(noi, 50):.1f} %' if hasn else 'n/a'} | {f'{q(rel / noi, 50):.2f}' if hasn else 'n/a'} |")  # fmt: skip
    keys = list(libs)
    n_px = libs[keys[0]][2] * libs[keys[0]][3]
    csr = {k: to_csr(libs[k][1], n_px) for k in keys}
    if a.minian:
        csr["Minian"] = read_minian(a.minian, n_px, libs[keys[0]][3])
    L += ["", "### Agreement between libraries (Hungarian on footprint r >= 0.7)", "",
          "| A | B | cells A | cells B | matched | share of A | share of B | median r of matches |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]  # fmt: skip
    for pair in a.pair or []:
        ka, kb = pair.split(",")
        m, na, nb, r = agreement(csr[ka], csr[kb])
        L.append(f"| {ka} | {kb} | {na} | {nb} | {m} | {100 * m / na:.1f} % | {100 * m / nb:.1f} % | {r:.4f} |")
    md = "\n".join(L)
    print(md)
    if a.md:
        a.md.write_text(md + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sims")
    s.add_argument("--root", type=Path, required=True, help="suite run root (ARM/SIM under it)")
    s.add_argument("--tier", default="full")
    s.add_argument("--only")
    s.add_argument("--step", action="append", required=True, help="NAME=ARM:BEFORE:AFTER")
    s.add_argument("--null", default="", help="name of the null step (ratios are reported against it)")
    s.add_argument("--md", type=Path)
    r = sub.add_parser("real")
    r.add_argument("--run", action="append", required=True, help="NAME=DIR")
    r.add_argument("--pair", action="append", help="NAME:TAG,NAME:TAG (or Minian) to compare")
    r.add_argument("--minian", type=Path, help="Minian output directory (A.zarr)")
    r.add_argument("--tags", default="wrap1,wrap2,final", help="libraries of each run, in order (e.g. settle0,settle5,final)")
    r.add_argument("--md", type=Path)
    a = ap.parse_args(argv)
    {"sims": cmd_sims, "real": cmd_real}[a.cmd](a)


if __name__ == "__main__":
    main()
