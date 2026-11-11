#!/usr/bin/env python3
"""Candidate sampling and bundle rendering for the blind labelling tool.

Three steps (see README.md):

  select   pool the cells of several `qc_eval real` runs (plus Minian
           components no run found), deduplicate, sample strata, shuffle and
           write `candidates.tsv` + `candidates.bin` for
           `qc_eval real ... --label-bundle candidates.tsv` and
           `selection.json` (the provenance, kept out of the bundle).
  render   turn the raw crops written by `qc_eval --label-bundle` into the
           served bundle: PNG sprite sheets with ONE fixed grey range for the
           whole bundle (no auto-contrast), trace JSON with one fixed y-range,
           `items.json` (opaque ids in shuffled order) and `manifest.json`
           (provenance, never served and never shown).
  resolve  join `labels.jsonl` (last line per id wins) with the manifest.

Only numpy and Pillow are needed to render; `select` also reads Minian's
`A.zarr` (zarr) when `--minian` is given.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import time
from pathlib import Path

import numpy as np

PRE = 180  # frames before an event peak (9 s at 20 fps)
POST = 260  # frames after it (13 s)
SPAN = PRE + POST + 1
EVENTS = 3
FPS = 20
TRACE_POINTS = 2000
EDGE_PX = 10  # footprints reaching this close to the image border are "edge"

# Default stratum sizes for 300 candidates; the remainder goes to `uniform`.
STRATA = {"flagged": 80, "run_specific": 60, "minian_only": 60}


# --------------------------------------------------------------- footprints


def read_fp(path):
    """`footprints.bin` (CALAFP01) -> (H, W, [(id, pixels, a, h)])."""
    b = Path(path).read_bytes()
    if b[:8] != b"CALAFP01":
        raise ValueError(f"{path}: not a CALAFP01 file")
    h, w, n = struct.unpack_from("<3I", b, 8)
    o = 20
    out = []
    for _ in range(n):
        cid, m = struct.unpack_from("<2I", b, o)
        o += 8
        p = np.frombuffer(b, "<u4", m, o).astype(np.int64)
        o += 4 * m
        a = np.frombuffer(b, "<f4", m, o).astype(np.float32)
        o += 4 * m
        hh = np.frombuffer(b, "<f4", m, o).astype(np.float32)
        o += 4 * m
        out.append((cid, p, a, hh))
    return h, w, out


def write_fp(path, h, w, cells):
    """cells: [(id, pixels, a)] -> CALAFP01 (the filtered column repeats `a`)."""
    with open(path, "wb") as f:
        f.write(b"CALAFP01")
        f.write(struct.pack("<3I", h, w, len(cells)))
        for cid, p, a in cells:
            f.write(struct.pack("<2I", cid, len(p)))
            f.write(np.asarray(p, "<u4").tobytes())
            f.write(np.asarray(a, "<f4").tobytes())
            f.write(np.asarray(a, "<f4").tobytes())


def centroid(p, a, w):
    wt = np.maximum(a, 1e-9)
    return float(np.average(p // w, weights=wt)), float(np.average(p % w, weights=wt))


def footprint_r(p1, a1, p2, a2):
    """Pearson r of two sparse footprints over the union of their pixels."""
    u = np.union1d(p1, p2)
    va = np.zeros(len(u))
    vb = np.zeros(len(u))
    va[np.searchsorted(u, p1)] = a1
    vb[np.searchsorted(u, p2)] = a2
    if va.std() == 0 or vb.std() == 0:
        return 0.0
    return float(np.corrcoef(va, vb)[0, 1])


def best_match(entry, others, radius=15.0):
    """Highest r between `entry` and any of `others` whose centroid is near."""
    best, who = 0.0, -1
    for j, o in enumerate(others):
        if np.hypot(o["cy"] - entry["cy"], o["cx"] - entry["cx"]) > radius:
            continue
        r = footprint_r(entry["p"], entry["a"], o["p"], o["a"])
        if r > best:
            best, who = r, j
    return best, who


def touches_edge(p, h, w, margin=EDGE_PX):
    y, x = p // w, p % w
    return bool(y.min() < margin or x.min() < margin or y.max() >= h - margin or x.max() >= w - margin)


def opaque_id(source, ident):
    return hashlib.sha1(f"{source},{ident}".encode()).hexdigest()[:8]


# ----------------------------------------------------------------- select


def load_run(run_dir):
    """Cells of one `qc_eval real` run, with its flag columns when present."""
    run_dir = Path(run_dir)
    h, w, fps = read_fp(run_dir / "footprints.bin")
    flags = {}
    ana = run_dir / "ana.tsv"
    if ana.exists():
        import csv

        with open(ana) as f:
            for row in csv.DictReader(f, delimiter="\t"):
                flags[int(row["slot"])] = row
    cells = []
    for slot, (cid, p, a, _h) in enumerate(fps):
        cy, cx = centroid(p, a, w)
        row = flags.get(slot, {})
        flagged = set()
        if row.get("tex") == "True":
            flagged.add("texture")
        if row.get("two") == "True":
            flagged.add("two_peak")
        if touches_edge(p, h, w):
            flagged.add("edge")
        cells.append(
            dict(source=run_dir.name, id=int(cid), p=p, a=a, cy=cy, cx=cx, flags=sorted(flagged), seen_in=[run_dir.name])
        )
    return h, w, cells


def load_minian(path, w, offset):
    import zarr

    arr = zarr.open(str(path), mode="r")["A"]
    mw = arr.shape[2]
    dy, dx = offset
    cells = []
    for u in range(arr.shape[0]):
        a = np.nan_to_num(np.asarray(arr[u], dtype=np.float64)).ravel()
        nz = np.flatnonzero(a > 0)
        if nz.size == 0:
            continue
        y, x = nz // mw + dy, nz % mw + dx
        keep = (y >= 0) & (y < arr.shape[1]) & (x >= 0) & (x < w)
        if not keep.any():
            continue
        p = (y[keep] * w + x[keep]).astype(np.int64)
        v = a[nz][keep].astype(np.float32)
        cy, cx = centroid(p, v, w)
        cells.append(dict(source="minian", id=u, p=p, a=v, cy=cy, cx=cx, flags=[], seen_in=["minian"]))
    return cells


def pool_runs(per_run, same_r=0.7):
    """Union of the runs' cells; a cell that matches an earlier one at r >= same_r is the same cell."""
    pool = []
    for cells in per_run:
        for c in cells:
            r, j = best_match(c, pool)
            if r >= same_r:
                pool[j]["seen_in"].extend(c["seen_in"])
            else:
                pool.append(c)
    return pool


