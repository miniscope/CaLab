"""Classify GT units matched in arm A (main) but not arm B (replay) and vice versa."""
import sys, json, os
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import demix_metrics as DM

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Projects/cala-data/demix-suite/quick-pass1-discover"
A, B = (sys.argv[2], sys.argv[3]) if len(sys.argv) > 3 else ("main-pass1", "stage2-pass1")
SIMS = ["static_s5", "static_s6", "static_s7", "pairs_s5", "pairs_s6"]
CD = Path.home() / "Projects/cala-data"


def simdir(s):
    return (CD / "demix-bench/measure/pairsim_v2191" / s) if s.startswith("pairs") else (CD / "sims-gt110" / s)


def tsv(p):
    return DM.read_tsv(p) if p.exists() else []


def load(run, h, w, G, gtu):
    fin = tsv(run / "final.tsv")
    _, _, ids, cells, _ = DM.read_library(run / "footprints.bin")
    R = DM.pearson_matrix(cells, G, h, w)  # cells x gt rows
    matched = {int(float(r["best_gt"])): i for i, r in enumerate(fin) if int(float(r["matched"])) == 1}
    adds = tsv(run / "adds.tsv")
    rem = tsv(run / "removals.tsv")
    cen = np.array([[float(r["cy"]), float(r["cx"])] for r in fin])
    return dict(fin=fin, ids=ids, cells=cells, R=R, matched=matched, adds=adds, rem=rem, cen=cen)


def mass_at(cells, y, x, w, excl=None):
    """max over cells of footprint value at pixel (y,x) / that cell's peak."""
    p = int(round(y)) * w + int(round(x))
    best, who = 0.0, -1
    for i, (idx, val) in enumerate(cells):
        if i == excl or val.max() <= 0:
            continue
        k = np.flatnonzero(idx == p)
        if len(k):
            v = val[k[0]] / val.max()
            if v > best:
                best, who = v, i
    return best, who


rows = []
for s in SIMS:
    ra, rb = ROOT / A / s, ROOT / B / s
    if not (ra / "final.tsv").exists():
        continue
    h, w, units, _C = DM.read_oracle(simdir(s) / "oracle.bin")
    gt = tsv(ra / "gt.tsv")
    gtu = [int(float(r["unit"])) for r in gt]
    G = np.stack([DM.dense_patch(units[u]["full"], h, w).ravel() for u in gtu])
    gc = np.array([[float(r["cy"]), float(r["cx"])] for r in gt])
    D = json.loads((ra / "demix_det.json").read_text())["diam_px"]
    dd = np.hypot(gc[:, None, 0] - gc[None, :, 0], gc[:, None, 1] - gc[None, :, 1])
    np.fill_diagonal(dd, 1e9)
    nn = dd.min(1) / D
    a, b = load(ra, h, w, G, gtu), load(rb, h, w, G, gtu)
    for direction, X, Y in (("lost", a, b), ("gained", b, a)):
        for g in sorted(set(X["matched"]) - set(Y["matched"])):
            ci = X["matched"][g]
            cid = X["ids"][ci]
            born = next((int(float(r["recording_frame"])) for r in X["adds"] if int(float(r["id"])) == cid), -1)
            # Y side: best cell for g
            col = Y["R"][:, g]
            j = int(np.argmax(col))
            rj = float(col[j])
            jm = next((gg for gg, ii in Y["matched"].items() if ii == j), None)  # GT j is matched to
            jbest = int(np.argmax(Y["R"][j]))
            # how many GT units does cell j cover at r>=0.5
            nmulti = int((Y["R"][j] >= 0.5).sum())
            dj = float(np.hypot(*(Y["cen"][j] - gc[g]))) / D
            # adds near g in Y
            near_adds = [r for r in Y["adds"] if np.hypot(float(r["cy"]) - gc[g, 0], float(r["cx"]) - gc[g, 1]) < 0.5 * D]
            near_ids = {int(float(r["id"])) for r in near_adds}
            rem = [r for r in Y["rem"] if int(float(r["id"])) in near_ids and int(float(r["id"])) not in Y["ids"]]
            ms, mw = mass_at(Y["cells"], gc[g, 0], gc[g, 1], w)
            if rj >= 0.7:
                cls = "c:conflict"  # cell fits g but Hungarian gave it to someone else (or nobody?)
            elif rj >= 0.4 and dj < 0.5:
                cls = "c:below-thr"
            elif rem:
                cls = "b:" + ",".join(sorted({r["kind"] for r in rem}))
            elif not near_adds:
                cls = "a:never-born"
            else:
                cls = "d:born-alive-elsewhere"
            rows.append(dict(sim=s, dir=direction, g=g, nn=nn[g], snr=float(gt[g]["snr"]), det=int(float(gt[g]["detectable"])),
                             x_r=float(X["R"][ci, g]), x_born=born, y_r=rj, y_cell_d=dj, y_cell_matched_to=jm,
                             y_cell_best=jbest, y_cell_ngt=nmulti, n_adds=len(near_adds),
                             rem=";".join(f"{r['kind']}@{r['recording_frame']}(b{r['born_recording']})" for r in rem),
                             mass=ms, cls=cls))

import csv
out = Path(os.environ.get("OUT", str(Path.home() / "Projects/cala-data/demix-suite/discloss/classify.tsv")))
with open(out, "w") as f:
    wr = csv.DictWriter(f, fieldnames=list(rows[0].keys()), delimiter="\t")
    wr.writeheader()
    for r in rows:
        wr.writerow({k: (f"{v:.3f}" if isinstance(v, float) else v) for k, v in r.items()})
from collections import Counter
for d in ("lost", "gained"):
    print(d, "total", sum(r["dir"] == d for r in rows))
    print("  by sim", dict(Counter(r["sim"] for r in rows if r["dir"] == d)))
    print("  by class", dict(Counter(r["cls"] for r in rows if r["dir"] == d)))
    nnv = np.array([r["nn"] for r in rows if r["dir"] == d])
    print("  nn<0.5D %d, 0.5-1 %d, >=1 %d" % ((nnv < 0.5).sum(), ((nnv >= 0.5) & (nnv < 1)).sum(), (nnv >= 1).sum()))
    print("  det", dict(Counter(r["det"] for r in rows if r["dir"] == d)))
print("wrote", out)
