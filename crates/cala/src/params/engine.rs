//! The engine's config structs, built from resolved params.
//!
//! [`Engine::build`] resolves [`CalaParams`] for a recording and builds
//! every config the engine reads: preprocessing (with its flattening),
//! motion, the online flat field, the slow loop and its visit schedule,
//! look-back, the trace solver and the QC. Engine code keeps reading those
//! structs; only their construction lives here.
//!
//! Values the params do not set (the engine's internal constants) come
//! from each struct's own `Default` or `for_fps`. A value the params set is
//! written over it in the engine's own arithmetic (f32), so the default
//! params give exactly the configs those functions give.

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::resolve::{resolve, Context, EngineView, ResolveError};
use super::{
    BackgroundModel, CalaParams, ClusterAdmit, ClusterSign, ClusterUpdate, Flicker, Lines,
    MergeRule, RefineGate,
};
use crate::discover::{
    JointAdmit, JointSign, JointUpdate, LookbackConfig, MergeRule as EMergeRule,
    RefineGate as ERefineGate, SlowLoopConfig, VisitSchedule,
};
use crate::motion::{MotionConfig, NonRigidConfig};
use crate::preprocess::flatfield::OnlineFlatFieldConfig;
use crate::preprocess::flatten::{FlattenConfig, SIGMA_PER_DIAMETER};
use crate::preprocess::flicker::FlickerMode;
use crate::preprocess::lines::LineMode;
use crate::preprocess::PreprocessConfig;
use crate::qc::QcConfig;
use crate::trace::{BackgroundModel as EBackground, SolverConfig};

/// Every engine config of a run, built from one set of params.
#[derive(Clone, Debug)]
pub struct Engine {
    /// The params in the engine's units.
    pub view: EngineView,
    /// [`fingerprint`] of the params.
    pub fingerprint: [u8; 32],
    pub preprocess: PreprocessConfig,
    pub motion: MotionConfig,
    /// Frames the motion corrector's template is built from.
    pub motion_warmup_frames: usize,
    pub flat_field: OnlineFlatFieldConfig,
    pub slow_loop: SlowLoopConfig,
    pub visit: VisitSchedule,
    /// `None`: look-back off.
    pub lookback: Option<LookbackConfig>,
    pub solver: SolverConfig,
    /// The QC at the recording's frame rate.
    pub qc: QcConfig,
}

impl Engine {
    /// Resolve `p` for the recording `ctx` and build every config.
    pub fn build(p: &CalaParams, ctx: Context) -> Result<Engine, ResolveError> {
        let view = resolve(p, ctx)?;
        let fingerprint = fingerprint(p);
        let fps = view.fps as f32;
        Ok(Engine {
            preprocess: preprocess(p, &view, fps),
            motion: motion(&view),
            motion_warmup_frames: view.motion.warmup_frames as usize,
            flat_field: flat_field(&view, fps),
            slow_loop: slow_loop(&view, &fingerprint),
            visit: visit(&view),
            lookback: view.lookback.enabled.then(|| LookbackConfig {
                rate: view.lookback.rate,
                max_frames: view.lookback.max_frames as usize,
                ..LookbackConfig::default()
            }),
            solver: SolverConfig {
                tol: view.trace.tol as f32,
                max_sweeps: view.trace.max_sweeps,
                ..SolverConfig::default()
            },
            qc: qc(&view, fps),
            fingerprint,
            view,
        })
    }

    /// The QC config at frame rate `fps` instead of the recording's, with
    /// the params' pass rule.
    pub fn qc_at(&self, fps: f32) -> QcConfig {
        qc(&self.view, fps)
    }
}

