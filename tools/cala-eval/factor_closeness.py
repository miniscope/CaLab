"""Closeness of two `qc_eval` runs of one recording, and gate A1 of the factor pipeline.

    python factor_closeness.py --ref RUN --test RUN [--null RUN ...]
        [--truth truth.npz] [--tile 64] [--band 16] [--out cells.tsv]

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
  before the 6 px radius.

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


def compare(
    ref: Path, test: Path, tile: int = 64, truth_path: Path | None = None
) -> list[Row]:
    """One row per cell of `ref`, compared with the cell of the same id in `test`."""
    return _compare(ref, test, tile, truth_path)[0]


def _compare(
    ref: Path, test: Path, tile: int, truth_path: Path | None
) -> tuple[list[Row], tuple[float, float, int]]:
    """The rows of `compare` and the truth offset `(dy, dx, n cells)` used for them."""
    (h, w), fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    ta, tb = read_traces(ref), read_traces(test)
    cen, qc = read_centroids(ref), read_qc(ref)
    truth = read_truth(truth_path, (h, w)) if truth_path else None
    dy, dx, n_off = truth_offset(ta, cen, truth) if truth else (0.0, 0.0, 0)
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
                "trace_r1": lag1_r(ta[cid], tb[cid]) if both else NAN,
                "truth_r_ref": truth_r(ta[cid], (cy, cx), truth, (dy, dx))
                if truth and cid in ta
                else NAN,
                "truth_r_test": truth_r(tb[cid], (cy, cx), truth, (dy, dx))
                if truth and cid in tb
                else NAN,
            }
        )
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
) -> str:
    """The Markdown comparison of `test` with `ref`, judged against the `nulls`."""
    rows, (dy, dx, n_off) = _compare(ref, test, tile, truth_path)
    null_rows = [compare(ref, n, tile, None) for n in nulls]
    dims, fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    missing = sum(1 for r in rows if not r["in_test"])
    extra = len(set(fb) - set(fa))
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
