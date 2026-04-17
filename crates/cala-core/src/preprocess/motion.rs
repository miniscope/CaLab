//! Dual-anchor motion correction via FFT phase correlation.
//!
//! Per-frame algorithm (design §3):
//!   1. **Local pass** — phase-correlate `input` against the previous
//!      corrected frame (`local_anchor`), find peak within
//!      `cfg.motion_max_shift_px`, parabolic-subpixel refine.
//!   2. **Global pass** — when `cfg.motion_use_global_anchor` is true
//!      and at least one prior frame has been seen, apply the local
//!      shift to produce an intermediate image, correlate it against
//!      the running mean of all prior corrected frames (`global_anchor`),
//!      and add the resulting refinement to the local shift.
//!   3. Apply the **composite** shift to the original input with a
//!      single bilinear resampling (replicate boundary). Doing it in
//!      one pass avoids stacking interpolation blur.
//!   4. Update local anchor = corrected output; update global anchor
//!      via cumulative-mean recurrence.
//!
//! First frame through is the identity: output = input, both anchors
//! initialized from input, shift = (0, 0). After `reset()` the state
//! forgets both anchors and the next call behaves as first-frame again.

use rustfft::{num_complex::Complex32, FftPlanner};

use super::fft2d::{fft_cols, fft_rows};
use crate::assets::{Frame, FrameMut, ShapeError};
use crate::config::PreprocessConfig;

/// Bins with |A · conj(B)| below this are zeroed before normalization
/// — division-by-zero guard plus noise suppression on silent frequencies.
const PHASE_CORRELATION_EPS: f32 = 1e-10;

/// Detected per-frame motion shift, in pixels.
///
/// Positive `dy` means the current frame moved DOWN relative to the
/// anchor; positive `dx` means RIGHT. Subpixel-accurate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MotionShift {
    pub dy: f32,
    pub dx: f32,
}

/// State held across frames by the motion-correction stage.
pub struct MotionState {
    height: usize,
    width: usize,
    has_anchor: bool,
    local_anchor: Vec<f32>,
    global_anchor: Vec<f32>,
    global_count: u64,
    scratch: Vec<f32>,
}

impl MotionState {
    pub fn new(height: usize, width: usize) -> Self {
        let n = height * width;
        Self {
            height,
            width,
            has_anchor: false,
            local_anchor: vec![0.0; n],
            global_anchor: vec![0.0; n],
            global_count: 0,
            scratch: vec![0.0; n],
        }
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn has_anchor(&self) -> bool {
        self.has_anchor
    }

    /// Number of corrected frames that have contributed to the global
    /// anchor so far. 0 until the first successful `motion_correct` call.
    pub fn global_count(&self) -> u64 {
        self.global_count
    }

    /// View of the current local anchor, or `None` until the first
    /// frame has been processed.
    pub fn local_anchor(&self) -> Option<Frame<'_>> {
        if !self.has_anchor {
            return None;
        }
        Some(
            Frame::new(&self.local_anchor, self.height, self.width)
                .expect("invariant: local_anchor length == height * width"),
        )
    }

