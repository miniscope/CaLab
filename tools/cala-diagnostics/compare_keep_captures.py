"""Apply frozen candidates/thresholds to captured Minisim keep-probes, descriptively."""
import argparse
import csv
import json
from pathlib import Path

import numpy as np
from background_models import compare_snapshot, read_tsv

import replay_keep as _replay


def dump_tsv(path, rows):
    if not rows:
        return
    keys = list(dict.fromkeys(k for row in rows for k in row))
    with path.open("w") as f:
        writer = csv.DictWriter(f, fieldnames=keys, delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)


def shifted_column(fp, shape, offset):
    pixels, _, values = fp
    h, w = shape
    y = pixels.astype(np.int64) // w + offset[0]
    x = pixels.astype(np.int64) % w + offset[1]
    valid = (y >= 0) & (y < h) & (x >= 0) & (x < w)
    return dict(zip((y[valid]*w+x[valid]).tolist(), values[valid].astype(float).tolist()))


def sparse_pearson(a, b):
    union = list(a.keys() | b.keys())
    av = np.array([a.get(p, 0.0) for p in union])
    bv = np.array([b.get(p, 0.0) for p in union])
    if np.std(av) <= 0 or np.std(bv) <= 0:
        return 0.0
    return float(np.corrcoef(av, bv)[0, 1])


