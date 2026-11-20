//! Global flicker: a per-frame offset and gain shared by every pixel.
//!
//! Miniscope frames carry common-mode frame-to-frame flicker (broadband, with
//! most of its power at 2–8 Hz) of two physical kinds:
//!
//! * **multiplicative**: the excitation LED's intensity fluctuates, so every
//!   pixel (cells included) scales by `1 + m_t`;
//! * **additive**: a sensor / readout offset `a_t` is added to every pixel.
//!
//! The observed frame is `y_t = a_t + (1 + m_t) · x_t`. This stage estimates
//! `(a_t, m_t)` per frame and inverts it, `x̂_t = (y_t − a_t) / (1 + m_t)`,
//! inside the field of view.
//!
//! # Estimate
//!
//! A reference image `R` holds the running mean of the frames (an
//! exponential moving average with time constant `tau_frames`, default 1 s;
//! a plain cumulative mean until that many frames have been seen). The frame
//! is regressed on it, `y = a + (1 + m) · R`, over a sparse grid of FOV
//! pixels (every `s`-th pixel in each direction, with `s` the largest step
//! that keeps at least [`FlickerConfig::grid_pixels`] pixels: 4287 at stride 8
//! on the workshop data's 600x600 frames). The fit is trimmed least squares:
//! start from the median and MAD of `y − R`, then refit on the pixels whose
//! residual is within `clip_sigma` σ, re-estimating σ from the kept pixels,
//! for [`FIT_ITERATIONS`] rounds. Active cells are large residuals and drop
//! out, so the fit follows the tissue background, not the activity.
//!
//! The reference is updated with the *uncorrected* frame, so `(a_t, m_t)` are
//! the common-mode fluctuation relative to the last ~`tau_frames` frames:
//! everything slower (bleaching, slow drift) stays in the frame and is left
//! to the background stage. (Updating `R` with the corrected frame instead
//! would make the global gain unobservable: the correction would absorb every
//! slow brightness change, bleaching included, and freeze the output level.)
//! The time constant trades the low edge of the flicker band against the
//! scene's own slow common mode (neuropil, synchronous activity), which the
//! regression cannot tell from flicker: on a 600x600 calibrated minisim
//! render without flicker the stage reads `m` with an RMS of 1.4 % at 1 s, of
//! which 0.3 % is in the 2–8 Hz band (0.8 % / 0.3 % at 0.25 s, 1.8 % / 0.3 %
//! at 2 s), while the band-limited recovery of an injected flicker is the
//! same for all three (r 0.95–0.96).
//!
//! # Where in the chain
//!
//! Right after hot-pixel repair, before glow flattening, line removal and
//! motion correction. Flattening subtracts a low-pass of the frame, so after
//! it a gain flicker is no longer one number per frame: it survives as `m_t`
//! times the high-passed texture, which looks like activity to every later
//! stage. Before flattening it is one global number. The lens disk and the
//! vignette are fixed to the sensor and dominate the spatial structure of
//! `R`, so the regression is done in sensor coordinates; brain motion only
//! moves the fine texture. Measured on the workshop CA1 data (frames
//! 5000–7000, `examples/flicker_eval.rs`): estimating on the raw frames after
//! the recorded motion correction leaves 4.0 % of the 2–8 Hz pixel power in
//! the common mode, against 0.4 % in sensor coordinates (12.4 % before).
//!
//! A purely additive `a_t` is constant over the FOV and glow flattening
//! removes it anyway; it is fitted alongside `m_t` so the gain is measured
//! without bias, and it matters for the dim pixels near the lens edge.
//!
//! # Separating the two
//!
//! The offset and the gain are distinguishable only through the spatial
//! contrast of `R` (`σ(R) / mean(R)` over the fitted pixels): on a flat
//! reference `a` and `m · R` are the same image. Below
//! [`FlickerConfig::min_contrast`] the `Both` mode falls back to a gain-only
//! fit (the dominant kind on the workshop data) and reports
//! [`FlickerRecord::separable`] `= false`. On the workshop data the contrast
//! is 0.39 and every frame separates, but the split is only moderately
//! identified: regressing each pixel's 2–8 Hz series on the estimated `a_t`
//! and `m_t` gives a loading of 0.95 on `a_t` and `13 + 0.73 · F0` on `m_t`
//! (`F0` the pixel's mean), so part of an offset that moves with the gain is
//! booked as gain. Their sum, the change at each pixel, is what is removed.
//!
//! # Replay
//!
//! `R` is running state ([`FlickerState`], part of
//! [`super::PreprocessState`]), and each frame's `(a_t, m_t)` is recorded in
//! [`FlickerRecord`]; [`FlickerCorrector::apply_record`] applies a recorded
//! correction without touching the state, which is what a replay of a past
//! frame uses.
//!
//! # Cost
//!
//! Proportional to the grid (~11 µs per 1000 grid pixels: four passes and two
//! selections) plus one multiply-add over the FOV: 62 µs per 600x600 frame
//! native, ~0.1 ms in WASM.

