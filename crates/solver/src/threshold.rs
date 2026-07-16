/// Threshold search for InDeCa spike binarization.
///
/// Given a relaxed solution s in [0,1], find the optimal threshold that produces
/// a binary spike train whose AR2 convolution best explains the observed trace.
/// Uses a coarse-then-fine grid search over thresholds from the relaxed solution.
///
/// For each candidate threshold, the binary spike train is convolved through
/// the peak-normalized AR2 model and fit with least-squares alpha + baseline.
/// Alpha is constrained non-negative (spikes must add signal, not subtract).
use crate::banded::BandedAR2;

pub struct ThresholdResult {
    pub s_binary: Vec<f32>,
    pub alpha: f64,
    pub baseline: f64,
    pub threshold: f64,
    pub pve: f64,
    pub error: f64,
}

/// How the binarization threshold is chosen.
#[derive(Clone, Copy)]
pub enum Selection {
    /// Current behavior: threshold that minimizes reconstruction error (max PVE).
    /// This overfits — it drives the residual below the noise floor.
    MaxPve,
    /// Noise-constrained: the sparsest support (highest threshold) whose residual
    /// at original-rate grid positions stays within the noise floor
    /// `sigma^2 * n_grid_interior`. `sigma` is the noise std of the filtered trace
    /// at original rate (data-derived, no tuning knob). Realizes an OASIS-style
    /// "don't fit below the noise" sparsity at the stage where counts are decided.
    NoiseFloor { sigma: f64 },
}

/// Compute boundary padding for threshold search: ceil(2 * tau_d * fs_up).
/// Used to exclude edge effects from the error computation.
pub fn boundary_padding(tau_decay: f64, fs_up: f64) -> usize {
    (2.0 * tau_decay * fs_up).ceil() as usize
}

/// Find the optimal binarization threshold for a relaxed spike solution.
///
/// Searches over candidate thresholds to find the one that minimizes
/// reconstruction error when the binarized signal is convolved through
/// the AR2 model and fit with least-squares alpha + baseline.
///
/// Alpha is constrained non-negative (spikes must add signal, not subtract).
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
    )
}

