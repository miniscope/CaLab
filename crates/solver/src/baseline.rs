/// Rolling-percentile baseline estimation and subtraction.
///
/// Calcium signals are positive-going transients on top of a slowly varying
/// fluorescence baseline. The HP filter zeros the *mean*, not the *floor*,
/// pushing the baseline negative and causing spurious spikes. A rolling low
/// percentile (default q=0.2) tracks the floor of the signal, bringing the
/// baseline to ~0 while preserving transients.
///
/// Algorithm matches InDeCa's `compute_dff`: causal window of length
/// `5 * ceil(5 * tau_d * fs)`, 20th percentile via partial sort.

/// Compute the rolling-baseline window size in samples.
///
/// `5 * kernel_length` where `kernel_length = ceil(5 * tau_d * fs)`,
/// matching InDeCa's convention.
pub fn baseline_window(tau_d: f64, fs: f64) -> usize {
    let kernel_len = (5.0 * tau_d * fs).ceil() as usize;
    5 * kernel_len.max(1)
}

/// Subtract a rolling-percentile baseline from `trace` in place.
///
/// For each position `t`, the baseline is the `quantile`-th value of
/// `trace[max(0, t-window+1)..=t]` (causal window, min_periods=1 at edges).
/// O(n * w) via partial sort — fast enough for one-time preprocessing.
pub fn subtract_rolling_baseline(trace: &mut [f32], window: usize, quantile: f64) {
    let n = trace.len();
    if n == 0 || window == 0 {
        return;
    }

    // Pre-compute all baseline values before modifying the trace.
    let mut baselines = Vec::with_capacity(n);
    let mut buf = Vec::with_capacity(window);

    for t in 0..n {
        let start = t.saturating_sub(window - 1);
        buf.clear();
        buf.extend_from_slice(&trace[start..=t]);
        let k = ((buf.len() as f64 - 1.0) * quantile).round() as usize;
        let k = k.min(buf.len() - 1);
        // Partial sort: move the k-th smallest element to position k.
        buf.select_nth_unstable_by(k, |a, b| a.partial_cmp(b).unwrap());
        baselines.push(buf[k]);
    }

    for (v, &b) in trace.iter_mut().zip(baselines.iter()) {
        *v -= b;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_size_computation() {
        // tau_d=0.4, fs=30 → kernel_len = ceil(5*0.4*30) = ceil(60) = 60 → window = 300
        assert_eq!(baseline_window(0.4, 30.0), 300);
        // tau_d=0.2, fs=10 → kernel_len = ceil(5*0.2*10) = ceil(10) = 10 → window = 50
        assert_eq!(baseline_window(0.2, 10.0), 50);
        // tau_d=0.01, fs=1 → kernel_len = ceil(0.05) = 1 → window = 5
        assert_eq!(baseline_window(0.01, 1.0), 5);
    }

    #[test]
    fn constant_trace_goes_to_zero() {
        let mut trace = vec![5.0_f32; 100];
        subtract_rolling_baseline(&mut trace, 20, 0.2);
        for &v in &trace {
            assert!(v.abs() < 1e-6, "Expected ~0, got {}", v);
        }
    }

    #[test]
    fn positive_transients_preserved() {
        let mut trace = vec![0.0_f32; 200];
        // Add a transient
        for i in 50..70 {
            trace[i] = 10.0;
        }
        let original = trace.clone();
        subtract_rolling_baseline(&mut trace, 100, 0.2);

        // Baseline region should be ~0
        for &v in &trace[120..200] {
            assert!(v.abs() < 1e-6, "Baseline region not ~0: {}", v);
        }

        // Transient peak should still be positive and large
        let peak: f32 = trace[50..70].iter().copied().fold(0.0_f32, f32::max);
        assert!(
            peak > original[55] * 0.5,
            "Transient too suppressed: peak={}, original={}",
            peak,
            original[55]
        );
    }

    #[test]
    fn empty_trace_noop() {
        let mut trace: Vec<f32> = vec![];
        subtract_rolling_baseline(&mut trace, 10, 0.2);
        assert!(trace.is_empty());
    }

    #[test]
    fn zero_window_noop() {
        let mut trace = vec![5.0_f32; 10];
        subtract_rolling_baseline(&mut trace, 0, 0.2);
        for &v in &trace {
            assert!((v - 5.0).abs() < 1e-6);
        }
    }

    #[test]
    fn rising_baseline_tracked() {
        // Linearly increasing baseline — the rolling percentile should track it
        let n = 500;
        let mut trace: Vec<f32> = (0..n).map(|i| i as f32 * 0.1).collect();
        subtract_rolling_baseline(&mut trace, 50, 0.2);

        // After the window fills, the baseline should be approximately zero
        // (the 20th percentile of a local window tracks the lower portion)
        let late = &trace[100..];
        let mean: f32 = late.iter().sum::<f32>() / late.len() as f32;
        // The residual after subtracting the 20th percentile of a linear ramp
        // should be positive (since the floor is below the mean) but bounded
        assert!(mean > 0.0, "Mean should be positive, got {}", mean);
        assert!(mean < 10.0, "Mean should be bounded, got {}", mean);
    }
}
