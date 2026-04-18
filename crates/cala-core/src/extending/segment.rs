//! Candidate proposal: max-variance patch → rank-1 NMF → quality gates
//! (thesis Algorithm 9).
//!
//! Task 3 lands the patch-selection stage: compute per-pixel residual
//! variance over the extend window, locate the argmax pixel, and
//! extract a radius-`r` time stack clipped to frame bounds.
//!
//! Task 4 adds [`rank1_nmf`] — a non-negative rank-1 factorization
//! `X ≈ a c^T` via alternating projected least squares. Used on the
//! patch time stack to produce a candidate `(a, c)` pair; downstream
//! quality gates (Task 5) decide whether to register it as a new
//! estimator.

use std::ops::Range;

use crate::buffers::bipbuf::ResidualRingBuf;

/// Compute per-pixel residual variance over the full buffer window.
///
/// Returns a dense length-`frame_len` map. Formula is the population
/// variance `E[r²] − E[r]²`; a 60-frame default window at f32 keeps
/// accumulation error well below the signal scale on typical
/// miniscope residuals. An empty buffer yields an all-zero map.
pub fn variance_map(buf: &ResidualRingBuf) -> Vec<f32> {
    let frame_len = buf.frame_len();
    let t = buf.len();
    let mut map = vec![0.0f32; frame_len];
    if t == 0 {
        return map;
    }
    let inv_t = 1.0f32 / (t as f32);
    let window = buf.window();
    let mut sum = vec![0.0f32; frame_len];
    let mut sum_sq = vec![0.0f32; frame_len];
    for f in 0..t {
        let base = f * frame_len;
        for p in 0..frame_len {
            let v = window[base + p];
            sum[p] += v;
            sum_sq[p] += v * v;
        }
    }
    for p in 0..frame_len {
        let mean = sum[p] * inv_t;
        let mean_sq = sum_sq[p] * inv_t;
        // Clamp to zero — float subtraction can produce a tiny negative
        // when every residual at this pixel is essentially identical.
        map[p] = (mean_sq - mean * mean).max(0.0);
    }
    map
}

/// Argmax `(y, x, value)` of a row-major `height × width` map. Ties
/// are broken by lowest linear index. Returns `None` if the map is
/// empty or all non-finite.
pub fn argmax_yx(map: &[f32], height: usize, width: usize) -> Option<(usize, usize, f32)> {
    assert_eq!(
        map.len(),
        height * width,
        "map length {} must equal height * width = {}",
        map.len(),
        height * width
    );
    let mut best: Option<(usize, f32)> = None;
    for (i, &v) in map.iter().enumerate() {
        if !v.is_finite() {
            continue;
        }
        match best {
            None => best = Some((i, v)),
            Some((_, b)) if v > b => best = Some((i, v)),
            _ => {}
        }
    }
    best.map(|(i, v)| (i / width, i % width, v))
}

/// Inclusive-start / exclusive-end row and column ranges for a patch
/// of radius `radius` centered at `(center_y, center_x)`, clipped to
/// the frame bounds.
pub fn patch_bounds(
    center_y: usize,
    center_x: usize,
    radius: usize,
    height: usize,
    width: usize,
) -> (Range<usize>, Range<usize>) {
    assert!(center_y < height, "center_y {center_y} out of height {height}");
    assert!(center_x < width, "center_x {center_x} out of width {width}");
    let y0 = center_y.saturating_sub(radius);
    let y1 = (center_y + radius + 1).min(height);
    let x0 = center_x.saturating_sub(radius);
    let x1 = (center_x + radius + 1).min(width);
    (y0..y1, x0..x1)
}

/// Pack the residual ring window restricted to the given `y_range ×
/// x_range` patch into a row-major-per-frame time stack.
///
/// Output layout: `window_len` frames × `patch_h × patch_w` pixels,
/// in the order returned by `ResidualRingBuf::window` (oldest-first).
pub fn extract_patch_stack(
    buf: &ResidualRingBuf,
    height: usize,
    width: usize,
    y_range: Range<usize>,
    x_range: Range<usize>,
) -> Vec<f32> {
    assert_eq!(
        height * width,
        buf.frame_len(),
        "frame shape {}x{} must equal buffer frame_len {}",
        height,
        width,
        buf.frame_len()
    );
    assert!(y_range.end <= height, "y_range exceeds height");
    assert!(x_range.end <= width, "x_range exceeds width");
    let patch_h = y_range.end - y_range.start;
    let patch_w = x_range.end - x_range.start;
    let t = buf.len();
    let mut stack = Vec::with_capacity(t * patch_h * patch_w);
    let window = buf.window();
    for f in 0..t {
        let frame_base = f * buf.frame_len();
        for y in y_range.clone() {
            let row_base = frame_base + y * width;
            stack.extend_from_slice(&window[row_base + x_range.start..row_base + x_range.end]);
        }
    }
    stack
}