/// Threshold search with a selectable criterion. See [`Selection`].
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
) -> ThresholdResult {
    let n = s_relaxed.len();
    let pad = boundary_padding(tau_decay, fs_up).min(n / 4);

    // Minimum threshold floor at 0.5/upsample_factor.
    // At upsampled rates, FISTA spreads spike energy across neighboring bins,
    // producing halo values around this level. This floor prevents the search
    // from selecting a threshold so low that halo artifacts are counted as spikes.
    let min_threshold = 0.5 / upsample_factor.max(1) as f64;

    // Collect sorted unique non-zero values for threshold candidates
    let mut vals: Vec<f32> = s_relaxed.iter().copied().filter(|&v| v > 1e-10).collect();
    vals.sort_unstable_by(|a, b| a.total_cmp(b));
    vals.dedup_by(|a, b| (*a - *b).abs() < 1e-10);

    if vals.is_empty() {
        // No nonzero values — return zero result
        return ThresholdResult {
            s_binary: vec![0.0; n],
            alpha: 0.0,
            baseline: y.iter().map(|&v| v as f64).sum::<f64>() / n as f64,
            threshold: 0.0,
            pve: 0.0,
            error: f64::INFINITY,
        };
    }

    // Reusable buffers
    let mut s_bin = vec![0.0_f32; n];
    let mut conv_buf = vec![0.0_f32; n];

    let mut best = ThresholdResult {
        s_binary: Vec::new(),
        alpha: 0.0,
        baseline: 0.0,
        threshold: 0.0,
        pve: 0.0,
        error: f64::INFINITY,
    };

    // Noise-constrained selection scans for the sparsest support within the
    // noise floor; the max-PVE path keeps the original coarse→fine search.
    if let Selection::NoiseFloor { sigma } = selection {
        best.threshold = select_noise_floor_threshold(
            s_relaxed,
            y,
            banded,
            pad,
            upsample_factor,
            max_alpha,
            sigma,
            &vals,
            min_threshold,
            &mut s_bin,
            &mut conv_buf,
        );
    } else {
        // Phase 1: Coarse search — ~50 evenly spaced thresholds
        let coarse_n = 50.min(vals.len());
        let coarse_step = if vals.len() > 1 {
            (vals.len() - 1) as f64 / (coarse_n - 1).max(1) as f64
        } else {
            1.0
        };

        let mut coarse_thresholds: Vec<f64> = Vec::with_capacity(coarse_n);
        for i in 0..coarse_n {
            let idx = (i as f64 * coarse_step).round() as usize;
            let idx = idx.min(vals.len() - 1);
            coarse_thresholds.push(vals[idx] as f64);
        }
        coarse_thresholds.dedup_by(|a, b| (*a - *b).abs() < 1e-10);

        // Enforce minimum threshold floor
        coarse_thresholds.retain(|&t| t >= min_threshold);
        if coarse_thresholds.is_empty() {
            // All candidates below minimum — use min_threshold as the only candidate
            coarse_thresholds.push(min_threshold);
        }

        let mut consecutive_increases = 0;
        for &thresh in &coarse_thresholds {
            let err = evaluate_threshold(
                s_relaxed,
                y,
                banded,
                thresh,
                pad,
                1,
                max_alpha,
                &mut s_bin,
                &mut conv_buf,
            );
            if err < best.error {
                best.error = err;
                best.threshold = thresh;
                consecutive_increases = 0;
            } else {
                consecutive_increases += 1;
                if consecutive_increases >= 10 {
                    break;
                }
            }
        }

        // Phase 2: Fine search — ~50 thresholds around the best coarse result
        let spread = if vals.len() > 1 {
            (vals[vals.len() - 1] - vals[0]) as f64 / coarse_n as f64 * 2.0
        } else {
            best.threshold * 0.2
        };
        let fine_lo = (best.threshold - spread).max(min_threshold);
        let fine_hi = best.threshold + spread;
        let fine_n = 50;
        let fine_step = (fine_hi - fine_lo) / (fine_n - 1).max(1) as f64;

        consecutive_increases = 0;
        for i in 0..fine_n {
            let thresh = fine_lo + i as f64 * fine_step;
            if thresh < 0.0 {
                continue;
            }
            let err = evaluate_threshold(
                s_relaxed,
                y,
                banded,
                thresh,
                pad,
                1,
                max_alpha,
                &mut s_bin,
                &mut conv_buf,
            );
            if err < best.error {
                best.error = err;
                best.threshold = thresh;
                consecutive_increases = 0;
            } else {
                consecutive_increases += 1;
                if consecutive_increases >= 10 {
                    break;
                }
            }
        }
    } // end max-PVE search branch

    // Final pass: compute full result at best threshold
    binarize(s_relaxed, best.threshold, &mut s_bin);
    banded.convolve_forward(&s_bin, &mut conv_buf);

    let (alpha, baseline) = lstsq_alpha_baseline(&conv_buf, y, pad, max_alpha);
    best.alpha = alpha;
    best.baseline = baseline;
    best.s_binary = s_bin;

    // Compute PVE (proportion of variance explained)
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

        best.pve = if ss_tot > 1e-20 {
            1.0 - ss_res / ss_tot
        } else {
            0.0
        };
    }

    best
}

/// Binarize: s_bin[i] = 1 if s[i] >= threshold, else 0.
fn binarize(s: &[f32], threshold: f64, s_bin: &mut [f32]) {
    let thresh = threshold as f32;
    for (out, &v) in s_bin.iter_mut().zip(s.iter()) {
        *out = if v >= thresh { 1.0 } else { 0.0 };
    }
}

/// Evaluate a single threshold: binarize → convolve → lstsq → residual SSE.
///
/// Alpha/baseline are always fit over the full interior; the SSE is accumulated
/// over the interior sampling every `stride`-th position (`stride >= 1`).
/// `stride == 1` sums the whole interior — the max-PVE search. A larger stride
/// restricts the residual to original-rate grid positions (`stride == upsample_
/// factor`), where the upsampled trace equals the real samples and the noise is
/// uncorrelated — the quantity the noise-floor budget is calibrated against.
fn evaluate_threshold(
    s_relaxed: &[f32],
    y: &[f32],
    banded: &BandedAR2,
    threshold: f64,
    pad: usize,
    stride: usize,
    max_alpha: f64,
    s_bin: &mut [f32],
    conv_buf: &mut [f32],
) -> f64 {
    binarize(s_relaxed, threshold, s_bin);
    banded.convolve_forward(s_bin, conv_buf);

    let (alpha, baseline) = lstsq_alpha_baseline(conv_buf, y, pad, max_alpha);

    let n = y.len();
    let mut err = 0.0_f64;
    let mut i = pad;
    while i < n.saturating_sub(pad) {
        let pred = alpha * conv_buf[i] as f64 + baseline;
        let d = y[i] as f64 - pred;
        err += d * d;
        i += stride.max(1);
    }
    err
}

