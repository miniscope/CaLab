"""Closeness of two `qc_eval` runs of one recording (factor pipeline, phase 0).

    python factor_closeness.py --ref RUN --test RUN [--null RUN ...]
        [--truth truth.npz] [--tile 64] [--band 16] [--out cells.tsv]

`--ref` is the raw run. `--test` is a run whose later passes solved frames
rebuilt from the factors (`qc_eval --replay-source factors`). Each `--null` is
a raw run that differs from `--ref` only in `--later-budget`: the spread
between raw runs that the test run is judged against.

Per cell of the reference run (cells are matched by id; pass 1 is the same in
all runs, and a refine replay keeps the cell set):

- `trace_r`: Pearson correlation of the Extract traces (`extract_trace.f32`);
- `fp_cos`: cosine of the unfiltered footprints (`footprints.bin`);
- `edge_px`: distance of the centroid to the nearest tile line;
- `border_px`: distance of the centroid to the frame border;
- `truth_r_*` (with `--truth`): the best correlation with a ground-truth unit
  whose centroid is within 6 px.

A loss is the median of `1 - value` over the QC-pass cells. The test run is
`within` the null spread when its loss is at most the largest null loss.
Needs numpy.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fp_scales import read_footprints

Cell = tuple[np.ndarray, np.ndarray]
Row = dict[str, float]
Truth = tuple[np.ndarray, np.ndarray]

EDGE_BINS: tuple[tuple[float, float], ...] = (
    (0, 4),
    (4, 8),
    (8, 16),
    (16, float("inf")),
)
NEAR_PX = 8.0
TRUTH_PX = 6.0
NAN = float("nan")


# ---------------------------------------------------------------------------
# Reading a run
# ---------------------------------------------------------------------------


def read_tsv(path: Path) -> list[dict[str, str]]:
    lines = path.read_text().splitlines()
    if not lines:
        return []
    head = lines[0].split("\t")
    return [dict(zip(head, ln.split("\t"))) for ln in lines[1:] if ln]


def read_traces(run: Path) -> dict[int, np.ndarray]:
    """`{id: trace}` of a run's Extract pass (`extract_trace.f32`, frames x cells)."""
    ids = [int(r["id"]) for r in read_tsv(run / "extract_ids.tsv")]
    if not ids:
        return {}
    x = np.fromfile(run / "extract_trace.f32", "<f4").reshape(-1, len(ids))
    return {cid: x[:, k] for k, cid in enumerate(ids)}


def read_centroids(run: Path) -> dict[int, tuple[float, float]]:
    return {
        int(r["id"]): (float(r["cy"]), float(r["cx"]))
        for r in read_tsv(run / "final.tsv")
    }


def read_qc(run: Path) -> dict[int, bool]:
    """`{id: QC pass}` at the run's last checkpoint; empty when the run has no `cells.tsv`."""
    path = run / "cells.tsv"
    rows = read_tsv(path) if path.exists() else []
    if not rows:
        return {}
    last = max(int(r["frame"]) for r in rows)
    return {
        int(float(r["id"])): float(r["pass"]) > 0.5
        for r in rows
        if int(r["frame"]) == last
    }


