//! Recursive (IIR) Gaussian blur whose cost does not depend on sigma.
//!
//! # Method
//!
//! A 1-D Gaussian is approximated by a third-order causal recursion followed
//! by the same recursion run backwards:
//!
//! ```text
//! w[n] = B x[n] + a1 w[n-1] + a2 w[n-2] + a3 w[n-3]      (causal)
//! y[n] = B w[n] + a1 y[n+1] + a2 y[n+2] + a3 y[n+3]      (anti-causal)
//! ```
//!
//! That is about 14 flops per sample per axis for any σ, so a σ = 20 px blur
//! of a 600x600 frame costs the same as σ = 2 px. An FFT would be exact but
//! O(N log N) and is owned by the motion stage; a box-filter cascade is
//! cheaper still but its response is only piecewise polynomial.
//!
//! The coefficients follow van Vliet, Young & Verbeek (1998, "Recursive
//! Gaussian derivative filters", ICPR), as surveyed by Getreuer (2013, IPOL):
//! three poles optimized once for a unit-scale Gaussian
//! (`1.41650 ± 1.00829i`, `1.86543`) are raised to the power `1/q`, with `q`
//! solved numerically so that the cascade's variance,
//! `σ² = Σₖ 2 dₖ / (dₖ − 1)²`, is exactly the requested σ². The older
//! Young & van Vliet (1995) closed-form coefficients were tried first and
//! rejected: their effective σ is 8-13 % larger than requested (measured
//! 21.7 for σ = 20) with heavy tails (kurtosis 5.7 against 3), which breaks
//! the derivative identity the flattening stage relies on. Measured here: the
//! variance is exact, and the 2-D impulse response matches a sampled Gaussian
//! to within 2 % of its peak for σ ≥ 5 (4 % at σ = 2, 7 % at σ = 1; see the
//! tests).
//!
//! # Boundaries: zero padding, done exactly
//!
//! Outside the frame the input is taken as zero. That is what normalized
//! convolution needs ([`crate::preprocess::flatten`] divides `blur(frame·mask)`
//! by `blur(mask)`, and the frame border is just more mask = 0), so no edge
//! replication is required. The causal pass starts from a zero state, which is
//! exact. The anti-causal pass needs the causal output *past* the end, which
//! keeps ringing down after the input stops; it is a linear function of the
//! last three causal outputs, so the 3x3 map from those to the anti-causal
//! start values is precomputed once per σ by running the recursion on unit
//! vectors (the Triggs & Sdika 2006 idea, computed numerically instead of in
//! closed form).
//!
//! # Layout
//!
//! The recursion runs in `f64`. With σ = 20 the poles sit close to 1 and an
//! `f32` recursion carries a relative rounding error of ~10⁻³ (0.1 grey
//! levels on a 100-level frame), which the plane fit of the flattening stage
//! amplifies through its derivatives; in `f64` it is ~10⁻¹¹. Input and output
//! stay `f32`.
//!
//! Both axes use the same row-recursion kernel, which walks down the rows of a
//! row-major buffer and updates a whole row at a time (contiguous, so it
//! vectorizes across columns). The horizontal pass is the vertical pass of the
//! transposed image, with blocked transposes in between. Work buffers carry
//! three zero rows above and three tail rows below the data so the recursion
//! has no special cases at the ends.

use super::{Dims, PreprocessError};

/// Rows of padding at each end of a work buffer (the recursion order).
const PAD: usize = 3;
/// Transpose tile edge.
const TILE: usize = 32;

/// Unit-scale poles of the third-order recursion (van Vliet et al. 1998).
const POLE_RE: f64 = 1.41650;
const POLE_IM: f64 = 1.00829;
const POLE_REAL: f64 = 1.86543;

/// Complex `d^(1/q)` for `d = re + i·im`.
fn cpow_inv(re: f64, im: f64, q: f64) -> (f64, f64) {
    let r = (re * re + im * im).sqrt().ln() / q;
    let t = im.atan2(re) / q;
    (r.exp() * t.cos(), r.exp() * t.sin())
}

