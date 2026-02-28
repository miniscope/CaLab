/// Rolling-percentile baseline estimation and subtraction.
///
/// Calcium signals are positive-going transients on top of a slowly varying
/// fluorescence baseline. The HP filter zeros the *mean*, not the *floor*,
/// pushing the baseline negative and causing spurious spikes. A rolling low
/// percentile (default q=0.2) tracks the floor of the signal, bringing the
/// baseline to ~0 while preserving transients.
///
/// Uses a coordinate-compressed Fenwick tree (Binary Indexed Tree) for
/// O(N log M) sliding-window k-th element queries, where M = distinct values.

/// Compute the rolling-baseline window size in samples.
///
/// `5 * kernel_length` where `kernel_length = ceil(5 * tau_d * fs)`,
/// matching InDeCa's convention.
pub fn baseline_window(tau_d: f64, fs: f64) -> usize {
    let kernel_len = (5.0 * tau_d * fs).ceil() as usize;
    5 * kernel_len.max(1)
}

/// Wrapper for f32 that provides total ordering (NaN sorts last).
#[derive(Clone, Copy)]
struct OrderedF32(f32);

impl PartialEq for OrderedF32 {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}
impl Eq for OrderedF32 {}

impl PartialOrd for OrderedF32 {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for OrderedF32 {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

/// Fenwick tree (Binary Indexed Tree) supporting point updates and prefix sums.
/// Used for O(log M) k-th element queries via binary lifting.
struct FenwickTree {
    tree: Vec<i32>,
}

impl FenwickTree {
    fn new(size: usize) -> Self {
        FenwickTree {
            tree: vec![0; size + 1], // 1-indexed
        }
    }

    /// Add `delta` to position `i` (0-indexed).
    fn update(&mut self, mut i: usize, delta: i32) {
        i += 1; // convert to 1-indexed
        while i < self.tree.len() {
            self.tree[i] += delta;
            i += i & i.wrapping_neg(); // i += lowbit(i)
        }
    }

    /// Find the 0-indexed position of the k-th element (1-based k).
    /// Uses binary lifting: O(log M) time.
    fn kth(&self, mut k: i32) -> usize {
        let n = self.tree.len() - 1; // max 0-indexed position + 1
        let mut pos = 0;
        // Find highest power of 2 <= n
        let mut bit = 1;
        while bit <= n {
            bit <<= 1;
        }
        bit >>= 1;

        while bit > 0 {
            let next = pos + bit;
            if next <= n && self.tree[next] < k {
                k -= self.tree[next];
                pos = next;
            }
            bit >>= 1;
        }
        pos // 0-indexed coordinate
    }
}

/// Subtract a rolling-percentile baseline from `trace` in place.
///
/// For each position `t`, the baseline is the `quantile`-th value of
/// `trace[max(0, t-window+1)..=t]` (causal window, min_periods=1 at edges).
/// O(N log M) via coordinate-compressed Fenwick tree, where M = distinct values.
pub fn subtract_rolling_baseline(trace: &mut [f32], window: usize, quantile: f64) {
    let n = trace.len();
    if n == 0 || window == 0 {
        return;
    }

    // Coordinate compression: sort + dedup trace values, assign indices via binary search.
    let mut sorted_vals: Vec<OrderedF32> = trace.iter().map(|&v| OrderedF32(v)).collect();
    sorted_vals.sort_unstable();
    sorted_vals.dedup();
    let m = sorted_vals.len();

    // Map from value to compressed index via binary search.
    let compress = |v: f32| -> usize {
        sorted_vals
            .binary_search(&OrderedF32(v))
            .unwrap()
    };

    let mut fenwick = FenwickTree::new(m);
    let mut baselines = Vec::with_capacity(n);

    for t in 0..n {
        // Add the new element entering the window.
        let ci = compress(trace[t]);
        fenwick.update(ci, 1);

        // Remove the element leaving the window.
        if t >= window {
            let old_ci = compress(trace[t - window]);
            fenwick.update(old_ci, -1);
        }

        // Current window size.
        let win_size = (t + 1).min(window);
        // k-th index (0-based rank), matching the original: ((win_size - 1) * quantile).round()
        let k = ((win_size as f64 - 1.0) * quantile).round() as usize;
        let k = k.min(win_size - 1);

        // Find the (k+1)-th smallest element (Fenwick kth uses 1-based k).
        let coord = fenwick.kth((k + 1) as i32);
        baselines.push(sorted_vals[coord].0);
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

    /// Reference implementation (the old O(N*W) algorithm) for cross-validation.
    fn subtract_rolling_baseline_reference(trace: &mut [f32], window: usize, quantile: f64) {
        let n = trace.len();
        if n == 0 || window == 0 {
            return;
        }
        let mut baselines = Vec::with_capacity(n);
        let mut buf = Vec::with_capacity(window);
        for t in 0..n {
            let start = t.saturating_sub(window - 1);
            buf.clear();
            buf.extend_from_slice(&trace[start..=t]);
            let k = ((buf.len() as f64 - 1.0) * quantile).round() as usize;
            let k = k.min(buf.len() - 1);
            buf.select_nth_unstable_by(k, |a, b| a.partial_cmp(b).unwrap());
            baselines.push(buf[k]);
        }
        for (v, &b) in trace.iter_mut().zip(baselines.iter()) {
            *v -= b;
        }
    }

    /// Fenwick tree produces identical results to the reference partial-sort algorithm.
    #[test]
    fn fenwick_matches_reference_random() {
        // Deterministic pseudo-random sequence (simple LCG)
        let n = 2000;
        let window = 300;
        let quantile = 0.2;
        let mut rng_state = 42u64;
        let mut trace: Vec<f32> = (0..n)
            .map(|_| {
                rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
                ((rng_state >> 33) as f32) / (u32::MAX as f32 / 2.0) - 0.5
            })
            .collect();

        let mut trace_ref = trace.clone();
        subtract_rolling_baseline(&mut trace, window, quantile);
        subtract_rolling_baseline_reference(&mut trace_ref, window, quantile);

        for i in 0..n {
            assert!(
                (trace[i] - trace_ref[i]).abs() < 1e-6,
                "Mismatch at index {}: fenwick={} ref={} diff={}",
                i,
                trace[i],
                trace_ref[i],
                (trace[i] - trace_ref[i]).abs()
            );
        }
    }

    /// Cross-validate on a trace with repeated values (tests dedup handling).
    #[test]
    fn fenwick_matches_reference_repeated_values() {
        let mut trace = vec![1.0_f32; 100];
        // Insert some different values
        for i in (0..100).step_by(5) {
            trace[i] = 0.0;
        }
        for i in (3..100).step_by(7) {
            trace[i] = 2.0;
        }

        let mut trace_ref = trace.clone();
        subtract_rolling_baseline(&mut trace, 20, 0.2);
        subtract_rolling_baseline_reference(&mut trace_ref, 20, 0.2);

        for i in 0..trace.len() {
            assert!(
                (trace[i] - trace_ref[i]).abs() < 1e-6,
                "Mismatch at index {}: fenwick={} ref={}",
                i,
                trace[i],
                trace_ref[i]
            );
        }
    }
}
