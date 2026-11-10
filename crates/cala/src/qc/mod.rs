//! Online quality control: per-cell, demixing and global metrics computed
//! alongside the fast loop, from the data alone (no ground truth).
//!
//! [`QcMonitor::observe`] takes each preprocessed frame with the fast loop's
//! [`FrameTraces`] and the [`Library`] that produced them. It keeps a bounded
//! state: a ring of the last `window_frames` trace values per cell (carried
//! across library versions by cell id), a block-averaged residual map, and a
//! few numbers per cell and footprint. Per frame it only appends the traces;
//! every `residual_every` frames it renders the model to measure the
//! residual; and it refreshes the window statistics of `n / refresh_frames`
//! cells, round-robin, so the cost is flat in the recording length.
//!
//! # What each metric is worth
//!
//! Every metric was checked against ground truth (`examples/qc_eval.rs`):
//! minisim recordings run through the merged fast and slow loops (1759
//! cells, 1540 true positives, three recordings), the GT footprints with a
//! share deliberately wrong (shifted, merged, split, a neighbour deleted),
//! and 10 min of real CA1 data against Minian. Numbers are AUC for "detected
//! cell is real" and Spearman ρ with the true trace r.
//!
//! * **Trace quality, validated.** [`TraceStats::peak_snr`] (CaLab robust
//!   peak SNR): AUC 0.80, ρ 0.78 on sims, 0.95 with oracle footprints; on
//!   real data AUC 0.75 for "also found by Minian", ρ 0.39 with the trace r
//!   against Minian. `proj_r` (trace vs the cell's own footprint
//!   projection): AUC 0.71, ρ 0.57 (oracle); real AUC 0.64, ρ 0.37.
//! * **Demixing, validated.** `vif` (noise inflation from the local Gram
//!   matrix) and `max_overlap` rank true crosstalk (ρ 0.44-0.47 with the
//!   neighbours' share of the trace variance). `max_neighbour_r` finds split
//!   cells (AUC 1.00 against unperturbed cells; r > 0.8 flags 87 % of split
//!   halves and no unperturbed cell) and duplicates: in a pair above 0.8 the
//!   lower-SNR member is the extra cell in 22 of 45 pairs, the other in 3.
//!   `fp_error` (residual a cell leaves when it fires, relative to its SNR)
//!   ranks wrong footprints (AUC 0.68-0.73 for shifted, merged, missing
//!   neighbour; inverted AUC 0.71 for real cells) but no threshold separates
//!   them, so it is a colour scale, not a flag.
//! * **Regime-dependent, descriptive only.** `diff_skew` and `asymmetry`
//!   (fast rise, slow decay) predict real cells on sims (AUC 0.82 / 0.66) but
//!   not on the real recording (0.52 / 0.60), whose transients rise over
//!   several frames. `slow_frac` is not a failure: on the real recording the
//!   slow "humps" are long calcium events that Minian finds too (low-pass r
//!   0.89), and slow share correlates *positively* with agreement with
//!   Minian (ρ 0.63). `events`, widths, `zero_frac` (non-negativity clamp),
//!   footprint shape and stability are descriptive.
//! * **Global, validated.** `explained` and `residual_excess` track true
//!   recall over a run (ρ 0.93-1.00 and −0.87 to −1.00), and `adds_per_min`
//!   falls as recall rises (ρ −0.64 to −0.92). `pass_frac` and the median
//!   SNR do not track recall consistently.
//! * **Convergence: existing-cell stability.** Cell discovery never stops
//!   on long recordings (batch tools find nearly twice the cells in 30-120
//!   min as in 10-30 min), so adds per minute cannot say whether a run has
//!   converged. What should settle is the cells already found: every
//!   `stability_lag_s` the monitor snapshots each cell's unfiltered
//!   footprint and trace noise σ (own footprint and demixing with its
//!   neighbours), and compares every cell older than `stable_min_age_s` with
//!   the snapshot one to two lags old (`stable_frac`, `fp_stability`,
//!   `trace_sigma_change`; per cell `fp_ref_cos`, `sigma_ref_change`). On
//!   minisim, `stable_frac` rises from ~0.6 to a plateau of 0.87-0.96 while
//!   GT precision is flat. It is a run-level signal, not a per-cell flag:
//!   cells that are unstable at a given moment are true positives about as
//!   often as stable ones (0.96 vs 0.98, 8-min runs; 0.89 vs 0.96, 20 min)
//!   with traces as good (true r 0.95-0.96 either way). The slow loop's add
//!   classification (re-adds, adds removed again, removals of established
//!   cells: `crate::discover::ChurnCounts`) is the other half of the
//!   convergence rule, which lives in the app (`apps/cala/src/lib/qc.ts`).

// Index loops over pixels and cells read more clearly here; `!(x > 0.0)`
// deliberately treats NaN as "not positive".
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

pub mod stats;

#[cfg(feature = "jsbindings")]
mod js;

use std::collections::{HashMap, VecDeque};

use crate::preprocess::Dims;
use crate::trace::{check_len, BgTerms, FrameTraces, Library, TraceError};
pub use stats::{trace_stats, TraceStats};

/// Settings of the QC monitor.
#[derive(Debug, Clone, PartialEq)]
pub struct QcConfig {
    /// Frame rate, Hz (event rates per minute, slow-share window).
    pub fps: f32,
    /// Trace history per cell, frames.
    pub window_frames: usize,
    /// Every cell's statistics are recomputed at least every this many
    /// frames.
    pub refresh_frames: usize,
    /// History a cell needs before its trace statistics are reported.
    pub min_frames: usize,
    /// Event threshold, noise units.
    pub event_z: f32,
    /// Width of the slow moving average for `slow_frac`, seconds.
    pub slow_window_s: f32,
    /// Width of the running mean events are detected on, seconds.
    pub smooth_s: f32,
    /// The model is rendered for the residual every this many frames.
    pub residual_every: u32,
    /// Time constant of the residual averages, frames.
    pub residual_tau_frames: f32,
    /// Side of the residual map's blocks, px.
    pub block_px: usize,
    /// Overlapping neighbours kept per cell (nearest first).
    pub max_neighbours: usize,
    /// Smallest |normalised overlap| of filtered footprints that makes two
    /// cells neighbours (cells whose support disks overlap always are).
    pub min_overlap: f32,
    /// Window of the churn rates, frames.
    pub churn_window_frames: u64,
    /// Existing-cell stability: each cell is compared with its state
    /// between one and two of these lags ago (seconds).
    pub stability_lag_s: f32,
    /// Only cells at least this old (seconds) are judged for stability.
    pub stable_min_age_s: f32,
    /// A cell is stable when its unfiltered footprint has at least this
    /// cosine with that earlier one...
    pub stable_cos: f32,
    /// ...and its trace noise σ (own footprint and demixing with its
    /// neighbours) changed by less than this fraction.
    pub stable_sigma: f32,
    /// Thresholds of [`CellQc::pass`].
    pub pass: PassRule,
}

