//! Small numeric helpers of the slow loop.

use super::local;
use super::local::{Column, Fit, Rect};
use crate::trace::Library;

/// Gaussian σ per unit of median absolute deviation (1 / 0.6745, to the
/// digits the slow loop has always used): the robust scale of its residual
/// maps. Deliberately not `preprocess::stats::MAD_GAUSSIAN`, whose reciprocal
/// differs in the fifth digit and would change results.
pub(super) const MAD_TO_SIGMA: f32 = 1.4826;

/// The filtered column of the cell in `slot` on the sorted pixels `pix`, as
/// the fast loop models it: exact on the support, the moat's block means
/// off it, 0 beyond.
pub(super) fn column_on(lib: &Library, slot: usize, pix: &[u32]) -> Vec<f32> {
    let (spix, sval) = lib.filtered(slot);
    let (lb, lv) = lib.lowpass(slot);
    pix.iter()
        .map(|p| match spix.binary_search(p) {
            Ok(k) => sval[k],
            Err(_) if lib.block_px() > 0 => {
                let b = lib.block_of(*p) as u32;
                lb.binary_search(&b).map_or(0.0, |k| -lv[k])
            }
            Err(_) => 0.0,
        })
        .collect()
}

/// The single-peaked basin of the light `q` from `seed` (S1.6): a pixel
/// `r` joins when a 4-neighbour `p` is in the basin, `q(r) > tol(r)` (it is
/// significant) and `q(r) ≤ floor(p) + tol(r)` (it does not rise
/// significantly above the lowest light on its way from the seed);
/// `floor(r) = min(floor(p), q(r))`. Pixels join in order of decreasing
/// `q`. Pixels off `mask` or with a non-finite `q` never join.
pub(super) fn basin(
    q: &[f32],
    tol: &[f32],
    mask: &[bool],
    ch: usize,
    cw: usize,
    seed: usize,
) -> Vec<bool> {
    let n = ch * cw;
    let mut inb = vec![false; n];
    let mut floor = vec![f32::NEG_INFINITY; n];
    let mut heap = std::collections::BinaryHeap::new();
    let key = |v: f32| (v * 1e6) as i64;
    inb[seed] = true;
    floor[seed] = q[seed];
    heap.push((key(q[seed]), seed));
    while let Some((_, p)) = heap.pop() {
        let (y, x) = (p / cw, p % cw);
        let nb = [
            (y > 0).then(|| p - cw),
            (y + 1 < ch).then(|| p + cw),
            (x > 0).then(|| p - 1),
            (x + 1 < cw).then(|| p + 1),
        ];
        for r in nb.into_iter().flatten() {
            if inb[r] || !mask[r] || !q[r].is_finite() {
                continue;
            }
            if q[r] > tol[r] && q[r] <= floor[p] + tol[r] {
                inb[r] = true;
                floor[r] = floor[p].min(q[r]);
                heap.push((key(q[r]), r));
            }
        }
    }
    inb
}

/// Whether `q[p]` is not below any of its 8 neighbours (non-finite
/// neighbours ignored).
pub(super) fn local_max(q: &[f32], ch: usize, cw: usize, p: usize) -> bool {
    let (y, x) = (p / cw, p % cw);
    for (dy, dx) in [
        (-1i64, 0i64),
        (1, 0),
        (0, -1),
        (0, 1),
        (-1, -1),
        (1, 1),
        (-1, 1),
        (1, -1),
    ] {
        let (yy, xx) = (y as i64 + dy, x as i64 + dx);
        if yy >= 0 && xx >= 0 && (yy as usize) < ch && (xx as usize) < cw {
            let v = q[yy as usize * cw + xx as usize];
            if v.is_finite() && v > q[p] {
                return false;
            }
        }
    }
    true
}

