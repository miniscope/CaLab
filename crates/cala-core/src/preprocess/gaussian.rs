//! Separable 2D Gaussian blur.
//!
//! Used inside motion correction to restore coarse blob-like structure
//! on post-high-pass frames so phase correlation has something with
//! sharp spectral peaks to lock onto. Also available as a standalone
//! primitive — callers supply their own scratch buffer so it's allocation-
//! free in the hot loop.
//!
//! Implementation: apply 1D Gaussian along rows into `scratch`, then
//! 1D Gaussian along columns into `output`. Boundary handling is
//! **replicate** (out-of-range samples clamp to the nearest valid index),
//! matching how the rest of the preprocess stages treat edges.
//!
//! The kernel is precomputed once in `GaussianKernel` and reused across
//! frames. Kernel size is auto-derived from sigma as `2·ceil(3·σ) + 1`
//! so the tails past ±3σ (which carry <0.27% of the weight) are dropped.

use crate::assets::{Frame, FrameMut, ShapeError};

/// Precomputed 1D Gaussian kernel, normalized to sum to 1.
#[derive(Debug, Clone)]
pub struct GaussianKernel {
    /// The kernel samples, length `2·radius + 1`, symmetric around index `radius`.
    kernel: Vec<f32>,
    /// Number of samples on each side of the center.
    radius: usize,
}

impl GaussianKernel {
    /// Build a Gaussian kernel with automatic size (`2·ceil(3·σ) + 1`).
    /// Panics if `sigma <= 0`.
    pub fn from_sigma(sigma: f32) -> Self {
        assert!(sigma > 0.0, "GaussianKernel::from_sigma requires sigma > 0");
        let radius = (3.0 * sigma).ceil() as usize;
        let ksize = 2 * radius + 1;
        let mut kernel = Vec::with_capacity(ksize);
        let two_s2 = 2.0 * sigma * sigma;
        let mut sum = 0.0_f32;
        for i in 0..ksize {
            let dx = (i as f32) - (radius as f32);
            let v = (-(dx * dx) / two_s2).exp();
            kernel.push(v);
            sum += v;
        }
        let inv = 1.0 / sum;
        for v in kernel.iter_mut() {
            *v *= inv;
        }
        Self { kernel, radius }
    }

    pub fn radius(&self) -> usize {
        self.radius
    }

    pub fn taps(&self) -> &[f32] {
        &self.kernel
    }
}