/// Thresholds of the per-cell pass/fail call (validated in
/// `examples/qc_eval.rs`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PassRule {
    /// Smallest peak SNR (noise units).
    pub min_snr: f32,
    /// Trace correlation with an overlapping neighbour above which the two
    /// are a correlated pair (split, duplicate or crosstalk).
    pub pair_r: f32,
}

/// Peak SNR below `min_snr`.
pub const FLAG_LOW_SNR: u32 = 1;
/// Trace follows an overlapping neighbour's (r > `pair_r`).
pub const FLAG_CORRELATED_PAIR: u32 = 2;
/// The lower-SNR member of a correlated pair (the likely extra cell).
pub const FLAG_LIKELY_DUPLICATE: u32 = 4;
/// Not enough history yet.
pub const FLAG_UNMEASURED: u32 = 8;

impl Default for QcConfig {
    fn default() -> QcConfig {
        QcConfig {
            fps: 20.0,
            window_frames: 1200,
            refresh_frames: 100,
            min_frames: 100,
            event_z: 4.0,
            slow_window_s: 5.0,
            smooth_s: 0.25,
            residual_every: 8,
            residual_tau_frames: 600.0,
            block_px: 8,
            max_neighbours: 8,
            min_overlap: 0.02,
            churn_window_frames: 1200,
            stability_lag_s: 60.0,
            stable_min_age_s: 120.0,
            stable_cos: 0.95,
            stable_sigma: 0.1,
            pass: PassRule {
                min_snr: 5.0,
                pair_r: 0.8,
            },
        }
    }
}

impl QcConfig {
    pub fn validate(&self) -> Result<(), TraceError> {
        let ok = self.fps.is_finite()
            && self.fps > 0.0
            && self.window_frames >= 32
            && self.refresh_frames >= 1
            && self.min_frames >= 16
            && self.min_frames <= self.window_frames
            && self.event_z.is_finite()
            && self.slow_window_s.is_finite()
            && self.slow_window_s >= 0.0
            && self.smooth_s.is_finite()
            && self.smooth_s >= 0.0
            && self.residual_every >= 1
            && self.residual_tau_frames.is_finite()
            && self.residual_tau_frames >= 1.0
            && self.block_px >= 1
            && self.min_overlap.is_finite()
            && self.stability_lag_s.is_finite()
            && self.stability_lag_s > 0.0
            && self.stable_min_age_s.is_finite()
            && self.stable_cos.is_finite()
            && self.stable_sigma.is_finite();
        if ok {
            Ok(())
        } else {
            Err(TraceError::InvalidConfig(format!("{self:?}")))
        }
    }
}

/// Metrics of one cell (NaN where not yet defined).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CellQc {
    pub id: u64,
    /// Frames since the cell entered the library.
    pub age_frames: u64,
    /// Frames of trace history the statistics use.
    pub frames: u32,
    /// Window statistics of the trace.
    pub trace: TraceStats,
    /// The model's trace noise σ (library), next to the measured σ.
    pub model_sigma: f32,
    /// Events per minute over the window.
    pub event_rate: f32,
    /// Second-moment radius of the unfiltered footprint, px.
    pub fp_radius_px: f32,
    /// √(λ_max / λ_min) of the footprint's second moments.
    pub fp_elongation: f32,
    /// Footprint mass in the outer quarter of the support radius.
    pub fp_edge_frac: f32,
    /// Correlation of the footprint with its previous version (1 until it
    /// changes).
    pub fp_last_r: f32,
    /// Number of footprint changes since the cell entered.
    pub fp_changes: u32,
    /// Cosine of the unfiltered footprint with the cell's footprint one to
    /// two `stability_lag_s` ago, and the relative change of its trace noise
    /// σ since then (NaN when the cell was not in the library then).
    pub fp_ref_cos: f32,
    pub sigma_ref_change: f32,
    pub n_neighbours: u32,
    /// Largest |normalised overlap| ã_iᵀã_j / (‖ã_i‖ ‖ã_j‖) with a neighbour.
    pub max_overlap: f32,
    /// Variance inflation of the cell's coefficient by its neighbours:
    /// (G⁻¹)_ii G_ii on the local Gram matrix (1 = no overlap).
    pub vif: f32,
    /// Largest trace correlation with an overlapping neighbour.
    pub max_neighbour_r: f32,
    /// Id of that neighbour (`u64::MAX` when none).
    pub max_neighbour_id: u64,
    /// Mean whitened residual energy per support pixel while silent / active.
    pub residual_rest: f32,
    pub residual_active: f32,
    /// Correlation of the trace with the cell's own footprint projection
    /// ã_iᵀ(y − b_i)/‖ã_i‖² (what the cell would read with no neighbours),
    /// over the residual frames: low when neighbours or the background model
    /// take the cell's light.
    pub proj_r: f32,
    /// Footprint mismatch: √(residual_active − residual_rest) / peak SNR,
    /// the residual a cell leaves when it fires relative to its signal.
    pub fp_error: f32,
    /// `FLAG_*` bits.
    pub flags: u32,
    /// Measured, SNR ≥ `min_snr`, and not the weaker member of a correlated
    /// pair ([`PassRule`]).
    pub pass: bool,
}

impl CellQc {
    fn new(id: u64) -> CellQc {
        CellQc {
            id,
            age_frames: 0,
            frames: 0,
            trace: TraceStats::NAN,
            model_sigma: f32::NAN,
            event_rate: f32::NAN,
            fp_radius_px: f32::NAN,
            fp_elongation: f32::NAN,
            fp_edge_frac: f32::NAN,
            fp_last_r: 1.0,
            fp_changes: 0,
            fp_ref_cos: f32::NAN,
            sigma_ref_change: f32::NAN,
            n_neighbours: 0,
            max_overlap: 0.0,
            vif: 1.0,
            max_neighbour_r: f32::NAN,
            max_neighbour_id: u64::MAX,
            fp_error: f32::NAN,
            flags: FLAG_UNMEASURED,
            residual_rest: f32::NAN,
            residual_active: f32::NAN,
            proj_r: f32::NAN,
            pass: false,
        }
    }

    /// Field names of [`CellQc::to_row`], in order.
    pub const FIELDS: [&'static str; 34] = [
        "id",
        "age_frames",
        "frames",
        "sigma",
        "baseline",
        "peak_snr",
        "events",
        "event_rate",
        "rise_frames",
        "decay_frames",
        "asymmetry",
        "width_frames",
        "diff_skew",
        "zero_frac",
        "slow_frac",
        "model_sigma",
        "fp_radius_px",
        "fp_elongation",
        "fp_edge_frac",
        "fp_last_r",
        "fp_changes",
        "fp_ref_cos",
        "sigma_ref_change",
        "n_neighbours",
        "max_overlap",
        "vif",
        "max_neighbour_r",
        "max_neighbour_id",
        "residual_rest",
        "residual_active",
        "proj_r",
        "fp_error",
        "flags",
        "pass",
    ];