/// Inverse of the standard normal CDF, `Φ⁻¹(p)` for `0 < p < 1` (Acklam's
/// rational approximation, relative error below 1.2e-9).
pub(crate) fn norm_quantile(p: f64) -> f64 {
    if !(p > 0.0 && p < 1.0) {
        return if p >= 1.0 {
            f64::INFINITY
        } else {
            f64::NEG_INFINITY
        };
    }
    const A: [f64; 6] = [
        -3.969_683_028_665_376e1,
        2.209_460_984_245_205e2,
        -2.759_285_104_469_687e2,
        1.383_577_518_672_69e2,
        -3.066_479_806_614_716e1,
        2.506_628_277_459_239,
    ];
    const B: [f64; 5] = [
        -5.447_609_879_822_406e1,
        1.615_858_368_580_409e2,
        -1.556_989_798_598_866e2,
        6.680_131_188_771_972e1,
        -1.328_068_155_288_572e1,
    ];
    const C: [f64; 6] = [
        -7.784_894_002_430_293e-3,
        -3.223_964_580_411_365e-1,
        -2.400_758_277_161_838,
        -2.549_732_539_343_734,
        4.374_664_141_464_968,
        2.938_163_982_698_783,
    ];
    const D: [f64; 4] = [
        7.784_695_709_041_462e-3,
        3.224_671_290_700_398e-1,
        2.445_134_137_142_996,
        3.754_408_661_907_416,
    ];
    let lo = 0.02425;
    if p < lo {
        let q = (-2.0 * p.ln()).sqrt();
        (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    } else if p <= 1.0 - lo {
        let q = p - 0.5;
        let r = q * q;
        (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
            / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0)
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    }
}

/// The intersection of `a` and `b` (empty, at the clamped corner, when they
/// do not overlap).
pub(super) fn clip(a: Rect, b: Rect) -> Rect {
    let y0 = a.y0.max(b.y0);
    let x0 = a.x0.max(b.x0);
    let y1 = (a.y0 + a.h).min(b.y0 + b.h).max(y0);
    let x1 = (a.x0 + a.w).min(b.x0 + b.w).max(x0);
    Rect {
        y0,
        x0,
        h: y1 - y0,
        w: x1 - x0,
    }
}

/// Paired z of the per-frame χ² gains of `alt` over `base` (same frames):
/// mean gain over its standard error. Scale-free, so it suits footprint
/// changes, whose χ² effect grows with the cell's activity.
pub(super) fn paired_z(base: &[Fit], alt: &[Fit]) -> f64 {
    let n = base.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let d: Vec<f64> = base.iter().zip(alt).map(|(b, a)| b.chi2 - a.chi2).collect();
    let m = d.iter().sum::<f64>() / n;
    let v = d.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (n - 1.0);
    if v <= 0.0 {
        return if m > 0.0 { f64::INFINITY } else { 0.0 };
    }
    m / (v / n).sqrt()
}

/// Cosine similarity of two patch columns.
pub(super) fn overlap(a: &Column, b: &Column, n: usize) -> f32 {
    let ab = b.dot(&a.dense(n));
    let (aa, bb) = (a.norm2(), b.norm2());
    if aa <= 0.0 || bb <= 0.0 {
        0.0
    } else {
        ab / (aa * bb).sqrt()
    }
}

/// Adjusted R² of the least-squares fit of `y` on the columns `xs` plus an
/// intercept (0 when there are too few samples for the regressors).
pub(super) fn adjusted_r2(y: &[f32], xs: &[Vec<f32>]) -> f32 {
    let n = y.len();
    let p = xs.len();
    if n < p + 3 {
        return 0.0;
    }
    let mean = |v: &[f32]| v.iter().map(|&x| f64::from(x)).sum::<f64>() / n as f64;
    let my = mean(y);
    let yc: Vec<f64> = y.iter().map(|&v| f64::from(v) - my).collect();
    let xc: Vec<Vec<f64>> = xs
        .iter()
        .map(|x| {
            let m = mean(x);
            x.iter().map(|&v| f64::from(v) - m).collect()
        })
        .collect();
    let syy: f64 = yc.iter().map(|v| v * v).sum();
    if syy <= 0.0 {
        return 0.0;
    }
    let mut g = vec![0.0f64; p * p];
    let mut b = vec![0.0f64; p];
    for a in 0..p {
        for c in a..p {
            let d: f64 = xc[a].iter().zip(&xc[c]).map(|(u, v)| u * v).sum();
            g[a * p + c] = d;
            g[c * p + a] = d;
        }
        b[a] = xc[a].iter().zip(&yc).map(|(u, v)| u * v).sum();
    }
    // A small ridge keeps silent (all-zero) neighbours solvable.
    let tr = (0..p).map(|a| g[a * p + a]).sum::<f64>() / p as f64;
    for a in 0..p {
        g[a * p + a] += 1e-6 * tr.max(1e-12);
    }
    let Some(inv) = local::invert(&g, p) else {
        return 0.0;
    };
    let explained: f64 = (0..p)
        .map(|a| b[a] * (0..p).map(|c| inv[a * p + c] * b[c]).sum::<f64>())
        .sum();
    let r2 = (explained / syy).clamp(0.0, 0.999_999);
    // Few held-out frames for many neighbours fit noise: count the fit only
    // when it is significant (F test at 1e-3, the χ²_p quantile by
    // Wilson-Hilferty, conservative for small n - p - 1).
    let f = (r2 / p as f64) / ((1.0 - r2) / (n - p - 1) as f64);
    let q = 2.0 / (9.0 * p as f64);
    let chi = p as f64 * (1.0 - q + 3.09 * q.sqrt()).powi(3);
    if f * (p as f64) < chi {
        return 0.0;
    }
    (1.0 - (1.0 - r2) * (n - 1) as f64 / (n - p - 1) as f64) as f32
}

/// Pearson correlation of `a` and `b` (same length), accumulated in f64; 0
/// for fewer than two samples or a constant series.
pub(super) fn corr(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let ma = a.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let mb = b.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        let (dx, dy) = (f64::from(x) - ma, f64::from(y) - mb);
        sab += dx * dy;
        saa += dx * dx;
        sbb += dy * dy;
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        (sab / (saa * sbb).sqrt()) as f32
    }
}

/// Solve `a x = b` in place (`a` row major `n x n`, `b` becomes `x`) by
/// Gaussian elimination with partial pivoting; false when `a` is singular.
pub(super) fn solve_dense(a: &mut [f64], b: &mut [f64], n: usize) -> bool {
    for k in 0..n {
        let p = (k..n)
            .max_by(|&i, &j| a[i * n + k].abs().total_cmp(&a[j * n + k].abs()))
            .unwrap_or(k);
        if !(a[p * n + k].abs() > 0.0) {
            return false;
        }
        if p != k {
            for j in 0..n {
                a.swap(k * n + j, p * n + j);
            }
            b.swap(k, p);
        }
        for i in k + 1..n {
            let f = a[i * n + k] / a[k * n + k];
            if f != 0.0 {
                for j in k..n {
                    a[i * n + j] -= f * a[k * n + j];
                }
                b[i] -= f * b[k];
            }
        }
    }
    for k in (0..n).rev() {
        let s: f64 = (k + 1..n).map(|j| a[k * n + j] * b[j]).sum();
        b[k] = (b[k] - s) / a[k * n + k];
    }
    b.iter().all(|v| v.is_finite())
}