/// Separable 2D Gaussian blur from `input` into `output`.
///
/// `scratch` must have length `input.height() * input.width()` — it holds
/// the intermediate result of the row pass before the column pass writes
/// the final output. Returns `Err(ShapeError)` if any of the shape
/// invariants fail.
pub fn gaussian_blur(
    input: Frame<'_>,
    output: &mut FrameMut<'_>,
    scratch: &mut [f32],
    kernel: &GaussianKernel,
) -> Result<(), ShapeError> {
    let h = input.height();
    let w = input.width();
    let n = h * w;
    if output.height() != h || output.width() != w {
        return Err(ShapeError {
            expected: n,
            actual: output.pixels().len(),
        });
    }
    if scratch.len() != n {
        return Err(ShapeError {
            expected: n,
            actual: scratch.len(),
        });
    }

    let r = kernel.radius as isize;
    let taps = kernel.taps();
    let w_isize = w as isize;
    let h_isize = h as isize;

    // Row pass: scratch[y, x] = Σ_k taps[k+r] · input[y, clamp(x + k, 0, w-1)]
    for y in 0..h {
        let row_in = &input.pixels()[y * w..(y + 1) * w];
        let row_out = &mut scratch[y * w..(y + 1) * w];
        for x in 0..w {
            let mut acc = 0.0_f32;
            for (kidx, &tap) in taps.iter().enumerate() {
                let k = kidx as isize - r;
                let sx = (x as isize + k).clamp(0, w_isize - 1) as usize;
                acc += tap * row_in[sx];
            }
            row_out[x] = acc;
        }
    }

    // Column pass: output[y, x] = Σ_k taps[k+r] · scratch[clamp(y + k, 0, h-1), x]
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0_f32;
            for (kidx, &tap) in taps.iter().enumerate() {
                let k = kidx as isize - r;
                let sy = (y as isize + k).clamp(0, h_isize - 1) as usize;
                acc += tap * scratch[sy * w + x];
            }
            *output.get_mut(y, x) = acc;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_sums_to_one() {
        let k = GaussianKernel::from_sigma(1.5);
        let sum: f32 = k.taps().iter().sum();
        assert!((sum - 1.0).abs() < 1e-5, "sum = {sum}");
    }

    #[test]
    fn kernel_is_symmetric() {
        let k = GaussianKernel::from_sigma(2.0);
        let taps = k.taps();
        let n = taps.len();
        for i in 0..n / 2 {
            assert!((taps[i] - taps[n - 1 - i]).abs() < 1e-6);
        }
    }

    #[test]
    fn kernel_peaks_at_center() {
        let k = GaussianKernel::from_sigma(1.0);
        let taps = k.taps();
        let r = k.radius();
        for (i, &t) in taps.iter().enumerate() {
            if i != r {
                assert!(
                    t < taps[r],
                    "tap {i} = {t} not less than center {}",
                    taps[r]
                );
            }
        }
    }

    #[test]
    fn blur_of_constant_is_constant() {
        let (h, w) = (8, 12);
        let input = vec![7.25_f32; h * w];
        let mut output = vec![0.0_f32; h * w];
        let mut scratch = vec![0.0_f32; h * w];
        let k = GaussianKernel::from_sigma(2.0);
        gaussian_blur(
            Frame::new(&input, h, w).unwrap(),
            &mut FrameMut::new(&mut output, h, w).unwrap(),
            &mut scratch,
            &k,
        )
        .unwrap();
        for &v in &output {
            assert!((v - 7.25).abs() < 1e-4, "got {v}");
        }
    }

    #[test]
    fn blur_smooths_impulse_into_bell() {
        // Single bright pixel in the middle of an otherwise-zero image.
        // After blur, the bright mass should spread symmetrically and
        // peak magnitude should drop.
        let (h, w) = (11, 11);
        let mut input = vec![0.0_f32; h * w];
        input[5 * w + 5] = 1.0;
        let mut output = vec![0.0_f32; h * w];
        let mut scratch = vec![0.0_f32; h * w];
        let k = GaussianKernel::from_sigma(1.0);
        gaussian_blur(
            Frame::new(&input, h, w).unwrap(),
            &mut FrameMut::new(&mut output, h, w).unwrap(),
            &mut scratch,
            &k,
        )
        .unwrap();
        // Peak at the impulse location, smaller than the input's 1.0.
        let peak = output[5 * w + 5];
        assert!(peak > 0.0 && peak < 1.0, "peak = {peak}");
        // Symmetry: (5±1, 5) and (5, 5±1) all equal.
        let up = output[4 * w + 5];
        let dn = output[6 * w + 5];
        let lf = output[5 * w + 4];
        let rt = output[5 * w + 6];
        assert!((up - dn).abs() < 1e-6);
        assert!((lf - rt).abs() < 1e-6);
        assert!((up - lf).abs() < 1e-6);
        // Total mass is preserved (normalized kernel).
        let sum_in: f32 = input.iter().sum();
        let sum_out: f32 = output.iter().sum();
        assert!(
            (sum_in - sum_out).abs() < 1e-4,
            "mass drift: {sum_in} -> {sum_out}"
        );
    }

    #[test]
    fn blur_preserves_energy_of_constant_background_with_one_bright_pixel() {
        // Same setup as the impulse test but with a non-zero background.
        // Replicate boundary means edge pixels "see" the same background
        // pixel multiple times, so total mass is conserved exactly.
        let (h, w) = (9, 9);
        let mut input = vec![2.0_f32; h * w];
        input[4 * w + 4] += 10.0;
        let mut output = vec![0.0_f32; h * w];
        let mut scratch = vec![0.0_f32; h * w];
        let k = GaussianKernel::from_sigma(1.2);
        gaussian_blur(
            Frame::new(&input, h, w).unwrap(),
            &mut FrameMut::new(&mut output, h, w).unwrap(),
            &mut scratch,
            &k,
        )
        .unwrap();
        let sum_in: f32 = input.iter().sum();
        let sum_out: f32 = output.iter().sum();
        assert!((sum_in - sum_out).abs() < 1e-3, "{sum_in} vs {sum_out}");
    }

    #[test]
    fn blur_rejects_mismatched_shapes() {
        let (h, w) = (4, 4);
        let input = vec![0.0_f32; h * w];
        let mut output = vec![0.0_f32; h * w];
        let mut scratch = vec![0.0_f32; h * w - 1]; // wrong size
        let k = GaussianKernel::from_sigma(1.0);
        let err = gaussian_blur(
            Frame::new(&input, h, w).unwrap(),
            &mut FrameMut::new(&mut output, h, w).unwrap(),
            &mut scratch,
            &k,
        );
        assert!(err.is_err());
    }
}
