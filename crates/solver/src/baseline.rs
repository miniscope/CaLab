/// Rolling-percentile baseline estimation and subtraction.
///
/// Calcium signals are positive-going transients on top of a slowly varying
/// fluorescence baseline. The HP filter zeros the *mean*, not the *floor*,
/// pushing the baseline negative and causing spurious spikes. A rolling low
/// percentile (default q=0.2) tracks the floor of the signal, bringing the
/// baseline to ~0 while preserving transients.
///
/// The sliding-window order statistic is computed exactly in O(N) by
/// [`RollingQuantile`] (dense ranks from a radix sort, a bitset over ranks for
/// the window, and a cursor that steps to neighbouring set bits).

/// Default rolling-baseline percentile (quantile of the causal window taken as
/// the floor estimate). Single source of truth for the callers that subtract a
/// rolling baseline (`Solver::subtract_baseline` and `indeca::solve_trace`), so
/// the two paths cannot drift; `subtract_rolling_baseline` still accepts any
/// quantile for callers that want to override it.
pub const DEFAULT_BASELINE_QUANTILE: f64 = 0.2;

/// Compute the rolling-baseline window size in samples.
///
/// `5 * kernel_length` where `kernel_length = ceil(5 * tau_d * fs)`,
/// matching InDeCa's convention.
pub fn baseline_window(tau_d: f64, fs: f64) -> usize {
    let kernel_len = (5.0 * tau_d * fs).ceil() as usize;
    5 * kernel_len.max(1)
}

/// Sortable integer key of an `f32` with the same order as `f32::total_cmp`
/// (negative NaN < -inf < ... < -0 < +0 < ... < +inf < positive NaN).
#[inline]
fn sortable_key(v: f32) -> u32 {
    let b = v.to_bits();
    if b & 0x8000_0000 != 0 {
        !b
    } else {
        b | 0x8000_0000
    }
}

/// Radix digits per pass of the key sort (3 passes of 11 bits).
const RADIX_BITS: u32 = 11;
const RADIX_BUCKETS: usize = 1 << RADIX_BITS;

/// Workspace for the sliding-window order statistic behind
/// [`subtract_rolling_baseline`]. Buffers grow but never shrink, so a caller
/// that scores many candidate traces of one length (the chain-consistent
/// threshold search) allocates once.
///
/// Algorithm: every sample gets a dense rank (its position in the stable
/// radix sort of all `n` values, ties broken by index, so the rank order is a
/// total order consistent with the values). The window is a bitset over
/// ranks; the quantile is a cursor on that bitset holding the invariant
/// "exactly `k` window ranks lie below the cursor". Each step sets one bit
/// (the entering sample), clears one (the leaving sample), adjusts the count
/// below the cursor with two comparisons, and moves the cursor to the next or
/// previous set bit when the count or `k` changed. The window covers a
/// fraction `w / n` of all ranks, so a move scans a word or two of the bitset.
/// This is O(n) per trace after the O(n) radix sort, against the O(n log n)
/// sort plus O(n log n) tree walks of a Fenwick/balanced-tree sliding
/// quantile, and it produces the identical multiset order statistic.
#[derive(Default)]
pub(crate) struct RollingQuantile {
    /// `(key, index)` pairs, sorted by key (stable) after the radix passes.
    pairs: Vec<u64>,
    scratch: Vec<u64>,
    /// `rank[t]`: position of sample `t` in the sorted order.
    rank: Vec<u32>,
    /// Sorted keys, by rank: the quantile value is `sorted_key[cursor]`.
    sorted_key: Vec<u32>,
    /// Window membership by rank.
    bits: Vec<u64>,
    hist: Vec<u32>,
    baselines: Vec<f32>,
}