/// Variance of the forward-backward cascade with the poles scaled by `1/q`:
/// `Σ 2 d / (d − 1)²` over the three poles (real part).
fn cascade_variance(q: f64) -> f64 {
    let (a, b) = cpow_inv(POLE_RE, POLE_IM, q);
    // 2 d / (d − 1)² for the complex pole, times 2 for its conjugate (real part).
    let (ur, ui) = (a - 1.0, b);
    let (sr, si) = (ur * ur - ui * ui, 2.0 * ur * ui); // (d − 1)²
    let den = sr * sr + si * si;
    let complex = 2.0 * 2.0 * (a * sr + b * si) / den;
    let d = POLE_REAL.powf(1.0 / q);
    complex + 2.0 * d / ((d - 1.0) * (d - 1.0))
}

/// Recursion coefficients for one σ.
#[derive(Debug, Clone, Copy)]
struct Coeffs {
    b: f64,
    a: [f64; 3],
    /// `tail[j][k]`: anti-causal start value `y[N + j]` per unit causal output
    /// `w[N - 1 - k]` (zero input past the end).
    tail: [[f64; 3]; 3],
}

impl Coeffs {
    fn new(sigma: f64) -> Coeffs {
        // The cascade variance grows monotonically with q: bisect (in log q).
        let target = sigma * sigma;
        let (mut lo, mut hi) = (1e-3f64, 1e4f64);
        for _ in 0..200 {
            let mid = (lo * hi).sqrt();
            if cascade_variance(mid) < target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let q = (lo * hi).sqrt();
        // Inverse poles c = 1/d (inside the unit circle) and the expansion of
        // Π (1 − c z⁻¹) = 1 − a1 z⁻¹ − a2 z⁻² − a3 z⁻³.
        let (dr, di) = cpow_inv(POLE_RE, POLE_IM, q);
        let m2 = dr * dr + di * di;
        let (cr, ci) = (dr / m2, -di / m2); // 1 / d (complex)
        let c3 = 1.0 / POLE_REAL.powf(1.0 / q);
        let pair_sum = 2.0 * cr; // c + c̄
        let pair_prod = cr * cr + ci * ci; // c · c̄
        let a = [pair_sum + c3, -(pair_prod + pair_sum * c3), pair_prod * c3];
        let b = 1.0 - (a[0] + a[1] + a[2]);

        // Ring the causal recursion down past the end (zero input), then run
        // the anti-causal recursion back to the boundary from a zero state far
        // enough out (|c|^len < 1e-13) that the truncation is negligible.
        let cmax = pair_prod.sqrt().max(c3).min(1.0 - 1e-9);
        let len = ((-30.0 / cmax.ln()).ceil() as usize).clamp(16, 1 << 20) + 16;
        let mut tail = [[0.0f64; 3]; 3];
        for k in 0..3 {
            let mut w = vec![0.0f64; len + 3];
            w[2 - k] = 1.0; // index 2 is w[N-1], 1 is w[N-2], 0 is w[N-3]
            for i in 3..len + 3 {
                w[i] = a[0] * w[i - 1] + a[1] * w[i - 2] + a[2] * w[i - 3];
            }
            let mut y = vec![0.0f64; len + 6];
            for i in (3..len + 3).rev() {
                y[i] = b * w[i] + a[0] * y[i + 1] + a[1] * y[i + 2] + a[2] * y[i + 3];
            }
            for (j, row) in tail.iter_mut().enumerate() {
                row[k] = y[3 + j];
            }
        }
        Coeffs { b, a, tail }
    }
}

/// A reusable 2-D Gaussian blur of one frame size and σ (in pixels).
#[derive(Debug, Clone)]
pub struct RecursiveGaussian {
    dims: Dims,
    sigma: f32,
    c: Coeffs,
    /// `(PAD + height + PAD) x width`: the frame, vertical pass in place.
    ws_v: Vec<f64>,
    /// `(PAD + width + PAD) x height`: the transposed frame.
    ws_t: Vec<f64>,
    /// Scratch of the vertical pass: which columns hold any input, and
    /// those columns as `[start, end)` runs.
    live: Vec<bool>,
    runs: Vec<(usize, usize)>,
}

impl RecursiveGaussian {
    /// σ must be finite and at least 0.5 px (the range of the coefficient fit).
    pub fn new(dims: Dims, sigma: f32) -> Result<RecursiveGaussian, PreprocessError> {
        if !sigma.is_finite() || sigma < 0.5 {
            return Err(PreprocessError::InvalidConfig(format!(
                "gaussian sigma must be >= 0.5 px, got {sigma}"
            )));
        }
        Ok(RecursiveGaussian {
            dims,
            sigma,
            c: Coeffs::new(f64::from(sigma)),
            ws_v: vec![0.0; (dims.height + 2 * PAD) * dims.width],
            ws_t: vec![0.0; (dims.width + 2 * PAD) * dims.height],
            live: vec![false; dims.width],
            runs: Vec::new(),
        })
    }

