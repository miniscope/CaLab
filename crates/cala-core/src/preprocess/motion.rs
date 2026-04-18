//! Dual-anchor motion correction via FFT cross-correlation on demeaned,
//! optionally low-passed frames.
//!
//! Per-frame algorithm (design §3):
//!   1. **Prep** the input for correlation: optional Gaussian low-pass
//!      (σ = `cfg.motion_smooth_sigma_px`) to tame per-pixel noise,
//!      then double-center — subtract the row mean + column mean and
//!      add back the global mean. The demean kills vignetting and
//!      uneven illumination in one O(h·w) pass, giving the correlator
//!      a zero-mean input without touching the sharp pipeline output.
//!      This is the NormCorre recipe: normalize rows+cols, then FFT.
//!   2. **Local pass** — cross-correlate the prepped input against the
//!      prepped previous-corrected frame, find peak within
//!      `cfg.motion_max_shift_px`, parabolic-subpixel refine.
//!   3. **Global pass** — when `cfg.motion_use_global_anchor` is true
//!      and at least one prior frame has been seen, apply the local
//!      shift to the prepped intermediate and correlate it against the
//!      prepped running-mean anchor for a drift refinement. Add to
//!      the local shift.
//!   4. Apply the **composite** shift to the **sharp** original input
//!      with a single bilinear resampling (replicate boundary). One
//!      pass avoids stacking interpolation blur.
//!   5. Update local anchor = sharp corrected output; update prepped
//!      local anchor = prep(corrected). Update both sharp and prepped
//!      global anchors via cumulative-mean recurrence.
//!
//! First frame through is the identity: output = input, anchors are
//! initialized from input (prepped equivalents from its demean), shift
//! = (0, 0). After `reset()` the state forgets all anchors and the
//! next call behaves as first-frame again.

use rustfft::{num_complex::Complex32, FftPlanner};

use super::fft2d::{fft_cols, fft_rows};
use super::gaussian::{gaussian_blur, GaussianKernel};
use crate::assets::{Frame, FrameMut, ShapeError};
use crate::config::{MotionCorrelation, MotionSubpixel, PreprocessConfig};

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
///
/// Correlator sees only the center crop of each frame (configurable via
/// `cfg.motion_corr_crop_frac`); the bilinear shift still goes out to
/// the full frame. This keeps lens-edge vignetting and rolloff out of
/// the correlation peak without discarding any pipeline output pixels.
pub struct MotionState {
    height: usize,
    width: usize,
    // Center-crop region fed to the correlator. corr_y0/x0 are the
    // top-left offsets into the full frame; corr_h/w are the dims.
    corr_h: usize,
    corr_w: usize,
    corr_y0: usize,
    corr_x0: usize,
    has_anchor: bool,
    // Sharp anchors at full-frame size — kept for public inspection.
    local_anchor: Vec<f32>,
    global_anchor: Vec<f32>,
    // Prepped (optionally smoothed, then row+col demeaned) anchors —
    // actually used by the correlator, sized to the corr crop. Names
    // kept as `smoothed_*` for historical reasons; the prep step is
    // now demean, not DoG.
    smoothed_local_anchor: Vec<f32>,
    smoothed_global_anchor: Vec<f32>,
    global_count: u64,
    // Per-frame working buffers, all sized to the corr crop.
    shift_scratch: Vec<f32>, // intermediate after local shift (global pass)
    smooth_buf: Vec<f32>,    // prepped current-frame crop fed to correlator
    smooth_row_scratch: Vec<f32>, // row pass of the separable Gaussian
    corr_scratch: Vec<f32>,  // raw center-cropped current frame
    smooth_kernel: Option<GaussianKernel>, // σ_smooth low-pass kernel
    demean_row_means: Vec<f32>, // length corr_h — scratch for double-centering
    demean_col_means: Vec<f32>, // length corr_w — scratch for double-centering
}

