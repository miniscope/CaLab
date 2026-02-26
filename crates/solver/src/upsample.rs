/// Upsampling and downsampling utilities for InDeCa spike inference.
///
/// Upsampling uses linear interpolation to increase temporal resolution,
/// allowing sub-frame spike detection. Downsampling bin-sums the upsampled
/// binary spike train back to the original frame rate.

/// Compute the upsample factor: round(target_fs / fs), minimum 1.
pub fn compute_upsample_factor(fs: f64, target_fs: f64) -> usize {
    (target_fs / fs).round().max(1.0) as usize
}

/// Linearly-interpolated upsampling: insert (factor - 1) interpolated values
/// between each pair of samples.
///
/// Output length = input_length * factor.
/// At factor=1, returns a copy of the input.
pub fn upsample_trace(trace: &[f32], factor: usize) -> Vec<f32> {
    if factor <= 1 {
        return trace.to_vec();
    }
    let n = trace.len();
    if n == 0 {
        return Vec::new();
    }
    let out_len = n * factor;
    let mut out = vec![0.0_f32; out_len];
    for i in 0..n {
        out[i * factor] = trace[i];
        if i + 1 < n {
            let v0 = trace[i];
            let v1 = trace[i + 1];
            for j in 1..factor {
                let frac = j as f32 / factor as f32;
                out[i * factor + j] = v0 + (v1 - v0) * frac;
            }
        } else {
            // Last sample: hold value for remaining positions
            for j in 1..factor {
                out[i * factor + j] = trace[i];
            }
        }
    }
    out
}

/// Upsample spike counts to a binary trace at the upsampled rate.
///
/// For each original bin with count C, places min(C, factor) ones spread
/// across the corresponding upsampled bins. Conserves total spike count.
/// Output length = counts.len() * factor.
pub fn upsample_counts_to_binary(counts: &[f32], factor: usize) -> Vec<f32> {
    if factor <= 1 {
        // At factor 1, binarize in-place: any count > 0.5 becomes 1
        return counts.iter().map(|&v| if v > 0.5 { 1.0 } else { 0.0 }).collect();
    }
    let n = counts.len();
    let mut out = vec![0.0_f32; n * factor];
    for i in 0..n {
        let c = (counts[i].round() as usize).min(factor);
        for j in 0..c {
            out[i * factor + j] = 1.0;
        }
    }
    out
}

