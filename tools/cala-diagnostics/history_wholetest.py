"""Whole-history cell test on the low-rank factors alone (offline feasibility check).

    python history_wholetest.py RUN_DIR TRUTH_NPZ [--out NAME]
    python history_wholetest.py RUN_DIR --scan 4 --keep-known-activity --out history_wholetest_scan

``RUN_DIR`` is a ``discover_eval ... --factors-out RUN_DIR/factors`` output (``footprints.bin``
and ``factors/w*.fac``). With ``--scan STRIDE`` every grid spot in the field of view is tested
(no truth needed); ``history_review_score.py`` turns that table into candidates. See
``HISTORY_SCAN.md``.
Question: can a decision made on the whole compressed session, with its own noise reference,
confirm cells the slow loop missed (dim, overlapped), and tell them from non-cells?

At a spot, on a square patch, every frame of every window is rebuilt from the factors
(window mean dropped) and the run's final library plus a smooth background is removed by
least squares. The windows are split in two halves (even / odd). Each half gives the leading
spatial pattern of what is left; the test asks whether the two halves agree and whether one
half's pattern has calcium-like events in the other half's frames:

* ``cos``: cosine between the two halves' patterns (a noise pattern does not repeat);
* ``gain``: variance the other half's pattern explains, over the patch's average direction;
* ``peak_z``: (max - median) / (1.4826 MAD) of the cross-fitted trace; ``event_z``: the
  same peak over the noise below the median (not inflated by frequent activity);
* ``width``: sigma (px) of the averaged pattern; ``shift``: its peak's distance from the spot.

Nothing is in raw-noise units: the reference is the same statistics at empty spots (far from
every true, out-of-focus and library cell). Classes scored:

* ``missed``: detectable truth cells the run did not find;
* ``loo``: found cells with their own footprint left out of the model (what a clear cell
  looks like to this test);
* ``oof``: out-of-focus cells away from true cells (real light, not a cell);
* ``empty``: the null.

Writes ``RUN_DIR/<NAME>.tsv`` (one row per spot) and prints the summary.
"""

from __future__ import annotations

import argparse
import multiprocessing as mp
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

HALF = 14  # patch half-size, px
FAR = 15.0  # an empty spot is at least this far from every known centre, px
FOV_SHARE = (
    0.44  # spots stay inside this share of the frame's short side from its centre
)
N_EMPTY = 150
N_LOO = 60
BG_ORDER = 2  # polynomial order of the background removed per frame
DISK = 7.0  # the pattern is looked for within this radius of the spot, px

# x0, y0, w, h, spatial, temporal, mean
Tile = tuple[int, int, int, int, np.ndarray, np.ndarray, np.ndarray]


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def read_tsv(path: Path) -> list[dict[str, str]]:
    lines = path.read_text().splitlines()
    head = lines[0].split("\t")
    return [dict(zip(head, ln.split("\t"), strict=False)) for ln in lines[1:]]


def read_factor_file(path: Path) -> list[Tile]:
    """(x0, y0, w, h, spatial P x r, temporal T x r, mean P) per tile of one window."""
    b = path.read_bytes()
    assert b[:8] == b"CALAFAC1", path
    n = struct.unpack_from("<I", b, 24)[0]
    at, out = 36, []
    for _ in range(n):
        (ln,) = struct.unpack_from("<I", b, at)
        tb = b[at + 4 : at + 4 + ln]
        at += 4 + ln
        x0, y0, w, h, rank, frames, _ = struct.unpack_from("<7I", tb, 4)
        mean = np.frombuffer(tb, "<f4", w * h, 48)
        o = 48 + 4 * w * h
        sp = np.frombuffer(tb, "<f4", w * h * rank, o).reshape(w * h, rank)
        tm = np.frombuffer(tb, "<f4", frames * rank, o + 4 * w * h * rank)
        out.append((x0, y0, w, h, sp, tm.reshape(frames, rank), mean))
    return out