impl MotionState {
    /// Build a motion state pulling every motion-relevant parameter
    /// (σ_smooth, corr crop fraction) from a config.
    pub fn with_config(height: usize, width: usize, cfg: &PreprocessConfig) -> Self {
        Self::build(
            height,
            width,
            cfg.motion_smooth_sigma_px,
            cfg.motion_corr_crop_frac,
        )
    }

    fn build(height: usize, width: usize, smooth_sigma_px: f32, crop_frac: f32) -> Self {
        assert!(
            crop_frac > 0.0 && crop_frac <= 1.0,
            "motion crop_frac must be in (0, 1] (got {crop_frac})"
        );
        // Round crop dims down to a multiple of 4: matches BMP row
        // stride (AVI writers/players expect it for uncompressed 8-bit)
        // and gives the FFT a smoother factorization than arbitrary
        // dimensions. Clamp to ≥ 4 so tiny frames still get a valid crop.
        let corr_h_raw = ((height as f32 * crop_frac).round() as usize).clamp(1, height);
        let corr_w_raw = ((width as f32 * crop_frac).round() as usize).clamp(1, width);
        let corr_h = (corr_h_raw & !0x3).max(4).min(height);
        let corr_w = (corr_w_raw & !0x3).max(4).min(width);
        let corr_y0 = (height - corr_h) / 2;
        let corr_x0 = (width - corr_w) / 2;
        let n_full = height * width;
        let n_corr = corr_h * corr_w;
        let smooth_kernel = if smooth_sigma_px > 0.0 {
            Some(GaussianKernel::from_sigma(smooth_sigma_px))
        } else {
            None
        };
        Self {
            height,
            width,
            corr_h,
            corr_w,
            corr_y0,
            corr_x0,
            has_anchor: false,
            local_anchor: vec![0.0; n_full],
            global_anchor: vec![0.0; n_full],
            smoothed_local_anchor: vec![0.0; n_corr],
            smoothed_global_anchor: vec![0.0; n_corr],
            global_count: 0,
            shift_scratch: vec![0.0; n_corr],
            smooth_buf: vec![0.0; n_corr],
            smooth_row_scratch: vec![0.0; n_corr],
            corr_scratch: vec![0.0; n_corr],
            smooth_kernel,
            demean_row_means: vec![0.0; corr_h],
            demean_col_means: vec![0.0; corr_w],
        }
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

    /// View of the sharp full-frame running-mean global anchor, or
    /// `None` until at least one frame has contributed
    /// (`global_count() > 0`).
    pub fn global_anchor(&self) -> Option<Frame<'_>> {
        if self.global_count == 0 {
            return None;
        }
        Some(
            Frame::new(&self.global_anchor, self.height, self.width)
                .expect("invariant: global_anchor length == height * width"),
        )
    }

    /// Forget all anchor state. The next call to `motion_correct`
    /// behaves as the first frame again.
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

        // Produce the correlator-ready version of the current frame:
        // optional Gaussian low-pass followed by row+col demean.
        self.fill_smoothed(input.pixels())?;

        if !self.has_anchor {
            output.pixels_mut().copy_from_slice(input.pixels());
            self.local_anchor.copy_from_slice(input.pixels());
            self.smoothed_local_anchor.copy_from_slice(&self.smooth_buf);
            // Sharp and smoothed global anchors both get seeded with
            // the first frame; the cumulative-mean recurrence below
            // handles subsequent updates symmetrically.
            self.global_anchor.copy_from_slice(input.pixels());
            self.smoothed_global_anchor
                .copy_from_slice(&self.smooth_buf);
            self.global_count = 1;
            self.has_anchor = true;
            return Ok(MotionShift { dy: 0.0, dx: 0.0 });
        }

        let local_shift = detect_shift(
            &self.smooth_buf,
            &self.smoothed_local_anchor,
            self.corr_h,
            self.corr_w,
            cfg.motion_max_shift_px,
            cfg.motion_correlation,
            cfg.motion_subpixel,
            cfg.motion_subpixel_radius,
        );