impl RollingQuantile {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Stable sort of `(key, index)` by key; fills `rank` and `sorted_key`.
    fn sort_ranks(&mut self, trace: &[f32]) {
        let n = trace.len();
        self.pairs.clear();
        self.pairs.extend(
            trace
                .iter()
                .enumerate()
                .map(|(t, &v)| ((sortable_key(v) as u64) << 32) | t as u64),
        );
        self.scratch.resize(n, 0);
        self.hist.resize(RADIX_BUCKETS, 0);
        let mut shift = 32;
        while shift < 64 {
            let mask = (RADIX_BUCKETS - 1) as u64;
            self.hist.fill(0);
            for &p in &self.pairs {
                self.hist[((p >> shift) & mask) as usize] += 1;
            }
            let mut acc = 0u32;
            for h in self.hist.iter_mut() {
                let c = *h;
                *h = acc;
                acc += c;
            }
            for &p in &self.pairs {
                let b = ((p >> shift) & mask) as usize;
                self.scratch[self.hist[b] as usize] = p;
                self.hist[b] += 1;
            }
            std::mem::swap(&mut self.pairs, &mut self.scratch);
            shift += RADIX_BITS;
        }
        self.rank.resize(n, 0);
        self.sorted_key.resize(n, 0);
        for (r, &p) in self.pairs.iter().enumerate() {
            self.rank[(p & 0xFFFF_FFFF) as usize] = r as u32;
            self.sorted_key[r] = (p >> 32) as u32;
        }
    }

    #[inline]
    fn next_set_above(bits: &[u64], c: usize) -> Option<usize> {
        let (mut w, b) = (c / 64, c % 64);
        // Bits strictly above `b` in the cursor's word (none when b == 63).
        let mut word = if b == 63 {
            0
        } else {
            bits[w] & (u64::MAX << (b + 1))
        };
        loop {
            if word != 0 {
                return Some(w * 64 + word.trailing_zeros() as usize);
            }
            w += 1;
            if w >= bits.len() {
                return None;
            }
            word = bits[w];
        }
    }

    #[inline]
    fn prev_set_below(bits: &[u64], c: usize) -> Option<usize> {
        let (mut w, b) = (c / 64, c % 64);
        let mut word = if b == 0 {
            0
        } else {
            bits[w] & (u64::MAX >> (64 - b))
        };
        loop {
            if word != 0 {
                return Some(w * 64 + 63 - word.leading_zeros() as usize);
            }
            if w == 0 {
                return None;
            }
            w -= 1;
            word = bits[w];
        }
    }

    /// Subtract the causal rolling `quantile` over `window` samples from
    /// `trace` in place (see [`subtract_rolling_baseline`]).
    pub(crate) fn subtract(&mut self, trace: &mut [f32], window: usize, quantile: f64) {
        let n = trace.len();
        if n == 0 || window == 0 {
            return;
        }
        self.sort_ranks(trace);
        let words = n.div_ceil(64);
        self.bits.clear();
        self.bits.resize(words, 0);
        self.baselines.clear();
        self.baselines.reserve(n);

        let rank = &self.rank;
        let bits = &mut self.bits;
        // Cursor rank and the number of window ranks below it.
        let mut cursor = rank[0] as usize;
        let mut below = 0usize;
        bits[cursor / 64] |= 1 << (cursor % 64);
        self.baselines.push(trace[0]);
        for t in 1..n {
            let r = rank[t] as usize;
            bits[r / 64] |= 1 << (r % 64);
            below += (r < cursor) as usize;
            if t >= window {
                let r0 = rank[t - window] as usize;
                bits[r0 / 64] &= !(1 << (r0 % 64));
                if r0 < cursor {
                    below -= 1;
                } else if r0 == cursor {
                    // The quantile element left: step to its successor (same
                    // count below), or to its predecessor when it was the
                    // largest in the window.
                    match Self::next_set_above(bits, cursor) {
                        Some(c) => cursor = c,
                        None => {
                            cursor =
                                Self::prev_set_below(bits, cursor).expect("window is non-empty");
                            below -= 1;
                        }
                    }
                }
            }
            let win_size = (t + 1).min(window);
            let k = ((win_size as f64 - 1.0) * quantile).round() as usize;
            let k = k.min(win_size - 1);
            while below < k {
                cursor = Self::next_set_above(bits, cursor).expect("k below window size");
                below += 1;
            }
            while below > k {
                cursor = Self::prev_set_below(bits, cursor).expect("k is non-negative");
                below -= 1;
            }
            let key = self.sorted_key[cursor];
            let b = if key & 0x8000_0000 != 0 {
                key & 0x7FFF_FFFF
            } else {
                !key
            };
            self.baselines.push(f32::from_bits(b));
        }
        for (v, &b) in trace.iter_mut().zip(self.baselines.iter()) {
            *v -= b;
        }
    }
}

