//! Windowed FFT cross-correlation with sub-pixel peak refinement.
//!
//! [`Correlator`] holds the plans, the window and the buffers for one image
//! size. [`Correlator::spectrum`] windows an image and transforms it;
//! [`Correlator::register`] cross-correlates a reference spectrum `T` with a
//! moving spectrum `F` and returns the shift `s` that registers the moving
//! image onto the reference, `moving(p - s) ~ reference(p)` (the convention
//! of `scipy.ndimage.shift` and `skimage.registration.phase_cross_correlation`).
//!
//! The correlation is plain cross-correlation, `IFFT(T conj(F))`, **not**
//! phase correlation. Normalising the cross-power spectrum to unit magnitude
//! weights every frequency equally, so on band-passed Miniscope frames the
//! noise-dominated bins swamp the few that carry the cell texture, and the peak
//! collapses to (0, 0) even for a known 3 px shift. The band-pass prefilter
//! already whitens what matters.
//!
//! # Window-overlap envelope
//!
//! With a fixed window, the expected correlation of a shifted texture is
//! its autocorrelation times the window's own autocorrelation `A(u)`, which
//! falls off with `|u|` and drags the peak towards zero. Every correlation
//! value (integer and upsampled) is divided by `A(u)`, computed from the
//! window's power spectrum, which removes that pull to first order.
//!
//! # Sub-pixel refinement
//!
//! The integer peak (restricted to `|s| <= max_shift`) is refined with the
//! matrix-multiply upsampled DFT of Guizar-Sicairos, Thurman & Fienup (Opt.
//! Lett. 33, 156, 2008): the correlation is evaluated exactly (it is band
//! limited, so this is not an interpolation) on a grid of spacing `1 / U`
//! spanning ±0.75 px around the integer peak, and a final parabola through the
//! best grid point and its neighbours removes most of the remaining `1 / U`
//! quantisation. The DFT sums only over frequencies the band-pass leaves
//! non-negligible ([`Correlator::set_band_limit`]), which cuts its cost
//! roughly in half. With `U <= 1` the cheaper fallback is used instead: a
//! parabola through the integer peak and its neighbours on each axis, which
//! is biased towards integers by up to a few hundredths of a pixel on smooth
//! peaks and more on sharp ones.

use std::f64::consts::PI;

use realfft::num_complex::Complex32;

use super::fft2d::{signed_freq, Fft2d};
use super::filter::tukey;
use super::MotionError;

/// Result of one registration.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Peak {
    /// Shift registering the moving image onto the reference (rows).
    pub dy: f32,
    /// Shift registering the moving image onto the reference (columns).
    pub dx: f32,
    /// Normalised cross-correlation at the peak, in `[-1, 1]` (0 when either
    /// image has no energy).
    pub ncc: f32,
}

/// FFT cross-correlation engine for one image size.
pub struct Correlator {
    h: usize,
    w: usize,
    fft: Fft2d,
    win_y: Vec<f32>,
    win_x: Vec<f32>,
    windowed: Vec<f32>,
    cross: Vec<Complex32>,
    work: Vec<Complex32>,
    surface: Vec<f32>,
    /// Vertical frequency bins summed by the upsampled DFT.
    k_active: Vec<usize>,
    /// Highest horizontal frequency bin summed by the upsampled DFT.
    l_max: usize,
    stage1: Vec<Complex32>,
    tw_y: Vec<Complex32>,
    tw_x: Vec<Complex32>,
    grid: Vec<f32>,
    /// Power spectra `|DFT(window)|^2` of the 1-D windows, for the overlap
    /// envelope.
    pow_y: Vec<f64>,
    pow_x: Vec<f64>,
    /// Normalised envelope at integer lags `0..h` / `0..w`.
    env_y: Vec<f32>,
    env_x: Vec<f32>,
    env_sy: Vec<f64>,
    env_sx: Vec<f64>,
}

/// `|DFT(w)|^2` of a 1-D window.
fn window_power(w: &[f32]) -> Vec<f64> {
    let n = w.len();
    (0..n)
        .map(|k| {
            let (mut re, mut im) = (0.0f64, 0.0f64);
            for (p, &v) in w.iter().enumerate() {
                let ph = -2.0 * PI * ((k * p) % n) as f64 / n as f64;
                re += v as f64 * ph.cos();
                im += v as f64 * ph.sin();
            }
            re * re + im * im
        })
        .collect()
}

/// Circular autocorrelation of a window at (fractional) lag `u`, from its
/// power spectrum, normalised to 1 at lag 0.
fn envelope(pow: &[f64], u: f64) -> f64 {
    let n = pow.len();
    let total: f64 = pow.iter().sum();
    if total <= 0.0 {
        return 1.0;
    }
    let v: f64 = pow
        .iter()
        .enumerate()
        .map(|(k, &p)| p * (2.0 * PI * signed_freq(k, n) as f64 * u / n as f64).cos())
        .sum();
    (v / total).max(1e-6)
}

