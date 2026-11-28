//! [`resolve`]: params plus the recording's context to the engine's units.
//!
//! [`EngineView`] holds every engine value [`CalaParams`] sets, in the units
//! the engine counts in: frames and pixels. Durations convert by one rule,
//! [`frames`]. Two groups of durations exist:
//!
//! * converted at the recording's frame rate: the background relaxation and
//!   the flat-field half-lives, first map and refit interval;
//! * converted at `time.legacy_frame_fps` (default 20) when it is set: every
//!   other duration, which the engine counts in fixed frames.
//!
//! Nothing in the engine is built from the view yet. The golden files in
//! `crates/cala/tests/golden/` pin it at the default params, so a change of
//! an engine value shows up as a diff there.

use serde::{Deserialize, Serialize};

use super::{
    BackgroundModel, CalaParams, ClusterAdmit, ClusterSign, ClusterUpdate, FactorsMode,
    FinalSettleLevel, Flicker, Lines, MergeRule, RefineGate,
};

/// What [`resolve`] needs to know of the recording.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Context {
    /// The recording's frame rate, Hz (before `time.fps_override`).
    pub fps: f64,
    /// Frame width and height, px.
    pub frame: [u32; 2],
}

/// Why params could not be resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolveError {
    /// JSON pointer of the offending field.
    pub pointer: String,
    pub message: String,
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.pointer, self.message)
    }
}

impl std::error::Error for ResolveError {}

/// How the cell diameter in pixels was found. Tags are open: a later
/// source (a per-device optics table, an online estimate) adds a variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiameterSource {
    /// `scales.cell_diameter_px`, set directly.
    Px,
    /// `scales.expected_cell_diameter_um` through the optics.
    Optics,
}

/// The resolved cell diameter.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct CellDiameter {
    /// Diameter, px of the frame.
    pub px: f64,
    /// Where `px` came from.
    pub source: DiameterSource,
    /// Size of one frame pixel at the sample, µm, when the optics give it.
    pub um_per_px: Option<f64>,
}

/// Every engine value the params set, in frames and pixels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EngineView {
    /// The frame rate in force, Hz.
    pub fps: f64,
    /// The rate the fixed-frame durations are converted at, Hz.
    pub legacy_frame_fps: f64,
    pub frame: [u32; 2],
    pub cell_diameter: CellDiameter,
    pub preprocess: PreprocessView,
    pub motion: MotionView,
    pub flat_field: FlatFieldView,
    pub slow_loop: SlowLoopView,
    pub visit: VisitView,
    pub lookback: LookbackView,
    pub settle: SettleView,
    pub trace: TraceView,
    pub qc: QcView,
    pub factors: FactorsView,
}

/// `PreprocessConfig` values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreprocessView {
    pub warmup_frames: u64,
    pub flicker: Flicker,
    pub lines: Lines,
    pub fov_rel_threshold: f64,
    pub fov_fit_disk: bool,
    pub fov_margin_px: u32,
    pub hot_pixel_k_sigma: f64,
    pub background_boxcar: u64,
    /// Frames, unrounded (the engine keeps a float).
    pub background_relax_frames: f64,
    pub flatten_cell_diameter_px: f64,
    pub flatten_sigma_px: f64,
}

/// `MotionConfig` values and the motion warm-up.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MotionView {
    pub max_shift: f64,
    pub template_tau: f64,
    pub template_refresh: u64,
    pub warmup_frames: u64,
    /// `None`: rigid only.
    pub nonrigid: Option<NonRigidView>,
    pub session_fix: bool,
}

/// `NonRigidConfig` values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NonRigidView {
    pub grid: [u32; 2],
    pub max_patch_shift: f64,
}

/// `OnlineFlatFieldConfig` values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FlatFieldView {
    pub enabled: bool,
    pub half_life_frames: u64,
    pub offset_half_life_frames: u64,
    pub first_frames: u64,
    pub refine_every_frames: u64,
}

