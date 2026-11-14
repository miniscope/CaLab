"""Make a two-session recording from one minisim sim: perturb the frames after a boundary.

    $MINISIM_PY tools/cala-eval/stitch_sessions.py <src sim> <out sim> [options]
      --boundary N     first frame of session B (default 4800)
      --shift DY,DX    rigid move of B's tissue, px (sub-pixel allowed; default 0,0)
      --rotate DEG     rotation of B's tissue about the frame centre, degrees (default 0)
      --gain G         multiply B's camera counts by G (default 1)
      --offset O       add O grey levels to B's camera counts (default 0)
      --seed S         dither / noise seed (default 0)
      --b-source SIM   session B's frames come from another sim of the same size (a
                       different field of view: the failed-boundary case of the
                       boundary-flag calibration). The GT stays the source's, so it is
                       wrong after the boundary: score only session A
      --aperture-dark F  render BOTH sessions through a sensor-fixed lit disk that leaves the
                       share F of the frame dark (real Miniscope frames: ~0.28), edge
                       `--aperture-edge` px (default 10), dark level `--dark-level` grey (default 4)

Models several Miniscope sessions of one animal concatenated into one recording (the
session-boundary study, `results/2026-11-13-session-boundary.md`). Session A (frames
before the boundary) is copied bit for bit (APFS clone where possible); session B is the
same cells and the same activity (the GT is shared), seen through a perturbation applied
to the raw 8-bit frames here, outside cala:

* Geometry (shift / rotation) moves the *tissue* only. minisim renders
  `counts = floor(s * (T(x) * M(x) + L(x)) + noise)` with `M = illumination * vignette`
  and `L` the leakage glow, both fixed to the sensor (`daq/ground_truth`), and
  `s = photons_per_unit * quantum_efficiency * gain_adu_per_e` (`spec.json`). Each B frame
  is de-quantized (`R + U(0, 1)`), divided into tissue `T = (R - s L) / (s M)`,
  resampled at the moved coordinates with the bicubic Keys kernel (the kernel cala's
  warp uses), and re-composed with the sensor-fixed `M` and `L` at the output pixel, so
  the vignette and the glow do not move.
* Noise. Resampling averages noise (sub-pixel) and the `M(x) / M(x - d)` ratio rescales
  it. The per-pixel noise the output carries is computed from minisim's sensor model
  (`var = gain_adu_per_e * E + (read_noise_e * gain_adu_per_e)^2 + 1/12`, `E` the
  session-A mean image) and the shortfall to the model at the output is added as
  Gaussian noise (fixed per pixel, so B has the noise level a real recording at that
  brightness would). Where the carried noise exceeds the model (only where dim tissue
  moves into a brighter part of the field) it is kept; `session.json` reports the share.
  Integer shifts carry the noise exactly (one tap) apart from the `M` ratio.
* Edges. Tissue that the move brings in from outside the frame (or from where `M` is
  under 0.05) has no data. It is filled with session A's *time-mean* tissue at the
  mirrored position plus model noise: static texture, no activity, so the fill adds
  no cells and no transients, and the GT (which does not know the fill) stays right.
* Aperture (`--aperture-dark`). Real Miniscope frames are a lit disk on a dark frame
  (~28 % dark); minisim's frames are lit to the edge. With this option every frame, A's
  included, becomes `D x + (1 - D) d0 + n`: `D` a disk centred on the frame with a cosine
  edge, `d0` the dark level, `n` Gaussian noise topping the scaled noise up to the model
  at the new brightness. The B perturbation acts on `x`, inside the disk, before `D`: the
  dark corners do not change, as in the real data. A is rewritten (no clone savings).
* Intensity (`--gain`, `--offset`) acts on the de-quantized counts after the geometry,
  `G * x + O`, then `floor` and clip to 0..255 (minisim's sensor has no dark offset, so
  the camera offset is 0 and the gain scales all fluorescence including the glow;
  noise scales with G, as for an analog gain change).

Ground truth: `oracle.bin`, the GT zarr and metadata are shared with the source. A rigid
shift of B adds to the true content shift, so `shifts.npy` gets `+(dy, dx)` for B's
frames (a static source gets zeros for A). qc_eval reads `shifts.npy` for `--motion`
runs (GT frame offset, PR #374). A rotation is not representable there; B's mean
content shift is zero (rotation about the centre) and that is what is written.

The output's AVIs have the same layout as the source's (uncompressed 8-bit `00dc`
chunks, 1000 frames per file). `session.json` records the arguments and noise checks.
Needs numpy and zarr (the minisim venv). About 3 min per sim for a geometry arm.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import zarr

FRAMES_PER_FILE = 1000
M_MIN = 0.05


def avi_frames(path: Path, n_px: int, mode: str = "r") -> tuple[np.memmap, list[int]]:
    """Memmap of an uncompressed AVI and the byte offset of each frame's payload."""
    mm = np.memmap(path, dtype=np.uint8, mode=mode)
    b = mm[: 1 << 20].tobytes()
    i = b.find(b"movi")
    assert i > 0, path
    off = i + 4
    offs = []
    size = len(mm)
    while off + 8 <= size:
        cid = mm[off : off + 4].tobytes()
        sz = int.from_bytes(mm[off + 4 : off + 8].tobytes(), "little")
        if cid == b"idx1":
            break
        if cid[2:] in (b"dc", b"db"):
            assert sz == n_px, (path, cid, sz)
            offs.append(off + 8)
        off += 8 + sz + (sz & 1)
    return mm, offs