    /// The metrics as numbers, in [`CellQc::FIELDS`] order (ids as f64 are
    /// exact below 2⁵³; no neighbour = -1).
    pub fn to_row(&self) -> [f64; 34] {
        let t = &self.trace;
        let f = |v: f32| f64::from(v);
        [
            self.id as f64,
            self.age_frames as f64,
            f64::from(self.frames),
            f(t.sigma),
            f(t.baseline),
            f(t.peak_snr),
            f64::from(t.events),
            f(self.event_rate),
            f(t.rise_frames),
            f(t.decay_frames),
            f(t.asymmetry),
            f(t.width_frames),
            f(t.diff_skew),
            f(t.zero_frac),
            f(t.slow_frac),
            f(self.model_sigma),
            f(self.fp_radius_px),
            f(self.fp_elongation),
            f(self.fp_edge_frac),
            f(self.fp_last_r),
            f64::from(self.fp_changes),
            f(self.fp_ref_cos),
            f(self.sigma_ref_change),
            f64::from(self.n_neighbours),
            f(self.max_overlap),
            f(self.vif),
            f(self.max_neighbour_r),
            if self.max_neighbour_id == u64::MAX {
                -1.0
            } else {
                self.max_neighbour_id as f64
            },
            f(self.residual_rest),
            f(self.residual_active),
            f(self.proj_r),
            f(self.fp_error),
            f64::from(self.flags),
            if self.pass { 1.0 } else { 0.0 },
        ]
    }
}

/// One overlapping neighbour of a cell.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PairQc {
    pub id: u64,
    /// Normalised overlap of the filtered footprints.
    pub overlap: f32,
    /// Trace correlation over the shared window (NaN before refresh).
    pub r: f32,
}

/// Run-level metrics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlobalQc {
    pub frames: u64,
    pub library_version: u64,
    pub cells: u32,
    /// Cells with enough history for trace statistics.
    pub cells_measured: u32,
    /// Fraction of the signal variance (above noise) the model explains,
    /// over the residual map's blocks.
    pub explained: f32,
    /// Mean over blocks of max(residual variance / noise − 1, 0).
    pub residual_excess: f32,
    /// Library edits per minute over the churn window.
    pub adds_per_min: f32,
    pub removes_per_min: f32,
    pub footprint_changes_per_min: f32,
    pub total_adds: u64,
    pub total_removes: u64,
    /// Over measured cells.
    pub snr_p10: f32,
    pub snr_median: f32,
    pub snr_p90: f32,
    pub pass_frac: f32,
    pub median_fp_last_r: f32,
    pub median_neighbour_r: f32,
    pub median_proj_r: f32,
    pub median_vif: f32,
    pub median_asymmetry: f32,
    /// Measured cells in a correlated pair.
    pub pair_frac: f32,
    /// Existing-cell stability against the cells' state one to two
    /// `stability_lag_s` ago: cells compared (present then and now), the
    /// median cosine of their unfiltered footprints, the median relative
    /// change of their trace noise σ, and the share that is stable
    /// (`stable_cos` and `stable_sigma`). NaN before the first comparison.
    pub stable_cells: u32,
    pub fp_stability: f32,
    pub trace_sigma_change: f32,
    pub stable_frac: f32,
}

impl GlobalQc {
    pub const FIELDS: [&'static str; 26] = [
        "frames",
        "library_version",
        "cells",
        "cells_measured",
        "explained",
        "residual_excess",
        "adds_per_min",
        "removes_per_min",
        "footprint_changes_per_min",
        "total_adds",
        "total_removes",
        "snr_p10",
        "snr_median",
        "snr_p90",
        "pass_frac",
        "median_fp_last_r",
        "median_neighbour_r",
        "median_proj_r",
        "median_vif",
        "median_asymmetry",
        "pair_frac",
        "stable_cells",
        "fp_stability",
        "trace_sigma_change",
        "stable_frac",
        "residual_blocks",
    ];
}

/// Per-cell state carried across library versions by id.
#[derive(Debug, Clone)]
struct CellState {
    born: u64,
    /// Ring of the last `window_frames` trace values (slot `t % W`).
    hist: Vec<f32>,
    /// Frames of valid history in `hist`.
    valid: usize,
    qc: CellQc,
    /// Unfiltered footprint at the last version, for stability.
    fp_pix: Vec<u32>,
    fp_val: Vec<f32>,
    /// Overlapping neighbours: (slot, overlap) in the current library.
    nb: Vec<(u32, f32)>,
    nb_r: Vec<f32>,
    res: [ResAvg; 2],
    /// Running means of (p, c, p², c², pc) for `proj_r`.
    pc: [ResAvg; 5],
}

/// A cell's state at a stability snapshot.
#[derive(Debug, Clone)]
struct Snap {
    pix: Vec<u32>,
    val: Vec<f32>,
    sigma: f32,
}

/// Existing-cell stability (recomputed on library changes and snapshots).
#[derive(Debug, Clone, Copy)]
struct Stability {
    cells: u32,
    cos: f32,
    sigma: f32,
    frac: f32,
}

/// Running average with a time constant (cumulative while young).
#[derive(Debug, Clone, Copy, Default)]
struct ResAvg {
    n: f32,
    v: f32,
}

impl ResAvg {
    fn push(&mut self, x: f32, tau: f32) {
        self.n += 1.0;
        let a = (1.0 / self.n).max(1.0 / tau);
        self.v += a * (x - self.v);
    }

    fn get(&self) -> f32 {
        if self.n > 0.0 {
            self.v
        } else {
            f32::NAN
        }
    }
}

/// The online QC state. See the module docs.
#[derive(Debug, Clone)]
pub struct QcMonitor {
    cfg: QcConfig,
    dims: Dims,
    fov: Vec<u8>,
    noise: Vec<f32>,
    frames: u64,
    version: Option<u64>,
    n_cells: usize,
    cells: Vec<CellState>,
    cursor: usize,
    // Residual scratch (full frame) and block map.
    model: Vec<f32>,
    bw: usize,
    bh: usize,
    block_n: Vec<u32>,
    block_noise: Vec<f32>,
    /// Block column of each pixel column.
    block_col: Vec<u32>,
    inv_noise: Vec<f32>,
    blk_r: Vec<f32>,
    blk_y: Vec<f32>,
    blk_mr: Vec<f32>,
    blk_vr: Vec<f32>,
    blk_my: Vec<f32>,
    blk_vy: Vec<f32>,
    res_updates: f32,
    // Churn.
    churn: VecDeque<(u64, u32, u32, u32)>,
    total_adds: u64,
    total_removes: u64,
    /// Stability snapshots: the reference (one to two lags old) and the
    /// next one, with the frames they were taken at.
    snap_ref: HashMap<u64, Snap>,
    snap_next: HashMap<u64, Snap>,
    snap_next_frame: u64,
    stability: Stability,
    scratch: Vec<f32>,
    scratch2: Vec<f32>,
    img: Vec<f32>,
}

