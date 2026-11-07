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
//! # What each metric is for
//!
//! Every metric below was checked against ground truth on calibrated minisim
//! recordings (`examples/qc_eval.rs`); see that file's header for the
//! numbers. In short:
//!
//! * **Trace quality** ([`CellQc::peak_snr`], `events`, `event_rate`): the
//!   CaLab robust peak SNR of the cell's trace over the window, in noise
//!   units. It predicts whether a detected cell is real and how well its
//!   trace matches the truth.
//! * **Calcium-likeness** (`asymmetry`, `diff_skew`, `width_frames`,
//!   `slow_frac`, `zero_frac`): transients rise fast and decay slowly; a
//!   slow symmetric hump (neuropil or background absorbed into a trace) does
//!   not.
//! * **Footprint** (`fp_radius_px`, `fp_elongation`, `fp_edge_frac`,
//!   `fp_last_r`, `fp_changes`): shape of the unfiltered footprint and its
//!   correlation with the cell's previous version (stability).
//! * **Demixing** (`max_overlap`, `vif`, `max_neighbour_r`, `ctrl_r`): how
//!   much the cell's filtered footprint overlaps its neighbours', the noise
//!   inflation of its coefficient that the overlap causes (variance inflation
//!   factor from the local Gram matrix), and the correlation of its trace
//!   with overlapping neighbours' traces, next to nearby non-overlapping
//!   cells' (`ctrl_r`, the correlation independent cells show here).
//! * **Residual** (`residual_rest`, `residual_active`): mean whitened
//!   residual energy on the cell's support while it is silent and while it
//!   is active (a wrong footprint leaves residual when the cell fires).
//! * **Global** ([`GlobalQc`]): fraction of signal variance explained,
//!   residual excess (where signal is left unexplained: missing cells),
//!   library churn, and summaries of the per-cell metrics. These converge to
//!   an asymptote as the run settles.

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
    /// Thresholds of [`CellQc::pass`].
    pub pass: PassRule,
}

/// Thresholds of the per-cell pass/fail call.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PassRule {
    pub min_snr: f32,
    pub min_events: u32,
    pub max_neighbour_r: f32,
    pub max_slow_frac: f32,
}