def sample_strata(pool, minian_only, n, seed, strata=None):
    """Pick n candidates: flagged / run-specific / Minian-only quotas, the rest uniform.

    Quotas are capped by availability and the shortfall goes to `uniform`; a cell
    is in one stratum only (the first that claims it). Returns a shuffled list of
    (entry, stratum).
    """
    strata = dict(STRATA if strata is None else strata)
    rng = np.random.default_rng(seed)
    n_runs = len({s for c in pool for s in c["seen_in"]})
    taken: set[int] = set()
    out = []

    def draw(idx, k, name):
        idx = [i for i in idx if i not in taken]
        k = min(k, len(idx))
        picks = rng.choice(idx, size=k, replace=False) if k else []
        for i in picks:
            taken.add(int(i))
            out.append((pool[int(i)], name))

    draw([i for i, c in enumerate(pool) if c["flags"]], strata["flagged"], "flagged")
    draw([i for i, c in enumerate(pool) if len(set(c["seen_in"])) < n_runs], strata["run_specific"], "run_specific")
    k_min = min(strata["minian_only"], len(minian_only))
    if k_min:
        out.extend((minian_only[int(i)], "minian_only") for i in rng.choice(len(minian_only), size=k_min, replace=False))
    draw(range(len(pool)), max(n - len(out), 0), "uniform")
    order = rng.permutation(len(out))
    return [out[int(i)] for i in order]


