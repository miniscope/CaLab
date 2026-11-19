"""Closeness of two `qc_eval` runs of one recording, and gate A1 of the factor pipeline.

    python factor_closeness.py --ref RUN --test RUN [--null RUN ...]
        [--truth truth.npz] [--match] [--tile 64] [--band 16] [--out cells.tsv]

`--ref` is the raw run. `--test` is a run whose later passes solved frames
rebuilt from the factors (`qc_eval --replay-source factors`). Each `--null` is
a raw run that differs from `--ref` only in `--later-budget`: the spread
between raw runs that the test run is judged against.

Per cell of the reference run (cells are matched by id; pass 1 is the same in
all runs, and a refine replay keeps the cell set):

- `trace_r`: Pearson correlation of the Extract traces (`extract_trace.f32`);
- `trace_r1`: the same from lag-1 cross-covariances, which noise that is white in time
  does not enter; the trace gate uses it, because the factors remove noise that a raw
  trace keeps; undefined (and counted as without a value) for a trace that is noise only;
- `fp_cos`: cosine of the unfiltered footprints (`footprints.bin`);
- `edge_px`: distance of the centroid to the nearest tile line;
- `border_px`: distance of the centroid to the frame border;
- `truth_r_*` (with `--truth`): the best correlation with a ground-truth unit
  whose centroid is within 6 px. One frame offset between the run and the truth is
  estimated first, from the units that best follow each cell's trace, and applied
  before the 6 px radius;
- `truth_fp_*` (with `--truth`): the footprint's correlation over the frame with the
  footprint of the truth unit its trace follows best (main's "footprint r"), and
  `truth_overlap`, that unit's `cat_overlap` flag;
- with `--match`, cells are paired by footprint (cosine at least 0.5, centroids within
  20 px) instead of by id, for runs whose Discover differed; a reference cell without a
  partner counts as lost.

A loss is the median of `1 - value` over the QC-pass cells. The judged measures
are `trace_r1` and `fp_cos`; the plain `trace_r` is printed but not gated. The test
run is `within` the null spread when its loss is at most the largest null loss.
The report ends with gate A1 of the spec's Amendment 1.
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
TRUTH_MIN_R = 0.5
TRUTH_MIN_CELLS = 3
# Pairing of the cells of two runs whose Discover differed (look-back): footprint cosine at
# least MATCH_COS, centroids at most MATCH_PX apart.
MATCH_COS = 0.5
MATCH_PX = 20.0
NAN = float("nan")
WHITE_Z = 4.0


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


def read_min_valid(run: Path) -> dict[int, float] | None:
    """`{id: min_valid}` of a factor-engine run (`extract_min_valid.tsv`), or None for a
    run without the file (older runs, the frames route)."""
    path = run / "extract_min_valid.tsv"
    if not path.exists():
        return None
    return {int(r["id"]): float(r["min_valid"]) for r in read_tsv(path)}


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


def read_truth_footprints(path: Path) -> tuple[list[Cell], np.ndarray]:
    """Each truth unit's footprint `(pixels, values)` of a `truth.npz`, and its `cat_overlap`
    flag (all False when the file has none)."""
    z = np.load(path)
    ptr = z["A_indptr"]
    idx, val = z["A_indices"].astype(np.int64), z["A_data"].astype(np.float64)
    units = [
        (idx[ptr[k] : ptr[k + 1]], val[ptr[k] : ptr[k + 1]])
        for k in range(len(ptr) - 1)
    ]
    overlap = (
        np.asarray(z["cat_overlap"], dtype=bool)
        if "cat_overlap" in z.files
        else np.zeros(len(units), dtype=bool)
    )
    return units, overlap


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


def lag1_r(a: np.ndarray, b: np.ndarray) -> float:
    """Correlation of the temporally correlated parts of two traces.

    Built from lag-1 cross-covariances, `C(p, q) = mean of (p[t] q[t+1] + p[t+1] q[t]) / 2`,
    as `C(a, b) / sqrt(C(a, a) C(b, b))`. Noise that is white in time adds nothing to them in
    expectation, so a trace and its denoised version score near 1, where the plain correlation
    drops by the share of noise. NaN when either trace's lag-1 autocorrelation is not above
    `WHITE_Z / sqrt(n)` (a constant trace, or noise only) or there are fewer than 3 samples;
    the result is clipped to [-1, 1].
    """
    n = min(len(a), len(b))
    if n < 3:
        return NAN
    x, y = a[:n].astype(np.float64), b[:n].astype(np.float64)
    x, y = x - x.mean(), y - y.mean()

    def c(p: np.ndarray, q: np.ndarray) -> float:
        return float(0.5 * ((p[:-1] * q[1:]).sum() + (p[1:] * q[:-1]).sum()))

    cxx, cyy = c(x, x), c(y, y)
    # A trace has a slow part to compare only when its lag-1 autocorrelation is clearly positive:
    # white noise of n samples gives one of about 0 +- 1 / sqrt(n) (the compressor's own rule).
    floor = WHITE_Z / float(np.sqrt(n))
    sxx, syy = float((x * x).sum()), float((y * y).sum())
    if sxx <= 0 or syy <= 0 or cxx / sxx <= floor or cyy / syy <= floor:
        return NAN
    return float(np.clip(c(x, y) / np.sqrt(cxx * cyy), -1.0, 1.0))


def fp_cosine(a: Cell, b: Cell) -> float:
    da = dict(zip(a[0].tolist(), a[1].tolist()))
    dot = sum(da.get(p, 0.0) * v for p, v in zip(b[0].tolist(), b[1].tolist()))
    d = float(np.sqrt((a[1] ** 2).sum() * (b[1] ** 2).sum()))
    return float(dot / d) if d > 0 else NAN


def footprint_centroid(cell: Cell, w: int) -> tuple[float, float]:
    """Weighted centroid (y, x) of a footprint; NaN for an empty one."""
    pix, val = cell
    v = val.astype(np.float64)
    s = float(v.sum())
    if s <= 0:
        return NAN, NAN
    p = pix.astype(np.int64)
    return float((p // w * v).sum()) / s, float((p % w * v).sum()) / s


def match_cells(
    fa: dict[int, Cell],
    fb: dict[int, Cell],
    dims: tuple[int, int],
    min_cos: float = MATCH_COS,
) -> dict[int, int]:
    """Pairs (reference id to test id) of the cells of two runs whose cell sets differ: in
    falling footprint cosine, each cell in at most one pair, cosine at least `min_cos`,
    centroids at most `MATCH_PX` apart. Ids are not used: they do not correspond."""
    w = dims[1]
    cb = {k: footprint_centroid(c, w) for k, c in fb.items()}
    cand: list[tuple[float, int, int]] = []
    for ia, a in fa.items():
        ya, xa = footprint_centroid(a, w)
        for ib, b in fb.items():
            yb, xb = cb[ib]
            if not math.hypot(ya - yb, xa - xb) <= MATCH_PX:
                continue
            c = fp_cosine(a, b)
            if c >= min_cos:
                cand.append((c, ia, ib))
    cand.sort(key=lambda x: (-x[0], x[1], x[2]))
    out: dict[int, int] = {}
    used: set[int] = set()
    for _, ia, ib in cand:
        if ia not in out and ib not in used:
            out[ia] = ib
            used.add(ib)
    return out


def line_distance(c: float, n: int, tile: int) -> float:
    """Distance of coordinate `c` to the nearest tile line inside `n` px (lines at k * tile - 0.5)."""
    lines = np.arange(tile, n, tile) - 0.5
    return float(np.abs(lines - c).min()) if len(lines) else float("inf")


def truth_offset(
    traces: dict[int, np.ndarray],
    centroids: dict[int, tuple[float, float]],
    truth: Truth,
) -> tuple[float, float, int]:
    """Median (dy, dx) from each cell to the truth unit that best follows its trace, and the
    number of cells used (those whose best correlation is above `TRUTH_MIN_R`).

    The run is registered to its own template, so its frame is shifted against the truth by
    one global offset. Returns (0.0, 0.0, n) when fewer than `TRUTH_MIN_CELLS` cells are used.
    """
    cen, tr = truth
    dys: list[float] = []
    dxs: list[float] = []
    ok = np.isfinite(cen).all(axis=1)
    if ok.any():
        units = np.flatnonzero(ok)
        for cid, trace in traces.items():
            c = centroids.get(cid)
            if c is None or not (math.isfinite(c[0]) and math.isfinite(c[1])):
                continue
            n = min(len(trace), tr.shape[1])
            x = trace[:n].astype(np.float64)
            x = x - x.mean()
            u = tr[units, :n].astype(np.float64)
            u = u - u.mean(axis=1, keepdims=True)
            d = np.sqrt((x * x).sum() * (u * u).sum(axis=1))
            with np.errstate(divide="ignore", invalid="ignore"):
                r = np.where(d > 0, (u @ x) / d, np.nan)
            if not np.isfinite(r).any():
                continue
            k = int(np.nanargmax(r))
            if r[k] > TRUTH_MIN_R:
                dys.append(float(cen[units[k], 0] - c[0]))
                dxs.append(float(cen[units[k], 1] - c[1]))
    if len(dys) < TRUTH_MIN_CELLS:
        return 0.0, 0.0, len(dys)
    return float(np.median(dys)), float(np.median(dxs)), len(dys)


def truth_r(
    trace: np.ndarray,
    c: tuple[float, float],
    truth: Truth,
    offset: tuple[float, float] = (0.0, 0.0),
) -> float:
    """Best correlation with a truth unit within `TRUTH_PX` of `c` shifted by `offset`."""
    cen, tr = truth
    y, x = c[0] + offset[0], c[1] + offset[1]
    near = np.flatnonzero(np.hypot(cen[:, 0] - y, cen[:, 1] - x) <= TRUTH_PX)
    rs = [r for r in (pearson(trace, tr[k]) for k in near) if not math.isnan(r)]
    return max(rs) if rs else NAN


def truth_best(
    trace: np.ndarray,
    c: tuple[float, float],
    truth: Truth,
    offset: tuple[float, float] = (0.0, 0.0),
) -> tuple[int, float]:
    """The truth unit within `TRUTH_PX` of `c` shifted by `offset` that the trace follows
    best, and that correlation; (-1, NaN) when there is none."""
    cen, tr = truth
    y, x = c[0] + offset[0], c[1] + offset[1]
    best = (-1, NAN)
    for k in np.flatnonzero(np.hypot(cen[:, 0] - y, cen[:, 1] - x) <= TRUTH_PX):
        r = pearson(trace, tr[k])
        if not math.isnan(r) and (best[0] < 0 or r > best[1]):
            best = (int(k), r)
    return best


def fp_truth_r(
    cell: Cell, unit: Cell, shift: tuple[int, int], dims: tuple[int, int]
) -> float:
    """Correlation over the whole frame of a cell's footprint and a truth footprint moved
    into the run's frame by `shift` (truth pixel (y, x) goes to (y - dy, x - dx)); NaN when
    either is constant. main's demixing suite calls this the footprint r."""
    h, w = dims
    dy, dx = shift
    up, uv = unit
    y, x = up // w - dy, up % w - dx
    ok = (y >= 0) & (y < h) & (x >= 0) & (x < w)
    tp, tv = (y[ok] * w + x[ok]), uv[ok].astype(np.float64)
    a = dict(zip(cell[0].tolist(), cell[1].astype(np.float64).tolist()))
    sab = sum(a.get(p, 0.0) * v for p, v in zip(tp.tolist(), tv.tolist()))
    av = cell[1].astype(np.float64)
    n = h * w
    sa, saa = float(av.sum()), float((av * av).sum())
    sb, sbb = float(tv.sum()), float((tv * tv).sum())
    va, vb = saa - sa * sa / n, sbb - sb * sb / n
    if va <= 0 or vb <= 0:
        return NAN
    return float((sab - sa * sb / n) / math.sqrt(va * vb))


