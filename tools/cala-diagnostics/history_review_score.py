"""Candidates of the whole-history scan, per checkpoint and cumulative, scored.

    python history_review_score.py RUN_DIR [--truth TRUTH.npz] [--ref name=UNITS.npz ...]

``RUN_DIR`` holds ``history_wholetest_scan.tsv`` (``history_wholetest.py --scan``). Optional
checkpoints ``RUN_DIR_t<F>`` emulate a review during the session: the library as it was at
frame F (``fp_<F>.bin`` linked as ``footprints.bin``) and only the factor windows complete by
then (``HISTORY_SCAN.md`` shows how to make them).

A grid spot is a candidate when the two halves' patterns agree in shape (cos >= 0.9, width
<= 3.3 px, shift <= 3 px), its gain and cross-half event score are at least 5 MADs above the
session's own background (spots 10 px or more from every library cell), and it does not
follow a neighbour (nb_corr < 0.6; beside a library cell only when nb_corr < 0.3).
Candidates within 6 px are one. A candidate is new when it is more than 6 px from every
candidate of an earlier checkpoint (those would be library cells by then).

Scoring: with ``--truth`` against the run's ``gt_units.tsv`` / ``labels.tsv`` (a
``discover_eval sim`` run); with ``--ref`` against other pipelines' unit centres (an ``A``
matrix in an .npz, or centres in an .npy), aligned to the library by the best integer shift.
"""

import struct
import sys
from pathlib import Path

import numpy as np

FPS = 20.0


def tsv(p: Path) -> list[dict[str, str]]:
    lines = p.read_text().splitlines()
    head = lines[0].split("\t")
    return [dict(zip(head, ln.split("\t"), strict=False)) for ln in lines[1:]]


