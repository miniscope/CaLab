//! [`MotionCorrector`]: the stateful, frame-by-frame motion-correction stage.
//! See the [module docs](super) for the method.

use realfft::num_complex::Complex32;

use super::fft2d::fft_friendly_size;
use super::filter::{difference_of_gaussians, gaussian_blur, median3x3, DogScratch};
use super::warp::{Interpolation, Warper};
use super::xcorr::Correlator;
use super::MotionError;

/// The record's template was updated with this frame.
pub const FLAG_TEMPLATE_UPDATED: u32 = 1;
/// Brightness or peak quality was anomalous; the template was not updated.
pub const FLAG_ANOMALOUS: u32 = 2;
/// The frame had nothing to register (blank or flat); the previous shift was held.
pub const FLAG_HELD: u32 = 4;
/// No warm-up was run; this frame became the template.
pub const FLAG_BOOTSTRAP: u32 = 8;
/// The registration region's mean brightness jumped (e.g. a flash).
pub const FLAG_BRIGHTNESS_OUTLIER: u32 = 16;
/// The correlation peak was unusually weak.
pub const FLAG_LOW_QUALITY: u32 = 32;

/// Gain (relative to its peak) below which the DoG pass-band is treated as
/// empty when band-limiting the sub-pixel DFT.
const BAND_GAIN_FLOOR: f64 = 1e-2;
/// Smallest registration region side, in pixels.
const MIN_ROI_SIDE: usize = 16;
/// Rate of the running brightness / quality statistics (per frame).
const STATS_RATE: f32 = 0.02;
/// Smoothing (px) of the maps behind the static-fraction weights.
const WEIGHT_SIGMA: f32 = 2.0;
/// Rate of the running moments behind the static-fraction weights.
const WEIGHT_RATE: f32 = 1.0 / 1000.0;
/// Largest drift of the running template searched against the warm-up one.
const DRIFT_SEARCH_PX: f32 = 4.0;
/// Rate of the running per-patch noise and power estimates (per frame).
const SHRINK_RATE: f32 = 0.05;

/// A rectangle in frame pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Roi {
    pub y0: usize,
    pub x0: usize,
    pub height: usize,
    pub width: usize,
}

/// Piecewise-rigid (non-rigid) refinement settings.
#[derive(Debug, Clone, PartialEq)]
pub struct NonRigidConfig {
    /// Patch grid, `(rows, cols)`, each at least 2. Default 4 x 4.
    pub grid: (usize, usize),
    /// Patch side in pixels; `None` derives it from the registration region
    /// so neighbouring patches overlap by half (`2 * side / (grid + 1)`).
    pub patch_size: Option<usize>,
    /// Largest residual (beyond the rigid shift) searched per patch, px.
    pub max_patch_shift: f32,
    /// A patch whose peak quality is below this fraction of the median patch
    /// quality of the frame is rejected.
    pub min_quality_ratio: f32,
    /// A patch whose residual differs from the median of its accepted
    /// neighbours by more than this (px, either axis) is rejected.
    pub outlier_px: f32,
    /// Weight of the new estimate in the exponential temporal smoother of the
    /// residuals (1 = no smoothing).
    pub temporal_alpha: f32,
    /// Shrink each smoothed residual towards zero by its estimated
    /// signal-to-(signal + noise) power ratio (default true).
    pub shrink: bool,
}

impl Default for NonRigidConfig {
    fn default() -> Self {
        NonRigidConfig {
            grid: (4, 4),
            patch_size: None,
            max_patch_shift: 3.0,
            min_quality_ratio: 0.5,
            outlier_px: 1.0,
            temporal_alpha: 0.5,
            shrink: true,
        }
    }
}

/// How the registration template evolves after the warm-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateStrategy {
    /// The warm-up template, never updated.
    Frozen,
    /// Exponentially weighted running template (time constant
    /// `template_tau`) of rigidly corrected frames, free to drift.
    Running,
    /// Running template whose position is pinned to the warm-up template:
    /// at every refresh it is registered onto the warm-up template and the
    /// offset is added to every shift.
    PinnedToWarmup,
    /// Running template pinned to a slowly growing reference, the cumulative
    /// mean of all corrected frames.
    PinnedToCumulative,
    /// R. Chang's dual anchor: the global template is the cumulative mean of
    /// all corrected frames, and the previous frame (local anchor) seeds the
    /// search: local registration to the previous frame, then the global
    /// refinement against the cumulative mean.
    DualAnchor,
}

/// Motion-correction settings. [`Default`] gives the values below; sizes
/// that depend on the frame (registration region, patch size, the clamp on
/// `max_shift` and `dog_sigma_large`) are derived when the corrector sees
/// its first data.
#[derive(Debug, Clone, PartialEq)]
pub struct MotionConfig {
    /// Largest rigid shift searched, px (default 15; clamped to a quarter of
    /// the registration region).
    pub max_shift: f32,
    /// Registration region. `None` (default) picks the largest square inside
    /// the lit field of view (from [`MotionCorrector::set_fov_mask`] or the
    /// warm-up mean), trimmed to an FFT-friendly side.
    pub roi: Option<Roi>,
    /// Cap on the side of an automatically chosen region (0 = no cap).
    /// Default 384: beyond it accuracy no longer improves but cost does.
    pub roi_max_side: usize,
    /// 3x3 median before the band-pass (default true).
    pub median_prefilter: bool,
    /// DoG high-cut sigma, px (default 1.5).
    pub dog_sigma_small: f32,
    /// DoG low-cut sigma, px (default 15; clamped to region side / 16, so a
    /// small region keeps a sharp correlation peak).
    pub dog_sigma_large: f32,
    /// Tukey window taper fraction (default 0.3).
    pub window_alpha: f32,
    /// Upsampling factor of the sub-pixel DFT (default 10); `<= 1` uses the
    /// parabolic fallback.
    pub upsample: u32,
    /// Warm-up re-registration passes after the initial mean (default 2).
    pub warmup_iterations: usize,
    /// Time constant of the running template, in frames (default 400);
    /// 0 freezes the warm-up template.
    pub template_tau: f32,
    /// Accepted frames between template spectrum refreshes (default 20).
    pub template_refresh: usize,
    /// How the template evolves (default [`TemplateStrategy::PinnedToWarmup`]).
    /// `template_tau == 0` also freezes it.
    pub template_strategy: TemplateStrategy,
    /// Weight each pixel of the registration crop by its static fraction,
    /// `T^2 / (T^2 + var_t)` (smoothed; template `T`, temporal variance of the
    /// corrected frames `var_t`), so content that changes over time (active
    /// cells) pulls less on the peak. Estimated during warm-up and refreshed
    /// slowly. Default off.
    pub variance_weighting: bool,
    /// Robust z-score beyond which a frame's brightness or (low) peak
    /// quality counts as anomalous (default 6).
    pub anomaly_threshold: f32,
    /// Weight of the local anchor (registration against the previous frame,
    /// chained onto its shift) blended with the template estimate; 0
    /// (default) disables it.
    pub anchor_weight: f32,
    /// Non-rigid refinement; `None` (default) for rigid only.
    pub nonrigid: Option<NonRigidConfig>,
    /// Resampling kernel for the corrected frame (default bicubic).
    pub interpolation: Interpolation,
}

impl Default for MotionConfig {
    fn default() -> Self {
        MotionConfig {
            max_shift: 15.0,
            roi: None,
            roi_max_side: 384,
            median_prefilter: true,
            dog_sigma_small: 1.5,
            dog_sigma_large: 15.0,
            window_alpha: 0.3,
            upsample: 10,
            warmup_iterations: 2,
            template_tau: 400.0,
            template_refresh: 20,
            template_strategy: TemplateStrategy::PinnedToWarmup,
            variance_weighting: false,
            anomaly_threshold: 6.0,
            anchor_weight: 0.0,
            nonrigid: None,
            interpolation: Interpolation::Bicubic,
        }
    }
}