/// Downsample a binary spike signal by bin-summing: each output sample
/// is the sum of `factor` consecutive input samples.
///
/// Output length = input_length / factor (truncated).
/// At factor=1, returns a copy of the input.
pub fn downsample_binary(s_bin: &[f32], factor: usize) -> Vec<f32> {
    if factor <= 1 {
        return s_bin.to_vec();
    }
    let out_len = s_bin.len() / factor;
    let mut out = vec![0.0_f32; out_len];
    for i in 0..out_len {
        let mut sum = 0.0_f32;
        for j in 0..factor {
            sum += s_bin[i * factor + j];
        }
        out[i] = sum;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_at_factor_1() {
        let trace = vec![1.0, 2.0, 3.0, 4.0];
        assert_eq!(upsample_trace(&trace, 1), trace);
        assert_eq!(downsample_binary(&trace, 1), trace);
    }

    #[test]
    fn linear_interpolation_pattern() {
        let trace = vec![0.0, 3.0, 6.0];
        let up = upsample_trace(&trace, 3);
        assert_eq!(up.len(), 9);
        // Between 0.0 and 3.0: 0, 1, 2
        // Between 3.0 and 6.0: 3, 4, 5
        // After 6.0 (hold): 6, 6, 6
        let expected = vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 6.0, 6.0];
        for (i, (&a, &b)) in up.iter().zip(expected.iter()).enumerate() {
            assert!(
                (a - b).abs() < 1e-6,
                "Mismatch at {}: got {} expected {}",
                i,
                a,
                b
            );
        }
    }

    #[test]
    fn original_samples_preserved() {
        let trace = vec![1.0, 5.0, 2.0, 8.0];
        let factor = 4;
        let up = upsample_trace(&trace, factor);
        assert_eq!(up.len(), 16);
        // Original sample positions (0, 4, 8, 12) should have exact values
        assert!((up[0] - 1.0).abs() < 1e-6);
        assert!((up[4] - 5.0).abs() < 1e-6);
        assert!((up[8] - 2.0).abs() < 1e-6);
        assert!((up[12] - 8.0).abs() < 1e-6);
    }

    #[test]
    fn monotone_interpolation() {
        // Linearly increasing trace should produce linearly increasing upsampled trace
        let trace = vec![0.0, 10.0];
        let up = upsample_trace(&trace, 5);
        assert_eq!(up.len(), 10);
        for i in 0..5 {
            let expected = i as f32 * 2.0;
            assert!(
                (up[i] - expected).abs() < 1e-5,
                "At {}: got {} expected {}",
                i,
                up[i],
                expected
            );
        }
        // After last original sample: hold at 10.0
        for i in 5..10 {
            assert!(
                (up[i] - 10.0).abs() < 1e-5,
                "Hold region at {}: got {} expected 10.0",
                i,
                up[i]
            );
        }
    }

    #[test]
    fn bin_sum_downsample() {
        // Simulate a binary signal at 3x: some 1s within each bin
        let s_bin = vec![1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0];
        let down = downsample_binary(&s_bin, 3);
        assert_eq!(down.len(), 3);
        assert!((down[0] - 2.0).abs() < 1e-6);
        assert!((down[1] - 0.0).abs() < 1e-6);
        assert!((down[2] - 3.0).abs() < 1e-6);
    }

    #[test]
    fn factor_computation() {
        assert_eq!(compute_upsample_factor(30.0, 300.0), 10);
        assert_eq!(compute_upsample_factor(30.0, 30.0), 1);
        assert_eq!(compute_upsample_factor(30.0, 15.0), 1); // min 1
        assert_eq!(compute_upsample_factor(20.0, 300.0), 15);
        assert_eq!(compute_upsample_factor(30.0, 100.0), 3); // round(3.33) = 3
    }

    #[test]
    fn empty_input() {
        assert_eq!(upsample_trace(&[], 5), Vec::<f32>::new());
        assert_eq!(downsample_binary(&[], 5), Vec::<f32>::new());
    }

    #[test]
    fn counts_to_binary_conserves_spikes() {
        let counts = vec![2.0, 0.0, 1.0, 3.0];
        let bin = upsample_counts_to_binary(&counts, 4);
        assert_eq!(bin.len(), 16);
        // Total spikes preserved
        let total: f32 = bin.iter().sum();
        assert!((total - 6.0).abs() < 1e-6, "Total spikes: {}", total);
        // All values are 0 or 1
        for &v in &bin {
            assert!(v == 0.0 || v == 1.0, "Non-binary value: {}", v);
        }
        // Bin 0: 2 spikes → positions 0,1
        assert_eq!(bin[0], 1.0);
        assert_eq!(bin[1], 1.0);
        assert_eq!(bin[2], 0.0);
        // Bin 1: 0 spikes
        assert_eq!(bin[4], 0.0);
        // Bin 2: 1 spike → position 8
        assert_eq!(bin[8], 1.0);
        assert_eq!(bin[9], 0.0);
    }

    #[test]
    fn counts_to_binary_caps_at_factor() {
        // Count exceeds factor — should cap
        let counts = vec![10.0];
        let bin = upsample_counts_to_binary(&counts, 3);
        assert_eq!(bin.len(), 3);
        let total: f32 = bin.iter().sum();
        assert!((total - 3.0).abs() < 1e-6);
    }

    #[test]
    fn counts_to_binary_factor_1() {
        let counts = vec![0.0, 1.0, 2.0, 0.0];
        let bin = upsample_counts_to_binary(&counts, 1);
        assert_eq!(bin, vec![0.0, 1.0, 1.0, 0.0]);
    }

    #[test]
    fn counts_to_binary_roundtrip() {
        // Roundtrip: upsample_counts_to_binary → downsample_binary should recover counts
        let counts = vec![1.0, 0.0, 2.0, 1.0, 0.0];
        let factor = 5;
        let binary = upsample_counts_to_binary(&counts, factor);
        let recovered = downsample_binary(&binary, factor);
        assert_eq!(recovered.len(), counts.len());
        for (i, (&c, &r)) in counts.iter().zip(recovered.iter()).enumerate() {
            assert!((c - r).abs() < 1e-6, "Mismatch at {}: {} vs {}", i, c, r);
        }
    }

    #[test]
    fn single_sample() {
        let trace = vec![3.0];
        let up = upsample_trace(&trace, 4);
        assert_eq!(up.len(), 4);
        // Single sample should hold value
        for &v in &up {
            assert!((v - 3.0).abs() < 1e-6);
        }
    }
}
