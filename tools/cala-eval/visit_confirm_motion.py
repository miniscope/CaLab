#!/usr/bin/env python
"""Visit budget confirmation on the full-length motion sim (results/2026-11-24-visit-budget-sweep.md, "Confirmation").

    $MINISIM_PY tools/cala-eval/visit_confirm_motion.py [--root R] [--diagnose ARM,ARM] [--md OUT]

Runs are `visit_budget_sweep.sh run v3_motion_s5 SEED BUDGET STEPS` with FRAMES=9600 (`v3_motion_s5_s<seed>_b<budget>_k<..>_f9600`).
Table: per arm the mean over seeds (and per seed) of visits per Discover frame, cells, false, precision, recall, footprint r,
trace r, bitten share (`visit_budget_summary.one`). Diagnosis of the false cells (estimated cells with no strict match to
a detectable GT unit), per run: best footprint Pearson r to any GT unit (all units, GT moved into cala's frame by the run's
offset), classed as
  split     best unit is detectable and already matched to another estimate (r >= 0.3): a second piece of a real cell;
  dim       best unit is not detectable (r >= 0.3): a real but below-threshold neuron;
  no GT     no unit with r >= 0.3: nothing real under it;
and by QC peak SNR (< 5, the app's low-SNR rule), pass flag, distance from the image edge against the registration's
shift extent (`motion.tsv`), .
Needs numpy, scipy.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import shift as nd_shift

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demix_metrics as DM  # noqa: E402
import visit_budget_summary as VS  # noqa: E402

SIM = "v3_motion_s5"
SIMS_V3 = Path.home() / "Projects/cala-data/sims-v3"


def load_cells_last(run: Path) -> dict:
    """QC rows at the last Discover checkpoint, by library id."""
    rows = DM.read_tsv(run / "cells.tsv")
    last = max(int(float(r["frame"])) for r in rows)
    return {int(float(r["id"])): r for r in rows if int(float(r["frame"])) == last}


def cos_matrix(a, b, hw):
    """Cosine similarity between two lists of sparse footprints."""
    from scipy.sparse import csr_matrix

    def mat(cells):
        r, c, v = [], [], []
        for i, (idx, val) in enumerate(cells):
            r.append(np.full(len(idx), i))
            c.append(idx)
            v.append(val / (np.linalg.norm(val) + 1e-12))
        return csr_matrix((np.concatenate(v), (np.concatenate(r), np.concatenate(c))), shape=(len(cells), hw))

    return (mat(a) @ mat(b).T).toarray()


def diagnose(run: Path, others: list[Path]):
    h, w, units, _C = DM.read_oracle(SIMS_V3 / SIM / "oracle.bin")
    _h, _w, ids, cells, _f = DM.read_library(run / "footprints.bin")
    det = json.loads((run / "demix_det.json").read_text())
    dy, dx = det["offset"]
    nonempty = [k for k, u in enumerate(units) if u["full"][2].max() > 0]
    G = np.stack([DM.dense_patch(units[k]["full"], h, w).ravel() for k in nonempty])
    if np.hypot(dy, dx) >= DM.MIN_OFFSET_PX:
        for r in range(G.shape[0]):
            G[r] = nd_shift(G[r].reshape(h, w), (dy, dx), order=1).ravel()
    R = DM.pearson_matrix(cells, G, h, w)
    isdet = np.array([units[k]["det"] for k in nonempty])
    # "false" as in the sweep tables: qc_eval's own match flag (final.tsv), not the strict re-match
    matched = {k for k, r in enumerate(DM.read_tsv(run / "final.tsv")) if int(float(r["matched"])) == 1}
    mu = {int(r["u"]) for r in DM.read_tsv(run / "demix_cells.tsv")}  # GT unit ids (index into units)
    qc = load_cells_last(run)
    births = DM.read_births(run)
    mot =DM.read_tsv(run / "motion.tsv")
    sh = np.array([[float(m["dy"]), float(m["dx"])] for m in mot])
    ext = float(np.max(np.abs(sh - np.median(sh, axis=0))))
    oth = [DM.read_library(o / "footprints.bin")[3] for o in others]
    rows = []
    for i in range(len(cells)):
        idx, val = cells[i]
        cy, cx = DM.centroid_sparse(idx, val, w)
        j = int(np.argmax(R[i]))
        r = float(R[i, j])
        u = nonempty[j]
        if r < 0.3:
            cls = "no GT"
        elif not isdet[j]:
            cls = "dim"
        elif u in mu:
            cls = "split"
        else:
            cls = "unmatched real"
        q = qc.get(ids[i], {})
        peak = float(q.get("peak_snr", "nan"))
        rows.append({
            "i": i, "false": i not in matched, "cls": cls, "r": r, "cy": cy, "cx": cx,
            "edge": min(cy, cx, h - 1 - cy, w - 1 - cx), "snr": peak,
            "pass": float(q.get("pass", "nan")), "flags": int(float(q.get("flags", "0"))),
            "nn_r": float(q.get("max_neighbour_r", "nan")),
            "fp_edge": float(q.get("fp_edge_frac", "nan")), "elong": float(q.get("fp_elongation", "nan")),
            "fpc": q.get("fp_class", "?"), "born": float(births.get(ids[i], np.nan)),
        })  # fmt: skip
    for k, oc in enumerate(oth):
        C = cos_matrix(cells, oc, h * w).max(1)
        for i, r in enumerate(rows):
            r[f"in_other{k}"] = bool(C[i] >= 0.5)
    return rows, ext


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path.home() / "Projects/cala-data/runs/visit-sweep"))
    ap.add_argument("--diagnose", default="b0.50x k1.2 f9600,b1.00x k1.2 f9600,b2.00x k1.2 f9600,b4.00x k0.3 f9600")
    ap.add_argument("--md", default=None)
    a = ap.parse_args()
    root = Path(a.root)
    runs = []
    for d in sorted(root.glob(f"{SIM}_s*_b*_k*_f9600")):
        if (d / "demix_det.json").exists() and Path(str(d) + ".done").exists():
            r = VS.one(d)
            if r:
                runs.append((d, r))
    out = []
    P = out.append
    arms = sorted({r["scale"] for _d, r in runs})
    P(f"| arm | seeds | visits / Discover frame | visits / settle frame | cells | false | precision | recall | fp r | trace r | bitten |")
    P("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for s in arms:
        rs = [r for _d, r in runs if r["scale"] == s]
        m = lambda k: float(np.mean([r[k] for r in rs]))  # noqa: E731
        per = " / ".join(f"{r['cells']}" for r in sorted(rs, key=lambda r: r["seed"]))
        P(f"| {s:g}x | {len(rs)} (cells {per}) | {m('v_disc'):.3f} | {m('v_settle'):.3f} | {m('cells'):.0f} | {m('false'):.0f} | "
          f"{m('prec'):.4f} | {m('rec'):.4f} | {m('fp_r'):.4f} | {m('tr_r'):.4f} | {m('bitten'):.3f} |")  # fmt: skip
    P("")
    P("Per run:")
    P("")
    P("| run | cells | matched | false | precision | recall | fp r | fp r < 1 D | trace r | bitten | Discover s | settle s | RSS GB |")
    P("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for d, r in sorted(runs, key=lambda x: (x[1]["scale"], x[1]["seed"])):
        P(f"| {r['scale']:g}x s{r['seed']} | {r['cells']} | {r['matched']} | {r['false']} | {r['prec']:.4f} | {r['rec']:.4f} | "
          f"{r['fp_r']:.4f} | {r['fp_r_close']:.4f} | {r['tr_r']:.4f} | {r['bitten']:.3f} | {r['disc_s']:.0f} | {r['settle_s']:.0f} | {r['rss_gb']:.2f} |")  # fmt: skip
    # false-cell diagnosis
    P("")
    P("False-cell diagnosis (pooled over seeds; false = no strict match to a detectable GT unit):")
    P("")
    P("| arm | false | split of a matched real cell | dim (undetectable GT unit) | unmatched detectable | no GT | SNR < 5 | QC fail | edge < 1.5 x shift extent | all cells there |")
    P("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    by_scale = {}
    for d, r in runs:
        by_scale.setdefault(r["scale"], {})[r["seed"]] = d
    detail = {}
    for sc in sorted(by_scale):
        if f"b{sc:.2f}x" not in " ".join(a.diagnose.split(",")):
            continue
        rows_all = []
        for seed, d in by_scale[sc].items():
            rows, ext = diagnose(d, [])
            for rr in rows:
                rr["seed"] = seed
            rows_all += rows
        detail[sc] = rows_all
        f = [r for r in rows_all if r["false"]]
        n = max(len(f), 1)
        c = lambda k: sum(r["cls"] == k for r in f)  # noqa: E731
        near = lambda rs: sum(r["edge"] < 1.5 * ext for r in rs)  # noqa: E731
        P(f"| {sc:g}x | {len(f)} | {c('split')} | {c('dim')} | {c('unmatched real')} | {c('no GT')} | "
          f"{sum(1 for r in f if r['snr'] < 5)} | {sum(1 for r in f if r['pass'] == 0)} | {near(f)} ({near(f) / n:.0%}) | "
          f"{near(rows_all)} of {len(rows_all)} ({near(rows_all) / len(rows_all):.0%}) |")  # fmt: skip
    P(f"\n(shift extent = max |frame shift - median| from `motion.tsv` = {ext:.1f} px; the edge margin is 1.5 x that.)")
    # false rate by edge distance
    P("")
    P("False-cell rate by distance from the image edge (px; pooled over seeds):")
    P("")
    bins = [0, 10, 20, 40, 80, 1000]
    P("| arm | " + " | ".join(f"{bins[k]}-{bins[k + 1]}" for k in range(len(bins) - 1)) + " |")
    P("| --- | " + " | ".join("---:" for _ in bins[:-1]) + " |")
    for sc, rows in detail.items():
        cell = []
        for k in range(len(bins) - 1):
            rs = [r for r in rows if bins[k] <= r["edge"] < bins[k + 1]]
            cell.append(f"{sum(r['false'] for r in rs)} / {len(rs)}")
        P(f"| {sc:g}x | " + " | ".join(cell) + " |")
    P("")
    P("False cells: median QC peak SNR, and the share with a very correlated neighbour (max neighbour r > 0.8):")
    P("")
    P("| arm | median peak SNR false | median peak SNR matched | nn r > 0.8, false | nn r > 0.8, matched |")
    P("| --- | ---: | ---: | ---: | ---: |")
    for sc, rows in detail.items():
        f = [r for r in rows if r["false"]]
        t = [r for r in rows if not r["false"]]
        ms = lambda rs: float(np.nanmedian([r["snr"] for r in rs])) if rs else float("nan")  # noqa: E731
        nn = lambda rs: sum(r["nn_r"] > 0.8 for r in rs) / max(len(rs), 1)  # noqa: E731
        P(f"| {sc:g}x | {ms(f):.1f} | {ms(t):.1f} | {nn(f):.0%} | {nn(t):.0%} |")
    # when the false cells are born, qc_eval's own class of them, and the "split" r
    P("")
    P("Birth frame (`adds.tsv`) of false and matched cells, qc_eval's own class of the false cells (`fp_class` at the last "
      "checkpoint) and the best-GT r of the false cells called splits:")
    P("")
    P("| arm | median birth: false / matched | false born in the last third | matched born in the last third | false by fp_class | split r quartiles |")
    P("| --- | --- | ---: | ---: | --- | --- |")
    for sc, rows in detail.items():
        f = [r for r in rows if r["false"]]
        t = [r for r in rows if not r["false"]]
        last3 = lambda rs: np.nanmean([r["born"] >= 6400 for r in rs if np.isfinite(r["born"])]) if rs else float("nan")  # noqa: E731
        med = lambda rs: float(np.nanmedian([r["born"] for r in rs])) if rs else float("nan")  # noqa: E731
        fc = {}
        for r in f:
            fc[r["fpc"]] = fc.get(r["fpc"], 0) + 1
        sr = [r["r"] for r in f if r["cls"] == "split"]
        q = np.percentile(sr, [25, 50, 75]) if sr else [float("nan")] * 3
        P(f"| {sc:g}x | {med(f):.0f} / {med(t):.0f} | {last3(f):.0%} | {last3(t):.0%} | "
          + ", ".join(f"{k} {v}" for k, v in sorted(fc.items())) + f" | {q[0]:.2f} / {q[1]:.2f} / {q[2]:.2f} |")  # fmt: skip
    # visit-rate profile within each arm (seed 1): visits per observed Discover frame per third of the recording
    P("")
    P("Visits per Discover frame within a run (seed 1, from `global.tsv`): a fixed work budget gives a falling visit rate:")
    P("")
    P("| arm | frames 0-3200 | 3200-6400 | 6400-9600 (Discover only; settle visits excluded) |")
    P("| --- | ---: | ---: | ---: |")
    for sc in sorted(by_scale):
        d = by_scale[sc].get(1)
        if d is None:
            continue
        g = DM.read_tsv(d / "global.tsv")
        lg = Path(str(d) + ".log").read_text()
        st = re.search(r"settle: (\d+) frames in ([\d.]+) s .*?, (\d+) visits", lg)
        settle_v = int(st.group(3))
        fr = np.array([float(x["slow_frames"]) for x in g])
        vs = np.array([float(x["slow_visits"]) for x in g])
        fr_end = float(fr[-1]) - int(st.group(1))
        v_end = vs[-1] - settle_v
        pts = []
        for lo, hi in ((0, 3200), (3200, 6400), (6400, fr_end)):
            vlo = np.interp(lo, fr, vs)
            vhi = np.interp(hi, fr, vs) if hi < fr_end else v_end
            pts.append((vhi - vlo) / max(hi - lo, 1))
        P(f"| {sc:g}x | {pts[0]:.3f} | {pts[1]:.3f} | {pts[2]:.3f} |")
    text = "\n".join(out)
    print(text)
    if a.md:
        Path(a.md).write_text(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
