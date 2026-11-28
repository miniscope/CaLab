//! Params for the engine's loose-argument entry points: the wasm bindings
//! and `qc_eval`'s flags.
//!
//! Those entry points take a few values each and leave every other one at
//! the engine's own value, which differs from the [`CalaParams`] default in
//! three places: the cluster replay and the merge guard are off, and so is
//! look-back (the app switches them on through its own arguments). The
//! ring and the margin of the slow loop are absolute pixel sizes there,
//! whatever the cell diameter. [`engine_params`] gives that configuration.

use super::{CalaParams, ClusterUpdate};

/// The slow loop's ring radii and tile margin at any cell diameter, px.
pub const ENGINE_RING_PX: [f64; 2] = [12.0, 20.0];
/// See [`ENGINE_RING_PX`].
pub const ENGINE_MARGIN_PX: u32 = 24;

/// The engine's own configuration, as params: [`CalaParams::default`] with
/// the cluster replay, the merge guard and look-back off.
pub fn engine_params() -> CalaParams {
    let mut p = CalaParams::default();
    p.discover.cluster.update = ClusterUpdate::Off;
    p.discover.merge.guard_min_sep_d = None;
    p.lookback.enabled = false;
    p
}

/// Set the cell diameter (px) and keep the slow loop's ring and margin at
/// their pixel sizes ([`ENGINE_RING_PX`], [`ENGINE_MARGIN_PX`]), as the
/// loose-argument entry points keep them. The ratios are chosen so that
/// `ratio × d` gives the pixel size back exactly in f32.
pub fn set_diameter_fixed_ring(p: &mut CalaParams, d: f64) {
    p.scales.cell_diameter_px = Some(d);
    p.discover.ring.inner_per_d = ENGINE_RING_PX[0] / d;
    p.discover.ring.outer_per_d = ENGINE_RING_PX[1] / d;
    p.discover.margin_px = Some(ENGINE_MARGIN_PX);
}

/// The flattening σ argument of the bindings: 0 (or any non-positive
/// value) derives it from the cell diameter (`null`).
pub fn flatten_sigma(px: f32) -> Option<f64> {
    (px > 0.0).then_some(f64::from(px))
}

/// The merge guard argument of the bindings: `Infinity` is off (`null`).
pub fn guard_min_sep(d: f32) -> Option<f64> {
    d.is_finite().then_some(f64::from(d))
}

/// The frame rate argument of the bindings: 0, negative or not finite
/// means "unknown", which the engine has always read as 20 Hz.
pub fn fps_or_default(fps: f32) -> f64 {
    if fps.is_finite() && fps > 0.0 {
        f64::from(fps)
    } else {
        20.0
    }
}

/// A duration the entry point counts in frames, as seconds: at
/// `time.legacy_frame_fps`, or at the recording's `fps` when that is unset
/// (the rate [`super::resolve::resolve`] converts it back at).
pub fn legacy_seconds(p: &CalaParams, fps: f64, frames: f64) -> f64 {
    frames / p.time.legacy_frame_fps.unwrap_or(fps)
}

// ---- the configs of the loose-argument entry points ----
//
// Each function builds params from an entry point's arguments, resolves
// them and returns the config the entry point hands to the engine.

use super::engine::Engine;
use super::resolve::{Context, ResolveError};
use super::{ClusterSign, VisitMode};
use crate::discover::{LookbackConfig, SlowLoopConfig, VisitSchedule};
use crate::motion::MotionConfig;
use crate::preprocess::flatfield::OnlineFlatFieldConfig;
use crate::preprocess::flatten::FlattenConfig;
use crate::preprocess::PreprocessConfig;
use crate::qc::QcConfig;
use crate::trace::SolverConfig;

fn build(p: &CalaParams, fps: f64, frame: [u32; 2]) -> Result<Engine, ResolveError> {
    Engine::build(p, Context { fps, frame })
}

/// `new PreprocessConfig(fps)`: the preprocessing at `fps` (0 = unknown).
pub fn preprocess_config(fps: f32) -> PreprocessConfig {
    build(&engine_params(), fps_or_default(fps), [0, 0])
        .expect("the engine params resolve at a valid frame rate")
        .preprocess
}

/// `new FlatFieldEstimator(…, fps, gainHalfLifeS, offsetHalfLifeS, firstS,
/// refineS, …)`: a duration that is negative or not finite keeps its
/// default.
pub fn flat_field_config(
    fps: f32,
    gain_half_life_s: f32,
    offset_half_life_s: f32,
    first_s: f32,
    refine_s: f32,
) -> OnlineFlatFieldConfig {
    let mut p = engine_params();
    let given = |s: f32| (s.is_finite() && s >= 0.0).then_some(f64::from(s));
    let f = &mut p.flat_field;
    if let Some(s) = given(gain_half_life_s) {
        f.gain_half_life_s = s;
    }
    if let Some(s) = given(offset_half_life_s) {
        f.offset_half_life_s = s;
    }
    if let Some(s) = given(first_s) {
        f.first_map_s = s;
    }
    if let Some(s) = given(refine_s) {
        f.refine_every_s = s;
    }
    build(&p, fps_or_default(fps), [0, 0])
        .expect("the engine params resolve at a valid frame rate")
        .flat_field
}