def read_truth(path: Path, dims: tuple[int, int]) -> Truth:
    """Centroids `(n, 2)` as (y, x) and traces `(n, frames)` of a `truth.npz`."""
    z = np.load(path)
    h, w = dims
    assert h * w in [int(v) for v in z["A_shape"]], (
        f"{path}: footprints are not {h} x {w}"
    )
    ptr = z["A_indptr"]
    idx, val = z["A_indices"].astype(np.int64), z["A_data"].astype(np.float64)
    cen = np.full((len(ptr) - 1, 2), np.nan)
    for k in range(len(ptr) - 1):
        i, v = idx[ptr[k] : ptr[k + 1]], val[ptr[k] : ptr[k + 1]]
        if v.sum() > 0:
            cen[k] = ((i // w * v).sum() / v.sum(), (i % w * v).sum() / v.sum())
    return cen, z["traces"]


# ---------------------------------------------------------------------------
# Per-cell measures
# ---------------------------------------------------------------------------


def pearson(a: np.ndarray, b: np.ndarray) -> float:
    """Correlation over the common length; NaN when either side is constant."""
    n = min(len(a), len(b))
    x, y = a[:n].astype(np.float64), b[:n].astype(np.float64)
    x, y = x - x.mean(), y - y.mean()
    d = float(np.sqrt((x * x).sum() * (y * y).sum()))
    return float((x * y).sum() / d) if d > 0 else NAN


def fp_cosine(a: Cell, b: Cell) -> float:
    da = dict(zip(a[0].tolist(), a[1].tolist()))
    dot = sum(da.get(p, 0.0) * v for p, v in zip(b[0].tolist(), b[1].tolist()))
    d = float(np.sqrt((a[1] ** 2).sum() * (b[1] ** 2).sum()))
    return float(dot / d) if d > 0 else NAN


def line_distance(c: float, n: int, tile: int) -> float:
    """Distance of coordinate `c` to the nearest tile line inside `n` px (lines at k * tile - 0.5)."""
    lines = np.arange(tile, n, tile) - 0.5
    return float(np.abs(lines - c).min()) if len(lines) else float("inf")


def truth_r(trace: np.ndarray, c: tuple[float, float], truth: Truth) -> float:
    cen, tr = truth
    near = np.flatnonzero(np.hypot(cen[:, 0] - c[0], cen[:, 1] - c[1]) <= TRUTH_PX)
    rs = [r for r in (pearson(trace, tr[k]) for k in near) if not math.isnan(r)]
    return max(rs) if rs else NAN


def compare(
    ref: Path, test: Path, tile: int = 64, truth_path: Path | None = None
) -> list[Row]:
    """One row per cell of `ref`, compared with the cell of the same id in `test`."""
    (h, w), fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    ta, tb = read_traces(ref), read_traces(test)
    cen, qc = read_centroids(ref), read_qc(ref)
    truth = read_truth(truth_path, (h, w)) if truth_path else None
    rows: list[Row] = []
    for cid in sorted(fa):
        cy, cx = cen.get(cid, (NAN, NAN))
        both = cid in ta and cid in tb
        rows.append(
            {
                "id": cid,
                "cy": cy,
                "cx": cx,
                "edge_px": min(line_distance(cy, h, tile), line_distance(cx, w, tile)),
                "border_px": min(cy, cx, h - 1 - cy, w - 1 - cx),
                "qc_pass": float(qc.get(cid, True)),
                "in_test": float(cid in fb),
                "fp_cos": fp_cosine(fa[cid], fb[cid]) if cid in fb else NAN,
                "trace_r": pearson(ta[cid], tb[cid]) if both else NAN,
                "truth_r_ref": truth_r(ta[cid], (cy, cx), truth)
                if truth and cid in ta
                else NAN,
                "truth_r_test": truth_r(tb[cid], (cy, cx), truth)
                if truth and cid in tb
                else NAN,
            }
        )
    return rows


def line_jump(cells: dict[int, Cell], dims: tuple[int, int], tile: int) -> float:
    """Median relative jump of footprint values across tile lines over the same between all
    other neighbouring rows and columns (1: the tile lines do not show in the footprints)."""
    h, w = dims
    on: list[float] = []
    off: list[float] = []
    for pix, val in cells.values():
        if len(val) == 0 or val.max() <= 0:
            continue
        a = np.zeros(h * w)
        a[pix] = val
        a = a.reshape(h, w)
        thr = 0.2 * val.max()
        for axis in (0, 1):
            lo = a[:-1, :] if axis == 0 else a[:, :-1]
            hi = a[1:, :] if axis == 0 else a[:, 1:]
            ok = (lo >= thr) & (hi >= thr)
            jump = np.abs(hi[ok] - lo[ok]) / (0.5 * (hi[ok] + lo[ok]))
            at_line = (np.nonzero(ok)[axis] + 1) % tile == 0
            on.extend(jump[at_line].tolist())
            off.extend(jump[~at_line].tolist())
    if not on or not off or np.median(off) <= 0:
        return NAN
    return float(np.median(on) / np.median(off))


# ---------------------------------------------------------------------------
# Summary and verdict
# ---------------------------------------------------------------------------


def finite(rows: list[Row], key: str) -> np.ndarray:
    v = np.asarray([r[key] for r in rows], dtype=np.float64)
    return v[np.isfinite(v)]


def loss(rows: list[Row], key: str) -> float:
    """Median of `1 - value` over the QC-pass cells with a value."""
    v = finite([r for r in rows if r["qc_pass"]], key)
    return float(np.median(1.0 - v)) if len(v) else NAN


def verdict(test_loss: float, null_losses: list[float]) -> str:
    nulls = [x for x in null_losses if not math.isnan(x)]
    if not nulls or math.isnan(test_loss):
        return "not judged"
    return "within" if test_loss <= max(nulls) else "outside"


def groups(rows: list[Row], band: float) -> list[tuple[str, list[Row]]]:
    out = [
        ("all cells", rows),
        ("QC pass", [r for r in rows if r["qc_pass"]]),
        ("not QC pass", [r for r in rows if not r["qc_pass"]]),
    ]
    for lo, hi in EDGE_BINS:
        name = (
            f"tile line {lo:g} to {hi:g} px"
            if hi < float("inf")
            else f"tile line over {lo:g} px"
        )
        out.append((name, [r for r in rows if lo <= r["edge_px"] < hi]))
    out.append(
        (
            f"under {band:g} px from the border",
            [r for r in rows if r["border_px"] < band],
        )
    )
    return out


def subsets(rows: list[Row]) -> list[tuple[str, list[Row]]]:
    return [
        ("QC pass", rows),
        (
            f"QC pass, under {NEAR_PX:g} px from a tile line",
            [r for r in rows if r["edge_px"] < NEAR_PX],
        ),
        (
            f"QC pass, {NEAR_PX:g} px or more from a tile line",
            [r for r in rows if r["edge_px"] >= NEAR_PX],
        ),
    ]


def q(v: np.ndarray, p: float) -> str:
    return f"{np.percentile(v, p):.4f}" if len(v) else "n/a"


def report(
    ref: Path,
    test: Path,
    nulls: list[Path],
    tile: int = 64,
    band: float = 16.0,
    truth_path: Path | None = None,
) -> str:
    """The Markdown comparison of `test` with `ref`, judged against the `nulls`."""
    rows = compare(ref, test, tile, truth_path)
    null_rows = [compare(ref, n, tile, None) for n in nulls]
    missing = sum(1 for r in rows if not r["in_test"])
    out = [f"### `{test.name}` against `{ref.name}`", ""]
    out.append(
        f"{len(rows)} cells in the reference run; {missing} of {len(rows)} cells are missing in the test run."
    )
    out += [
        "",
        "| cells | n | trace r median | trace r 5th pct | footprint cos median | footprint cos 5th pct |",
    ]
    out.append("| --- | --- | --- | --- | --- | --- |")
    for name, g in groups(rows, band):
        tr, fc = finite(g, "trace_r"), finite(g, "fp_cos")
        out.append(
            f"| {name} | {len(g)} | {q(tr, 50)} | {q(tr, 5)} | {q(fc, 50)} | {q(fc, 5)} |"
        )
    out += [
        "",
        "| cells | measure | loss | largest null loss | against the null |",
        "| --- | --- | --- | --- | --- |",
    ]
    for k, (name, g) in enumerate(subsets(rows)):
        for key, label in (("trace_r", "trace r"), ("fp_cos", "footprint cos")):
            mine = loss(g, key)
            theirs = [loss(subsets(n)[k][1], key) for n in null_rows]
            top = max([x for x in theirs if not math.isnan(x)], default=NAN)
            out.append(
                f"| {name} | {label} | {mine:.5f} | {top:.5f} | {verdict(mine, theirs)} |"
            )
    if truth_path:
        a, b = finite(rows, "truth_r_ref"), finite(rows, "truth_r_test")
        out += [
            "",
            f"Trace correlation with the truth, median: reference {q(a, 50)}, test {q(b, 50)}.",
        ]
    dims, fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    ja, jb = line_jump(fa, dims, tile), line_jump(fb, dims, tile)
    out += [
        "",
        f"Footprint jump at tile lines over elsewhere: reference {ja:.3f}, test {jb:.3f}.",
        "",
    ]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--ref", type=Path, required=True)
    ap.add_argument("--test", type=Path, required=True)
    ap.add_argument("--null", type=Path, action="append", default=[])
    ap.add_argument("--truth", type=Path)
    ap.add_argument("--tile", type=int, default=64)
    ap.add_argument("--band", type=float, default=16.0)
    ap.add_argument("--out", type=Path, help="per-cell table (tsv)")
    a = ap.parse_args()
    print(report(a.ref, a.test, a.null, a.tile, a.band, a.truth))
    if a.out:
        rows = compare(a.ref, a.test, a.tile, a.truth)
        keys = list(rows[0]) if rows else ["id"]
        lines = ["\t".join(keys)] + [
            "\t".join(f"{r[k]:.6g}" for k in keys) for r in rows
        ]
        a.out.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
