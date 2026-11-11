//! Per-pixel noise σ from frame-to-frame differences, streamed.
//!
//! # Definition (CaLab's SNR convention)
//!
//! `σ = median|Δy| / (Φ⁻¹(0.75) · √2)`, with `Δy_t = y_t − y_{t−1}` per pixel:
//! the same MAD-of-differences estimator as `noise_sigma_mad_diff` in
//! `crates/solver/src/snr.rs`, so a pixel's σ here and a trace's σ there mean
//! the same thing. Differencing removes the slow signal and the background;
//! the difference of two iid samples has variance 2σ², hence √2; the median
//! (rather than the mean) ignores the few large differences at transient
//! onsets.
//!
//! # Streaming the median
//!
//! An exact per-pixel median needs every past |Δy| (or a histogram per pixel:
//! 32 bins x 360 k pixels x 2 bytes = 23 MB at 600x600, plus a choice of bin
//! range). Two O(1)-memory estimators are offered:
//!
//! * [`NoiseEstimator::MedianTracker`] (default): a stochastic-approximation
//!   ("frugal") median, `m ← m · (1 ± η)` as |Δy| is above or below `m`.
//!   Its fixed point is exactly the median, so it is robust to transients
//!   like the batch estimator. With multiplicative steps it is scale-free;
//!   for half-normal |Δy| its relative spread is ≈ 0.76·√η and its time
//!   constant ≈ 1.2/η frames. Default η = 0.002: ±3.4 % per pixel, adapting
//!   over ~600 frames (30 s at 20 fps), slow enough to be steady and fast
//!   enough to follow bleaching and brightness steps. It starts from the
//!   mean-absolute-difference estimate of the first `init_frames` differences
//!   (converted to a median by the Gaussian ratio), so it is usable after a
//!   second instead of after its time constant. Before that, the running mean
//!   is reported.
//! * [`NoiseEstimator::MeanAbs`]: the running mean of |Δy| times
//!   `√π / 2` (the Gaussian mean-to-σ factor for a difference, after the √2).
//!   Exact (no step-size noise) and order-independent, but not robust: every
//!   transient onset adds its full size, so it reads high on active pixels
//!   (measured on the minisim fixture in the integration tests).
//!
//! # Quantized input: dither
//!
//! 8-bit frames make |Δy| (nearly) integer-valued, and a median of a discrete
//! distribution is not a smooth function of σ: on integer-valued noise of
//! σ = 3 the undithered tracker reads 4 % high (3.13 against 3.01, see the
//! tests). With `dither` (default on), the tracker
//! compares `|Δy + u|` instead, `u` uniform in (−½, ½) from a hash of the
//! pixel index and frame number (so replay is exact). That turns the
//! integer-valued difference back into a continuous one whose median tracks
//! σ smoothly (3.03); the dither adds 1/12 to the variance of Δy, a bias of
//! +0.5 % at σ = 3 grey levels (+4 % at σ = 1). After flattening, real frames
//! are no longer exactly integer and the dither makes no measurable
//! difference there; it matters for raw integer input.
//!
//! # Measured
//!
//! On the workshop CA1 data (`examples/preprocess_eval.rs`, 4000 frames) the
//! tracker equals the batch MAD-diff of the last 600 frames to 0.1 %. It reads
//! 4 % below the batch value over all 4000 frames, correctly: the noise fell
//! with the brightness step at frame 2000 (shot noise), and the tracker
//! follows the present. On the minisim fixture it matches the simulator's
//! per-pixel σ to 0.3 % off cells.
//!
//! The state is the previous frame plus one (or two) floats per pixel, so it
//! is snapshot-able like the background ([`NoiseState`]).

use super::stats::MAD_GAUSSIAN;
use super::{Dims, PreprocessError};