def compare(
    ref: Path,
    test: Path,
    tile: int = 64,
    truth_path: Path | None = None,
    pairs: dict[int, int] | None = None,
) -> list[Row]:
    """One row per cell of `ref`, compared with the cell of the same id in `test`, or with
    its partner in `pairs` (reference id to test id) when given."""
    return _compare(ref, test, tile, truth_path, pairs)[0]


def _compare(
    ref: Path,
    test: Path,
    tile: int,
    truth_path: Path | None,
    pairs: dict[int, int] | None = None,
) -> tuple[list[Row], tuple[float, float, int]]:
    """The rows of `compare` and the truth offset `(dy, dx, n cells)` used for them."""
    (h, w), fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    ta, tb = read_traces(ref), read_traces(test)
    cen, qc = read_centroids(ref), read_qc(ref)
    truth = read_truth(truth_path, (h, w)) if truth_path else None
    units, overlap = (
        read_truth_footprints(truth_path)
        if truth_path
        else ([], np.zeros(0, dtype=bool))
    )
    dy, dx, n_off = truth_offset(ta, cen, truth) if truth else (0.0, 0.0, 0)
    shift = (round(dy), round(dx))
    rows: list[Row] = []
    for cid in sorted(fa):
        tid = cid if pairs is None else pairs.get(cid, -1)
        cy, cx = cen.get(cid, (NAN, NAN))
        both = cid in ta and tid in tb
        ku = (
            truth_best(ta[cid], (cy, cx), truth, (dy, dx))[0]
            if truth and cid in ta
            else -1
        )
        kt = (
            truth_best(tb[tid], (cy, cx), truth, (dy, dx))[0]
            if truth and tid in tb
            else -1
        )
        row: Row = {
            "id": cid,
            "cy": cy,
            "cx": cx,
            "edge_px": min(line_distance(cy, h, tile), line_distance(cx, w, tile)),
            "border_px": min(cy, cx, h - 1 - cy, w - 1 - cx),
            "qc_pass": float(qc.get(cid, True)),
            "in_test": float(tid in fb),
            "fp_cos": fp_cosine(fa[cid], fb[tid]) if tid in fb else NAN,
            "trace_r": pearson(ta[cid], tb[tid]) if both else NAN,
            "trace_r1": lag1_r(ta[cid], tb[tid]) if both else NAN,
            "truth_r_ref": truth_r(ta[cid], (cy, cx), truth, (dy, dx))
            if truth and cid in ta
            else NAN,
            "truth_r_test": truth_r(tb[tid], (cy, cx), truth, (dy, dx))
            if truth and tid in tb
            else NAN,
            "truth_fp_ref": fp_truth_r(fa[cid], units[ku], shift, (h, w))
            if ku >= 0
            else NAN,
            "truth_fp_test": fp_truth_r(fb[tid], units[kt], shift, (h, w))
            if kt >= 0 and tid in fb
            else NAN,
            "truth_overlap": float(overlap[ku]) if ku >= 0 else NAN,
        }
        if pairs is not None:
            row["test_id"] = float(tid)
        rows.append(row)
    return rows, (dy, dx, n_off)


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