/// The cluster replay and merge guard arguments of `withConfig`.
#[derive(Clone, Copy, Debug)]
pub struct ClusterArgs {
    pub update: ClusterUpdate,
    pub sign: ClusterSign,
    /// Cell diameters; `None`: off.
    pub guard_min_sep_d: Option<f64>,
}

/// `new SlowLoop` / `new VisitWorker` (`cluster` `None`) and their
/// `withConfig`: the slow loop's flattening and config for a cell diameter
/// `d` (px) and flattening σ `sigma_px` (0 = derived).
pub fn slow_loop_config(
    d: f32,
    sigma_px: f32,
    cluster: Option<ClusterArgs>,
) -> Result<(FlattenConfig, SlowLoopConfig), ResolveError> {
    let mut p = engine_params();
    set_diameter_fixed_ring(&mut p, f64::from(d));
    p.scales.flatten_sigma_px = flatten_sigma(sigma_px);
    if let Some(c) = cluster {
        p.discover.cluster.update = c.update;
        p.discover.cluster.sign = c.sign;
        p.discover.merge.guard_min_sep_d = c.guard_min_sep_d;
    }
    let e = build(&p, 20.0, [0, 0])?;
    Ok((e.preprocess.flatten, e.slow_loop))
}

/// `enableLookback(rate, maxFrames)`.
pub fn lookback_config(rate: f64, max_frames: u32) -> LookbackConfig {
    let mut p = engine_params();
    p.lookback.enabled = true;
    p.lookback.rate = rate;
    p.lookback.horizon_s = legacy_seconds(&p, 20.0, f64::from(max_frames));
    build(&p, 20.0, [0, 0])
        .expect("the engine params resolve")
        .lookback
        .expect("look-back is on")
}

/// `setVisitSchedule(auto)`.
pub fn visit_schedule(auto: bool) -> VisitSchedule {
    let mut p = engine_params();
    p.discover.visit.mode = if auto {
        VisitMode::Auto
    } else {
        VisitMode::Fixed
    };
    build(&p, 20.0, [0, 0])
        .expect("the engine params resolve")
        .visit
}

/// `new TraceEngine(lib, tol, maxSweeps)` and `new FactorExtractor(…)`: 0
/// (or a non-positive tolerance) keeps the default.
pub fn solver_config(tol: f32, max_sweeps: u32) -> SolverConfig {
    let mut p = engine_params();
    if tol > 0.0 {
        p.trace.tol = f64::from(tol);
    }
    if max_sweeps > 0 {
        p.trace.max_sweeps = max_sweeps;
    }
    build(&p, 20.0, [0, 0])
        .expect("the engine params resolve")
        .solver
}

/// `new QcMonitor(…, fps, windowFrames)`: the QC at `fps`, its window
/// `window_frames` (0 = the default). An invalid `fps` gives a config that
/// fails `QcConfig::validate`, as `QcConfig::for_fps` does.
pub fn qc_config(fps: f32, window_frames: u32) -> QcConfig {
    let e = build(&engine_params(), fps_or_default(fps), [0, 0])
        .expect("the engine params resolve at a valid frame rate");
    let mut c = e.qc_at(fps);
    if window_frames > 0 {
        c.window_frames = window_frames as usize;
    }
    c
}

/// The params fields of `MotionOptions`; the options' other fields are
/// engine settings outside the params and are set on the result.
#[derive(Clone, Copy, Debug)]
pub struct MotionArgs {
    pub max_shift: f32,
    /// Frames (0 = frozen template).
    pub template_tau: f32,
    pub nonrigid: bool,
    pub grid: (usize, usize),
    pub max_patch_shift: f32,
}

/// `new MotionCorrector(…, options)`: the motion config of `a`. The params
/// hold one grid size for rows and columns; a non-square grid and a
/// template time constant that is not a whole number of frames are set on
/// the result directly.
pub fn motion_config(a: MotionArgs) -> MotionConfig {
    let mut p = engine_params();
    let tau_s = legacy_seconds(&p, 20.0, f64::from(a.template_tau));
    let m = &mut p.motion;
    m.max_shift_px = f64::from(a.max_shift);
    m.template_tau_s = tau_s;
    m.nonrigid.enabled = a.nonrigid;
    m.nonrigid.grid = a.grid.0 as u32;
    m.nonrigid.max_patch_shift_px = f64::from(a.max_patch_shift);
    let mut c = build(&p, 20.0, [0, 0])
        .expect("the engine params resolve")
        .motion;
    c.template_tau = a.template_tau;
    if let Some(n) = c.nonrigid.as_mut() {
        n.grid = a.grid;
    }
    c
}