/// Output of [`select_max_variance_patch`].
#[derive(Debug)]
pub struct PatchSelection {
    /// Image-space `(y, x)` coordinates of the argmax pixel.
    pub center_yx: (usize, usize),
    /// Row range the patch occupies in the full frame.
    pub y_range: Range<usize>,
    /// Column range the patch occupies in the full frame.
    pub x_range: Range<usize>,
    /// Variance at the argmax pixel (the selection score).
    pub max_variance: f32,
    /// `window_len × patch_h × patch_w`, row-major per frame.
    pub time_stack: Vec<f32>,
    pub patch_h: usize,
    pub patch_w: usize,
    pub window_len: usize,
}

/// Locate the maximum-variance pixel over the residual window and
/// extract a radius-`radius` patch time stack around it (clipped to
/// frame bounds).
///
/// Returns `None` when the buffer is empty.
pub fn select_max_variance_patch(
    buf: &ResidualRingBuf,
    height: usize,
    width: usize,
    radius: usize,
) -> Option<PatchSelection> {
    if buf.is_empty() {
        return None;
    }
    assert_eq!(
        height * width,
        buf.frame_len(),
        "frame shape {}x{} must equal buffer frame_len {}",
        height,
        width,
        buf.frame_len()
    );
    let map = variance_map(buf);
    let (cy, cx, max_variance) = argmax_yx(&map, height, width)?;
    let (y_range, x_range) = patch_bounds(cy, cx, radius, height, width);
    let patch_h = y_range.end - y_range.start;
    let patch_w = x_range.end - x_range.start;
    let time_stack =
        extract_patch_stack(buf, height, width, y_range.clone(), x_range.clone());
    Some(PatchSelection {
        center_yx: (cy, cx),
        y_range,
        x_range,
        max_variance,
        time_stack,
        patch_h,
        patch_w,
        window_len: buf.len(),
    })
}

/// Result of a rank-1 non-negative factorization `X ≈ a c^T`.
#[derive(Debug, Clone)]
pub struct Rank1Nmf {
    /// Spatial factor, length `p`. Unit L2 norm unless the fit
    /// collapsed to zero (all-zero patch).
    pub a: Vec<f32>,
    /// Temporal factor, length `t`. Carries the full scale of the
    /// factorization.
    pub c: Vec<f32>,
    /// Number of alternating-LS iterations executed.
    pub iterations: u32,
    /// `true` if the relative-change tolerance was hit before
    /// `max_iter`.
    pub converged: bool,
    /// Relative reconstruction error `‖X − a c^T‖_F / ‖X‖_F`.
    /// Defined to be 0 when `‖X‖_F == 0`.
    pub recon_error: f32,
}