    /// View of the running-mean global anchor, or `None` until at
    /// least one frame has contributed (`global_count() > 0`).
    pub fn global_anchor(&self) -> Option<Frame<'_>> {
        if self.global_count == 0 {
            return None;
        }
        Some(
            Frame::new(&self.global_anchor, self.height, self.width)
                .expect("invariant: global_anchor length == height * width"),
        )
    }

    /// Forget both anchors. The next call to `motion_correct` behaves
    /// as the first frame again.
    pub fn reset(&mut self) {
        self.has_anchor = false;
        self.global_count = 0;
    }

    /// Register `input` against the anchors, write the corrected frame
    /// to `output`, update both anchors, and return the composite shift.
    pub fn motion_correct(
        &mut self,
        input: Frame<'_>,
        output: &mut FrameMut<'_>,
        cfg: &PreprocessConfig,
    ) -> Result<MotionShift, ShapeError> {
        let n = self.height * self.width;
        if input.height() != self.height || input.width() != self.width {
            return Err(ShapeError {
                expected: n,
                actual: input.pixels().len(),
            });
        }
        if output.height() != self.height || output.width() != self.width {
            return Err(ShapeError {
                expected: n,
                actual: output.pixels().len(),
            });
        }

        if !self.has_anchor {
            output.pixels_mut().copy_from_slice(input.pixels());
            self.local_anchor.copy_from_slice(input.pixels());
            self.update_global_anchor(input.pixels());
            self.has_anchor = true;
            return Ok(MotionShift { dy: 0.0, dx: 0.0 });
        }

        let local_shift = detect_shift(
            input.pixels(),
            &self.local_anchor,
            self.height,
            self.width,
            cfg.motion_max_shift_px,
        );

        let composite_shift = if cfg.motion_use_global_anchor && self.global_count > 0 {
            // Apply the local shift to get an intermediate image, then
            // correlate it against the global anchor for a refinement.
            // The final bilinear is applied once to the original input
            // with the composite shift — avoids stacking interpolation.
            {
                let mut scratch_frame = FrameMut::new(&mut self.scratch, self.height, self.width)
                    .expect("scratch length invariant");
                apply_bilinear_shift(input, &mut scratch_frame, local_shift.dy, local_shift.dx);
            }
            let global_refinement = detect_shift(
                &self.scratch,
                &self.global_anchor,
                self.height,
                self.width,
                cfg.motion_max_shift_px,
            );
            MotionShift {
                dy: local_shift.dy + global_refinement.dy,
                dx: local_shift.dx + global_refinement.dx,
            }
        } else {
            local_shift
        };

        apply_bilinear_shift(input, output, composite_shift.dy, composite_shift.dx);
        self.local_anchor.copy_from_slice(output.pixels());
        self.update_global_anchor(output.pixels());
        Ok(composite_shift)
    }

    /// Cumulative-mean recurrence over corrected frames:
    ///   g ← (g·count + new) / (count + 1)
    /// On the very first update (count == 0) this collapses to g ← new,
    /// so the initial buffer contents don't matter.
    fn update_global_anchor(&mut self, new_frame: &[f32]) {
        let n = self.global_count as f32;
        let inv = 1.0 / (n + 1.0);
        for (g, &v) in self.global_anchor.iter_mut().zip(new_frame.iter()) {
            *g = (*g * n + v) * inv;
        }
        self.global_count += 1;
    }
}

/// Phase-correlate `current` against `anchor`, find the peak within the
/// allowed shift radius, and return the full subpixel shift of `current`
/// relative to `anchor`.
fn detect_shift(
    current: &[f32],
    anchor: &[f32],
    h: usize,
    w: usize,
    max_shift: u32,
) -> MotionShift {
    let map = phase_correlate(current, anchor, h, w);
    let (py, px) = find_peak_in_range(&map, h, w, max_shift);
    let (sy, sx) = parabolic_subpixel(&map, h, w, py, px);
    MotionShift {
        dy: bin_to_signed_shift(py, h) + sy,
        dx: bin_to_signed_shift(px, w) + sx,
    }
}

/// Compute the 2D phase-correlation map between `a` and `b`.
///
/// The peak location gives the shift of `a` relative to `b`: if
/// `a[n] = b[n − δ]` (a is b shifted forward by δ), the peak is at δ.
fn phase_correlate(a: &[f32], b: &[f32], h: usize, w: usize) -> Vec<f32> {
    let mut a_c: Vec<Complex32> = a.iter().map(|&r| Complex32::new(r, 0.0)).collect();
    let mut b_c: Vec<Complex32> = b.iter().map(|&r| Complex32::new(r, 0.0)).collect();

    let mut planner = FftPlanner::<f32>::new();
    let row_fft = planner.plan_fft_forward(w);
    let col_fft = planner.plan_fft_forward(h);
    let row_ifft = planner.plan_fft_inverse(w);
    let col_ifft = planner.plan_fft_inverse(h);

    fft_rows(&mut a_c, h, w, &row_fft);
    fft_cols(&mut a_c, h, w, &col_fft);
    fft_rows(&mut b_c, h, w, &row_fft);
    fft_cols(&mut b_c, h, w, &col_fft);

    for i in 0..a_c.len() {
        let r = a_c[i] * b_c[i].conj();
        let mag = (r.re * r.re + r.im * r.im).sqrt();
        a_c[i] = if mag > PHASE_CORRELATION_EPS {
            r / mag
        } else {
            Complex32::new(0.0, 0.0)
        };
    }

    fft_cols(&mut a_c, h, w, &col_ifft);
    fft_rows(&mut a_c, h, w, &row_ifft);

    let norm = 1.0 / (h * w) as f32;
    a_c.iter().map(|c| c.re * norm).collect()
}

