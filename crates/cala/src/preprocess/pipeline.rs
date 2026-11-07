//! The composed preprocessing chain, its per-frame record and its state.
//!
//! ```text
//!  raw ─► hot pixels ─► flicker ─► flatten ─► lines ─►│ FrameRegistrar │─┬─► background ─► out
//!                                                                          └─► noise map (σ per pixel)
//!        └──────────── front (sensor coords) ─────────┘                    └── back (tissue coords, stateful) ┘
//! ```
//!
//! Use it in one of two ways:
//!
//! * [`Preprocessor::process`] with a [`FrameRegistrar`] runs the whole chain;
//!   [`NoRegistration`] (via [`Preprocessor::process_frame`]) skips motion.
//! * [`Preprocessor::front`], then motion correction applied externally, then
//!   [`Preprocessor::back`]. This is the same computation; it exists so the
//!   motion stage can live in another worker or on the GPU.
//!
//! # Warm-up
//!
//! The frozen [`Calibration`] (FOV mask and hot-pixel map) is estimated from
//! the first frames before any frame is processed: feed them to a
//! [`WarmupAccumulator`], call [`Calibration::from_warmup`], then process from
//! frame 0 (re-reading the warm-up frames, as the streaming source does
//! anyway). Every frame, including the warm-up ones, then sees the same
//! calibration.
//!
//! # Replay
//!
//! The front half is a pure function of the raw frame, the calibration and the
//! frame's flicker estimate (`FrontRecord::flicker`): the flicker stage keeps
//! a running reference image, so [`Preprocessor::front`] estimates and advances
//! it, while [`Preprocessor::front_replay`] applies a recorded estimate and
//! reproduces a past frame's front half exactly, in any order. The back half
//! depends on the background and noise state: [`Preprocessor::state`] captures
//! it (with the calibration and config) as a [`PreprocessState`], which
//! serializes to bytes ([`PreprocessState::to_bytes`]); restoring it with
//! [`Preprocessor::from_state`] and feeding the following frames reproduces
//! their outputs bit for bit. Background snapshots
//! ([`super::background::BackgroundConfig::snapshot_every`]) give restore
//! points inside a recording without saving the whole state each frame.

use std::fmt;

use super::background::{BackgroundConfig, BackgroundState, RunningMinBackground};
use super::codec::{Reader, Writer};
use super::flatten::{FlattenConfig, GlowFlattener};
use super::flicker::{FlickerConfig, FlickerCorrector, FlickerMode, FlickerRecord, FlickerState};
use super::fov::{FovConfig, FovMask};
use super::hot_pixels::{HotPixelConfig, HotPixelMap};
use super::lines::{LineCorrector, LineMode};
use super::noise::{NoiseConfig, NoiseEstimator, NoiseMap, NoiseState};
use super::warmup::{WarmupAccumulator, DEFAULT_WARMUP_FRAMES};
use super::{Dims, PreprocessError, RawPixel};

/// Motion correction, as the preprocessing chain sees it.
///
/// The chain calls [`FrameRegistrar::register`] between the sensor-coordinate
/// stages (hot pixels, flattening, lines) and the tissue-coordinate ones
/// (background, noise), with the frame in place. `register` estimates and
/// applies the correction and returns a record of it (shifts, a piecewise
/// field, a template version, ...); `replay` applies a recorded correction
/// again without re-estimating, which is what makes pass 2 exact. Both work on
/// a row-major `width x height` `f32` frame.
///
/// To plug in a motion corrector: implement this trait for it (or for a thin
/// wrapper) and pass it to [`Preprocessor::process`].
pub trait FrameRegistrar {
    /// What one frame's registration was (must be enough to `replay` it).
    type Record: Clone + fmt::Debug;
    type Error: fmt::Display;

    /// Estimate the motion of `frame`, warp it in place, and report it.
    fn register(
        &mut self,
        frame: &mut [f32],
        width: usize,
        height: usize,
    ) -> Result<Self::Record, Self::Error>;

    /// Warp `frame` in place exactly as `record` says.
    fn replay(
        &self,
        frame: &mut [f32],
        width: usize,
        height: usize,
        record: &Self::Record,
    ) -> Result<(), Self::Error>;
}