/// `SlowLoopConfig` values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SlowLoopView {
    pub cell_diameter_px: f64,
    pub psf_sigma_px: f64,
    pub tile_px: u32,
    pub margin_px: u32,
    pub frames_per_tile: u32,
    pub reservoir_max_bytes: u64,
    pub event_half_life_frames: u64,
    pub accept_z: f64,
    pub event_z: f64,
    pub min_events: u32,
    pub merge_corr: f64,
    pub commit_interval_frames: u32,
    pub reject_cooldown_frames: u64,
    pub event_frames: u64,
    pub probation_frames: u64,
    pub probe_gap_frames: u64,
    pub stats_half_life_frames: u64,
    pub support_alpha: f64,
    pub refine_z: f64,
    pub refine_gate: RefineGate,
    pub merge_rule: MergeRule,
    pub reservoir_refine_frames: u64,
    pub merge_z: f64,
    pub merge_guard_max_ovl: f64,
    pub merge_refit_max_ovl: f64,
    /// Cell diameters; `None`: off.
    pub merge_guard_min_sep: Option<f64>,
    pub warm_start: bool,
    pub joint_neighbours: bool,
    pub joint_update: ClusterUpdate,
    pub cluster_rho_min: f64,
    pub cluster_max: u32,
    pub joint_sign_rule: ClusterSign,
    pub joint_iters: u32,
    pub joint_admit: ClusterAdmit,
    pub joint_carry: bool,
    pub joint_l1: f64,
    pub churn_readd_window_frames: u64,
    pub churn_frames: u64,
    pub background: BackgroundModel,
    /// Inner and outer ring radius, px.
    pub ring_px: [f64; 2],
    pub seed: u32,
    /// Fast-loop work units per frame.
    pub budget: f64,
}

/// `VisitSchedule` values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VisitView {
    pub auto: bool,
    pub target: f64,
}

/// The look-back settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LookbackView {
    pub enabled: bool,
    pub rate: f64,
    pub max_frames: u64,
}

/// The settle settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettleView {
    pub background_cap: f64,
    pub final_level: FinalSettleLevel,
    pub final_max_frames: u64,
    pub on_factors_joint_update: ClusterUpdate,
    pub on_factors_merge_guard_min_sep: Option<f64>,
}

/// `SolverConfig` values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TraceView {
    pub tol: f64,
    pub max_sweeps: u32,
}

/// `QcConfig` values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QcView {
    pub enabled: bool,
    pub min_snr: f64,
    pub pair_r: f64,
    pub motion_r2_flag: f64,
}

/// The factor settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FactorsView {
    pub mode: FactorsMode,
    pub window_frames: u64,
}

/// `seconds` at `fps` as a whole number of frames: `max(1, round(s × fps))`,
/// in f64; 0 stays 0 (where 0 means off).
pub fn frames(seconds: f64, fps: f64) -> u64 {
    if seconds == 0.0 {
        0
    } else {
        (seconds * fps).round().max(1.0) as u64
    }
}

/// The cell diameter in pixels: `scales.cell_diameter_px` when set, else
/// `scales.expected_cell_diameter_um` over the optics' µm per frame pixel.
pub fn cell_diameter(p: &CalaParams, frame: [u32; 2]) -> Result<CellDiameter, ResolveError> {
    let um_per_px = um_per_px(p, frame);
    if let Some(px) = p.scales.cell_diameter_px {
        return Ok(CellDiameter {
            px,
            source: DiameterSource::Px,
            um_per_px,
        });
    }
    let err = |message: &str| ResolveError {
        pointer: "/scales/expected_cell_diameter_um".into(),
        message: message.into(),
    };
    let um = p
        .scales
        .expected_cell_diameter_um
        .ok_or_else(|| err("set the cell diameter in µm or in pixels"))?;
    let per = um_per_px.ok_or_else(|| {
        err("the optics (sensor pixel size, magnification) are needed to convert µm to pixels")
    })?;
    Ok(CellDiameter {
        px: um / per,
        source: DiameterSource::Optics,
        um_per_px: Some(per),
    })
}