/// The flattening of the preprocessing (the slow loop builds its own copy
/// from the same config).
pub fn flatten(p: &CalaParams, view: &EngineView) -> FlattenConfig {
    let d = view.cell_diameter.px as f32;
    let s = &p.scales;
    // The engine derives σ from the diameter itself when it is the default
    // multiple; only another value is passed explicitly.
    let sigma_px = match s.flatten_sigma_px {
        Some(px) => Some(px as f32),
        None if s.flatten_sigma_per_d as f32 == SIGMA_PER_DIAMETER => None,
        None => Some(s.flatten_sigma_per_d as f32 * d),
    };
    FlattenConfig {
        cell_diameter_px: d,
        sigma_px,
        ..FlattenConfig::default()
    }
}

fn preprocess(p: &CalaParams, v: &EngineView, fps: f32) -> PreprocessConfig {
    let pv = &v.preprocess;
    let mut c = PreprocessConfig::for_fps(fps);
    c.warmup_frames = pv.warmup_frames as usize;
    c.flicker.mode = match pv.flicker {
        Flicker::Off => FlickerMode::Off,
        Flicker::Additive => FlickerMode::Additive,
        Flicker::Multiplicative => FlickerMode::Multiplicative,
        Flicker::Both => FlickerMode::Both,
    };
    c.lines = match pv.lines {
        Lines::Off => LineMode::Off,
        Lines::Rows => LineMode::Rows,
        Lines::Columns => LineMode::Columns,
        Lines::Both => LineMode::Both,
    };
    c.fov.rel_threshold = pv.fov_rel_threshold as f32;
    c.fov.fit_disk = pv.fov_fit_disk;
    c.fov.margin_px = pv.fov_margin_px as usize;
    c.hot.k_sigma = pv.hot_pixel_k_sigma as f32;
    c.background.boxcar = pv.background_boxcar as usize;
    c.background.relax_frames = pv.background_relax_frames as f32;
    c.flatten = flatten(p, v);
    c
}

fn motion(v: &EngineView) -> MotionConfig {
    let m = &v.motion;
    MotionConfig {
        max_shift: m.max_shift as f32,
        template_tau: m.template_tau as f32,
        template_refresh: m.template_refresh as usize,
        nonrigid: m.nonrigid.as_ref().map(|n| NonRigidConfig {
            grid: (n.grid[0] as usize, n.grid[1] as usize),
            max_patch_shift: n.max_patch_shift as f32,
            ..NonRigidConfig::default()
        }),
        ..MotionConfig::default()
    }
}

fn flat_field(v: &EngineView, fps: f32) -> OnlineFlatFieldConfig {
    let f = &v.flat_field;
    let mut c = OnlineFlatFieldConfig::for_fps(fps);
    c.estimator.half_life_frames = f.half_life_frames as f64;
    c.estimator.offset_half_life_frames = f.offset_half_life_frames as f64;
    c.first_frames = f.first_frames;
    c.refine_every_frames = f.refine_every_frames;
    c
}