def cmd_select(a):
    per_run, h, w = [], None, None
    for r in a.runs:
        h, w, cells = load_run(r)
        per_run.append(cells)
        print(f"{r}: {len(cells)} cells")
    pool = pool_runs(per_run)
    print(f"pool after deduplication: {len(pool)}")
    minian_only = []
    if a.minian:
        off = tuple(int(v) for v in a.minian_offset.split(","))
        mn = load_minian(a.minian, w, off)
        for c in mn:
            r, _ = best_match(c, pool)
            if r < 0.5:
                minian_only.append(c)
        print(f"minian: {len(mn)} components, {len(minian_only)} unmatched at r < .5")
    picked = sample_strata(pool, minian_only, a.n, a.seed)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rows, cells, prov = [], [], []
    for i, (c, stratum) in enumerate(picked):
        cid = opaque_id(c["source"], c["id"])
        rows.append(f"{cid}\t{c['cy']:.2f}\t{c['cx']:.2f}")
        cells.append((i, c["p"], c["a"]))
        prov.append(
            dict(cid=cid, index=i, source=c["source"], id=c["id"], stratum=stratum, seen_in=sorted(set(c["seen_in"])), flags=c["flags"], cy=c["cy"], cx=c["cx"])
        )
    (out / "candidates.tsv").write_text("cid\tcy\tcx\n" + "\n".join(rows) + "\n")
    write_fp(out / "candidates.bin", h, w, cells)
    (out / "selection.json").write_text(json.dumps(dict(seed=a.seed, runs=[Path(r).name for r in a.runs], candidates=prov), indent=1))
    counts = {s: sum(1 for p in prov if p["stratum"] == s) for s in ("flagged", "run_specific", "minian_only", "uniform")}
    print(f"{len(picked)} candidates written to {out}: {counts}")


# ----------------------------------------------------------------- render


def fixed_range(arrays, lo_q, hi_q, per_array=4000, seed=0):
    """One (lo, hi) for a whole bundle from a pixel sample of every array."""
    rng = np.random.default_rng(seed)
    parts = []
    for x in arrays:
        flat = np.asarray(x, dtype=np.float32).ravel()
        parts.append(flat[rng.integers(0, flat.size, size=min(per_array, flat.size))])
    v = np.concatenate(parts)
    lo, hi = np.percentile(v, [lo_q, hi_q])
    if hi <= lo:
        hi = lo + 1.0
    return float(lo), float(hi)


LEVELS = 32  # grey levels of the sprite sheets (noise does not compress; 32 keeps 300 candidates near 150 MB)


def to_u8(x, lo, hi, levels=256):
    """Linear map with the bundle's fixed range, `levels` grey steps; values outside clip."""
    q = np.clip((np.asarray(x, np.float32) - lo) / (hi - lo), 0.0, 1.0) * (levels - 1)
    return np.round(np.round(q) * (255.0 / (levels - 1))).astype(np.uint8)


def sprite(frames, lo, hi, levels=LEVELS):
    """frames [EVENTS, SPAN, c, c] -> one image, events as rows, frames as columns."""
    e, s, c, _ = frames.shape
    return to_u8(frames, lo, hi, levels).transpose(0, 2, 1, 3).reshape(e * c, s * c)


def centre(x, size):
    """Central size x size window of the last two axes."""
    c = x.shape[-1]
    o = (c - size) // 2
    return x[..., o : o + size, o : o + size]


def decimate_max(tr, n=TRACE_POINTS):
    """At most n points, each the block maximum so a short event survives."""
    if len(tr) <= n:
        return [float(v) for v in tr], 1
    k = int(np.ceil(len(tr) / n))
    m = len(tr) // k * k
    blocks = np.asarray(tr[:m]).reshape(-1, k).max(axis=1)
    return [round(float(v), 3) for v in blocks], k


