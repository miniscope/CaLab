//! Spatial correlation of the noise, and what it does to the slow loop's
//! noise nulls.
//!
//! The slow loop measures χ² in whitened units (per-pixel σ) and calibrates
//! its tests against what a column of pure noise would buy: 0.5 per frame
//! for a non-negative coefficient, with variance 1.25 per frame, and a trace
//! noise of `1 / sqrt(hᵀ Σ⁻¹ h)`. Both assume the noise is independent from
//! pixel to pixel. Motion correction breaks that. Every sub-pixel shift
//! resamples the frame, and an interpolating kernel averages neighbouring
//! pixels: per-pixel noise variance falls (by ~40 % at a half-pixel shift
//! with bicubic weights) while the noise at cell scale does not, because the
//! kernel's weights sum to one. Measured on the minisim recordings, the
//! frame-to-frame difference has a lag-1 correlation of 0.16 along both
//! axes with motion correction and 0.00 without, and its per-pixel variance
//! is 0.58 of the uncorrected one; with the simulator's true shifts
//! applied instead of the estimated ones it is the same. Projected on a
//! cell-sized column, that noise is about 1.7 times what the whitened model
//! assumes, so every test against the white-noise null is loose by that
//! factor: residual noise blobs pass as cells (the motion recordings kept
//! adding compact false cells next to real ones, with or without
//! registration error).
//!
//! [`NoiseCorr`] measures the correlation of the whitened frame-to-frame
//! difference at every lag within two pixels (the frame difference removes
//! static structure; transients are rare and spatially sparse) and turns it
//! into the variance inflation `ρ = Σ_l K(l) g(l)` of a cell-scale column,
//! with `g` the autocorrelation of a Gaussian of a quarter cell diameter.
//! `ρ` is never taken below 1: white noise (no motion correction) leaves
//! every test exactly as it was.

use crate::preprocess::Dims;

/// Half-plane lags `(dy, dx)` within two pixels; with `(0, 0)` and their
/// mirror images they cover the 5 x 5 window.
const LAGS: [(usize, isize); 12] = [
    (0, 1),
    (0, 2),
    (1, -2),
    (1, -1),
    (1, 0),
    (1, 1),
    (1, 2),
    (2, -2),
    (2, -1),
    (2, 0),
    (2, 1),
    (2, 2),
];

/// Streaming estimate of the noise correlation at short lags.
#[derive(Debug, Clone)]
pub(crate) struct NoiseCorr {
    prev: Vec<f32>,
    has_prev: bool,
    /// Running mean of the per-frame correlation at each lag.
    k: [f64; 12],
    frames: f64,
    /// Time constant of the running mean (frames).
    tau: f64,
    /// Every `row_step`-th row is sampled.
    row_step: usize,
}

impl NoiseCorr {
    pub fn new(n_px: usize) -> NoiseCorr {
        NoiseCorr {
            prev: vec![0.0; n_px],
            has_prev: false,
            k: [0.0; 12],
            frames: 0.0,
            tau: 1000.0,
            row_step: 4,
        }
    }

    /// Account for one whitened frame `z` (0 outside the FOV / at NaN).
    pub fn push(&mut self, z: &[f32], fov: &[u8], dims: Dims) -> u64 {
        let (h, w) = (dims.height, dims.width);
        if !self.has_prev || h < 5 || w < 5 {
            self.prev.copy_from_slice(z);
            self.has_prev = true;
            return z.len() as u64;
        }
        let mut s0 = 0.0f64;
        let mut s = [0.0f64; 12];
        let mut work = 0u64;
        for y in (0..h - 2).step_by(self.row_step) {
            for x in 2..w - 2 {
                let p = y * w + x;
                if fov[p] == 0 {
                    continue;
                }
                let d0 = z[p] - self.prev[p];
                s0 += f64::from(d0 * d0);
                for (l, &(dy, dx)) in LAGS.iter().enumerate() {
                    let q = (p as isize + (dy * w) as isize + dx) as usize;
                    if fov[q] != 0 {
                        s[l] += f64::from(d0 * (z[q] - self.prev[q]));
                    }
                }
            }
            work += (13 * w) as u64;
        }
        self.prev.copy_from_slice(z);
        if s0 <= 0.0 {
            return work;
        }
        self.frames += 1.0;
        let a = 1.0 / self.frames.min(self.tau);
        for (k, v) in self.k.iter_mut().zip(s) {
            *k += a * (v / s0 - *k);
        }
        work + z.len() as u64
    }

    /// Variance inflation of a cell-scale column (at least 1).
    pub fn rho(&self, cell_diameter_px: f32) -> f32 {
        if self.frames < 20.0 {
            return 1.0;
        }
        let sc = (0.25 * cell_diameter_px).max(1.0) as f64;
        let mut r = 1.0f64;
        for (&k, &(dy, dx)) in self.k.iter().zip(&LAGS) {
            let d2 = (dy * dy) as f64 + (dx * dx) as f64;
            r += 2.0 * k * (-d2 / (4.0 * sc * sc)).exp();
        }
        r.max(1.0) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(n: usize, seed: &mut u64) -> Vec<f32> {
        (0..n)
            .map(|_| {
                // Sum of uniforms: close enough to Gaussian here.
                (0..4)
                    .map(|_| {
                        *seed ^= *seed << 13;
                        *seed ^= *seed >> 7;
                        *seed ^= *seed << 17;
                        (*seed >> 11) as f32 / (1u64 << 53) as f32 - 0.5
                    })
                    .sum::<f32>()
            })
            .collect()
    }

    #[test]
    fn white_noise_gives_one_and_smoothed_noise_more() {
        let dims = Dims::new(64, 48).unwrap();
        let fov = vec![1u8; dims.pixels()];
        let mut white = NoiseCorr::new(dims.pixels());
        let mut smooth = NoiseCorr::new(dims.pixels());
        let mut seed = 0x1234_5678_9abc_def1u64;
        let mut s = vec![0.0f32; dims.pixels()];
        for _ in 0..200 {
            let n = noise(dims.pixels(), &mut seed);
            white.push(&n, &fov, dims);
            // Half-pixel shift along both axes, bilinear: a 2 x 2 average.
            for y in 0..dims.height {
                for x in 0..dims.width {
                    let (y1, x1) = ((y + 1).min(dims.height - 1), (x + 1).min(dims.width - 1));
                    let w = dims.width;
                    s[y * w + x] =
                        0.25 * (n[y * w + x] + n[y * w + x1] + n[y1 * w + x] + n[y1 * w + x1]);
                }
            }
            smooth.push(&s, &fov, dims);
        }
        assert!((white.rho(12.0) - 1.0).abs() < 0.05, "{}", white.rho(12.0));
        // A 2 x 2 box: per-pixel variance 1/4 of the cell-scale one; the
        // Gaussian weighting at a quarter diameter (3 px) keeps most of it.
        let r = smooth.rho(12.0);
        assert!(r > 3.3 && r < 4.0, "{r}");
    }
}
