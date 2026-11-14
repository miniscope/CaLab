"""Session boundary on real Miniscope data: raw brightness and per-cell baseline (read-only).

    python3 -I tools/cala-eval/real_boundary.py brightness <session1 img dir> <session2 img dir> <out dir>
    python3 -I tools/cala-eval/real_boundary.py cells <export1.npz> <export2.npz> <out dir> [--boundary N]
    python3 -I tools/cala-eval/real_boundary.py concat <session1 img dir> <session2 img dir> <link dir>
    python3 -I tools/cala-eval/real_boundary.py traces <qc_eval run> <out dir> [--start N] [--label S]

Part of the session-boundary study (`results/2026-11-13-session-boundary.md`). The input
folders are only read (AVIs through a read-only memmap); everything is written to `<out dir>`.

* `brightness`: every frame's raw mean over the lit field (pixels whose session mean is
  above 25 % of the 99th percentile) and over a 3 x 3 grid of regions, streaming, for both
  sessions (`brightness.npz`); and the mean images of the first and last 600 frames of each
  session with the ratio maps (`mean_images.npz`). Prints the window means. The question:
  does the raw light change across the boundary (LED warm-up, gain, focus)?
* `cells`: the app's exported traces (`cala-export.npz` of each session, a Joint run)
  joined at the boundary. Per cell: noise sigma (MAD of the first difference / 0.954 ...
  i.e. sigma of the trace from its frame-to-frame differences), baseline (20th percentile)
  in windows, and activity class from the frames around the boundary (`silent`: no frame
  above baseline + 4 sigma in B-600..B+600; `active` otherwise). Prints the population
  window means per class, for the boundary and for the start of session 1 (control: the
  same statistics at frame 0 of the run).
* `concat`: a folder of symlinks `0.avi ..` (session 1's files, then session 2's,
  renumbered) for `qc_eval real`, which reads `<dir>/<i>.avi`.
* `traces`: the population curves of a `qc_eval real ... --boundary-log` run
  (`boundary_traces.bin`), in units of each cell's noise sigma, per class.
"""

import argparse
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from stitch_sessions import avi_frames  # noqa: E402

N_PX = 600 * 600
WIN = 600


def session_files(d: Path) -> list[Path]:
    return sorted(d.glob("*.avi"), key=lambda p: int(p.stem))


def iter_frames(d: Path):
    for p in session_files(d):
        mm, offs = avi_frames(p, N_PX)
        for o in offs:
            yield np.asarray(mm[o : o + N_PX], dtype=np.float32)
        del mm