def cmd_render(a):
    from PIL import Image

    raw = Path(a.raw)
    sel = json.loads((Path(a.select) / "selection.json").read_text())
    cands = sel["candidates"]
    n = len(cands)
    crops = [ln.split("\t") for ln in (raw / "crops.tsv").read_text().splitlines()[1:]]
    crop = int(crops[0][3])
    show = min(a.display_crop, crop)
    t_len = (raw / "traces.f32").stat().st_size // 4 // n
    traces = np.memmap(raw / "traces.f32", dtype="<f4", mode="r", shape=(n, t_len))
    snip_y = np.memmap(raw / "snip_y.f32", dtype="<f4", mode="r", shape=(n, EVENTS, SPAN, crop, crop))
    snip_pre = np.memmap(raw / "snip_pre.f32", dtype="<f4", mode="r", shape=(n, EVENTS, SPAN, crop, crop))
    mean_y = np.fromfile(raw / "mean_y.f32", dtype="<f4").reshape(n, crop, crop)
    mean_pre = np.fromfile(raw / "mean_pre.f32", dtype="<f4").reshape(n, crop, crop)
    peaks = np.zeros((n, EVENTS), int)
    for ln in (raw / "peaks.tsv").read_text().splitlines()[1:]:
        i, e, t = (int(v) for v in ln.split("\t"))
        peaks[i, e] = t

    # One range for the whole bundle, set before any image is drawn.
    y_lo, y_hi = fixed_range((snip_y[i] for i in range(n)), 1.0, 99.5)
    p_lo, p_hi = fixed_range((snip_pre[i] for i in range(n)), 1.0, 99.5)
    tr_lo, tr_hi = fixed_range((traces[i] for i in range(n)), 0.1, 99.9, per_array=t_len)
    # Event-triggered average: peak frames minus the pre-event baseline, one range for all.
    eta = np.stack([snip_y[i, :, PRE - 1 : PRE + 2].mean((0, 1)) - snip_y[i, :, 0 : PRE // 2].mean((0, 1)) for i in range(n)])
    # Max projection of the crop over all event frames; its own fixed ranges (a max sits far above a mean).
    max_y = np.stack([snip_y[i].max((0, 1)) for i in range(n)])
    max_pre = np.stack([snip_pre[i].max((0, 1)) for i in range(n)])
    my_lo, my_hi = fixed_range([max_y], 1.0, 99.5, per_array=max_y.size)
    mp_lo, mp_hi = fixed_range([max_pre], 1.0, 99.5, per_array=max_pre.size)
    e_lo, e_hi = fixed_range([eta], 1.0, 99.5, per_array=eta.size)
    e_lo = min(e_lo, -e_hi * 0.1)
    print(f"fixed ranges: y [{y_lo:.2f}, {y_hi:.2f}] raw [{p_lo:.2f}, {p_hi:.2f}] eta [{e_lo:.2f}, {e_hi:.2f}] trace [{tr_lo:.2f}, {tr_hi:.2f}]")

    fp_pixels = read_fp(Path(a.select) / "candidates.bin")[2]
    h_img, w_img, _ = read_fp(Path(a.select) / "candidates.bin")
    out = Path(a.out)
    (out / "c").mkdir(parents=True, exist_ok=True)
    for i, c in enumerate(cands):
        d = out / "c" / c["cid"]
        d.mkdir(exist_ok=True)
        Image.fromarray(sprite(centre(np.asarray(snip_y[i]), show), y_lo, y_hi)).save(d / "snip.png", optimize=True)
        Image.fromarray(sprite(centre(np.asarray(snip_pre[i]), show), p_lo, p_hi)).save(d / "raw.png", optimize=True)
        # Footprint on the crop grid, shown as a shape (peak = 1: its scale is arbitrary).
        _, p, wts, _ = fp_pixels[i]
        y0, x0 = (int(v) for v in crops[i][1:3])
        fp = np.zeros((crop, crop), np.float32)
        yy, xx = p // w_img - y0, p % w_img - x0
        ok = (yy >= 0) & (yy < crop) & (xx >= 0) & (xx < crop)
        fp[yy[ok], xx[ok]] = np.maximum(wts[ok], 0)
        peak = float(fp.max()) or 1.0
        Image.fromarray(to_u8(centre(fp / peak, show), 0.0, 1.0)).save(d / "fp.png", optimize=True)
        Image.fromarray(to_u8(centre(mean_y[i], show), y_lo, y_hi, LEVELS)).save(d / "mean.png", optimize=True)
        Image.fromarray(to_u8(centre(mean_pre[i], show), p_lo, p_hi, LEVELS)).save(d / "mean_raw.png", optimize=True)
        Image.fromarray(to_u8(centre(max_y[i], show), my_lo, my_hi, LEVELS)).save(d / "max.png", optimize=True)
        Image.fromarray(to_u8(centre(max_pre[i], show), mp_lo, mp_hi, LEVELS)).save(d / "max_raw.png", optimize=True)
        Image.fromarray(to_u8(centre(eta[i], show), e_lo, e_hi, LEVELS)).save(d / "eta.png", optimize=True)
        full, k = decimate_max(traces[i])
        wins = [[round(float(v), 3) for v in traces[i][t - PRE : t + POST + 1]] for t in peaks[i]]
        (d / "trace.json").write_text(json.dumps(dict(full=full, step=k, n=t_len, events=[int(t) for t in peaks[i]], windows=wins), separators=(",", ":")))
        if i % 50 == 0:
            print(f"rendered {i}/{n}")

    order = [c["cid"] for c in cands]
    items = dict(
        order=order,
        crop=show,
        span=SPAN,
        pre=PRE,
        built=int(time.time()),  # cache-busting token for the page's requests
        events=EVENTS,
        fps=FPS,
        trace_range=[tr_lo, tr_hi],
        # Informational only; the PNGs are already scaled with these.
        grey_range=dict(processed=[y_lo, y_hi], raw=[p_lo, p_hi], eta=[e_lo, e_hi], max=[my_lo, my_hi], max_raw=[mp_lo, mp_hi]),
    )
    (out / "items.json").write_text(json.dumps(items))
    (out / "manifest.json").write_text(json.dumps(dict(selection=sel), indent=1))
    mb = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1e6
    print(f"bundle: {n} candidates, {mb:.1f} MB at {out}")


# ---------------------------------------------------------------- resolve


def last_labels(path):
    """Latest line per cid; a null label is an undo and removes the entry."""
    latest = {}
    p = Path(path)
    if not p.exists():
        return latest
    for ln in p.read_text().splitlines():
        if not ln.strip():
            continue
        try:
            rec = json.loads(ln)
        except json.JSONDecodeError:
            continue  # a torn final line
        latest[rec["cid"]] = rec
    return {k: v for k, v in latest.items() if v.get("label") in ("cell", "not", "unsure")}


def resolve(bundle):
    bundle = Path(bundle)
    man = json.loads((bundle / "manifest.json").read_text())["selection"]["candidates"]
    labels = last_labels(bundle / "labels.jsonl")
    rows = []
    for c in man:
        rec = labels.get(c["cid"])
        if rec:
            rows.append({**c, "label": rec["label"], "merged": rec.get("merged", False), "edge_flag": rec.get("edge", False), "part_flag": rec.get("part", False), "ms": rec.get("ms")})
    return rows


def cmd_resolve(a):
    rows = resolve(a.bundle)
    out = Path(a.bundle) / "resolved.json"
    out.write_text(json.dumps(rows, indent=1))
    from collections import Counter

    print(f"{len(rows)} labelled; {dict(Counter(r['label'] for r in rows))}")
    for s in sorted({r["stratum"] for r in rows}):
        sub = [r for r in rows if r["stratum"] == s]
        print(f"  {s}: {dict(Counter(r['label'] for r in sub))}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("select")
    s.add_argument("--runs", nargs="+", required=True, help="qc_eval real run dirs (footprints.bin, ana.tsv)")
    s.add_argument("--minian", help="Minian A.zarr")
    s.add_argument("--minian-offset", default="1,0", help="row,col shift from Minian to cala coordinates")
    s.add_argument("--n", type=int, default=300)
    s.add_argument("--seed", type=int, default=1)
    s.add_argument("--out", required=True)
    s.set_defaults(f=cmd_select)
    r = sub.add_parser("render")
    r.add_argument("--select", required=True, help="dir of select")
    r.add_argument("--raw", required=True, help="dir written by qc_eval --label-bundle")
    r.add_argument("--out", required=True, help="bundle dir")
    r.add_argument("--display-crop", type=int, default=32, help="side of the window shown, px (<= the crop qc_eval cut)")
    r.set_defaults(f=cmd_render)
    v = sub.add_parser("resolve")
    v.add_argument("bundle")
    v.set_defaults(f=cmd_resolve)
    a = ap.parse_args(argv)
    a.f(a)


if __name__ == "__main__":
    sys.exit(main())