/// The identity registrar: no motion correction.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoRegistration;

impl FrameRegistrar for NoRegistration {
    type Record = ();
    type Error = std::convert::Infallible;

    fn register(&mut self, _: &mut [f32], _: usize, _: usize) -> Result<(), Self::Error> {
        Ok(())
    }

    fn replay(&self, _: &mut [f32], _: usize, _: usize, _: &()) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// Settings for every stage.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreprocessConfig {
    /// Frames averaged for the calibration (FOV mask, hot pixels).
    pub warmup_frames: usize,
    pub fov: FovConfig,
    pub hot: HotPixelConfig,
    pub flicker: FlickerConfig,
    pub flatten: FlattenConfig,
    pub lines: LineMode,
    pub background: BackgroundConfig,
    pub noise: NoiseConfig,
}

impl Default for PreprocessConfig {
    fn default() -> PreprocessConfig {
        PreprocessConfig {
            warmup_frames: DEFAULT_WARMUP_FRAMES,
            fov: FovConfig::default(),
            hot: HotPixelConfig::default(),
            flicker: FlickerConfig::default(),
            flatten: FlattenConfig::default(),
            lines: LineMode::default(),
            background: BackgroundConfig::default(),
            noise: NoiseConfig::default(),
        }
    }
}

impl PreprocessConfig {
    /// Defaults with the time-based settings converted at `fps`.
    pub fn for_fps(fps: f32) -> PreprocessConfig {
        PreprocessConfig {
            background: BackgroundConfig::for_fps(fps),
            flicker: FlickerConfig::for_fps(fps),
            ..PreprocessConfig::default()
        }
    }

    pub fn validate(&self) -> Result<(), PreprocessError> {
        if self.warmup_frames == 0 {
            return Err(PreprocessError::InvalidConfig(
                "warmup_frames must be >= 1".into(),
            ));
        }
        self.fov.validate()?;
        self.hot.validate()?;
        self.flicker.validate()?;
        self.flatten.validate()?;
        self.background.validate()?;
        self.noise.validate()
    }
}

/// The frozen, warm-up-derived part of the chain.
#[derive(Debug, Clone, PartialEq)]
pub struct Calibration {
    dims: Dims,
    fov: FovMask,
    hot: HotPixelMap,
}

impl Calibration {
    /// Build from parts (e.g. a mask drawn by the user).
    pub fn new(fov: FovMask, hot: HotPixelMap) -> Result<Calibration, PreprocessError> {
        if fov.dims() != hot.dims() {
            return Err(PreprocessError::InvalidConfig(
                "fov mask and hot-pixel map sizes differ".into(),
            ));
        }
        Ok(Calibration {
            dims: fov.dims(),
            fov,
            hot,
        })
    }

    /// Estimate the FOV mask and then the hot-pixel map from warm-up frames.
    pub fn from_warmup(
        acc: &WarmupAccumulator,
        cfg: &PreprocessConfig,
    ) -> Result<Calibration, PreprocessError> {
        cfg.validate()?;
        let dims = acc.dims();
        let mean = acc.mean()?;
        let var = acc.variance()?;
        // The FOV threshold uses the mean as is: a hot pixel outside the lens
        // is an isolated speck that the opening removes.
        let fov = FovMask::from_mean(dims, &mean, &cfg.fov)?;
        let hot = HotPixelMap::detect(dims, &mean, &var, &fov, &cfg.hot)?;
        Calibration::new(fov, hot)
    }

    pub fn dims(&self) -> Dims {
        self.dims
    }

    pub fn fov(&self) -> &FovMask {
        &self.fov
    }

    pub fn hot_pixels(&self) -> &HotPixelMap {
        &self.hot
    }
}

/// Per-frame record of the stateless (sensor-coordinate) stages.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FrontRecord {
    /// Mean of the input inside the FOV, after hot-pixel repair (global
    /// brightness; flashes and brightness steps show up here).
    pub input_mean: f32,
    /// Mean of the subtracted glow inside the FOV.
    pub lowpass_mean: f32,
    /// RMS of the subtracted row / column offsets (0 when off).
    pub row_rms: f32,
    pub col_rms: f32,
    /// The global flicker removed from this frame (replay it with
    /// [`Preprocessor::front_replay`]).
    pub flicker: FlickerRecord,
}