/// Scan candidate thresholds and return the highest (sparsest) one whose
/// grid-residual stays within the noise budget `sigma^2 * n_grid_interior`.
/// Residual increases as the threshold rises (fewer spikes → worse fit), so the
/// highest feasible threshold is the sparsest support that still explains the
/// signal down to — but not below — the noise floor. Falls back to the
/// min-grid-residual threshold if none is feasible (budget tighter than the
/// best achievable fit).
#[allow(clippy::too_many_arguments)]
fn select_noise_floor_threshold(
    s_relaxed: &[f32],
    y: &[f32],
    banded: &BandedAR2,
    pad: usize,
    upsample_factor: usize,
    max_alpha: f64,
    sigma: f64,
    vals: &[f32],
    min_threshold: f64,
    s_bin: &mut [f32],
    conv_buf: &mut [f32],
) -> f64 {
    let n = y.len();
    // Evaluate the noise constraint on original-rate grid positions only
    // (stride = upsample_factor): there the upsampled trace equals the real
    // samples, avoiding the correlated, reduced-variance noise at interpolated
    // positions, so the budget can use a noise std estimated at the original rate.
    let stride = upsample_factor.max(1);
    let n_grid = (pad..n.saturating_sub(pad)).step_by(stride).count();
    let budget = sigma * sigma * n_grid as f64;

    // Up to `cap` candidate thresholds, evenly spaced through the sorted values.
    // `cap` is a fixed search resolution (mirroring the coarse/fine counts in the
    // max-PVE path), not a result-affecting tuning knob.
    let cap = 256usize;
    let step = if vals.len() > cap {
        vals.len() as f64 / cap as f64
    } else {
        1.0
    };
    let mut candidates: Vec<f64> = Vec::with_capacity(cap.min(vals.len()));
    let mut idx = 0.0_f64;
    while (idx as usize) < vals.len() {
        let thr = vals[idx as usize] as f64;
        idx += step;
        if thr >= min_threshold {
            candidates.push(thr);
        }
    }

    // Grid residual rises as the threshold rises (fewer spikes → worse fit), so
    // the sparsest feasible support is the *highest* threshold within budget.
    // Scan top-down and return the first feasible one. If none is feasible
    // (budget tighter than the best achievable fit), fall back to the
    // min-residual threshold found over the same scan.
    let mut best_effort_thr = min_threshold;
    let mut best_effort_sse = f64::INFINITY;
    for &thr in candidates.iter().rev() {
        let sse = evaluate_threshold(
            s_relaxed, y, banded, thr, pad, stride, max_alpha, s_bin, conv_buf,
        );
        if sse <= budget {
            return thr;
        }
        if sse < best_effort_sse {
            best_effort_sse = sse;
            best_effort_thr = thr;
        }
    }
    best_effort_thr
}

/// Least-squares fit for alpha and baseline: y ≈ alpha * conv + baseline.
/// Solves the 2x2 normal equations over the inner region [pad..n-pad].
/// Alpha is constrained to [0, max_alpha]. When max_alpha is f64::INFINITY
/// (the default from solve_trace), alpha is effectively uncapped — the
/// free-solve phase calibrates the prescale so alpha_lstsq lands near 1.0.
pub(crate) fn lstsq_alpha_baseline(conv: &[f32], y: &[f32], pad: usize, max_alpha: f64) -> (f64, f64) {
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
            Selection::NoiseFloor {
                sigma: 1.5 * noise_std,
            },
        );
        let loose = threshold_search_opts(
            &s_relaxed,
            &y,
            &banded,
            0.4,
            30.0,
            1,
            f64::INFINITY,
            Selection::NoiseFloor { sigma: 100.0 },
        );

        let tight_count: f32 = tight.s_binary.iter().sum();
        let loose_count: f32 = loose.s_binary.iter().sum();
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
        // sigma → 0 makes the budget unreachable, so no threshold is feasible and
        // the scan must fall back to the minimum-residual threshold — which on
        // this signal recovers the true spikes rather than returning garbage.
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
            Selection::NoiseFloor { sigma: 1e-9 },
        );
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
}
