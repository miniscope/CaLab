/// Threshold search for InDeCa spike binarization.
///
/// Given a relaxed solution s in [0,1], find the optimal threshold that produces
/// a binary spike train whose AR2 convolution best explains the observed trace.
/// Uses a coarse-then-fine grid search over thresholds from the relaxed solution.
///
/// Assumes the input trace is normalized: y_norm = (y - baseline) / alpha,
/// so the AR2 impulse response peak ≈ 1 matches the trace amplitude.
/// This ensures that spurious binary spikes create large MSE penalties.

use crate::banded::BandedAR2;

pub struct ThresholdResult {
    pub s_binary: Vec<f32>,
    pub alpha: f64,
    pub baseline: f64,
    pub threshold: f64,
    pub pve: f64,
    pub error: f64,
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
) -> ThresholdResult {
    let n = s_relaxed.len();
    let pad = boundary_padding(tau_decay, fs_up).min(n / 4);

    // Collect sorted unique non-zero values for threshold candidates
    let mut vals: Vec<f32> = s_relaxed
        .iter()
        .copied()
        .filter(|&v| v > 1e-10)
        .collect();
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
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
        s_binary: vec![0.0; n],
        alpha: 0.0,
        baseline: 0.0,
        threshold: 0.0,
        pve: 0.0,
        error: f64::INFINITY,
    };

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

    let mut consecutive_increases = 0;
    for &thresh in &coarse_thresholds {
        let err = evaluate_threshold(
            s_relaxed, y, banded, thresh, pad, &mut s_bin, &mut conv_buf,
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
    let fine_lo = (best.threshold - spread).max(0.0);
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
            s_relaxed, y, banded, thresh, pad, &mut s_bin, &mut conv_buf,
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

    // Final pass: compute full result at best threshold
    binarize(s_relaxed, best.threshold, &mut s_bin);
    banded.convolve_forward(&s_bin, &mut conv_buf);

    let (alpha, baseline) = lstsq_alpha_baseline(&conv_buf, y, pad);
    best.alpha = alpha;
    best.baseline = baseline;
    best.s_binary = s_bin.clone();

    // Compute PVE (proportion of variance explained)
    let inner_range = pad..n.saturating_sub(pad);
    let inner_len = inner_range.len();
    if inner_len > 0 {
        let y_mean: f64 =
            inner_range.clone().map(|i| y[i] as f64).sum::<f64>() / inner_len as f64;

        let ss_tot: f64 = inner_range
            .clone()
            .map(|i| {
                let d = y[i] as f64 - y_mean;
                d * d
            })
            .sum();

        let ss_res: f64 = inner_range
            .map(|i| {
                let pred = alpha * conv_buf[i] as f64 + baseline;
                let d = y[i] as f64 - pred;
                d * d
            })
            .sum();

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
    for (i, &v) in s.iter().enumerate() {
        s_bin[i] = if v >= thresh { 1.0 } else { 0.0 };
    }
}

/// Evaluate a single threshold: binarize → convolve → lstsq → error.
fn evaluate_threshold(
    s_relaxed: &[f32],
    y: &[f32],
    banded: &BandedAR2,
    threshold: f64,
    pad: usize,
    s_bin: &mut [f32],
    conv_buf: &mut [f32],
) -> f64 {
    binarize(s_relaxed, threshold, s_bin);
    banded.convolve_forward(s_bin, conv_buf);

    let (alpha, baseline) = lstsq_alpha_baseline(conv_buf, y, pad);

    // Error over the interior (excluding boundary padding)
    let n = y.len();
    let mut err = 0.0_f64;
    for i in pad..n.saturating_sub(pad) {
        let pred = alpha * conv_buf[i] as f64 + baseline;
        let d = y[i] as f64 - pred;
        err += d * d;
    }
    err
}

/// Least-squares fit for alpha and baseline: y ≈ alpha * conv + baseline.
/// Solves the 2x2 normal equations over the inner region [pad..n-pad].
/// Alpha is constrained non-negative (spikes add signal, never subtract).
fn lstsq_alpha_baseline(conv: &[f32], y: &[f32], pad: usize) -> (f64, f64) {
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

    // Constrain alpha >= 0
    if alpha < 0.0 {
        return (0.0, sum_y / count);
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

        let result = threshold_search(&s_true, &y, &banded, 0.4, 30.0);

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

        let result = threshold_search(&s_true, &y, &banded, 0.4, 30.0);

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

        let result = threshold_search(&s_relaxed, &y, &banded, 0.4, 30.0);
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

        let result = threshold_search(&s_relaxed, &y, &banded, 0.4, 30.0);
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

        let result = threshold_search(&s_relaxed, &y, &banded, 0.4, 30.0);
        assert_eq!(result.s_binary.iter().sum::<f32>(), 0.0);
    }

    #[test]
    fn boundary_padding_values() {
        assert_eq!(boundary_padding(0.4, 30.0), 24);
        assert_eq!(boundary_padding(0.2, 100.0), 40);
        assert_eq!(boundary_padding(1.0, 10.0), 20);
    }
}