def read_library(
    path: Path,
) -> tuple[int, int, list[tuple[int, np.ndarray, np.ndarray]]]:
    """(H, W, [(id, pixel indices, unfiltered values)]) from ``footprints.bin``."""
    with path.open("rb") as f:
        assert f.read(8) == b"CALAFP01"
        h, w, n = struct.unpack("<III", f.read(12))
        cells = []
        for _ in range(n):
            i, k = struct.unpack("<II", f.read(8))
            pix = np.frombuffer(f.read(4 * k), "<u4").astype(np.int64)
            val = np.frombuffer(f.read(4 * k), "<f4").copy()
            f.seek(4 * k, 1)
            cells.append((i, pix, val))
    return h, w, cells


@dataclass
class Truth:
    y: np.ndarray
    x: np.ndarray
    found: np.ndarray
    n_events: np.ndarray
    snr: np.ndarray
    cats: dict[str, np.ndarray]
    matched_id: np.ndarray  # library id of the match, -1 when missed
    all_centres: np.ndarray  # every true cell, detectable or not
    oof: np.ndarray


def load_truth(run: Path, truth: Path) -> Truth:
    """Detectable truth cells in the run's frame coordinates."""
    units = [u for u in read_tsv(run / "gt_units.tsv") if u["detectable"] == "true"]
    match = {
        int(r["gt"]): int(r["id"])
        for r in read_tsv(run / "labels.tsv")
        if r["class"] == "match"
    }
    off = read_tsv(run / "gt_offset.tsv")[0]
    d = np.array([int(off["dy"]), int(off["dx"])])
    z = np.load(truth)
    idx = np.array([int(u["oracle_unit_index"]) for u in units])
    mid = np.array([match.get(int(u["slot"]), -1) for u in units])
    return Truth(
        y=np.array([float(u["cy"]) for u in units]) - d[0],
        x=np.array([float(u["cx"]) for u in units]) - d[1],
        found=mid >= 0,
        n_events=(z["spikes"] > 0).sum(axis=1)[idx],
        snr=np.array([float(u["peak_snr"]) for u in units]),
        cats={
            k[4:]: z[k][idx].astype(bool)
            for k in ("cat_dim", "cat_small", "cat_overlap", "cat_late")
        },
        matched_id=mid,
        all_centres=z["centroids"] - d,
        oof=z["oof_centroids"] - d,
    )


# ---------------------------------------------------------------------------
# Patch data and model
# ---------------------------------------------------------------------------


