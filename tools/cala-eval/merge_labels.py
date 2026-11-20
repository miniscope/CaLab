"""Labelled merge candidates from merge logs (`qc_eval --merge-log`, diagnostics build).

For every run directory given (`<suite>/<arm>/<sim>` holding `merges.jsonl`,
`removals.tsv`, `final.tsv`), each logged merge test at overlap >= 0.5 is a row:
  dup   both cells' best GT unit is the same (duplicate or fragment: should merge)
  pair  different best GT units, both cells at r >= 0.5 and the weaker-matched one
        not a blend of the other's unit (gt2 != other's unit or gt2_r < gt_r - 0.1)
  amb   anything else
Accepted merges are linked to the removal they caused (`removals.tsv`, same frame and
id), giving the gone cell; a pair merge is `harmful` when the gone cell's unit is not
matched in the run's final library (`final.tsv`). The labelled-pair table is per
unique (run, lo, hi): a real pair must be rejected at every retest, a duplicate needs
one accept. Writes OUT.tsv (one row per test, with features) and prints a summary.
Usage: merge_labels.py OUT.tsv RUN_DIR ...
"""
import csv, json, math, sys
from pathlib import Path
import numpy as np


def tsv(p):
    return list(csv.DictReader(open(p), delimiter="\t")) if p.exists() else []


def label(a, b):
    ga, gb = a.get("gt", -1), b.get("gt", -1)
    if ga >= 0 and ga == gb:
        return "dup"
    if ga >= 0 and gb >= 0 and a["gt_r"] >= 0.5 and b["gt_r"] >= 0.5:
        for x, y in ((a, b), (b, a)):
            if x.get("gt2", -1) == y["gt"] and x.get("gt2_r", 0) >= x["gt_r"] - 0.1:
                return "amb"
        return "pair"
    return "amb"


def _peak(pix, val, w, sigma=1.5):
    """Peak (y, x) of a light estimate after PSF smoothing (sigma px)."""
    pix = np.asarray(pix, int)
    val = np.asarray(val, float)
    if len(pix) == 0:
        return None
    y, x = pix // w, pix % w
    y0, x0 = y.min(), x.min()
    img = np.zeros((y.max() - y0 + 1, x.max() - x0 + 1))
    img[y - y0, x - x0] = val
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    img = np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 0, img)
    img = np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 1, img)
    iy, ix = np.unravel_index(np.argmax(img), img.shape)
    return np.array([iy + y0, ix + x0], float), img, (y0, x0)


def peaks(r):
    w = r["width"]
    out = {}
    P = {}
    for key in ("a", "b"):
        c = r[key]
        if "st_h" not in c:
            return dict(pk_dist=math.nan, pk_jit=math.nan, cur_dist=math.nan)
        P[key] = _peak(c["st_pix"], c["st_h"], w)
        jit = []
        if "st_ha" in c:
            for hk in ("st_ha", "st_hb"):
                q = _peak(c["st_pix"], c[hk], w)
                jit.append(np.hypot(*(q[0] - P[key][0])))
        out[key + "_jit"] = max(jit) if jit else math.nan
        cp = _peak(c["pix"], c["filt"], w)
        out[key + "_cur"] = cp[0]
    d = float(np.hypot(*(P["a"][0] - P["b"][0])))
    return dict(pk_dist=d, pk_jit=max(out["a_jit"], out["b_jit"]),
                cur_dist=float(np.hypot(*(out["a_cur"] - out["b_cur"]))))


def feats(r):
    c0 = np.array(r.get("pair_c0", []), float)
    c1 = np.array(r.get("pair_c1", []), float)
    e0 = float((c0**2).sum() * r.get("pair_q0", 1.0))
    e1 = float((c1**2).sum() * r.get("pair_q1", 1.0))
    tc = float(np.corrcoef(c0, c1)[0, 1]) if len(c0) > 2 and c0.std() > 0 and c1.std() > 0 else math.nan
    cp = np.array(r["chi_pair"], float)
    mu, s = r["mu"], r["s"]
    drops = [(float(np.sum(r[f"solo_chi{k}"]) - cp.sum()) - mu) / s for k in (0, 1) if f"solo_chi{k}" in r]
    sep = cp.sum() if "chi_refit" not in r else min(cp.sum(), float(np.sum(r["chi_refit"])))
    best = sep + mu - r["z"] * s  # best alternative arm's total chi2
    rf = float(np.sum(r["rf_chi"])) if "rf_chi" in r else math.nan
    z_rf = (mu - (best - min(sep, rf))) / s if "rf_chi" in r else r["z"]
    rad = 0.5 * (r.get("rf_ra", math.nan) + r.get("rf_rb", math.nan))
    rfe = dict(z_rf=z_rf, rf_share=r.get("rf_share", math.nan), rf_two=int(r.get("rf_two", False)),
               rf_made=int(r.get("rf_made", False)), rf_ovl=r.get("rf_ovl", math.nan),
               rf_cross=max(r.get("rf_cross_a", math.nan), r.get("rf_cross_b", math.nan)),
               rf_crossmin=min(r.get("rf_cross_a", math.nan), r.get("rf_cross_b", math.nan)),
               rf_dist=r.get("rf_dist", math.nan) / rad if rad > 0 else math.nan)
    return dict(**rfe, **peaks(r), tcorr=tc, eshare=min(e0, e1) / max(e0, e1) if max(e0, e1) > 0 else 0.0,
                dropmin=min(drops) if drops else math.nan, dropmax=max(drops) if drops else math.nan)


rows = []
for d in map(Path, sys.argv[2:]):
    log = d / "merges.jsonl"
    if not log.exists():
        continue
    run = f"{d.parent.name}/{d.name}"
    matched = {int(float(x["best_gt"])) for x in tsv(d / "final.tsv") if int(float(x["matched"])) == 1}
    rem = {(int(x["frame"]), int(x["id"])) for x in tsv(d / "removals.tsv") if x["kind"] == "merge"}
    for line in open(log):
        r = json.loads(line)
        if r["ovl"] < 0.5:
            continue
        a, b = r["a"], r["b"]
        lab = label(a, b)
        gone = None
        if r["accept"]:
            if (r["frame"], r["lo"]) in rem:
                gone = (a, b)
            elif (r["frame"], r["hi"]) in rem:
                gone = (b, a)
        harm = int(bool(gone) and lab == "pair" and gone[0]["gt"] not in matched)
        row = dict(run=run, frame=r["frame"], lo=r["lo"], hi=r["hi"], lab=lab, accept=int(r["accept"]),
                   harm=harm, ovl=r["ovl"], z=r["z"], one=int(r["one"]), arm=r["arm"],
                   shape=r["shape_excess"] if r["shape_excess"] is not None else math.nan,
                   gt_ra=a.get("gt_r", math.nan), gt_rb=b.get("gt_r", math.nan),
                   born_lo=a["born"], born_hi=b["born"],
                   gone_late=(int(gone[0]["born"] > gone[1]["born"]) if gone else -1))
        row.update(feats(r))
        rows.append(row)
with open(sys.argv[1], "w") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0]), delimiter="\t")
    w.writeheader()
    for r in rows:
        w.writerow({k: (f"{v:.4g}" if isinstance(v, float) else v) for k, v in r.items()})
print("tests at ovl >= 0.5:", len(rows))
