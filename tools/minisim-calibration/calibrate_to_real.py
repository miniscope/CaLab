"""Measure how closely a minisim recording matches a real Miniscope recording.

Computes the statistics the realism calibration targets (see ``CALIBRATION.md``) for a real recording and for a simulated one, side
by side:

* **Registration content** - frames are band-passed the way a rigid registration
  sees them (3x3 median, then a difference of Gaussians, sigma 1.5 / 15 px),
  un-shifted with known registering shifts, and cropped to the central 256 px.
  Per-pixel power is split into *static* (spatial variance of the temporal mean),
  *white* (half the mean squared frame difference) and *slow dynamic* (the rest of
  the temporal variance). Also the median normalized cross-correlation (NCC) of
  each frame to the mean (the template).
* **Grey levels** - mean inside the field of view and in the central 64 px.
* **Noise vs brightness** - pixels are binned by their temporal mean; the
  per-bin median of half the mean squared frame difference (which drops slow
  trends) is fitted as ``var = slope * mean + intercept``. For a shot-noise
  sensor ``slope`` is the gain in grey levels per photo-electron.
* **Illumination falloff** - the radial profile of the (smoothed) mean image,
  normalized to the centre.
* **Vessels** - the mean image divided by its local background (Gaussian, sigma
  15 px): the depth of the darkest dips, the fraction of the field darker than
  0.9 / 0.8 of background, and the typical width of those dark structures.

Usage::

    # a real Miniscope AVI (uncompressed GREY) + its registering shifts
    python calibrate_to_real.py real path/to/0.avi --shifts shifts.npy --frames 300

    # a minisim movie saved as movie.npy + shifts.npy (true content motion)
    python calibrate_to_real.py movie path/to/dir

    # simulate a Spec JSON (default: the V4 + CA1 preset) at 384 px, 300 frames,
    # rigid motion, and measure it
    python calibrate_to_real.py sim --out path/to/dir [--spec x.spec.json] [--novasc]

    # rigid registration RMSE on a saved sim (DoG + plain cross-correlation)
    python calibrate_to_real.py register path/to/dir

Shift convention: ``--shifts`` for a real recording are the *registering* shifts
(applying ``scipy.ndimage.shift(frame, s)`` aligns the frame to the template). A
minisim ``shifts.npy`` is the true *content motion*, so it is negated.

Every subcommand prints a table and, with ``--json PATH``, writes the numbers.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, median_filter
from scipy.ndimage import shift as nd_shift

CROP = 256  # central crop for the registration-content statistics, px
DOG = (1.5, 15.0)  # registration band-pass, px


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------


def read_grey_avi(
    path: str | Path, n_frames: int | None = None, start: int = 0
) -> np.ndarray:
    """Frames ``(t, h, w)`` uint8 of an uncompressed 8-bit GREY AVI (Miniscope DAQ)."""
    from minisim.avi import read_avi_header

    hdr = read_avi_header(path)
    h, w = hdr["avih"]["height"], hdr["avih"]["width"]
    frames = hdr["frames"][start:]
    if n_frames is not None:
        frames = frames[:n_frames]
    raw = Path(path).read_bytes()
    return np.stack(
        [np.frombuffer(raw, np.uint8, h * w, off).reshape(h, w) for off, _ in frames]
    )


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------


def bandpass(frame: np.ndarray) -> np.ndarray:
    """The registration band-pass: 3x3 median, then DoG (sigma 1.5 / 15 px)."""
    g = median_filter(frame.astype(np.float32), 3)
    return gaussian_filter(g, DOG[0]) - gaussian_filter(g, DOG[1])


def content_stats(movie: np.ndarray, reg_shifts: np.ndarray) -> dict:
    """Static / slow / white power in the registration band, and NCC to template."""
    h, w = movie.shape[1:]
    cy, cx = (h - CROP) // 2, (w - CROP) // 2
    P = np.empty((len(movie), CROP, CROP), np.float32)
    for k, (f, s) in enumerate(zip(movie, reg_shifts, strict=True)):
        g = nd_shift(bandpass(f), s, order=1, mode="nearest")
        P[k] = g[cy : cy + CROP, cx : cx + CROP]
    m = P.mean(0)
    static = float(m.var())
    dyn = float(P.var(0).mean())
    white = float((np.diff(P, axis=0) ** 2).mean() / 2)
    slow = dyn - white
    T = m - m.mean()
    Pc = P - P.mean(axis=(1, 2), keepdims=True)
    ncc = (Pc * T).sum(axis=(1, 2)) / np.sqrt((T**2).sum() * (Pc**2).sum(axis=(1, 2)))
    return {
        "static": static,
        "slow": slow,
        "white": white,
        "slow_over_static": slow / static,
        "white_over_static": white / static,
        "ncc_to_template": float(np.median(ncc)),
    }


def fov_mask(mean_img: np.ndarray) -> np.ndarray:
    """Pixels inside the lit field of view: smoothed mean above 25% of its 99th pct."""
    sm = gaussian_filter(mean_img, 5)
    return sm > 0.25 * np.percentile(sm, 99)


def grey_stats(movie: np.ndarray) -> dict:
    """Mean grey level inside the FOV and in the central 64 px; saturation."""
    m = movie.mean(0, dtype=np.float64)
    h, w = m.shape
    c = m[h // 2 - 32 : h // 2 + 32, w // 2 - 32 : w // 2 + 32]
    return {
        "mean_in_fov": float(m[fov_mask(m)].mean()),
        "mean_center64": float(c.mean()),
        "p99": float(np.percentile(m, 99)),
        "frac_saturated": float((movie == 255).mean()),
    }


def noise_vs_brightness(movie: np.ndarray, n_bins: int = 24) -> dict:
    """Temporal noise variance vs mean grey level: ``var = slope * mean + intercept``.

    Variance is half the mean squared frame difference (slow trends cancel), the
    per-bin *median* over pixels (robust to cells firing and motion at edges).
    """
    x = movie.astype(np.float32)
    mean = x.mean(0).ravel()
    var = ((np.diff(x, axis=0) ** 2).mean(0) / 2).ravel()
    lo, hi = np.percentile(mean, [2, 99.5])
    lo = max(lo, 3.0)  # stay clear of the zero clip
    edges = np.linspace(lo, hi, n_bins + 1)
    idx = np.digitize(mean, edges) - 1
    bm, bv = [], []
    for b in range(n_bins):
        sel = idx == b
        if sel.sum() >= 200:
            bm.append(float(np.median(mean[sel])))
            bv.append(float(np.median(var[sel])))
    bm_a, bv_a = np.array(bm), np.array(bv)
    slope, intercept = np.polyfit(bm_a, bv_a, 1)
    m_img = mean.reshape(movie.shape[1:])
    typical = float(np.median(m_img[fov_mask(m_img)]))
    return {
        "slope": float(slope),
        "intercept": float(intercept),
        "typical_mean": typical,
        "noise_sd_at_typical": float(np.sqrt(max(slope * typical + intercept, 0))),
        "bins_mean": bm,
        "bins_var": bv,
    }


def radial_profile(mean_img: np.ndarray, n_bins: int = 12) -> dict:
    """Radial falloff of the smoothed mean image, normalized to its centre.

    Radius is normalized to the half-diagonal (1 = a corner) so profiles from
    different frame sizes compare at the same relative position.
    """
    sm = gaussian_filter(mean_img.astype(np.float64), 10)
    h, w = sm.shape
    yy, xx = np.mgrid[:h, :w]
    r = np.hypot(yy - (h - 1) / 2, xx - (w - 1) / 2) / np.hypot(h / 2, w / 2)
    edges = np.linspace(0, 1, n_bins + 1)
    prof = []
    for a, b in zip(edges[:-1], edges[1:], strict=True):
        sel = (r >= a) & (r < b)
        prof.append(float(np.median(sm[sel])) if sel.any() else float("nan"))
    p = np.array(prof)
    return {
        "r": ((edges[:-1] + edges[1:]) / 2).tolist(),
        "profile": (p / p[0]).tolist(),
    }


def vessel_stats(mean_img: np.ndarray, crop: int = 384) -> dict:
    """Dark-vessel appearance in the mean image (central ``crop`` px).

    ``ratio = mean / local background`` (Gaussian sigma 15 px). Reports the 1st /
    5th percentile of ``ratio`` (dip depth), the fraction of pixels below 0.9 / 0.8
    (vessel density) and the median width (px) of the < 0.9 structures, from the
    distance transform along their medial axis.
    """
    from scipy.ndimage import distance_transform_edt, maximum_filter

    h, w = mean_img.shape
    crop = min(crop, h, w)
    cy, cx = (h - crop) // 2, (w - crop) // 2
    m = median_filter(mean_img.astype(np.float64), 3)
    bg = gaussian_filter(m, 15)
    ratio = (m / np.maximum(bg, 1e-6))[cy : cy + crop, cx : cx + crop]
    mask = ratio < 0.9
    dt = distance_transform_edt(mask)
    ridge = mask & (dt == maximum_filter(dt, 5)) & (dt >= 1)
    width = float(np.median(2 * dt[ridge])) if ridge.any() else 0.0
    return {
        "ratio_p1": float(np.percentile(ratio, 1)),
        "ratio_p5": float(np.percentile(ratio, 5)),
        "frac_below_0.9": float((ratio < 0.9).mean()),
        "frac_below_0.8": float((ratio < 0.8).mean()),
        "width_px": width,
    }


def measure(movie: np.ndarray, reg_shifts: np.ndarray) -> dict:
    """All statistics for one recording."""
    mean_img = movie.mean(0, dtype=np.float64)
    return {
        "content": content_stats(movie, reg_shifts),
        "grey": grey_stats(movie),
        "noise": noise_vs_brightness(movie),
        "radial": radial_profile(mean_img),
        "vessels": vessel_stats(mean_img),
    }


def print_report(label: str, s: dict) -> None:
    c, g, n, v = s["content"], s["grey"], s["noise"], s["vessels"]
    print(f"== {label}")
    print(
        f"  content: static {c['static']:.2f}  slow {c['slow']:.2f}  white {c['white']:.3f}"
        f"  slow/static {c['slow_over_static']:.3f}  white/static {c['white_over_static']:.4f}"
        f"  NCC {c['ncc_to_template']:.3f}"
    )
    print(
        f"  grey: mean in FOV {g['mean_in_fov']:.1f}  centre64 {g['mean_center64']:.1f}"
        f"  p99 {g['p99']:.1f}  saturated {g['frac_saturated']:.2e}"
    )
    print(
        f"  noise: var = {n['slope']:.3f}*mean + {n['intercept']:.2f}"
        f"  (sd {n['noise_sd_at_typical']:.2f} at mean {n['typical_mean']:.1f})"
    )
    print(
        "  radial (centre->corner): "
        + " ".join(f"{p:.2f}" for p in s["radial"]["profile"])
    )
    print(
        f"  vessels: ratio p1 {v['ratio_p1']:.3f} p5 {v['ratio_p5']:.3f}"
        f"  frac<0.9 {v['frac_below_0.9']:.3f} frac<0.8 {v['frac_below_0.8']:.4f}"
        f"  width {v['width_px']:.1f} px"
    )


# ---------------------------------------------------------------------------
# Registration check
# ---------------------------------------------------------------------------


def _upsampled_dft(data, region, up, offsets):
    """Inverse DFT of ``data`` upsampled by ``up`` on a ``region``-px window at ``offsets``."""
    for n, off in zip(data.shape[::-1], offsets[::-1], strict=True):
        kernel = np.exp(
            -2j * np.pi * (np.arange(region) - off)[:, None] * np.fft.fftfreq(n, up)
        )
        data = np.tensordot(kernel, data, axes=(1, -1))
    return data


def cross_correlation_shift(
    ref: np.ndarray, mov: np.ndarray, up: int = 20
) -> np.ndarray:
    """Shift ``(dy, dx)`` registering ``mov`` onto ``ref``: plain (unnormalized) CC.

    No phase normalization - the phase-correlation whitening amplifies the white
    noise band and fails on miniscope data.
    """
    X = np.fft.fft2(ref) * np.conj(np.fft.fft2(mov))
    cc = np.abs(np.fft.ifft2(X))
    dims = np.array(cc.shape)
    peak = np.array(np.unravel_index(np.argmax(cc), cc.shape), float)
    peak[peak > dims // 2] -= dims[peak > dims // 2]
    peak = np.round(peak * up) / up
    region = int(np.ceil(up * 1.5))
    centre = np.trunc(region / 2.0)
    up_cc = np.abs(_upsampled_dft(X.conj(), region, up, centre - peak * up))
    fine = np.array(np.unravel_index(np.argmax(up_cc), up_cc.shape), float) - centre
    return peak + fine / up


def register_rmse(movie: np.ndarray, motion: np.ndarray, iters: int = 3) -> dict:
    """Rigid registration RMSE (px) vs truth: DoG + windowed plain cross-correlation.

    The template is the band-passed mean, refined ``iters`` times on the
    registered frames. Estimated registering shifts are compared with ``-motion``
    after removing the common offset (the template's own position is arbitrary).
    """
    t, h, w = movie.shape
    from scipy.signal.windows import tukey

    # a flat-top (Tukey 0.2) window: a Hann window over-weights the centre and
    # costs ~0.1 px here
    win = np.outer(tukey(h, 0.2), tukey(w, 0.2)).astype(np.float32)
    B = np.stack([bandpass(f) for f in movie])
    tmpl = B.mean(0)
    est = np.zeros((t, 2))
    for _ in range(iters + 1):
        est = np.array([cross_correlation_shift(tmpl * win, b * win) for b in B])
        tmpl = np.mean(
            [
                nd_shift(b, s, order=1, mode="nearest")
                for b, s in zip(B, est, strict=True)
            ],
            0,
        )
    err = est - (-motion)
    err -= err.mean(0)
    return {
        "rmse_px": float(np.sqrt((err**2).sum(1).mean())),
        "rmse_y": float(np.sqrt((err[:, 0] ** 2).mean())),
        "rmse_x": float(np.sqrt((err[:, 1] ** 2).mean())),
        "max_err_px": float(np.sqrt((err**2).sum(1)).max()),
        "motion_rms_px": float(np.sqrt(((motion - motion.mean(0)) ** 2).sum(1).mean())),
    }


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------


def adjust_spec(
    spec,
    *,
    size=None,
    n_frames=None,
    fps=20.0,
    seed=None,
    vasculature=True,
    nonrigid=False,
):
    """Copy of ``spec`` resized/re-timed; drop vessels; force rigid-only motion."""
    acq = spec.acquisition
    upd: dict = {}
    if size is not None:
        upd["image_sensor"] = acq.image_sensor.model_copy(
            update={"n_px_height": size, "n_px_width": size}
        )
    if n_frames is not None:
        upd.update(fps=fps, duration_s=n_frames / fps)
    steps = []
    for st in spec.steps:
        if st.kind == "vasculature" and not vasculature:
            continue
        if st.kind == "brain_motion":
            st = st.model_copy(update={"nonrigid": nonrigid})
        steps.append(st)
    return type(spec).model_validate(
        spec.model_copy(
            update={
                "acquisition": acq.model_copy(update=upd),
                "steps": steps,
                "seed": spec.seed if seed is None else seed,
            }
        ).model_dump()
    )


def baseline_spec():
    """The uncalibrated V4 + CA1 preset with realistic motion."""
    from minisim import presets

    return presets.build_spec(
        presets.miniscope_v4(), presets.ca1(), extra_steps=[presets.realistic_motion()]
    )


def simulate_to(spec, out: Path) -> None:
    """Simulate ``spec``; save uint8 ``movie.npy`` and true ``shifts.npy``."""
    from minisim import simulate

    rec = simulate(spec)
    mov = np.clip(np.rint(np.asarray(rec.observed)), 0, 255).astype(np.uint8)
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "movie.npy", mov)
    assert rec.ground_truth.shifts is not None
    np.save(out / "shifts.npy", np.asarray(rec.ground_truth.shifts, dtype=np.float64))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("real", help="measure a real GREY AVI")
    r.add_argument("avi")
    r.add_argument(
        "--shifts", required=True, help="registering shifts .npy (frame, (dy, dx))"
    )
    r.add_argument("--frames", type=int, default=300)
    r.add_argument("--start", type=int, default=0, help="first frame within the AVI")
    r.add_argument(
        "--shift-offset",
        type=int,
        default=0,
        help="index of the AVI's frame 0 in --shifts",
    )
    mv = sub.add_parser("movie", help="measure a saved sim (movie.npy + shifts.npy)")
    mv.add_argument("dir")
    sm = sub.add_parser("sim", help="simulate the V4+CA1 preset, then measure it")
    sm.add_argument("--out", required=True)
    sm.add_argument(
        "--spec", help="Spec JSON to simulate (default: the uncalibrated V4+CA1 preset)"
    )
    sm.add_argument("--novasc", action="store_true", help="drop the vasculature")
    sm.add_argument("--size", type=int, default=384)
    sm.add_argument("--frames", type=int, default=300)
    sm.add_argument("--seed", type=int, default=5)
    rg = sub.add_parser("register", help="rigid registration RMSE on a saved sim")
    rg.add_argument("dir")
    for p in (r, mv, sm, rg):
        p.add_argument("--json", help="write the numbers here")
    a = ap.parse_args()

    if a.cmd == "real":
        movie = read_grey_avi(a.avi, a.frames, a.start)
        sh = np.load(a.shifts)[a.shift_offset + a.start :][: len(movie)]
        res = measure(movie, sh)
        print_report(a.avi, res)
    elif a.cmd in ("movie", "sim"):
        d = Path(a.dir if a.cmd == "movie" else a.out)
        if a.cmd == "sim":
            from minisim import Spec

            base = (
                Spec.model_validate_json(Path(a.spec).read_text())
                if a.spec
                else baseline_spec()
            )
            spec = adjust_spec(
                base,
                size=a.size,
                n_frames=a.frames,
                seed=a.seed,
                vasculature=not a.novasc,
            )
            simulate_to(spec, d)
        movie = np.load(d / "movie.npy")
        res = measure(movie, -np.load(d / "shifts.npy"))
        print_report(str(d), res)
    else:
        d = Path(a.dir)
        res = register_rmse(np.load(d / "movie.npy"), np.load(d / "shifts.npy"))
        print(f"== {d}: " + "  ".join(f"{k} {v:.3f}" for k, v in res.items()))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