def patch_frames(
    windows: list[list[Tile]], y0: int, x0: int, size: int
) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Per window: the patch's frames rebuilt from the factors with the window mean dropped
    (T, size^2), and that mean image (size^2)."""
    blocks, means = [], []
    for tiles in windows:
        frames = tiles[0][5].shape[0]
        out = np.zeros((frames, size * size), np.float32)
        mean = np.zeros(size * size, np.float32)
        for tx, ty, tw, th, sp, tm, mu in tiles:
            ya, yb = max(y0, ty), min(y0 + size, ty + th)
            xa, xb = max(x0, tx), min(x0 + size, tx + tw)
            if ya >= yb or xa >= xb:
                continue
            yy, xx = np.mgrid[ya:yb, xa:xb]
            src = ((yy - ty) * tw + (xx - tx)).ravel()
            dst = ((yy - y0) * size + (xx - x0)).ravel()
            out[:, dst] = tm @ sp[src].T
            mean[dst] = mu[src]
        blocks.append(out)
        means.append(mean)
    return blocks, means


def without_nuisance(block: np.ndarray, mean: np.ndarray, size: int) -> np.ndarray:
    """A window's frames with its mean image and the mean's two spatial gradients fitted
    out of every frame: what a brightness change of the whole frame and a sub-pixel shift
    leave behind."""
    img = mean.reshape(size, size)
    gy, gx = np.gradient(img)
    cols = np.stack([img.ravel(), gy.ravel(), gx.ravel()], axis=1).astype(np.float64)
    return block - (block @ np.linalg.pinv(cols).T.astype(np.float32)) @ cols.T.astype(
        np.float32
    )


def shift_keys(run: Path, n_frames: int, step: float) -> np.ndarray:
    """One integer per frame naming its motion-correction shift, binned to ``step`` px."""
    rows = read_tsv(run / "frames.tsv")[:n_frames]
    dy = np.round(np.array([float(r["dy"]) for r in rows]) / step).astype(np.int64)
    dx = np.round(np.array([float(r["dx"]) for r in rows]) / step).astype(np.int64)
    _, key = np.unique(dy * 100_000 + dx, return_inverse=True)
    return key


def without_shift_pattern(frames: np.ndarray, key: np.ndarray) -> np.ndarray:
    """Frames minus the mean frame of their motion-shift bin. The sensor's fixed pixel
    pattern is static on the chip, so registration moves it across the image with the
    shift: a pixel-scale pattern that repeats whenever the shift repeats."""
    n = min(len(frames), len(key))
    out = frames.copy()
    sums = np.zeros((int(key.max()) + 1, frames.shape[1]), np.float64)
    np.add.at(sums, key[:n], frames[:n])
    counts = np.bincount(key[:n], minlength=len(sums))[:, None]
    out[:n] -= (sums / np.maximum(counts, 1)).astype(np.float32)[key[:n]]
    return out


def model_columns(
    cells: list[tuple[int, np.ndarray, np.ndarray]],
    width: int,
    y0: int,
    x0: int,
    size: int,
    skip: int,
) -> np.ndarray:
    """Library footprints on the patch (``skip``: an id left out) plus the background."""
    cols = []
    for i, pix, val in cells:
        if i == skip:
            continue
        py, px = pix // width - y0, pix % width - x0
        ok = (py >= 0) & (py < size) & (px >= 0) & (px < size)
        if ok.sum() < 4:
            continue
        c = np.zeros(size * size, np.float32)
        c[py[ok] * size + px[ok]] = val[ok]
        cols.append(c)
    g = np.linspace(-1.0, 1.0, size, dtype=np.float32)
    yy, xx = np.meshgrid(g, g, indexing="ij")
    for a in range(BG_ORDER + 1):
        for b in range(BG_ORDER + 1 - a):
            cols.append((yy**a * xx**b).ravel())
    return np.stack(cols, axis=1)


def residual(frames: np.ndarray, cols: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Frames with the least-squares fit of the model columns removed, and the fit's
    coefficients (T, columns)."""
    coef = frames @ np.linalg.pinv(cols.astype(np.float64)).T.astype(np.float32)
    return frames - coef @ cols.T, coef


def disk_mask(size: int, radius: float) -> np.ndarray:
    yy, xx = np.mgrid[:size, :size] - size // 2
    return (np.hypot(yy, xx) <= radius).ravel()


# ---------------------------------------------------------------------------
# The test
# ---------------------------------------------------------------------------


def leading(res: np.ndarray) -> np.ndarray:
    """Leading spatial pattern of a block of residual frames, mostly positive."""
    _, v = np.linalg.eigh((res.T @ res).astype(np.float64))
    h = v[:, -1]
    return (h if h.sum() >= 0 else -h).astype(np.float32)


def robust_peak(c: np.ndarray) -> float:
    med = np.median(c)
    mad = 1.4826 * np.median(np.abs(c - med))
    return float((c.max() - med) / mad) if mad > 0 else 0.0


def event_z(c: np.ndarray) -> float:
    """Peak above the median in units of the noise below the median, which a cell's own
    activity does not inflate (``robust_peak`` falls for cells that fire often)."""
    med = np.median(c)
    low = c[c < med] - med
    sigma = float(np.sqrt((low**2).mean())) if len(low) else 0.0
    return float((c.max() - med) / sigma) if sigma > 0 else 0.0


