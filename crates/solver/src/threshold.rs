//! Threshold search for InDeCa spike binarization.
//!
//! Given a relaxed solution `s` in [0,1], choose the threshold whose binary
//! spike train, convolved through the peak-normalized AR(2) model and fit with
//! a least-squares amplitude `alpha >= 0` plus baseline, explains the observed
//! trace.
//!
//! # Candidates
//!
//! Candidates are a fixed, evenly spaced grid of [`THRESHOLD_GRID_LEVELS`]
//! levels over `[0.5 / upsample_factor, 1]`. The grid does not depend on the
//! relaxed solution's own values, so a tiny change to the input cannot shift
//! the candidate set. (A strided list of the solution's distinct values, used
//! previously, did shift, which made the pick hypersensitive to 1e-6 input
//! perturbations.) The lower end is the upsampling halo floor: FISTA spreads
//! one spike over neighbouring upsampled bins at about `1 / upsample_factor`
//! each.
//!
//! # Residual statistic
//!
//! Each candidate train is convolved through the AR(2) model and fit with a
//! least-squares alpha/baseline over the interior. The selection statistic is
//! the residual energy at original-rate grid positions (every
//! `upsample_factor`-th interior sample), where the upsampled trace equals the
//! recorded samples. [`NoiseModel`] gives that statistic's expected noise
//! energy `sigma^2 * n_grid` (the budget, with `sigma` the noise std of the
//! *filtered* trace on the grid) and its sampling standard error
//! `sigma^2 * sqrt(2 * n_grid * corr_sum)`: a sum of `n_grid` squared
//! zero-mean Gaussian samples has variance `2 * sum_ij cov_ij^2`, which is
//! `2 * sigma^4 * n_grid * corr_sum` for stationary noise with
//! `corr_sum = sum_lag rho(lag)^2` (1 for white noise).
//!
//! The reconstruction is not passed through the trace's bandpass: the
//! low-pass sits above the kernel's band (filtering the reconstruction changed
//! the true train's residual by under 3% on the simulation presets), and the
//! high-pass's slow-band role is taken over by the rolling baseline and the
//! fitted offset (filtering with it made the true train fit worse, because the
//! trace's rolling-baseline step undoes the high-pass sag the reconstruction
//! would keep). What keeps real traces above the budget is model error the
//! AR(2) train cannot express (slow drift, the rolling baseline absorbing
//! calcium during dense activity, frame integration), not the filter.
//!
//! # Selection rule
//!
//! Let `e(t)` be the grid residual energy at threshold `t` and `e_min` its
//! minimum over the grid. The pick is the sparsest (highest) threshold with
//! `e(t) <= allowance`, where
//!
//! - [`Selection::NoiseFloor`]: `allowance = max(budget, e_min + SE)`. When the
//!   best fit beats the noise floor by more than its standard error
//!   (`e_min + SE < budget`) the budget binds: the sparsest train that explains
//!   the trace down to, but not below, the noise (the "noise path"). Otherwise
//!   no train reaches the noise floor and the rule is the one-SE rule below.
//! - [`Selection::MaxPve`]: `allowance = e_min + SE` (the "one standard error"
//!   rule). Every threshold within one SE of the best fit is statistically
//!   indistinguishable from it, so the sparsest of them is taken; this keeps
//!   the pick off the noise-driven wiggles of a flat error curve. With no noise
//!   model (`SE = 0`) it is the plain minimum-error (maximum-PVE) threshold.
use crate::banded::BandedAR2;
use crate::chain::Scorer;

/// Number of evenly spaced candidate thresholds. This is the numerical
/// resolution of the search (a step of ~0.005 in normalized spike height), not
/// a tuning knob: the selection rule, not the grid, decides the pick.
pub const THRESHOLD_GRID_LEVELS: usize = 200;

pub struct ThresholdResult {
    pub s_binary: Vec<f32>,
    pub alpha: f64,
    pub baseline: f64,
    pub threshold: f64,
    pub pve: f64,
    /// Grid residual energy at the picked threshold (the selection statistic).
    pub error: f64,
    /// True when the noise budget decided the pick (see the module docs).
    pub noise_path: bool,
}

/// How the binarization threshold is chosen. See the module docs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Selection {
    /// Sparsest threshold within one standard error of the best fit.
    MaxPve,
    /// Sparsest threshold whose residual stays within the noise budget, falling
    /// back to the one-SE rule when the budget is out of reach.
    NoiseFloor,
}