impl Default for QcConfig {
    fn default() -> QcConfig {
        QcConfig {
            fps: 20.0,
            window_frames: 1200,
            refresh_frames: 100,
            min_frames: 100,
            event_z: 4.0,
            slow_window_s: 5.0,
            residual_every: 8,
            residual_tau_frames: 600.0,
            block_px: 8,
            max_neighbours: 8,
            min_overlap: 0.02,
            churn_window_frames: 1200,
            pass: PassRule {
                min_snr: 6.0,
                min_events: 1,
                max_neighbour_r: 0.6,
                max_slow_frac: 0.6,
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
            && self.residual_every >= 1
            && self.residual_tau_frames.is_finite()
            && self.residual_tau_frames >= 1.0
            && self.block_px >= 1
            && self.min_overlap.is_finite();
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
    /// Mean trace correlation with nearby non-overlapping cells.
    pub ctrl_r: f32,
    /// Mean whitened residual energy per support pixel while silent / active.
    pub residual_rest: f32,
    pub residual_active: f32,
    /// Passes [`PassRule`].
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
            n_neighbours: 0,
            max_overlap: 0.0,
            vif: 1.0,
            max_neighbour_r: f32::NAN,
            max_neighbour_id: u64::MAX,
            ctrl_r: f32::NAN,
            residual_rest: f32::NAN,
            residual_active: f32::NAN,
            pass: false,
        }
    }

    /// Field names of [`CellQc::to_row`], in order.
    pub const FIELDS: [&'static str; 30] = [
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
        "n_neighbours",
        "max_overlap",
        "vif",
        "max_neighbour_r",
        "max_neighbour_id",
        "ctrl_r",
        "residual_rest",
        "residual_active",
        "pass",
    ];

    /// The metrics as numbers, in [`CellQc::FIELDS`] order (ids as f64 are
    /// exact below 2⁵³; no neighbour = -1).
    pub fn to_row(&self) -> [f64; 30] {
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
            f64::from(self.n_neighbours),
            f(self.max_overlap),
            f(self.vif),
            f(self.max_neighbour_r),
            if self.max_neighbour_id == u64::MAX {
                -1.0
            } else {
                self.max_neighbour_id as f64
            },
            f(self.ctrl_r),
            f(self.residual_rest),
            f(self.residual_active),
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
    pub median_ctrl_r: f32,
    pub median_vif: f32,
    pub median_asymmetry: f32,
    pub slow_frac_high: f32,
}

impl GlobalQc {
    pub const FIELDS: [&'static str; 22] = [
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
        "median_ctrl_r",
        "median_vif",
        "median_asymmetry",
        "slow_frac_high",
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
    /// Nearby non-overlapping cells (slots) as correlation controls.
    ctrl: Vec<u32>,
    res: [ResAvg; 2],
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
                4 * (c.hist.len() + c.fp_pix.len() + c.fp_val.len() + c.ctrl.len())
                    + 8 * c.nb.len()
                    + 4 * c.nb_r.len()
                    + std::mem::size_of::<CellState>()
            })
            .sum();
        cells + self.model.len() * 12 + self.blk_r.len() * 36
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
                    ctrl: Vec::new(),
                    res: [ResAvg::default(); 2],
                }
            });
            let (pix, val) = lib.unfiltered(s);
            if !c.fp_pix.is_empty() && (c.fp_pix != pix || c.fp_val != val) {
                c.qc.fp_last_r = sparse_corr(&c.fp_pix, &c.fp_val, pix, val, &mut self.img);
                c.qc.fp_changes += 1;
                changes += 1;
                // The residual averages describe the old footprint.
                c.res = [ResAvg::default(); 2];
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
            let mut ctrl: Vec<(f32, u32)> = Vec::new();
            for (j, &((yj, xj), rj)) in centers.iter().enumerate() {
                if j == i {
                    continue;
                }
                let d2 = (yi - yj).powi(2) + (xi - xj).powi(2);
                let reach = 3.0 * (ri + rj);
                if d2 > reach * reach {
                    continue;
                }
                let r = rho(i, j);
                if d2 < (ri + rj).powi(2) || r.abs() >= self.cfg.min_overlap {
                    nb.push((d2, j as u32, r));
                } else {
                    ctrl.push((d2, j as u32));
                }
            }
            nb.sort_by(|a, b| a.0.total_cmp(&b.0));
            nb.truncate(self.cfg.max_neighbours);
            ctrl.sort_by(|a, b| a.0.total_cmp(&b.0));
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
            c.ctrl = ctrl.iter().take(4).map(|e| e.1).collect();
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
        let st = trace_stats(&x, self.cfg.event_z, slow, 0.01 * ms, ms, &mut self.scratch);
        let mut other = Vec::with_capacity(len);
        // Neighbour and control correlations over the shared window.
        let nb: Vec<u32> = self.cells[s].nb.iter().map(|e| e.0).collect();
        let mut best = (f32::NAN, u64::MAX);
        let mut rs = Vec::with_capacity(nb.len());
        for &j in &nb {
            let l = len.min(self.cells[j as usize].valid);
            self.window(j as usize, l, &mut other);
            let r = stats::pearson(&x[len - l..], &other);
            rs.push(r);
            if r > best.0 || (best.0.is_nan() && !r.is_nan()) {
                best = (r, self.cells[j as usize].qc.id);
            }
        }
        let ctrl = self.cells[s].ctrl.clone();
        let (mut cs, mut cn) = (0.0f32, 0u32);
        for &j in &ctrl {
            let l = len.min(self.cells[j as usize].valid);
            if l < self.cfg.min_frames {
                continue;
            }
            self.window(j as usize, l, &mut other);
            let r = stats::pearson(&x[len - l..], &other);
            if r.is_finite() {
                cs += r;
                cn += 1;
            }
        }
        self.scratch2 = x;
        let fps = self.cfg.fps;
        let pass = self.cfg.pass;
        let c = &mut self.cells[s];
        c.nb_r = rs;
        c.qc.trace = st;
        c.qc.event_rate = st.events as f32 / (len as f32 / fps / 60.0);
        c.qc.max_neighbour_r = best.0;
        c.qc.max_neighbour_id = best.1;
        c.qc.ctrl_r = if cn > 0 { cs / cn as f32 } else { f32::NAN };
        c.qc.residual_rest = c.res[0].get();
        c.qc.residual_active = c.res[1].get();
        let q = &c.qc;
        c.qc.pass = q.trace.peak_snr >= pass.min_snr
            && q.trace.events >= pass.min_events
            && !(q.max_neighbour_r > pass.max_neighbour_r)
            && !(q.trace.slow_frac > pass.max_slow_frac);
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
            let (p, _) = lib.filtered(s);
            let mut e = 0.0f32;
            let mut k = 0u32;
            for &q in p {
                let q = q as usize;
                let iv = self.inv_noise[q];
                if iv > 0.0 {
                    let r = (y[q] - self.model[q] - b) * iv;
                    e += r * r;
                    k += 1;
                }
            }
            if k == 0 {
                continue;
            }
            let c = &mut self.cells[s];
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
            median_ctrl_r: f32::NAN,
            median_vif: f32::NAN,
            median_asymmetry: f32::NAN,
            slow_frac_high: f32::NAN,
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
            g.median_ctrl_r = med(&|q| q.ctrl_r);
            g.median_vif = med(&|q| q.vif);
            g.median_asymmetry = med(&|q| q.trace.asymmetry);
            g.slow_frac_high = measured
                .iter()
                .filter(|q| q.trace.slow_frac > self.cfg.pass.max_slow_frac)
                .count() as f32
                / measured.len() as f32;
        }
        g
    }
}

impl GlobalQc {
    /// The metrics as numbers in [`GlobalQc::FIELDS`] order; the last entry
    /// is the number of residual blocks (map size), for the bindings.
    pub fn to_row(&self, blocks: usize) -> [f64; 22] {
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
            f(self.median_ctrl_r),
            f(self.median_vif),
            f(self.median_asymmetry),
            f(self.slow_frac_high),
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