/// Per-frame record of the stateful (tissue-coordinate) stages.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BackRecord {
    /// Index of this frame in the stream (frames fed to `back` before it).
    pub frame_index: u64,
    /// Mean of the subtracted background floor.
    pub floor_mean: f32,
    /// Fraction of pixels whose floor snapped down at this frame.
    pub floor_lowered_fraction: f32,
    /// A background snapshot was stored after this frame.
    pub snapshot: bool,
}

/// Everything recorded about one frame.
#[derive(Debug, Clone, PartialEq)]
pub struct PreprocessRecord<R = ()> {
    pub front: FrontRecord,
    pub back: BackRecord,
    pub registration: R,
}

/// The preprocessing chain for one recording.
#[derive(Debug, Clone)]
pub struct Preprocessor {
    cfg: PreprocessConfig,
    calib: Calibration,
    flicker: FlickerCorrector,
    flatten: GlowFlattener,
    lines: LineCorrector,
    background: RunningMinBackground,
    noise: NoiseMap,
    next_frame: u64,
}

impl Preprocessor {
    pub fn new(
        calib: Calibration,
        cfg: &PreprocessConfig,
    ) -> Result<Preprocessor, PreprocessError> {
        cfg.validate()?;
        let dims = calib.dims();
        Ok(Preprocessor {
            cfg: *cfg,
            flicker: FlickerCorrector::new(calib.fov(), &cfg.flicker)?,
            flatten: GlowFlattener::new(calib.fov(), &cfg.flatten)?,
            lines: LineCorrector::new(calib.fov(), cfg.lines),
            background: RunningMinBackground::new(dims, &cfg.background)?,
            noise: NoiseMap::new(dims, &cfg.noise)?,
            calib,
            next_frame: 0,
        })
    }

    pub fn dims(&self) -> Dims {
        self.calib.dims()
    }

    pub fn config(&self) -> &PreprocessConfig {
        &self.cfg
    }

    pub fn calibration(&self) -> &Calibration {
        &self.calib
    }

    /// Hot pixels → flicker → flattening → lines, from `raw` into `out`.
    ///
    /// Estimates this frame's flicker against the running reference and
    /// advances it; everything else is stateless. To reproduce a past frame,
    /// use [`Self::front_replay`] with its record.
    pub fn front<T: RawPixel>(
        &mut self,
        raw: &[T],
        out: &mut [f32],
    ) -> Result<FrontRecord, PreprocessError> {
        self.load_repaired(raw, out)?;
        let fk = self.flicker.apply(out)?;
        self.front_rest(out, fk)
    }

    /// [`Self::front`] with the flicker correction of `flicker` (a past
    /// frame's `PreprocessRecord::front.flicker`) instead of a new estimate. Stateless:
    /// any frame, any order, bit for bit.
    pub fn front_replay<T: RawPixel>(
        &mut self,
        raw: &[T],
        out: &mut [f32],
        flicker: &FlickerRecord,
    ) -> Result<FrontRecord, PreprocessError> {
        self.load_repaired(raw, out)?;
        self.flicker.apply_record(out, flicker)?;
        self.front_rest(out, *flicker)
    }

    fn load_repaired<T: RawPixel>(
        &self,
        raw: &[T],
        out: &mut [f32],
    ) -> Result<(), PreprocessError> {
        let dims = self.dims();
        dims.check("raw frame", raw.len())?;
        dims.check("output frame", out.len())?;
        for (o, &r) in out.iter_mut().zip(raw) {
            let v = r.to_f32();
            *o = if v.is_finite() { v } else { 0.0 };
        }
        self.calib.hot.apply(out)
    }

    fn front_rest(
        &mut self,
        out: &mut [f32],
        flicker: FlickerRecord,
    ) -> Result<FrontRecord, PreprocessError> {
        let fl = self.flatten.apply(out)?;
        let ln = self.lines.apply(out)?;
        Ok(FrontRecord {
            input_mean: fl.input_mean,
            lowpass_mean: fl.lowpass_mean,
            row_rms: ln.row_rms,
            col_rms: ln.col_rms,
            flicker,
        })
    }

