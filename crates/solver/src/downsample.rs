//! Bin-average downsampling, used by the simulator to bring its
//! high-resolution fluorescence down to the recording rate. (The InDeCa
//! pipeline does not resample: it runs at the recorded rate throughout.)

/// Downsample a continuous signal by bin-averaging: each output sample
/// is the mean of `factor` consecutive input samples.
///
/// Output length = input_length / factor (truncated).
/// At factor=1, returns a copy of the input.
pub fn downsample_average(signal: &[f32], factor: usize) -> Vec<f32> {
    if factor <= 1 {
        return signal.to_vec();
    }
    let inv = 1.0 / factor as f32;
    signal
        .chunks_exact(factor)
        .map(|chunk| chunk.iter().sum::<f32>() * inv)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_at_factor_1() {
        let trace = vec![1.0, 2.0, 3.0, 4.0];
        assert_eq!(downsample_average(&trace, 1), trace);
    }

    #[test]
    fn bin_average_of_consecutive_samples() {
        let signal = vec![1.0, 3.0, 5.0, 7.0, 9.0, 11.0, 100.0];
        // Truncated to whole bins: [1,3], [5,7], [9,11].
        assert_eq!(downsample_average(&signal, 2), vec![2.0, 6.0, 10.0]);
    }

    #[test]
    fn empty_input() {
        assert_eq!(downsample_average(&[], 5), Vec::<f32>::new());
    }
}