/// Non-negative rank-1 factorization of a `t × p` time stack
/// (row-major per frame). Projected alternating least squares:
/// each update clamps to ≥ 0, so any signed residual input is
/// handled without a pre-clip of `X`.
///
/// Output is normalized so `‖a‖_2 = 1`; `c` carries all the scale.
pub fn rank1_nmf(x: &[f32], t: usize, p: usize, max_iter: u32, tol: f32) -> Rank1Nmf {
    assert_eq!(
        x.len(),
        t * p,
        "x length {} must equal t * p = {}",
        x.len(),
        t * p
    );
    assert!(t > 0 && p > 0, "t and p must be positive (got {t} × {p})");
    assert!(tol > 0.0, "tol must be positive (got {tol})");
    assert!(max_iter >= 1, "max_iter must be ≥ 1 (got {max_iter})");

    // Frobenius norm of X — numerator of the recon-error ratio.
    let x_frob_sq: f32 = x.iter().map(|&v| v * v).sum();
    let x_frob = x_frob_sq.sqrt();

    // Zero-input short-circuit: the zero factorization is exact.
    if x_frob == 0.0 {
        return Rank1Nmf {
            a: vec![0.0; p],
            c: vec![0.0; t],
            iterations: 0,
            converged: true,
            recon_error: 0.0,
        };
    }

    // Initialize `a` from the time-averaged positive signal per pixel.
    // A flat-positive init is a safe bet — any positive overlap with
    // the true spatial factor is enough for ALS to converge.
    let mut a = vec![0.0f32; p];
    for pi in 0..p {
        let mut s = 0.0f32;
        for ti in 0..t {
            s += x[ti * p + pi].max(0.0);
        }
        a[pi] = s;
    }
    // Fallback: if the positive-part mean is all zero (e.g. X is
    // entirely negative), seed `a` flat. ALS will still find the
    // dominant non-negative component if one exists; otherwise the
    // result collapses to zero and the caller's quality gates reject.
    if a.iter().all(|&v| v == 0.0) {
        a.iter_mut().for_each(|v| *v = 1.0);
    }
    normalize_l2(&mut a);

    let mut c = vec![0.0f32; t];
    let mut converged = false;
    let mut iterations = 0u32;

    for _ in 0..max_iter {
        iterations += 1;
        // c update: c_new[ti] = max(sum_p X[ti,p] * a[p], 0) / (a ⋅ a)
        // With `a` unit-L2, a ⋅ a == 1, so just take the dot product.
        let mut c_new = vec![0.0f32; t];
        for ti in 0..t {
            let mut s = 0.0f32;
            for pi in 0..p {
                s += x[ti * p + pi] * a[pi];
            }
            c_new[ti] = s.max(0.0);
        }

        let c_energy: f32 = c_new.iter().map(|&v| v * v).sum();
        if c_energy == 0.0 {
            // Signal has no non-negative projection onto `a`'s
            // direction — collapse to zero.
            c = c_new;
            a.iter_mut().for_each(|v| *v = 0.0);
            converged = true;
            break;
        }

        // a update: a_new[pi] = max(sum_t X[ti,pi] * c[ti], 0) / (c ⋅ c)
        let mut a_new = vec![0.0f32; p];
        for pi in 0..p {
            let mut s = 0.0f32;
            for ti in 0..t {
                s += x[ti * p + pi] * c_new[ti];
            }
            a_new[pi] = (s / c_energy).max(0.0);
        }

        let a_energy: f32 = a_new.iter().map(|&v| v * v).sum();
        if a_energy == 0.0 {
            c = c_new;
            a = a_new;
            converged = true;
            break;
        }
        let a_norm = a_energy.sqrt();
        // Scale-fold: pull the freshly-computed ‖a_new‖ into `c` so
        // `a` stays unit-L2 after every iteration.
        a_new.iter_mut().for_each(|v| *v /= a_norm);
        c_new.iter_mut().for_each(|v| *v *= a_norm);

        // Convergence: relative change in (a, c) below tol.
        let da = l2_diff(&a_new, &a);
        let dc = l2_diff(&c_new, &c);
        let denom = l2_norm(&a_new) + l2_norm(&c_new);
        if denom > 0.0 && (da + dc) < tol * denom {
            a = a_new;
            c = c_new;
            converged = true;
            break;
        }
        a = a_new;
        c = c_new;
    }

    let residual_sq = frobenius_residual_sq(x, &a, &c, t, p);
    let recon_error = residual_sq.sqrt() / x_frob;

    Rank1Nmf {
        a,
        c,
        iterations,
        converged,
        recon_error,
    }
}

fn normalize_l2(v: &mut [f32]) {
    let n = l2_norm(v);
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

fn l2_norm(v: &[f32]) -> f32 {
    v.iter().map(|&x| x * x).sum::<f32>().sqrt()
}

fn l2_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f32>()
        .sqrt()
}

/// `‖X − a c^T‖_F²` without materializing the outer product.
fn frobenius_residual_sq(x: &[f32], a: &[f32], c: &[f32], t: usize, p: usize) -> f32 {
    let mut acc = 0.0f32;
    for ti in 0..t {
        let ct = c[ti];
        for pi in 0..p {
            let r = x[ti * p + pi] - a[pi] * ct;
            acc += r * r;
        }
    }
    acc
}
