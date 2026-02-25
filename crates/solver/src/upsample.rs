/// Upsampling and downsampling utilities for InDeCa spike inference.
///
/// Upsampling zero-inserts between samples to increase temporal resolution,
/// allowing sub-frame spike detection. Downsampling bin-sums the upsampled
/// binary spike train back to the original frame rate.

/// Compute the upsample factor: round(target_fs / fs), minimum 1.
pub fn compute_upsample_factor(fs: f64, target_fs: f64) -> usize {
    (target_fs / fs).round().max(1.0) as usize
}

/// Zero-insert upsampling: insert (factor - 1) zeros between each sample.
///
/// Output length = input_length * factor.
/// At factor=1, returns a copy of the input.
pub fn upsample_trace(trace: &[f32], factor: usize) -> Vec<f32> {
    if factor <= 1 {
        return trace.to_vec();
    }
    let out_len = trace.len() * factor;
    let mut out = vec![0.0_f32; out_len];
    for (i, &v) in trace.iter().enumerate() {
        out[i * factor] = v;
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
    fn zero_insertion_pattern() {
        let trace = vec![1.0, 2.0, 3.0];
        let up = upsample_trace(&trace, 3);
        assert_eq!(up.len(), 9);
        assert_eq!(up, vec![1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 3.0, 0.0, 0.0]);
    }

    #[test]
    fn round_trip_sum_preservation() {
        let trace = vec![1.0, 2.0, 3.0, 4.0];
        let factor = 5;
        let up = upsample_trace(&trace, factor);
        let down = downsample_binary(&up, factor);
        assert_eq!(down.len(), trace.len());
        for (i, (&d, &t)) in down.iter().zip(trace.iter()).enumerate() {
            assert!(
                (d - t).abs() < 1e-6,
                "Mismatch at {}: {} vs {}",
                i,
                d,
                t
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
}