/// Convert an FFT bin index to a signed shift (cycles-per-N convention).
/// Bins in `[0, size/2]` stay positive; bins above `size/2` wrap to
/// negative (bin − size).
fn bin_to_signed_shift(bin: usize, size: usize) -> f32 {
    let b = bin as isize;
    let s = size as isize;
    if 2 * b > s {
        (b - s) as f32
    } else {
        b as f32
    }
}

/// Locate the largest value in `map` whose signed shift satisfies
/// `|dy|, |dx| ≤ max_shift`. Returns the winning `(ky, kx)` bin pair.
fn find_peak_in_range(map: &[f32], h: usize, w: usize, max_shift: u32) -> (usize, usize) {
    let max_s = max_shift as f32;
    let mut best = (0usize, 0usize);
    let mut best_val = f32::NEG_INFINITY;
    for ky in 0..h {
        let sdy = bin_to_signed_shift(ky, h);
        if sdy.abs() > max_s {
            continue;
        }
        for kx in 0..w {
            let sdx = bin_to_signed_shift(kx, w);
            if sdx.abs() > max_s {
                continue;
            }
            let v = map[ky * w + kx];
            if v > best_val {
                best_val = v;
                best = (ky, kx);
            }
        }
    }
    best
}

/// Subpixel refinement: fit 1D parabolas through the peak and its two
/// neighbors along each axis. The parabola's extremum lies at fractional
/// offset δ ∈ [−0.5, 0.5]. Neighbors use cyclic (modulo) indexing so
/// peaks at the boundary of the search range still see valid values.
///
/// A parabolic fit is the log-quadratic form of a Gaussian peak fit
/// assuming the three samples are on the same (Gaussian) envelope.
fn parabolic_subpixel(map: &[f32], h: usize, w: usize, py: usize, px: usize) -> (f32, f32) {
    let y_prev = if py == 0 { h - 1 } else { py - 1 };
    let y_next = if py + 1 == h { 0 } else { py + 1 };
    let x_prev = if px == 0 { w - 1 } else { px - 1 };
    let x_next = if px + 1 == w { 0 } else { px + 1 };

    let f_y = map[py * w + px];
    let f_yprev = map[y_prev * w + px];
    let f_ynext = map[y_next * w + px];
    let f_xprev = map[py * w + x_prev];
    let f_xnext = map[py * w + x_next];

    let sy = fit_parabola(f_yprev, f_y, f_ynext);
    let sx = fit_parabola(f_xprev, f_y, f_xnext);
    (sy, sx)
}

/// Minimizer of the parabola through (−1, a), (0, b), (+1, c):
///   δ = (a − c) / (2·(a − 2b + c))
/// Clamped to `[−0.5, 0.5]` to avoid runaway on near-flat peaks.
fn fit_parabola(a: f32, b: f32, c: f32) -> f32 {
    let denom = a - 2.0 * b + c;
    if denom.abs() < 1e-12 {
        return 0.0;
    }
    ((a - c) / (2.0 * denom)).clamp(-0.5, 0.5)
}