def pattern_shape(h: np.ndarray, size: int) -> tuple[float, float]:
    """(sigma px of the positive part around its peak, peak's distance from the centre)."""
    img = np.maximum(h.reshape(size, size), 0)
    py, px = np.unravel_index(int(img.argmax()), img.shape)
    yy, xx = np.mgrid[:size, :size]
    r2 = (yy - py) ** 2 + (xx - px) ** 2
    near = r2 <= (size // 2) ** 2
    m = img[near].sum()
    sigma = float(np.sqrt((img[near] * r2[near]).sum() / (2 * m))) if m > 0 else 0.0
    return sigma, float(np.hypot(py - size // 2, px - size // 2))


def neighbour_corr(
    frames: np.ndarray, cols: np.ndarray, h: np.ndarray, n_cells: int
) -> float:
    """Largest correlation between the pattern's time course and a library cell's, with
    the pattern fitted jointly with the model (so neither takes the other's light)."""
    if n_cells == 0:
        return 0.0
    joint = np.concatenate([cols, h[:, None]], axis=1).astype(np.float64)
    coef = frames @ np.linalg.pinv(joint).T.astype(np.float32)
    c = coef[:, -1]
    cz = (c - c.mean()) / (c.std() + 1e-9)
    nb = coef[:, :n_cells]
    nz = (nb - nb.mean(0)) / (nb.std(0) + 1e-9)
    return float(np.abs(cz @ nz).max() / len(c))


def without_known_activity(
    res: np.ndarray, coef: np.ndarray, n_cells: int
) -> np.ndarray:
    """Residual frames with, at every pixel, whatever co-varies with a known cell's time
    course removed. An imperfect footprint leaves a remainder that moves exactly with its
    cell; a separate cell keeps the part of its activity the known cells do not share."""
    if n_cells == 0:
        return res
    c = coef[:, :n_cells].astype(np.float64)
    q, _ = np.linalg.qr(c - c.mean(axis=0))
    q = q.astype(np.float32)
    return res - q @ (q.T @ res)


def asym_events(c: np.ndarray) -> float:
    """Event evidence of a time course per 1000 frames: squared excess above 3 sigma minus
    squared excess below -3 sigma, sigma being the noise below the median."""
    med = np.median(c)
    low = c[c < med] - med
    noise = float(np.sqrt((low**2).mean())) if len(low) else 0.0
    if noise <= 0:
        return 0.0
    z = (c - med) / noise
    pos = float((np.maximum(z - 3.0, 0.0) ** 2).sum())
    neg = float((np.maximum(-z - 3.0, 0.0) ** 2).sum())
    return 1000.0 * (pos - neg) / len(c)


def cell_template(size: int, sigma: float) -> np.ndarray:
    """A cell-shaped filter at the patch centre: a Gaussian of the cells' width minus one
    twice as wide, zero sum and unit norm (flat and broad light give nothing)."""
    yy, xx = np.mgrid[:size, :size] - size // 2
    r2 = (yy**2 + xx**2).astype(np.float64)
    core = np.exp(-r2 / (2 * sigma**2))
    wide = np.exp(-r2 / (2 * (2 * sigma) ** 2))
    t = (core / core.sum() - wide / wide.sum()).ravel()
    return (t / np.linalg.norm(t)).astype(np.float32)


def event_score(
    res: np.ndarray, coef: np.ndarray, n_cells: int, sigma: float
) -> dict[str, float]:
    """One number for "a cell is here": the event evidence a cell-shaped filter collects
    over the whole session.

    The filter's time course on the residual frames is cleared of what follows the known
    cells' time courses (the leftover of an imperfect footprint moves with its cell), then
    measured in units of its own noise below the baseline. ``score`` adds up the squared
    excess of every frame above 3 sigma and subtracts the same sum for frames below
    -3 sigma: calcium events are positive only, noise and motion residue are symmetric.
    Per 1000 frames. ``ev_width`` and ``ev_shift`` describe the average residual image of
    the event frames (its sigma and its peak's distance from the spot, px): a cell is as
    wide as the library's cells and sits at the spot."""
    size = round(float(np.sqrt(res.shape[1])))
    c = (res @ cell_template(size, sigma)).astype(np.float64)
    if n_cells:
        x = np.column_stack([coef[:, :n_cells].astype(np.float64), np.ones(len(c))])
        c = c - x @ np.linalg.lstsq(x, c, rcond=None)[0]
    med = np.median(c)
    low = c[c < med] - med
    noise = float(np.sqrt((low**2).mean())) if len(low) else 0.0
    none = {"score": 0.0, "score_pos": 0.0, "ev_width": 0.0, "ev_shift": float(size)}
    if noise <= 0:
        return none
    z = (c - med) / noise
    w = np.maximum(z - 3.0, 0.0)
    pos = float((w**2).sum())
    neg = float((np.maximum(-z - 3.0, 0.0) ** 2).sum())
    if pos <= 0:
        return none
    # What the events look like: the residual frames averaged with the events' weights.
    width, shift = pattern_shape((w.astype(np.float32) @ res) / float(w.sum()), size)
    return {
        "score": 1000.0 * (pos - neg) / len(c),
        "score_pos": 1000.0 * pos / len(c),
        "ev_width": width,
        "ev_shift": shift,
    }


def whole_test(
    frames: np.ndarray,
    cols: np.ndarray,
    half_id: np.ndarray,
    size: int,
    n_cells: int,
    sigma: float,
) -> dict[str, float]:
    """One spot's statistics: the single event score, and the split-half ones on the disk."""
    disk = disk_mask(size, DISK)
    res, coef = residual(frames, cols)
    single = event_score(res, coef, n_cells, sigma)
    if CTX.get("project", True):
        res = without_known_activity(res, coef, n_cells)
    res = res[:, disk]
    a, b = res[half_id == 0], res[half_id == 1]
    ha, hb = leading(a), leading(b)
    if ha @ hb < 0:
        hb = -hb
    ca, cb = a @ hb, b @ ha  # each half's frames on the other half's pattern
    mean_dir = (float((a**2).sum()) + float((b**2).sum())) / res.shape[1]
    gain = (float((ca**2).sum()) + float((cb**2).sum())) / mean_dir
    h_img = np.zeros(size * size, np.float32)
    h_img[disk] = ha + hb
    width, shift = pattern_shape(h_img, size)
    return {
        **single,
        "xscore": min(asym_events(ca), asym_events(cb)),
        "nb_corr": neighbour_corr(frames, cols, np.maximum(h_img, 0), n_cells),
        "cos": float(abs(ha @ hb)),
        "gain": gain,
        "peak_z": min(robust_peak(ca), robust_peak(cb)),
        "event_z": min(event_z(ca), event_z(cb)),
        "width": width,
        "shift": shift,
    }


# ---------------------------------------------------------------------------
# Spots
# ---------------------------------------------------------------------------


def library_sigma(cells: list[tuple[int, np.ndarray, np.ndarray]]) -> float:
    """Median Gaussian width of the library's footprints, px (from the area above half max)."""
    s = [
        np.sqrt((v >= 0.5 * v.max()).sum() / np.pi) / 1.177
        for _, _, v in cells
        if len(v)
    ]
    return float(np.median(s)) if s else 3.5


def fov_radius(shape: tuple[int, int]) -> float:
    return FOV_SHARE * min(shape)


def empty_spots(known: np.ndarray, shape: tuple[int, int], n: int) -> np.ndarray:
    """Random FOV positions at least ``FAR`` px from every known centre."""
    rng = np.random.default_rng(0)
    cy, cx = shape[0] / 2, shape[1] / 2
    out: list[tuple[float, float]] = []
    while len(out) < n:
        y, x = rng.uniform(0, shape[0]), rng.uniform(0, shape[1])
        if np.hypot(y - cy, x - cx) > fov_radius(shape):
            continue
        if np.hypot(known[:, 0] - y, known[:, 1] - x).min() >= FAR:
            out.append((y, x))
    return np.array(out)


def spot_list(
    t: Truth, lib_centres: np.ndarray, shape: tuple[int, int]
) -> list[tuple[str, float, float, int, int]]:
    """(class, y, x, truth row or -1, library id to leave out or -1)."""
    cy, cx = shape[0] / 2, shape[1] / 2
    inside = np.hypot(t.y - cy, t.x - cx) <= fov_radius(shape)
    spots = [
        ("missed", t.y[i], t.x[i], i, -1) for i in np.flatnonzero(~t.found & inside)
    ]
    rng = np.random.default_rng(1)
    found = np.flatnonzero(t.found & inside)
    for i in rng.choice(found, min(N_LOO, len(found)), replace=False):
        spots.append(("loo", t.y[i], t.x[i], int(i), int(t.matched_id[i])))
    for y, x in t.oof:
        d_true = np.hypot(t.all_centres[:, 0] - y, t.all_centres[:, 1] - x).min()
        d_lib = np.hypot(lib_centres[:, 0] - y, lib_centres[:, 1] - x).min()
        if np.hypot(y - cy, x - cx) <= fov_radius(shape) and min(d_true, d_lib) >= FAR:
            spots.append(("oof", y, x, -1, -1))
    known = np.concatenate([t.all_centres, t.oof, lib_centres])
    spots += [("empty", y, x, -1, -1) for y, x in empty_spots(known, shape, N_EMPTY)]
    return spots


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

STATS = (
    "xscore",
    "score",
    "score_pos",
    "ev_width",
    "ev_shift",
    "cos",
    "gain",
    "peak_z",
    "event_z",
    "width",
    "shift",
    "nb_corr",
)


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """Probability that a positive scores above a negative."""
    if not len(pos) or not len(neg):
        return float("nan")
    return float(
        (pos[:, None] > neg[None, :]).mean()
        + 0.5 * (pos[:, None] == neg[None, :]).mean()
    )


def summary(rows: list[dict]) -> str:
    cls = np.array([r["class"] for r in rows])
    val = {s: np.array([r[s] for r in rows]) for s in STATS}
    lines = ["class\tn\t" + "\t".join(f"{s} median" for s in STATS)]
    for c in ("loo", "missed", "oof", "empty"):
        m = cls == c
        lines.append(
            f"{c}\t{m.sum()}\t"
            + "\t".join(f"{np.median(val[s][m]):.2f}" for s in STATS)
        )
    lines.append("")
    lines.append(
        "stat\tAUC loo/empty\tAUC missed/empty\tAUC missed/oof\tempty p99\tmissed above\tloo above\toof above"
    )
    for s in ("xscore", "score", "cos", "gain"):
        v = val[s]
        p99 = float(np.quantile(v[cls == "empty"], 0.99))
        lines.append(
            f"{s}\t{auc(v[cls == 'loo'], v[cls == 'empty']):.2f}\t{auc(v[cls == 'missed'], v[cls == 'empty']):.2f}"
            f"\t{auc(v[cls == 'missed'], v[cls == 'oof']):.2f}\t{p99:.2f}"
            f"\t{(v[cls == 'missed'] > p99).sum()}/{(cls == 'missed').sum()}"
            f"\t{(v[cls == 'loo'] > p99).sum()}/{(cls == 'loo').sum()}"
            f"\t{(v[cls == 'oof'] > p99).sum()}/{(cls == 'oof').sum()}"
        )
    return "\n".join(lines)


CTX: dict = {}


def test_spot(spot: tuple[str, float, float, int, int]) -> dict:
    """One spot's row (uses the data in ``CTX``; runs in a worker process)."""
    cls, y, x, ti, skip = spot
    height, width, size = CTX["height"], CTX["width"], 2 * HALF + 1
    y0 = int(np.clip(round(y) - HALF, 0, height - size))
    x0 = int(np.clip(round(x) - HALF, 0, width - size))
    blocks, means = patch_frames(CTX["windows"], y0, x0, size)
    if CTX["nuisance"]:
        blocks = [
            without_nuisance(b, m, size) for b, m in zip(blocks, means, strict=True)
        ]
    frames = np.concatenate(blocks)
    if CTX.get("shift_key") is not None:
        frames = without_shift_pattern(frames, CTX["shift_key"])
    cols = model_columns(CTX["cells"], width, y0, x0, size, skip)
    n_cells = cols.shape[1] - (BG_ORDER + 1) * (BG_ORDER + 2) // 2
    row: dict = {"class": cls, "y": y, "x": x, "truth_row": ti}
    row.update(
        whole_test(frames, cols, CTX["half_id"], size, n_cells, CTX["cell_sigma"])
    )
    return row


def library_spots(
    cells: list[tuple[int, np.ndarray, np.ndarray]],
    lib_centres: np.ndarray,
    shape: tuple[int, int],
) -> list[tuple[str, float, float, int, int]]:
    """Without truth: library cells with their own footprint left out (``loo``) and
    empty spots far from every library cell."""
    cy, cx = shape[0] / 2, shape[1] / 2
    inside = np.flatnonzero(
        np.hypot(lib_centres[:, 0] - cy, lib_centres[:, 1] - cx) <= fov_radius(shape)
    )
    rng = np.random.default_rng(1)
    pick = rng.choice(inside, min(2 * N_LOO, len(inside)), replace=False)
    spots = [("loo", *lib_centres[i], -1, int(cells[i][0])) for i in pick]
    spots += [
        ("empty", y, x, -1, -1) for y, x in empty_spots(lib_centres, shape, N_EMPTY)
    ]
    return spots


def grid_spots(
    shape: tuple[int, int], stride: int
) -> list[tuple[str, float, float, int, int]]:
    """Every ``stride`` px inside the field of view."""
    cy, cx = shape[0] / 2, shape[1] / 2
    return [
        ("scan", float(y), float(x), -1, -1)
        for y in range(0, shape[0], stride)
        for x in range(0, shape[1], stride)
        if np.hypot(y - cy, x - cx) <= fov_radius(shape)
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("run", type=Path)
    ap.add_argument(
        "truth", type=Path, nargs="?", help="truth.npz (not needed with --scan)"
    )
    ap.add_argument("--out", default="history_wholetest")
    ap.add_argument(
        "--scan", type=int, default=0, help="test a grid with this stride, px"
    )
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--bg-order", type=int, default=BG_ORDER)
    ap.add_argument(
        "--keep-known-activity",
        action="store_true",
        help="do not remove what co-varies with the known cells' time courses",
    )
    ap.add_argument(
        "--cell-sigma",
        type=float,
        default=0.0,
        help="cell width for the event score, px (default: from the library)",
    )
    ap.add_argument(
        "--shift-step",
        type=float,
        default=0.0,
        help="remove the mean frame per motion-shift bin of this size, px (0 = off)",
    )
    ap.add_argument(
        "--nuisance",
        action="store_true",
        help="fit each window's mean image and its gradients out of the frames",
    )
    a = ap.parse_args()

    height, width, cells = read_library(a.run / "footprints.bin")
    lib_centres = np.array(
        [
            [(v @ (p // width)) / v.sum(), (v @ (p % width)) / v.sum()]
            for _, p, v in cells
        ]
    )
    windows = [read_factor_file(p) for p in sorted((a.run / "factors").glob("w*.fac"))]
    half_id = np.concatenate(
        [np.full(w[0][5].shape[0], k % 2, np.int8) for k, w in enumerate(windows)]
    )
    CTX.update(
        height=height, width=width, cells=cells, windows=windows, half_id=half_id
    )
    CTX["nuisance"] = a.nuisance
    CTX["project"] = not a.keep_known_activity
    CTX["cell_sigma"] = a.cell_sigma or library_sigma(cells)
    globals()["BG_ORDER"] = a.bg_order
    CTX["shift_key"] = (
        shift_keys(a.run, len(half_id), a.shift_step) if a.shift_step > 0 else None
    )
    t = None if a.scan or a.truth is None else load_truth(a.run, a.truth)
    if a.scan:
        spots = grid_spots((height, width), a.scan)
    elif t is None:
        spots = library_spots(cells, lib_centres, (height, width))
    else:
        spots = spot_list(t, lib_centres, (height, width))
    with mp.get_context("fork").Pool(a.jobs) as pool:
        rows = pool.map(test_spot, spots, chunksize=8)
    cats = list(t.cats) if t is not None else []
    if t is not None:
        for r in rows:
            ti = r["truth_row"]
            if ti >= 0:
                r.update(n_events=int(t.n_events[ti]), snr=float(t.snr[ti]))
                r.update({k: int(v[ti]) for k, v in t.cats.items()})
    keys = ["class", "y", "x", "truth_row", *STATS, "n_events", "snr", *cats]
    with (a.run / f"{a.out}.tsv").open("w") as f:
        f.write("\t".join(keys) + "\n")
        for r in rows:
            f.write("\t".join(f"{r.get(k, '')}" for k in keys) + "\n")
    if not a.scan:
        print(summary(rows))
    else:
        print(f"{len(rows)} grid spots written to {a.run / (a.out + '.tsv')}")


if __name__ == "__main__":
    main()