    /// Background and noise map, in place on a registered frame.
    ///
    /// The noise map sees the frame *before* the background is subtracted.
    /// The floor is quasi-static, so the output has the same noise; but when
    /// a pixel's floor snaps down it does so to a value that contains the
    /// current frame's noise, which would correlate with that noise and bias
    /// the estimate low (by ~4 % over the first 160 frames of the minisim
    /// fixture, while the floor is still settling).
    pub fn back(&mut self, frame: &mut [f32]) -> Result<BackRecord, PreprocessError> {
        self.dims().check("frame", frame.len())?;
        self.noise.update(frame)?;
        let bg = self.background.process(frame)?;
        let rec = BackRecord {
            frame_index: self.next_frame,
            floor_mean: bg.floor_mean,
            floor_lowered_fraction: bg.lowered_fraction,
            snapshot: bg.snapshot,
        };
        self.next_frame += 1;
        Ok(rec)
    }

    /// The whole chain with motion correction in the middle.
    pub fn process<T: RawPixel, R: FrameRegistrar>(
        &mut self,
        raw: &[T],
        out: &mut [f32],
        registrar: &mut R,
    ) -> Result<PreprocessRecord<R::Record>, PreprocessError> {
        let front = self.front(raw, out)?;
        let Dims { width, height } = self.dims();
        let registration = registrar
            .register(out, width, height)
            .map_err(|e| PreprocessError::Registration(e.to_string()))?;
        let back = self.back(out)?;
        Ok(PreprocessRecord {
            front,
            back,
            registration,
        })
    }

    /// The whole chain without motion correction.
    pub fn process_frame<T: RawPixel>(
        &mut self,
        raw: &[T],
        out: &mut [f32],
    ) -> Result<PreprocessRecord, PreprocessError> {
        self.process(raw, out, &mut NoRegistration)
    }

    /// Frames fed to [`Self::back`] so far.
    pub fn frames_processed(&self) -> u64 {
        self.next_frame
    }

    pub fn background(&self) -> &RunningMinBackground {
        &self.background
    }

    /// For [`RunningMinBackground::freeze`] (pass 2) and snapshot management.
    pub fn background_mut(&mut self) -> &mut RunningMinBackground {
        &mut self.background
    }

    pub fn noise(&self) -> &NoiseMap {
        &self.noise
    }

    pub fn flicker(&self) -> &FlickerCorrector {
        &self.flicker
    }

    /// The last frame's glow low-pass (0 outside the FOV).
    pub fn last_lowpass(&self) -> Vec<f32> {
        self.flatten.lowpass()
    }

    /// Capture config, calibration and running state.
    pub fn state(&self) -> PreprocessState {
        PreprocessState {
            config: self.cfg,
            calibration: self.calib.clone(),
            background: self.background.state(),
            noise: self.noise.state(),
            flicker: self.flicker.state(),
            next_frame: self.next_frame,
        }
    }

    /// Rebuild a preprocessor that continues exactly where `state` was taken.
    pub fn from_state(state: &PreprocessState) -> Result<Preprocessor, PreprocessError> {
        let mut p = Preprocessor::new(state.calibration.clone(), &state.config)?;
        p.restore(state)?;
        Ok(p)
    }

    /// Restore the running state (background, noise, frame counter) from a
    /// state of the same recording. The calibration and config must match.
    pub fn restore(&mut self, state: &PreprocessState) -> Result<(), PreprocessError> {
        if state.calibration != self.calib || state.config != self.cfg {
            return Err(PreprocessError::InvalidState(
                "state belongs to a different calibration or config".into(),
            ));
        }
        self.background.restore(&state.background)?;
        self.noise.restore(&state.noise)?;
        self.flicker.restore(&state.flicker)?;
        self.next_frame = state.next_frame;
        Ok(())
    }
}

