//! Shared pieces of the binarization's candidate scoring: the noise model of
//! the selection residual, the grid of candidate spike sizes, the interior
//! boundary padding and the amplitude/offset least squares.
//!
//! The binarization itself (event segmentation, counts, placement and the
//! pick) lives in the `event_mass` module; how a candidate reconstruction is
//! compared with the trace is the `chain` module's `Scorer`.
//!
//! # Residual statistic
//!
//! Each candidate train is convolved through the AR(2) model (and the
//! trace's preprocessing chain) and fit with a least-squares amplitude
//! `alpha >= 0` plus offset over the interior `[pad, n - pad)`. The
//! selection statistic is the residual energy over that interior.
//! [`NoiseModel`] gives its expected noise energy `sigma^2 * n_grid` (the
//! budget, with `sigma` the noise std of the *filtered* trace) and its
//! sampling standard error `sigma^2 * sqrt(2 * n_grid * corr_sum)`: a sum of
//! `n_grid` squared zero-mean Gaussian samples has variance `2 * sum_ij
//! cov_ij^2`, which is `2 * sigma^4 * n_grid * corr_sum` for stationary
//! noise with `corr_sum = sum_lag rho(lag)^2` (1 for white noise).
use crate::banded::BandedAR2;

/// Number of evenly spaced candidate spike sizes. This is the numerical
/// resolution of the search, not a tuning knob: the selection rule, not the
/// grid, decides the pick.
pub const THRESHOLD_GRID_LEVELS: usize = 200;

/// Noise statistics of the selection residual (filtered space, native-rate
/// samples). Data-derived; see `indeca::estimate_noise_model`.
#[derive(Clone, Copy, Debug)]
pub struct NoiseModel {
    /// Per-sample noise std of the filtered trace.
    pub sigma: f64,
    /// `sum_lag rho(lag)^2` of that noise: 1 for white noise, larger when the
    /// low-pass correlates neighbouring samples.
    pub corr_sum: f64,
}

impl NoiseModel {
    /// Expected residual energy of pure noise over `n_grid` samples.
    pub fn budget(&self, n_grid: usize) -> f64 {
        self.sigma * self.sigma * n_grid as f64
    }

    /// Sampling standard error of that residual energy.
    pub fn std_error(&self, n_grid: usize) -> f64 {
        self.sigma * self.sigma * (2.0 * n_grid as f64 * self.corr_sum.max(1.0)).sqrt()
    }
}

/// Boundary padding: `ceil(2 * tau_d * fs)` samples at each end, excluded
/// from the error computation (edge effects of the AR(2) convolution).
pub fn boundary_padding(tau_decay: f64, fs: f64) -> usize {
    (2.0 * tau_decay * fs).ceil() as usize
}

/// The candidate spike sizes relative to the largest event mass:
/// [`THRESHOLD_GRID_LEVELS`] evenly spaced levels over `[min_level, 1]`,
/// ascending.
pub fn threshold_grid(min_level: f64) -> Vec<f64> {
    let lo = min_level.clamp(0.0, 1.0);
    let last = (THRESHOLD_GRID_LEVELS - 1) as f64;
    (0..THRESHOLD_GRID_LEVELS)
        .map(|i| lo + (1.0 - lo) * i as f64 / last)
        .collect()
}

/// Proportion of variance explained by `alpha * conv + baseline` over the
/// interior `[pad, n - pad)` of `y` (0 when the interior is empty or flat).
pub(crate) fn interior_pve(y: &[f32], conv: &[f32], alpha: f64, baseline: f64, pad: usize) -> f64 {
    let n = y.len();
    let inner_range = pad..n.saturating_sub(pad);
    let inner_len = inner_range.len();
    if inner_len == 0 {
        return 0.0;
    }
    let mut y_sum = 0.0_f64;
    for i in inner_range.clone() {
        y_sum += y[i] as f64;
    }
    let y_mean = y_sum / inner_len as f64;
    let mut ss_tot = 0.0_f64;
    let mut ss_res = 0.0_f64;
    for i in inner_range {
        let yi = y[i] as f64;
        let d = yi - y_mean;
        ss_tot += d * d;
        let r = yi - (alpha * conv[i] as f64 + baseline);
        ss_res += r * r;
    }
    if ss_tot > 1e-20 {
        1.0 - ss_res / ss_tot
    } else {
        0.0
    }
}

/// Residual energy of `alpha * conv + baseline` against `y` over the
/// interior `[pad, n - pad)`.
pub(crate) fn interior_error(
    y: &[f32],
    conv: &[f32],
    alpha: f64,
    baseline: f64,
    pad: usize,
) -> f64 {
    let n = y.len();
    let mut err = 0.0_f64;
    for i in pad..n.saturating_sub(pad) {
        let d = y[i] as f64 - (alpha * conv[i] as f64 + baseline);
        err += d * d;
    }
    err
}

