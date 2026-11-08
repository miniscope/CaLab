"""Per-cell activity statistics of cala traces, real vs simulated, measured one way.

    python activity_stats.py RUN_DIR [RUN_DIR ...] [--json OUT.json]

RUN_DIR is the output of ``crates/cala/examples/discover_eval.rs`` (``traces.f32``,
frames x cells, and ``frames.tsv``) on a real recording or on a minisim recording
(``make_trace_sim.py``). Running the same detector and extractor on both keeps
the comparison like for like: the cell selection, the trace floor and the
background model are cala's on both sides.

Per cell and per 60 s window (cala QC's window, ``crates/cala/src/qc``), with the
QC definitions (CaLab robust SNR convention):

* noise sigma: median |frame difference| / 0.6745 / sqrt(2), leaving out
  zero-zero pairs (the trace is floored at 0);
* peak SNR: (mean of the top 1 % - median) / sigma;
* events: maximal runs of the 0.25 s running mean above median + 2 sigma_s whose
  peak reaches median + 4 sigma_s (sigma_s = sigma / sqrt(5)); per event the
  half-height crossings around its peak give the width (FWHM), the rise (half
  height to the first sample at 80 %) and the decay (last sample at 80 % back to
  half height);

and over the whole trace:

* burstiness: fraction of inter-event intervals shorter than 2 s;
* long events: fraction of events wider (FWHM) than 2 s;
* drift: the range (p95 - p5) of a 20 s rolling 20th-percentile baseline, in
  noise sigma; a cell counts as drifting above 5 sigma *and* above 25 % of its
  peak amplitude (top 1 % minus median).

Per-cell values are the median over windows; tables report the quartiles over
cells.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import percentile_filter, uniform_filter1d

FPS = 20.0
WINDOW = 1200  # 60 s, cala QC's window
SMOOTH = 5  # 0.25 s
EVENT_Z = 4.0
MAD_GAUSSIAN = 0.6744897501960817


def load_traces(run: Path) -> np.ndarray:
    """``(cells, frames)`` float32 from a discover_eval run directory."""
    n_frames = sum(1 for _ in open(run / "frames.tsv")) - 1
    raw = np.fromfile(run / "traces.f32", dtype="<f4")
    return raw.reshape(n_frames, -1).T.copy()


def sigma_mad_diff(x: np.ndarray, zero: float) -> float:
    d = np.abs(np.diff(x))
    keep = ~((x[:-1] <= zero) & (x[1:] <= zero))
    d = d[keep]
    if d.size < 8:
        return float("nan")
    return float(np.median(d) / MAD_GAUSSIAN / np.sqrt(2))


def window_stats(x: np.ndarray, zero: float) -> dict:
    """QC trace statistics of one window (``crates/cala/src/qc/stats.rs``)."""
    n = x.size
    out = dict(snr=np.nan, sigma=np.nan, events=0, fwhm=[], rise=[], decay=[], peaks=[])
    sigma = sigma_mad_diff(x, zero)
    if not sigma > 0:
        return out
    med = float(np.median(x))
    top = max(n // 100, 3)
    out["sigma"] = sigma
    out["snr"] = (float(np.mean(np.partition(x, n - top)[n - top :])) - med) / sigma
    sm = uniform_filter1d(x.astype(np.float64), SMOOTH, mode="nearest")
    ss = sigma / np.sqrt(SMOOTH)
    lo, on = med + 2 * ss, med + EVENT_Z * ss
    above = sm > lo
    edges = np.flatnonzero(np.diff(np.r_[0, above.astype(np.int8), 0]))
    for start, end in zip(edges[::2], edges[1::2]):
        seg = sm[start:end]
        p = start + int(np.argmax(seg))
        pk = sm[p]
        if pk <= on:
            continue
        out["events"] += 1
        out["peaks"].append(p)
        if start == 0 or end == n:
            continue
        half = med + 0.5 * (pk - med)
        top80 = med + 0.8 * (pk - med)
        left = p
        while left > start and sm[left - 1] >= half:
            left -= 1
        right = p
        while right + 1 < end and sm[right + 1] >= half:
            right += 1
        idx = np.arange(left, right + 1)
        hi = idx[sm[left : right + 1] >= top80]
        a, b = (hi[0], hi[-1]) if hi.size else (p, p)
        out["rise"].append((a - left + 0.5) / FPS)
        out["decay"].append((right - b + 0.5) / FPS)
        out["fwhm"].append((right - left + 1) / FPS)
    return out


def cell_stats(x: np.ndarray) -> dict:
    """Per-cell summary over all full 60 s windows of a trace."""
    scale = max(float(np.max(np.abs(x))), 1e-12)
    zero = 1e-6 * scale
    ws = [window_stats(x[s : s + WINDOW], zero) for s in range(0, x.size - WINDOW + 1, WINDOW)]
    snr = np.nanmedian([w["snr"] for w in ws]) if ws else np.nan
    sigma = np.nanmedian([w["sigma"] for w in ws]) if ws else np.nan
    n_ev = sum(w["events"] for w in ws)
    minutes = len(ws) * WINDOW / FPS / 60
    fwhm = [v for w in ws for v in w["fwhm"]]
    rise = [v for w in ws for v in w["rise"]]
    decay = [v for w in ws for v in w["decay"]]
    peaks = np.concatenate([np.asarray(w["peaks"]) + i * WINDOW for i, w in enumerate(ws)]) if ws else []
    iei = np.diff(np.sort(peaks)) / FPS if len(peaks) > 1 else np.array([])
    # Drift: 20 s rolling 20th-percentile baseline (decimated 4x for speed).
    dec = x[: x.size // 4 * 4].reshape(-1, 4).mean(axis=1)
    base = percentile_filter(dec, 20, size=int(20 * FPS / 4), mode="nearest")
    drift = float(np.percentile(base, 95) - np.percentile(base, 5))
    amp = snr * sigma if np.isfinite(snr) else np.nan
    return dict(
        snr=float(snr),
        sigma=float(sigma),
        rate=n_ev / minutes if minutes else np.nan,
        fwhm=fwhm,
        rise=rise,
        decay=decay,
        iei=iei.tolist(),
        drift_z=drift / sigma if sigma > 0 else np.nan,
        drifting=bool(sigma > 0 and drift > 5 * sigma and drift > 0.25 * amp),
    )


def summarize(traces: np.ndarray) -> dict:
    cells = [cell_stats(x) for x in traces]
    q = lambda v: [float(np.nanpercentile(v, p)) for p in (25, 50, 75)] if len(v) else [np.nan] * 3  # noqa: E731
    fwhm = np.array([v for c in cells for v in c["fwhm"]])
    iei = np.array([v for c in cells for v in c["iei"]])
    return {
        "cells": len(cells),
        "peak_snr": q([c["snr"] for c in cells]),
        "event_rate_per_min": q([c["rate"] for c in cells]),
        "fwhm_s": q(fwhm),
        "rise_s": q([v for c in cells for v in c["rise"]]),
        "decay_s": q([v for c in cells for v in c["decay"]]),
        "frac_events_fwhm_gt_2s": float(np.mean(fwhm > 2.0)) if fwhm.size else np.nan,
        "frac_iei_lt_2s": float(np.mean(iei < 2.0)) if iei.size else np.nan,
        "drift_frac": float(np.mean([c["drifting"] for c in cells])),
        "drift_z": q([c["drift_z"] for c in cells]),
        "silent_frac": float(np.mean([c["rate"] == 0 for c in cells])),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--json", type=Path)
    a = ap.parse_args()
    res = {}
    for run in a.runs:
        s = summarize(load_traces(run))
        res[str(run)] = s
        print(run)
        for k, v in s.items():
            print(f"  {k:24s} {np.round(v, 3).tolist() if isinstance(v, list) else round(v, 3)}")
    if a.json:
        a.json.write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