def dropped(rows: list[Row], key: str) -> int:
    """Number of QC-pass rows whose `key` is NaN (no value to compare)."""
    return sum(1 for r in rows if r["qc_pass"] and math.isnan(r[key]))


def verdict(
    test_loss: float,
    null_losses: list[float],
    test_dropped: int = 0,
    null_dropped: list[int] | None = None,
) -> str:
    nulls = [x for x in null_losses if not math.isnan(x)]
    if not nulls or math.isnan(test_loss):
        return "not judged"
    if test_loss > max(nulls):
        return "outside"
    if test_dropped > max(null_dropped or [], default=0):
        return "dropped cells"
    return "within"


# Gate A1 of the spec's Amendment 1 (limits approved 18 Nov 2026).
A1_TRUTH_MEDIAN = -0.01
A1_TRUTH_P5 = -0.05
A1_TRUTH_MIN_R = 0.8
A1_TRUTH_MIN_CELLS = 20
A1_FOOTPRINT_LOSS = 0.02
A1_TRACE_LOSS = 0.08
A1_JUMP_OVER_RAW = 0.10
A1_WORDS = {True: "pass", False: "fail", None: "does not apply"}
# A value exactly at a limit passes; this absorbs floating-point rounding.
A1_TOL = 1e-9


def a1_value(r: Row, key: str) -> float:
    """The row's value for gate A1: 0, the worst case, for a cell the test run lost
    (`in_test` 0, whatever its other columns hold) or a value that is not finite."""
    if not r.get("in_test", 1.0):
        return 0.0
    v = r[key]
    return v if math.isfinite(v) else 0.0