/// Noise statistics of the selection residual (filtered space, original-rate
/// grid positions). Data-derived; see `indeca::estimate_noise_model`.
#[derive(Clone, Copy, Debug)]
pub struct NoiseModel {
    /// Per-sample noise std of the filtered trace at grid positions.
    pub sigma: f64,
    /// `sum_lag rho(lag)^2` of that noise: 1 for white noise, larger when the
    /// low-pass correlates neighbouring grid samples.
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

/// Compute boundary padding for threshold search: ceil(2 * tau_d * fs_up).
/// Used to exclude edge effects from the error computation.
pub fn boundary_padding(tau_decay: f64, fs_up: f64) -> usize {
    (2.0 * tau_decay * fs_up).ceil() as usize
}

/// The candidate thresholds: [`THRESHOLD_GRID_LEVELS`] evenly spaced levels
/// over `[min_threshold, 1]`, ascending.
pub fn threshold_grid(min_threshold: f64) -> Vec<f64> {
    let lo = min_threshold.clamp(0.0, 1.0);
    let last = (THRESHOLD_GRID_LEVELS - 1) as f64;
    (0..THRESHOLD_GRID_LEVELS)
        .map(|i| lo + (1.0 - lo) * i as f64 / last)
        .collect()
}

/// Minimum-error (maximum-PVE) threshold search with an unknown noise level.
/// See [`threshold_search_opts`].
pub fn threshold_search(
    s_relaxed: &[f32],
    y: &[f32],
    banded: &BandedAR2,
    tau_decay: f64,
    fs_up: f64,
    upsample_factor: usize,
    max_alpha: f64,
) -> ThresholdResult {
    threshold_search_opts(
        s_relaxed,
        y,
        banded,
        tau_decay,
        fs_up,
        upsample_factor,
        max_alpha,
        Selection::MaxPve,
        None,
    )
}

/// Threshold search with a selectable criterion. `noise` (`None`: unknown)
/// sets the budget and the standard error. See the module docs.
#[allow(clippy::too_many_arguments)]
pub fn threshold_search_opts(
    s_relaxed: &[f32],
    y: &[f32],
    banded: &BandedAR2,
    tau_decay: f64,
    fs_up: f64,
    upsample_factor: usize,
    max_alpha: f64,
    selection: Selection,
    noise: Option<NoiseModel>,
) -> ThresholdResult {
    threshold_search_scored(
        s_relaxed,
        &mut Scorer::Plain { y },
        banded,
        tau_decay,
        fs_up,
        upsample_factor,
        max_alpha,
        selection,
        noise,
    )
}

/// [`threshold_search_opts`] with an explicit candidate [`Scorer`] (the
/// trace is the scorer's target).
#[allow(clippy::too_many_arguments)]
pub(crate) fn threshold_search_scored(
    s_relaxed: &[f32],
    scorer: &mut Scorer,
    banded: &BandedAR2,
    tau_decay: f64,
    fs_up: f64,
    upsample_factor: usize,
    max_alpha: f64,
    selection: Selection,
    noise: Option<NoiseModel>,
) -> ThresholdResult {
    let n = s_relaxed.len();
    let pad = boundary_padding(tau_decay, fs_up).min(n / 4);
    let stride = upsample_factor.max(1);

    if !s_relaxed.iter().any(|&v| v > 1e-10) {
        // No nonzero values — return zero result
        return ThresholdResult {
            s_binary: vec![0.0; n],
            alpha: 0.0,
            // Guard the empty trace: 0/0 would report a NaN baseline.
            baseline: if n == 0 {
                0.0
            } else {
                scorer.target().iter().map(|&v| v as f64).sum::<f64>() / n as f64
            },
            threshold: 0.0,
            pve: 0.0,
            error: f64::INFINITY,
            noise_path: false,
        };
    }

    // Reusable buffers
    let mut s_bin = vec![0.0_f32; n];
    let mut conv_buf = vec![0.0_f32; n];

    // Score every grid level, top-down. A lower threshold keeps a superset of
    // the bins a higher one keeps, so an unchanged count means an unchanged
    // binary train: reuse its error instead of refitting.
    let levels = threshold_grid(0.5 / stride as f64);
    let mut errors = vec![f64::INFINITY; levels.len()];
    let mut last_count = usize::MAX;
    let mut last_err = f64::INFINITY;
    for (i, &thr) in levels.iter().enumerate().rev() {
        let count = binarize(s_relaxed, thr, &mut s_bin);
        if count != last_count {
            last_err = scorer
                .score(&s_bin, banded, pad, stride, max_alpha, &mut conv_buf)
                .0;
            last_count = count;
        }
        errors[i] = last_err;
    }

    let n_grid = (pad..n.saturating_sub(pad)).step_by(stride).count();
    let (i_min, e_min) =
        errors
            .iter()
            .copied()
            .enumerate()
            .fold(
                (0, f64::INFINITY),
                |acc, (i, e)| {
                    if e < acc.1 {
                        (i, e)
                    } else {
                        acc
                    }
                },
            );
    let fit_allowance = e_min + noise.map_or(0.0, |nm| nm.std_error(n_grid));
    let budget = match (selection, noise) {
        (Selection::NoiseFloor, Some(nm)) => nm.budget(n_grid),
        _ => 0.0,
    };
    let noise_path = budget > fit_allowance;
    let allowance = budget.max(fit_allowance);
    let pick = (0..levels.len())
        .rev()
        .find(|&i| errors[i] <= allowance)
        .unwrap_or(i_min);

    // Final pass: full result at the picked threshold
    let threshold = levels[pick];
    binarize(s_relaxed, threshold, &mut s_bin);
    let (_, alpha, baseline) = scorer.score(&s_bin, banded, pad, stride, max_alpha, &mut conv_buf);
    let y = scorer.target();

    // PVE (proportion of variance explained) over the full interior
    let mut pve = 0.0;
    let inner_range = pad..n.saturating_sub(pad);
    let inner_len = inner_range.len();
    if inner_len > 0 {
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
            let pred = alpha * conv_buf[i] as f64 + baseline;
            let r = yi - pred;
            ss_res += r * r;
        }

        if ss_tot > 1e-20 {
            pve = 1.0 - ss_res / ss_tot;
        }
    }

