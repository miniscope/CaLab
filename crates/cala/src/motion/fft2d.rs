//! Real-to-complex 2-D FFT with cached plans and reusable buffers.
//!
//! [`Fft2d`] transforms a real `height x width` image (row-major) into the
//! non-redundant half of its spectrum and back. It plans once at construction
//! (any size: `rustfft` handles mixed radices and Bluestein for awkward
//! primes, though sizes of the form `2^a 3^b 5^c` are fastest; see
//! [`fft_friendly_size`]) and owns every scratch buffer, so a transform
//! allocates nothing.
//!
//! # Spectrum layout
//!
//! The spectrum has `height` vertical frequencies `k` and `width / 2 + 1`
//! horizontal frequencies `l`, stored **column-major**: entry `(k, l)` is at
//! `l * height + k` ([`Fft2d::index`]). The column layout is what the column
//! transforms want (they run in place on contiguous chunks), and element-wise
//! products, the common use, do not care. Vertical frequency `k` above
//! `height / 2` is the negative frequency `k - height` ([`signed_freq`]).
//!
//! # Normalisation
//!
//! Neither direction is normalised: `inverse(forward(x)) = height * width * x`.

use std::sync::Arc;

use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rustfft::{Fft, FftPlanner};

use super::MotionError;

/// Planned forward and inverse 2-D real FFT of one image size.
pub struct Fft2d {
    height: usize,
    width: usize,
    cols: usize,
    r2c: Arc<dyn RealToComplex<f32>>,
    c2r: Arc<dyn ComplexToReal<f32>>,
    col_fwd: Arc<dyn Fft<f32>>,
    col_inv: Arc<dyn Fft<f32>>,
    row_in: Vec<f32>,
    row_scratch: Vec<Complex32>,
    col_scratch: Vec<Complex32>,
    rows: Vec<Complex32>,
}