def a1_loss(qc: list[Row], key: str) -> float:
    """Median of `1 - value` over the QC-pass cells; a cell without a value loses 1."""
    if not qc:
        return NAN
    return float(np.median([1.0 - a1_value(r, key) for r in qc]))


def a1_gate(
    rows: list[Row], jump_ref: float, jump_test: float
) -> list[tuple[str, str, bool | None]]:
    """(rule, measured, passed) for the four rules of gate A1, on the QC-pass cells.

    A QC-pass cell that the test run lost, or whose value is not finite, counts as the
    worst case in every rule (loss 1; truth correlation 0 in the test run).
    The truth is usable when it is a property of the reference run alone: at least
    `A1_TRUTH_MIN_CELLS` QC-pass cells have a finite reference truth correlation and
    their median is at least `A1_TRUTH_MIN_R`. The truth rule applies then, the trace rule
    otherwise. `passed` is `None` for a rule that does not apply; a value that cannot be
    computed fails its rule.
    """
    qc = [r for r in rows if r["qc_pass"]]
    truth = [r for r in qc if math.isfinite(r["truth_r_ref"])]
    ref = np.asarray([r["truth_r_ref"] for r in truth], dtype=np.float64)
    med_ref = float(np.median(ref)) if len(ref) else NAN
    usable = len(truth) >= A1_TRUTH_MIN_CELLS and med_ref >= A1_TRUTH_MIN_R
    out: list[tuple[str, str, bool | None]] = []
    if usable:
        diff = np.asarray(
            [a1_value(r, "truth_r_test") - r["truth_r_ref"] for r in truth],
            dtype=np.float64,
        )
        med, p5 = float(np.median(diff)), float(np.percentile(diff, 5))
        out.append(
            (
                "1 truth",
                f"median {med:+.4f}, 5th pct {p5:+.4f} over {len(diff)} cells",
                med >= A1_TRUTH_MEDIAN - A1_TOL and p5 >= A1_TRUTH_P5 - A1_TOL,
            )
        )
    else:
        shown = "n/a" if math.isnan(med_ref) else f"{med_ref:.3f}"
        out.append(
            (
                "1 truth",
                (
                    f"no usable truth: {len(truth)} cells with a reference truth "
                    f"correlation (need {A1_TRUTH_MIN_CELLS}), median {shown} "
                    f"(need {A1_TRUTH_MIN_R})"
                ),
                None,
            )
        )
    fp = a1_loss(qc, "fp_cos")
    out.append(("2 footprints", f"loss {fp:.4f}", fp <= A1_FOOTPRINT_LOSS + A1_TOL))
    tr = a1_loss(qc, "trace_r1")
    out.append(
        (
            "3 traces without truth",
            f"loss {tr:.4f}",
            None if usable else tr <= A1_TRACE_LOSS + A1_TOL,
        )
    )
    out.append(
        (
            "4 tile lines",
            f"jump {jump_test:.3f} against {jump_ref:.3f}",
            jump_test <= jump_ref + A1_JUMP_OVER_RAW + A1_TOL,
        )
    )
    return out