    ThresholdResult {
        s_binary: s_bin,
        alpha,
        baseline,
        threshold,
        pve,
        error: errors[pick],
        noise_path,
    }
}

/// Binarize: s_bin[i] = 1 if s[i] >= threshold, else 0. Returns the number of ones.
fn binarize(s: &[f32], threshold: f64, s_bin: &mut [f32]) -> usize {
    let thresh = threshold as f32;
    let mut count = 0;
    for (out, &v) in s_bin.iter_mut().zip(s.iter()) {
        let on = v >= thresh;
        count += on as usize;
        *out = if on { 1.0 } else { 0.0 };
    }
    count
}

/// Score one binary train: convolve → least-squares alpha/baseline over the
/// full interior → residual energy at every `stride`-th interior sample.
/// Leaves the reconstruction in `conv_buf`.
/// Returns `(grid_error, alpha, baseline)`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn fit_candidate(
    s_bin: &[f32],
    y: &[f32],
    banded: &BandedAR2,
    pad: usize,
    stride: usize,
    max_alpha: f64,
    conv_buf: &mut [f32],
) -> (f64, f64, f64) {
    banded.convolve_forward(s_bin, conv_buf);

    let (alpha, baseline) = lstsq_alpha_baseline(conv_buf, y, pad, max_alpha);

    let n = y.len();
    let mut err = 0.0_f64;
    for i in (pad..n.saturating_sub(pad)).step_by(stride.max(1)) {
        let d = y[i] as f64 - (alpha * conv_buf[i] as f64 + baseline);
        err += d * d;
    }
    (err, alpha, baseline)
}