impl Correlator {
    /// Correlator for `h x w` images with a Tukey window of taper `alpha`.
    pub fn new(h: usize, w: usize, alpha: f32) -> Result<Self, MotionError> {
        let fft = Fft2d::new(h, w)?;
        let n_spec = fft.spectrum_len();
        let l_max = w / 2;
        let win_y = tukey(h, alpha);
        let win_x = tukey(w, alpha);
        let pow_y = window_power(&win_y);
        let pow_x = window_power(&win_x);
        let env_y = (0..h).map(|d| envelope(&pow_y, d as f64) as f32).collect();
        let env_x = (0..w).map(|d| envelope(&pow_x, d as f64) as f32).collect();
        Ok(Correlator {
            h,
            w,
            win_y,
            win_x,
            pow_y,
            pow_x,
            env_y,
            env_x,
            env_sy: Vec::new(),
            env_sx: Vec::new(),
            windowed: vec![0.0; h * w],
            cross: vec![Complex32::default(); n_spec],
            work: vec![Complex32::default(); n_spec],
            surface: vec![0.0; h * w],
            k_active: (0..h).collect(),
            l_max,
            stage1: Vec::new(),
            tw_y: Vec::new(),
            tw_x: Vec::new(),
            grid: Vec::new(),
            fft,
        })
    }

    pub fn height(&self) -> usize {
        self.h
    }

    pub fn width(&self) -> usize {
        self.w
    }

    /// A zeroed spectrum buffer for [`spectrum`](Self::spectrum).
    pub fn make_spectrum(&self) -> Vec<Complex32> {
        self.fft.make_spectrum()
    }

    /// Restrict the upsampled DFT to frequencies (in cycles per pixel, per
    /// axis) at or below `f_max`. Only safe when the inputs carry nothing
    /// above it, e.g. after a low-pass whose gain there is negligible.
    pub fn set_band_limit(&mut self, f_max: f32) {
        let f = f_max.clamp(0.0, 0.5) as f64;
        self.k_active = (0..self.h)
            .filter(|&k| (signed_freq(k, self.h).unsigned_abs() as f64) <= f * self.h as f64 + 1e-9)
            .collect();
        self.l_max = ((f * self.w as f64).floor() as usize).min(self.w / 2);
    }

    /// Window `img` (`h * w`, row-major) and transform it into `spec`. Returns
    /// the windowed energy `sum((window * img)^2)`.
    pub fn spectrum(&mut self, img: &[f32], spec: &mut [Complex32]) -> Result<f64, MotionError> {
        if img.len() != self.h * self.w {
            return Err(MotionError::SizeMismatch(format!(
                "image has {} pixels, correlator expects {}",
                img.len(),
                self.h * self.w
            )));
        }
        let mut energy = 0.0f64;
        for y in 0..self.h {
            let wy = self.win_y[y];
            let src = &img[y * self.w..][..self.w];
            let dst = &mut self.windowed[y * self.w..][..self.w];
            let mut row_e = 0.0f32;
            for ((d, &s), &wx) in dst.iter_mut().zip(src).zip(&self.win_x) {
                let v = s * wy * wx;
                *d = v;
                row_e += v * v;
            }
            energy += row_e as f64;
        }
        self.fft.forward(&self.windowed, spec)?;
        Ok(energy)
    }