    pub fn sigma(&self) -> f32 {
        self.sigma
    }

    pub fn dims(&self) -> Dims {
        self.dims
    }

    /// `out = G_σ * src`, zero outside the frame.
    pub fn blur(&mut self, src: &[f32], out: &mut [f32]) -> Result<(), PreprocessError> {
        self.dims.check("blur input", src.len())?;
        self.dims.check("blur output", out.len())?;
        let n = self.dims.pixels();
        for (d, &s) in self.ws_v[PAD * self.dims.width..PAD * self.dims.width + n]
            .iter_mut()
            .zip(src)
        {
            *d = f64::from(s);
        }
        self.run(out);
        Ok(())
    }

    /// `out = G_σ * (src · weight)`: the numerator of a normalized convolution.
    pub fn blur_weighted(
        &mut self,
        src: &[f32],
        weight: &[f32],
        out: &mut [f32],
    ) -> Result<(), PreprocessError> {
        self.dims.check("blur input", src.len())?;
        self.dims.check("blur weight", weight.len())?;
        self.dims.check("blur output", out.len())?;
        let w = self.dims.width;
        let n = self.dims.pixels();
        for ((d, &s), &m) in self.ws_v[PAD * w..PAD * w + n]
            .iter_mut()
            .zip(src)
            .zip(weight)
        {
            *d = f64::from(s * m);
        }
        self.run(out);
        Ok(())
    }