/// Least-squares fit for alpha and baseline: y ≈ alpha * conv + baseline.
/// Solves the 2x2 normal equations over the inner region [pad..n-pad].
/// Alpha is constrained to [0, max_alpha]. When max_alpha is f64::INFINITY
/// (the default from solve_trace), alpha is effectively uncapped — the
/// free-solve phase calibrates the prescale so alpha_lstsq lands near 1.0.
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
    use crate::banded::BandedAR2;

    /// Test-only reference for the candidate set used before the fixed grid:
    /// a strided list (at most 256) of the relaxed solution's sorted distinct
    /// values at or above `min_threshold`. Kept to check that the grid reaches
    /// the same best fit when the solution has few distinct levels.
    fn sorted_unique_candidates(s_relaxed: &[f32], min_threshold: f64) -> Vec<f64> {
        let mut vals: Vec<f32> = s_relaxed.iter().copied().filter(|&v| v > 1e-10).collect();
        vals.sort_unstable_by(|a, b| a.total_cmp(b));
        vals.dedup_by(|a, b| (*a - *b).abs() < 1e-10);
        let cap = 256usize;
        let step = if vals.len() > cap {
            vals.len() as f64 / cap as f64
        } else {
            1.0
        };
        let mut out = Vec::new();
        let mut idx = 0.0_f64;
        while (idx as usize) < vals.len() {
            let thr = vals[idx as usize] as f64;
            idx += step;
            if thr >= min_threshold {
                out.push(thr);
            }
        }
        out
    }

    fn noise_model(sigma: f64) -> Option<NoiseModel> {
        Some(NoiseModel {
            sigma,
            corr_sum: 1.0,
        })
    }

    #[test]
    fn perfect_binary_recovery() {
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 300;

        let mut s_true = vec![0.0_f32; n];
        s_true[20] = 1.0;
        s_true[80] = 1.0;
        s_true[150] = 1.0;
        s_true[220] = 1.0;

        let alpha_true = 5.0;
        let baseline_true = 2.0;
        let mut conv = vec![0.0_f32; n];
        banded.convolve_forward(&s_true, &mut conv);

        let y: Vec<f32> = conv
            .iter()
            .map(|&c| alpha_true * c + baseline_true as f32)
            .collect();

        let result = threshold_search(&s_true, &y, &banded, 0.4, 30.0, 1, f64::INFINITY);

        let spike_count: f32 = result.s_binary.iter().sum();
        assert!(
            (spike_count - 4.0).abs() < 0.5,
            "Should find 4 spikes, got {}",
            spike_count
        );
        assert!(
            result.pve > 0.95,
            "PVE should be > 0.95, got {}",
            result.pve
        );
    }

    #[test]
    fn alpha_baseline_recovery() {
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 300;

        let mut s_true = vec![0.0_f32; n];
        s_true[50] = 1.0;
        s_true[150] = 1.0;

        let alpha_true = 3.5;
        let baseline_true = 1.5;
        let mut conv = vec![0.0_f32; n];
        banded.convolve_forward(&s_true, &mut conv);

        let y: Vec<f32> = conv
            .iter()
            .map(|&c| (alpha_true * c as f64 + baseline_true) as f32)
            .collect();

        let result = threshold_search(&s_true, &y, &banded, 0.4, 30.0, 1, f64::INFINITY);

        assert!(
            (result.alpha - alpha_true).abs() < 0.5,
            "Alpha should be ~{}, got {}",
            alpha_true,
            result.alpha
        );
        assert!(
            (result.baseline - baseline_true).abs() < 0.5,
            "Baseline should be ~{}, got {}",
            baseline_true,
            result.baseline
        );
    }

    #[test]
    fn pve_high_on_clean_data() {
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 500;

        let mut s_relaxed = vec![0.0_f32; n];
        for &pos in &[50, 120, 250, 380] {
            s_relaxed[pos] = 0.95;
            if pos > 0 {
                s_relaxed[pos - 1] = 0.3;
            }
            if pos + 1 < n {
                s_relaxed[pos + 1] = 0.3;
            }
        }

        let mut s_binary = vec![0.0_f32; n];
        for &pos in &[50, 120, 250, 380] {
            s_binary[pos] = 1.0;
        }
        let mut conv = vec![0.0_f32; n];
        banded.convolve_forward(&s_binary, &mut conv);
        let y: Vec<f32> = conv.iter().map(|&c| 3.0 * c + 1.0).collect();

        let result = threshold_search(&s_relaxed, &y, &banded, 0.4, 30.0, 1, f64::INFINITY);
        assert!(
            result.pve > 0.9,
            "PVE should be > 0.9 on clean data, got {}",
            result.pve
        );
    }

    #[test]
    fn alpha_non_negative() {
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 100;
        let s_relaxed = vec![0.5_f32; n];
        let y = vec![1.0_f32; n];

        let result = threshold_search(&s_relaxed, &y, &banded, 0.4, 30.0, 1, f64::INFINITY);
        assert!(
            result.alpha >= 0.0,
            "Alpha should be non-negative, got {}",
            result.alpha
        );
    }

    #[test]
    fn empty_spikes_handled() {
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 100;
        let s_relaxed = vec![0.0_f32; n];
        let y = vec![1.0_f32; n];

        let result = threshold_search(&s_relaxed, &y, &banded, 0.4, 30.0, 1, f64::INFINITY);
        assert_eq!(result.s_binary.iter().sum::<f32>(), 0.0);
    }

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

    /// Deterministic white-ish noise in [-amp, amp) via an LCG (tests must not
    /// use real RNG). Zero-mean in expectation; variance ≈ amp²/3.
    fn lcg_noise(n: usize, amp: f32, seed: u64) -> Vec<f32> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let u = ((state >> 32) as f64) / ((1u64 << 31) as f64) - 1.0;
                (u as f32) * amp
            })
            .collect()
    }

    /// Build a graded relaxed solution + noisy observed trace with three true
    /// spikes whose relaxed values differ (1.0 / 0.85 / 0.7) plus weaker spurious
    /// bumps (0.55), so the budget genuinely controls how many survive.
    fn graded_case(banded: &BandedAR2, n: usize) -> (Vec<f32>, Vec<f32>, f64) {
        let true_pos = [80usize, 250, 430];
        let true_val = [1.0_f32, 0.85, 0.7];
        let mut s_bin_true = vec![0.0_f32; n];
        let mut s_relaxed = vec![0.0_f32; n];
        for (&p, &v) in true_pos.iter().zip(&true_val) {
            s_bin_true[p] = 1.0;
            s_relaxed[p] = v;
        }
        for &p in &[40usize, 150, 320, 500, 560] {
            s_relaxed[p] = 0.55;
        }
        let mut conv = vec![0.0_f32; n];
        banded.convolve_forward(&s_bin_true, &mut conv);
        let alpha = 8.0_f64;
        let baseline = 1.0_f64;
        let amp = 0.25_f32;
        let noise = lcg_noise(n, amp, 0xABCDEF01);
        let y: Vec<f32> = conv
            .iter()
            .zip(&noise)
            .map(|(&c, &e)| (alpha * c as f64 + baseline) as f32 + e)
            .collect();
        let noise_std = (amp as f64) / 3.0_f64.sqrt();
        (s_relaxed, y, noise_std)
    }

    #[test]
    fn noise_floor_larger_budget_is_sparser() {
        // A larger noise budget admits sparser (higher) thresholds, so it should
        // never yield more spikes than a tight budget. With a huge budget the
        // sparsest support (highest candidate) is immediately feasible; with a
        // budget just above the noise floor, all three true spikes are required.
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 600;
        let (s_relaxed, y, noise_std) = graded_case(&banded, n);

        let tight = threshold_search_opts(
            &s_relaxed,
            &y,
            &banded,
            0.4,
            30.0,
            1,
            f64::INFINITY,
            Selection::NoiseFloor,
            noise_model(1.5 * noise_std),
        );
        let loose = threshold_search_opts(
            &s_relaxed,
            &y,
            &banded,
            0.4,
            30.0,
            1,
            f64::INFINITY,
            Selection::NoiseFloor,
            noise_model(100.0),
        );

        let tight_count: f32 = tight.s_binary.iter().sum();
        let loose_count: f32 = loose.s_binary.iter().sum();
        assert!(tight.noise_path && loose.noise_path);
        assert!(
            loose.threshold >= tight.threshold,
            "looser budget should pick a higher threshold ({} vs {})",
            loose.threshold,
            tight.threshold
        );
        assert!(
            loose_count <= tight_count,
            "looser budget should not add spikes ({} vs {})",
            loose_count,
            tight_count
        );
        assert!(
            (tight_count - 3.0).abs() < 0.5,
            "tight budget should keep all three true spikes, got {}",
            tight_count
        );
        assert!(
            loose_count < tight_count,
            "huge budget should drop the weaker spikes ({} vs {})",
            loose_count,
            tight_count
        );
    }

    #[test]
    fn noise_floor_falls_back_when_infeasible() {
        // sigma → 0 makes the budget unreachable, so the noise path is not taken
        // and the one-SE rule (SE → 0: the minimum-error threshold) decides —
        // which on this signal recovers the true spikes rather than garbage.
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 600;
        let (s_relaxed, y, _) = graded_case(&banded, n);

        let result = threshold_search_opts(
            &s_relaxed,
            &y,
            &banded,
            0.4,
            30.0,
            1,
            f64::INFINITY,
            Selection::NoiseFloor,
            noise_model(1e-9),
        );
        assert!(!result.noise_path);
        assert!(result.threshold.is_finite());
        let count: f32 = result.s_binary.iter().sum();
        assert!(
            (count - 3.0).abs() < 0.5,
            "fallback should recover the three true spikes, got {}",
            count
        );
        assert!(
            result.pve > 0.9,
            "fallback fit should explain the signal, pve {}",
            result.pve
        );
    }

    #[test]
    fn grid_reaches_the_reference_candidates_best_fit() {
        // With few distinct relaxed levels the grid reaches every binarization
        // the old sorted-unique candidate list could, so the minimum error agrees.
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 600;
        let (s_relaxed, y, _) = graded_case(&banded, n);
        let mut s_bin = vec![0.0_f32; n];
        let mut conv = vec![0.0_f32; n];
        let pad = boundary_padding(0.4, 30.0).min(n / 4);
        let ref_min = sorted_unique_candidates(&s_relaxed, 0.5)
            .into_iter()
            .map(|t| {
                binarize(&s_relaxed, t, &mut s_bin);
                fit_candidate(&s_bin, &y, &banded, pad, 1, f64::INFINITY, &mut conv).0
            })
            .fold(f64::INFINITY, f64::min);
        let r = threshold_search(&s_relaxed, &y, &banded, 0.4, 30.0, 1, f64::INFINITY);
        assert!(
            (r.error - ref_min).abs() <= 1e-9 * ref_min.max(1.0),
            "grid min {} vs reference min {}",
            r.error,
            ref_min
        );
    }

    #[test]
    fn one_se_rule_drops_a_spike_the_data_cannot_justify() {
        // Noise-free trace: three unit spikes plus a fourth at 0.55 amplitude.
        // Including the fourth spike (relaxed value 0.6) fits slightly better
        // than leaving it out; the plain minimum keeps it. Once the standard
        // error of the residual exceeds that gain, the one-SE rule prefers the
        // sparser train.
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 600;
        let mut s_relaxed = vec![0.0_f32; n];
        let mut y_src = vec![0.0_f32; n];
        for (&p, &v) in [100usize, 250, 400].iter().zip(&[1.0_f32, 0.9, 0.8]) {
            s_relaxed[p] = v;
            y_src[p] = 1.0;
        }
        s_relaxed[520] = 0.6;
        y_src[520] = 0.55;
        let mut conv = vec![0.0_f32; n];
        banded.convolve_forward(&y_src, &mut conv);
        let y: Vec<f32> = conv.iter().map(|&c| 8.0 * c + 1.0).collect();

        let plain = threshold_search(&s_relaxed, &y, &banded, 0.4, 30.0, 1, f64::INFINITY);
        assert!((plain.s_binary.iter().sum::<f32>() - 4.0).abs() < 0.5);

        let one_se = threshold_search_opts(
            &s_relaxed,
            &y,
            &banded,
            0.4,
            30.0,
            1,
            f64::INFINITY,
            Selection::MaxPve,
            noise_model(3.0),
        );
        assert!(!one_se.noise_path);
        assert!(
            (one_se.s_binary.iter().sum::<f32>() - 3.0).abs() < 0.5,
            "one-SE rule should drop the marginal spike"
        );
    }

    #[test]
    fn pick_is_stable_under_tiny_perturbations() {
        // A relaxed solution with many distinct values (the case where the old
        // candidate list itself moved with the input): a 1e-6 relative
        // perturbation of the trace must not change the binary train.
        let banded = BandedAR2::new(0.02, 0.4, 30.0);
        let n = 900;
        let (mut s_relaxed, y, noise_std) = graded_case(&banded, n);
        for (v, e) in s_relaxed.iter_mut().zip(lcg_noise(n, 0.2, 7)) {
            *v = (*v + e.abs()).min(1.0);
        }
        let y2: Vec<f32> = y
            .iter()
            .enumerate()
            .map(|(i, &v)| v * (1.0 + if i % 2 == 0 { 1e-6 } else { -1e-6 }))
            .collect();
        let run = |yy: &[f32]| {
            threshold_search_opts(
                &s_relaxed,
                yy,
                &banded,
                0.4,
                30.0,
                1,
                f64::INFINITY,
                Selection::NoiseFloor,
                noise_model(noise_std),
            )
        };
        assert_eq!(run(&y).s_binary, run(&y2).s_binary);
    }
}