/// Subtract a rolling-percentile baseline from `trace` in place.
///
/// For each position `t`, the baseline is the `quantile`-th value of
/// `trace[max(0, t-window+1)..=t]` (causal window, min_periods=1 at edges):
/// the value at 0-based rank `round((win_size - 1) * quantile)` of the sorted
/// window. O(n) via [`RollingQuantile`].
pub fn subtract_rolling_baseline(trace: &mut [f32], window: usize, quantile: f64) {
    RollingQuantile::new().subtract(trace, window, quantile);
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

    /// The rank-bitset sliding quantile produces identical results to the reference partial-sort algorithm.
    #[test]
    fn matches_reference_random() {
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
                "Mismatch at index {}: fast={} ref={} diff={}",
                i,
                trace[i],
                trace_ref[i],
                (trace[i] - trace_ref[i]).abs()
            );
        }
    }

    /// Windows longer than the trace, of one sample, and a trace of one sample.
    #[test]
    fn matches_reference_edge_windows() {
        let mut rng_state = 7u64;
        let trace: Vec<f32> = (0..300)
            .map(|_| {
                rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
                ((rng_state >> 33) as f32) / (u32::MAX as f32 / 2.0) - 0.5
            })
            .collect();
        for (window, quantile) in [
            (1usize, 0.2),
            (2, 0.5),
            (301, 0.2),
            (1000, 0.9),
            (64, 0.0),
            (64, 1.0),
            (65, 0.2),
        ] {
            let mut fast = trace.clone();
            let mut reference = trace.clone();
            subtract_rolling_baseline(&mut fast, window, quantile);
            subtract_rolling_baseline_reference(&mut reference, window, quantile);
            assert_eq!(fast, reference, "window {window} quantile {quantile}");
        }
        let mut one = vec![3.5_f32];
        subtract_rolling_baseline(&mut one, 10, 0.2);
        assert_eq!(one, vec![0.0]);
    }

    /// A smooth, piecewise-monotone signal with long flat (tied) stretches and
    /// negative values: the structure the chain scorer feeds in.
    #[test]
    fn matches_reference_smooth_with_ties() {
        let n = 5000;
        let mut trace = vec![0.0_f32; n];
        for (i, v) in trace.iter_mut().enumerate() {
            let x = i as f32 / 50.0;
            *v = (x.sin() * 3.0).round() - 0.5 * (x / 7.0).cos();
        }
        for i in (0..n).step_by(321) {
            for j in i..(i + 40).min(n) {
                trace[j] = 2.0;
            }
        }
        let mut fast = trace.clone();
        let mut reference = trace.clone();
        subtract_rolling_baseline(&mut fast, 700, 0.2);
        subtract_rolling_baseline_reference(&mut reference, 700, 0.2);
        assert_eq!(fast, reference);
    }

    /// Cross-validate on a trace with repeated values (tests dedup handling).
    #[test]
    fn matches_reference_repeated_values() {
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
                "Mismatch at index {}: fast={} ref={}",
                i,
                trace[i],
                trace_ref[i]
            );
        }
    }
}