/// A serializable snapshot of a [`Preprocessor`]: config, frozen calibration,
/// and the background, noise and flicker-reference state. Background snapshots are not included
/// (each is as large as the background state itself).
#[derive(Debug, Clone, PartialEq)]
pub struct PreprocessState {
    pub config: PreprocessConfig,
    pub calibration: Calibration,
    pub background: BackgroundState,
    pub noise: NoiseState,
    pub flicker: FlickerState,
    pub next_frame: u64,
}

const MAGIC: &[u8; 8] = b"CALAPRE\0";
/// 2: adds the flicker stage (config and reference).
const VERSION: u32 = 2;

impl PreprocessState {
    /// Little-endian binary encoding (see `codec.rs`), versioned.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::new();
        w.bytes(MAGIC);
        w.u32(VERSION);
        let c = &self.config;
        w.usize(c.warmup_frames);
        w.f32(c.fov.rel_threshold);
        w.usize(c.fov.open_radius);
        w.u8(u8::from(c.fov.fit_disk));
        w.usize(c.fov.margin_px);
        w.f32(c.hot.k_sigma);
        w.f32(c.hot.sigma_floor);
        w.f32(c.hot.stuck_rel_std);
        w.u8(u8::from(c.hot.detect_cold));
        w.f32(c.flatten.cell_diameter_px);
        match c.flatten.sigma_px {
            Some(s) => {
                w.u8(1);
                w.f32(s);
            }
            None => {
                w.u8(0);
                w.f32(0.0);
            }
        }
        w.u8(u8::from(c.flatten.local_linear));
        w.u8(c.lines.code());
        w.usize(c.background.boxcar);
        w.f32(c.background.relax_frames);
        w.u32(c.background.snapshot_every);
        match c.noise.estimator {
            NoiseEstimator::MedianTracker { eta } => {
                w.u8(0);
                w.f32(eta);
            }
            NoiseEstimator::MeanAbs => {
                w.u8(1);
                w.f32(0.0);
            }
        }
        w.u32(c.noise.init_frames);
        w.u8(u8::from(c.noise.dither));
        w.u8(c.flicker.mode.code());
        w.f32(c.flicker.tau_frames);
        w.usize(c.flicker.grid_pixels);
        w.f32(c.flicker.clip_sigma);
        w.f32(c.flicker.min_contrast);

        let cal = &self.calibration;
        w.usize(cal.dims.width);
        w.usize(cal.dims.height);
        w.u8s(cal.fov.mask());
        w.f32(cal.fov.threshold());
        let (has_disk, (dy, dx, dr)) = match cal.fov.disk() {
            Some(d) => (1u8, d),
            None => (0u8, (0.0, 0.0, 0.0)),
        };
        w.u8(has_disk);
        w.f32(dy);
        w.f32(dx);
        w.f32(dr);
        w.u8s(cal.hot.flags());
        w.f32(cal.hot.sigma());

        let b = &self.background;
        w.usize(b.boxcar);
        w.usize(b.ring_pos);
        w.usize(b.ring_filled);
        w.u64(b.frames);
        w.f32s(&b.ring);
        w.f32s(&b.floor);

        let n = &self.noise;
        w.u64(n.frames);
        w.f32s(&n.prev);
        w.f32s(&n.mean_abs);
        w.f32s(&n.median);

        w.u64(self.flicker.frames);
        w.f32s(&self.flicker.reference);