    /// Register a moving spectrum `mov` (energy `e_mov`) onto a reference
    /// spectrum `reference` (energy `e_ref`), searching integer shifts with
    /// `|dy|, |dx| <= max_shift`, then refining with an upsampled DFT of
    /// factor `upsample` (`<= 1` selects the parabolic fallback).
    pub fn register(
        &mut self,
        reference: &[Complex32],
        e_ref: f64,
        mov: &[Complex32],
        e_mov: f64,
        max_shift: f32,
        upsample: u32,
    ) -> Result<Peak, MotionError> {
        let n = self.fft.spectrum_len();
        if reference.len() != n || mov.len() != n {
            return Err(MotionError::SizeMismatch(
                "spectrum length does not match the correlator".into(),
            ));
        }
        // Nothing to align (blank image): report no shift and no quality.
        if !(e_ref > 0.0 && e_mov > 0.0 && (e_ref * e_mov).is_finite()) {
            return Ok(Peak {
                dy: 0.0,
                dx: 0.0,
                ncc: 0.0,
            });
        }
        for ((c, &t), &f) in self.cross.iter_mut().zip(reference).zip(mov) {
            *c = t * f.conj();
        }
        self.work.copy_from_slice(&self.cross);
        self.fft.inverse(&mut self.work, &mut self.surface)?;

        let (h, w) = (self.h as isize, self.w as isize);
        let ry = (max_shift.max(0.0).floor() as isize).min(h / 2 - 1).max(0);
        let rx = (max_shift.max(0.0).floor() as isize).min(w / 2 - 1).max(0);
        // Correlation divided by the window-overlap envelope, which would
        // otherwise pull the peak towards zero shift by a fraction of the
        // shift that grows as the peak broadens.
        let (env_y, env_x) = (&self.env_y, &self.env_x);
        let at = |s: &[f32], dy: isize, dx: isize| -> f32 {
            let y = dy.rem_euclid(h) as usize;
            let x = dx.rem_euclid(w) as usize;
            s[y * w as usize + x] / (env_y[y] * env_x[x])
        };
        let mut best = (0isize, 0isize, f32::NEG_INFINITY);
        for dy in -ry..=ry {
            for dx in -rx..=rx {
                let v = at(&self.surface, dy, dx);
                if v > best.2 {
                    best = (dy, dx, v);
                }
            }
        }
        let (iy, ix, iv) = best;
        let norm = (self.h * self.w) as f64;
        let denom = (e_ref * e_mov).sqrt();
        let to_ncc = |v: f64| -> f32 {
            if denom > 0.0 && v.is_finite() {
                ((v / norm) / denom).clamp(-1.0, 1.0) as f32
            } else {
                0.0
            }
        };

        if upsample <= 1 {
            let sub = |m: f32, c: f32, p: f32| -> f32 {
                let d = m - 2.0 * c + p;
                if d < 0.0 {
                    (0.5 * (m - p) / d).clamp(-0.5, 0.5)
                } else {
                    0.0
                }
            };
            let fy = sub(
                at(&self.surface, iy - 1, ix),
                iv,
                at(&self.surface, iy + 1, ix),
            );
            let fx = sub(
                at(&self.surface, iy, ix - 1),
                iv,
                at(&self.surface, iy, ix + 1),
            );
            return Ok(Peak {
                dy: iy as f32 + fy,
                dx: ix as f32 + fx,
                ncc: to_ncc(iv as f64),
            });
        }

        let (dy, dx, v) = self.upsampled_peak(iy as f64, ix as f64, upsample);
        Ok(Peak {
            dy: dy as f32,
            dx: dx as f32,
            ncc: to_ncc(v),
        })
    }