/// µm per frame pixel at the sample, when the sensor pixel size and the
/// magnification are known.
fn um_per_px(p: &CalaParams, frame: [u32; 2]) -> Option<f64> {
    let o = &p.optics;
    let (pixel, mag) = (o.sensor_pixel_um?, o.magnification?);
    let binning = match (o.binning, o.sensor_width_px) {
        (Some(b), _) => f64::from(b),
        (None, Some(w)) if frame[0] > 0 => (f64::from(w) / f64::from(frame[0])).round().max(1.0),
        _ => 1.0,
    };
    Some(pixel * binning / mag)
}

/// `p` in the engine's units for a recording described by `ctx`.
pub fn resolve(p: &CalaParams, ctx: Context) -> Result<EngineView, ResolveError> {
    let fps = p.time.fps_override.unwrap_or(ctx.fps);
    if !(fps.is_finite() && fps > 0.0) {
        return Err(ResolveError {
            pointer: "/time/fps_override".into(),
            message: format!("the frame rate must be positive, got {fps}"),
        });
    }
    let legacy = p.time.legacy_frame_fps.unwrap_or(fps);
    let lf = |s: f64| frames(s, legacy);
    let rf = |s: f64| frames(s, fps);
    let d = cell_diameter(p, ctx.frame)?;
    let dpx = d.px;
    let s = &p.scales;
    let pre = &p.preprocess;
    let m = &p.motion;
    let ff = &p.flat_field;
    let dis = &p.discover;
    Ok(EngineView {
        fps,
        legacy_frame_fps: legacy,
        frame: ctx.frame,
        cell_diameter: d,
        preprocess: PreprocessView {
            warmup_frames: lf(pre.warmup_s),
            flicker: pre.flicker,
            lines: pre.lines,
            fov_rel_threshold: pre.fov.rel_threshold,
            fov_fit_disk: pre.fov.fit_disk,
            fov_margin_px: pre.fov.margin_px,
            hot_pixel_k_sigma: pre.hot_pixel_k_sigma,
            background_boxcar: lf(pre.background.boxcar_s),
            background_relax_frames: pre.background.relax_s * fps,
            flatten_cell_diameter_px: dpx,
            flatten_sigma_px: s.flatten_sigma_px.unwrap_or(s.flatten_sigma_per_d * dpx),
        },
        motion: MotionView {
            max_shift: m.max_shift_px,
            template_tau: lf(m.template_tau_s) as f64,
            template_refresh: lf(m.template_refresh_s),
            warmup_frames: lf(m.warmup_s),
            nonrigid: m.nonrigid.enabled.then(|| NonRigidView {
                grid: [m.nonrigid.grid, m.nonrigid.grid],
                max_patch_shift: m.nonrigid.max_patch_shift_px,
            }),
            session_fix: m.session_fix,
        },
        flat_field: FlatFieldView {
            enabled: ff.enabled,
            half_life_frames: rf(ff.gain_half_life_s),
            offset_half_life_frames: rf(ff.offset_half_life_s),
            first_frames: rf(ff.first_map_s),
            refine_every_frames: rf(ff.refine_every_s),
        },
        slow_loop: SlowLoopView {
            cell_diameter_px: dpx,
            psf_sigma_px: s.psf_sigma_px,
            tile_px: dis.tile_px,
            margin_px: dis
                .margin_px
                .unwrap_or_else(|| (2.4 * dpx).ceil().max(24.0) as u32),
            frames_per_tile: dis.frames_per_tile,
            reservoir_max_bytes: u64::from(dis.reservoir_max_mb) << 20,
            event_half_life_frames: lf(dis.event_half_life_s),
            accept_z: dis.accept_z,
            event_z: dis.event_z,
            min_events: dis.min_events,
            merge_corr: dis.merge.corr,
            commit_interval_frames: dis.commit_interval_frames,
            reject_cooldown_frames: lf(dis.reject_cooldown_s),
            event_frames: lf(dis.event_s),
            probation_frames: lf(dis.probation_s),
            probe_gap_frames: lf(dis.probe_gap_s),
            stats_half_life_frames: lf(dis.stats_half_life_s),
            support_alpha: dis.support_alpha,
            refine_z: dis.refine.z,
            refine_gate: dis.refine.gate,
            merge_rule: dis.merge.rule,
            reservoir_refine_frames: lf(dis.reservoir_refine_s),
            merge_z: dis.merge.z,
            merge_guard_max_ovl: dis.merge.guard_max_ovl,
            merge_refit_max_ovl: dis.merge.refit_max_ovl,
            merge_guard_min_sep: dis.merge.guard_min_sep_d,
            warm_start: dis.warm_start,
            joint_neighbours: dis.cluster.neighbours,
            joint_update: dis.cluster.update,
            cluster_rho_min: dis.cluster.rho_min,
            cluster_max: dis.cluster.max,
            joint_sign_rule: dis.cluster.sign,
            joint_iters: dis.cluster.iters,
            joint_admit: dis.cluster.admit,
            joint_carry: dis.cluster.carry,
            joint_l1: dis.cluster.l1,
            churn_readd_window_frames: lf(dis.churn.readd_window_s),
            churn_frames: lf(dis.churn.churn_s),
            background: dis.background,
            ring_px: [dis.ring.inner_per_d * dpx, dis.ring.outer_per_d * dpx],
            seed: dis.seed,
            budget: dis.budget,
        },
        visit: VisitView {
            auto: dis.visit.mode == super::VisitMode::Auto,
            target: dis.visit.target,
        },
        lookback: LookbackView {
            enabled: p.lookback.enabled,
            rate: p.lookback.rate,
            max_frames: lf(p.lookback.horizon_s),
        },
        settle: SettleView {
            background_cap: p.settle.background.cap,
            final_level: p.settle.final_.level,
            final_max_frames: lf(p.settle.final_.max_s.unwrap_or(3.0 * dis.stats_half_life_s)),
            on_factors_joint_update: p.settle.on_factors.cluster_update,
            on_factors_merge_guard_min_sep: p.settle.on_factors.guard_min_sep_d,
        },
        trace: TraceView {
            tol: p.trace.tol,
            max_sweeps: p.trace.max_sweeps,
        },
        qc: QcView {
            enabled: p.qc.enabled,
            min_snr: p.qc.pass.min_snr,
            pair_r: p.qc.pass.pair_r,
            motion_r2_flag: p.qc.pass.motion_r2_flag,
        },
        factors: FactorsView {
            mode: p.factors.mode,
            window_frames: lf(p.factors.window_s),
        },
    })
}

/// Frame rates of the golden files: 20 (where both groups of durations
/// agree) and 30 (where they differ).
pub const GOLDEN_FPS: [u32; 2] = [20, 30];

/// The frame of the golden files, px.
pub const GOLDEN_FRAME: [u32; 2] = [600, 600];

/// The golden file of `fps`, relative to the crate root.
pub fn golden_path(fps: u32) -> String {
    format!("tests/golden/engine-view-fps{fps}.json")
}

/// The golden file's text: the default params resolved at `fps` on a
/// [`GOLDEN_FRAME`] frame, pretty-printed with a trailing newline.
pub fn golden_text(fps: u32) -> String {
    let view = resolve(
        &CalaParams::default(),
        Context {
            fps: f64::from(fps),
            frame: GOLDEN_FRAME,
        },
    )
    .expect("the default params resolve");
    let mut s = serde_json::to_string_pretty(&view).expect("the view serialises");
    s.push('\n');
    s
}