impl MotionConfig {
    fn validate(&self) -> Result<(), MotionError> {
        let bad = |m: &str| Err(MotionError::InvalidConfig(m.into()));
        if !(self.max_shift.is_finite() && self.max_shift >= 1.0) {
            return bad("max_shift must be at least 1 px");
        }
        if !(self.dog_sigma_small >= 0.0 && self.dog_sigma_large > self.dog_sigma_small) {
            return bad("need 0 <= dog_sigma_small < dog_sigma_large");
        }
        if !(0.0..=1.0).contains(&self.window_alpha) {
            return bad("window_alpha must be in [0, 1]");
        }
        if self.upsample > 100 {
            return bad("upsample must be at most 100");
        }
        if !(self.template_tau >= 0.0 && self.template_tau.is_finite()) {
            return bad("template_tau must be finite and non-negative");
        }
        if self.anomaly_threshold.is_nan() || self.anomaly_threshold <= 0.0 {
            return bad("anomaly_threshold must be positive");
        }
        if !(0.0..=1.0).contains(&self.anchor_weight) {
            return bad("anchor_weight must be in [0, 1]");
        }
        if let Some(nr) = &self.nonrigid {
            if nr.grid.0 < 2 || nr.grid.1 < 2 || nr.grid.0 > 16 || nr.grid.1 > 16 {
                return bad("nonrigid grid must be between 2x2 and 16x16");
            }
            if !(nr.max_patch_shift >= 0.5 && nr.max_patch_shift.is_finite()) {
                return bad("max_patch_shift must be at least 0.5 px");
            }
            if !(nr.temporal_alpha > 0.0 && nr.temporal_alpha <= 1.0) {
                return bad("temporal_alpha must be in (0, 1]");
            }
            if nr.outlier_px.is_nan()
                || nr.outlier_px <= 0.0
                || !(0.0..1.0).contains(&nr.min_quality_ratio)
            {
                return bad("outlier_px must be positive and min_quality_ratio in [0, 1)");
            }
        }
        Ok(())
    }
}

/// One frame's pixels.
#[derive(Debug, Clone, Copy)]
pub enum Frame<'a> {
    U8(&'a [u8]),
    F32(&'a [f32]),
}

impl Frame<'_> {
    fn len(&self) -> usize {
        match self {
            Frame::U8(p) => p.len(),
            Frame::F32(p) => p.len(),
        }
    }

    fn to_f32(self, out: &mut [f32]) -> Result<(), MotionError> {
        match self {
            Frame::U8(p) => {
                for (o, &v) in out.iter_mut().zip(p) {
                    *o = v as f32;
                }
            }
            Frame::F32(p) => {
                if p.iter().any(|v| !v.is_finite()) {
                    return Err(MotionError::NonFinite(
                        "frame contains NaN or infinity".into(),
                    ));
                }
                out.copy_from_slice(p);
            }
        }
        Ok(())
    }
}

/// Several frames stored back to back, `count * height * width` values.
#[derive(Debug, Clone, Copy)]
pub enum Frames<'a> {
    U8(&'a [u8]),
    F32(&'a [f32]),
}

impl<'a> Frames<'a> {
    fn len(&self) -> usize {
        match self {
            Frames::U8(p) => p.len(),
            Frames::F32(p) => p.len(),
        }
    }

    /// Frame `i` of a batch of frames of `px` pixels.
    pub fn frame(&self, i: usize, px: usize) -> Frame<'a> {
        match *self {
            Frames::U8(p) => Frame::U8(&p[i * px..(i + 1) * px]),
            Frames::F32(p) => Frame::F32(&p[i * px..(i + 1) * px]),
        }
    }
}

/// Everything needed to estimate nothing and replay a frame: the rigid shift,
/// the residual patch grid, and diagnostics.
#[derive(Debug, Clone, PartialEq)]
pub struct MotionRecord {
    /// Rigid shift registering the frame onto the template, rows (px).
    pub dy: f32,
    /// Rigid shift registering the frame onto the template, columns (px).
    pub dx: f32,
    /// Normalised cross-correlation of the band-passed frame with the
    /// template at the rigid peak (0 when nothing could be registered).
    pub quality: f32,
    /// Bit set of `FLAG_*`.
    pub flags: u32,
    /// Residual (non-rigid) shift at each patch centre, `(row, col, axis)`
    /// row-major with axis 0 = dy, 1 = dx; empty for rigid-only.
    pub residual: Vec<f32>,
}

impl MotionRecord {
    /// Length of a flat record carrying `residual_len` residual values.
    pub fn flat_len(residual_len: usize) -> usize {
        4 + residual_len
    }

    /// `[dy, dx, quality, flags, residual...]`.
    pub fn write_flat(&self, out: &mut [f32]) -> Result<(), MotionError> {
        if out.len() != Self::flat_len(self.residual.len()) {
            return Err(MotionError::SizeMismatch(format!(
                "flat record holds {} values, need {}",
                out.len(),
                Self::flat_len(self.residual.len())
            )));
        }
        out[0] = self.dy;
        out[1] = self.dx;
        out[2] = self.quality;
        out[3] = self.flags as f32;
        out[4..].copy_from_slice(&self.residual);
        Ok(())
    }

    /// Inverse of [`write_flat`](Self::write_flat).
    pub fn from_flat(flat: &[f32]) -> Result<Self, MotionError> {
        if flat.len() < 4 {
            return Err(MotionError::InvalidRecord(format!(
                "flat record has {} values, need at least 4",
                flat.len()
            )));
        }
        Ok(MotionRecord {
            dy: flat[0],
            dx: flat[1],
            quality: flat[2],
            flags: flat[3].max(0.0) as u32,
            residual: flat[4..].to_vec(),
        })
    }
}

/// Geometry that, with a record, determines a correction exactly.
#[derive(Debug, Clone, PartialEq)]
pub struct MotionGeometry {
    pub height: usize,
    pub width: usize,
    pub roi: Roi,
    /// Patch-centre rows in frame pixels (empty for rigid-only).
    pub node_ys: Vec<f64>,
    /// Patch-centre columns in frame pixels (empty for rigid-only).
    pub node_xs: Vec<f64>,
    pub interpolation: Interpolation,
}

impl MotionGeometry {
    /// A [`Warper`] that replays records of this geometry.
    pub fn warper(&self) -> Result<Warper, MotionError> {
        Warper::new(
            self.height,
            self.width,
            &self.node_ys,
            &self.node_xs,
            self.interpolation,
        )
    }
}

/// Exponentially weighted location and mean absolute deviation.
#[derive(Debug, Clone, Copy)]
struct Tracker {
    mean: f32,
    dev: f32,
    floor: f32,
}

impl Tracker {
    fn from_samples(v: &[f32], floor: f32) -> Self {
        let mut s: Vec<f32> = v.iter().copied().filter(|x| x.is_finite()).collect();
        if s.is_empty() {
            return Tracker {
                mean: 0.0,
                dev: floor,
                floor,
            };
        }
        s.sort_by(f32::total_cmp);
        let med = s[s.len() / 2];
        let mut d: Vec<f32> = s.iter().map(|x| (x - med).abs()).collect();
        d.sort_by(f32::total_cmp);
        Tracker {
            mean: med,
            dev: d[d.len() / 2].max(floor),
            floor,
        }
    }

    fn z(&self, v: f32) -> f32 {
        (v - self.mean) / self.dev.max(self.floor)
    }

    /// Update with `v`, winsorised at `k` deviations so a single outlier
    /// barely moves the statistics while a lasting step (a new brightness
    /// level after a file boundary, say) is still followed within a few
    /// dozen frames instead of locking every later frame out.
    fn update(&mut self, v: f32, k: f32) {
        let lim = k * self.dev.max(self.floor);
        let d = (v - self.mean).clamp(-lim, lim);
        self.mean += STATS_RATE * d;
        self.dev += STATS_RATE * (d.abs() - self.dev);
    }
}

/// Median-plus-DoG prefilter of the extended registration region (the
/// region plus a margin, so crops at shifted positions see the same filter
/// response as the template and no artificial region edge).
struct Prefilter {
    /// Region whose mean raw brightness is reported.
    roi: Roi,
    /// Region that is filtered.
    ext: Roi,
    median: bool,
    s1: f32,
    s2: f32,
    raw: Vec<f32>,
    med: Vec<f32>,
    med_scratch: Vec<f32>,
    dog: DogScratch,
}

impl Prefilter {
    /// Filter the extended region of `frame` (full `width`) into `out`;
    /// returns the mean raw brightness of the registration region.
    fn run(&mut self, frame: &[f32], width: usize, out: &mut [f32]) -> f32 {
        let Roi {
            y0,
            x0,
            height: h,
            width: w,
        } = self.ext;
        for y in 0..h {
            let src = &frame[(y0 + y) * width + x0..][..w];
            self.raw[y * w..][..w].copy_from_slice(src);
        }
        let brightness = self.brightness(frame, width);
        let input = if self.median {
            median3x3(&self.raw, h, w, &mut self.med, &mut self.med_scratch);
            &self.med
        } else {
            &self.raw
        };
        difference_of_gaussians(input, h, w, self.s1, self.s2, out, &mut self.dog);
        brightness
    }

    /// Mean raw brightness of the registration region of `frame`.
    fn brightness(&self, frame: &[f32], width: usize) -> f32 {
        let r = self.roi;
        let mut sum = 0.0f64;
        for y in 0..r.height {
            let src = &frame[(r.y0 + y) * width + r.x0..][..r.width];
            sum += src.iter().map(|&v| v as f64).sum::<f64>();
        }
        (sum / (r.height * r.width) as f64) as f32
    }
}

