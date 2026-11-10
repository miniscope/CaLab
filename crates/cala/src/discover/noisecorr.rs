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
//! static structure) and turns it into the variance inflation
//! `ρ = Σ_l (K(l) − K_4) g(l)` of a cell-scale column, with `g` the
//! autocorrelation of a Gaussian of a quarter cell diameter. `K_4`, the
//! correlation at 4 px (beyond any interpolation kernel), is the part of
//! the difference that is signal (neuropil, transients): it is about as
//! large at every short lag and is not noise. On the 15 min workshop
//! recording without motion correction the short lags alone summed to
//! `ρ` = 1.11 although no single lag exceeded 0.01; with the baseline that
//! is 1.0 again.
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
    pushes: usize,
    /// Running mean of the correlation at `BASE_LAG` px (along either axis).
    base: f64,
    d: Vec<f32>,
}

/// Lag (px) beyond the reach of any interpolation kernel: correlation there
/// is signal (neuropil, transients, light that changes across many pixels),
/// which is about as strong at the short lags and is not noise.
const BASE_LAG: usize = 4;

/// Lags (half plane) at 4 to 5.7 px whose mean correlation is the signal
/// baseline: several, so the baseline is not the noisiest term of `ρ`.
const BASE_LAGS: [(usize, isize); 10] = [
    (0, 4),
    (3, -4),
    (3, 4),
    (4, -4),
    (4, -2),
    (4, -1),
    (4, 0),
    (4, 1),
    (4, 2),
    (4, 4),
];

/// Every this-many-th row is sampled per frame: about 18 rows, every 8th
/// to every 32nd. `ρ` is a running mean over ~1000 frames, so on a 600 px
/// frame every 32nd row (it was every 8th) moves it by about its own
/// frame-to-frame jitter (mean |Δρ| 0.002 at ρ ≈ 1.5 on the motion sims)
/// for a quarter of the cost; small frames keep every 8th.
fn row_step(height: usize) -> usize {
    (height / 18).clamp(8, 32)
}

fn dot(a: &[f32], b: &[f32]) -> f64 {
    let mut acc = [0.0f32; 8];
    let (ca, ra) = a.as_chunks::<8>();
    let (cb, rb) = b.as_chunks::<8>();
    for (x, y) in ca.iter().zip(cb) {
        for k in 0..8 {
            acc[k] += x[k] * y[k];
        }
    }
    let tail: f32 = ra.iter().zip(rb).map(|(x, y)| x * y).sum();
    acc.iter().map(|&v| f64::from(v)).sum::<f64>() + f64::from(tail)
}

impl NoiseCorr {
    pub fn new(n_px: usize) -> NoiseCorr {
        NoiseCorr {
            prev: vec![0.0; n_px],
            has_prev: false,
            k: [0.0; 12],
            frames: 0.0,
            tau: 1000.0,
            pushes: 0,
            base: 0.0,
            d: Vec::new(),
        }
    }

    /// Account for one whitened frame `z` (0 outside the FOV / at NaN).
    /// Each frame samples every `row_step(h)`-th row, starting at a row that
    /// rotates from frame to frame, against the previous frame's same rows
    /// (only the rows the next frame needs are kept).
    pub fn push(&mut self, z: &[f32], fov: &[u8], dims: Dims) -> u64 {
        let (h, w) = (dims.height, dims.width);
        if h < 2 * BASE_LAG + 1 || w < 2 * BASE_LAG + 1 {
            return 0;
        }
        let step = row_step(h);
        let phase = self.pushes % step;
        let mut work = 0u64;
        let mut s0 = 0.0f64;
        let mut s = [0.0f64; 12];
        let mut sb = 0.0f64;
        if self.has_prev {
            let rows = BASE_LAG + 1;
            self.d.resize(rows * w, 0.0);
            for y in (phase..h - BASE_LAG).step_by(step) {
                // Masked differences of rows y .. y + BASE_LAG.
                for r in 0..rows {
                    let o = (y + r) * w;
                    for x in 0..w {
                        self.d[r * w + x] = if fov[o + x] != 0 {
                            z[o + x] - self.prev[o + x]
                        } else {
                            0.0
                        };
                    }
                }
                let (lo, hi) = (BASE_LAG, w - BASE_LAG);
                let d0 = &self.d[lo..hi];
                s0 += dot(d0, d0);
                for (l, &(dy, dx)) in LAGS.iter().enumerate() {
                    let a = (dy * w) as isize + lo as isize + dx;
                    let o = &self.d[a as usize..a as usize + (hi - lo)];
                    s[l] += dot(d0, o);
                }
                for &(dy, dx) in &BASE_LAGS {
                    let a = (dy * w) as isize + lo as isize + dx;
                    sb += dot(d0, &self.d[a as usize..a as usize + (hi - lo)])
                        / BASE_LAGS.len() as f64;
                }
                work += (rows * w + 23 * (hi - lo)) as u64;
            }
        }
        // Keep the rows the next frame compares.
        let next = (self.pushes + 1) % step;
        for y in (next..h).step_by(step) {
            let rows = y * w..((y + BASE_LAG + 1).min(h)) * w;
            work += rows.len() as u64;
            self.prev[rows.clone()].copy_from_slice(&z[rows]);
        }
        self.pushes += 1;
        self.has_prev = true;
        if s0 <= 0.0 {
            return work;
        }
        self.frames += 1.0;
        let a = 1.0 / self.frames.min(self.tau);
        for (k, v) in self.k.iter_mut().zip(s) {
            *k += a * (v / s0 - *k);
        }
        self.base += a * (sb / s0 - self.base);
        work
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
            r += 2.0 * (k - self.base) * (-d2 / (4.0 * sc * sc)).exp();
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
