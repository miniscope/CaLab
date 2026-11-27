"""End-to-end registration error of cala's motion corrector on minisim sims.

    python tools/cala-eval/motion_bias.py [--blocks N] <run dir> [<run dir> ...]

Each run dir holds `motion_eval minisim` output written with `MOTION_SAVE=<run dir>`:
`cala_rigid.npy`, `cala_nonrigid.npy` (registering rigid shifts, `(frames, 2)`),
`cala_patch_est.npy` and `true_patch.npy` (registering displacement of the non-rigid run
and true content motion at the patch centres, `(frames * points, 2)`, frame-major).

Truth for the rigid shift is the mean true content motion over the patch centres (the
registration region sees the rigid shift plus the mean of the non-rigid field there, not
minisim's rigid `shifts` alone). A registering shift `s` matches content motion `m` when
`-s = m + c`, with `c` one constant per axis (the template's position). Per axis it
reports the error after removing `c` (its mean): RMS, mean |e|, p95 |e|, and the
regression slope of `-s` on `m` (1 = no gain bias; `slope - 1` is the bias as a fraction
of the shift). Rows: the rigid-only run, the rigid part of the non-rigid run, the
non-rigid run's displacement at the patch centres, and its residual part (each patch minus
the mean over the frame's patches, against the same for the truth; its slope is the gain
of the patch registration on the non-rigid field). Prints one TSV row per run and mode.

`--blocks N` instead prints the rigid-only run's gain (dy, dx) in consecutive blocks of N
frames, one row per run, to see a gain that changes over the recording.
"""

import sys
from pathlib import Path

import numpy as np


def stats(est: np.ndarray, tru: np.ndarray) -> list[float]:
    """Per axis: rms, mean |e|, p95 |e| (mean offset removed) and the slope of -est on tru."""
    out = []
    for ax in range(2):
        a = -est[:, ax]
        b = tru[:, ax]
        e = a - b
        e = e - e.mean()
        bc = b - b.mean()
        slope = float(np.dot(a - a.mean(), bc) / np.dot(bc, bc))
        out += [
            float(np.sqrt(np.mean(e**2))),
            float(np.mean(np.abs(e))),
            float(np.quantile(np.abs(e), 0.95)),
            slope,
        ]
    return out


def blocks(dirs: list[Path], size: int) -> None:
    for d in dirs:
        rg = np.load(d / "cala_rigid.npy")
        tru_p = np.load(d / "true_patch.npy")
        n = rg.shape[0]
        tru = tru_p.reshape(n, -1, 2).mean(axis=1)
        cells = []
        for b0 in range(0, n - size + 1, size):
            s = stats(rg[b0 : b0 + size], tru[b0 : b0 + size])
            cells.append(f"{s[3]:.3f},{s[7]:.3f}")
        print("\t".join([str(d)] + cells))


def main() -> int:
    args = sys.argv[1:]
    if args[:1] == ["--blocks"]:
        blocks([Path(a) for a in args[2:]], int(args[1]))
        return 0
    hdr = ["run", "mode"]
    for ax in ("dy", "dx"):
        hdr += [f"{ax}_rms", f"{ax}_mae", f"{ax}_p95", f"{ax}_slope"]
    print("\t".join(hdr))
    for d in map(Path, sys.argv[1:]):
        est_p = np.load(d / "cala_patch_est.npy")
        tru_p = np.load(d / "true_patch.npy")
        rg = np.load(d / "cala_rigid.npy")
        nr = np.load(d / "cala_nonrigid.npy")
        n = rg.shape[0]
        k = est_p.shape[0] // n
        tru_mean = tru_p.reshape(n, k, 2).mean(axis=1)
        # Residual part: each patch minus the mean over the patches of its frame.
        est_r = est_p.reshape(n, k, 2)
        est_r = (est_r - est_r.mean(axis=1, keepdims=True)).reshape(-1, 2)
        tru_r = tru_p.reshape(n, k, 2)
        tru_r = (tru_r - tru_r.mean(axis=1, keepdims=True)).reshape(-1, 2)
        rows = [
            ("rigid", stats(rg, tru_mean)),
            ("nonrigid_rigidpart", stats(nr, tru_mean)),
            ("nonrigid_patches", stats(est_p, tru_p)),
            ("patch_residual", stats(est_r, tru_r)),
        ]
        for mode, s in rows:
            print("\t".join([d.name if d.name.startswith("v3") else str(d), mode] + [f"{v:.4f}" for v in s]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