/// Per-patch registration state.
struct Patches {
    cfg: NonRigidConfig,
    gy: usize,
    gx: usize,
    size: usize,
    /// Patch top-left corners in region coordinates, row-major.
    origins: Vec<(usize, usize)>,
    corr: Correlator,
    t_specs: Vec<Vec<Complex32>>,
    t_energy: Vec<f64>,
    buf: Vec<f32>,
    f_spec: Vec<Complex32>,
    /// Temporally smoothed residuals, `2 * gy * gx`.
    smoothed: Vec<f32>,
    /// Previous raw residuals and running noise / total power per value.
    prev_raw: Vec<f32>,
    noise_var: Vec<f32>,
    power: Vec<f32>,
    /// The last residuals output (held on degenerate frames).
    last: Vec<f32>,
    started: bool,
    raw: Vec<f32>,
    quality: Vec<f32>,
    valid: Vec<bool>,
}

impl Patches {
    fn refresh(&mut self, template: &[f32], roi_w: usize) -> Result<(), MotionError> {
        let p = self.size;
        for (idx, &(oy, ox)) in self.origins.iter().enumerate() {
            for y in 0..p {
                self.buf[y * p..][..p].copy_from_slice(&template[(oy + y) * roi_w + ox..][..p]);
            }
            self.t_energy[idx] = self.corr.spectrum(&self.buf, &mut self.t_specs[idx])?;
        }
        Ok(())
    }

    /// Residual shifts (beyond `rigid`) of every patch of the filtered
    /// region, regularised and smoothed; written into `out`.
    #[allow(clippy::too_many_arguments)]
    fn estimate(
        &mut self,
        filtered: &[f32],
        ext: Roi,
        roi: Roi,
        rigid: (f32, f32),
        upsample: u32,
        out: &mut [f32],
    ) -> Result<(), MotionError> {
        let p = self.size;
        let (ry, rx) = (rigid.0.round() as isize, rigid.1.round() as isize);
        let max_oy = (ext.height - p) as isize;
        let max_ox = (ext.width - p) as isize;
        // Region coordinates of the extended-region origin.
        let (ey, ex) = (
            ext.y0 as isize - roi.y0 as isize,
            ext.x0 as isize - roi.x0 as isize,
        );
        let n = self.origins.len();
        for idx in 0..n {
            let (ty, tx) = self.origins[idx];
            // Template patch at `t` matches frame content at `t - s`.
            let fy = (ty as isize - ry - ey).clamp(0, max_oy) as usize;
            let fx = (tx as isize - rx - ex).clamp(0, max_ox) as usize;
            for y in 0..p {
                self.buf[y * p..][..p].copy_from_slice(&filtered[(fy + y) * ext.width + fx..][..p]);
            }
            let (fy, fx) = (fy as isize + ey, fx as isize + ex);
            let e = self.corr.spectrum(&self.buf, &mut self.f_spec)?;
            let peak = self.corr.register(
                &self.t_specs[idx],
                self.t_energy[idx],
                &self.f_spec,
                e,
                self.cfg.max_patch_shift + 0.5,
                upsample,
            )?;
            self.raw[2 * idx] = (ty as isize - fy) as f32 + peak.dy - rigid.0;
            self.raw[2 * idx + 1] = (tx as isize - fx) as f32 + peak.dx - rigid.1;
            self.quality[idx] = peak.ncc;
        }
        self.regularize();
        let a = self.cfg.temporal_alpha;
        if !self.started {
            self.smoothed.copy_from_slice(&self.raw);
            self.prev_raw.copy_from_slice(&self.raw);
            self.started = true;
        }
        for i in 0..self.raw.len() {
            let r = self.raw[i];
            self.smoothed[i] += a * (r - self.smoothed[i]);
            // Noise variance from frame-to-frame differences (the deformation
            // itself changes over many frames), total power around zero.
            let d = r - self.prev_raw[i];
            self.noise_var[i] += SHRINK_RATE * (0.5 * d * d - self.noise_var[i]);
            self.power[i] += SHRINK_RATE * (r * r - self.power[i]);
            self.prev_raw[i] = r;
        }
        // Wiener-style shrinkage towards zero (rigid): keep the smoothed
        // residual in proportion to how much of its power is signal, so noisy
        // patches cannot make the correction worse than rigid.
        let smooth_noise = a / (2.0 - a);
        for (i, o) in out.iter_mut().enumerate() {
            let noise = self.noise_var[i];
            let signal = (self.power[i] - noise).max(0.0);
            let g = if self.cfg.shrink {
                signal / (signal + smooth_noise * noise + 1e-12)
            } else {
                1.0
            };
            *o = g * self.smoothed[i];
        }
        self.last.copy_from_slice(out);
        Ok(())
    }

    /// Reject low-quality patches and patches that disagree with their
    /// neighbours, replacing them with the neighbour median.
    fn regularize(&mut self) {
        let (gy, gx) = (self.gy, self.gx);
        let mut q: Vec<f32> = self.quality.clone();
        q.sort_by(f32::total_cmp);
        let qmed = q[q.len() / 2];
        let qmin = (self.cfg.min_quality_ratio * qmed).max(1e-3);
        let lim = self.cfg.max_patch_shift;
        for (i, v) in self.valid.iter_mut().enumerate() {
            let (a, b) = (self.raw[2 * i], self.raw[2 * i + 1]);
            *v = self.quality[i] >= qmin && a.abs() <= lim && b.abs() <= lim;
        }
        let neighbour_median = |raw: &[f32], valid: &[bool], i: usize, j: usize, c: usize| {
            let mut v = Vec::with_capacity(8);
            for di in -1isize..=1 {
                for dj in -1isize..=1 {
                    let (ni, nj) = (i as isize + di, j as isize + dj);
                    if (di, dj) == (0, 0)
                        || ni < 0
                        || nj < 0
                        || ni >= gy as isize
                        || nj >= gx as isize
                    {
                        continue;
                    }
                    let k = ni as usize * gx + nj as usize;
                    if valid[k] {
                        v.push(raw[2 * k + c]);
                    }
                }
            }
            median(&mut v)
        };
        let mut keep = self.valid.clone();
        for i in 0..gy {
            for j in 0..gx {
                let k = i * gx + j;
                if !self.valid[k] {
                    continue;
                }
                for c in 0..2 {
                    if let Some(m) = neighbour_median(&self.raw, &self.valid, i, j, c) {
                        if (self.raw[2 * k + c] - m).abs() > self.cfg.outlier_px {
                            keep[k] = false;
                        }
                    }
                }
            }
        }
        let snapshot = self.raw.clone();
        for i in 0..gy {
            for j in 0..gx {
                let k = i * gx + j;
                if keep[k] {
                    continue;
                }
                for c in 0..2 {
                    self.raw[2 * k + c] =
                        neighbour_median(&snapshot, &keep, i, j, c).unwrap_or(0.0);
                }
            }
        }
        self.valid = keep;
    }
}

fn median(v: &mut [f32]) -> Option<f32> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f32::total_cmp);
    let n = v.len();
    Some(if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    })
}

/// State that exists once the registration region is known.
struct Engine {
    roi: Roi,
    /// The region plus its filtering margin.
    ext: Roi,
    /// Region-sized crop of the filtered extended region, at the frame's
    /// current integer offset.
    crop: Vec<f32>,
    /// Integer offset of `crop`.
    offset: (isize, isize),
    max_shift: f32,
    pre: Prefilter,
    corr: Correlator,
    template: Vec<f32>,
    t_spec: Vec<Complex32>,
    t_energy: f64,
    filtered: Vec<f32>,
    f_spec: Vec<Complex32>,
    prev_spec: Vec<Complex32>,
    prev_energy: f64,
    prev_shift: Option<(f32, f32)>,
    /// Previous frame's shift relative to its crop offset (for the anchor).
    prev_rel: (f32, f32),
    patches: Option<Patches>,
    roi_warper: Warper,
    /// Patch-centre rows / columns in region coordinates.
    node_ys: Vec<f64>,
    node_xs: Vec<f64>,
    warped_roi: Vec<f32>,
    brightness: Tracker,
    quality: Tracker,
    accepted_since_refresh: usize,
    /// The warm-up template (the position reference of `PinnedToWarmup`).
    t0: Vec<f32>,
    /// Spectrum and energy of the pinning reference (scratch).
    ref_spec: Vec<Complex32>,
    /// Shift registering the running template onto its reference.
    drift: (f32, f32),
    upsample: u32,
    strategy: TemplateStrategy,
    /// Cumulative mean of corrected crops (in output coordinates) and its count.
    cum: Vec<f32>,
    cum_n: f64,
    /// Static-fraction weights (empty when off), the running first and second
    /// moments they come from, and scratch.
    weight: Vec<f32>,
    m1: Vec<f32>,
    m2: Vec<f32>,
    weighted: Vec<f32>,
    wtmp: Vec<f32>,
    wtmp2: Vec<f32>,
    blur_scratch: Vec<f32>,
}

