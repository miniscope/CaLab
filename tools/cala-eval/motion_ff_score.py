"""Rigid registration gain and error per arm, with seed CIs (flat-field gain work).

    python tools/cala-eval/motion_ff_score.py <root> <arm>[=<dir>] ... [--ref ARM] [--early A:B] [--late A:B]

`<root>/<arm>/<sim>/` holds `cala_rigid.npy` and `true_patch.npy` (`motion_eval minisim` with
`MOTION_SAVE`, rigid-only runs are fine); `arm=dir` reads `<dir>/<sim>/` instead. Sims are the
subdirectories present in every arm. Truth and error as in `motion_bias.py`: truth is the mean true
content motion over the patch centres, error is `-est - truth` with its mean removed per axis, gain is
the slope of `-est` on truth. Per seed the two axes are averaged; the table gives the mean over seeds
with a 95 % t interval. Columns: RMS and p95 |e| over the whole run, gain over the whole run, early
frames (default 0:3000, before the first map) and late frames (default 6000:9600). With `--ref`, a
second table gives the paired per-seed difference of each arm minus the reference.
"""

import sys
from pathlib import Path

import numpy as np

T975 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262}


def per_seed(d: Path, early, late) -> dict[str, float]:
    est = np.load(d / "cala_rigid.npy")
    n = est.shape[0]
    tru = np.load(d / "true_patch.npy").reshape(n, -1, 2).mean(axis=1)

    def stats(a0, a1):
        rms, p95, gain = [], [], []
        for ax in range(2):
            a = -est[a0:a1, ax]
            b = tru[a0:a1, ax]
            e = a - b
            e = e - e.mean()
            bc = b - b.mean()
            gain.append(float(np.dot(a - a.mean(), bc) / np.dot(bc, bc)))
            rms.append(float(np.sqrt(np.mean(e**2))))
            p95.append(float(np.quantile(np.abs(e), 0.95)))
        return np.mean(rms), np.mean(p95), np.mean(gain)

    rms, p95, gain = stats(0, n)
    _, _, g_early = stats(*early)
    late_rms, _, g_late = stats(late[0], min(late[1], n))
    return {"rms": rms, "p95": p95, "gain": gain, "gain_early": g_early, "gain_late": g_late, "rms_late": late_rms}


def ci(v: list[float]) -> str:
    a = np.asarray(v)
    if len(a) < 2:
        return f"{a.mean():.4f}"
    h = T975.get(len(a) - 1, 1.96) * a.std(ddof=1) / np.sqrt(len(a))
    return f"{a.mean():.4f} ± {h:.4f}"


def main() -> int:
    args = sys.argv[1:]
    opts = {}
    for k in ("--ref", "--early", "--late"):
        if k in args:
            i = args.index(k)
            opts[k] = args[i + 1]
            del args[i : i + 2]
    span = lambda s: tuple(int(x) for x in s.split(":"))
    early = span(opts.get("--early", "0:3000"))
    late = span(opts.get("--late", "6000:9600"))
    root = Path(args[0])
    arms = {}
    for a in args[1:]:
        name, _, d = a.partition("=")
        arms[name] = Path(d) if d else root / name
    sims = sorted(set.intersection(*[{p.name for p in d.iterdir() if (p / "cala_rigid.npy").exists()} for d in arms.values()]))
    res = {a: {s: per_seed(d / s, early, late) for s in sims} for a, d in arms.items()}
    keys = ["rms", "p95", "gain", "gain_early", "gain_late", "rms_late"]
    print(f"sims: {', '.join(sims)}; early {early}, late {late}\n")
    print("| arm | " + " | ".join(keys) + " |")
    print("|---|" + "---:|" * len(keys))
    for a in arms:
        print(f"| {a} | " + " | ".join(ci([res[a][s][k] for s in sims]) for k in keys) + " |")
    ref = opts.get("--ref")
    if ref:
        print(f"\nPaired difference, arm minus {ref}:\n")
        print("| arm | " + " | ".join(keys) + " |")
        print("|---|" + "---:|" * len(keys))
        for a in arms:
            if a == ref:
                continue
            print(f"| {a} | " + " | ".join(ci([res[a][s][k] - res[ref][s][k] for s in sims]) for k in keys) + " |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