def keys(t: np.ndarray) -> list[np.ndarray]:
    """Keys (a = -0.5) bicubic weights of the 4 taps at offsets -1, 0, 1, 2 for fraction t."""
    a = -0.5

    def w(x):
        x = np.abs(x)
        return np.where(
            x <= 1,
            (a + 2) * x**3 - (a + 3) * x**2 + 1,
            np.where(x < 2, a * x**3 - 5 * a * x**2 + 8 * a * x - 4 * a, 0.0),
        )

    return [w(t + 1), w(t), w(1 - t), w(2 - t)]


def sampler(h: int, w: int, dy: float, dx: float, rot_deg: float):
    """Taps for out(y, x) = in(source(y, x)), the tissue moved by (dy, dx) and rotated.

    Returns (flat indices [k, n], weights [k, n], outside mask [n]) with zero-weight taps
    pruned. `outside`: the source point lies outside the frame (no data).
    """
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    cy, cx = (h - 1) / 2.0, (w - 1) / 2.0
    # Forward: content at p moves to R (p - c) + c + d. Inverse for the source.
    th = np.deg2rad(rot_deg)
    py, px = yy - dy - cy, xx - dx - cx
    sy = np.cos(th) * py + np.sin(th) * px + cy
    sx = -np.sin(th) * py + np.cos(th) * px + cx
    outside = (sy < 0) | (sy > h - 1) | (sx < 0) | (sx > w - 1)
    y0, x0 = np.floor(sy), np.floor(sx)
    fy, fx = sy - y0, sx - x0
    wy, wx = keys(fy), keys(fx)
    idx, wts = [], []
    for i in range(4):
        yi = np.clip(y0 + i - 1, 0, h - 1).astype(np.int64)
        for j in range(4):
            xj = np.clip(x0 + j - 1, 0, w - 1).astype(np.int64)
            wt = wy[i] * wx[j]
            if np.any(np.abs(wt) > 1e-9):
                idx.append((yi * w + xj).ravel())
                wts.append(wt.ravel())
    return np.array(idx), np.array(wts, dtype=np.float32), outside.ravel(), (sy.ravel(), sx.ravel())