impl QcMonitor {
    /// `noise` is the preprocessing's per-pixel noise σ map, `fov` the mask.
    pub fn new(
        dims: Dims,
        fov: Vec<u8>,
        noise: Vec<f32>,
        cfg: QcConfig,
    ) -> Result<QcMonitor, TraceError> {
        cfg.validate()?;
        let n_px = dims.pixels();
        check_len("fov mask", n_px, fov.len())?;
        let b = cfg.block_px;
        let bw = dims.width.div_ceil(b);
        let bh = dims.height.div_ceil(b);
        let mut m = QcMonitor {
            cfg,
            dims,
            fov,
            noise: Vec::new(),
            block_col: (0..dims.width).map(|x| (x / b) as u32).collect(),
            inv_noise: Vec::new(),
            frames: 0,
            version: None,
            n_cells: 0,
            cells: Vec::new(),
            cursor: 0,
            model: vec![0.0; n_px],
            bw,
            bh,
            block_n: vec![0; bw * bh],
            block_noise: vec![0.0; bw * bh],
            blk_r: vec![0.0; bw * bh],
            blk_y: vec![0.0; bw * bh],
            blk_mr: vec![0.0; bw * bh],
            blk_vr: vec![0.0; bw * bh],
            blk_my: vec![0.0; bw * bh],
            blk_vy: vec![0.0; bw * bh],
            res_updates: 0.0,
            churn: VecDeque::new(),
            total_adds: 0,
            total_removes: 0,
            snap_ref: HashMap::new(),
            snap_next: HashMap::new(),
            snap_next_frame: 0,
            stability: Stability {
                cells: 0,
                cos: f32::NAN,
                sigma: f32::NAN,
                frac: f32::NAN,
            },
            scratch: Vec::new(),
            scratch2: Vec::new(),
            img: vec![0.0; n_px],
        };
        m.set_noise(noise)?;
        Ok(m)
    }

    /// Replace the noise map (it is refined during the run).
    pub fn set_noise(&mut self, noise: Vec<f32>) -> Result<(), TraceError> {
        check_len("noise map", self.dims.pixels(), noise.len())?;
        if noise.iter().any(|v| !v.is_finite() || *v < 0.0) {
            return Err(TraceError::InvalidConfig(
                "noise map must be finite and >= 0".into(),
            ));
        }
        self.inv_noise = noise
            .iter()
            .map(|&v| if v > 0.0 { 1.0 / v } else { 0.0 })
            .collect();
        self.noise = noise;
        let (w, b) = (self.dims.width, self.cfg.block_px);
        self.block_n.iter_mut().for_each(|v| *v = 0);
        let mut var = vec![0.0f64; self.block_n.len()];
        for q in 0..self.dims.pixels() {
            if self.fov[q] == 0 {
                continue;
            }
            let bi = (q / w / b) * self.bw + (q % w) / b;
            self.block_n[bi] += 1;
            var[bi] += f64::from(self.noise[q]).powi(2);
        }
        for (bi, v) in var.iter().enumerate() {
            let n = f64::from(self.block_n[bi]);
            // Variance of the block mean of independent pixel noise.
            self.block_noise[bi] = if n > 0.0 { (v / (n * n)) as f32 } else { 0.0 };
        }
        Ok(())
    }

    pub fn config(&self) -> &QcConfig {
        &self.cfg
    }

    /// Frames observed.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Bytes of the bounded state (trace rings, maps, footprint copies).
    pub fn state_bytes(&self) -> usize {
        let cells: usize = self
            .cells
            .iter()
            .map(|c| {
                4 * (c.hist.len() + c.fp_pix.len() + c.fp_val.len())
                    + 8 * c.nb.len()
                    + 4 * c.nb_r.len()
                    + std::mem::size_of::<CellState>()
            })
            .sum();
        let snaps: usize = self
            .snap_ref
            .values()
            .chain(self.snap_next.values())
            .map(|s| 8 * s.pix.len() + std::mem::size_of::<Snap>() + 8)
            .sum();
        cells + snaps + self.model.len() * 12 + self.blk_r.len() * 36
    }

    /// Lag of the stability snapshots, frames.
    fn lag_frames(&self) -> u64 {
        (self.cfg.stability_lag_s * self.cfg.fps).round().max(1.0) as u64
    }

    /// Take a stability snapshot every lag; the previous one becomes the
    /// reference.
    fn snapshot(&mut self) {
        if self.frames < self.snap_next_frame + self.lag_frames() {
            return;
        }
        let next: HashMap<u64, Snap> = self
            .cells
            .iter()
            .map(|c| {
                (
                    c.qc.id,
                    Snap {
                        pix: c.fp_pix.clone(),
                        val: c.fp_val.clone(),
                        sigma: c.qc.model_sigma,
                    },
                )
            })
            .collect();
        self.snap_ref = std::mem::replace(&mut self.snap_next, next);
        self.snap_next_frame = self.frames;
        self.update_stability();
    }

    /// Compare every cell with its reference snapshot.
    fn update_stability(&mut self) {
        let (mut cos, mut sig) = (Vec::new(), Vec::new());
        let (mut n, mut stable) = (0u32, 0u32);
        let min_age = (self.cfg.stable_min_age_s * self.cfg.fps).round() as u64;
        let ln_sigma = self.cfg.stable_sigma.ln_1p();
        for c in &mut self.cells {
            c.qc.fp_ref_cos = f32::NAN;
            c.qc.sigma_ref_change = f32::NAN;
            let Some(r) = self.snap_ref.get(&c.qc.id) else {
                continue;
            };
            let k = if r.pix == c.fp_pix && r.val == c.fp_val {
                1.0
            } else {
                sparse_cos(&r.pix, &r.val, &c.fp_pix, &c.fp_val, &mut self.img)
            };
            let d = if r.sigma > 0.0 && c.qc.model_sigma > 0.0 {
                (c.qc.model_sigma / r.sigma).ln().abs()
            } else {
                f32::NAN
            };
            c.qc.fp_ref_cos = k;
            c.qc.sigma_ref_change = d.exp_m1();
            if self.frames.saturating_sub(c.born) < min_age {
                continue;
            }
            n += 1;
            if k >= self.cfg.stable_cos && d < ln_sigma {
                stable += 1;
            }
            if k.is_finite() {
                cos.push(k);
            }
            if d.is_finite() {
                sig.push(d.exp_m1());
            }
        }
        self.stability = Stability {
            cells: n,
            cos: median_or_nan(&mut cos),
            sigma: median_or_nan(&mut sig),
            frac: if n > 0 {
                stable as f32 / n as f32
            } else {
                f32::NAN
            },
        };
    }