fn slow_loop(v: &EngineView, fp: &[u8; 32]) -> SlowLoopConfig {
    let s = &v.slow_loop;
    let mut c = SlowLoopConfig {
        cell_diameter_px: s.cell_diameter_px as f32,
        psf_sigma_px: s.psf_sigma_px as f32,
        tile_px: s.tile_px as usize,
        margin_px: s.margin_px as usize,
        frames_per_tile: s.frames_per_tile as usize,
        reservoir_max_bytes: s.reservoir_max_bytes as usize,
        event_half_life_frames: s.event_half_life_frames as f32,
        accept_z: s.accept_z as f32,
        event_z: s.event_z as f32,
        min_events: s.min_events,
        merge_corr: s.merge_corr as f32,
        commit_interval_frames: u64::from(s.commit_interval_frames),
        reject_cooldown_frames: s.reject_cooldown_frames,
        event_frames: s.event_frames as u32,
        probation_frames: s.probation_frames,
        probe_gap_frames: s.probe_gap_frames,
        stats_half_life_frames: s.stats_half_life_frames as f32,
        support_alpha: s.support_alpha as f32,
        refine_z: s.refine_z as f32,
        refine_gate: match s.refine_gate {
            RefineGate::Legacy => ERefineGate::Legacy,
            RefineGate::SplitHalf => ERefineGate::SplitHalf,
        },
        merge_rule: match s.merge_rule {
            MergeRule::Legacy => EMergeRule::Legacy,
            MergeRule::SplitHalf => EMergeRule::SplitHalf,
        },
        reservoir_refine_frames: s.reservoir_refine_frames,
        merge_z: s.merge_z as f32,
        merge_guard_max_ovl: s.merge_guard_max_ovl as f32,
        merge_refit_max_ovl: s.merge_refit_max_ovl as f32,
        merge_guard_min_sep: s.merge_guard_min_sep.map_or(f32::INFINITY, |d| d as f32),
        warm_start: s.warm_start,
        joint_neighbours: s.joint_neighbours,
        joint_update: match s.joint_update {
            ClusterUpdate::Off => JointUpdate::Off,
            ClusterUpdate::Refine => JointUpdate::Refine,
            ClusterUpdate::All => JointUpdate::All,
        },
        cluster_rho_min: s.cluster_rho_min as f32,
        cluster_max: s.cluster_max as usize,
        joint_sign_rule: match s.joint_sign_rule {
            ClusterSign::Off => JointSign::Off,
            ClusterSign::Own => JointSign::Own,
            ClusterSign::All => JointSign::All,
        },
        joint_iters: s.joint_iters as usize,
        joint_admit: match s.joint_admit {
            ClusterAdmit::Cluster => JointAdmit::Cluster,
            ClusterAdmit::Member => JointAdmit::Member,
        },
        joint_carry: s.joint_carry,
        joint_l1: s.joint_l1 as f32,
        background: match s.background {
            BackgroundModel::None => EBackground::None,
            BackgroundModel::Ring => EBackground::Ring {
                inner_px: s.ring_px[0] as f32,
                outer_px: s.ring_px[1] as f32,
            },
        },
        seed: u64::from(s.seed),
        fingerprint: u64::from_le_bytes(fp[..8].try_into().expect("8 bytes")),
        ..SlowLoopConfig::default()
    };
    c.churn.readd_window_frames = s.churn_readd_window_frames;
    c.churn.churn_frames = s.churn_frames;
    c
}

fn visit(v: &EngineView) -> VisitSchedule {
    let base = if v.visit.auto {
        VisitSchedule::auto()
    } else {
        VisitSchedule::fixed()
    };
    VisitSchedule {
        target: v.visit.target,
        ..base
    }
}

fn qc(v: &EngineView, fps: f32) -> QcConfig {
    let mut c = QcConfig::for_fps(fps);
    c.pass.min_snr = v.qc.min_snr as f32;
    c.pass.pair_r = v.qc.pair_r as f32;
    c.motion_r2_flag = v.qc.motion_r2_flag as f32;
    c
}

/// The params' fingerprint: SHA-256 of their canonical JSON (keys sorted,
/// no whitespace), over the fields that may change results. The `compute`
/// block is left out except `compute.repeatable`, and the `export` block
/// is left out: they change how long a run takes or what is written, not
/// what it finds. Two runs with the same fingerprint were asked for the
/// same results.
pub fn fingerprint(p: &CalaParams) -> [u8; 32] {
    let mut v = serde_json::to_value(p).expect("params serialise");
    if let Value::Object(m) = &mut v {
        m.remove("export");
        if let Some(Value::Object(c)) = m.get_mut("compute") {
            c.retain(|k, _| k == "repeatable");
        }
    }
    let mut s = String::new();
    canonical(&v, &mut s);
    Sha256::digest(s.as_bytes()).into()
}

/// [`fingerprint`] as 64 lowercase hex digits.
pub fn fingerprint_hex(p: &CalaParams) -> String {
    fingerprint(p).iter().map(|b| format!("{b:02x}")).collect()
}

/// `v` as JSON with every object's keys in byte order and no whitespace.
fn canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                canonical(&m[k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(x, out);
            }
            out.push(']');
        }
        _ => out.push_str(&v.to_string()),
    }
}