/// Outcome of registering one frame's crop against the template.
struct Registration {
    /// Total registering shift.
    shift: (f32, f32),
    /// Shift of the final crop relative to its offset.
    rel: (f32, f32),
    ncc: f32,
    energy: f64,
}

/// Residual (crop-relative) shift beyond which the crop is re-cut at the
/// rounded total shift and registered again.
const RECROP_PX: f32 = 0.75;

impl Engine {
    /// Cut the region-sized crop of the filtered extended region whose
    /// content matches the template when the frame is shifted by the integer
    /// `offset` (clamped to the margin); records the offset used.
    fn cut(&mut self, offset: (isize, isize)) {
        let (rh, rw) = (self.roi.height, self.roi.width);
        let ey = self.roi.y0 as isize - self.ext.y0 as isize;
        let ex = self.roi.x0 as isize - self.ext.x0 as isize;
        let cy = (ey - offset.0).clamp(0, (self.ext.height - rh) as isize);
        let cx = (ex - offset.1).clamp(0, (self.ext.width - rw) as isize);
        self.offset = (ey - cy, ex - cx);
        let (cy, cx) = (cy as usize, cx as usize);
        for y in 0..rh {
            self.crop[y * rw..][..rw]
                .copy_from_slice(&self.filtered[(cy + y) * self.ext.width + cx..][..rw]);
        }
    }

    /// Register the filtered frame: cut at the predicted integer shift,
    /// correlate, and if the residual exceeds [`RECROP_PX`] cut again at the
    /// new estimate, so the final crop is aligned to within a fraction of a
    /// pixel and window-edge effects are negligible.
    fn register(
        &mut self,
        predicted: (f32, f32),
        max_shift: f32,
        upsample: u32,
    ) -> Result<Registration, MotionError> {
        let round = |v: (f32, f32)| (v.0.round() as isize, v.1.round() as isize);
        self.cut(round(predicted));
        let mut energy = self.crop_spectrum()?;
        let mut peak = self.corr.register(
            &self.t_spec,
            self.t_energy,
            &self.f_spec,
            energy,
            max_shift,
            upsample,
        )?;
        if peak.dy.abs() > RECROP_PX || peak.dx.abs() > RECROP_PX {
            let first = self.offset;
            let total = (first.0 as f32 + peak.dy, first.1 as f32 + peak.dx);
            self.cut(round(total));
            if self.offset != first {
                energy = self.crop_spectrum()?;
                peak = self.corr.register(
                    &self.t_spec,
                    self.t_energy,
                    &self.f_spec,
                    energy,
                    2.0 * RECROP_PX + 1.0,
                    upsample,
                )?;
            }
        }
        let rel = (peak.dy, peak.dx);
        Ok(Registration {
            shift: (self.offset.0 as f32 + rel.0, self.offset.1 as f32 + rel.1),
            rel,
            ncc: peak.ncc,
            energy,
        })
    }

    /// Spectrum of the current crop (weighted when enabled) into `f_spec`.
    fn crop_spectrum(&mut self) -> Result<f64, MotionError> {
        if self.weight.is_empty() {
            return self.corr.spectrum(&self.crop, &mut self.f_spec);
        }
        for ((o, &c), &w) in self.weighted.iter_mut().zip(&self.crop).zip(&self.weight) {
            *o = c * w;
        }
        self.corr.spectrum(&self.weighted, &mut self.f_spec)
    }

    /// Spectrum of a region-sized image (weighted when enabled).
    fn image_spectrum(&mut self, which: Image, out: Out) -> Result<f64, MotionError> {
        let img: &[f32] = match which {
            Image::Template => &self.template,
            Image::WarmUp => &self.t0,
            Image::Cumulative => &self.cum,
        };
        let spec = match out {
            Out::Template => &mut self.t_spec,
            Out::Reference => &mut self.ref_spec,
        };
        if self.weight.is_empty() {
            return self.corr.spectrum(img, spec);
        }
        for ((o, &c), &w) in self.weighted.iter_mut().zip(img).zip(&self.weight) {
            *o = c * w;
        }
        self.corr.spectrum(&self.weighted, spec)
    }

    /// Recompute the static-fraction weights from the running moments.
    fn refresh_weights(&mut self) {
        if self.weight.is_empty() {
            return;
        }
        let (h, w) = (self.roi.height, self.roi.width);
        for ((t2, v), (&a, &b)) in self
            .wtmp
            .iter_mut()
            .zip(self.wtmp2.iter_mut())
            .zip(self.m1.iter().zip(&self.m2))
        {
            *t2 = a * a;
            *v = (b - a * a).max(0.0);
        }
        // Smooth both maps (sigma 2 px) and form T^2 / (T^2 + var).
        gaussian_blur(
            &self.wtmp,
            h,
            w,
            WEIGHT_SIGMA,
            &mut self.weighted,
            &mut self.blur_scratch,
        );
        std::mem::swap(&mut self.wtmp, &mut self.weighted);
        gaussian_blur(
            &self.wtmp2,
            h,
            w,
            WEIGHT_SIGMA,
            &mut self.weighted,
            &mut self.blur_scratch,
        );
        for ((wt, &t2), &v) in self.weight.iter_mut().zip(&self.wtmp).zip(&self.weighted) {
            *wt = if t2 + v > 0.0 { t2 / (t2 + v) } else { 0.0 };
        }
    }