    /// One frame: `y` is the preprocessed frame the fast loop solved, `lib`
    /// the library it used, `tr` its output.
    pub fn observe(
        &mut self,
        y: &[f32],
        lib: &Library,
        tr: &FrameTraces,
    ) -> Result<(), TraceError> {
        check_len("frame", self.dims.pixels(), y.len())?;
        if lib.dims() != self.dims {
            return Err(TraceError::Incompatible(format!(
                "library is {:?}, QC {:?}",
                lib.dims(),
                self.dims
            )));
        }
        check_len("traces", lib.len(), tr.traces.len())?;
        if self.version != Some(lib.version()) {
            self.on_library(lib);
        }
        let w = self.cfg.window_frames;
        let pos = (self.frames % w as u64) as usize;
        for (c, &v) in self.cells.iter_mut().zip(&tr.traces) {
            c.hist[pos] = v;
            c.valid = (c.valid + 1).min(w);
        }
        self.frames += 1;
        self.snapshot();
        if self
            .frames
            .is_multiple_of(u64::from(self.cfg.residual_every))
        {
            self.residual(y, lib, tr)?;
        }
        let n = self.n_cells;
        if n > 0 {
            let per = n.div_ceil(self.cfg.refresh_frames);
            for _ in 0..per {
                if self.cursor >= n {
                    self.cursor = 0;
                }
                self.refresh(self.cursor, lib);
                self.cursor += 1;
            }
        }
        Ok(())
    }

    /// A new library version: carry cells over by id, count churn, update
    /// footprint and overlap metrics.
    fn on_library(&mut self, lib: &Library) {
        let mut old: HashMap<u64, CellState> = self.cells.drain(..).map(|c| (c.qc.id, c)).collect();
        let w = self.cfg.window_frames;
        let n = lib.len();
        let (mut adds, mut changes) = (0u32, 0u32);
        let mut cells = Vec::with_capacity(n);
        for s in 0..n {
            let id = lib.ids()[s];
            let mut c = old.remove(&id).unwrap_or_else(|| {
                adds += 1;
                CellState {
                    born: self.frames,
                    hist: vec![0.0; w],
                    valid: 0,
                    qc: CellQc::new(id),
                    fp_pix: Vec::new(),
                    fp_val: Vec::new(),
                    nb: Vec::new(),
                    nb_r: Vec::new(),
                    res: [ResAvg::default(); 2],
                    pc: [ResAvg::default(); 5],
                }
            });
            let (pix, val) = lib.unfiltered(s);
            if !c.fp_pix.is_empty() && (c.fp_pix != pix || c.fp_val != val) {
                c.qc.fp_last_r = sparse_corr(&c.fp_pix, &c.fp_val, pix, val, &mut self.img);
                c.qc.fp_changes += 1;
                changes += 1;
                // The residual averages describe the old footprint.
                c.res = [ResAvg::default(); 2];
                c.pc = [ResAvg::default(); 5];
            }
            if c.fp_pix != pix || c.fp_val != val {
                c.fp_pix.clear();
                c.fp_pix.extend_from_slice(pix);
                c.fp_val.clear();
                c.fp_val.extend_from_slice(val);
                let ((cy, cx), radius) = lib.support(s);
                let (r, e, edge) = shape(pix, val, self.dims.width, (cy, cx), radius);
                c.qc.fp_radius_px = r;
                c.qc.fp_elongation = e;
                c.qc.fp_edge_frac = edge;
            }
            c.qc.model_sigma = lib.trace_noise()[s];
            cells.push(c);
        }
        let removes = old.len() as u32;
        if self.version.is_some() || n > 0 {
            self.total_adds += u64::from(adds);
            self.total_removes += u64::from(removes);
            self.churn.push_back((self.frames, adds, removes, changes));
        }
        self.cells = cells;
        self.n_cells = n;
        self.version = Some(lib.version());
        self.neighbours(lib);
        self.update_stability();
    }

    /// Overlapping neighbours, local variance inflation and control cells.
    ///
    /// Neighbours are cells whose support disks overlap (or whose filtered
    /// footprints have a Gram entry of at least `min_overlap`), nearest
    /// first: two halves of one split cell have disjoint footprints, zero
    /// overlap, and must still be compared. Controls are the 4 nearest cells
    /// within 3 support radii that are not neighbours.
    fn neighbours(&mut self, lib: &Library) {
        let n = self.n_cells;
        let gd = &lib.gram_diag;
        let centers: Vec<((f32, f32), f32)> = (0..n).map(|s| lib.support(s)).collect();
        let rho = |i: usize, j: usize| -> f32 {
            let (cols, vals) = lib.gram.row(i);
            cols.binary_search(&(j as u32))
                .map_or(0.0, |p| vals[p] / (gd[i] * gd[j]).sqrt())
        };
        for i in 0..n {
            let ((yi, xi), ri) = centers[i];
            let mut nb: Vec<(f32, u32, f32)> = Vec::new();
            for (j, &((yj, xj), rj)) in centers.iter().enumerate() {
                if j == i {
                    continue;
                }
                let d2 = (yi - yj).powi(2) + (xi - xj).powi(2);
                if d2 > (ri + rj + 2.0).powi(2)
                    && lib.gram.row(i).0.binary_search(&(j as u32)).is_err()
                {
                    continue;
                }
                let r = rho(i, j);
                if d2 < (ri + rj).powi(2) || r.abs() >= self.cfg.min_overlap {
                    nb.push((d2, j as u32, r));
                }
            }
            nb.sort_by(|a, b| a.0.total_cmp(&b.0));
            nb.truncate(self.cfg.max_neighbours);
            // Local Gram over {i} ∪ neighbours (normalised).
            let k = nb.len() + 1;
            let mut members = Vec::with_capacity(k);
            members.push(i);
            members.extend(nb.iter().map(|e| e.1 as usize));
            let mut g = vec![0.0f64; k * k];
            for a in 0..k {
                g[a * k + a] = 1.0;
                for b in (a + 1)..k {
                    let v = f64::from(rho(members[a], members[b]));
                    g[a * k + b] = v;
                    g[b * k + a] = v;
                }
            }
            let vif = inv00(&g, k).unwrap_or(f64::INFINITY);
            let c = &mut self.cells[i];
            c.qc.n_neighbours = nb.len() as u32;
            c.qc.max_overlap = nb.iter().map(|e| e.2.abs()).fold(0.0, f32::max);
            c.qc.vif = vif as f32;
            c.nb_r = vec![f32::NAN; nb.len()];
            c.nb = nb.iter().map(|e| (e.1, e.2)).collect();
        }
    }

    /// Chronological window of slot `s` (last `len` frames) into `out`.
    fn window(&self, s: usize, len: usize, out: &mut Vec<f32>) {
        let w = self.cfg.window_frames;
        let h = &self.cells[s].hist;
        out.clear();
        // The ring's newest sample is at (frames - 1) % w.
        let end = (self.frames % w as u64) as usize;
        if len <= end {
            out.extend_from_slice(&h[end - len..end]);
        } else {
            out.extend_from_slice(&h[w - (len - end)..]);
            out.extend_from_slice(&h[..end]);
        }
    }