impl Fft2d {
    /// Plan transforms for `height x width` images (both at least 2).
    pub fn new(height: usize, width: usize) -> Result<Self, MotionError> {
        if height < 2 || width < 2 {
            return Err(MotionError::InvalidConfig(format!(
                "FFT size {height}x{width} is too small (need at least 2x2)"
            )));
        }
        let mut real = RealFftPlanner::<f32>::new();
        let mut cplx = FftPlanner::<f32>::new();
        let r2c = real.plan_fft_forward(width);
        let c2r = real.plan_fft_inverse(width);
        let col_fwd = cplx.plan_fft_forward(height);
        let col_inv = cplx.plan_fft_inverse(height);
        let cols = width / 2 + 1;
        let row_scratch_len = r2c.get_scratch_len().max(c2r.get_scratch_len());
        let col_scratch_len = col_fwd
            .get_inplace_scratch_len()
            .max(col_inv.get_inplace_scratch_len());
        Ok(Fft2d {
            height,
            width,
            cols,
            r2c,
            c2r,
            col_fwd,
            col_inv,
            row_in: vec![0.0; width],
            row_scratch: vec![Complex32::default(); row_scratch_len],
            col_scratch: vec![Complex32::default(); col_scratch_len],
            rows: vec![Complex32::default(); height * cols],
        })
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn width(&self) -> usize {
        self.width
    }

    /// Number of horizontal frequencies kept, `width / 2 + 1`.
    pub fn spectrum_cols(&self) -> usize {
        self.cols
    }

    /// Length of a spectrum buffer, `height * (width / 2 + 1)`.
    pub fn spectrum_len(&self) -> usize {
        self.height * self.cols
    }

    /// Index of frequency `(k, l)` in a spectrum buffer.
    #[inline]
    pub fn index(&self, k: usize, l: usize) -> usize {
        l * self.height + k
    }

    /// A zeroed spectrum buffer of the right length.
    pub fn make_spectrum(&self) -> Vec<Complex32> {
        vec![Complex32::default(); self.spectrum_len()]
    }

    /// Forward transform of `input` (`height * width`, row-major) into
    /// `spectrum` (`spectrum_len()`, column-major).
    pub fn forward(
        &mut self,
        input: &[f32],
        spectrum: &mut [Complex32],
    ) -> Result<(), MotionError> {
        let (h, w, c) = (self.height, self.width, self.cols);
        check_len("forward input", input.len(), h * w)?;
        check_len("forward spectrum", spectrum.len(), h * c)?;
        for r in 0..h {
            self.row_in.copy_from_slice(&input[r * w..(r + 1) * w]);
            self.r2c
                .process_with_scratch(
                    &mut self.row_in,
                    &mut self.rows[r * c..(r + 1) * c],
                    &mut self.row_scratch,
                )
                .map_err(|e| MotionError::Internal(format!("row FFT: {e}")))?;
        }
        transpose(&self.rows, spectrum, h, c);
        self.col_fwd
            .process_with_scratch(spectrum, &mut self.col_scratch);
        Ok(())
    }

    /// Inverse transform of `spectrum` into `output` (`height * width`,
    /// row-major), unnormalised. `spectrum` is used as scratch and left
    /// holding the column-inverted data.
    pub fn inverse(
        &mut self,
        spectrum: &mut [Complex32],
        output: &mut [f32],
    ) -> Result<(), MotionError> {
        let (h, w, c) = (self.height, self.width, self.cols);
        check_len("inverse spectrum", spectrum.len(), h * c)?;
        check_len("inverse output", output.len(), h * w)?;
        self.col_inv
            .process_with_scratch(spectrum, &mut self.col_scratch);
        transpose(spectrum, &mut self.rows, c, h);
        let even = w % 2 == 0;
        for r in 0..h {
            let row = &mut self.rows[r * c..(r + 1) * c];
            // A Hermitian spectrum gives real DC (and Nyquist) bins up to
            // rounding; realfft insists they be exactly real.
            row[0].im = 0.0;
            if even {
                row[c - 1].im = 0.0;
            }
            self.c2r
                .process_with_scratch(row, &mut output[r * w..(r + 1) * w], &mut self.row_scratch)
                .map_err(|e| MotionError::Internal(format!("row inverse FFT: {e}")))?;
        }
        Ok(())
    }
}

fn check_len(what: &str, got: usize, want: usize) -> Result<(), MotionError> {
    if got == want {
        Ok(())
    } else {
        Err(MotionError::SizeMismatch(format!(
            "{what} has {got} elements, expected {want}"
        )))
    }
}

/// Transpose a `rows x cols` row-major matrix into `dst` (`cols x rows`),
/// in cache-sized blocks.
fn transpose(src: &[Complex32], dst: &mut [Complex32], rows: usize, cols: usize) {
    const B: usize = 16;
    for r0 in (0..rows).step_by(B) {
        let r1 = (r0 + B).min(rows);
        for c0 in (0..cols).step_by(B) {
            let c1 = (c0 + B).min(cols);
            for r in r0..r1 {
                for c in c0..c1 {
                    dst[c * rows + r] = src[r * cols + c];
                }
            }
        }
    }
}

/// Signed frequency of bin `k` of an `n`-point transform: `k` for
/// `k <= n / 2`, else `k - n`.
#[inline]
pub fn signed_freq(k: usize, n: usize) -> isize {
    if k <= n / 2 {
        k as isize
    } else {
        k as isize - n as isize
    }
}

/// Largest `m <= n` of the form `2^a 3^b 5^c` with `m` even (or `n` itself if
/// `n < 2`), the sizes `rustfft` transforms fastest.
pub fn fft_friendly_size(n: usize) -> usize {
    let mut m = n;
    while m >= 2 {
        if m.is_multiple_of(2) {
            let mut r = m;
            for p in [2, 3, 5] {
                while r.is_multiple_of(p) {
                    r /= p;
                }
            }
            if r == 1 {
                return m;
            }
        }
        m -= 1;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_odd_and_even_sizes() {
        for (h, w) in [(8, 8), (7, 10), (12, 9), (30, 45)] {
            let mut f = Fft2d::new(h, w).unwrap();
            let img: Vec<f32> = (0..h * w).map(|i| ((i * 37 % 11) as f32) - 3.0).collect();
            let mut s = f.make_spectrum();
            f.forward(&img, &mut s).unwrap();
            let mut back = vec![0.0; h * w];
            f.inverse(&mut s, &mut back).unwrap();
            let n = (h * w) as f32;
            for (a, b) in img.iter().zip(&back) {
                assert!((a - b / n).abs() < 1e-4, "{h}x{w}: {a} vs {}", b / n);
            }
        }
    }

    #[test]
    fn matches_direct_dft() {
        let (h, w) = (6, 5);
        let img: Vec<f32> = (0..h * w).map(|i| (i as f32 * 0.7).sin()).collect();
        let mut f = Fft2d::new(h, w).unwrap();
        let mut s = f.make_spectrum();
        f.forward(&img, &mut s).unwrap();
        for k in 0..h {
            for l in 0..w / 2 + 1 {
                let mut acc = (0.0f64, 0.0f64);
                for y in 0..h {
                    for x in 0..w {
                        let ph = -2.0
                            * std::f64::consts::PI
                            * ((k * y) as f64 / h as f64 + (l * x) as f64 / w as f64);
                        acc.0 += img[y * w + x] as f64 * ph.cos();
                        acc.1 += img[y * w + x] as f64 * ph.sin();
                    }
                }
                let v = s[f.index(k, l)];
                assert!((v.re as f64 - acc.0).abs() < 1e-3 && (v.im as f64 - acc.1).abs() < 1e-3);
            }
        }
    }

    #[test]
    fn rejects_bad_sizes() {
        assert!(Fft2d::new(1, 8).is_err());
        let mut f = Fft2d::new(4, 4).unwrap();
        let mut s = f.make_spectrum();
        assert!(f.forward(&[0.0; 15], &mut s).is_err());
    }

    #[test]
    fn friendly_sizes() {
        assert_eq!(fft_friendly_size(384), 384);
        assert_eq!(fft_friendly_size(397), 384);
        assert_eq!(fft_friendly_size(281), 270);
        assert_eq!(fft_friendly_size(77), 72);
    }
}
