"""Collect measured default small-run metrics and timing; run after completion."""
import argparse
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("--root", type=Path, required=True, help="Benchmark root containing small_runs and simulations")
ap.add_argument("--json", type=Path, help="Output JSON; default ROOT/small_results.json")
a = ap.parse_args()
HERE = a.root.resolve()

def table(path):
    with path.open() as f:
        return list(csv.DictReader(f, delimiter="\t"))

results = {}
for path in sorted((HERE / "small_runs").iterdir()):
    if not path.is_dir():
        continue
    required = ["summary.txt", "timings.tsv", "edits.tsv", "checkpoints.tsv",
                "library_versions.tsv", "finalize_ms.txt", "footprint_history.bin"]
    missing = [name for name in required if not (path / name).exists()]
    if missing:
        print(f"Skipping incomplete {path.name}: missing {', '.join(missing)}", file=sys.stderr)
        continue
    logpath = next((p for p in [path.with_suffix(".log"), path / "run.log"] if p.exists()), None)
    log = logpath.read_text() if logpath else ""
    timing = table(path / "timings.tsv")
    if not timing:
        print(f"Skipping incomplete {path.name}: no timing rows", file=sys.stderr)
        continue
    keys = [k for k in timing[0] if k.endswith("_ms")]
    raw = np.array([[float(row[k]) for k in keys] for row in timing])
    totals = raw.sum(axis=1)
    edits = Counter(row["kind"] for row in table(path / "edits.tsv"))
    totals_work = {k: sum(int(row[k]) for row in timing) for k in timing[0] if k.startswith("work_")}
    work_sum = sum(totals_work.values())
    stats = {}
    for i, k in enumerate(keys):
        arr = raw[:, i]
        stats[k] = dict(mean=float(arr.mean()), p50=float(np.percentile(arr, 50)),
                        p95=float(np.percentile(arr, 95)), p99=float(np.percentile(arr, 99)),
                        max=float(arr.max()), sum_s=float(arr.sum()/1000))
    versions = table(path / "library_versions.tsv")
    sim = HERE / "simulations" / path.name
    inventory_path = sim / "oracle_inventory.json"
    result = dict(summary=(path / "summary.txt").read_text(),
                  checkpoints=table(path / "checkpoints.tsv"), edits=dict(edits),
                  timing=stats,
                  timed_frame_total=dict(mean=float(totals.mean()), p95=float(np.percentile(totals,95)),
                                         p99=float(np.percentile(totals,99)), max=float(totals.max()),
                                         over50ms=int((totals > 50).sum()), frames=len(totals)),
                  work_totals=totals_work,
                  work_share={k:v/work_sum for k,v in totals_work.items()},
                  versions=len(versions), history_mb=(path / "footprint_history.bin").stat().st_size/1e6,
                  publication_changed_counts=[int(v["changed"]) for v in versions],
                  finalize_ms=float((path / "finalize_ms.txt").read_text()),
                  inventory=json.loads(inventory_path.read_text()) if inventory_path.exists() else None)
    real = re.search(r"^real ([\d.]+)$", log, re.M)
    result["wall_s"] = float(real.group(1)) if real else None
    result["pass1_log"] = next((line for line in log.splitlines() if line.startswith("pass 1:")), None)
    result["pass2_log"] = next((line for line in log.splitlines() if line.startswith("pass 2:")), None)
    results[path.name] = result
(a.json or HERE / "small_results.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps({k: {q:r[q] for q in ["wall_s", "summary", "edits", "timed_frame_total", "finalize_ms", "history_mb"]} for k,r in results.items()}, indent=2))
