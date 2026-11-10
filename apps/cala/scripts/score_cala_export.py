#!/usr/bin/env python
"""Score a cala export (`<folder>_cala.npz`) against the truth of a MiniMe synthetic session.

    <minime>/.venv/bin/python apps/cala/scripts/score_cala_export.py <export.npz> <session>/meta.json
        [--json out.json]

The export's sparse footprints become the unit matrix ``A`` (units x H*W), its
traces (cells x frames) and the recorded rigid shifts (frames x (dy, dx)) go to
``minime.score.score_run``, which matches units to the true cells (correcting
the motion-template offset) and reports recall, precision, trace correlation and
recall per cell category. Needs the MiniMe package (``from minime import score``).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import sparse

from minime import score


def load_export(path: Path) -> dict:
    z = np.load(path)
    starts = z["footprint_starts"].astype(np.int64)
    pixels = z["footprint_pixels"].astype(np.int64)
    values = z["footprint_values"].astype(np.float32)
    h, w = (int(v) for v in z["fov_shape"])
    n = len(starts) - 1
    A = sparse.csr_matrix((values, pixels, starts), shape=(n, h * w))
    return {
        "A": A,
        "traces": z["traces"].astype(np.float32),
        "shifts": z["motion_shift_yx"].astype(np.float64),
        "H": h,
        "W": w,
        "meta": json.loads(z["meta_json"].tobytes().decode("utf-8")),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("export", type=Path)
    ap.add_argument("meta", type=Path, help="the session's meta.json (truth.npz next to it)")
    ap.add_argument("--json", type=Path, help="also write the scores here")
    a = ap.parse_args()
    e = load_export(a.export)
    traces = e["traces"]
    truth_frames = json.loads(a.meta.read_text())["frames"]
    if traces.shape[1] < truth_frames:
        # A live run that ended early, or dropped frames: pad with NaN so the scorer can align.
        pad = np.full((traces.shape[0], truth_frames - traces.shape[1]), np.nan, np.float32)
        traces = np.concatenate([traces, pad], axis=1)
        print(f"note: {e['traces'].shape[1]} frames in the export, {truth_frames} in the truth; padded", file=sys.stderr)
    shifts = e["shifts"]
    if shifts.shape[0] < truth_frames:
        shifts = np.concatenate([shifts, np.repeat(shifts[-1:], truth_frames - shifts.shape[0], axis=0)])
    out = score.score_run(e["A"], traces[:, :truth_frames], e["H"], e["W"], a.meta, shifts[:truth_frames])
    out["export"] = str(a.export)
    out["frames"] = int(e["traces"].shape[1])
    out["library_version"] = e["meta"].get("library_version")
    keys = ["n_units", "n_true", "n_matched", "recall", "precision", "f1", "recall_detectable",
            "trace_corr_median", "trace_corr_q25", "median_match_dist_px", "alignment_ok"]
    for k in keys:
        print(f"{k:>22}: {out.get(k)}")
    print("     recall_by_category:", {k: round(v["recall"], 3) for k, v in out["recall_by_category"].items()})
    if a.json:
        a.json.write_text(json.dumps(out, indent=1, default=float))
    return 0


if __name__ == "__main__":
    sys.exit(main())
