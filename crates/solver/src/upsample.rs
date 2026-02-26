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