/// Bilinear resample: `output[y, x]` reads `input[y + sdy, x + sdx]`
/// with replicate-boundary clamping on out-of-range coordinates.
fn apply_bilinear_shift(input: Frame<'_>, output: &mut FrameMut<'_>, sdy: f32, sdx: f32) {
    let h = input.height();
    let w = input.width();
    let h_max = (h - 1) as f32;
    let w_max = (w - 1) as f32;
    for y in 0..h {
        for x in 0..w {
            let sy = (y as f32 + sdy).clamp(0.0, h_max);
            let sx = (x as f32 + sdx).clamp(0.0, w_max);
            let y0 = sy.floor() as usize;
            let x0 = sx.floor() as usize;
            let y1 = (y0 + 1).min(h - 1);
            let x1 = (x0 + 1).min(w - 1);
            let fy = sy - y0 as f32;
            let fx = sx - x0 as f32;
            let v = (1.0 - fy) * ((1.0 - fx) * input.get(y0, x0) + fx * input.get(y0, x1))
                + fy * ((1.0 - fx) * input.get(y1, x0) + fx * input.get(y1, x1));
            *output.get_mut(y, x) = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_shift_zero_at_zero() {
        assert_eq!(bin_to_signed_shift(0, 8), 0.0);
    }

    #[test]
    fn signed_shift_small_positive_is_bin_index() {
        assert_eq!(bin_to_signed_shift(3, 8), 3.0);
    }

    #[test]
    fn signed_shift_above_half_wraps_to_negative() {
        assert_eq!(bin_to_signed_shift(5, 8), -3.0);
        assert_eq!(bin_to_signed_shift(7, 8), -1.0);
    }

    #[test]
    fn signed_shift_at_half_stays_positive() {
        // Even size: the Nyquist bin (size/2) is ambiguous but we pick positive.
        assert_eq!(bin_to_signed_shift(4, 8), 4.0);
    }

    #[test]
    fn parabolic_fit_symmetric_peak_is_centered() {
        assert!(fit_parabola(0.5, 1.0, 0.5).abs() < 1e-6);
    }

    #[test]
    fn parabolic_fit_asymmetric_peak_biases_toward_larger_neighbor() {
        // f[-1]=0.2, f[0]=1.0, f[+1]=0.6
        //   δ = (0.2 - 0.6) / (2·(0.2 - 2 + 0.6)) = -0.4 / -2.4 = 1/6
        let delta = fit_parabola(0.2, 1.0, 0.6);
        assert!((delta - 1.0 / 6.0).abs() < 1e-6, "δ = {delta}");
    }

    #[test]
    fn parabolic_fit_flat_triple_returns_zero() {
        assert_eq!(fit_parabola(1.0, 1.0, 1.0), 0.0);
    }

    #[test]
    fn bilinear_shift_zero_is_identity() {
        let input = [1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0];
        let mut output = [0.0f32; 6];
        apply_bilinear_shift(
            Frame::new(&input, 2, 3).unwrap(),
            &mut FrameMut::new(&mut output, 2, 3).unwrap(),
            0.0,
            0.0,
        );
        assert_eq!(output, input);
    }

    #[test]
    fn bilinear_shift_integer_shift_samples_from_target() {
        // 3x3 input with shift (+1, 0): output[y] reads input[y+1] (clamped).
        let input = [1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
        let mut output = [0.0f32; 9];
        apply_bilinear_shift(
            Frame::new(&input, 3, 3).unwrap(),
            &mut FrameMut::new(&mut output, 3, 3).unwrap(),
            1.0,
            0.0,
        );
        assert_eq!(output[0], 4.0); // input[1, 0]
        assert_eq!(output[3], 7.0); // input[2, 0]
        assert_eq!(output[6], 7.0); // clamped: input[2, 0]
    }

    #[test]
    fn bilinear_shift_half_pixel_averages_two_rows() {
        let input = [1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
        let mut output = [0.0f32; 9];
        apply_bilinear_shift(
            Frame::new(&input, 3, 3).unwrap(),
            &mut FrameMut::new(&mut output, 3, 3).unwrap(),
            0.5,
            0.0,
        );
        assert!((output[0] - 2.5).abs() < 1e-6); // 0.5*1 + 0.5*4
        assert!((output[1] - 3.5).abs() < 1e-6); // 0.5*2 + 0.5*5
        assert!((output[6] - 7.0).abs() < 1e-6); // clamped
    }

    #[test]
    fn phase_correlate_identity_peaks_at_origin() {
        // Phase correlation of two identical inputs produces a peak at
        // bin (0, 0). The peak value can be below 1 if some frequency
        // bins fall below PHASE_CORRELATION_EPS and are gated to zero,
        // but it must still be the global maximum by a wide margin.
        let h = 8;
        let w = 8;
        let mut a = vec![0.0f32; h * w];
        for y in 0..h {
            for x in 0..w {
                a[y * w + x] = ((y as f32 - 3.5).powi(2) + (x as f32 - 3.5).powi(2)) * -0.5;
                a[y * w + x] = a[y * w + x].exp();
            }
        }
        let map = phase_correlate(&a, &a, h, w);
        let peak = map[0];
        let max_other = map[1..].iter().copied().fold(f32::NEG_INFINITY, f32::max);
        assert!(peak > 0.3, "peak at (0,0) = {peak}");
        assert!(peak > 3.0 * max_other, "peak {peak} vs next {max_other}");
    }
}
