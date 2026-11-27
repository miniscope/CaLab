"""Score a learned flat-field gain map against a sim's true sensor PRNU and its tissue.

    $MINISIM_PY -I tools/cala-eval/ff_map_score.py <gt root> <sims root> <arm dir> ... [--frames N]

`<arm dir>/<sim>/final_log_gain.npy` is `motion_eval`'s `MOTION_FF_OUT` map (0 where the solve
left a pixel undefined); `<gt root>/<sim>/prnu_gain.npy` is the true per-pixel PRNU gain
(`export_gt_nonrigid.py --prnu`); `<sims root>/<sim>/daq/Miniscope/0.avi` gives the tissue (mean
of the first N frames, default 600, streamed, divided by the true PRNU so the reference holds no
sensor pattern). Per sim, over defined pixels that are not hot or stuck (`hot_pixel_mask.npy`,
`stuck_pixel_mask.npy` when exported; their excess is an offset, not a gain):

- `prnu r`: correlation of the learned log gain with log PRNU, both high-passed (minus a σ = 8 px
  Gaussian) so the vignette and illumination, which the solve does not separate from the tissue's
  slow profile, do not enter;
- `prnu slope`: regression slope of the learned high-passed log gain on log PRNU (1 = full size);
- `resid sd`: sd of the learned high-passed log gain minus slope x PRNU (what is not PRNU);
- `tissue r`: correlation of that residual with the tissue's fine structure (high-passed log mean
  image minus its σ = 2 blur, a DoG), the leak this work removes.

Prints one row per arm with mean ± 95 % t interval over sims, and, with two or more arms, the
paired difference of each arm minus the first.
"""

import glob
import sys
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter

T975 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262}
COLS = ("prnu r", "prnu slope", "resid sd", "tissue r")


def hp(x: np.ndarray, s: float = 8.0) -> np.ndarray:
    return x - gaussian_filter(x, s)


def tissue_dog(daq: Path, n: int, prnu: np.ndarray) -> np.ndarray:
    cap = cv2.VideoCapture(sorted(glob.glob(str(daq / "Miniscope" / "0.avi")))[0])
    acc, k = None, 0
    while k < n:
        ok, f = cap.read()
        if not ok:
            break
        f = f[..., 0].astype(np.float64)
        acc = f if acc is None else acc + f
        k += 1
    h = hp(np.log(np.maximum(acc / k, 1.0) / prnu))
    return h - gaussian_filter(h, 2.0)


def bad_pixels(gt: Path) -> np.ndarray | bool:
    bad: np.ndarray | bool = False
    for k in ("hot_pixel_mask", "stuck_pixel_mask"):
        if (gt / f"{k}.npy").exists():
            bad = bad | (np.load(gt / f"{k}.npy") != 0)
    return bad


def score(g: np.ndarray, prnu: np.ndarray, dog: np.ndarray, bad) -> list[float]:
    m = (g != 0) & ~bad
    # Fill undefined pixels with the defined mean before filtering, then score defined ones only.
    gf = np.where(m, g, g[m].mean())
    a = hp(gf)[m]
    p = hp(np.log(prnu))[m]
    a, p = a - a.mean(), p - p.mean()
    r = float(np.corrcoef(a, p)[0, 1])
    slope = float(a @ p / (p @ p))
    res = a - slope * p
    tr = float(np.corrcoef(res, dog[m])[0, 1])
    return [r, slope, float(res.std()), tr]


def ci(x: np.ndarray) -> str:
    n = len(x)
    if n < 2:
        return f"{x.mean():.4f}"
    return f"{x.mean():.4f} ± {T975[n - 1] * x.std(ddof=1) / np.sqrt(n):.4f}"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    n = 600
    if "--frames" in sys.argv:
        n = int(sys.argv[sys.argv.index("--frames") + 1])
        args = [a for a in args if a != str(n)]
    if len(args) < 3:
        print(__doc__)
        return 2
    gt, sims, arms = Path(args[0]), Path(args[1]), [Path(a) for a in args[2:]]
    names = sorted(
        set.intersection(*[{p.parent.name for p in a.glob("*/final_log_gain.npy")} for a in arms])
    )
    dogs = {s: tissue_dog(sims / s / "daq", n, np.load(gt / s / "prnu_gain.npy")) for s in names}
    res = {}
    for a in arms:
        res[a] = np.array(
            [
                score(
                    np.load(a / s / "final_log_gain.npy"),
                    np.load(gt / s / "prnu_gain.npy"),
                    dogs[s],
                    bad_pixels(gt / s),
                )
                for s in names
            ]
        )
    print(f"sims: {', '.join(names)}\n")
    print("| arm | " + " | ".join(COLS) + " |")
    print("|---|" + "---:|" * len(COLS))
    for a in arms:
        print(f"| {a.name} | " + " | ".join(ci(res[a][:, j]) for j in range(len(COLS))) + " |")
    if len(arms) > 1:
        print(f"\nPaired difference, arm minus {arms[0].name}:\n")
        print("| arm | " + " | ".join(COLS) + " |")
        print("|---|" + "---:|" * len(COLS))
        for a in arms[1:]:
            d = res[a] - res[arms[0]]
            print(f"| {a.name} | " + " | ".join(ci(d[:, j]) for j in range(len(COLS))) + " |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
