#!/usr/bin/env python
"""Offline prototype of the scale probe D0 (S2.4 section 2.2): cell diameter from the first frames.

    python tools/cala-eval/probe_scale.py <recording> [...] [--frames 400] [--bin 1] [--json out.json]

`<recording>` is a minisim sim directory (reads `daq/Miniscope/*.avi`) or a directory of numbered
AVIs (a real recording). Nothing here is tuned; every number is a declared level or measured geometry.

1. Read the first `--frames` frames (default 400, the two warm-up walks the app already makes),
   optionally binned `--bin` x `--bin` (mean, rounded, as `qc_eval --bin`).
2. Register them rigidly to their own mean (phase correlation on a difference-of-Gaussians band,
   twice, the second time against the registered mean).
3. Subtract the per-pixel temporal median and divide by the per-pixel noise (1.4826 MAD of frame
   differences / sqrt 2).
4. Scale-normalised Laplacian of Gaussian `-sigma^2 LoG_sigma` on a geometric ladder of sigma
   (ratio sqrt 2) from the smoothing floor 0.6 px (the recursive Gaussian's validity floor) to the
   largest sigma for which three kernel widths (3 x 6 sigma) fit in the FOV's inscribed radius.
5. Each band to z with its robust noise scale (1.4826 MAD over the FOV and frames).
6. Every local maximum over (y, x, sigma), at least 3 sigma inside the FOV, above the detector's own
   event threshold (`event_z` = 4), votes for its sigma*, interpolated on log sigma. The same search
   on the negated frames is counted per band and reported (`dark_per_band`); it is not a clean null
   (gaps between active cells and the LoG surround make dark blobs), so it filters nothing.
7. sigma* -> half-max diameter with the blurred-disk relation at the ladder's lowest sigma
   (computed here on synthetic disks; it lies between 2.36 sigma* for a Gaussian and 2.83 sigma*
   for a sharp disk).
8. `d0` = median over votes, and over sites: votes grouped by place, one value per site, so a long
   transient does not count once per frame. A site counts when it voted in at least `event_frames`
   (3) frames, the detector's own definition of a transient; single-frame noise maxima do not.
   95 % CIs from order statistics.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fp_scales import median_ci  # noqa: E402

EVENT_Z = 4.0  # SlowLoopConfig::event_z
EVENT_FRAMES = 3  # SlowLoopConfig::event_frames: a transient lasts at least this many frames
FLOOR = 0.6  # validity floor of the recursive Gaussian (discover/mod.rs)
RATIO = math.sqrt(2.0)


def avi_paths(rec: str) -> list[str]:
    d = os.path.join(rec, "daq", "Miniscope") if os.path.isdir(os.path.join(rec, "daq")) else rec
    ps = glob.glob(os.path.join(d, "*.avi"))
    return sorted(ps, key=lambda p: int(Path(p).stem))


def read_frames(rec: str, n: int, b: int) -> np.ndarray:
    out = []
    for p in avi_paths(rec):
        cap = cv2.VideoCapture(p)
        while len(out) < n:
            ok, f = cap.read()
            if not ok:
                break
            f = f[..., 0] if f.ndim == 3 else f
            if b > 1:
                h, w = f.shape[0] // b, f.shape[1] // b
                f = f[: h * b, : w * b].reshape(h, b, w, b).astype(np.uint32).sum(axis=(1, 3))
                f = ((f + (b * b) // 2) // (b * b)).astype(np.uint8)
            out.append(f.astype(np.float32))
        if len(out) >= n:
            break
    return np.stack(out)


def dog(f: np.ndarray) -> np.ndarray:
    return cv2.GaussianBlur(f, (0, 0), 1.5) - cv2.GaussianBlur(f, (0, 0), 15.0)


def register(frames: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    win = cv2.createHanningWindow(frames.shape[1:][::-1], cv2.CV_32F)
    shifts = np.zeros((len(frames), 2))
    reg = frames
    for _ in range(2):
        tpl = dog(reg.mean(0))
        out = np.empty_like(frames)
        for i, f in enumerate(frames):
            (dx, dy), _ = cv2.phaseCorrelate(tpl, dog(f), win)
            shifts[i] = (dy, dx)
            m = np.float32([[1, 0, -dx], [0, 1, -dy]])
            out[i] = cv2.warpAffine(f, m, f.shape[::-1], flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        reg = out
    return reg, shifts


def fov_mask(mean: np.ndarray) -> np.ndarray:
    """Pixels brighter than half the median of the bright half (a lit field, as cala's FOV mask)."""
    v = mean[mean > np.median(mean)]
    m = mean > 0.5 * np.median(v)
    lab, n = ndimage.label(m)
    if n > 1:
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        m = lab == (1 + int(np.argmax(sizes)))
    return ndimage.binary_fill_holes(m)


def ladder(fov: np.ndarray) -> np.ndarray:
    r_in = ndimage.distance_transform_edt(fov).max()
    top = r_in / 18.0
    k = int(math.floor(math.log(top / FLOOR) / math.log(RATIO)))
    return FLOOR * RATIO ** np.arange(k + 1)


def nlog(f: np.ndarray, s: float) -> np.ndarray:
    """-sigma^2 LoG: positive at the centre of a bright blob."""
    return -(s * s) * cv2.Laplacian(cv2.GaussianBlur(f, (0, 0), s), cv2.CV_32F, ksize=1)


def disk_relation(sigmas: np.ndarray, blur: float) -> tuple[np.ndarray, np.ndarray]:
    """(sigma*, half-max diameter) of synthetic disks blurred by `blur`, for the ladder's sigma range."""
    fine = np.exp(np.linspace(math.log(sigmas[0]), math.log(sigmas[-1]), 200))
    s_star, dd = [], []
    for diam in np.exp(np.linspace(math.log(1.5), math.log(4 * sigmas[-1]), 60)):
        n = int(8 * sigmas[-1] + 4 * diam) | 1
        c = n // 2
        yy, xx = np.mgrid[0:n, 0:n]
        sub = 4  # supersampled disk edge
        acc = np.zeros((n, n), np.float32)
        for oy in range(sub):
            for ox in range(sub):
                acc += np.hypot(yy + (oy + 0.5) / sub - 0.5 - c, xx + (ox + 0.5) / sub - 0.5 - c) <= diam / 2
        img = cv2.GaussianBlur(acc / sub**2, (0, 0), blur)
        resp = [nlog(img, s)[c, c] for s in fine]
        j = int(np.argmax(resp))
        if 0 < j < len(fine) - 1:
            s_star.append(fine[j])
            pk = img.max()
            dd.append(2 * math.sqrt((img >= 0.5 * pk).sum() / math.pi))
    s_star, dd = np.array(s_star), np.array(dd)
    o = np.argsort(s_star)
    return s_star[o], dd[o]


def probe(rec: str, n: int, b: int) -> dict:
    frames = read_frames(rec, n, b)
    reg, shifts = register(frames)
    mean = reg.mean(0)
    fov = fov_mask(mean)
    med = np.median(reg, axis=0)
    # Per-pixel noise from frame differences (1.4826 MAD / sqrt 2, as the SNR convention): frames
    # are whitened by it, so a pixel noisier than its neighbours does not vote again and again.
    dif = np.diff(reg, axis=0)
    npx = 1.4826 * np.median(np.abs(dif - np.median(dif, axis=0)), axis=0) / math.sqrt(2)
    floor = np.median(npx[fov])
    npx = np.where(npx > 0, npx, floor).astype(np.float32)
    del dif
    sig = ladder(fov)
    rel_s, rel_d = disk_relation(sig, sig[0])
    # Robust noise per band from every 10th frame.
    noise = []
    for s in sig:
        vals = np.concatenate([nlog((reg[i] - med) / npx, s)[fov] for i in range(0, len(reg), 10)])
        noise.append(1.4826 * np.median(np.abs(vals - np.median(vals))))
    noise = np.array(noise, np.float32)
    inner = [ndimage.binary_erosion(fov, iterations=int(math.ceil(3 * s))) for s in sig]

    def maxima(z: np.ndarray, i: int, out: list) -> None:
        mx = ndimage.maximum_filter(z, size=3, mode="constant", cval=-np.inf)
        cand = (z == mx) & (z > EVENT_Z)
        cand[0] = cand[-1] = False  # sigma* must be interior to the ladder
        for k, y, x in zip(*np.nonzero(cand)):
            if not inner[k][y, x]:
                continue
            # Parabola through (log sigma, z) at k-1, k, k+1.
            zm, z0, zp = z[k - 1, y, x], z[k, y, x], z[k + 1, y, x]
            den = zm - 2 * z0 + zp
            off = 0.5 * (zm - zp) / den if den < 0 else 0.0
            out.append((i, y, x, sig[k] * RATIO**off, z0, k))

    votes: list = []  # (frame, y, x, sigma*, z, band) of bright maxima
    null: list = []  # the same on the negated frame: the measured null
    for i in range(len(reg)):
        f = (reg[i] - med) / npx
        z = np.stack([nlog(f, s) / noise[k] for k, s in enumerate(sig)])
        maxima(z, i, votes)
        maxima(-z, i, null)
    v = np.array(votes) if votes else np.zeros((0, 6))
    nv = np.array(null) if null else np.zeros((0, 6))
    # Dark maxima (the negated frames) per band, reported beside the bright ones: not a usable
    # null here, since the gaps between active cells and the LoG's own surround make dark blobs.
    z_band = np.bincount(nv[:, 5].astype(int), minlength=len(sig)).tolist() if len(nv) else []
    d_votes = np.interp(v[:, 3], rel_s, rel_d) if len(v) else np.zeros(0)
    # Sites: votes within max(sigma*) of a stronger vote's place belong to its site.
    g = int(math.ceil(sig[-1]))
    grid: dict[tuple[int, int], list[int]] = {}
    centres: list[tuple[float, float, float]] = []
    sites: list[list[int]] = []
    for j in np.argsort(-v[:, 4]) if len(v) else []:
        y, x, s_ = v[j, 1], v[j, 2], v[j, 3]
        gy, gx = int(y) // g, int(x) // g
        hit = None
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for si in grid.get((gy + dy, gx + dx), []):
                    cy, cx, cs = centres[si]
                    if math.hypot(y - cy, x - cx) <= max(cs, s_):
                        hit = si
                        break
                if hit is not None:
                    break
            if hit is not None:
                break
        if hit is None:
            centres.append((y, x, s_))
            sites.append([j])
            grid.setdefault((gy, gx), []).append(len(sites) - 1)
        else:
            sites[hit].append(j)
    sites = [s_ for s_ in sites if len(set(v[s_, 0].astype(int))) >= EVENT_FRAMES]
    d_sites = np.array([np.median(d_votes[s_]) for s_ in sites]) if sites else np.zeros(0)
    mv, lv, hv = median_ci(d_votes)
    ms, ls_, hs = median_ci(d_sites)
    return {
        "frames": len(reg),
        "bin": b,
        "shift_sd_px": float(shifts.std(0).mean()),
        "fov_px": int(fov.sum()),
        "ladder": [round(float(s), 3) for s in sig],
        "noise": [float(x) for x in noise],
        "votes": int(len(v)),
        "dark_per_band": z_band,
        "votes_per_band": np.bincount(v[:, 5].astype(int), minlength=len(sig)).tolist() if len(v) else [],
        "sites": len(sites),
        "d0_votes": mv,
        "d0_votes_ci": [lv, hv],
        "d0_sites": ms,
        "d0_sites_ci": [ls_, hs],
        "sigma_star_median": float(np.median(v[:, 3])) if len(v) else float("nan"),
        "d_per_sigma_star": float(np.median(d_votes / v[:, 3])) if len(v) else float("nan"),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recordings", nargs="+")
    ap.add_argument("--frames", type=int, default=400)
    ap.add_argument("--bin", type=int, default=1)
    ap.add_argument("--json", help="append one JSON line per recording")
    args = ap.parse_args()
    for rec in args.recordings:
        r = probe(rec, args.frames, args.bin)
        r["recording"] = rec
        print(
            f"{rec}: {r['frames']} frames, bin {r['bin']}, {r['votes']} votes at {r['sites']} sites; "
            f"d0 {r['d0_sites']:.2f} px (sites, 95% CI {r['d0_sites_ci'][0]:.2f}-{r['d0_sites_ci'][1]:.2f}), "
            f"{r['d0_votes']:.2f} (votes); sigma* {r['sigma_star_median']:.2f}, d/sigma* {r['d_per_sigma_star']:.2f}; "
            f"ladder {r['ladder'][0]}-{r['ladder'][-1]}",
            flush=True,
        )
        if args.json:
            with open(args.json, "a") as f:
                f.write(json.dumps(r) + "\n")


if __name__ == "__main__":
    main()