def library(p: Path) -> tuple[int, int, np.ndarray]:
    """(H, W, centres) of a CALAFP01 library."""
    with p.open("rb") as fh:
        fh.read(8)
        h, w, n = struct.unpack("<III", fh.read(12))
        out = []
        for _ in range(n):
            _, k = struct.unpack("<II", fh.read(8))
            pix = np.frombuffer(fh.read(4 * k), "<u4")
            a = np.frombuffer(fh.read(4 * k), "<f4").astype(float)
            fh.seek(4 * k, 1)
            out.append((a @ (pix // w) / a.sum(), a @ (pix % w) / a.sum()))
    return h, w, np.array(out).reshape(-1, 2)


def dmin(pts: np.ndarray, q: np.ndarray) -> np.ndarray:
    """Distance from each row of q to the nearest row of pts."""
    if not len(pts) or not len(q):
        return np.full(len(q), 1e9)
    return np.hypot(
        q[:, None, 0] - pts[None, :, 0], q[:, None, 1] - pts[None, :, 1]
    ).min(1)


def candidates(run: Path) -> tuple[np.ndarray, np.ndarray, int]:
    """Clustered candidates (y, x) passing the rule, the library centres, window count."""
    rows = tsv(run / "history_wholetest_scan.tsv")
    col = lambda k: np.array([float(r[k]) for r in rows])
    y, x, cos, gain, wid, sh, nb, xs = (
        col(k) for k in ("y", "x", "cos", "gain", "width", "shift", "nb_corr", "xscore")
    )
    _, _, lib = library(run / "footprints.bin")
    pts = np.stack([y, x], 1)
    dlib = dmin(lib, pts)
    bg = dlib >= 10

    def z(v: np.ndarray) -> np.ndarray:
        m = np.median(v[bg])
        return (v - m) / (1.4826 * np.median(np.abs(v[bg] - m)))

    gz, xz = z(gain), z(xs)
    rule = (cos >= 0.9) & (wid <= 3.3) & (sh <= 3) & (gz >= 5) & (xz >= 5)
    rule &= (nb < 0.6) & ((dlib > 4) | (nb < 0.3))
    idx = np.flatnonzero(rule)
    keep: list[int] = []
    for i in idx[np.argsort(-gz[idx])]:
        if all(np.hypot(y[i] - y[j], x[i] - x[j]) > 6 for j in keep):
            keep.append(int(i))
    n_win = len(list((run / "factors").glob("w*.fac")))
    return pts[keep].reshape(-1, 2), lib, n_win


def aligned_refs(refs: dict[str, Path], h: int, w: int, lib: np.ndarray) -> np.ndarray:
    """All reference unit centres, shifted into run coordinates."""
    out = []
    for p in refs.values():
        if p.suffix == ".npy":
            c = np.load(p)
        else:
            a = np.maximum(np.load(p)["A"], 0)
            yy, xx = np.divmod(np.arange(h * w), w)
            c = np.stack([(a @ yy) / a.sum(1), (a @ xx) / a.sum(1)], 1)
        best = (-1, 0, 0)
        for dy in range(-12, 13):
            for dx in range(-12, 13):
                k = int((dmin(lib + (dy, dx), c) <= 5).sum())
                if k > best[0]:
                    best = (k, dy, dx)
        out.append(c - best[1:])
    return np.concatenate(out) if out else np.zeros((0, 2))


def main() -> None:
    dump = Path(sys.argv[1])
    truth, refs = None, {}
    for i, a in enumerate(sys.argv):
        if a == "--truth":
            truth = Path(sys.argv[i + 1])
        if a == "--ref":
            n, p = sys.argv[i + 1].split("=", 1)
            refs[n] = Path(p)
    h, w, lib_end = library(dump / "footprints.bin")
    steps = sorted(
        (int(d.name.rsplit("_t", 1)[1]), d)
        for d in dump.parent.glob(dump.name + "_t*")
        if (d / "history_wholetest_scan.tsv").exists()
    )
    steps.append((-1, dump))
    if truth is not None:
        units, lab = tsv(dump / "gt_units.tsv"), tsv(dump / "labels.tsv")
        off = tsv(dump / "gt_offset.tsv")[0]
        d = np.array([int(off["dy"]), int(off["dx"])])
        zt = np.load(truth)
        matched = {int(r["gt"]) for r in lab if r["class"] == "match"}
        u = np.array([[float(r["cy"]), float(r["cx"])] for r in units]) - d
        det = np.array([r["detectable"] == "true" for r in units])
        fnd = np.array([int(r["slot"]) in matched for r in units])
        allc, oof = zt["centroids"] - d, zt["oof_centroids"] - d
        print(
            f"{dump}: cala finds {int((det & fnd).sum())} true cells, misses {int((det & ~fnd).sum())}"
        )
    else:
        ref = aligned_refs(refs, h, w, lib_end)
        print(
            f"{dump}: {len(lib_end)} cala cells at the end, {len(ref)} reference units"
        )
    accepted = np.zeros((0, 2))
    tally: dict[str, int] = {}
    for frame, run in steps:
        c, lib, n_win = candidates(run)
        new = c[dmin(accepted, c) > 6] if len(accepted) else c
        kinds: dict[str, int] = {}
        for q in new:
            q2 = q[None]
            if truth is not None:
                du = np.hypot(u[:, 0] - q[0], u[:, 1] - q[1])
                du[~det] = 1e9
                j = int(du.argmin())
                if du[j] <= 6 and dmin(lib, u[j][None])[0] <= 6:
                    k = "false: copy of a cell cala has"
                elif du[j] <= 6 and fnd[j]:
                    k = "true, cala finds it later"
                elif du[j] <= 6:
                    k = "true, cala never finds it"
                elif dmin(allc, q2)[0] <= 6:
                    k = "true but too weak to score"
                elif dmin(oof, q2)[0] <= 10:
                    k = "false: out-of-focus"
                else:
                    k = "false: nothing there"
            else:
                on_ref = dmin(ref, q2)[0] <= 5
                later = dmin(lib_end, q2)[0] <= 5
                k = ("confirmed" if on_ref else "unconfirmed") + (
                    ", cala finds it later" if later else ", cala never finds it"
                )
            kinds[k] = kinds.get(k, 0) + 1
            tally[k] = tally.get(k, 0) + 1
        accepted = np.concatenate([accepted, new])
        label = "end" if frame < 0 else f"frame {frame}"
        print(
            f"  {label:12s} {n_win * 600 / FPS / 60:5.1f} min of history, {len(lib):4d} cala cells: "
            f"{len(c):3d} pass, {len(new):3d} new, {len(accepted):3d} so far | "
            + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items()))
        )
    c_end, _, _ = candidates(dump)
    print(
        f"  in-session total {len(accepted)} vs end-only scan {len(c_end)} | "
        + ", ".join(f"{k} {v}" for k, v in sorted(tally.items()))
    )


if __name__ == "__main__":
    main()