use super::fov::FovMask;
use super::stats::{quantile_in_place, MAD_GAUSSIAN};
use super::{Dims, PreprocessError};

/// Trimmed least-squares rounds after the median / MAD start.
pub const FIT_ITERATIONS: usize = 3;
/// Fewest kept grid pixels for a fit; below it the frame is left as is.
pub const MIN_FIT_PIXELS: usize = 16;
/// A fitted gain `1 + m` outside this range is treated as a failed fit.
const GAIN_RANGE: (f64, f64) = (0.5, 2.0);
/// Clip of the first (median / MAD) round, in σ: wider than the later rounds
/// because the gain spreads `y − R` before it is fitted.
const START_CLIP_SIGMA: f32 = 4.0;
/// Default reference time constant, seconds.
pub const DEFAULT_TAU_SECONDS: f32 = 1.0;

/// Which flicker components to correct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlickerMode {
    Off,
    /// Offset only (`m_t = 0`).
    Additive,
    /// Gain only (`a_t = 0`).
    Multiplicative,
    /// Both, separated by the contrast of the reference.
    #[default]
    Both,
}

impl FlickerMode {
    pub fn code(self) -> u8 {
        match self {
            FlickerMode::Off => 0,
            FlickerMode::Additive => 1,
            FlickerMode::Multiplicative => 2,
            FlickerMode::Both => 3,
        }
    }

    pub fn from_code(c: u8) -> Option<FlickerMode> {
        Some(match c {
            0 => FlickerMode::Off,
            1 => FlickerMode::Additive,
            2 => FlickerMode::Multiplicative,
            3 => FlickerMode::Both,
            _ => return None,
        })
    }
}

/// Settings for [`FlickerCorrector`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FlickerConfig {
    pub mode: FlickerMode,
    /// Time constant of the reference image, frames (>= 1).
    pub tau_frames: f32,
    /// Fitted pixels: the grid step is the largest that keeps at least this
    /// many FOV pixels (all of them on a small FOV). >= 16.
    pub grid_pixels: usize,
    /// Trim residuals beyond this many σ (> 0).
    pub clip_sigma: f32,
    /// Smallest `σ(R) / mean(R)` for which `Both` separates offset and gain.
    pub min_contrast: f32,
}

impl Default for FlickerConfig {
    fn default() -> FlickerConfig {
        FlickerConfig::for_fps(20.0)
    }
}

impl FlickerConfig {
    /// Defaults with the reference time constant converted at `fps`
    /// (non-positive or non-finite = 20 fps).
    pub fn for_fps(fps: f32) -> FlickerConfig {
        let fps = if fps.is_finite() && fps > 0.0 {
            fps
        } else {
            20.0
        };
        FlickerConfig {
            mode: FlickerMode::Both,
            tau_frames: (DEFAULT_TAU_SECONDS * fps).max(1.0),
            grid_pixels: 4096,
            clip_sigma: 2.5,
            min_contrast: 0.05,
        }
    }

    pub fn validate(&self) -> Result<(), PreprocessError> {
        if !(self.tau_frames.is_finite() && self.tau_frames >= 1.0) {
            return Err(PreprocessError::InvalidConfig(format!(
                "flicker tau_frames must be >= 1, got {}",
                self.tau_frames
            )));
        }
        if self.grid_pixels < MIN_FIT_PIXELS {
            return Err(PreprocessError::InvalidConfig(format!(
                "flicker grid_pixels must be >= {MIN_FIT_PIXELS}, got {}",
                self.grid_pixels
            )));
        }
        if !(self.clip_sigma.is_finite() && self.clip_sigma > 0.0) {
            return Err(PreprocessError::InvalidConfig(format!(
                "flicker clip_sigma must be > 0, got {}",
                self.clip_sigma
            )));
        }
        if !(self.min_contrast.is_finite() && self.min_contrast >= 0.0) {
            return Err(PreprocessError::InvalidConfig(format!(
                "flicker min_contrast must be >= 0, got {}",
                self.min_contrast
            )));
        }
        Ok(())
    }
}

