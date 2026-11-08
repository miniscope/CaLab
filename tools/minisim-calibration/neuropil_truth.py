"""Structure of a sim's true neuropil (ground truth), on the real-data definitions.

    python neuropil_truth.py SIM_DIR [SIM_DIR ...] [--skip-s 60]

SIM_DIR is a ``make_trace_sim.py`` output. The neuropil is
``amplitude * mean_k S_k(y, x) T_k(t)`` (minisim ``NeuropilStep``); this rebuilds
its 1 s-smoothed fluctuation on 4 x 4 px blocks inside the FOV (illumination
above 25 % of its maximum), after the first ``--skip-s`` seconds (the bleaching
transient), and reports, as for the real background analysis
(a global mode with a per-pixel weight, then the residual):

* global share: variance of the per-block regression on the FOV-mean
  fluctuation over the total;
* local scale: 1/e and half-maximum distance of the residual's spatial
  autocorrelation, in full-resolution px.

Real reference (workshop recording, cells and motion removed): global share
~0.9, local field 1/e ~100-120 px.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

from background_stats import crossing, radial
from minisim.recording import load_ground_truth

B = 4


def main() -> None:
    args = sys.argv[1:]
    skip = 60.0
    if "--skip-s" in args:
        i = args.index("--skip-s")
        skip = float(args[i + 1])
        del args[i : i + 2]
    for run in args:
        gt, _ = load_ground_truth(Path(run) / "daq/ground_truth/ground_truth.zarr")
        S = np.asarray(gt.neuropil_spatial, dtype=np.float64)  # (k, H', W') canvas
        T = np.asarray(gt.neuropil_temporal, dtype=np.float64)  # (k, t)
        top, left = gt.fov_offset
        h, w = gt.fov_shape
        S = S[:, top : top + h, left : left + w]
        T = T[:, int(skip * 20) :]
        nb = T.shape[1] // 20
        T = T[:, : nb * 20].reshape(len(T), nb, 20).mean(axis=2)
        T = T - T.mean(axis=1, keepdims=True)
        hb, wb = h // B, w // B
        Sb = S[:, : hb * B, : wb * B].reshape(len(S), hb, B, wb, B).mean(axis=(2, 4))
        illum = np.asarray(gt.illumination)[: hb * B, : wb * B].reshape(hb, B, wb, B).mean(axis=(1, 3))
        mb = illum > 0.25 * illum.max()
        d = np.tensordot(T, Sb, axes=(0, 0))  # (t, hb, wb)
        g = d[:, mb].mean(axis=1)
        beta = np.tensordot(g, d, axes=(0, 0)) / np.dot(g, g)
        fit = g[:, None, None] * beta[None]
        res = (d - fit) * mb[None]
        share = float(np.sum(fit[:, mb] ** 2) / np.sum(d[:, mb] ** 2))
        ph, pw = 2 * hb, 2 * wb
        fm = np.fft.rfft2(mb.astype(float), (ph, pw))
        norm = np.fft.irfft2(fm * np.conj(fm), (ph, pw))
        acc = np.zeros((ph, pw))
        for r in res:
            fr = np.fft.rfft2(r, (ph, pw))
            acc += np.fft.irfft2(fr * np.conj(fr), (ph, pw))
        prof = radial(np.fft.fftshift(acc / np.maximum(norm, 1)), min(hb, wb) // 2)
        prof = prof / prof[0]
        print(
            f"{run}: global share {share:.3f}, local 1/e {crossing(prof, np.exp(-1)) * B:.0f} px, "
            f"half {crossing(prof, 0.5) * B:.0f} px"
        )


if __name__ == "__main__":
    main()