        w.u64(self.next_frame);
        w.finish()
    }

    /// Decode [`Self::to_bytes`] output; every inconsistency is an error.
    pub fn from_bytes(bytes: &[u8]) -> Result<PreprocessState, PreprocessError> {
        let mut r = Reader::new(bytes);
        if r.bytes(8, "magic")? != MAGIC {
            return Err(PreprocessError::InvalidState(
                "not a cala preprocess state".into(),
            ));
        }
        let v = r.u32("version")?;
        if v != VERSION {
            return Err(PreprocessError::InvalidState(format!(
                "unsupported state version {v}"
            )));
        }
        let warmup_frames = r.usize("warmup")?;
        let fov = FovConfig {
            rel_threshold: r.f32("fov")?,
            open_radius: r.usize("fov")?,
            fit_disk: r.u8("fov")? != 0,
            margin_px: r.usize("fov")?,
        };
        let hot = HotPixelConfig {
            k_sigma: r.f32("hot")?,
            sigma_floor: r.f32("hot")?,
            stuck_rel_std: r.f32("hot")?,
            detect_cold: r.u8("hot")? != 0,
        };
        let cell_diameter_px = r.f32("flatten")?;
        let has_sigma = r.u8("flatten")? != 0;
        let s = r.f32("flatten")?;
        let flatten = FlattenConfig {
            cell_diameter_px,
            sigma_px: has_sigma.then_some(s),
            local_linear: r.u8("flatten")? != 0,
        };
        let lines = LineMode::from_code(r.u8("lines")?)
            .ok_or_else(|| PreprocessError::InvalidState("bad line mode".into()))?;
        let background = BackgroundConfig {
            boxcar: r.usize("background")?,
            relax_frames: r.f32("background")?,
            snapshot_every: r.u32("background")?,
        };
        let kind = r.u8("noise")?;
        let eta = r.f32("noise")?;
        let estimator = match kind {
            0 => NoiseEstimator::MedianTracker { eta },
            1 => NoiseEstimator::MeanAbs,
            _ => return Err(PreprocessError::InvalidState("bad noise estimator".into())),
        };
        let noise_cfg = NoiseConfig {
            estimator,
            init_frames: r.u32("noise")?,
            dither: r.u8("noise")? != 0,
        };
        let flicker_cfg = FlickerConfig {
            mode: FlickerMode::from_code(r.u8("flicker")?)
                .ok_or_else(|| PreprocessError::InvalidState("bad flicker mode".into()))?,
            tau_frames: r.f32("flicker")?,
            grid_pixels: r.usize("flicker")?,
            clip_sigma: r.f32("flicker")?,
            min_contrast: r.f32("flicker")?,
        };
        let config = PreprocessConfig {
            warmup_frames,
            fov,
            hot,
            flicker: flicker_cfg,
            flatten,
            lines,
            background,
            noise: noise_cfg,
        };
        config
            .validate()
            .map_err(|e| PreprocessError::InvalidState(e.to_string()))?;

        let dims = Dims::new(r.usize("dims")?, r.usize("dims")?)
            .map_err(|e| PreprocessError::InvalidState(e.to_string()))?;
        let mask = r.u8s("fov mask")?;
        let threshold = r.f32("fov threshold")?;
        let has_disk = r.u8("fov disk")? != 0;
        let disk = (r.f32("fov disk")?, r.f32("fov disk")?, r.f32("fov disk")?);
        let flags = r.u8s("hot flags")?;
        let hot_sigma = r.f32("hot sigma")?;
        let fov = FovMask::from_mask(dims, &mask)
            .map_err(|e| PreprocessError::InvalidState(e.to_string()))?
            .with_details(threshold, has_disk.then_some(disk));
        let hot_map = HotPixelMap::from_flags(dims, &flags)
            .map_err(|e| PreprocessError::InvalidState(e.to_string()))?
            .with_sigma(hot_sigma);
        let calibration = Calibration::new(fov, hot_map)
            .map_err(|e| PreprocessError::InvalidState(e.to_string()))?;

        let boxcar = r.usize("background")?;
        let ring_pos = r.usize("background")?;
        let ring_filled = r.usize("background")?;
        let frames = r.u64("background")?;
        let ring = r.f32s("background ring")?;
        let floor = r.f32s("background floor")?;
        let background = BackgroundState {
            dims,
            boxcar,
            ring,
            ring_pos,
            ring_filled,
            floor,
            frames,
        };
        background.check()?;

        let nframes = r.u64("noise")?;
        let noise = NoiseState {
            dims,
            prev: r.f32s("noise prev")?,
            mean_abs: r.f32s("noise mean")?,
            median: r.f32s("noise median")?,
            frames: nframes,
        };
        noise.check(matches!(estimator, NoiseEstimator::MedianTracker { .. }))?;
        let flicker = FlickerState {
            frames: r.u64("flicker")?,
            reference: r.f32s("flicker reference")?,
        };
        // The grid length is checked against the calibration on restore.
        let next_frame = r.u64("next frame")?;
        if !r.done() {
            return Err(PreprocessError::InvalidState("trailing bytes".into()));
        }
        Ok(PreprocessState {
            config,
            calibration,
            background,
            noise,
            flicker,
            next_frame,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic(dims: Dims, frames: usize) -> Vec<Vec<u8>> {
        let (w, h) = (dims.width as f32, dims.height as f32);
        (0..frames)
            .map(|t| {
                (0..dims.pixels())
                    .map(|i| {
                        let (x, y) = ((i % dims.width) as f32, (i / dims.width) as f32);
                        let d = ((x - w / 2.0).powi(2) + (y - h / 2.0).powi(2)).sqrt() / w;
                        let glow = (120.0 * (1.0 - 2.0 * d)).max(0.0);
                        let noise = ((i * 7919 + t * 104729) % 7) as f32 - 3.0;
                        (glow + noise).clamp(0.0, 255.0) as u8
                    })
                    .collect()
            })
            .collect()
    }

    fn calibrated(dims: Dims, frames: &[Vec<u8>], cfg: &PreprocessConfig) -> Preprocessor {
        let mut acc = WarmupAccumulator::new(dims);
        for f in frames {
            acc.push(f).unwrap();
        }
        let cal = Calibration::from_warmup(&acc, cfg).unwrap();
        Preprocessor::new(cal, cfg).unwrap()
    }

    #[test]
    fn registrar_is_called_between_front_and_back() {
        struct Shift(usize);
        impl FrameRegistrar for Shift {
            type Record = usize;
            type Error = String;
            fn register(&mut self, f: &mut [f32], _: usize, _: usize) -> Result<usize, String> {
                f.rotate_right(self.0);
                Ok(self.0)
            }
            fn replay(&self, f: &mut [f32], _: usize, _: usize, r: &usize) -> Result<(), String> {
                f.rotate_right(*r);
                Ok(())
            }
        }
        let dims = Dims::new(24, 20).unwrap();
        let frames = synthetic(dims, 12);
        let cfg = PreprocessConfig::default();
        let mut a = calibrated(dims, &frames, &cfg);
        let mut b = a.clone();
        let mut reg = Shift(3);
        let mut out_a = vec![0.0; dims.pixels()];
        let mut out_b = vec![0.0; dims.pixels()];
        for f in &frames {
            let rec = a.process(f, &mut out_a, &mut reg).unwrap();
            assert_eq!(rec.registration, 3);
            // The same thing by hand: front, replay the record, back.
            b.front(f, &mut out_b).unwrap();
            reg.replay(&mut out_b, dims.width, dims.height, &rec.registration)
                .unwrap();
            b.back(&mut out_b).unwrap();
            assert_eq!(out_a, out_b);
        }

        struct Fails;
        impl FrameRegistrar for Fails {
            type Record = ();
            type Error = &'static str;
            fn register(&mut self, _: &mut [f32], _: usize, _: usize) -> Result<(), &'static str> {
                Err("no template")
            }
            fn replay(
                &self,
                _: &mut [f32],
                _: usize,
                _: usize,
                _: &(),
            ) -> Result<(), &'static str> {
                Ok(())
            }
        }
        let e = a.process(&frames[0], &mut out_a, &mut Fails).unwrap_err();
        assert!(matches!(e, PreprocessError::Registration(ref m) if m.contains("no template")));
    }

    #[test]
    fn degenerate_inputs_never_panic() {
        // 1x1, 1xN and Nx1 frames, constant and saturated content.
        for &(w, h) in &[(1usize, 1usize), (1, 9), (9, 1), (3, 2)] {
            let dims = Dims::new(w, h).unwrap();
            for value in [0u8, 255, 17] {
                let frames = vec![vec![value; dims.pixels()]; 6];
                let cfg = PreprocessConfig::default();
                let mut p = calibrated(dims, &frames, &cfg);
                let mut out = vec![0.0; dims.pixels()];
                for f in &frames {
                    p.process_frame(f, &mut out).unwrap();
                    assert!(out.iter().all(|v| v.is_finite()));
                }
                assert!(p.noise().sigma().iter().all(|v| v.is_finite()));
            }
        }
        // Non-finite f32 input is treated as 0.
        let dims = Dims::new(8, 8).unwrap();
        let frames = synthetic(dims, 4);
        let mut p = calibrated(dims, &frames, &PreprocessConfig::default());
        let mut out = vec![0.0; 64];
        let bad: Vec<f32> = (0..64)
            .map(|i| match i % 3 {
                0 => f32::NAN,
                1 => f32::INFINITY,
                _ => 5.0,
            })
            .collect();
        p.process_frame(&bad, &mut out).unwrap();
        assert!(out.iter().all(|v| v.is_finite()));
        // u16 input works too.
        let wide: Vec<u16> = (0..64).map(|i| i as u16 * 1000).collect();
        p.process_frame(&wide, &mut out).unwrap();
        // Wrong lengths are errors.
        assert!(p.process_frame(&[0u8; 3], &mut out).is_err());
        assert!(p.process_frame(&frames[0], &mut [0.0; 3]).is_err());
        assert!(p.back(&mut [0.0; 63]).is_err());
        // Bad dims, configs and empty warm-up.
        assert!(Dims::new(0, 5).is_err());
        assert!(Dims::new(1 << 13, 1 << 13).is_err());
        assert!(Dims::new(usize::MAX, 2).is_err());
        let acc = WarmupAccumulator::new(dims);
        assert!(Calibration::from_warmup(&acc, &PreprocessConfig::default()).is_err());
        let bad_cfg = PreprocessConfig {
            warmup_frames: 0,
            ..PreprocessConfig::default()
        };
        assert!(bad_cfg.validate().is_err());
        let other = Calibration::new(
            FovMask::full(dims),
            HotPixelMap::empty(Dims::new(4, 4).unwrap()),
        );
        assert!(other.is_err());
    }

    #[test]
    fn state_roundtrip_and_corrupt_bytes() {
        let dims = Dims::new(16, 12).unwrap();
        let frames = synthetic(dims, 20);
        for cfg in [
            PreprocessConfig::default(),
            PreprocessConfig {
                lines: LineMode::Both,
                fov: FovConfig {
                    fit_disk: true,
                    ..FovConfig::default()
                },
                flatten: FlattenConfig {
                    sigma_px: Some(3.0),
                    local_linear: false,
                    ..FlattenConfig::default()
                },
                noise: NoiseConfig {
                    estimator: NoiseEstimator::MeanAbs,
                    init_frames: 4,
                    dither: false,
                },
                ..PreprocessConfig::for_fps(30.0)
            },
        ] {
            let mut p = calibrated(dims, &frames, &cfg);
            let mut out = vec![0.0; dims.pixels()];
            for f in &frames[..7] {
                p.process_frame(f, &mut out).unwrap();
            }
            let st = p.state();
            let bytes = st.to_bytes();
            let back = PreprocessState::from_bytes(&bytes).unwrap();
            assert_eq!(back, st);
            let mut q = Preprocessor::from_state(&back).unwrap();
            let mut out2 = vec![0.0; dims.pixels()];
            for f in &frames[7..] {
                p.process_frame(f, &mut out).unwrap();
                q.process_frame(f, &mut out2).unwrap();
                assert_eq!(out, out2);
            }
            // Every truncation and a few corruptions fail cleanly.
            for cut in [0, 7, 8, 12, 40, bytes.len() / 2, bytes.len() - 1] {
                assert!(
                    PreprocessState::from_bytes(&bytes[..cut]).is_err(),
                    "cut {cut}"
                );
            }
            let mut extra = bytes.clone();
            extra.push(0);
            assert!(PreprocessState::from_bytes(&extra).is_err());
            let mut bad_magic = bytes.clone();
            bad_magic[0] ^= 1;
            assert!(PreprocessState::from_bytes(&bad_magic).is_err());
            // A state from another recording size does not restore.
            let other_dims = Dims::new(10, 10).unwrap();
            let other = calibrated(other_dims, &synthetic(other_dims, 3), &cfg);
            assert!(p.restore(&other.state()).is_err());
        }
        assert!(PreprocessState::from_bytes(&[]).is_err());
        assert!(PreprocessState::from_bytes(&[0u8; 64]).is_err());
    }
}