/// Score one train against the bare trace: convolve, fit the least-squares
/// alpha/baseline over the interior, return the interior residual energy.
/// Leaves the reconstruction in `conv_buf`. Returns `(error, alpha,
/// baseline)`.
pub(crate) fn fit_candidate(
    s: &[f32],
    y: &[f32],
    banded: &BandedAR2,
    pad: usize,
    max_alpha: f64,
    conv_buf: &mut [f32],
) -> (f64, f64, f64) {
    banded.convolve_forward(s, conv_buf);
    let (alpha, baseline) = lstsq_alpha_baseline(conv_buf, y, pad, max_alpha);
    (
        interior_error(y, conv_buf, alpha, baseline, pad),
        alpha,
        baseline,
    )
}

/// Least-squares fit for alpha and baseline: y ≈ alpha * conv + baseline.
/// Solves the 2x2 normal equations over the inner region [pad..n-pad].
/// Alpha is constrained to [0, max_alpha]. When max_alpha is f64::INFINITY
/// (what the pipeline passes), alpha is uncapped.
pub(crate) fn lstsq_alpha_baseline(
    conv: &[f32],
    y: &[f32],
    pad: usize,
    max_alpha: f64,
) -> (f64, f64) {
    let n = y.len();
    let lo = pad;
    let hi = n.saturating_sub(pad);
    if hi <= lo {
        return (0.0, 0.0);
    }
    let count = (hi - lo) as f64;

    let mut sum_c = 0.0_f64;
    let mut sum_y = 0.0_f64;
    let mut sum_cc = 0.0_f64;
    let mut sum_cy = 0.0_f64;

    for i in lo..hi {
        let c = conv[i] as f64;
        let yi = y[i] as f64;
        sum_c += c;
        sum_y += yi;
        sum_cc += c * c;
        sum_cy += c * yi;
    }

    // Normal equations: [[sum_cc, sum_c], [sum_c, count]] * [alpha, baseline] = [sum_cy, sum_y]
    let det = sum_cc * count - sum_c * sum_c;
    if det.abs() < 1e-30 {
        return (0.0, sum_y / count);
    }

    let alpha = (sum_cy * count - sum_c * sum_y) / det;
    let baseline = (sum_cc * sum_y - sum_c * sum_cy) / det;

    // Constrain alpha to [0, max_alpha]
    if alpha < 0.0 {
        return (0.0, sum_y / count);
    }
    if alpha > max_alpha {
        // Clamp alpha and recompute baseline for the clamped value
        let baseline = (sum_y - max_alpha * sum_c) / count;
        return (max_alpha, baseline);
    }

    (alpha, baseline)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_padding_values() {
        assert_eq!(boundary_padding(0.4, 30.0), 24);
        assert_eq!(boundary_padding(0.2, 100.0), 40);
        assert_eq!(boundary_padding(1.0, 10.0), 20);
    }

    #[test]
    fn grid_is_fixed_and_spans_floor_to_one() {
        let g = threshold_grid(0.05);
        assert_eq!(g.len(), THRESHOLD_GRID_LEVELS);
        assert!((g[0] - 0.05).abs() < 1e-12);
        assert!((g[g.len() - 1] - 1.0).abs() < 1e-12);
        assert!(g.windows(2).all(|w| w[1] > w[0]));
    }

    #[test]
    fn noise_model_energy_statistics() {
        let nm = NoiseModel {
            sigma: 2.0,
            corr_sum: 1.0,
        };
        assert!((nm.budget(100) - 400.0).abs() < 1e-12);
        // sigma^2 * sqrt(2 n) = 4 * sqrt(200)
        assert!((nm.std_error(100) - 4.0 * 200.0_f64.sqrt()).abs() < 1e-12);
        // Correlated noise has a larger standard error.
        let corr = NoiseModel {
            sigma: 2.0,
            corr_sum: 4.0,
        };
        assert!(corr.std_error(100) > nm.std_error(100));
    }

    #[test]
    fn lstsq_recovers_alpha_and_baseline_and_clamps_negative_alpha() {
        let conv: Vec<f32> = (0..100).map(|i| (i % 7) as f32).collect();
        let y: Vec<f32> = conv.iter().map(|&c| 3.0 * c + 5.0).collect();
        let (a, b) = lstsq_alpha_baseline(&conv, &y, 10, f64::INFINITY);
        assert!((a - 3.0).abs() < 1e-5 && (b - 5.0).abs() < 1e-4, "{a} {b}");
        let neg: Vec<f32> = conv.iter().map(|&c| -3.0 * c + 5.0).collect();
        let (a, _) = lstsq_alpha_baseline(&conv, &neg, 10, f64::INFINITY);
        assert_eq!(a, 0.0);
    }

    #[test]
    fn interior_pve_is_one_for_a_perfect_fit() {
        let conv: Vec<f32> = (0..100).map(|i| (i % 7) as f32).collect();
        let y: Vec<f32> = conv.iter().map(|&c| 2.0 * c + 1.0).collect();
        assert!((interior_pve(&y, &conv, 2.0, 1.0, 10) - 1.0).abs() < 1e-9);
    }
}