    /// Pearson correlation of slots `a` and `b` over the last `len` frames.
    fn ring_pearson(&self, a: usize, b: usize, len: usize) -> f32 {
        if len < 3 {
            return f32::NAN;
        }
        let w = self.cfg.window_frames;
        let (ha, hb) = (&self.cells[a].hist, &self.cells[b].hist);
        let end = (self.frames % w as u64) as usize;
        let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut acc = |r: std::ops::Range<usize>| {
            for (&x, &y) in ha[r.clone()].iter().zip(&hb[r]) {
                let (x, y) = (f64::from(x), f64::from(y));
                sa += x;
                sb += y;
                saa += x * x;
                sbb += y * y;
                sab += x * y;
            }
        };
        if len <= end {
            acc(end - len..end);
        } else {
            acc(w - (len - end)..w);
            acc(0..end);
        }
        let n = len as f64;
        let cov = sab / n - sa / n * (sb / n);
        let va = saa / n - (sa / n).powi(2);
        let vb = sbb / n - (sb / n).powi(2);
        if va <= 0.0 || vb <= 0.0 {
            f32::NAN
        } else {
            (cov / (va * vb).sqrt()) as f32
        }
    }

    /// Recompute the window statistics and correlations of slot `s`.
    fn refresh(&mut self, s: usize, lib: &Library) {
        let len = self.cells[s].valid;
        let age = self.frames - self.cells[s].born;
        self.cells[s].qc.age_frames = age;
        self.cells[s].qc.frames = len as u32;
        if len < self.cfg.min_frames {
            return;
        }
        let mut x = std::mem::take(&mut self.scratch2);
        self.window(s, len, &mut x);
        let ms = lib.trace_noise()[s];
        let slow = (self.cfg.slow_window_s * self.cfg.fps).round() as usize;
        let smooth = (self.cfg.smooth_s * self.cfg.fps).round() as usize;
        let st = trace_stats(
            &x,
            self.cfg.event_z,
            slow,
            smooth,
            0.01 * ms,
            ms,
            &mut self.scratch,
        );
        // Neighbour and control correlations over the shared window, on the
        // rings directly (both cells' samples of a frame share a ring slot).
        let nb: Vec<u32> = self.cells[s].nb.iter().map(|e| e.0).collect();
        let mut best = (f32::NAN, u64::MAX);
        let mut best_slot = None;
        let mut rs = Vec::with_capacity(nb.len());
        for &j in &nb {
            let l = len.min(self.cells[j as usize].valid);
            let r = self.ring_pearson(s, j as usize, l);
            rs.push(r);
            if r > best.0 || (best.0.is_nan() && !r.is_nan()) {
                best = (r, self.cells[j as usize].qc.id);
                best_slot = Some(j as usize);
            }
        }
        self.scratch2 = x;
        let fps = self.cfg.fps;
        let pass = self.cfg.pass;
        // SNR of the most correlated neighbour (as of its last refresh).
        let nb_snr = best_slot.map_or(f32::NAN, |j| self.cells[j].qc.trace.peak_snr);
        let c = &mut self.cells[s];
        c.nb_r = rs;
        c.qc.trace = st;
        c.qc.event_rate = st.events as f32 / (len as f32 / fps / 60.0);
        c.qc.max_neighbour_r = best.0;
        c.qc.max_neighbour_id = best.1;
        c.qc.residual_rest = c.res[0].get();
        c.qc.residual_active = c.res[1].get();
        c.qc.proj_r = {
            let m = |i: usize| f64::from(c.pc[i].get());
            let vp = m(2) - m(0) * m(0);
            let vc = m(3) - m(1) * m(1);
            if c.pc[0].n >= 8.0 && vp > 0.0 && vc > 0.0 {
                ((m(4) - m(0) * m(1)) / (vp * vc).sqrt()) as f32
            } else {
                f32::NAN
            }
        };
        c.qc.fp_error = if c.qc.trace.peak_snr > 0.0 {
            (c.qc.residual_active - c.qc.residual_rest).max(0.0).sqrt() / c.qc.trace.peak_snr
        } else {
            f32::NAN
        };
        let q = &c.qc;
        let mut flags = 0u32;
        if !(q.trace.peak_snr >= pass.min_snr) {
            flags |= FLAG_LOW_SNR;
        }
        if q.max_neighbour_r > pass.pair_r {
            flags |= FLAG_CORRELATED_PAIR;
            // The weaker member of the pair is the likely extra cell.
            let id = q.id;
            if q.trace.peak_snr < nb_snr || (q.trace.peak_snr == nb_snr && id > q.max_neighbour_id)
            {
                flags |= FLAG_LIKELY_DUPLICATE;
            }
        }
        c.qc.flags = flags;
        c.qc.pass = flags & (FLAG_LOW_SNR | FLAG_LIKELY_DUPLICATE) == 0;
    }

    /// Residual of the model on this frame: per-cell support energy and the
    /// block map.
    fn residual(&mut self, y: &[f32], lib: &Library, tr: &FrameTraces) -> Result<(), TraceError> {
        let n = self.n_cells;
        let ring = matches!(lib.bg, BgTerms::Ring { .. });
        // Model image Σ ã_j c_j (+ basis background).
        match &lib.bg {
            BgTerms::Basis { .. } => {
                lib.render(&tr.traces, Some(&tr.background), &mut self.model)?;
            }
            _ => {
                for s in 0..n {
                    let c = tr.traces[s];
                    if c != 0.0 {
                        let (p, v) = lib.filtered(s);
                        for (&q, &a) in p.iter().zip(v) {
                            self.model[q as usize] += a * c;
                        }
                    }
                }
            }
        }
        if ring {
            check_len("ring background", n, tr.background.len())?;
        }
        // Per-cell residual energy on its own support, with its own ring.
        let tau = self.cfg.residual_tau_frames / self.cfg.residual_every as f32;
        for s in 0..n {
            let b = if ring { tr.background[s] } else { 0.0 };
            let (p, v) = lib.filtered(s);
            let mut e = 0.0f32;
            let mut k = 0u32;
            let mut proj = 0.0f32;
            for (&q, &a) in p.iter().zip(v) {
                let q = q as usize;
                let yb = y[q] - b;
                proj += a * yb;
                let iv = self.inv_noise[q];
                if iv > 0.0 {
                    let r = (yb - self.model[q]) * iv;
                    e += r * r;
                    k += 1;
                }
            }
            let proj = proj / lib.gram_diag[s];
            let ct = tr.traces[s];
            let c = &mut self.cells[s];
            for (acc, x) in
                c.pc.iter_mut()
                    .zip([proj, ct, proj * proj, ct * ct, proj * ct])
            {
                acc.push(x, tau);
            }
            if k == 0 {
                continue;
            }
            let base = if c.qc.trace.baseline.is_finite() {
                c.qc.trace.baseline
            } else {
                0.0
            };
            let thr = base + self.cfg.event_z * lib.trace_noise()[s];
            let active = usize::from(tr.traces[s] > thr);
            c.res[active].push(e / k as f32, tau);
        }
        // Block map of the residual of the cells alone (y − Σ ã_j c_j): a
        // local ring background is a nuisance term, and its light (neuropil)
        // counts as unexplained here, like a missing cell's.
        let (w, bs) = (self.dims.width, self.cfg.block_px);
        self.blk_r.iter_mut().for_each(|v| *v = 0.0);
        self.blk_y.iter_mut().for_each(|v| *v = 0.0);
        for (row, yr) in y.chunks_exact(w).enumerate() {
            let b0 = (row / bs) * self.bw;
            let q0 = row * w;
            for (x, &yv) in yr.iter().enumerate() {
                let q = q0 + x;
                if self.fov[q] == 0 {
                    continue;
                }
                let bi = b0 + self.block_col[x] as usize;
                self.blk_r[bi] += yv - self.model[q];
                self.blk_y[bi] += yv;
            }
        }
        self.res_updates += 1.0;
        let a = (1.0 / self.res_updates).max(1.0 / tau);
        for bi in 0..self.blk_r.len() {
            let nb = self.block_n[bi];
            if nb == 0 {
                continue;
            }
            let r = self.blk_r[bi] / nb as f32;
            let yy = self.blk_y[bi] / nb as f32;
            ema_var(&mut self.blk_mr[bi], &mut self.blk_vr[bi], r, a);
            ema_var(&mut self.blk_my[bi], &mut self.blk_vy[bi], yy, a);
        }
        // Clear the scratch on the supports.
        for s in 0..n {
            if tr.traces[s] == 0.0 {
                continue;
            }
            for &q in lib.filtered(s).0 {
                self.model[q as usize] = 0.0;
            }
        }
        if matches!(lib.bg, BgTerms::Basis { .. }) {
            self.model.iter_mut().for_each(|v| *v = 0.0);
        }
        Ok(())
    }

