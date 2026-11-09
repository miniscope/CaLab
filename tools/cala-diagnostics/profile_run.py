#!/usr/bin/env python3
"""Summarize native cala stage timings and operation-count proxies.

Requires numpy; --plot additionally requires matplotlib. This reports measured
native stage durations, not browser throughput or private-stage wall times.
"""

import argparse
import csv
import json
import io
from pathlib import Path

import numpy as np

CORE = ["pre_ms", "fast_ms", "observe_ms", "step_ms", "swap_ms"]
DIAGNOSTICS = ["spatial_diag_ms", "ledger_ms", "evolution_ms"]


def statistics(values):
    return {
        "mean_ms": float(np.mean(values)),
        "p50_ms": float(np.percentile(values, 50)),
        "p99_ms": float(np.percentile(values, 99)),
        "max_ms": float(np.max(values)),
        "total_seconds": float(np.sum(values) / 1000),
    }


def summarize(run, fps):
    text = (run / "timings.tsv").read_text()
    # Do not accept a partial numeric field from a running writer.
    if text and not text.endswith("\n"):
        text = text[: text.rfind("\n") + 1]
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    fields = reader.fieldnames
    rows = [row for row in reader if None not in row.values()]
    if not rows:
        raise ValueError("No complete timing rows found")
    values = {key: np.array([float(row[key]) for row in rows]) for key in fields}
    count = len(rows)
    total = sum(values[key].sum() for key in CORE)
    report = {
        "run": str(run),
        "frames": count,
        "fps": fps,
        "recording_minutes": count / fps / 60,
        "stages": {},
        "work_proxy": {},
        "per_minute": [],
        "caveats": [
            "Exploratory native timings; concurrent processes may affect durations.",
            "Core timers exclude diagnostics, file input, setup, and finalization.",
            "Private-stage work counters estimate operations, not wall time.",
            "Native discovery observes all frames; browser forwarding is load-dependent.",
        ],
    }
    for key in CORE + DIAGNOSTICS:
        report["stages"][key] = statistics(values[key])
        report["stages"][key]["fraction_of_core_time"] = float(values[key].sum() / total)
    work = {key: float(values[key].sum()) for key in fields if key.startswith("work_")}
    work_total = sum(work.values())
    report["work_proxy"] = {
        key: {"operations": value, "fraction": value / work_total if work_total else 0}
        for key, value in work.items()
    }
    frame_ms = sum(values[key] for key in CORE)
    report["core_per_frame"] = statistics(frame_ms)
    report["core_per_frame"]["fraction_gt_nominal_frame_interval"] = float(
        np.mean(frame_ms > 1000 / fps)
    )
    report["core_per_frame"]["idealized_fps"] = float(1000 / np.mean(frame_ms))
    for minute in range(int(np.ceil(count / fps / 60))):
        selected = (values["frame"] >= minute * 60 * fps) & (
            values["frame"] < (minute + 1) * 60 * fps
        )
        if selected.any():
            report["per_minute"].append(
                {
                    "minute": minute + 1,
                    "frames": int(selected.sum()),
                    **{key: float(values[key][selected].mean()) for key in CORE},
                }
            )
    return report


def plot(report, output):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    figure, axes = plt.subplots(1, 2, figsize=(12, 4), layout="constrained")
    minutes = report["per_minute"]
    labels = ["Preprocess + motion", "Trace solve", "Discovery observe", "Discovery step", "Library swap"]
    colors = ["#0072B2", "#009E73", "#E69F00", "#D55E00", "#CC79A7"]
    bottom = np.zeros(len(minutes))
    for key, label, color in zip(CORE, labels, colors):
        heights = np.array([minute[key] for minute in minutes])
        axes[0].bar(
            [minute["minute"] for minute in minutes], heights,
            bottom=bottom, label=label, color=color,
        )
        bottom += heights
    axes[0].set(
        xlabel="Recording minute", ylabel="Mean measured ms/frame",
        title="Native processing stages over the session",
    )
    axes[0].legend(fontsize=8)
    work = report["work_proxy"]
    axes[1].barh(
        [key.removeprefix("work_") for key in work],
        [100 * entry["fraction"] for entry in work.values()], color="#0072B2",
    )
    axes[1].set(
        xlabel="Share of estimated work (%)",
        title="Discovery operation-count proxy (not wall time)",
    )
    figure.suptitle(
        "Exploratory native profiling; concurrent workloads; browser scheduling differs",
        fontsize=10,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output, dpi=180)
    plt.close(figure)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--fps", type=float, default=20)
    parser.add_argument("--plot", type=Path, help="Optional output PNG")
    args = parser.parse_args()
    if not np.isfinite(args.fps) or args.fps <= 0:
        parser.error("--fps must be finite and positive")
    report = summarize(args.run, args.fps)
    output = args.run / "profile_summary.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    if args.plot:
        plot(report, args.plot)
    print(f"{report['frames']} frames summarized in {output}")


if __name__ == "__main__":
    main()
