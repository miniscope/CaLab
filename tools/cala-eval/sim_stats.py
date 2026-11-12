#!/usr/bin/env python
"""Grey level and a per-cell peak-SNR proxy of minisim recordings (calibration checks).

    $MINISIM_PY tools/cala-eval/sim_stats.py <sims>/static_s5 [...]     # needs opencv (minisim venv)

- grey: mean and centre (200 x 200 px) grey level over 200 frames spread over the recording
  (every 48th frame of the DAQ AVIs).
- snr proxy: for each detectable unit, `footprint peak x (C p99.5 - C median)` over the first
  300 frames, divided by the pixel noise at the footprint peak (MAD of frame differences / sqrt 2,
  3 x 3 mean). Static recordings only (the footprint peak pixel must not move). It is a
  relative measure to compare recordings made with different cell sizes, not an absolute SNR.
"""

from __future__ import annotations

import glob
import struct
import sys
from pathlib import Path

import cv2
import numpy as np


def grey(avi_dir: Path) -> str:
    files = sorted(glob.glob(str(avi_dir / "*.avi")), key=lambda p: int(Path(p).stem))
    mean, centre, i = [], [], 0
    for p in files:
        cap = cv2.VideoCapture(p)
        while True:
            ok, f = cap.read()
            if not ok:
                break
            if i % 48 == 0:
                g = f[..., 0].astype(np.float32)
                mean.append(g.mean())
                centre.append(g[200:400, 200:400].mean())
            i += 1
    return f"grey: mean {np.mean(mean):.1f}  centre {np.mean(centre):.1f}  ({len(mean)} of {i} frames)"


def snr_proxy(oracle: Path, avi: Path) -> str:
    cap = cv2.VideoCapture(str(avi))
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f[..., 0].astype(np.float32))
    v = np.array(frames)
    d = v[1:] - v[:-1]
    noise = 1.4826 * np.median(np.abs(d - np.median(d, 0)), 0) / np.sqrt(2)
    with open(oracle, "rb") as f:
        f.read(8)
        h, w, n, t = struct.unpack("<IIII", f.read(16))
        recs = []
        for _ in range(n):
            f.read(4)
            fl = f.read(4)
            f.read(8)
            y0, x0, ph, pw = struct.unpack("<iiII", f.read(16))
            a = np.frombuffer(f.read(4 * ph * pw), "<f4").reshape(ph, pw)
            _y, _x, ph2, pw2 = struct.unpack("<iiII", f.read(16))
            f.read(4 * ph2 * pw2)
            recs.append((fl[0], y0, x0, a))
        c = np.frombuffer(f.read(4 * n * t), "<f4").reshape(n, t)
    s = []
    for i, (det, y0, x0, a) in enumerate(recs):
        if not det:
            continue
        j = np.unravel_index(a.argmax(), a.shape)
        y, x = y0 + j[0], x0 + j[1]
        if not (1 <= y < h - 1 and 1 <= x < w - 1):
            continue
        tr = c[i, : len(v)]
        nz = noise[y - 1 : y + 2, x - 1 : x + 2].mean()
        if nz > 0:
            s.append(a.max() * (np.percentile(tr, 99.5) - np.median(tr)) / nz)
    q = np.percentile(s, [25, 50, 75])
    return f"snr proxy: n={len(s)} median {q[1]:.2f}  q25 {q[0]:.2f}  q75 {q[2]:.2f}"


if __name__ == "__main__":
    for d in map(Path, sys.argv[1:]):
        print(d)
        print(" ", grey(d / "daq" / "Miniscope"))
        print(" ", snr_proxy(d / "oracle.bin", d / "daq" / "Miniscope" / "0.avi"))