    /// Per-cell metrics in the current library's slot order.
    pub fn cells(&self) -> impl ExactSizeIterator<Item = &CellQc> {
        self.cells.iter().map(|c| &c.qc)
    }

    /// Overlapping neighbours of the cell in `slot` with their overlap and
    /// trace correlation.
    pub fn neighbours_of(&self, slot: usize) -> Vec<PairQc> {
        let Some(c) = self.cells.get(slot) else {
            return Vec::new();
        };
        c.nb.iter()
            .zip(&c.nb_r)
            .map(|(&(j, o), &r)| PairQc {
                id: self.cells[j as usize].qc.id,
                overlap: o,
                r,
            })
            .collect()
    }

    /// Residual map: per block, residual variance over time in units of the
    /// block's noise variance, minus 1 (0 = only noise left; NaN outside the
    /// field of view). Returns (blocks wide, blocks high, values).
    pub fn residual_map(&self) -> (usize, usize, Vec<f32>) {
        let v = (0..self.blk_vr.len())
            .map(|bi| {
                let nz = self.block_noise[bi];
                if self.block_n[bi] == 0 || !(nz > 0.0) || self.res_updates < 2.0 {
                    f32::NAN
                } else {
                    self.blk_vr[bi] / nz - 1.0
                }
            })
            .collect();
        (self.bw, self.bh, v)
    }

    /// Run-level metrics now.
    pub fn global(&self) -> GlobalQc {
        let mut g = GlobalQc {
            frames: self.frames,
            library_version: self.version.unwrap_or(0),
            cells: self.n_cells as u32,
            cells_measured: 0,
            explained: f32::NAN,
            residual_excess: f32::NAN,
            adds_per_min: 0.0,
            removes_per_min: 0.0,
            footprint_changes_per_min: 0.0,
            total_adds: self.total_adds,
            total_removes: self.total_removes,
            snr_p10: f32::NAN,
            snr_median: f32::NAN,
            snr_p90: f32::NAN,
            pass_frac: f32::NAN,
            median_fp_last_r: f32::NAN,
            median_neighbour_r: f32::NAN,
            median_proj_r: f32::NAN,
            median_vif: f32::NAN,
            median_asymmetry: f32::NAN,
            pair_frac: f32::NAN,
            stable_cells: self.stability.cells,
            fp_stability: self.stability.cos,
            trace_sigma_change: self.stability.sigma,
            stable_frac: self.stability.frac,
        };
        if self.res_updates >= 2.0 {
            let (mut num, mut den, mut ex, mut nb) = (0.0f64, 0.0f64, 0.0f64, 0u32);
            for bi in 0..self.blk_vr.len() {
                let nz = f64::from(self.block_noise[bi]);
                if self.block_n[bi] == 0 || nz <= 0.0 {
                    continue;
                }
                num += f64::from(self.blk_vr[bi]) - nz;
                den += f64::from(self.blk_vy[bi]) - nz;
                ex += (f64::from(self.blk_vr[bi]) / nz - 1.0).max(0.0);
                nb += 1;
            }
            if den > 0.0 {
                g.explained = (1.0 - num / den) as f32;
            }
            if nb > 0 {
                g.residual_excess = (ex / f64::from(nb)) as f32;
            }
        }
        let win = self.cfg.churn_window_frames;
        let since = self.frames.saturating_sub(win);
        let span_min = (self.frames.min(win).max(1)) as f32 / self.cfg.fps / 60.0;
        let (mut a, mut r, mut c) = (0u32, 0u32, 0u32);
        for &(t, ad, rm, ch) in &self.churn {
            if t >= since {
                a += ad;
                r += rm;
                c += ch;
            }
        }
        g.adds_per_min = a as f32 / span_min;
        g.removes_per_min = r as f32 / span_min;
        g.footprint_changes_per_min = c as f32 / span_min;

        let measured: Vec<&CellQc> = self
            .cells
            .iter()
            .map(|c| &c.qc)
            .filter(|q| q.trace.peak_snr.is_finite())
            .collect();
        g.cells_measured = measured.len() as u32;
        if !measured.is_empty() {
            let mut v: Vec<f32> = measured.iter().map(|q| q.trace.peak_snr).collect();
            v.sort_by(f32::total_cmp);
            let qn = |q: f32| v[((v.len() - 1) as f32 * q).round() as usize];
            g.snr_p10 = qn(0.1);
            g.snr_median = qn(0.5);
            g.snr_p90 = qn(0.9);
            g.pass_frac = measured.iter().filter(|q| q.pass).count() as f32 / measured.len() as f32;
            let med = |f: &dyn Fn(&CellQc) -> f32| {
                let mut v: Vec<f32> = measured
                    .iter()
                    .map(|q| f(q))
                    .filter(|x| x.is_finite())
                    .collect();
                median_or_nan(&mut v)
            };
            g.median_fp_last_r = med(&|q| q.fp_last_r);
            g.median_neighbour_r = med(&|q| q.max_neighbour_r);
            g.median_proj_r = med(&|q| q.proj_r);
            g.median_vif = med(&|q| q.vif);
            g.median_asymmetry = med(&|q| q.trace.asymmetry);
            g.pair_frac = measured
                .iter()
                .filter(|q| q.flags & FLAG_CORRELATED_PAIR != 0)
                .count() as f32
                / measured.len() as f32;
        }
        g
    }
}