def a1_passes(gate: list[tuple[str, str, bool | None]]) -> bool:
    """True when no rule of the gate failed."""
    return all(ok is not False for _, _, ok in gate)


def trace_gap(ta: dict[int, np.ndarray], tb: dict[int, np.ndarray]) -> dict[int, float]:
    """Per cell of both runs: the largest absolute difference of its two traces, over the
    standard deviation of the first (NaN when the first trace is constant)."""
    out: dict[int, float] = {}
    for cid in sorted(set(ta) & set(tb)):
        n = min(len(ta[cid]), len(tb[cid]))
        a = ta[cid][:n].astype(np.float64)
        b = tb[cid][:n].astype(np.float64)
        sd = float(np.std(a)) if n else 0.0
        out[cid] = float(np.max(np.abs(a - b))) / sd if sd > 0 else NAN
    return out


def engine_report(ref: Path, test: Path, band: float = 16.0) -> str:
    """Markdown: the traces of the factor engine (`test`) against those of the frame engine
    on frames rebuilt from the same factors (`ref`), by the cell's distance to the border.

    The two engines differ where pixels are missing: the frame engine fills them per frame,
    the factors hold the pixel's mean over the window. The border band is a proxy for those
    cells; the `min_valid` rows (when the test run has `extract_min_valid.tsv`) pick them.
    """
    (h, w), _ = read_footprints(ref / "footprints.bin")
    same = (ref / "footprints.bin").read_bytes() == (
        test / "footprints.bin"
    ).read_bytes()
    gap = trace_gap(read_traces(ref), read_traces(test))
    cen = read_centroids(ref)

    def border(cid: int) -> float:
        cy, cx = cen.get(cid, (NAN, NAN))
        return NAN if math.isnan(cy) else min(cy, cx, h - 1 - cy, w - 1 - cx)

    sets = [
        ("all cells", list(gap)),
        (f"{band:g} px or more from the border", [c for c in gap if border(c) >= band]),
        (f"under {band:g} px from the border", [c for c in gap if border(c) < band]),
    ]
    valid = read_min_valid(test)
    if valid is not None:
        sets += [
            ("min_valid below 1", [c for c in gap if valid.get(c, 1.0) < 1.0]),
            ("min_valid equal to 1", [c for c in gap if valid.get(c, 1.0) >= 1.0]),
        ]
    out = [
        f"### `{test.name}` against `{ref.name}`: factor engine against rebuilt frames",
        "",
        f"The two runs have the same footprints: {'yes' if same else 'no'}.",
        "",
        "| cells | n | largest trace difference over the trace's sd, median | largest |",
        "| --- | --- | --- | --- |",
    ]
    for name, ids in sets:
        v = np.asarray([gap[c] for c in ids], dtype=np.float64)
        v = v[np.isfinite(v)]
        top = f"{v.max():.4f}" if len(v) else "n/a"
        out.append(f"| {name} | {len(v)} | {q(v, 50)} | {top} |")
    if valid is not None:
        out += [
            "",
            (
                "`min_valid` is the smallest share of a window's frames in which every pixel of "
                "the cell's support was present, over all windows; a pixel never present in a window is "
                "stored as 0, which the factor engine reads and the frame engine treats as missing. "
                "Only the support is counted: a cell whose moat or ring holds a missing pixel still "
                "has `min_valid` 1 and can differ, so the row of cells at 1 is not a clean set."
            ),
        ]
    return "\n".join(out + [""])


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
        ("QC pass, no centroid", [r for r in rows if math.isnan(r["edge_px"])]),
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
    match: bool = False,
) -> str:
    """The Markdown comparison of `test` with `ref`, judged against the `nulls`.

    With `match`, cells are paired by footprint (`match_cells`) instead of by id: for runs
    whose Discover differed (look-back)."""
    dims, fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    pairs = match_cells(fa, fb, dims) if match else None
    rows, (dy, dx, n_off) = _compare(ref, test, tile, truth_path, pairs)
    null_rows = [compare(ref, n, tile, None) for n in nulls]
    missing = sum(1 for r in rows if not r["in_test"])
    partners = set(pairs.values()) if pairs is not None else set(fa)
    extra = len(set(fb) - partners)
    no_centroid = sum(1 for r in rows if math.isnan(r["edge_px"]))
    out = [f"### `{test.name}` against `{ref.name}`", ""]
    out.append(
        f"{len(rows)} cells in the reference run; {missing} of {len(rows)} cells are missing in the test run."
    )
    out.append(f"{extra} cells of the test run are not in the reference run.")
    out.append(
        f"{no_centroid} cells have no centroid in final.tsv and are in no tile-line group."
    )
    out += [
        "",
        "| cells | n | n with trace r | n with trace r1 | n with footprint cos | trace r median | trace r 5th pct | trace r1 median | trace r1 5th pct | footprint cos median | footprint cos 5th pct |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for name, g in groups(rows, band):
        tr, tr1, fc = finite(g, "trace_r"), finite(g, "trace_r1"), finite(g, "fp_cos")
        out.append(
            f"| {name} | {len(g)} | {len(tr)} | {len(tr1)} | {len(fc)} | {q(tr, 50)} | {q(tr, 5)} "
            f"| {q(tr1, 50)} | {q(tr1, 5)} | {q(fc, 50)} | {q(fc, 5)} |"
        )
    out += [
        "",
        "| cells | measure | QC-pass cells | without a value | most without a value in a null | loss | largest null loss | against the null |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for k, (name, g) in enumerate(subsets(rows)):
        n_qc = sum(1 for r in g if r["qc_pass"])
        for key, label, gated in (
            ("trace_r1", "trace r, lag 1", True),
            ("fp_cos", "footprint cos", True),
            ("trace_r", "trace r, plain", False),
        ):
            mine = loss(g, key)
            theirs = [loss(subsets(n)[k][1], key) for n in null_rows]
            null_drop = [dropped(subsets(n)[k][1], key) for n in null_rows]
            top = max([x for x in theirs if not math.isnan(x)], default=NAN)
            judged = (
                verdict(mine, theirs, dropped(g, key), null_drop)
                if gated
                else "not gated"
            )
            out.append(
                f"| {name} | {label} | {n_qc} | {dropped(g, key)} | {max(null_drop, default=0)} "
                f"| {mine:.5f} | {top:.5f} | {judged} |"
            )
    if truth_path:
        a, b = finite(rows, "truth_r_ref"), finite(rows, "truth_r_test")
        k = len(a)
        out += [
            "",
            (
                f"Truth frame offset (dy, dx) = ({dy:+.1f}, {dx:+.1f}) px from {n_off} cells; "
                f"{k} of {len(rows)} cells have a truth unit within {TRUTH_PX:g} px after it."
            ),
            f"Trace correlation with the truth, median: reference {q(a, 50)}, test {q(b, 50)}.",
        ]
        both = [
            r["truth_r_test"] - r["truth_r_ref"]
            for r in rows
            if math.isfinite(r["truth_r_ref"]) and math.isfinite(r["truth_r_test"])
        ]
        d = np.asarray(both, dtype=np.float64)
        out.append(
            f"Truth correlation, test minus reference, over {len(d)} cells (all cells): "
            f"median {q(d, 50)}, 5th pct {q(d, 5)}."
        )
        fr, ft = finite(rows, "truth_fp_ref"), finite(rows, "truth_fp_test")
        out.append(
            "Footprint correlation with the truth footprint, median: "
            f"reference {q(fr, 50)}, test {q(ft, 50)}."
        )
        for name, sel in (
            ("all cells", rows),
            (
                "cells whose truth unit overlaps another",
                [r for r in rows if r["truth_overlap"] == 1.0],
            ),
        ):
            d = np.asarray(
                [
                    r["truth_fp_test"] - r["truth_fp_ref"]
                    for r in sel
                    if math.isfinite(r["truth_fp_ref"])
                    and math.isfinite(r["truth_fp_test"])
                ],
                dtype=np.float64,
            )
            out.append(
                f"Truth footprint correlation, test minus reference, {name}: {len(d)} cells, "
                f"median {q(d, 50)}, 5th pct {q(d, 5)}."
            )
    if pairs is not None:
        paired = [r for r in rows if r["qc_pass"] and r["in_test"]]
        out += [
            "",
            (
                f"Cells paired by footprint (cosine at least {MATCH_COS:g}, centroids at most "
                f"{MATCH_PX:g} px apart): {len(pairs)} pairs. Over the {len(paired)} paired "
                f"QC-pass cells alone: footprint loss {a1_loss(paired, 'fp_cos'):.4f}, "
                f"trace loss {a1_loss(paired, 'trace_r1'):.4f}."
            ),
        ]
    ja, jb = line_jump(fa, dims, tile), line_jump(fb, dims, tile)
    gate = a1_gate(rows, ja, jb)
    n_qc = sum(1 for r in rows if r["qc_pass"])
    n_lost = sum(1 for r in rows if r["qc_pass"] and not r["in_test"])
    out += [
        "",
        f"Footprint jump at tile lines over elsewhere: reference {ja:.3f}, test {jb:.3f}.",
        "",
        f"Gate A1 runs over {n_qc} QC-pass cells; {n_lost} of them are missing in the test run.",
        "",
        "| A1 rule | measured | result |",
        "| --- | --- | --- |",
    ]
    out += [f"| {rule} | {what} | {A1_WORDS[ok]} |" for rule, what, ok in gate]
    out += ["", f"Gate A1: {'pass' if a1_passes(gate) else 'fail'}.", ""]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--ref", type=Path, required=True)
    ap.add_argument("--test", type=Path, required=True)
    ap.add_argument("--null", type=Path, action="append", default=[])
    ap.add_argument("--truth", type=Path)
    ap.add_argument(
        "--tile",
        type=int,
        default=64,
        help=(
            "spacing of the tile lines, px, for the edge distances and the footprint "
            "jump of both runs (default 64, plain tiles); arms on the offset grids "
            "need 32"
        ),
    )
    ap.add_argument("--band", type=float, default=16.0)
    ap.add_argument("--out", type=Path, help="per-cell table (tsv)")
    ap.add_argument(
        "--match",
        action="store_true",
        help="pair cells by footprint, not by id (runs whose Discover differed)",
    )
    a = ap.parse_args()
    print(report(a.ref, a.test, a.null, a.tile, a.band, a.truth, match=a.match))
    if a.out:
        dims, fa = read_footprints(a.ref / "footprints.bin")
        _, fb = read_footprints(a.test / "footprints.bin")
        pairs = match_cells(fa, fb, dims) if a.match else None
        rows = compare(a.ref, a.test, a.tile, a.truth, pairs)
        keys = list(rows[0]) if rows else ["id"]
        lines = ["\t".join(keys)] + [
            "\t".join(f"{r[k]:.6g}" for k in keys) for r in rows
        ]
        a.out.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