    /// Both passes on the frame already loaded into `ws_v`'s data rows.
    ///
    /// The vertical pass runs only on the columns that hold any input: a
    /// column of `+0.0` stays `+0.0` bit for bit (`b > 0` and the zero
    /// state), so skipping it changes nothing, and sparse inputs (a library
    /// build filters a few footprints per full-frame canvas) cost a fraction
    /// of a dense frame there. The horizontal pass then runs everywhere.
    fn run(&mut self, out: &mut [f32]) {
        let Dims { width, height } = self.dims;
        live_columns(
            &self.ws_v[PAD * width..(PAD + height) * width],
            width,
            &mut self.live,
            &mut self.runs,
        );
        filter_rows(&mut self.ws_v, height, width, &self.c, &self.runs);
        transpose(
            &self.ws_v[PAD * width..],
            height,
            width,
            &mut self.ws_t[PAD * height..],
            |v| v,
        );
        filter_rows(&mut self.ws_t, width, height, &self.c, &[(0, height)]);
        transpose(&self.ws_t[PAD * height..], width, height, out, |v| v as f32);
    }
}

/// The columns of `data` (rows of length `len`) holding any value other
/// than `+0.0`, as `[start, end)` runs in `runs`.
fn live_columns(data: &[f64], len: usize, live: &mut [bool], runs: &mut Vec<(usize, usize)>) {
    live.fill(false);
    let mut left = len;
    for row in data.chunks_exact(len) {
        for (l, v) in live.iter_mut().zip(row) {
            if !*l && v.to_bits() != 0 {
                *l = true;
                left -= 1;
            }
        }
        if left == 0 {
            break;
        }
    }
    runs.clear();
    let mut i = 0;
    while i < len {
        if live[i] {
            let s = i;
            while i < len && live[i] {
                i += 1;
            }
            runs.push((s, i));
        } else {
            i += 1;
        }
    }
}

/// Forward then backward recursion down the `n` data rows (length `len`) of a
/// padded buffer: rows `0..PAD` are zero, `PAD..PAD+n` data, then `PAD` tail rows.
/// Only the columns in `cols` (`[start, end)` runs) are filtered; the caller
/// guarantees every other column is `+0.0`, which the recursion keeps
/// (`b > 0`), so they are left as they are (their tail rows are not written).
fn filter_rows(ws: &mut [f64], n: usize, len: usize, c: &Coeffs, cols: &[(usize, usize)]) {
    let [a0, a1, a2] = c.a;
    let b = c.b;
    debug_assert!(b > 0.0);
    for r in PAD..PAD + n {
        let (head, rest) = ws.split_at_mut(r * len);
        let cur = &mut rest[..len];
        let p1 = &head[(r - 1) * len..r * len];
        let p2 = &head[(r - 2) * len..(r - 1) * len];
        let p3 = &head[(r - 3) * len..(r - 2) * len];
        for &(s, e) in cols {
            let (p1, p2, p3) = (&p1[s..e], &p2[s..e], &p3[s..e]);
            for (i, v) in cur[s..e].iter_mut().enumerate() {
                *v = b * *v + a0 * p1[i] + a1 * p2[i] + a2 * p3[i];
            }
        }
    }
    // Anti-causal start values past the end, from the last three causal rows.
    {
        let end = PAD + n;
        let (head, tail) = ws.split_at_mut(end * len);
        let w1 = &head[(end - 1) * len..end * len];
        let w2 = &head[(end - 2) * len..(end - 1) * len];
        let w3 = &head[(end - 3) * len..(end - 2) * len];
        for (j, t) in tail.chunks_exact_mut(len).take(PAD).enumerate() {
            let [m0, m1, m2] = c.tail[j];
            for &(s, e) in cols {
                let (w1, w2, w3) = (&w1[s..e], &w2[s..e], &w3[s..e]);
                for (i, v) in t[s..e].iter_mut().enumerate() {
                    *v = m0 * w1[i] + m1 * w2[i] + m2 * w3[i];
                }
            }
        }
    }
    for r in (PAD..PAD + n).rev() {
        let (head, rest) = ws.split_at_mut((r + 1) * len);
        let cur = &mut head[r * len..];
        let n1 = &rest[..len];
        let n2 = &rest[len..2 * len];
        let n3 = &rest[2 * len..3 * len];
        for &(s, e) in cols {
            let (n1, n2, n3) = (&n1[s..e], &n2[s..e], &n3[s..e]);
            for (i, v) in cur[s..e].iter_mut().enumerate() {
                *v = b * *v + a0 * n1[i] + a1 * n2[i] + a2 * n3[i];
            }
        }
    }
}

/// `dst[c * rows + r] = f(src[r * cols + c])`, in cache-sized tiles.
fn transpose<T: Copy, U>(src: &[T], rows: usize, cols: usize, dst: &mut [U], f: impl Fn(T) -> U) {
    for r0 in (0..rows).step_by(TILE) {
        let r1 = (r0 + TILE).min(rows);
        for c0 in (0..cols).step_by(TILE) {
            let c1 = (c0 + TILE).min(cols);
            for r in r0..r1 {
                let row = &src[r * cols..r * cols + cols];
                for c in c0..c1 {
                    dst[c * rows + r] = f(row[c]);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Direct zero-padded convolution with a sampled, normalized Gaussian.
    fn reference(src: &[f32], dims: Dims, sigma: f64) -> Vec<f64> {
        let r = (6.0 * sigma).ceil() as isize;
        let k: Vec<f64> = (-r..=r)
            .map(|i| (-(i * i) as f64 / (2.0 * sigma * sigma)).exp())
            .collect();
        let s: f64 = k.iter().sum();
        let k: Vec<f64> = k.iter().map(|v| v / s).collect();
        let (w, h) = (dims.width as isize, dims.height as isize);
        let mut tmp = vec![0.0f64; dims.pixels()];
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0;
                for (j, kv) in k.iter().enumerate() {
                    let xx = x + j as isize - r;
                    if (0..w).contains(&xx) {
                        acc += kv * f64::from(src[(y * w + xx) as usize]);
                    }
                }
                tmp[(y * w + x) as usize] = acc;
            }
        }
        let mut out = vec![0.0f64; dims.pixels()];
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0;
                for (j, kv) in k.iter().enumerate() {
                    let yy = y + j as isize - r;
                    if (0..h).contains(&yy) {
                        acc += kv * tmp[(yy * w + x) as usize];
                    }
                }
                out[(y * w + x) as usize] = acc;
            }
        }
        out
    }

    #[test]
    fn impulse_matches_sampled_gaussian() {
        for &sigma in &[1.0f32, 2.0, 5.0, 12.0, 20.0] {
            let dims = Dims::new(97, 81).unwrap();
            let mut src = vec![0.0f32; dims.pixels()];
            src[40 * 97 + 48] = 1.0;
            let mut g = RecursiveGaussian::new(dims, sigma).unwrap();
            let mut out = vec![0.0f32; dims.pixels()];
            g.blur(&src, &mut out).unwrap();
            let r = reference(&src, dims, f64::from(sigma));
            let peak = r.iter().cloned().fold(0.0, f64::max);
            let err = out
                .iter()
                .zip(&r)
                .map(|(&a, &b)| (f64::from(a) - b).abs())
                .fold(0.0, f64::max);
            let tol = if sigma <= 2.0 { 0.08 } else { 0.03 };
            eprintln!("sigma {sigma}: rel err {:.4}", err / peak);
            assert!(err / peak < tol, "sigma {sigma}: rel err {}", err / peak);
            let sum: f64 = out.iter().map(|&v| f64::from(v)).sum();
            // Mass inside the frame (zero padding loses the tails at large σ).
            let ref_sum: f64 = r.iter().sum();
            assert!(
                (sum - ref_sum).abs() < 0.015,
                "sigma {sigma}: mass {sum} vs {ref_sum}"
            );
        }
    }

    #[test]
    fn variance_is_exact() {
        let n = 1001usize;
        for &sigma in &[1.0f32, 3.0, 20.0, 45.0] {
            let mut g = RecursiveGaussian::new(Dims::new(n, 1).unwrap(), sigma).unwrap();
            let mut src = vec![0.0f32; n];
            src[n / 2] = 1.0;
            let mut out = vec![0.0f32; n];
            g.blur(&src, &mut out).unwrap();
            let s: f64 = out.iter().map(|&v| f64::from(v)).sum();
            let var: f64 = out
                .iter()
                .enumerate()
                .map(|(i, &v)| (i as f64 - (n / 2) as f64).powi(2) * f64::from(v))
                .sum::<f64>()
                / s;
            let rel = var.sqrt() / f64::from(sigma) - 1.0;
            assert!(rel.abs() < 1e-3, "sigma {sigma}: effective {}", var.sqrt());
        }
    }

    #[test]
    fn zero_padding_at_edges_matches_reference() {
        // A constant image: the blur falls off toward the borders exactly as a
        // zero-padded convolution does (this is what normalized convolution needs).
        let dims = Dims::new(64, 50).unwrap();
        let src = vec![1.0f32; dims.pixels()];
        for &sigma in &[3.0f32, 20.0, 60.0] {
            let mut g = RecursiveGaussian::new(dims, sigma).unwrap();
            let mut out = vec![0.0f32; dims.pixels()];
            g.blur(&src, &mut out).unwrap();
            let r = reference(&src, dims, f64::from(sigma));
            let err = out
                .iter()
                .zip(&r)
                .map(|(&a, &b)| (f64::from(a) - b).abs())
                .fold(0.0, f64::max);
            assert!(err < 0.03, "sigma {sigma}: max abs err {err}");
        }
    }

    #[test]
    fn interior_of_constant_is_unchanged() {
        let dims = Dims::new(300, 300).unwrap();
        let src = vec![100.0f32; dims.pixels()];
        let mut g = RecursiveGaussian::new(dims, 20.0).unwrap();
        let mut out = vec![0.0f32; dims.pixels()];
        g.blur(&src, &mut out).unwrap();
        let c = out[150 * 300 + 150];
        assert!((c - 100.0).abs() < 0.05, "centre {c}");
    }

    #[test]
    fn tiny_and_degenerate_sizes() {
        for &(w, h) in &[(1usize, 1usize), (1, 7), (9, 1), (2, 2)] {
            let dims = Dims::new(w, h).unwrap();
            let src: Vec<f32> = (0..dims.pixels()).map(|i| i as f32).collect();
            let mut g = RecursiveGaussian::new(dims, 4.0).unwrap();
            let mut out = vec![0.0f32; dims.pixels()];
            g.blur(&src, &mut out).unwrap();
            assert!(out.iter().all(|v| v.is_finite()));
        }
        let dims = Dims::new(4, 4).unwrap();
        assert!(RecursiveGaussian::new(dims, 0.1).is_err());
        assert!(RecursiveGaussian::new(dims, f32::NAN).is_err());
        let mut g = RecursiveGaussian::new(dims, 1.0).unwrap();
        let mut out = vec![0.0; 16];
        assert!(g.blur(&[0.0; 3], &mut out).is_err());
    }

    #[test]
    fn repeated_calls_are_identical() {
        let dims = Dims::new(40, 30).unwrap();
        let src: Vec<f32> = (0..dims.pixels())
            .map(|i| ((i * 7919) % 255) as f32)
            .collect();
        let mut g = RecursiveGaussian::new(dims, 6.0).unwrap();
        let mut a = vec![0.0; dims.pixels()];
        let mut b = vec![0.0; dims.pixels()];
        g.blur(&src, &mut a).unwrap();
        g.blur(&vec![5.0; dims.pixels()], &mut b).unwrap();
        g.blur(&src, &mut b).unwrap();
        assert_eq!(a, b);
    }

    /// The vertical pass skips columns of `+0.0`: bit for bit what running
    /// it on every column gives, for sparse inputs (a few patches, the
    /// library build's canvases), after a dense frame (stale tail rows), and
    /// with `-0.0` in a column (which is not skipped).
    #[test]
    fn skipping_zero_columns_is_exact() {
        let dims = Dims::new(97, 61).unwrap();
        let full = |g: &mut RecursiveGaussian, src: &[f32]| {
            let Dims { width, height } = dims;
            for (d, &s) in g.ws_v[PAD * width..PAD * width + dims.pixels()]
                .iter_mut()
                .zip(src)
            {
                *d = f64::from(s);
            }
            filter_rows(&mut g.ws_v, height, width, &g.c, &[(0, width)]);
            transpose(
                &g.ws_v[PAD * width..],
                height,
                width,
                &mut g.ws_t[PAD * height..],
                |v| v,
            );
            filter_rows(&mut g.ws_t, width, height, &g.c, &[(0, height)]);
            let mut out = vec![0.0f32; dims.pixels()];
            transpose(&g.ws_t[PAD * height..], width, height, &mut out, |v| {
                v as f32
            });
            out
        };
        let mut sparse = vec![0.0f32; dims.pixels()];
        for (y0, x0) in [(3usize, 2usize), (40, 50), (20, 90), (55, 30)] {
            for y in y0..(y0 + 5).min(dims.height) {
                for x in x0..(x0 + 4).min(dims.width) {
                    sparse[y * dims.width + x] = 1.0 + ((y * 31 + x * 17) % 13) as f32;
                }
            }
        }
        let mut negzero = sparse.clone();
        negzero[10 * dims.width + 70] = -0.0;
        let dense: Vec<f32> = (0..dims.pixels())
            .map(|i| ((i * 7919) % 255) as f32)
            .collect();
        let mut g = RecursiveGaussian::new(dims, 7.0).unwrap();
        let mut h = RecursiveGaussian::new(dims, 7.0).unwrap();
        for src in [
            &dense,
            &sparse,
            &negzero,
            &vec![0.0; dims.pixels()],
            &sparse,
        ] {
            let mut out = vec![0.0f32; dims.pixels()];
            g.blur(src, &mut out).unwrap();
            let want = full(&mut h, src);
            let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
            assert_eq!(bits(&out), bits(&want));
        }
    }
}