/// One frame's flicker estimate (all zero when the stage is off).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FlickerRecord {
    /// Additive offset `a_t`, grey levels.
    pub offset: f32,
    /// Relative gain `m_t` (the frame was scaled by `1 + m_t`).
    pub gain: f32,
    /// `σ(R) / mean(R)` over the kept pixels: how well offset and gain separate.
    pub contrast: f32,
    /// Fraction of the grid pixels kept by the trimmed fit.
    pub kept_fraction: f32,
    /// `Both` mode separated the offset from the gain (false: gain-only fallback,
    /// or a mode that fits one component).
    pub separable: bool,
}

/// The running state: the reference image on the fitted grid.
#[derive(Debug, Clone, PartialEq)]
pub struct FlickerState {
    /// Reference values at the grid pixels, in grid order.
    pub reference: Vec<f32>,
    /// Frames folded into the reference.
    pub frames: u64,
}

/// The flicker stage for one recording.
#[derive(Debug, Clone)]
pub struct FlickerCorrector {
    cfg: FlickerConfig,
    dims: Dims,
    stride: usize,
    /// FOV pixel indices on the grid.
    grid: Vec<u32>,
    /// Runs `start..end` of FOV pixels (the pixels that are corrected).
    runs: Vec<(usize, usize)>,
    reference: Vec<f32>,
    frames: u64,
    /// Truncated-normal σ correction for `clip_sigma`.
    sigma_fix: f32,
    y: Vec<f32>,
    resid: Vec<f32>,
    scratch: Vec<f32>,
}