    /// Evaluate the correlation `sum Re(X e^{2 pi i (k y / h + l x / w)})` on
    /// a `1 / up` grid within ±0.75 px of `(y0, x0)` and return the refined
    /// peak position and its (unnormalised) value.
    fn upsampled_peak(&mut self, y0: f64, x0: f64, up: u32) -> (f64, f64, f64) {
        let up = up as f64;
        let half = (0.75 * up).ceil() as usize;
        let n = 2 * half + 1;
        let off = |i: usize| (i as f64 - half as f64) / up;
        let (h, w) = (self.h, self.w);
        let nk = self.k_active.len();
        let nl = self.l_max + 1;

        // Twiddles e^{2 pi i f y / h} for every sample row and active k.
        self.tw_y.resize(n * nk, Complex32::default());
        for i in 0..n {
            let y = y0 + off(i);
            for (j, &k) in self.k_active.iter().enumerate() {
                let ph = 2.0 * PI * signed_freq(k, h) as f64 * y / h as f64;
                let (s, c) = ph.sin_cos();
                self.tw_y[i * nk + j] = Complex32::new(c as f32, s as f32);
            }
        }
        self.tw_x.resize(n * nl, Complex32::default());
        for j in 0..n {
            let x = x0 + off(j);
            for l in 0..nl {
                let ph = 2.0 * PI * l as f64 * x / w as f64;
                let (s, c) = ph.sin_cos();
                // Hermitian symmetry: columns 1..w/2 stand for themselves and
                // their mirror (weight 2); DC and an even Nyquist count once.
                let wt = if l == 0 || (w % 2 == 0 && l == w / 2) {
                    1.0
                } else {
                    2.0
                };
                self.tw_x[j * nl + l] = Complex32::new((c * wt) as f32, (s * wt) as f32);
            }
        }

        // Stage 1: sum over k for every column l and sample row i.
        self.stage1.resize(n * nl, Complex32::default());
        for l in 0..nl {
            let col = &self.cross[l * h..][..h];
            for i in 0..n {
                let tw = &self.tw_y[i * nk..][..nk];
                let mut re = 0.0f32;
                let mut im = 0.0f32;
                for (&k, t) in self.k_active.iter().zip(tw) {
                    let x = col[k];
                    re += x.re * t.re - x.im * t.im;
                    im += x.re * t.im + x.im * t.re;
                }
                self.stage1[i * nl + l] = Complex32::new(re, im);
            }
        }
        // Stage 2: real part of the sum over l for every sample (i, j),
        // divided by the window-overlap envelope.
        self.env_sy.clear();
        self.env_sy
            .extend((0..n).map(|i| envelope(&self.pow_y, y0 + off(i))));
        self.env_sx.clear();
        self.env_sx
            .extend((0..n).map(|j| envelope(&self.pow_x, x0 + off(j))));
        self.grid.resize(n * n, 0.0);
        for i in 0..n {
            let a = &self.stage1[i * nl..][..nl];
            for j in 0..n {
                let t = &self.tw_x[j * nl..][..nl];
                let v: f32 = a
                    .iter()
                    .zip(t)
                    .map(|(a, t)| a.re * t.re - a.im * t.im)
                    .sum();
                self.grid[i * n + j] = (v as f64 / (self.env_sy[i] * self.env_sx[j])) as f32;
            }
        }
        let (mut bi, mut bj, mut bv) = (half, half, f32::NEG_INFINITY);
        for i in 0..n {
            for j in 0..n {
                let v = self.grid[i * n + j];
                if v > bv {
                    bi = i;
                    bj = j;
                    bv = v;
                }
            }
        }
        let g = |i: usize, j: usize| self.grid[i * n + j];
        let para = |m: f32, c: f32, p: f32| -> f64 {
            let d = m - 2.0 * c + p;
            if d < 0.0 {
                (0.5 * (m - p) / d).clamp(-0.5, 0.5) as f64
            } else {
                0.0
            }
        };
        let fy = if bi > 0 && bi + 1 < n {
            para(g(bi - 1, bj), bv, g(bi + 1, bj))
        } else {
            0.0
        };
        let fx = if bj > 0 && bj + 1 < n {
            para(g(bi, bj - 1), bv, g(bi, bj + 1))
        } else {
            0.0
        };
        (y0 + off(bi) + fy / up, x0 + off(bj) + fx / up, bv as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Broadband smooth random texture (many plane waves with frequencies up
    /// to 0.2 cycles/px), sampled at a sub-pixel offset analytically.
    fn texture(h: usize, w: usize, sy: f64, sx: f64) -> Vec<f32> {
        let mut state = 12345u64;
        let mut rnd = || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        let waves: Vec<(f64, f64, f64)> = (0..80)
            .map(|_| {
                (
                    (rnd() - 0.5) * 0.4,
                    (rnd() - 0.5) * 0.4,
                    rnd() * std::f64::consts::TAU,
                )
            })
            .collect();
        let mut img = vec![0.0f32; h * w];
        for y in 0..h {
            for x in 0..w {
                let (yy, xx) = (y as f64 - sy, x as f64 - sx);
                let v: f64 = waves
                    .iter()
                    .map(|&(a, b, p)| (2.0 * PI * (a * yy + b * xx) + p).cos())
                    .sum();
                img[y * w + x] = v as f32;
            }
        }
        img
    }

    #[test]
    fn recovers_subpixel_shift_both_refiners() {
        let (h, w) = (64, 72);
        let mut c = Correlator::new(h, w, 0.3).unwrap();
        let reference = texture(h, w, 0.0, 0.0);
        let mut tr = c.make_spectrum();
        let er = c.spectrum(&reference, &mut tr).unwrap();
        for &(sy, sx) in &[(0.0, 0.0), (1.3, -2.7), (-3.45, 0.62), (5.0, 4.25)] {
            // moving(p) = reference(p - d) with d = (sy, sx): registering
            // shift is -d.
            let mov = texture(h, w, sy, sx);
            let mut fm = c.make_spectrum();
            let em = c.spectrum(&mov, &mut fm).unwrap();
            let p = c.register(&tr, er, &fm, em, 8.0, 20).unwrap();
            assert!((p.dy + sy as f32).abs() < 0.05, "dy {} vs {}", p.dy, -sy);
            assert!((p.dx + sx as f32).abs() < 0.05, "dx {} vs {}", p.dx, -sx);
            assert!(p.ncc > 0.8, "ncc {}", p.ncc);
            let q = c.register(&tr, er, &fm, em, 8.0, 1).unwrap();
            assert!((q.dy + sy as f32).abs() < 0.25 && (q.dx + sx as f32).abs() < 0.25);
        }
    }

    #[test]
    fn zero_energy_gives_zero_quality() {
        let mut c = Correlator::new(16, 16, 0.3).unwrap();
        let mut a = c.make_spectrum();
        let ea = c.spectrum(&vec![0.0; 256], &mut a).unwrap();
        let p = c.register(&a.clone(), ea, &a, ea, 4.0, 10).unwrap();
        assert_eq!(p.ncc, 0.0);
        assert!(p.dy.is_finite() && p.dx.is_finite());
    }
}