    fn refresh_spectra(&mut self) -> Result<(), MotionError> {
        self.refresh_weights();
        self.t_energy = self.image_spectrum(Image::Template, Out::Template)?;
        if let Some(p) = &mut self.patches {
            p.refresh(&self.template, self.roi.width)?;
        }
        self.accepted_since_refresh = 0;
        // Pin the running template's position to its reference: a frame
        // registered onto the running template with shift `s` is registered
        // onto the reference with `s + drift`.
        let reference = match self.strategy {
            TemplateStrategy::PinnedToWarmup if !self.t0.is_empty() => Image::WarmUp,
            TemplateStrategy::PinnedToCumulative if !self.cum.is_empty() => Image::Cumulative,
            _ => return Ok(()),
        };
        let e_ref = self.image_spectrum(reference, Out::Reference)?;
        let d = self.corr.register(
            &self.ref_spec,
            e_ref,
            &self.t_spec,
            self.t_energy,
            DRIFT_SEARCH_PX,
            self.upsample,
        )?;
        if d.ncc > 0.0 {
            self.drift = (d.dy, d.dx);
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum Image {
    Template,
    WarmUp,
    Cumulative,
}

#[derive(Clone, Copy)]
enum Out {
    Template,
    Reference,
}

/// State of a streaming warm-up (see [`MotionCorrector::warmup_begin`]).
#[derive(Default)]
struct Warm {
    /// Built on the first pushed batch.
    eng: Option<Engine>,
    /// Filtered extended region of every pushed frame, back to back.
    stored: Vec<f32>,
    /// Running sum of the zero-shift crops (pass 0).
    acc: Vec<f32>,
    brightness: Vec<f32>,
    n: usize,
}

/// The warm-up passes after the plain mean: `acc` is the sum of the `n`
/// zero-shift crops; `load(eng, i)` must put frame `i`'s filtered extended
/// region into `eng.filtered`. Leaves `eng` ready to stream.
fn refine_template(
    cfg: &MotionConfig,
    eng: &mut Engine,
    n: usize,
    mut acc: Vec<f32>,
    brightness: Vec<f32>,
    mut load: impl FnMut(&mut Engine, usize) -> Result<(), MotionError>,
) -> Result<(), MotionError> {
    let rpx = eng.roi.height * eng.roi.width;
    eng.template
        .iter_mut()
        .zip(&acc)
        .for_each(|(t, &a)| *t = a / n as f32);
    let mut quality = Vec::with_capacity(n);
    let mut acc2 = vec![0.0f32; rpx];
    for _ in 0..cfg.warmup_iterations {
        eng.refresh_spectra()?;
        acc.fill(0.0);
        acc2.fill(0.0);
        quality.clear();
        for i in 0..n {
            load(eng, i)?;
            let reg = eng.register((0.0, 0.0), eng.max_shift, cfg.upsample)?;
            quality.push(reg.ncc);
            eng.roi_warper
                .warp(&eng.crop, reg.rel, &[], &mut eng.warped_roi, None)?;
            for ((a, a2), &v) in acc.iter_mut().zip(acc2.iter_mut()).zip(&eng.warped_roi) {
                *a += v;
                *a2 += v * v;
            }
        }
        eng.template
            .iter_mut()
            .zip(&acc)
            .for_each(|(t, &a)| *t = a / n as f32);
    }
    if cfg.variance_weighting && cfg.warmup_iterations > 0 {
        eng.m1 = eng.template.clone();
        eng.m2 = acc2.iter().map(|&v| v / n as f32).collect();
        eng.weight = vec![1.0; rpx];
    }
    eng.t0 = eng.template.clone();
    eng.cum = eng.template.clone();
    eng.cum_n = n as f64;
    eng.drift = (0.0, 0.0);
    eng.refresh_spectra()?;
    let bscale = brightness.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
    eng.brightness = Tracker::from_samples(&brightness, 1e-3 * bscale + 1e-6);
    eng.quality = Tracker::from_samples(&quality, 0.01);
    Ok(())
}

/// What an external prefilter needs to match the CPU one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrefilterParams {
    /// Filtered (extended) region.
    pub ext: Roi,
    /// Registration region (inside `ext`).
    pub roi: Roi,
    pub median: bool,
    pub sigma_small: f32,
    pub sigma_large: f32,
}

/// Streaming motion corrector for `height x width` frames.
pub struct MotionCorrector {
    h: usize,
    w: usize,
    cfg: MotionConfig,
    fov_mask: Option<Vec<bool>>,
    engine: Option<Engine>,
    warper: Warper,
    geometry: Option<MotionGeometry>,
    frame: Vec<f32>,
    warm: Option<Warm>,
}

impl MotionCorrector {
    /// Corrector for `height x width` frames.
    pub fn new(height: usize, width: usize, config: MotionConfig) -> Result<Self, MotionError> {
        config.validate()?;
        if height < MIN_ROI_SIDE || width < MIN_ROI_SIDE {
            return Err(MotionError::InvalidConfig(format!(
                "frame {height}x{width} is too small (need at least {MIN_ROI_SIDE}x{MIN_ROI_SIDE})"
            )));
        }
        if let Some(r) = config.roi {
            if r.height < MIN_ROI_SIDE
                || r.width < MIN_ROI_SIDE
                || r.y0 + r.height > height
                || r.x0 + r.width > width
            {
                return Err(MotionError::InvalidConfig(format!(
                    "roi {r:?} must lie inside the {height}x{width} frame and be at least {MIN_ROI_SIDE} px"
                )));
            }
        }
        Ok(MotionCorrector {
            h: height,
            w: width,
            warper: Warper::new(height, width, &[], &[], config.interpolation)?,
            cfg: config,
            fov_mask: None,
            engine: None,
            geometry: None,
            frame: vec![0.0; height * width],
            warm: None,
        })
    }

    pub fn config(&self) -> &MotionConfig {
        &self.cfg
    }

    pub fn height(&self) -> usize {
        self.h
    }

    pub fn width(&self) -> usize {
        self.w
    }

    /// Restrict the automatic registration region to the lit field of view:
    /// `mask` is `height * width`, nonzero = inside. Must be called before
    /// the template exists.
    pub fn set_fov_mask(&mut self, mask: &[u8]) -> Result<(), MotionError> {
        if mask.len() != self.h * self.w {
            return Err(MotionError::SizeMismatch(format!(
                "mask has {} pixels, frame has {}",
                mask.len(),
                self.h * self.w
            )));
        }
        if self.engine.is_some() || self.warm.is_some() {
            return Err(MotionError::InvalidConfig(
                "set the FOV mask before initialising".into(),
            ));
        }
        self.fov_mask = Some(mask.iter().map(|&v| v != 0).collect());
        Ok(())
    }

    /// Geometry of the correction, once the template exists.
    pub fn geometry(&self) -> Option<&MotionGeometry> {
        self.geometry.as_ref()
    }

    /// Whether a template exists.
    pub fn is_initialized(&self) -> bool {
        self.engine.is_some()
    }

    /// Residual values per record (`2 * rows * cols` of the patch grid, 0 for
    /// rigid-only).
    pub fn residual_len(&self) -> usize {
        self.cfg
            .nonrigid
            .as_ref()
            .map_or(0, |n| 2 * n.grid.0 * n.grid.1)
    }

    /// Length of one flat record (see [`MotionRecord::write_flat`]).
    pub fn record_len(&self) -> usize {
        MotionRecord::flat_len(self.residual_len())
    }

    /// The current band-passed template (registration region), if any.
    pub fn template(&self) -> Option<&[f32]> {
        self.engine.as_ref().map(|e| e.template.as_slice())
    }

    /// Build the warm-up template from `frames` (typically the first ~200 of
    /// the recording): their mean, then `warmup_iterations` rounds of
    /// registering every frame to it and re-averaging. Replaces any existing
    /// template and resets the streaming state.
    pub fn initialize(&mut self, frames: Frames<'_>) -> Result<(), MotionError> {
        let px = self.h * self.w;
        if frames.len() == 0 || !frames.len().is_multiple_of(px) {
            return Err(MotionError::SizeMismatch(format!(
                "warm-up buffer of {} values is not a positive multiple of the {px}-pixel frame",
                frames.len()
            )));
        }
        let n = frames.len() / px;
        // Validate everything first, and accumulate the mean for the region.
        let mut mean = vec![0.0f32; px];
        for i in 0..n {
            frames.frame(i, px).to_f32(&mut self.frame)?;
            for (m, &v) in mean.iter_mut().zip(&self.frame) {
                *m += v / n as f32;
            }
        }
        let roi = match self.cfg.roi {
            Some(r) => r,
            None => self.auto_roi(&mean),
        };
        let mut eng = self.build_engine(roi)?;
        let rpx = roi.height * roi.width;
        let mut acc = vec![0.0f32; rpx];
        let mut brightness = Vec::with_capacity(n);

        // Pass 0: plain mean of the band-passed regions.
        for i in 0..n {
            frames.frame(i, px).to_f32(&mut self.frame)?;
            let b = eng.pre.run(&self.frame, self.w, &mut eng.filtered);
            brightness.push(b);
            eng.cut((0, 0));
            for (a, &v) in acc.iter_mut().zip(&eng.crop) {
                *a += v;
            }
        }
        let (w, scratch) = (self.w, &mut self.frame);
        refine_template(&self.cfg, &mut eng, n, acc, brightness, |eng, i| {
            frames.frame(i, px).to_f32(scratch)?;
            eng.pre.run(scratch, w, &mut eng.filtered);
            Ok(())
        })?;
        self.install(eng);
        Ok(())
    }

    /// Start a streaming warm-up: the same template as [`initialize`], built
    /// from frames pushed batch by batch with [`warmup_push`], then closed
    /// with [`warmup_finish`].
    ///
    /// The template needs `warmup_iterations + 1` passes over the frames, so
    /// they cannot be dropped after one look. What is kept is only what the
    /// passes read: each frame's band-passed registration region plus its
    /// filtering margin (about half a 600x600 frame at the default region
    /// cap), as `f32`. The raw or preprocessed frame is never held, and
    /// the band-pass runs once per frame instead of once per pass. Memory
    /// is `n * ext_px * 4` bytes; the first pass (plain mean and brightness)
    /// is folded into the push.
    ///
    /// With neither a configured region nor a FOV mask the region is
    /// chosen from the first pushed batch's mean image.
    ///
    /// [`initialize`]: MotionCorrector::initialize
    /// [`warmup_push`]: MotionCorrector::warmup_push
    /// [`warmup_finish`]: MotionCorrector::warmup_finish
    pub fn warmup_begin(&mut self) {
        self.warm = Some(Warm::default());
    }

    /// Whether a streaming warm-up is open.
    pub fn warmup_active(&self) -> bool {
        self.warm.is_some()
    }

    /// Frames pushed so far in the open warm-up.
    pub fn warmup_count(&self) -> usize {
        self.warm.as_ref().map_or(0, |w| w.n)
    }

    /// Add a batch of whole frames to the open warm-up.
    pub fn warmup_push(&mut self, frames: Frames<'_>) -> Result<(), MotionError> {
        let px = self.h * self.w;
        if frames.len() == 0 || !frames.len().is_multiple_of(px) {
            return Err(MotionError::SizeMismatch(format!(
                "warm-up buffer of {} values is not a positive multiple of the {px}-pixel frame",
                frames.len()
            )));
        }
        let Some(mut warm) = self.warm.take() else {
            return Err(MotionError::InvalidConfig(
                "warmup_push without warmup_begin".into(),
            ));
        };
        let r = self.push_into(&mut warm, frames, px);
        // A failed push leaves the warm-up unusable; drop it.
        if r.is_ok() {
            self.warm = Some(warm);
        }
        r
    }

    fn push_into(
        &mut self,
        warm: &mut Warm,
        frames: Frames<'_>,
        px: usize,
    ) -> Result<(), MotionError> {
        let k = frames.len() / px;
        if warm.eng.is_none() {
            let roi = match self.cfg.roi {
                Some(r) => r,
                None => {
                    let mut mean = vec![0.0f32; px];
                    for i in 0..k {
                        frames.frame(i, px).to_f32(&mut self.frame)?;
                        for (m, &v) in mean.iter_mut().zip(&self.frame) {
                            *m += v / k as f32;
                        }
                    }
                    self.auto_roi(&mean)
                }
            };
            let eng = self.build_engine(roi)?;
            warm.acc = vec![0.0; roi.height * roi.width];
            warm.eng = Some(eng);
        }
        let eng = warm.eng.as_mut().expect("engine built above");
        for i in 0..k {
            frames.frame(i, px).to_f32(&mut self.frame)?;
            let b = eng.pre.run(&self.frame, self.w, &mut eng.filtered);
            warm.brightness.push(b);
            warm.stored.extend_from_slice(&eng.filtered);
            eng.cut((0, 0));
            for (a, &v) in warm.acc.iter_mut().zip(&eng.crop) {
                *a += v;
            }
        }
        warm.n += k;
        Ok(())
    }

    /// Close the warm-up: build the template from every pushed frame and
    /// start streaming. Errors if no frame was pushed. The stored frames are
    /// freed either way.
    pub fn warmup_finish(&mut self) -> Result<(), MotionError> {
        let Some(warm) = self.warm.take() else {
            return Err(MotionError::InvalidConfig(
                "warmup_finish without warmup_begin".into(),
            ));
        };
        let Warm {
            eng,
            stored,
            acc,
            brightness,
            n,
        } = warm;
        let Some(mut eng) = eng else {
            return Err(MotionError::SizeMismatch("no warm-up frames pushed".into()));
        };
        let epx = eng.ext.height * eng.ext.width;
        refine_template(&self.cfg, &mut eng, n, acc, brightness, |eng, i| {
            eng.filtered
                .copy_from_slice(&stored[i * epx..(i + 1) * epx]);
            Ok(())
        })?;
        self.install(eng);
        Ok(())
    }

    fn install(&mut self, eng: Engine) {
        let node_ys = eng.node_ys.iter().map(|v| v + eng.roi.y0 as f64).collect();
        let node_xs = eng.node_xs.iter().map(|v| v + eng.roi.x0 as f64).collect();
        let geometry = MotionGeometry {
            height: self.h,
            width: self.w,
            roi: eng.roi,
            node_ys,
            node_xs,
            interpolation: self.cfg.interpolation,
        };
        // Valid geometry by construction (increasing nodes inside the frame).
        if let Ok(w) = geometry.warper() {
            self.warper = w;
        }
        self.geometry = Some(geometry);
        self.engine = Some(eng);
    }

    /// Largest square inside the lit field of view, centred on its centroid,
    /// trimmed to an FFT-friendly side.
    fn auto_roi(&self, mean: &[f32]) -> Roi {
        let (h, w) = (self.h, self.w);
        let lit: Vec<bool> = match &self.fov_mask {
            Some(m) => m.clone(),
            None => {
                let mut sm = vec![0.0f32; h * w];
                let mut tmp = Vec::new();
                gaussian_blur(mean, h, w, 4.0, &mut sm, &mut tmp);
                let mut s: Vec<f32> = sm.clone();
                s.sort_by(f32::total_cmp);
                let hi = s[(s.len() * 99) / 100];
                let thr = 0.3 * hi;
                sm.iter().map(|&v| hi > 0.0 && v >= thr).collect()
            }
        };
        let fallback = || {
            let side = fft_friendly_size((h.min(w) * 3) / 5).max(MIN_ROI_SIDE);
            Roi {
                y0: (h - side) / 2,
                x0: (w - side) / 2,
                height: side,
                width: side,
            }
        };
        let count = lit.iter().filter(|&&v| v).count();
        if count < MIN_ROI_SIDE * MIN_ROI_SIDE {
            return fallback();
        }
        let (mut cy, mut cx) = (0.0f64, 0.0f64);
        for (i, _) in lit.iter().enumerate().filter(|(_, &v)| v) {
            cy += (i / w) as f64;
            cx += (i % w) as f64;
        }
        let (cy, cx) = (cy / count as f64, cx / count as f64);
        // Summed-area table of unlit pixels.
        let mut sat = vec![0u32; (h + 1) * (w + 1)];
        for y in 0..h {
            for x in 0..w {
                sat[(y + 1) * (w + 1) + x + 1] = u32::from(!lit[y * w + x])
                    + sat[y * (w + 1) + x + 1]
                    + sat[(y + 1) * (w + 1) + x]
                    - sat[y * (w + 1) + x];
            }
        }
        let unlit = |y0: usize, x0: usize, s: usize| {
            sat[(y0 + s) * (w + 1) + x0 + s] + sat[y0 * (w + 1) + x0]
                - sat[y0 * (w + 1) + x0 + s]
                - sat[(y0 + s) * (w + 1) + x0]
        };
        let place = |s: usize| -> Option<(usize, usize)> {
            if s > h || s > w {
                return None;
            }
            let y0 = ((cy - s as f64 / 2.0).round().max(0.0) as usize).min(h - s);
            let x0 = ((cx - s as f64 / 2.0).round().max(0.0) as usize).min(w - s);
            (unlit(y0, x0, s) == 0).then_some((y0, x0))
        };
        let mut best = None;
        for s in (MIN_ROI_SIDE..=h.min(w)).rev() {
            if let Some(p) = place(s) {
                best = Some((s, p));
                break;
            }
        }
        let Some((s, _)) = best else {
            return fallback();
        };
        let mut side = s;
        if self.cfg.roi_max_side > 0 {
            side = side.min(self.cfg.roi_max_side.max(MIN_ROI_SIDE));
        }
        let side = fft_friendly_size(side).max(MIN_ROI_SIDE);
        match place(side) {
            Some((y0, x0)) => Roi {
                y0,
                x0,
                height: side,
                width: side,
            },
            None => fallback(),
        }
    }

    fn build_engine(&self, roi: Roi) -> Result<Engine, MotionError> {
        let (rh, rw) = (roi.height, roi.width);
        let side = rh.min(rw);
        let s2 = self
            .cfg
            .dog_sigma_large
            .min(side as f32 / 16.0)
            .max(self.cfg.dog_sigma_small + 0.5);
        let s1 = self.cfg.dog_sigma_small;
        let max_shift = self.cfg.max_shift.min((side / 4) as f32).max(1.0);
        // Filtering margin: room for the largest shift plus the re-cut, and
        // for the patch search, clipped to the frame.
        let patch_extra = self
            .cfg
            .nonrigid
            .as_ref()
            .map_or(0.0, |n| n.max_patch_shift);
        let margin = (max_shift + patch_extra).ceil() as usize + 2;
        let ext = {
            let y0 = roi.y0.saturating_sub(margin);
            let x0 = roi.x0.saturating_sub(margin);
            Roi {
                y0,
                x0,
                height: (roi.y0 + rh + margin).min(self.h) - y0,
                width: (roi.x0 + rw + margin).min(self.w) - x0,
            }
        };
        let epx = ext.height * ext.width;
        let mut corr = Correlator::new(rh, rw, self.cfg.window_alpha)?;
        let ref_spec_init = corr.make_spectrum();
        let band = band_limit(s1);
        corr.set_band_limit(band);
        let patches = match &self.cfg.nonrigid {
            Some(nr) => {
                let (gy, gx) = nr.grid;
                let g = gy.max(gx);
                let p = nr
                    .patch_size
                    .unwrap_or_else(|| fft_friendly_size(2 * side / (g + 1)))
                    .min(side);
                if p < MIN_ROI_SIDE {
                    return Err(MotionError::InvalidConfig(format!(
                        "patches of {p} px are too small; use a coarser grid or a larger region"
                    )));
                }
                let pos = |n: usize, extent: usize, k: usize| -> usize {
                    if n == 1 {
                        (extent - p) / 2
                    } else {
                        ((extent - p) as f64 * k as f64 / (n - 1) as f64).round() as usize
                    }
                };
                let mut origins = Vec::with_capacity(gy * gx);
                for i in 0..gy {
                    for j in 0..gx {
                        origins.push((pos(gy, rh, i), pos(gx, rw, j)));
                    }
                }
                let ys: Vec<usize> = (0..gy).map(|i| origins[i * gx].0).collect();
                let xs: Vec<usize> = (0..gx).map(|j| origins[j].1).collect();
                if ys.windows(2).any(|v| v[1] <= v[0]) || xs.windows(2).any(|v| v[1] <= v[0]) {
                    return Err(MotionError::InvalidConfig(
                        "patch grid is too fine for the registration region".into(),
                    ));
                }
                let mut pc = Correlator::new(p, p, self.cfg.window_alpha)?;
                pc.set_band_limit(band);
                let ng = gy * gx;
                Some(Patches {
                    cfg: nr.clone(),
                    gy,
                    gx,
                    size: p,
                    origins,
                    t_specs: (0..ng).map(|_| pc.make_spectrum()).collect(),
                    t_energy: vec![0.0; ng],
                    buf: vec![0.0; p * p],
                    f_spec: pc.make_spectrum(),
                    corr: pc,
                    smoothed: vec![0.0; 2 * ng],
                    prev_raw: vec![0.0; 2 * ng],
                    noise_var: vec![0.0; 2 * ng],
                    power: vec![0.0; 2 * ng],
                    last: vec![0.0; 2 * ng],
                    started: false,
                    raw: vec![0.0; 2 * ng],
                    quality: vec![0.0; ng],
                    valid: vec![true; ng],
                })
            }
            None => None,
        };
        let (node_ys, node_xs): (Vec<f64>, Vec<f64>) = match &patches {
            Some(p) => {
                let half = (p.size as f64 - 1.0) / 2.0;
                (
                    (0..p.gy)
                        .map(|i| p.origins[i * p.gx].0 as f64 + half)
                        .collect(),
                    (0..p.gx).map(|j| p.origins[j].1 as f64 + half).collect(),
                )
            }
            None => (Vec::new(), Vec::new()),
        };
        Ok(Engine {
            roi,
            ext,
            crop: vec![0.0; rh * rw],
            offset: (0, 0),
            max_shift,
            pre: Prefilter {
                roi,
                ext,
                median: self.cfg.median_prefilter,
                s1,
                s2,
                raw: vec![0.0; epx],
                med: vec![0.0; epx],
                med_scratch: Vec::new(),
                dog: DogScratch::default(),
            },
            template: vec![0.0; rh * rw],
            t_spec: corr.make_spectrum(),
            t_energy: 0.0,
            filtered: vec![0.0; epx],
            f_spec: corr.make_spectrum(),
            prev_spec: corr.make_spectrum(),
            prev_energy: 0.0,
            prev_shift: None,
            prev_rel: (0.0, 0.0),
            corr,
            patches,
            roi_warper: Warper::new(rh, rw, &node_ys, &node_xs, Interpolation::Bilinear)?,
            node_ys,
            node_xs,
            warped_roi: vec![0.0; rh * rw],
            brightness: Tracker::from_samples(&[], 1e-6),
            quality: Tracker::from_samples(&[], 0.01),
            accepted_since_refresh: 0,
            t0: Vec::new(),
            ref_spec: ref_spec_init,
            drift: (0.0, 0.0),
            upsample: self.cfg.upsample,
            strategy: if self.cfg.template_tau == 0.0 {
                TemplateStrategy::Frozen
            } else {
                self.cfg.template_strategy
            },
            cum: Vec::new(),
            cum_n: 0.0,
            weight: Vec::new(),
            m1: Vec::new(),
            m2: Vec::new(),
            weighted: vec![0.0; rh * rw],
            wtmp: vec![0.0; rh * rw],
            wtmp2: vec![0.0; rh * rw],
            blur_scratch: Vec::new(),
        })
    }

    /// Estimate the motion of `frame`, write the corrected frame into `out`
    /// (`height * width`) and return its record. Without a prior
    /// [`initialize`](Self::initialize), the first frame becomes the template.
    pub fn process(
        &mut self,
        frame: Frame<'_>,
        out: &mut [f32],
    ) -> Result<MotionRecord, MotionError> {
        self.process_masked(frame, out, None)
    }

    /// [`process`](Self::process), also writing the validity mask.
    pub fn process_masked(
        &mut self,
        frame: Frame<'_>,
        out: &mut [f32],
        mask: Option<&mut [u8]>,
    ) -> Result<MotionRecord, MotionError> {
        let px = self.h * self.w;
        if frame.len() != px || out.len() != px {
            return Err(MotionError::SizeMismatch(format!(
                "frame has {} pixels and output {}, expected {px}",
                frame.len(),
                out.len()
            )));
        }
        let mut bootstrap = false;
        if self.engine.is_none() {
            match frame {
                Frame::U8(p) => self.initialize(Frames::U8(p))?,
                Frame::F32(p) => self.initialize(Frames::F32(p))?,
            }
            bootstrap = true;
        }
        frame.to_f32(&mut self.frame)?;
        let record = self.estimate(bootstrap)?;
        self.warper.warp(
            &self.frame,
            (record.dy, record.dx),
            &record.residual,
            out,
            mask,
        )?;
        Ok(record)
    }

    /// Allocating convenience form of [`process`](Self::process).
    pub fn process_frame(
        &mut self,
        frame: Frame<'_>,
    ) -> Result<(Vec<f32>, MotionRecord), MotionError> {
        let mut out = vec![0.0; self.h * self.w];
        let rec = self.process(frame, &mut out)?;
        Ok((out, rec))
    }

    /// Replay: warp `frame` by `record` (no estimation, no state change).
    pub fn apply(
        &mut self,
        frame: Frame<'_>,
        record: &MotionRecord,
        out: &mut [f32],
        mask: Option<&mut [u8]>,
    ) -> Result<(), MotionError> {
        let px = self.h * self.w;
        if frame.len() != px {
            return Err(MotionError::SizeMismatch(format!(
                "frame has {} pixels, expected {px}",
                frame.len()
            )));
        }
        if !record.residual.is_empty()
            && self.geometry.as_ref().is_none_or(|g| g.node_ys.is_empty())
        {
            return Err(MotionError::NotInitialized);
        }
        frame.to_f32(&mut self.frame)?;
        self.warper.warp(
            &self.frame,
            (record.dy, record.dx),
            &record.residual,
            out,
            mask,
        )
    }

    fn estimate(&mut self, bootstrap: bool) -> Result<MotionRecord, MotionError> {
        let eng = self.engine.as_mut().ok_or(MotionError::NotInitialized)?;
        let brightness = eng.pre.run(&self.frame, self.w, &mut eng.filtered);
        self.estimate_with(bootstrap, brightness)
    }

    /// Prefilter parameters an external (GPU) prefilter needs to reproduce
    /// the CPU one, or `None` before initialisation.
    pub fn prefilter_params(&self) -> Option<PrefilterParams> {
        let eng = self.engine.as_ref()?;
        Some(PrefilterParams {
            ext: eng.pre.ext,
            roi: eng.pre.roi,
            median: eng.pre.median,
            sigma_small: eng.pre.s1,
            sigma_large: eng.pre.s2,
        })
    }

    /// Estimate the motion of `frames` whose band-passed extended regions
    /// (`ext.height * ext.width` each, as the CPU prefilter would produce)
    /// were computed elsewhere; writes the flat records only (no warp).
    /// Registration and template bookkeeping are identical to
    /// [`process_batch`](Self::process_batch).
    pub fn estimate_batch_prefiltered(
        &mut self,
        frames: &[f32],
        filtered: &[f32],
        records: &mut [f32],
    ) -> Result<(), MotionError> {
        let px = self.h * self.w;
        let rl = self.record_len();
        let (n, fpx) = {
            let eng = self.engine.as_ref().ok_or(MotionError::NotInitialized)?;
            (
                frames.len() / px.max(1),
                eng.pre.ext.height * eng.pre.ext.width,
            )
        };
        if !frames.len().is_multiple_of(px) || filtered.len() != n * fpx || records.len() != n * rl
        {
            return Err(MotionError::SizeMismatch(format!(
                "{} frame values, {} filtered, {} record values: expected multiples of {px}, {fpx}, {rl}",
                frames.len(),
                filtered.len(),
                records.len()
            )));
        }
        for i in 0..n {
            let eng = self.engine.as_mut().ok_or(MotionError::NotInitialized)?;
            eng.filtered
                .copy_from_slice(&filtered[i * fpx..(i + 1) * fpx]);
            let brightness = eng.pre.brightness(&frames[i * px..(i + 1) * px], self.w);
            let rec = self.estimate_with(false, brightness)?;
            rec.write_flat(&mut records[i * rl..(i + 1) * rl])?;
        }
        Ok(())
    }

    fn estimate_with(
        &mut self,
        bootstrap: bool,
        brightness: f32,
    ) -> Result<MotionRecord, MotionError> {
        let cfg = &self.cfg;
        let eng = self.engine.as_mut().ok_or(MotionError::NotInitialized)?;
        let residual_len = cfg.nonrigid.as_ref().map_or(0, |n| 2 * n.grid.0 * n.grid.1);
        let mut flags = if bootstrap { FLAG_BOOTSTRAP } else { 0 };

        // Search around the previous shift: frame-to-frame motion is small,
        // so the first cut is usually already aligned to within a pixel.
        let mut predicted = eng.prev_shift.unwrap_or((0.0, 0.0));
        let dual = eng.strategy == TemplateStrategy::DualAnchor;
        if dual && eng.prev_shift.is_some() && eng.prev_energy > 0.0 {
            // Local anchor: register onto the previous corrected crop, chained
            // onto its shift; the global refinement below starts from there.
            let round = |v: (f32, f32)| (v.0.round() as isize, v.1.round() as isize);
            eng.cut(round(predicted));
            let e = eng.crop_spectrum()?;
            let d = eng.corr.register(
                &eng.prev_spec,
                eng.prev_energy,
                &eng.f_spec,
                e,
                eng.max_shift,
                cfg.upsample,
            )?;
            if d.ncc > 0.0 {
                predicted = (
                    eng.offset.0 as f32 + d.dy + eng.prev_rel.0,
                    eng.offset.1 as f32 + d.dx + eng.prev_rel.1,
                );
            }
        }
        let reg = eng.register(predicted, eng.max_shift, cfg.upsample)?;

        // Nothing to register: hold the previous correction.
        let rpx = (eng.roi.height * eng.roi.width) as f64;
        let degenerate =
            !(reg.energy.is_finite() && reg.energy > 1e-12 * rpx) || eng.t_energy <= 0.0;
        if degenerate {
            let residual = match &eng.patches {
                Some(p) => p.last.clone(),
                _ => vec![0.0; residual_len],
            };
            return Ok(MotionRecord {
                dy: predicted.0 + eng.drift.0,
                dx: predicted.1 + eng.drift.1,
                quality: 0.0,
                flags: flags | FLAG_HELD | FLAG_ANOMALOUS,
                residual,
            });
        }

        let mut rel = reg.rel;
        if cfg.anchor_weight > 0.0 || dual {
            if eng.prev_shift.is_some() && eng.prev_energy > 0.0 {
                // Register the current crop onto the previous one and chain
                // onto the previous shift: s = offset + d + prev_rel.
                let d = eng.corr.register(
                    &eng.prev_spec,
                    eng.prev_energy,
                    &eng.f_spec,
                    reg.energy,
                    eng.max_shift,
                    cfg.upsample,
                )?;
                if d.ncc > 0.0 && cfg.anchor_weight > 0.0 {
                    let w = cfg.anchor_weight;
                    rel.0 = (1.0 - w) * rel.0 + w * (d.dy + eng.prev_rel.0);
                    rel.1 = (1.0 - w) * rel.1 + w * (d.dx + eng.prev_rel.1);
                }
            }
            std::mem::swap(&mut eng.prev_spec, &mut eng.f_spec);
            eng.prev_energy = reg.energy;
        }
        let shift = (eng.offset.0 as f32 + rel.0, eng.offset.1 as f32 + rel.1);
        eng.prev_shift = Some(shift);
        eng.prev_rel = rel;

        if eng.brightness.z(brightness).abs() > cfg.anomaly_threshold {
            flags |= FLAG_BRIGHTNESS_OUTLIER;
        }
        if -eng.quality.z(reg.ncc) > cfg.anomaly_threshold {
            flags |= FLAG_LOW_QUALITY;
        }
        let anomalous = flags & (FLAG_BRIGHTNESS_OUTLIER | FLAG_LOW_QUALITY) != 0;
        if anomalous {
            flags |= FLAG_ANOMALOUS;
        }

        let mut residual = vec![0.0f32; residual_len];
        if let Some(p) = &mut eng.patches {
            p.estimate(
                &eng.filtered,
                eng.ext,
                eng.roi,
                shift,
                cfg.upsample,
                &mut residual,
            )?;
        }

        // Statistics follow every frame (winsorised); the template only
        // normal ones.
        eng.brightness.update(brightness, cfg.anomaly_threshold);
        eng.quality.update(reg.ncc, cfg.anomaly_threshold);
        if !anomalous && eng.strategy != TemplateStrategy::Frozen {
            // The crop is aligned to within `rel`; finish with the sub-pixel
            // part. The non-rigid field is deliberately left out: folding the
            // (noisier) patch estimates into the template measurably degraded
            // the rigid shifts on real data, and this way enabling the
            // non-rigid stage never changes the rigid result.
            eng.roi_warper
                .warp(&eng.crop, rel, &[], &mut eng.warped_roi, None)?;
            let a = if dual {
                (1.0 / (eng.cum_n + 1.0)) as f32
            } else {
                1.0 / cfg.template_tau.max(1.0)
            };
            for (t, &v) in eng.template.iter_mut().zip(&eng.warped_roi) {
                *t += a * (v - *t);
            }
            if !eng.weight.is_empty() {
                for ((m1, m2), &v) in eng
                    .m1
                    .iter_mut()
                    .zip(eng.m2.iter_mut())
                    .zip(&eng.warped_roi)
                {
                    *m1 += WEIGHT_RATE * (v - *m1);
                    *m2 += WEIGHT_RATE * (v * v - *m2);
                }
            }
            if dual {
                eng.cum_n += 1.0;
            } else if eng.strategy == TemplateStrategy::PinnedToCumulative {
                // In output coordinates: the running template's frame plus drift.
                let r = (rel.0 + eng.drift.0, rel.1 + eng.drift.1);
                eng.roi_warper
                    .warp(&eng.crop, r, &[], &mut eng.warped_roi, None)?;
                let a = (1.0 / (eng.cum_n + 1.0)) as f32;
                for (c, &v) in eng.cum.iter_mut().zip(&eng.warped_roi) {
                    *c += a * (v - *c);
                }
                eng.cum_n += 1.0;
            }
            flags |= FLAG_TEMPLATE_UPDATED;
            eng.accepted_since_refresh += 1;
            if eng.accepted_since_refresh >= cfg.template_refresh.max(1) {
                eng.refresh_spectra()?;
            }
        }

        Ok(MotionRecord {
            dy: shift.0 + eng.drift.0,
            dx: shift.1 + eng.drift.1,
            quality: reg.ncc,
            flags,
            residual,
        })
    }

    /// Correct `count` frames stored back to back in `frames`, writing the
    /// corrected frames into `out` and the flat records
    /// ([`record_len`](Self::record_len) each) into `records`.
    pub fn process_batch(
        &mut self,
        frames: Frames<'_>,
        out: &mut [f32],
        records: &mut [f32],
    ) -> Result<(), MotionError> {
        let px = self.h * self.w;
        let n = frames.len() / px;
        let rl = self.record_len();
        if !frames.len().is_multiple_of(px) || out.len() != n * px || records.len() != n * rl {
            return Err(MotionError::SizeMismatch(format!(
                "batch of {} values, output {}, records {}: expected multiples of {px} and {rl}",
                frames.len(),
                out.len(),
                records.len()
            )));
        }
        for i in 0..n {
            let rec = self.process(frames.frame(i, px), &mut out[i * px..(i + 1) * px])?;
            rec.write_flat(&mut records[i * rl..(i + 1) * rl])?;
        }
        Ok(())
    }

    /// Replay `count` frames with their flat records.
    pub fn apply_batch(
        &mut self,
        frames: Frames<'_>,
        records: &[f32],
        out: &mut [f32],
    ) -> Result<(), MotionError> {
        let px = self.h * self.w;
        let n = frames.len() / px;
        let rl = self.record_len();
        if !frames.len().is_multiple_of(px) || out.len() != n * px || records.len() != n * rl {
            return Err(MotionError::SizeMismatch(format!(
                "batch of {} values, output {}, records {}: expected multiples of {px} and {rl}",
                frames.len(),
                out.len(),
                records.len()
            )));
        }
        for i in 0..n {
            let rec = MotionRecord::from_flat(&records[i * rl..(i + 1) * rl])?;
            self.apply(
                frames.frame(i, px),
                &rec,
                &mut out[i * px..(i + 1) * px],
                None,
            )?;
        }
        Ok(())
    }
}

/// Frequency (cycles/px) above which a DoG with high-cut `sigma` has gain
/// below [`BAND_GAIN_FLOOR`] of its peak; 0.5 (no limit) for tiny sigmas.
fn band_limit(sigma: f32) -> f32 {
    if sigma <= 0.0 {
        return 0.5;
    }
    // exp(-2 pi^2 sigma^2 f^2) = floor  =>  f = sqrt(-ln floor / 2) / (pi sigma)
    let f = (-(BAND_GAIN_FLOOR.ln()) / 2.0).sqrt() / (std::f64::consts::PI * sigma as f64);
    f.min(0.5) as f32
}