        let composite_shift = if cfg.motion_use_global_anchor && self.global_count > 0 {
            // Apply local shift to the prepped crop to produce an
            // aligned intermediate, then correlate against the prepped
            // global anchor crop. The final bilinear is applied once
            // to the sharp full-size original with the composite shift
            // so we don't stack interpolations.
            {
                let smooth_in = Frame::new(&self.smooth_buf, self.corr_h, self.corr_w)
                    .expect("smooth_buf length invariant");
                let mut scratch_frame =
                    FrameMut::new(&mut self.shift_scratch, self.corr_h, self.corr_w)
                        .expect("shift_scratch length invariant");
                apply_bilinear_shift(
                    smooth_in,
                    &mut scratch_frame,
                    local_shift.dy,
                    local_shift.dx,
                );
            }
            let global_refinement = detect_shift(
                &self.shift_scratch,
                &self.smoothed_global_anchor,
                self.corr_h,
                self.corr_w,
                cfg.motion_max_shift_px,
                cfg.motion_correlation,
                cfg.motion_subpixel,
                cfg.motion_subpixel_radius,
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
        // Re-prep the sharp corrected output for the next frame's
        // local-anchor correlation. Doing it here (instead of shifting
        // the previous prepped frame) keeps smoothed_local_anchor
        // exactly consistent with the sharp anchor.
        self.fill_smoothed(output.pixels())?;
        self.smoothed_local_anchor.copy_from_slice(&self.smooth_buf);
        update_global_mean(&mut self.global_anchor, output.pixels(), self.global_count);
        update_global_mean(
            &mut self.smoothed_global_anchor,
            &self.smooth_buf,
            self.global_count,
        );
        self.global_count += 1;
        Ok(composite_shift)
    }

    /// Produce the correlator-ready crop of `src` into `self.smooth_buf`.
    ///
    /// Three-stage prep:
    ///   1. Center crop of `src` → `corr_scratch` (lens edges dropped).
    ///   2. Optional Gaussian low-pass (σ_smooth). 0 disables; buffer is
    ///      then a straight copy from `corr_scratch`.
    ///   3. Double-centering — subtract row mean + col mean, add back
    ///      global mean. Kills any residual row/column bias inside the
    ///      crop and guarantees a zero-mean correlator input.
    fn fill_smoothed(&mut self, src: &[f32]) -> Result<(), ShapeError> {
        // Stage 1: copy center crop from full-frame src.
        for y in 0..self.corr_h {
            let src_row = (self.corr_y0 + y) * self.width + self.corr_x0;
            let dst_row = y * self.corr_w;
            self.corr_scratch[dst_row..dst_row + self.corr_w]
                .copy_from_slice(&src[src_row..src_row + self.corr_w]);
        }

        // Stage 2: low-pass, or straight copy when disabled.
        match &self.smooth_kernel {
            Some(kernel) => {
                let frame = Frame::new(&self.corr_scratch, self.corr_h, self.corr_w)
                    .expect("corr_scratch length invariant");
                let mut out = FrameMut::new(&mut self.smooth_buf, self.corr_h, self.corr_w)
                    .expect("smooth_buf length invariant");
                gaussian_blur(frame, &mut out, &mut self.smooth_row_scratch, kernel)?;
            }
            None => {
                self.smooth_buf.copy_from_slice(&self.corr_scratch);
            }
        }

        // Stage 3: double-centering on the prepped crop.
        let h = self.corr_h;
        let w = self.corr_w;
        let inv_w = 1.0 / w as f32;
        let inv_h = 1.0 / h as f32;

        for y in 0..h {
            let row_start = y * w;
            let sum: f32 = self.smooth_buf[row_start..row_start + w].iter().sum();
            self.demean_row_means[y] = sum * inv_w;
        }
        for cm in self.demean_col_means.iter_mut() {
            *cm = 0.0;
        }
        for y in 0..h {
            let row_start = y * w;
            for x in 0..w {
                self.demean_col_means[x] += self.smooth_buf[row_start + x];
            }
        }
        for cm in self.demean_col_means.iter_mut() {
            *cm *= inv_h;
        }
        let global_mean: f32 = self.demean_row_means.iter().sum::<f32>() * inv_h;

        for y in 0..h {
            let rm = self.demean_row_means[y];
            let row_start = y * w;
            let row = &mut self.smooth_buf[row_start..row_start + w];
            for (x, px) in row.iter_mut().enumerate() {
                *px -= rm + self.demean_col_means[x] - global_mean;
            }
        }
        Ok(())
    }
}

/// Cumulative-mean recurrence over a running anchor:
///     g ← (g·count + new) / (count + 1)
/// Called once per corrected frame on both the sharp and smoothed
/// global anchors so each stays the running mean of its own stream.
fn update_global_mean(global: &mut [f32], new: &[f32], count: u64) {
    let n = count as f32;
    let inv = 1.0 / (n + 1.0);
    for (g, &v) in global.iter_mut().zip(new.iter()) {
        *g = (*g * n + v) * inv;
    }
}

/// Correlate `current` against `anchor`, find the peak within the
/// allowed shift radius, and return the full subpixel shift of `current`
/// relative to `anchor`. Correlation method and subpixel refinement
/// method come from the caller.
fn detect_shift(
    current: &[f32],
    anchor: &[f32],
    h: usize,
    w: usize,
    max_shift: u32,
    mode: MotionCorrelation,
    subpixel: MotionSubpixel,
    subpixel_radius: usize,
) -> MotionShift {
    let map = fft_correlate(current, anchor, h, w, mode);
    let (py, px) = find_peak_in_range(&map, h, w, max_shift);
    let (sy, sx) = match subpixel {
        MotionSubpixel::Parabolic => parabolic_subpixel(&map, h, w, py, px),
        MotionSubpixel::Centroid => weighted_centroid_subpixel(&map, h, w, py, px, subpixel_radius),
    };
    MotionShift {
        dy: bin_to_signed_shift(py, h) + sy,
        dx: bin_to_signed_shift(px, w) + sx,
    }
}

/// Compute the 2D correlation map between `a` and `b` via FFT.
///
/// `mode == Cross`: plain cross-correlation, `F · conj(G)` → IFFT. The
/// peak is weighted by the amplitude of coherent structure — best on
/// diffuse/noisy data where phase-only normalization would amplify noise.
///
/// `mode == Phase`: phase correlation, `F · conj(G) / |F · conj(G)|` →
/// IFFT. Sharper peak on clean signals; kept as an option.
///
/// For either mode, a shift of `a` relative to `b` (i.e. `a[n] = b[n−δ]`)
/// places the map's peak at bin `δ`.
fn fft_correlate(a: &[f32], b: &[f32], h: usize, w: usize, mode: MotionCorrelation) -> Vec<f32> {
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

    match mode {
        MotionCorrelation::Cross => {
            for i in 0..a_c.len() {
                a_c[i] *= b_c[i].conj();
            }
        }
        MotionCorrelation::Phase => {
            for i in 0..a_c.len() {
                let r = a_c[i] * b_c[i].conj();
                let mag = (r.re * r.re + r.im * r.im).sqrt();
                a_c[i] = if mag > PHASE_CORRELATION_EPS {
                    r / mag
                } else {
                    Complex32::new(0.0, 0.0)
                };
            }
        }
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

/// Subpixel refinement via weighted center-of-mass over a `(2r+1)²`
/// neighborhood around the integer peak `(py, px)`.
///
/// Subtracts the neighborhood's minimum value before weighting so a
/// constant bias in the correlation surface (common on cross-corr.
/// output) doesn't pull the centroid toward the window center. Peaks
/// near the FFT bin boundary wrap cyclically, matching the output
/// convention of `bin_to_signed_shift`.
///
/// Clamped to `[−r, +r]` on each axis; if all weights are zero (flat
/// window) returns `(0, 0)`.
fn weighted_centroid_subpixel(
    map: &[f32],
    h: usize,
    w: usize,
    py: usize,
    px: usize,
    radius: usize,
) -> (f32, f32) {
    let r = radius as isize;
    let h_i = h as isize;
    let w_i = w as isize;

    let mut local_min = f32::INFINITY;
    for dy in -r..=r {
        let y = (py as isize + dy).rem_euclid(h_i) as usize;
        for dx in -r..=r {
            let x = (px as isize + dx).rem_euclid(w_i) as usize;
            let v = map[y * w + x];
            if v < local_min {
                local_min = v;
            }
        }
    }

    let mut sum_w = 0.0f32;
    let mut sum_wy = 0.0f32;
    let mut sum_wx = 0.0f32;
    for dy in -r..=r {
        let y = (py as isize + dy).rem_euclid(h_i) as usize;
        for dx in -r..=r {
            let x = (px as isize + dx).rem_euclid(w_i) as usize;
            let wgt = (map[y * w + x] - local_min).max(0.0);
            sum_w += wgt;
            sum_wy += wgt * dy as f32;
            sum_wx += wgt * dx as f32;
        }
    }
    if sum_w < 1e-12 {
        return (0.0, 0.0);
    }
    let rf = radius as f32;
    (
        (sum_wy / sum_w).clamp(-rf, rf),
        (sum_wx / sum_w).clamp(-rf, rf),
    )
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
        let map = fft_correlate(&a, &a, h, w, MotionCorrelation::Phase);
        let peak = map[0];
        let max_other = map[1..].iter().copied().fold(f32::NEG_INFINITY, f32::max);
        assert!(peak > 0.3, "peak at (0,0) = {peak}");
        assert!(peak > 3.0 * max_other, "peak {peak} vs next {max_other}");
    }

    #[test]
    fn cross_correlate_identity_peaks_at_origin() {
        // Cross-correlation of two identical blobs produces the
        // autocorrelation; its global maximum must be at bin (0, 0).
        // We don't assert a large margin over neighbors — for a smooth
        // Gaussian blob the autocorrelation is wide and nearby bins
        // sit close to the peak.
        let h = 8;
        let w = 8;
        let mut a = vec![0.0f32; h * w];
        for y in 0..h {
            for x in 0..w {
                a[y * w + x] = ((y as f32 - 3.5).powi(2) + (x as f32 - 3.5).powi(2)) * -0.5;
                a[y * w + x] = a[y * w + x].exp();
            }
        }
        let map = fft_correlate(&a, &a, h, w, MotionCorrelation::Cross);
        let peak = map[0];
        assert!(
            peak > 0.0,
            "autocorrelation peak should be positive: {peak}"
        );
        // Every other bin must be strictly <= peak.
        for (i, &v) in map.iter().enumerate().skip(1) {
            assert!(v <= peak, "bin {i} = {v} exceeds peak {peak}");
        }
    }

    #[test]
    fn cross_correlate_detects_known_integer_shift() {
        // Build a deterministic blobby image, shift it by (dy, dx) = (2, 1),
        // and verify cross-correlation finds the correct peak bin.
        let h = 16;
        let w = 16;
        let mut src = vec![0.0f32; h * w];
        for y in 0..h {
            for x in 0..w {
                let cy = 7.5_f32;
                let cx = 7.5_f32;
                let r2 = ((y as f32) - cy).powi(2) + ((x as f32) - cx).powi(2);
                src[y * w + x] = (-r2 / 4.0).exp();
            }
        }
        let (dy, dx) = (2_usize, 1_usize);
        let mut shifted = vec![0.0f32; h * w];
        for y in 0..h {
            for x in 0..w {
                let sy = y.saturating_sub(dy);
                let sx = x.saturating_sub(dx);
                shifted[y * w + x] = src[sy * w + sx];
            }
        }
        let map = fft_correlate(&shifted, &src, h, w, MotionCorrelation::Cross);
        let (py, px) = find_peak_in_range(&map, h, w, 5);
        let found_dy = bin_to_signed_shift(py, h);
        let found_dx = bin_to_signed_shift(px, w);
        assert_eq!(
            (found_dy as i32, found_dx as i32),
            (dy as i32, dx as i32),
            "integer peak mismatch: got ({found_dy}, {found_dx})",
        );
    }
}