def mirror(sy: np.ndarray, sx: np.ndarray, h: int, w: int) -> np.ndarray:
    """Nearest in-frame pixel index of the mirrored source position."""

    def ref(v, n):
        v = np.abs(v)
        v = np.where(v > n - 1, 2 * (n - 1) - v, v)
        return np.clip(np.rint(v), 0, n - 1).astype(np.int64)

    return ref(sy, h) * w + ref(sx, w)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--boundary", type=int, default=4800)
    ap.add_argument("--shift", default="0,0")
    ap.add_argument("--rotate", type=float, default=0.0)
    ap.add_argument("--gain", type=float, default=1.0)
    ap.add_argument("--offset", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--aperture-dark", type=float, default=0.0)
    ap.add_argument("--aperture-edge", type=float, default=10.0)
    ap.add_argument("--dark-level", type=float, default=4.0)
    ap.add_argument("--b-source", type=Path, default=None)
    a = ap.parse_args()
    dy, dx = (float(v) for v in a.shift.split(","))
    src, out = a.src.resolve(), a.out.resolve()
    if out.exists():
        print(f"{out} exists; delete it to regenerate")
        return 1
    tmp = out.with_name(out.name + ".partial")
    if tmp.exists():
        shutil.rmtree(tmp)
    # Clone everything (APFS copy-on-write: no disk until B's frames are written).
    subprocess.run(["cp", "-c", "-R", str(src), str(tmp)], check=True)

    spec = json.loads((src / "spec.json").read_text())
    sensor = spec["acquisition"]["image_sensor"]
    ppu = next(st["photons_per_unit"] for st in spec["steps"] if st["kind"] == "sensor")
    g_adu = sensor["gain_adu_per_e"]
    s = ppu * sensor["quantum_efficiency"] * g_adu
    read_var = (sensor["read_noise_e"] * g_adu) ** 2
    h, w = sensor["n_px_height"], sensor["n_px_width"]
    n = h * w

    gt = zarr.open(str(src / "daq" / "ground_truth" / "ground_truth.zarr" / "ground_truth"), mode="r")
    m_field = (np.asarray(gt["illumination"]) * np.asarray(gt["vignette"])).ravel().astype(np.float32)
    leak = (s * np.asarray(gt["leakage"])).ravel().astype(np.float32)
    lit = m_field >= M_MIN

    avis = sorted((tmp / "daq" / "Miniscope").glob("*.avi"), key=lambda p: int(p.stem))
    frames_total = 0
    files = []
    for p in avis:
        mm, offs = avi_frames(p, n, "r+")
        files.append((mm, offs))
        frames_total += len(offs)

    def frame_ref(t):
        mm, offs = files[t // FRAMES_PER_FILE]
        o = offs[t % FRAMES_PER_FILE]
        return mm, o

    # Session A mean (every 20th frame of A): the noise model's brightness and the fill.
    a_idx = range(0, a.boundary, 20)
    mean_a = np.zeros(n, np.float64)
    for t in a_idx:
        mm, o = frame_ref(t)
        mean_a += mm[o : o + n]
    mean_a = (mean_a / len(a_idx) + 0.5).astype(np.float32)
    var_model = lambda e: g_adu * np.maximum(e, 0) + read_var + 1.0 / 12.0  # noqa: E731
    tissue_mean = np.where(lit, (mean_a - leak) / np.where(lit, m_field, 1), 0).astype(np.float32)

    geometric = (dy, dx) != (0.0, 0.0) or a.rotate != 0.0
    info = {
        "source": str(src),
        "boundary": a.boundary,
        "shift": [dy, dx],
        "rotate_deg": a.rotate,
        "gain": a.gain,
        "offset": a.offset,
        "seed": a.seed,
        "scale_adu_per_unit": s,
        "frames": frames_total,
        "b_source": str(a.b_source.resolve()) if a.b_source else None,
    }
    b_files = []
    if a.b_source:
        for p in sorted((a.b_source / "daq" / "Miniscope").glob("*.avi"), key=lambda p: int(p.stem)):
            b_files.append(avi_frames(p, n, "r"))

    def b_frame(t):
        mm, offs = b_files[t // FRAMES_PER_FILE]
        o = offs[t % FRAMES_PER_FILE]
        return mm[o : o + n]
    if geometric:
        idx, wts, outside, (sy, sx) = sampler(h, w, dy, dx, a.rotate)
        # A tap without data: outside the frame, or the source pixel is unlit.
        src_ok = ~outside & np.all(lit[idx] | (np.abs(wts) < 1e-9), axis=0)
        fill = ~src_ok & lit
        fill_src = mirror(sy, sx, h, w)
        fill_val = tissue_mean[fill_src]
        # Carried noise variance of the composed output and the model's at the output.
        var_in = var_model(mean_a)
        carried = m_field**2 * np.sum(wts**2 * (var_in / np.where(lit, m_field, 1) ** 2)[idx], axis=0)
        mean_out = np.where(
            src_ok, m_field * np.sum(wts * tissue_mean[idx], axis=0) + leak, np.where(fill, m_field * fill_val + leak, mean_a)
        )
        target = var_model(mean_out)
        add_sd = np.sqrt(np.maximum(target - np.where(src_ok, carried, 0.0), 0.0)).astype(np.float32)
        excess = src_ok & lit & (carried > 1.05 * target)
        info.update(
            fill_pixels=int(fill.sum()),
            noise_added_median_sd=float(np.median(add_sd[src_ok & lit])),
            noise_excess_share=float(excess.sum() / max((src_ok & lit).sum(), 1)),
            carried_over_target_median=float(np.median((carried / target)[src_ok & lit])),
        )
    aperture = a.aperture_dark > 0.0
    if aperture:
        yy, xx = np.mgrid[0:h, 0:w]
        dist = np.hypot(yy - (h - 1) / 2, xx - (w - 1) / 2).ravel()
        radius = np.sqrt((1.0 - a.aperture_dark) * h * w / np.pi)
        u = np.clip((radius - dist) / a.aperture_edge + 0.5, 0.0, 1.0)
        disk = (0.5 - 0.5 * np.cos(np.pi * u)).astype(np.float32)
        ap_mean = disk * mean_a + (1 - disk) * a.dark_level
        ap_sd = np.sqrt(np.maximum(var_model(ap_mean) - disk**2 * var_model(mean_a), 0.0)).astype(np.float32)
        info.update(
            aperture_dark=a.aperture_dark,
            aperture_radius_px=float(radius),
            aperture_edge_px=a.aperture_edge,
            dark_level=a.dark_level,
            dark_share=float((disk < 0.5).mean()),
        )
    rng = np.random.default_rng(a.seed)
    identity = not geometric and a.gain == 1.0 and a.offset == 0.0 and not a.b_source
    # (The identity arm would rewrite B unchanged: floor(R + U) = R. Skip it.)
    first = 0 if aperture else a.boundary
    for t in range(first, frames_total if (aperture or not identity) else 0):
        mm, o = frame_ref(t)
        src_frame = b_frame(t) if (a.b_source and t >= a.boundary) else mm[o : o + n]
        r = src_frame.astype(np.float32) + rng.random(n, dtype=np.float32)
        if t < a.boundary:
            v = disk * r + (1 - disk) * a.dark_level + ap_sd * rng.standard_normal(n, dtype=np.float32)
            mm[o : o + n] = np.clip(np.floor(v), 0, 255).astype(np.uint8)
            if t % 500 == 0:
                print(f"frame {t}", flush=True)
            continue
        if geometric:
            tis = np.where(lit, (r - leak) / np.where(lit, m_field, 1), 0).astype(np.float32)
            moved = np.sum(wts * tis[idx], axis=0)
            v = np.where(src_ok, moved, fill_val)
            v = np.where(lit, m_field * v + leak, r) + add_sd * rng.standard_normal(n, dtype=np.float32)
        else:
            v = r
        v = a.gain * v + a.offset
        if aperture:
            v = disk * v + (1 - disk) * a.dark_level + ap_sd * rng.standard_normal(n, dtype=np.float32)
        mm[o : o + n] = np.clip(np.floor(v), 0, 255).astype(np.uint8)
        if t % 500 == 0:
            print(f"frame {t}", flush=True)
    for mm, _ in files:
        mm.flush()

    # Ground-truth content shift.
    sh_path = tmp / "shifts.npy"
    sh = np.load(sh_path) if sh_path.exists() else np.zeros((frames_total, 2))
    sh = sh.astype(np.float64)
    sh[a.boundary :, 0] += dy
    sh[a.boundary :, 1] += dx
    np.save(sh_path, sh)
    (tmp / "session.json").write_text(json.dumps(info, indent=1) + "\n")
    os.rename(tmp, out)
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
