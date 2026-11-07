"""Diffuse background and flicker statistics, real or simulated, measured one way.

    python background_stats.py AVI_DIR [--start 0] [--frames 1200] [--json OUT.json]

Reads ``--frames`` frames from ``--start`` of the numbered AVIs in AVI_DIR. FOV =
pixels of the mean image above 25 % of its 99th percentile.

* Flicker: the FOV-mean grey per frame, relative to its mean, band-passed to
  2-8 Hz (FFT mask); reported as RMS in %. Real Miniscope frames carry LED-gain
  flicker of ~1.5 % there; activity and neuropil put little power in that band.
* Global fluctuation: the FOV-mean grey in 1 s means, minus a straight-line fit
  (bleaching), as a coefficient of variation in %.
* Global share: 1 s means (20 frames), 8 x 8 px blocks fully inside the FOV,
  each block's fluctuation about its own mean. The global mode is the FOV-mean
  fluctuation g(t); each block is regressed on it, and the share is the
  regressed variance over the total, summed over blocks.
* Local scale: the spatial autocorrelation of the residual (fluctuation minus
  the global fit) maps, averaged over time, radially; the 1/e and half-maximum
  distances in full-resolution px (cells contribute the short-range part).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from calibrate_to_real import read_grey_avi
from session_curve import avi_files

FPS = 20.0
BLOCK = 8


def read_span(d: Path, start: int, n: int) -> np.ndarray:
    from minisim.avi import read_avi_header

    out = []
    pos = 0
    for f in avi_files(d):
        ln = len(read_avi_header(f)["frames"])
        lo, hi = max(start, pos), min(start + n, pos + ln)
        if hi > lo:
            out.append(read_grey_avi(f, hi - lo, lo - pos))
        pos += ln
        if pos >= start + n:
            break
    return np.concatenate(out)


def radial(c: np.ndarray, r_max: int) -> np.ndarray:
    h, w = c.shape
    y, x = np.mgrid[:h, :w]
    r = np.rint(np.hypot(y - h // 2, x - w // 2)).astype(int)
    keep = r <= r_max
    return np.bincount(r[keep], c[keep]) / np.bincount(r[keep])


def crossing(prof: np.ndarray, level: float) -> float:
    below = np.flatnonzero(prof < level)
    if below.size == 0:
        return float("nan")
    i = max(int(below[0]), 1)
    return float(i - 1 + (prof[i - 1] - level) / (prof[i - 1] - prof[i]))


def stats(movie: np.ndarray) -> dict:
    t, h, w = movie.shape
    mean = movie.mean(axis=0)
    mask = mean > 0.25 * np.percentile(mean, 99)
    # flicker
    g = movie[:, mask].mean(axis=1)
    rel = g / g.mean() - 1
    f = np.fft.rfftfreq(t, 1 / FPS)
    spec = np.fft.rfft(rel - rel.mean())
    spec[(f < 2) | (f > 8)] = 0
    flick = float(np.std(np.fft.irfft(spec, t)) * 100)
    gs = g[: (t // 20) * 20].reshape(-1, 20).mean(axis=1)
    tt = np.arange(gs.size)
    gcv = float(np.std(gs - np.polyval(np.polyfit(tt, gs, 1), tt)) / gs.mean() * 100)
    # 1 s means, 8 px blocks
    nb = t // 20
    s = movie[: nb * 20].reshape(nb, 20, h, w).mean(axis=1)
    hb, wb = h // BLOCK, w // BLOCK
    s = s[:, : hb * BLOCK, : wb * BLOCK].reshape(nb, hb, BLOCK, wb, BLOCK).mean(axis=(2, 4))
    mb = mask[: hb * BLOCK, : wb * BLOCK].reshape(hb, BLOCK, wb, BLOCK).all(axis=(1, 3))
    d = s - s.mean(axis=0)
    gt = d[:, mb].mean(axis=1)
    beta = np.tensordot(gt, d, axes=(0, 0)) / np.dot(gt, gt)
    fit = gt[:, None, None] * beta[None]
    res = (d - fit) * mb[None]
    tot = float(np.sum(d[:, mb] ** 2))
    share = float(np.sum(fit[:, mb] ** 2) / tot)
    # residual spatial autocorrelation (FFT, normalized by the mask overlap)
    ph, pw = 2 * hb, 2 * wb
    fm = np.fft.rfft2(mb.astype(float), (ph, pw))
    norm = np.fft.irfft2(fm * np.conj(fm), (ph, pw))
    acc = np.zeros((ph, pw))
    for r in res:
        fr = np.fft.rfft2(r, (ph, pw))
        acc += np.fft.irfft2(fr * np.conj(fr), (ph, pw))
    ac = np.fft.fftshift(acc / np.maximum(norm, 1))
    prof = radial(ac, min(hb, wb) // 2)
    c0 = 2 * prof[1] - prof[2]  # lag 0 without the block-noise spike
    prof = prof / c0
    return dict(
        flicker_rms_pct=flick,
        global_cv_pct=gcv,
        global_share=share,
        local_1e_px=crossing(prof, np.exp(-1)) * BLOCK,
        local_half_px=crossing(prof, 0.5) * BLOCK,
        mean_grey=float(mean[mask].mean()),
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("avi_dir", type=Path)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--frames", type=int, default=1200)
    ap.add_argument("--json", type=Path)
    a = ap.parse_args()
    s = stats(read_span(a.avi_dir, a.start, a.frames).astype(np.float32))
    for k, v in s.items():
        print(f"  {k:18s} {v:.3f}")
    if a.json:
        a.json.write_text(json.dumps(s))


if __name__ == "__main__":
    main()