def footprint_context(case, folder, manifest):
    run = case / "run"
    target = int(manifest["target"])
    labels = {int(r["id"]): r for r in read_tsv(run / "labels.tsv")}
    label = labels.get(target)
    result = dict(final_class=label["class"] if label else "missing",
                  final_anchor_gt_slot=int(label["gt"]) if label else None,
                  final_reported_best_gt_r=float(label["r"]) if label else None)
    if label is None or int(label["gt"]) < 0:
        return result
    gt_units = {int(r["slot"]): r for r in read_tsv(run / "gt_units.tsv")}
    unit = gt_units.get(int(label["gt"]))
    if unit is None:
        return result
    shape, fps = _replay.read_fp(run / "gt_footprints.bin")
    gt_id = int(unit["oracle_id"])
    if gt_id not in fps:
        return result
    result.update(final_anchor_gt_oracle_id=gt_id,
                  final_anchor_gt_detectable=unit["detectable"],
                  final_anchor_gt_peak_snr=float(unit["peak_snr"]))
    offset_row = read_tsv(run / "gt_offset.tsv")[0]
    offset = (int(offset_row["dy"]), int(offset_row["dx"]))
    result.update(gt_alignment_dy=offset[0], gt_alignment_dx=offset[1])
    _, working = _replay.read_fp(folder / "target_working.bin")
    if target in working:
        det = shifted_column(working[target], shape, offset)
        gt = shifted_column(fps[gt_id], shape, (0, 0))
        result["working_vs_final_anchor_gt_r"] = sparse_pearson(det, gt)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--metrics", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    metrics = read_tsv(args.metrics)
    thresholds = {}
    for r in metrics:
        if r["anatomy"] == "pooled" and r["group"] == "negative_all":
            thresholds.setdefault(r["model"], {})[r["operating"]] = float(r["threshold"])
    rows = []
    manifests = sorted(args.captures.glob("*/manifest.json"))
    if not manifests:
        parser.error("--captures must contain case subdirectories with manifest.json")
    for path in manifests:
        manifest = json.loads(path.read_text())
        assert manifest["exit_code"] == 0 and manifest["final_footprints_identical_to_baseline"], path
        case = path.parent
        folders = sorted((case / "capture").glob("keep_*"))
        if not folders:
            parser.error("case capture directory has no keep snapshots")
        for folder in folders:
            meta = {r["key"]: r["value"] for r in read_tsv(folder / "meta.tsv")}
            probes = read_tsv(folder / "probes.tsv")
            context = footprint_context(case, folder, manifest)
            for row in compare_snapshot(folder):
                model = row["variant"]
                n_bg = 9 if model == "no_bump" else int(meta["n_bg"])
                dof = max(int(meta["fov_pixels"]) - n_bg - int(meta["n_full"]), 1)
                s2 = max(row["raw_full"] / dof, 1.0)
                row.update(case=case.name, simulation=manifest["case"], category=manifest["category"],
                           dof_scale_convention=dof, residual_scale=s2,
                           score=row["objective_gain"] / s2, raw_score=row["raw_gain"] / s2,
                           slow_frame=int(meta["slow_frame"]), tile=int(meta["tile"]),
                           **context)
                probe = probes[row["probe_index"]]
                row.update(native_outcome=probe["outcome"],
                           native_score=float(probe["normalized_gain"]))
                for operating, threshold in thresholds[model].items():
                    row["threshold_" + operating] = threshold
                    row["pass_" + operating] = row["score"] > threshold
                rows.append(row)
        print(case.name, "keep_snapshots", len(folders), flush=True)
    groups = {}
    for row in rows:
        groups.setdefault((row["case"], row["variant"]), []).append(row)
    summary = []
    for (case, model), group in groups.items():
        first = group[0]
        item = dict(case=case, category=first["category"], target_id=first["target_id"],
                    model=model, snapshots=len({r["snapshot"] for r in group}), probes=len(group),
                    mean_score=float(np.mean([r["score"] for r in group])),
                    median_score=float(np.median([r["score"] for r in group])),
                    min_score=min(r["score"] for r in group), max_score=max(r["score"] for r in group),
                    mean_raw_score=float(np.mean([r["raw_score"] for r in group])),
                    negative_raw_gain_count=sum(r["raw_gain"] < -1e-6 for r in group),
                    final_class=first["final_class"], final_reported_best_gt_r=first["final_reported_best_gt_r"],
                    mean_working_vs_final_anchor_gt_r=float(np.mean([r["working_vs_final_anchor_gt_r"] for r in group]))
                    if all("working_vs_final_anchor_gt_r" in r for r in group) else None,
                    min_working_vs_final_anchor_gt_r=min((r["working_vs_final_anchor_gt_r"] for r in group
                                                        if "working_vs_final_anchor_gt_r" in r), default=None),
                    max_working_vs_final_anchor_gt_r=max((r["working_vs_final_anchor_gt_r"] for r in group
                                                        if "working_vs_final_anchor_gt_r" in r), default=None))
        for operating, threshold in thresholds[model].items():
            count = sum(r["pass_" + operating] for r in group)
            item["threshold_" + operating] = threshold
            item["passes_" + operating] = count
            item["pass_rate_" + operating] = count / len(group)
        summary.append(item)
    args.out.mkdir(parents=True, exist_ok=True)
    dump_tsv(args.out / "probes.tsv", rows)
    dump_tsv(args.out / "cells.tsv", summary)
    (args.out / "probes.json").write_text(json.dumps(rows, indent=2, allow_nan=False))
    (args.out / "cells.json").write_text(json.dumps(summary, indent=2, allow_nan=False))
    config = dict(cases=len(manifests), probe_count=len(rows)//9, model_rows=len(rows),
                  threshold_source=str(args.metrics), candidate_parameters="fixed variant_manifest.json",
                  score="objective gain / max(full rawRSS/(fov count - bg count - full cell count),1)",
                  interpretation="Descriptive pass rates on selected probes, not FPR or independent-binomial rates.",
                  gt_correlation="Filtered unwhitened footprint Pearson r over union support, applying run's fixed motion offset to working footprint. GT anchor is the final label's matched/best GT slot, not selected per probe.",
                  limitations=["Thresholds calibrated on the developmental ID18 A/B tile control mixture; application to new geometries is a transfer test, not geometry-specific null calibration.",
                               "Retained GT cells may have weak early working footprints; probe rows retain that r.",
                               "Tentative unexplained cells are not established false detections or diffuse-only nulls.",
                               "Multiple probes from one cell/simulation are dependent; offline decisions do not modify later runtime state."])
    (args.out / "config.json").write_text(json.dumps(config, indent=2))
    print(json.dumps(config))


if __name__ == "__main__":
    main()