impl GlobalQc {
    /// The metrics as numbers in [`GlobalQc::FIELDS`] order; the last entry
    /// is the number of residual blocks (map size), for the bindings.
    pub fn to_row(&self, blocks: usize) -> [f64; 26] {
        let f = |v: f32| f64::from(v);
        [
            self.frames as f64,
            self.library_version as f64,
            f64::from(self.cells),
            f64::from(self.cells_measured),
            f(self.explained),
            f(self.residual_excess),
            f(self.adds_per_min),
            f(self.removes_per_min),
            f(self.footprint_changes_per_min),
            self.total_adds as f64,
            self.total_removes as f64,
            f(self.snr_p10),
            f(self.snr_median),
            f(self.snr_p90),
            f(self.pass_frac),
            f(self.median_fp_last_r),
            f(self.median_neighbour_r),
            f(self.median_proj_r),
            f(self.median_vif),
            f(self.median_asymmetry),
            f(self.pair_frac),
            f64::from(self.stable_cells),
            f(self.fp_stability),
            f(self.trace_sigma_change),
            f(self.stable_frac),
            blocks as f64,
        ]
    }
}

fn median_or_nan(v: &mut [f32]) -> f32 {
    stats::median_inplace(v)
}

/// Exponential running mean and variance.
fn ema_var(m: &mut f32, v: &mut f32, x: f32, a: f32) {
    let d = x - *m;
    *m += a * d;
    *v = (1.0 - a) * (*v + a * d * d);
}

/// Shape of an unfiltered footprint: second-moment radius, elongation and
/// mass share in the outer quarter of the support radius.
fn shape(pix: &[u32], val: &[f32], width: usize, c: (f32, f32), radius: f32) -> (f32, f32, f32) {
    let (mut sw, mut sy, mut sx) = (0.0f64, 0.0f64, 0.0f64);
    for (&q, &a) in pix.iter().zip(val) {
        let a = f64::from(a);
        sw += a;
        sy += a * (q as usize / width) as f64;
        sx += a * (q as usize % width) as f64;
    }
    if sw <= 0.0 {
        return (f32::NAN, f32::NAN, f32::NAN);
    }
    let (my, mx) = (sy / sw, sx / sw);
    let (mut cyy, mut cxx, mut cxy, mut edge) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let r_edge = 0.75 * f64::from(radius);
    for (&q, &a) in pix.iter().zip(val) {
        let a = f64::from(a);
        let (y, x) = ((q as usize / width) as f64, (q as usize % width) as f64);
        let (dy, dx) = (y - my, x - mx);
        cyy += a * dy * dy;
        cxx += a * dx * dx;
        cxy += a * dy * dx;
        let (ey, ex) = (y - f64::from(c.0), x - f64::from(c.1));
        if (ey * ey + ex * ex).sqrt() > r_edge {
            edge += a;
        }
    }
    let (cyy, cxx, cxy) = (cyy / sw, cxx / sw, cxy / sw);
    let tr = cyy + cxx;
    let det = cyy * cxx - cxy * cxy;
    let disc = (tr * tr / 4.0 - det).max(0.0).sqrt();
    let (l1, l2) = (tr / 2.0 + disc, (tr / 2.0 - disc).max(1e-9));
    (
        tr.sqrt() as f32,
        (l1 / l2).sqrt() as f32,
        (edge / sw) as f32,
    )
}

/// Cosine of two sparse images (`img` is a zeroed full-frame scratch, left
/// zeroed).
fn sparse_cos(pa: &[u32], va: &[f32], pb: &[u32], vb: &[f32], img: &mut [f32]) -> f32 {
    for (&q, &a) in pa.iter().zip(va) {
        img[q as usize] = a;
    }
    let ab: f64 = pb
        .iter()
        .zip(vb)
        .map(|(&q, &b)| f64::from(img[q as usize]) * f64::from(b))
        .sum();
    for &q in pa {
        img[q as usize] = 0.0;
    }
    let aa: f64 = va.iter().map(|&v| f64::from(v).powi(2)).sum();
    let bb: f64 = vb.iter().map(|&v| f64::from(v).powi(2)).sum();
    if aa > 0.0 && bb > 0.0 {
        (ab / (aa * bb).sqrt()) as f32
    } else {
        f32::NAN
    }
}

/// Pearson correlation of two sparse images over the union of their pixels
/// (`img` is a zeroed full-frame scratch, left zeroed).
fn sparse_corr(pa: &[u32], va: &[f32], pb: &[u32], vb: &[f32], img: &mut [f32]) -> f32 {
    for (&q, &a) in pa.iter().zip(va) {
        img[q as usize] = a;
    }
    let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut n = 0usize;
    for (&q, &b) in pb.iter().zip(vb) {
        let a = f64::from(img[q as usize]);
        let b = f64::from(b);
        sa += a;
        sb += b;
        saa += a * a;
        sbb += b * b;
        sab += a * b;
        n += 1;
        img[q as usize] = f32::NAN;
    }
    // Pixels only in A.
    for (&q, &a) in pa.iter().zip(va) {
        let v = img[q as usize];
        if !v.is_nan() {
            let a = f64::from(a);
            sa += a;
            saa += a * a;
            n += 1;
        }
        img[q as usize] = 0.0;
    }
    for &q in pb {
        img[q as usize] = 0.0;
    }
    if n < 2 {
        return f32::NAN;
    }
    let nf = n as f64;
    let cov = sab / nf - sa / nf * sb / nf;
    let va_ = saa / nf - (sa / nf).powi(2);
    let vb_ = sbb / nf - (sb / nf).powi(2);
    if va_ <= 0.0 || vb_ <= 0.0 {
        f32::NAN
    } else {
        (cov / (va_ * vb_).sqrt()) as f32
    }
}

/// `(A⁻¹)₀₀` of a small symmetric positive-definite matrix (Cholesky);
/// `None` when it is not positive definite.
fn inv00(a: &[f64], k: usize) -> Option<f64> {
    // A⁻¹₀₀ = 1 / (Schur complement of the trailing block) — solve A x = e0.
    let mut l = vec![0.0f64; k * k];
    for i in 0..k {
        for j in 0..=i {
            let mut s = a[i * k + j];
            for p in 0..j {
                s -= l[i * k + p] * l[j * k + p];
            }
            if i == j {
                if !(s > 1e-12) {
                    return None;
                }
                l[i * k + i] = s.sqrt();
            } else {
                l[i * k + j] = s / l[j * k + j];
            }
        }
    }
    // Forward: L z = e0; backward: Lᵀ x = z; return x0.
    let mut z = vec![0.0f64; k];
    for i in 0..k {
        let mut s = if i == 0 { 1.0 } else { 0.0 };
        for p in 0..i {
            s -= l[i * k + p] * z[p];
        }
        z[i] = s / l[i * k + i];
    }
    let mut x = vec![0.0f64; k];
    for i in (0..k).rev() {
        let mut s = z[i];
        for p in (i + 1)..k {
            s -= l[p * k + i] * x[p];
        }
        x[i] = s / l[i * k + i];
    }
    Some(x[0])
}

#[cfg(test)]
mod tests;