/// √2 · Φ⁻¹(0.75): median|Δ| of iid N(0, σ²) samples, per σ.
const MEDIAN_ABS_DIFF_PER_SIGMA: f32 = MAD_GAUSSIAN * std::f32::consts::SQRT_2;
/// E|Δ| per σ for iid N(0, σ²): √2 · √(2/π) = 2/√π.
const MEAN_ABS_DIFF_PER_SIGMA: f32 = std::f32::consts::FRAC_2_SQRT_PI;

/// Window radii (px) searched, in order, for known pixels whose σ stands in
/// for a pixel that has not had enough differences of its own
/// ([`NoiseMap::update_masked`]): past the motion's reach, then wider.
const FILL_RADII: [usize; 2] = [8, 32];

/// Pixels per block of [`NoiseMap::update_masked`]: a block whose pixels
/// all track their median takes a branch-free loop.
const MASKED_BLOCK: usize = 1024;

/// A deterministic value in (−½, ½) from a pixel index and a per-frame seed.
#[inline]
fn hash_unit(i: u32, seed: u32) -> f32 {
    let mut h = i.wrapping_mul(0x9E37_79B1) ^ seed;
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297A_2D39);
    h ^= h >> 15;
    (h >> 8) as f32 * (1.0 / 16_777_216.0) - 0.5
}

/// Which streaming estimator to use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NoiseEstimator {
    /// Frugal multiplicative median tracker with relative step `eta`.
    MedianTracker { eta: f32 },
    /// Running mean of |Δ| with the Gaussian correction.
    MeanAbs,
}

/// Settings for [`NoiseMap`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseConfig {
    pub estimator: NoiseEstimator,
    /// Differences averaged to initialise the median tracker.
    pub init_frames: u32,
    /// Dither the differences seen by the median tracker (see the module docs).
    pub dither: bool,
}

impl Default for NoiseConfig {
    fn default() -> NoiseConfig {
        NoiseConfig {
            estimator: NoiseEstimator::MedianTracker { eta: 0.002 },
            init_frames: 20,
            dither: true,
        }
    }
}

impl NoiseConfig {
    pub fn validate(&self) -> Result<(), PreprocessError> {
        if let NoiseEstimator::MedianTracker { eta } = self.estimator {
            if !(eta.is_finite() && eta > 0.0 && eta < 0.5) {
                return Err(PreprocessError::InvalidConfig(format!(
                    "noise eta must be in (0, 0.5), got {eta}"
                )));
            }
        }
        if self.init_frames == 0 {
            return Err(PreprocessError::InvalidConfig(
                "noise init_frames must be >= 1".into(),
            ));
        }
        Ok(())
    }
}

/// Everything needed to resume the noise map exactly.
#[derive(Debug, Clone, PartialEq)]
pub struct NoiseState {
    pub(crate) dims: Dims,
    pub(crate) prev: Vec<f32>,
    /// Running mean of |Δ| (all estimators use it during initialisation).
    pub(crate) mean_abs: Vec<f32>,
    /// The tracked median of |Δ| (median tracker only; empty otherwise).
    pub(crate) median: Vec<f32>,
    /// Frames fed so far (differences = frames − 1).
    pub(crate) frames: u64,
    /// Differences each pixel has had ([`NoiseMap::update_masked`] only;
    /// empty otherwise). Exact as `f32` up to 2^24.
    pub(crate) diffs: Vec<f32>,
}

impl NoiseState {
    pub fn frames(&self) -> u64 {
        self.frames
    }

    pub(crate) fn check(&self, tracker: bool) -> Result<(), PreprocessError> {
        let n = self.dims.pixels();
        if self.prev.len() != n
            || self.mean_abs.len() != n
            || self.median.len() != if tracker { n } else { 0 }
            || !(self.diffs.is_empty() || self.diffs.len() == n)
        {
            return Err(PreprocessError::InvalidState(
                "noise state sizes are inconsistent".into(),
            ));
        }
        Ok(())
    }
}

/// The streaming noise-map stage.
#[derive(Debug, Clone)]
pub struct NoiseMap {
    cfg: NoiseConfig,
    st: NoiseState,
}