/// Maximal runs of consecutive non-zero mask bytes, as index ranges.
fn fov_runs(mask: &[u8]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut start = None;
    for (i, &m) in mask.iter().enumerate() {
        match (m != 0, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                runs.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        runs.push((s, mask.len()));
    }
    runs
}

/// `σ_true / σ_kept` for a normal sample trimmed at ±`c` σ.
fn truncation_correction(c: f32) -> f32 {
    let c = f64::from(c);
    // Φ(c) − Φ(−c) via erf, φ(c) the density.
    let phi = (-0.5 * c * c).exp() / (2.0 * std::f64::consts::PI).sqrt();
    let mass = erf(c / std::f64::consts::SQRT_2);
    let ratio = 1.0 - 2.0 * c * phi / mass;
    if ratio > 1e-6 {
        (1.0 / ratio.sqrt()) as f32
    } else {
        1.0
    }
}

/// Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7), enough for a σ correction.
fn erf(x: f64) -> f64 {
    let s = x.signum();
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let p = t
        * (0.254_829_592
            + t * (-0.284_496_736
                + t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
    s * (1.0 - p * (-x * x).exp())
}

impl FlickerCorrector {
    pub fn new(fov: &FovMask, cfg: &FlickerConfig) -> Result<FlickerCorrector, PreprocessError> {
        cfg.validate()?;
        let dims = fov.dims();
        let s = ((fov.area() as f64 / cfg.grid_pixels as f64).sqrt().floor() as usize).max(1);
        // Centre the grid in each cell so a stride-s grid avoids the frame edge.
        let off = s / 2;
        let mut grid = Vec::new();
        for y in (off..dims.height).step_by(s) {
            for x in (off..dims.width).step_by(s) {
                let i = y * dims.width + x;
                if fov.contains(i) {
                    grid.push(i as u32);
                }
            }
        }
        let n = grid.len();
        Ok(FlickerCorrector {
            cfg: *cfg,
            dims,
            stride: s,
            grid,
            runs: fov_runs(fov.mask()),
            reference: vec![0.0; n],
            frames: 0,
            sigma_fix: truncation_correction(cfg.clip_sigma),
            y: vec![0.0; n],
            resid: vec![0.0; n],
            scratch: vec![0.0; n],
        })
    }

    pub fn config(&self) -> &FlickerConfig {
        &self.cfg
    }

    /// Grid pixels the fit uses.
    pub fn grid_len(&self) -> usize {
        self.grid.len()
    }

    /// Grid step in pixels.
    pub fn stride(&self) -> usize {
        self.stride
    }

    /// Estimate this frame's flicker, correct `frame` in place, and fold the
    /// uncorrected frame into the reference.
    pub fn apply(&mut self, frame: &mut [f32]) -> Result<FlickerRecord, PreprocessError> {
        self.dims.check("frame", frame.len())?;
        if self.cfg.mode == FlickerMode::Off || self.grid.is_empty() {
            return Ok(FlickerRecord::default());
        }
        for (y, &i) in self.y.iter_mut().zip(&self.grid) {
            *y = frame[i as usize];
        }
        let rec = if self.frames == 0 {
            // No reference yet: this frame defines it.
            self.reference.copy_from_slice(&self.y);
            FlickerRecord {
                kept_fraction: 1.0,
                ..FlickerRecord::default()
            }
        } else {
            let rec = self.fit();
            let alpha = (1.0 / (self.frames + 1) as f32).max(1.0 / self.cfg.tau_frames);
            for (r, &y) in self.reference.iter_mut().zip(&self.y) {
                *r += alpha * (y - *r);
            }
            rec
        };
        self.frames += 1;
        self.correct(frame, &rec);
        Ok(rec)
    }

    /// Apply a recorded correction (no estimation, no state change).
    pub fn apply_record(
        &self,
        frame: &mut [f32],
        rec: &FlickerRecord,
    ) -> Result<(), PreprocessError> {
        self.dims.check("frame", frame.len())?;
        self.correct(frame, rec);
        Ok(())
    }

    fn correct(&self, frame: &mut [f32], rec: &FlickerRecord) {
        if rec.offset == 0.0 && rec.gain == 0.0 {
            return;
        }
        let inv = 1.0 / (1.0 + rec.gain);
        let a = rec.offset;
        for &(s, e) in &self.runs {
            for v in &mut frame[s..e] {
                *v = (*v - a) * inv;
            }
        }
    }

    /// Trimmed least squares of `y = a + (1 + m) R` over the grid.
    fn fit(&mut self) -> FlickerRecord {
        let n = self.grid.len();
        // Round 0: robust centre and spread of y − R.
        for ((r, &y), &rf) in self.resid.iter_mut().zip(&self.y).zip(&self.reference) {
            *r = y - rf;
        }
        self.scratch.copy_from_slice(&self.resid);
        let med = quantile_in_place(&mut self.scratch, 0.5).unwrap_or(0.0);
        for s in self.scratch.iter_mut() {
            *s = (*s - med).abs();
        }
        let mad = quantile_in_place(&mut self.scratch, 0.5).unwrap_or(0.0) / MAD_GAUSSIAN;
        let mut centre = med;
        let mut lim = START_CLIP_SIGMA * mad;
        let mut out = FlickerRecord::default();
        for _ in 0..=FIT_ITERATIONS {
            // Sums over the kept pixels.
            let (mut k, mut sr, mut srr, mut sy, mut syr) = (0usize, 0.0f64, 0.0f64, 0.0, 0.0);
            for ((&r, &y), &rf) in self.resid.iter().zip(&self.y).zip(&self.reference) {
                if (r - centre).abs() <= lim {
                    let (y, rf) = (f64::from(y), f64::from(rf));
                    k += 1;
                    sr += rf;
                    srr += rf * rf;
                    sy += y;
                    syr += y * rf;
                }
            }
            if k < MIN_FIT_PIXELS || !lim.is_finite() {
                break;
            }
            let kf = k as f64;
            let mean_r = sr / kf;
            let var_r = (srr / kf - mean_r * mean_r).max(0.0);
            let contrast = if mean_r.abs() > 0.0 {
                var_r.sqrt() / mean_r.abs()
            } else {
                0.0
            };
            let mut separable = false;
            let (na, ng) = match self.cfg.mode {
                FlickerMode::Additive => ((sy - sr) / kf, 1.0),
                FlickerMode::Multiplicative => (0.0, if srr > 0.0 { syr / srr } else { 1.0 }),
                FlickerMode::Both
                    if contrast >= f64::from(self.cfg.min_contrast) && var_r > 0.0 =>
                {
                    separable = true;
                    let cov = syr / kf - (sy / kf) * mean_r;
                    let g = cov / var_r;
                    (sy / kf - g * mean_r, g)
                }
                _ => (0.0, if srr > 0.0 { syr / srr } else { 1.0 }),
            };
            if !(na.is_finite() && ng.is_finite() && ng >= GAIN_RANGE.0 && ng <= GAIN_RANGE.1) {
                break;
            }
            let (a, g) = (na, ng);
            out = FlickerRecord {
                offset: a as f32,
                gain: (g - 1.0) as f32,
                contrast: contrast as f32,
                kept_fraction: k as f32 / n as f32,
                separable,
            };
            // Residuals of this fit, and their σ over the kept pixels.
            let (af, gf) = (a as f32, g as f32);
            let (mut ss, mut kk) = (0.0f64, 0usize);
            for ((r, &y), &rf) in self.resid.iter_mut().zip(&self.y).zip(&self.reference) {
                let keep = (*r - centre).abs() <= lim;
                *r = y - af - gf * rf;
                if keep {
                    ss += f64::from(*r) * f64::from(*r);
                    kk += 1;
                }
            }
            centre = 0.0;
            let sigma = (ss / kk.max(1) as f64).sqrt() as f32 * self.sigma_fix;
            lim = self.cfg.clip_sigma * sigma;
        }
        out
    }

    /// Start the reference again from the next frame, as at the start of a
    /// recording (a session boundary, see [`super::session`]): the next frame
    /// defines it and is not corrected, the following ones are fitted
    /// against the cumulative mean of the new session's frames until
    /// `tau_frames` of them have been seen.
    pub fn reseat(&mut self) {
        self.frames = 0;
    }

    pub fn state(&self) -> FlickerState {
        FlickerState {
            reference: self.reference.clone(),
            frames: self.frames,
        }
    }

    pub fn restore(&mut self, st: &FlickerState) -> Result<(), PreprocessError> {
        if st.reference.len() != self.grid.len() {
            return Err(PreprocessError::InvalidState(format!(
                "flicker reference has {} values, the grid {}",
                st.reference.len(),
                self.grid.len()
            )));
        }
        self.reference.copy_from_slice(&st.reference);
        self.frames = st.frames;
        Ok(())
    }

    /// The reference image on the grid (grid order) and the grid indices.
    pub fn reference(&self) -> (&[f32], &[u32]) {
        (&self.reference, &self.grid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 64;
    const H: usize = 48;

    /// A vignetted background with texture, plus `cells` bright active blobs.
    fn scene(t: usize, cells: bool) -> Vec<f32> {
        let mut v = vec![0.0f32; W * H];
        for y in 0..H {
            for x in 0..W {
                let dx = x as f32 - W as f32 / 2.0;
                let dy = y as f32 - H as f32 / 2.0;
                let vig = 120.0 * (-(dx * dx + dy * dy) / 900.0).exp() + 20.0;
                let tex = 6.0 * ((x as f32 * 0.7).sin() * (y as f32 * 0.5).cos());
                // Deterministic pseudo-noise, ±1.5.
                let h = (x * 7919 + y * 104_729 + t * 1_299_709) % 1000;
                let noise = (h as f32 / 1000.0 - 0.5) * 3.0;
                v[y * W + x] = vig + tex + noise;
            }
        }
        if cells {
            // Six cells, each active on alternating frames, 3x the background.
            for c in 0..6 {
                if !(t + c).is_multiple_of(3) {
                    continue;
                }
                let (cx, cy) = (10 + 9 * c, 12 + 4 * c);
                for y in cy.saturating_sub(3)..(cy + 4).min(H) {
                    for x in cx.saturating_sub(3)..(cx + 4).min(W) {
                        v[y * W + x] += 150.0;
                    }
                }
            }
        }
        v
    }

    fn flicker_series(t: usize) -> (f32, f32) {
        let tf = t as f32;
        (
            3.0 * (0.9 * tf).sin() + 1.5 * (2.3 * tf).cos(),
            0.03 * (1.3 * tf).sin() + 0.015 * (0.4 * tf + 1.0).cos(),
        )
    }

    fn run(mode: FlickerMode, use_a: bool, use_m: bool, cells: bool) -> (f32, f32) {
        let dims = Dims::new(W, H).unwrap();
        let cfg = FlickerConfig {
            mode,
            grid_pixels: 1 << 20,
            ..FlickerConfig::for_fps(20.0)
        };
        let mut fc = FlickerCorrector::new(&FovMask::full(dims), &cfg).unwrap();
        let (mut ea, mut em) = (0.0f32, 0.0f32);
        let mut count = 0;
        for t in 0..200 {
            let (a, m) = flicker_series(t);
            let (a, m) = (if use_a { a } else { 0.0 }, if use_m { m } else { 0.0 });
            let clean = scene(t, cells);
            let mut f: Vec<f32> = clean.iter().map(|&x| a + (1.0 + m) * x).collect();
            let rec = fc.apply(&mut f).unwrap();
            if t >= 20 {
                // The estimate is relative to the running mean of the
                // flicker, which is ~0 for these zero-mean series.
                ea = ea.max((rec.offset - a).abs());
                em = em.max((rec.gain - m).abs());
                count += 1;
            }
        }
        assert!(count > 0);
        (ea, em)
    }

    #[test]
    fn recovers_additive_multiplicative_and_both() {
        for cells in [false, true] {
            let (ea, em) = run(FlickerMode::Both, true, false, cells);
            assert!(ea < 0.5 && em < 0.004, "additive, cells {cells}: {ea} {em}");
            let (ea, em) = run(FlickerMode::Both, false, true, cells);
            assert!(
                ea < 0.5 && em < 0.004,
                "multiplicative, cells {cells}: {ea} {em}"
            );
            let (ea, em) = run(FlickerMode::Both, true, true, cells);
            assert!(ea < 0.6 && em < 0.005, "both, cells {cells}: {ea} {em}");
            // Single-component modes on their own kind of flicker.
            let (ea, _) = run(FlickerMode::Additive, true, false, cells);
            assert!(ea < 0.5, "additive mode, cells {cells}: {ea}");
            let (_, em) = run(FlickerMode::Multiplicative, false, true, cells);
            assert!(em < 0.004, "multiplicative mode, cells {cells}: {em}");
        }
    }

    #[test]
    fn corrected_frames_match_the_clean_scene() {
        let dims = Dims::new(W, H).unwrap();
        let cfg = FlickerConfig {
            grid_pixels: 1 << 20,
            ..FlickerConfig::default()
        };
        let mut fc = FlickerCorrector::new(&FovMask::full(dims), &cfg).unwrap();
        let mut worst_before = 0.0f32;
        let mut worst_after = 0.0f32;
        for t in 0..120 {
            let (a, m) = flicker_series(t);
            let clean = scene(t, true);
            let mut f: Vec<f32> = clean.iter().map(|&x| a + (1.0 + m) * x).collect();
            let before = rms_diff(&f, &clean);
            fc.apply(&mut f).unwrap();
            if t >= 20 {
                worst_before = worst_before.max(before);
                worst_after = worst_after.max(rms_diff(&f, &clean));
            }
        }
        assert!(
            worst_after < 0.15 * worst_before,
            "{worst_after} vs {worst_before}"
        );
    }

    fn rms_diff(a: &[f32], b: &[f32]) -> f32 {
        let s: f32 = a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum();
        (s / a.len() as f32).sqrt()
    }

    #[test]
    fn flat_reference_falls_back_to_gain_only() {
        let dims = Dims::new(W, H).unwrap();
        let mut fc =
            FlickerCorrector::new(&FovMask::full(dims), &FlickerConfig::default()).unwrap();
        for t in 0..30 {
            let h = |i: usize| ((i * 7919 + t * 104_729) % 100) as f32 / 100.0;
            let mut f: Vec<f32> = (0..W * H).map(|i| 100.0 * 1.02 + h(i)).collect();
            let rec = fc.apply(&mut f).unwrap();
            if t > 0 {
                assert!(!rec.separable);
                assert_eq!(rec.offset, 0.0);
                assert!(rec.contrast < 0.05);
            }
        }
    }

    #[test]
    fn off_mode_record_replay_and_state() {
        let dims = Dims::new(W, H).unwrap();
        let off = FlickerConfig {
            mode: FlickerMode::Off,
            ..FlickerConfig::default()
        };
        let mut fc = FlickerCorrector::new(&FovMask::full(dims), &off).unwrap();
        let clean = scene(3, true);
        let mut f: Vec<f32> = clean.iter().map(|&x| 5.0 + 1.1 * x).collect();
        let g = f.clone();
        assert_eq!(fc.apply(&mut f).unwrap(), FlickerRecord::default());
        assert_eq!(f, g);

        // Recorded corrections replay exactly, and state restores exactly.
        let mut fc =
            FlickerCorrector::new(&FovMask::full(dims), &FlickerConfig::default()).unwrap();
        let mut recs = Vec::new();
        let mut outs = Vec::new();
        let mut mid = None;
        for t in 0..40 {
            if t == 25 {
                mid = Some(fc.state());
            }
            let (a, m) = flicker_series(t);
            let raw: Vec<f32> = scene(t, true).iter().map(|&x| a + (1.0 + m) * x).collect();
            let mut f = raw.clone();
            recs.push(fc.apply(&mut f).unwrap());
            outs.push((raw, f));
        }
        for (t, (raw, out)) in outs.iter().enumerate() {
            let mut f = raw.clone();
            fc.apply_record(&mut f, &recs[t]).unwrap();
            assert_eq!(&f, out, "replay {t}");
        }
        let mut again =
            FlickerCorrector::new(&FovMask::full(dims), &FlickerConfig::default()).unwrap();
        again.restore(mid.as_ref().unwrap()).unwrap();
        for (t, (raw, out)) in outs.iter().enumerate().skip(25) {
            let mut f = raw.clone();
            assert_eq!(again.apply(&mut f).unwrap(), recs[t]);
            assert_eq!(&f, out);
        }
        // Wrong sizes are errors.
        assert!(fc.apply(&mut [0.0; 3]).is_err());
        let bad = FlickerState {
            reference: vec![0.0; 2],
            frames: 1,
        };
        assert!(again.restore(&bad).is_err());
    }

    #[test]
    fn only_fov_pixels_change_and_configs_validate() {
        let dims = Dims::new(8, 8).unwrap();
        let mut mask = vec![0u8; 64];
        for (i, m) in mask.iter_mut().enumerate() {
            *m = u8::from((2..6).contains(&(i % 8)) && (2..6).contains(&(i / 8)));
        }
        let fov = FovMask::from_mask(dims, &mask).unwrap();
        let cfg = FlickerConfig {
            grid_pixels: 1 << 20,
            ..FlickerConfig::default()
        };
        let mut fc = FlickerCorrector::new(&fov, &cfg).unwrap();
        let base: Vec<f32> = (0..64).map(|i| 10.0 + (i % 5) as f32 * 7.0).collect();
        fc.apply(&mut base.clone()).unwrap();
        let mut f: Vec<f32> = base.iter().map(|&x| 1.0 + 1.05 * x).collect();
        let g = f.clone();
        fc.apply(&mut f).unwrap();
        for i in 0..64 {
            if mask[i] == 0 {
                assert_eq!(f[i], g[i]);
            }
        }
        for bad in [
            FlickerConfig {
                tau_frames: 0.5,
                ..FlickerConfig::default()
            },
            FlickerConfig {
                grid_pixels: 3,
                ..FlickerConfig::default()
            },
            FlickerConfig {
                clip_sigma: f32::NAN,
                ..FlickerConfig::default()
            },
            FlickerConfig {
                min_contrast: -1.0,
                ..FlickerConfig::default()
            },
        ] {
            assert!(bad.validate().is_err());
        }
        for c in 0..4 {
            assert_eq!(FlickerMode::from_code(c).unwrap().code(), c);
        }
        assert!(FlickerMode::from_code(4).is_none());
        assert!((truncation_correction(2.5) - 1.0 / 0.9113f32.sqrt()).abs() < 1e-3);
        // An empty FOV is a no-op, not a panic.
        let empty = FovMask::from_mask(dims, &[0u8; 64]).unwrap();
        let mut fc = FlickerCorrector::new(&empty, &cfg).unwrap();
        assert_eq!(fc.apply(&mut f).unwrap(), FlickerRecord::default());
    }
}