def brightness(s1: Path, s2: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    res = {}
    imgs = {}
    for name, d in (("s1", s1), ("s2", s2)):
        n = sum(len(avi_frames(p, N_PX)[1]) for p in session_files(d))
        means, grid = [], []
        first = np.zeros(N_PX, np.float64)
        last = np.zeros(N_PX, np.float64)
        total = np.zeros(N_PX, np.float64)
        frames = []
        for t, f in enumerate(iter_frames(d)):
            total += f
            if t < WIN:
                first += f
            if t >= n - WIN:
                last += f
            frames.append(t)
            means.append(float(f.mean()))
            g = f.reshape(3, 200, 3, 200).mean(axis=(1, 3)).ravel()
            grid.append(g)
        imgs[name + "_first"] = (first / WIN).reshape(600, 600)
        imgs[name + "_last"] = (last / WIN).reshape(600, 600)
        imgs[name + "_all"] = (total / n).reshape(600, 600)
        res[name + "_mean"] = np.array(means)
        res[name + "_grid"] = np.array(grid)
    lit = imgs["s1_all"] > 0.25 * np.percentile(imgs["s1_all"], 99)
    for name, d in (("s1", s1), ("s2", s2)):
        # Re-read only the lit-field mean is not needed: the full-frame mean differs from it by
        # a constant factor of the dark share; report both.
        pass
    np.savez_compressed(out / "brightness.npz", **res, lit=lit)
    np.savez_compressed(out / "mean_images.npz", **imgs, lit=lit)
    m1, m2 = res["s1_mean"], res["s2_mean"]
    report = {
        "frames": [len(m1), len(m2)],
        "lit_share": float(lit.mean()),
        "s1_first_600": float(m1[:WIN].mean()),
        "s1_first_30": float(m1[:30].mean()),
        "s1_600_1200": float(m1[WIN : 2 * WIN].mean()),
        "s1_last_600": float(m1[-WIN:].mean()),
        "s2_first_30": float(m2[:30].mean()),
        "s2_first_300": float(m2[:300].mean()),
        "s2_first_600": float(m2[:WIN].mean()),
        "s2_600_1200": float(m2[WIN : 2 * WIN].mean()),
        "s2_last_600": float(m2[-WIN:].mean()),
    }
    for a, b in (("s2_first", "s1_last"), ("s1_last", "s1_first"), ("s2_last", "s2_first")):
        r = imgs[a] / np.maximum(imgs[b], 1e-3)
        report[f"ratio_{a}/{b}_lit_median"] = float(np.median(r[lit]))
        report[f"ratio_{a}/{b}_lit_p05_p95"] = [float(np.percentile(r[lit], 5)), float(np.percentile(r[lit], 95))]
    g1, g2 = res["s1_grid"], res["s2_grid"]
    report["grid_ratio_s2first_s1last"] = (g2[:WIN].mean(0) / g1[-WIN:].mean(0)).round(4).tolist()
    # Time course of the first 3000 frames of each session in 100-frame bins (warm-up?).
    report["s1_bins100"] = m1[:3000].reshape(-1, 100).mean(1).round(3).tolist()
    report["s2_bins100"] = m2[:3000].reshape(-1, 100).mean(1).round(3).tolist()
    report["s1_tail_bins100"] = m1[-3000:].reshape(-1, 100).mean(1).round(3).tolist()
    (out / "brightness.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))


def noise_sigma(x: np.ndarray) -> float:
    d = np.diff(x[np.isfinite(x)])
    return float(np.median(np.abs(d - np.median(d))) / 0.6745 / np.sqrt(2))


def classify(tr: np.ndarray, b: int) -> tuple[np.ndarray, np.ndarray]:
    """Traces in units of each cell's p99 over the run, and the quiet mask.

    The unit is the cell's own p99. Activity score: the cell's p95 over B-600..B and over
    B+300..B+900 (the bump window itself is not used), the larger of the two; the third of
    the cells with the lowest score are "quiet", the rest "active".
    """
    p99 = np.nanpercentile(tr, 99, axis=1)
    u = tr / np.where(p99 > 0, p99, np.nan)[:, None]
    pre = np.nanpercentile(u[:, b - WIN : b], 95, axis=1)
    post = np.nanpercentile(u[:, b + 300 : b + 900], 95, axis=1)
    score = np.maximum(pre, post)
    return u, score <= np.nanpercentile(score, 100 / 3)


def population(u: np.ndarray, b: int, quiet: np.ndarray) -> dict:
    wins = {"-600..0": (-WIN, 0), "0-10": (0, 10), "10-100": (10, 100), "100-300": (100, 300),
            "300-1000": (300, 1000)}  # fmt: skip
    out = {}
    for cls, m in (("all", np.ones(len(u), bool)), ("active", ~quiet), ("quiet", quiet)):
        row = {"n": int(m.sum())}
        for w, (lo, hi) in wins.items():
            seg = u[m, b + lo : b + hi]
            row["mean " + w] = float(np.nanmean(seg)) if m.any() else float("nan")
            row["frac>0 " + w] = float(np.mean(seg > 0)) if m.any() else float("nan")
        out[cls] = row
    return out


def cells(e1: Path, e2: Path, out: Path, boundary: int | None) -> None:
    out.mkdir(parents=True, exist_ok=True)
    z1, z2 = np.load(e1, allow_pickle=False), np.load(e2, allow_pickle=False)
    assert np.array_equal(z1["cell_ids"], z2["cell_ids"])
    tr = np.concatenate([z1["traces"], z2["traces"]], axis=1).astype(np.float64)
    b = boundary or z1["traces"].shape[1]
    res = {"boundary": b, "cells": len(tr), "zero_share": float(np.mean(tr == 0))}
    for name, at in (("boundary", b), ("control mid session 1", b // 2), ("control mid session 2", b + b // 2),
                     ("control start of session 1 (frame 600)", WIN)):  # fmt: skip
        u, quiet = classify(tr, at)
        res[name] = population(u, at, quiet)
    u, quiet = classify(tr, b)
    for k in ("flicker_offset", "flicker_gain"):
        v = np.concatenate([z1[k], z2[k]])
        res[k] = {"before 600": float(v[b - WIN : b].mean()), "0-10": float(v[b : b + 10].mean()),
                  "10-100": float(v[b + 10 : b + 100].mean()), "100-1000": float(v[b + 100 : b + 1000].mean()),
                  "first 10 of session 1": float(v[:10].mean()), "session-1 frames 10-100": float(v[10:100].mean())}  # fmt: skip
    ms = np.concatenate([z1["motion_shift_yx"], z2["motion_shift_yx"]])
    res["motion_before_after"] = [ms[b - WIN : b].mean(0).round(3).tolist(), ms[b : b + WIN].mean(0).round(3).tolist()]
    sl = slice(b - WIN, b + 1500)
    np.savez_compressed(
        out / "cells_curves.npz",
        t=np.arange(-WIN, 1500),
        all=np.nanmean(u[:, sl], axis=0),
        active=np.nanmean(u[~quiet, sl], axis=0),
        quiet=np.nanmean(u[quiet, sl], axis=0),
        quiet_frac_on=np.mean(u[quiet, sl] > 0, axis=0),
        flicker_offset=np.concatenate([z1["flicker_offset"], z2["flicker_offset"]])[sl],
        flicker_gain=np.concatenate([z1["flicker_gain"], z2["flicker_gain"]])[sl],
    )
    (out / "cells.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


def concat(s1: Path, s2: Path, link: Path) -> None:
    link.mkdir(parents=True, exist_ok=False)
    i = 0
    for d in (s1, s2):
        for p in session_files(d):
            os.symlink(p.resolve(), link / f"{i}.avi")
            i += 1
    print(f"{i} files linked into {link}")


def read_traces(p: Path) -> dict[int, tuple[int, np.ndarray]]:
    b = p.read_bytes()
    assert b[:8] == b"CALABTL1"
    (n,) = struct.unpack_from("<I", b, 8)
    o, out = 12, {}
    for _ in range(n):
        cid, t0, ln = struct.unpack_from("<QII", b, o)
        o += 16
        out[cid] = (t0, np.frombuffer(b, "<f4", ln, o).astype(np.float64))
        o += 8 * ln
    return out


def traces(run: Path, out: Path, start: int, label: str, boundary: int | None) -> None:
    """Population curves of a qc_eval real run from `start` (first frames of the run, or a boundary)."""
    out.mkdir(parents=True, exist_ok=True)
    tr = read_traces(run / "boundary_traces.bin")
    T = max(t0 + len(x) for t0, x in tr.values())
    rows = []
    for t0, x in tr.values():
        if t0 > start or t0 + len(x) < T:
            continue
        rows.append(x[start - t0 :])
    X = np.array(rows)
    b = boundary if boundary is not None else start
    rel = b - start
    sig = np.array([noise_sigma(x) for x in X])
    sig[~(sig > 0)] = np.nan  # an all-zero (never active) trace has no noise scale
    ref = slice(max(rel - WIN, 0), rel) if rel > 0 else slice(1500, 2100)
    base = np.nanpercentile(X[:, ref], 20, axis=1)
    z = (X - base[:, None]) / sig[:, None]
    lo = max(rel - WIN, 0)
    near = z[:, lo : rel + WIN]
    active = np.nanmax(near, axis=1) > 4
    res = {"label": label, "cells": len(X), "active": int(active.sum()), "reference": [ref.start, ref.stop]}
    wins = {"0-10": (0, 10), "10-100": (10, 100), "100-1000": (100, 1000), "1000-2000": (1000, 2000)}
    if rel > 0:
        wins = {"-600..0": (-WIN, 0), **wins}
    for cls, m in (("all", np.ones(len(z), bool)), ("active", active), ("silent", ~active)):
        r = {"n": int(m.sum())}
        for w, (a, c) in wins.items():
            seg = z[m, rel + a : rel + c]
            r["mean " + w] = float(np.nanmean(seg))
            r["p20 " + w] = float(np.nanmedian(np.nanpercentile(seg, 20, axis=1)))
        res[cls] = r
    np.savez_compressed(
        out / f"curves_{label}.npz",
        t=np.arange(lo - rel, z.shape[1] - rel),
        all=np.nanmean(z[:, lo:], axis=0),
        silent=np.nanmean(z[~active, lo:], axis=0),
        silent_median=np.nanmedian(z[~active, lo:], axis=0),
    )
    (out / f"traces_{label}.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for c in ("brightness", "concat"):
        s = sub.add_parser(c)
        s.add_argument("s1", type=Path)
        s.add_argument("s2", type=Path)
        s.add_argument("out", type=Path)
    s = sub.add_parser("cells")
    s.add_argument("e1", type=Path)
    s.add_argument("e2", type=Path)
    s.add_argument("out", type=Path)
    s.add_argument("--boundary", type=int)
    s = sub.add_parser("traces")
    s.add_argument("run", type=Path)
    s.add_argument("out", type=Path)
    s.add_argument("--start", type=int, default=50)
    s.add_argument("--boundary", type=int)
    s.add_argument("--label", default="run")
    a = ap.parse_args()
    if a.cmd == "brightness":
        brightness(a.s1, a.s2, a.out)
    elif a.cmd == "concat":
        concat(a.s1, a.s2, a.out)
    elif a.cmd == "cells":
        cells(a.e1, a.e2, a.out, a.boundary)
    else:
        traces(a.run, a.out, a.start, a.label, a.boundary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