impl NoiseMap {
    pub fn new(dims: Dims, cfg: &NoiseConfig) -> Result<NoiseMap, PreprocessError> {
        cfg.validate()?;
        let n = dims.pixels();
        let tracker = matches!(cfg.estimator, NoiseEstimator::MedianTracker { .. });
        Ok(NoiseMap {
            cfg: *cfg,
            st: NoiseState {
                dims,
                prev: vec![0.0; n],
                mean_abs: vec![0.0; n],
                median: if tracker { vec![0.0; n] } else { Vec::new() },
                frames: 0,
                diffs: Vec::new(),
            },
        })
    }

    /// [`Self::update`] where only the pixels with `valid != 0` hold data.
    ///
    /// A difference is taken only between two consecutive valid samples of a
    /// pixel (a missing sample breaks the chain: the previous value becomes
    /// unknown, stored as NaN), so a pixel that holds data in some frames and
    /// none in others gets the σ of its data, not of the on/off switching.
    /// Each pixel counts its own differences: it initialises on its first
    /// `init_frames` of them and tracks the median after. Until then its σ
    /// is not known, and [`Self::sigma`] gives it the σ of the known pixels
    /// around it. Start a recording in this mode; do not mix it with
    /// [`Self::update`].
    pub fn update_masked(&mut self, frame: &[f32], valid: &[u8]) -> Result<(), PreprocessError> {
        self.st.dims.check("frame", frame.len())?;
        self.st.dims.check("validity mask", valid.len())?;
        let st = &mut self.st;
        if st.diffs.is_empty() {
            st.diffs = vec![0.0; st.prev.len()];
        }
        st.frames += 1;
        let first = st.frames == 1;
        let init = self.cfg.init_frames as f32;
        let tracking = !st.median.is_empty();
        let eta = match self.cfg.estimator {
            NoiseEstimator::MedianTracker { eta } => eta,
            NoiseEstimator::MeanAbs => 0.0,
        };
        let to_median = MEDIAN_ABS_DIFF_PER_SIGMA / MEAN_ABS_DIFF_PER_SIGMA;
        let dither = self.cfg.dither;
        let seed = (st.frames as u32).wrapping_mul(0x85EB_CA77);
        let cap = 16_777_216.0f32;
        let n = st.prev.len();
        let mut start = 0;
        while start < n {
            let end = (start + MASKED_BLOCK).min(n);
            let fr = &frame[start..end];
            let ok = &valid[start..end];
            let prev = &mut st.prev[start..end];
            let diffs = &mut st.diffs[start..end];
            if tracking && !first {
                // Branch-free (vectorised), both regimes per pixel: the
                // running mean of |Δ| until a pixel has had `init_frames`
                // differences (its median starts there), the median tracker
                // after. Missing samples become NaN first, so the loop reads
                // f32 only.
                let mut vm = [0.0f32; MASKED_BLOCK];
                let vm = &mut vm[..fr.len()];
                for ((d, &v), &o) in vm.iter_mut().zip(fr).zip(ok) {
                    *d = if o != 0 { v } else { f32::NAN };
                }
                let med = &mut st.median[start..end];
                let mabs = &mut st.mean_abs[start..end];
                for (j, ((((p, k), m), ma), &v)) in prev
                    .iter_mut()
                    .zip(diffs.iter_mut())
                    .zip(med.iter_mut())
                    .zip(mabs.iter_mut())
                    .zip(vm.iter())
                    .enumerate()
                {
                    let good = v.is_finite();
                    let last = *p;
                    *p = if good { v } else { f32::NAN };
                    let use_it = good & !last.is_nan();
                    let k1 = if use_it { (*k + 1.0).min(cap) } else { *k };
                    *k = k1;
                    let warm = k1 <= init;
                    // Running mean of this pixel's |Δ| (exact, 1/k weights).
                    let mean = *ma + ((v - last).abs() - *ma) / k1;
                    *ma = if use_it & warm { mean } else { *ma };
                    let u = if dither {
                        hash_unit((start + j) as u32, seed)
                    } else {
                        0.0
                    };
                    let a = (v - last + u).abs();
                    let step = if a > *m {
                        eta
                    } else if a < *m {
                        -eta
                    } else {
                        0.0
                    };
                    let next = *m * (1.0 + step);
                    let next = if next == 0.0 { a } else { next };
                    let next = if warm { mean * to_median } else { next };
                    *m = if use_it & (!warm | (k1 == init)) {
                        next
                    } else {
                        *m
                    };
                }
            } else {
                for (j, (p, &v)) in prev.iter_mut().zip(fr).enumerate() {
                    let i = start + j;
                    if ok[j] == 0 || !v.is_finite() {
                        *p = f32::NAN;
                        continue;
                    }
                    let last = std::mem::replace(p, v);
                    if first || last.is_nan() {
                        continue;
                    }
                    let k = &mut diffs[j];
                    *k = (*k + 1.0).min(cap);
                    if !tracking || *k <= init {
                        // Running mean of this pixel's |Δ| (exact, 1/k weights).
                        let m = &mut st.mean_abs[i];
                        *m += ((v - last).abs() - *m) / *k;
                        if tracking && *k == init {
                            st.median[i] = *m * to_median;
                        }
                    } else {
                        let u = if dither {
                            hash_unit(i as u32, seed)
                        } else {
                            0.0
                        };
                        let a = (v - last + u).abs();
                        let m = &mut st.median[i];
                        let step = if a > *m {
                            eta
                        } else if a < *m {
                            -eta
                        } else {
                            0.0
                        };
                        let next = *m * (1.0 + step);
                        *m = if next == 0.0 { a } else { next };
                    }
                }
            }
            start = end;
        }
        Ok(())
    }

