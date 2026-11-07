//! Warm-up statistics: the per-pixel temporal mean and variance of the first
//! frames, from which the frozen calibration (FOV mask, hot-pixel map) is
//! estimated.
//!
//! Sums are kept in `f64`, so a long warm-up of 8- or 16-bit frames loses no
//! precision. A non-finite sample (only possible for `f32` input) counts as 0.
//!
//! How many frames: the hot-pixel test compares the mean image to its local
//! median, so the mean must be quiet compared with the hot-pixel excess. With
//! temporal noise σ_t ≈ 3 grey levels, N = 200 frames leaves σ_t/√N ≈ 0.2 in
//! the mean, small against the ~10-level excess of the faintest real hot
//! pixels and against the ~2-level spatial texture of the tissue, which is the
//! actual noise floor of the test. 200 frames is 10 s at 20 fps.

use super::{Dims, PreprocessError, RawPixel};

/// Default warm-up length in frames (see the module docs).
pub const DEFAULT_WARMUP_FRAMES: usize = 200;

/// Running per-pixel sums over the warm-up frames.
#[derive(Debug, Clone)]
pub struct WarmupAccumulator {
    dims: Dims,
    sum: Vec<f64>,
    sumsq: Vec<f64>,
    count: u64,
}

impl WarmupAccumulator {
    pub fn new(dims: Dims) -> WarmupAccumulator {
        WarmupAccumulator {
            dims,
            sum: vec![0.0; dims.pixels()],
            sumsq: vec![0.0; dims.pixels()],
            count: 0,
        }
    }

    pub fn dims(&self) -> Dims {
        self.dims
    }

    /// Frames accumulated so far.
    pub fn count(&self) -> u64 {
        self.count
    }

    /// Add one frame (row-major, `width * height` samples).
    pub fn push<T: RawPixel>(&mut self, frame: &[T]) -> Result<(), PreprocessError> {
        self.dims.check("warm-up frame", frame.len())?;
        for ((s, q), &p) in self.sum.iter_mut().zip(self.sumsq.iter_mut()).zip(frame) {
            let v = p.to_f32();
            let v = if v.is_finite() { f64::from(v) } else { 0.0 };
            *s += v;
            *q += v * v;
        }
        self.count += 1;
        Ok(())
    }

    /// Per-pixel temporal mean.
    pub fn mean(&self) -> Result<Vec<f32>, PreprocessError> {
        let n = self.nonzero_count()?;
        Ok(self.sum.iter().map(|&s| (s / n) as f32).collect())
    }

    /// Per-pixel temporal variance (population, ≥ 0).
    pub fn variance(&self) -> Result<Vec<f32>, PreprocessError> {
        let n = self.nonzero_count()?;
        Ok(self
            .sum
            .iter()
            .zip(&self.sumsq)
            .map(|(&s, &q)| {
                let m = s / n;
                ((q / n - m * m).max(0.0)) as f32
            })
            .collect())
    }

    fn nonzero_count(&self) -> Result<f64, PreprocessError> {
        if self.count == 0 {
            Err(PreprocessError::NotReady(
                "no warm-up frames have been pushed".into(),
            ))
        } else {
            Ok(self.count as f64)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mean_and_variance() {
        let dims = Dims::new(2, 1).unwrap();
        let mut acc = WarmupAccumulator::new(dims);
        assert!(acc.mean().is_err());
        acc.push(&[1u8, 10]).unwrap();
        acc.push(&[3u8, 10]).unwrap();
        assert_eq!(acc.mean().unwrap(), vec![2.0, 10.0]);
        assert_eq!(acc.variance().unwrap(), vec![1.0, 0.0]);
        assert!(acc.push(&[1u8]).is_err());
        acc.push(&[f32::NAN, 10.0]).unwrap();
        assert!(acc.mean().unwrap().iter().all(|v| v.is_finite()));
    }
}