    /// [`Self::sigma`] after [`Self::update_masked`]: a pixel's own σ once it
    /// has had `init_frames` differences; before that (a pixel that rarely
    /// holds data, at the FOV edge under motion), the mean σ of the known
    /// pixels within [`FILL_RADII`], or its own early estimate when there is
    /// none (the first frames of a recording).
    fn sigma_masked(&self) -> Vec<f32> {
        let st = &self.st;
        let (w, h) = (st.dims.width, st.dims.height);
        let init = self.cfg.init_frames as f32;
        let tracking = !st.median.is_empty();
        let own = |i: usize| -> f32 {
            if tracking && st.diffs[i] >= init {
                st.median[i] / MEDIAN_ABS_DIFF_PER_SIGMA
            } else {
                st.mean_abs[i] / MEAN_ABS_DIFF_PER_SIGMA
            }
        };
        let mut out: Vec<f32> = (0..w * h).map(own).collect();
        if st.diffs.iter().all(|&k| k >= init) {
            return out;
        }
        // Integral images of the known pixels' σ and count.
        let (iw, ih) = (w + 1, h + 1);
        let mut is = vec![0.0f64; iw * ih];
        let mut ic = vec![0.0f64; iw * ih];
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let (v, c) = if st.diffs[i] >= init {
                    (f64::from(out[i]), 1.0)
                } else {
                    (0.0, 0.0)
                };
                let o = (y + 1) * iw + x + 1;
                is[o] = v + is[o - 1] + is[o - iw] - is[o - iw - 1];
                ic[o] = c + ic[o - 1] + ic[o - iw] - ic[o - iw - 1];
            }
        }
        let boxed = |a: &[f64], y: usize, x: usize, r: usize| -> f64 {
            let (y0, x0) = (y.saturating_sub(r), x.saturating_sub(r));
            let (y1, x1) = ((y + r + 1).min(h), (x + r + 1).min(w));
            a[y1 * iw + x1] - a[y0 * iw + x1] - a[y1 * iw + x0] + a[y0 * iw + x0]
        };
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if st.diffs[i] >= init {
                    continue;
                }
                for &r in &FILL_RADII {
                    let c = boxed(&ic, y, x, r);
                    if c > 0.0 {
                        out[i] = (boxed(&is, y, x, r) / c) as f32;
                        break;
                    }
                }
            }
        }
        out
    }

    /// Feed one (preprocessed) frame. Non-finite samples count as 0.
    pub fn update(&mut self, frame: &[f32]) -> Result<(), PreprocessError> {
        self.st.dims.check("frame", frame.len())?;
        let st = &mut self.st;
        st.frames += 1;
        if st.frames == 1 {
            for (p, &v) in st.prev.iter_mut().zip(frame) {
                *p = if v.is_finite() { v } else { 0.0 };
            }
            return Ok(());
        }
        let d = st.frames - 1; // differences seen, including this one
        let init = u64::from(self.cfg.init_frames);
        let tracking = !st.median.is_empty();
        if !tracking || d <= init {
            // Running mean of |Δ| (exact, 1/d weights; for MeanAbs forever).
            let w_new = 1.0 / d as f32;
            for ((p, m), &v) in st.prev.iter_mut().zip(st.mean_abs.iter_mut()).zip(frame) {
                let v = if v.is_finite() { v } else { 0.0 };
                *m += w_new * ((v - *p).abs() - *m);
                *p = v;
            }
            if tracking && d == init {
                let to_median = MEDIAN_ABS_DIFF_PER_SIGMA / MEAN_ABS_DIFF_PER_SIGMA;
                for (md, &m) in st.median.iter_mut().zip(&st.mean_abs) {
                    *md = m * to_median;
                }
            }
            return Ok(());
        }
        let eta = match self.cfg.estimator {
            NoiseEstimator::MedianTracker { eta } => eta,
            NoiseEstimator::MeanAbs => 0.0,
        };
        let dither = self.cfg.dither;
        let seed = (st.frames as u32).wrapping_mul(0x85EB_CA77);
        for (i, ((p, m), &v)) in st
            .prev
            .iter_mut()
            .zip(st.median.iter_mut())
            .zip(frame)
            .enumerate()
        {
            let v = if v.is_finite() { v } else { 0.0 };
            let u = if dither {
                hash_unit(i as u32, seed)
            } else {
                0.0
            };
            let a = (v - *p + u).abs();
            *p = v;
            // m ← m (1 ± η), branch-free.
            let step = if a > *m {
                eta
            } else if a < *m {
                -eta
            } else {
                0.0
            };
            let next = *m * (1.0 + step);
            // A pixel whose median collapsed to 0 (constant during
            // initialisation) restarts from the first non-zero difference.
            *m = if next == 0.0 { a } else { next };
        }
        Ok(())
    }

    /// Per-pixel σ in the units of the input frames.
    pub fn sigma(&self) -> Vec<f32> {
        if !self.st.diffs.is_empty() {
            return self.sigma_masked();
        }
        let st = &self.st;
        let tracking = !st.median.is_empty();
        let d = st.frames.saturating_sub(1);
        if tracking && d >= u64::from(self.cfg.init_frames) {
            st.median
                .iter()
                .map(|&m| m / MEDIAN_ABS_DIFF_PER_SIGMA)
                .collect()
        } else {
            st.mean_abs
                .iter()
                .map(|&m| m / MEAN_ABS_DIFF_PER_SIGMA)
                .collect()
        }
    }

    /// Frames fed so far.
    pub fn frames(&self) -> u64 {
        self.st.frames
    }

    pub fn config(&self) -> &NoiseConfig {
        &self.cfg
    }

    pub fn state(&self) -> NoiseState {
        self.st.clone()
    }

    pub fn restore(&mut self, state: &NoiseState) -> Result<(), PreprocessError> {
        let tracker = matches!(self.cfg.estimator, NoiseEstimator::MedianTracker { .. });
        state.check(tracker)?;
        if state.dims != self.st.dims {
            return Err(PreprocessError::InvalidState(
                "noise state size does not match".into(),
            ));
        }
        self.st = state.clone();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Lcg(u64);
    impl Lcg {
        fn uniform(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 40) as f32 + 0.5) / (1u64 << 24) as f32
        }
        /// Box-Muller.
        fn normal(&mut self) -> f32 {
            let (u, v) = (self.uniform(), self.uniform());
            (-2.0 * u.ln()).sqrt() * (2.0 * std::f32::consts::PI * v).cos()
        }
    }

    /// Returns the streamed σ map and the exact batch MAD-diff σ (pooled).
    fn feed(cfg: &NoiseConfig, frames: usize, sigma: f32, spikes: bool) -> (Vec<f32>, f32) {
        let dims = Dims::new(16, 16).unwrap();
        let mut nm = NoiseMap::new(dims, cfg).unwrap();
        let mut rng = Lcg(3);
        let mut prev: Option<Vec<f32>> = None;
        let mut diffs = Vec::new();
        for t in 0..frames {
            // Slow drift (removed by differencing) and, optionally, a big
            // transient every 50 frames.
            let f: Vec<f32> = (0..256)
                .map(|_| {
                    let s = if spikes && t % 50 < 3 { 60.0 } else { 0.0 };
                    100.0 + 0.01 * t as f32 + s + sigma * rng.normal()
                })
                .collect();
            nm.update(&f).unwrap();
            if let Some(p) = &prev {
                diffs.extend(f.iter().zip(p).map(|(a, b)| (a - b).abs()));
            }
            prev = Some(f);
        }
        diffs.sort_by(|a, b| a.total_cmp(b));
        let exact = diffs[diffs.len() / 2] / MEDIAN_ABS_DIFF_PER_SIGMA;
        (nm.sigma(), exact)
    }

    fn mean(v: &[f32]) -> f32 {
        v.iter().sum::<f32>() / v.len() as f32
    }

    #[test]
    fn median_tracker_matches_true_sigma_and_ignores_transients() {
        let (s, exact) = feed(&NoiseConfig::default(), 3000, 3.0, true);
        let m = mean(&s);
        // The transients (4 % of differences) lift the batch MAD-diff itself
        // by ~5 %; the tracker must match the batch estimator, not 3.0.
        assert!((exact - 3.0).abs() < 0.2, "batch {exact}");
        assert!(
            (m / exact - 1.0).abs() < 0.03,
            "tracker {m} vs batch {exact}"
        );
        let spread = (s.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / s.len() as f32).sqrt();
        assert!(spread / m < 0.08, "per-pixel spread {spread}");
        // The mean-abs variant is biased up by the transients.
        let (ma, _) = feed(
            &NoiseConfig {
                estimator: NoiseEstimator::MeanAbs,
                ..NoiseConfig::default()
            },
            3000,
            3.0,
            true,
        );
        assert!(mean(&ma) > 3.0 * 1.3, "mean-abs {}", mean(&ma));
        let (ma_clean, _) = feed(
            &NoiseConfig {
                estimator: NoiseEstimator::MeanAbs,
                ..NoiseConfig::default()
            },
            3000,
            3.0,
            false,
        );
        assert!((mean(&ma_clean) - 3.0).abs() < 0.05);
    }

    #[test]
    fn dither_removes_the_quantization_bias() {
        // Integer-valued frames (8-bit-like) with σ = 3.
        let run = |dither: bool| {
            let dims = Dims::new(16, 16).unwrap();
            let cfg = NoiseConfig {
                dither,
                ..NoiseConfig::default()
            };
            let mut nm = NoiseMap::new(dims, &cfg).unwrap();
            let mut rng = Lcg(17);
            for _ in 0..4000 {
                let f: Vec<f32> = (0..256)
                    .map(|_| (50.0 + 3.0 * rng.normal()).floor())
                    .collect();
                nm.update(&f).unwrap();
            }
            mean(&nm.sigma())
        };
        let (plain, dithered) = (run(false), run(true));
        // Floor quantization adds 1/12 per sample: true σ = √(9 + 1/12) ≈ 3.014.
        let truth = (9.0f32 + 1.0 / 12.0).sqrt();
        assert!(
            (dithered / truth - 1.0).abs() < 0.025,
            "dithered {dithered} vs {truth}"
        );
        assert!(
            (plain / truth - 1.0).abs() > (dithered / truth - 1.0).abs(),
            "plain {plain}"
        );
    }

    #[test]
    fn early_estimate_and_state_roundtrip() {
        let dims = Dims::new(4, 4).unwrap();
        let mut nm = NoiseMap::new(dims, &NoiseConfig::default()).unwrap();
        assert!(nm.sigma().iter().all(|&v| v == 0.0));
        nm.update(&[0.0; 16]).unwrap();
        nm.update(&[1.0; 16]).unwrap();
        assert!(nm
            .sigma()
            .iter()
            .all(|&v| (v - 1.0 / MEAN_ABS_DIFF_PER_SIGMA).abs() < 1e-6));
        let st = nm.state();
        let mut other = NoiseMap::new(dims, &NoiseConfig::default()).unwrap();
        other.restore(&st).unwrap();
        for k in 0..50 {
            let f = [k as f32 * 0.7 % 3.0; 16];
            nm.update(&f).unwrap();
            other.update(&f).unwrap();
        }
        assert_eq!(nm.sigma(), other.sigma());
        assert!(nm.update(&[0.0; 3]).is_err());
        let bad = NoiseConfig {
            estimator: NoiseEstimator::MedianTracker { eta: 0.0 },
            ..NoiseConfig::default()
        };
        assert!(NoiseMap::new(dims, &bad).is_err());
    }

    #[test]
    fn constant_then_noisy_pixel_recovers() {
        let dims = Dims::new(1, 1).unwrap();
        let mut nm = NoiseMap::new(dims, &NoiseConfig::default()).unwrap();
        for _ in 0..30 {
            nm.update(&[5.0]).unwrap();
        }
        let mut rng = Lcg(5);
        for _ in 0..4000 {
            nm.update(&[5.0 + 2.0 * rng.normal()]).unwrap();
        }
        let s = nm.sigma()[0];
        assert!((s - 2.0).abs() < 0.3, "{s}");
    }

    /// A pixel that holds data (level 40, σ 2) in some frames and 0 in
    /// others: unmasked, the on/off switching dominates or the median
    /// collapses; masked, the σ is that of the data.
    #[test]
    fn masked_update_ignores_missing_samples() {
        let dims = Dims::new(1, 3).unwrap();
        let mut masked = NoiseMap::new(dims, &NoiseConfig::default()).unwrap();
        let mut plain = NoiseMap::new(dims, &NoiseConfig::default()).unwrap();
        let mut rng = Lcg(9);
        for t in 0..6000 {
            // Pixel 0 always valid, 1 valid in runs (4 on, 4 off), 2 never.
            let on1 = t % 8 < 4;
            let v = [40.0 + 2.0 * rng.normal(), 40.0 + 2.0 * rng.normal(), 0.0];
            let f = [v[0], if on1 { v[1] } else { 0.0 }, v[2]];
            masked.update_masked(&f, &[1, u8::from(on1), 0]).unwrap();
            plain.update(&f).unwrap();
        }
        let (m, p) = (masked.sigma(), plain.sigma());
        assert!((m[0] - 2.0).abs() < 0.2, "{m:?}");
        assert!((m[1] - 2.0).abs() < 0.25, "{m:?}");
        // Never valid: the σ of its known neighbours.
        assert!((m[2] - 2.0).abs() < 0.25, "{m:?}");
        assert!(p[1] < 1.6, "{p:?}");
    }
}
