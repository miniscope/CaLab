//! The slow loop: streaming cell discovery (add, merge, refine).
//!
//! The fast loop ([`crate::trace`]) solves every frame for the traces of a
//! fixed footprint [`Library`]. The slow loop watches what that library
//! leaves unexplained and proposes structural edits: **add** a cell where
//! the residual holds a compact, recurring signal; **merge** two cells that
//! are one cell (overlapping, correlated); **refine** a footprint from the
//! frames where it is active. Each edit is a hypothesis tested on frames it
//! was not fitted on, and accepted edits are published as a new immutable
//! library version that the driver swaps into the fast loop between frames
//! ([`TraceEngine::set_library`](crate::trace::TraceEngine::set_library)).
//!
//! # Data flow
//!
//! * [`SlowLoop::observe`] (every frame, cheap): the residual `y − Σ ã_i c_i`
//!   of the fast loop, whitened by the noise map, block-averaged 2 x 2 and
//!   blurred to cell scale, gives each tile (64 px squares) a score, the
//!   largest residual excursion in noise units (robust scale per frame).
//!   The tile's **reservoir** keeps the whitened patch (tile + 24 px margin)
//!   of high-scoring frames (event slots whose priority halves every
//!   `event_half_life_frames`, so late-born cells' events displace old ones)
//!   plus a uniform sample of all frames (random slots; one sample for the
//!   whole frame, stored once as full frames and shared by the tiles). It
//!   is sized by frames per tile (`frames_per_tile`), within a byte cap
//!   (`reservoir_max_bytes`); [`SlowLoop::reservoir_plan`] says when the cap
//!   limits it.
//! * [`SlowLoop::step`] (budgeted): visits the tile with the most new frames.
//!   On its patches, a patch problem solves the working set's cells (each
//!   column the full filtered footprint: exact on its support, the
//!   high-pass moat as block means around it, [`crate::trace::moat_geometry`])
//!   plus a smooth 3 x 3 bump background exactly (non-negative traces) and
//!   gives whitened residuals and χ² values. Frames are split once, by a hash of
//!   the frame index, into fitting frames and held-out frames.
//!
//! # Edits
//!
//! * **Add.** The residual of the fitting frames, blurred to cell scale, is
//!   summed over significant excursions; at its peak a rank-1 factorisation
//!   `r_t ≈ h c_t` (c ≥ 0) is fitted on a *small* disk (0.75 cell diameters):
//!   detect small, merge later. `h` is a filtered footprint; the unfiltered
//!   footprint `a ≥ 0` with `H a ≈ h` comes from projected gradient through
//!   the same high-pass the preprocessing applies (`a − G_σ * a`, exact away
//!   from the lens edge), normalised to peak 1, cut to a seed support of 2.5
//!   half-widths (no upper bound; the running statistics later grow it to
//!   wherever the cell's light is significant: the significant
//!   single-peaked basin of the PSF-smoothed measured light, with a skirt of
//!   measured block-mean light on the rest of the statistics disk); the target is
//!   first smoothed at a tenth of a cell diameter (the
//!   optics' scale), which removes the pixel noise of a footprint estimated
//!   from a few dozen frames. The candidate is accepted when, on the
//!   **held-out** frames:
//!   1. adding its column lowers χ² by more than adding a column of pure
//!      noise would (0.5 per frame for a non-negative coefficient, variance
//!      1.25 per frame) by `accept_z` standard deviations. χ² is measured in
//!      units of the variance the current model leaves per pixel (at least
//!      the noise), because undetected dim cells and neuropil inflate it;
//!      both arms also get a free Gaussian background term (σ = one cell
//!      diameter) at the candidate, so broad local light does not count,
//!      and the first and second spatial derivatives of the two nearest
//!      cells, so the dipole and blur a sub-pixel registration error leaves
//!      beside a bright cell do not count either (`shift_nuisance`). The noise null (and every other
//!      one in the loop, and the trace σ of the event test) is widened by
//!      the measured spatial correlation of the noise, which sub-pixel
//!      motion correction introduces (`noise_corr`, `noisecorr.rs`);
//!   2. its trace rises `event_z` σ above its own held-out median on at
//!      least `min_events` frames (transients: a static residual pattern
//!      with a constant trace is not a cell);
//!   3. its trace does not follow a nearby cell's (r < `merge_corr`):
//!      that is the neighbour's unmodelled light (scatter halo, footprint
//!      mismatch), left to refinement. Optionally (`joint_neighbours`,
//!      off by default) it must not be explained by the nearby cells'
//!      traces jointly either (adjusted R² ≥ `merge_corr`², significant at
//!      1e-3): light left over by *several* neighbours (tails, the
//!      high-pass moat, footprints lagging motion) follows none of them
//!      alone. On the minisim recordings it lifts precision most where
//!      compute is high (motion, 4x visits: .858 -> .900 at 8 min); on the
//!      workshop recording it also blocks real cells, whose neighbours
//!      co-fire (`tools/cala-diagnostics/LEFTOVER_LIGHT.md`).
//!
//!   On the calibrated minisim recording, without 1-3 the loop kept adding
//!   cells (2187 cells for 823 GT units, precision 0.24); with them
//!   precision is 0.92. Thresholds are in noise units throughout, never raw
//!   intensity.
//! * **Merge.** Two cells whose supports overlap and whose traces correlate
//!   over the fitting frames are refitted as one (rank 1 on the union of the
//!   supports, from the residual plus both cells' fitted signal). The merge
//!   is accepted unless keeping them separate beats it on held-out frames by
//!   the same margin an add needs, so add and merge share one test.
//! * **Refine.** Each cell's footprint is re-estimated on a disk 2 px wider
//!   than its support, from the residual plus its own signal over the
//!   fitting frames where its trace is above 2 σ (activity-gated), and kept
//!   if held-out χ² improves.
//!
//! Accepted edits update the slow loop's working set at once (so the next
//! proposal on that tile sees them: no re-detection of the same signal) and
//! are published at most every `commit_interval_frames`. Rejected spots are
//! suppressed for a cooldown that doubles with each rejection.
//!
//! # Trimming with accumulating evidence
//!
//! An accepted cell is a hypothesis that keeps being tested; the library
//! should tend toward the right answer as frames come in, not be right at
//! once. Every published cell has an evidence ledger (`ledger.rs`), fed
//! every frame from the fast loop's result. That result comes from a library
//! fitted only on earlier frames, so every frame after a cell's birth is a
//! held-out test of it.
//!
//! * **Transients.** The ledger counts the cell's calcium-like transients
//!   after birth (a run of at least `event_frames` frames above 2 σ that
//!   peaks beyond `event_z` σ of a running baseline and noise scale).
//! * **Keep test (the add test in reverse).** The first held-out frame of
//!   each transient is stored as a *probe* in the cell's tile. On the next
//!   visit, the tile's model is solved on it with and without the cell, both
//!   with the add test's free local bump. The probe *passes* when the cell
//!   lowers χ² by `keep_z` σ of the noise-column null. It *fails* when the
//!   bump explains the signal as well (diffuse light, neuropil, a halo)
//!   although the cell's light on the probe, had it been shaped like the
//!   footprint, would have passed by `keep_z` σ. When it would not have
//!   (a weak transient), the probe is *inconclusive* and counts neither
//!   way. It counts as *redundant* when a neighbouring cell takes the
//!   signal over.
//! * **Decisions** (`SlowLoop::prune`, every step). Established: at least
//!   `establish_events` transients and no more failed than passed probes.
//!   Deleted as unsupported: `delete_fails` failed probes, outnumbering the
//!   passed ones `fail_ratio` to one. Deleted as silent: not a single
//!   transient within `probation_frames` of birth. A cell that is mostly
//!   redundant with one neighbour gets a merge test with it.
//! * **Merging established cells.** A pair whose merge test was rejected no
//!   longer blocks the tile's other pairs. Pairs whose filtered footprints
//!   largely coincide (cosine ≥ 0.5) are tested even when their traces do
//!   not correlate (an exact fit gives a duplicate no signal). Such a pair
//!   is merged when its held-out traces move together, or when one of the
//!   two carries under a quarter of the pair's signal.
//! * **No oscillation.** A deleted spot keeps a tombstone. Nothing is added
//!   there for 4^k cooldowns after the k-th deletion, and a new cell there
//!   needs held-out events from after the deletion. A re-added cell gets a
//!   probation window that is longer by the number of earlier deletions.
//!
//! [`SlowLoop::cell_infos`] reports each cell's status and evidence,
//! [`SlowLoop::take_edit_counts`] gives per-interval counts of adds, merges,
//! deletes and refines, and [`SlowLoop::take_deleted`] lists the cells
//! deleted, with the evidence each one was deleted on. Proposals are first
//! checked by a cheap held-out pre-test before the expensive fit. Published
//! libraries filter again only the footprints that changed
//! ([`LibraryBuilder::reuse`]).
//!
//! # Competing explanations (v3)
//!
//! v2 still churned on real data: residual left around an existing cell
//! (its footprint imperfect) was added as a small new cell and later
//! merged back, over and over. v3 decides every structural edit by model
//! comparison on held-out frames, and keeps footprints converging so that
//! less residual arises in the first place.
//!
//! * **Running footprint statistics** (`fpstats.rs`). Every fitting frame
//!   updates, per cell, the centred covariance of its own-signal residual
//!   with the fast loop's trace of the cell, on a disk wider than its
//!   support. The footprint from all frames so far is the ratio of the
//!   covariances; its standard error falls as frames come in. A cell is
//!   refined from it when the estimate disagrees with the current footprint
//!   beyond its own noise (a χ² test) *and* the change lowers held-out χ²
//!   (paired held-out gain above `refine_z`, 0 by default: the χ² test
//!   already used all frames). Converged footprints stop being proposed. The
//!   reservoir's noisier estimate is used only for young cells.
//! * **Add vs absorb vs merge-in.** A residual candidate competes with the
//!   overlapping cells re-estimated to take it up: from their statistics,
//!   grown into the candidate's disk with their trace fixed, or (when the
//!   candidate's trace follows theirs) refitted at rank 1 with it. A new
//!   cell costs a column, so it must beat the best alternative by the add
//!   margin; otherwise the best alternative is applied if it is confirmed
//!   on held-out frames it was not chosen on (`absorb_z`), and the spot is
//!   suppressed for a cooldown that doubles each time.
//! * **Split.** A cell whose active frames factorise at rank 2 into parts
//!   with distinct traces is tested as two cells; the pair must beat both
//!   the single cell and its best re-estimate by the add margin, and each
//!   part must pass the add test's event and neighbour-trace checks.
//! * **Merge.** A pair is compared with one cell fitted to both and with
//!   either cell alone; it is kept apart only when that beats the best
//!   single-cell alternative by `merge_z` (hysteresis below `accept_z`).
//!   The merged cell is a fresh fit, so the pair is also refitted on the
//!   same frames (`merge_refit_pair`) and the better of the two pairs is
//!   the baseline: otherwise footprints that lag the data (motion, slow
//!   change) lose to any fresh footprint and distinct cells are merged.
//!   The refitted pair counts only while it stays two cells (supports
//!   overlapping by less than half, the weaker part with at least
//!   `merge_refit_min_share` of the energy), so duplicates still merge.
//!   A young cell merged back marks its spot like a rejection.
//!
//! [`SlowLoop::take_edit_log`] lists every structural edit with the cells
//! involved and its held-out margin.
//! [`SlowLoop::churn_counts`] classifies every add as new or a re-add and
//! counts adds removed again soon and removals of established cells
//! (`churn.rs`), for the QC's convergence rule; it changes no decision.
//!
//! # Threading
//!
//! The slow loop is a plain struct with no clock: `step(budget)` spends a
//! work budget (approximately multiply-adds) with carry-over, so a single
//! WASM worker can interleave it with the fast loop deterministically.
//!
//! Tile visits can also run in parallel on other workers (`shard.rs`):
//! the loop then only observes, and hands each visit out as a
//! [`VisitJob`] ([`SlowLoop::take_job`]) to a [`VisitRunner`], applies the
//! [`VisitResult`] when it comes back ([`SlowLoop::apply_job`]) and
//! publishes from [`SlowLoop::housekeep`]. Visits out at the same time
//! never share a cell; [`SlowLoop::step_via`] runs the same protocol one
//! visit at a time and is identical to `step`.

// Index loops over pixels and cells read more clearly here; `!(x > 0.0)`
// deliberately treats NaN as "not positive".
#![allow(
    clippy::needless_range_loop,
    clippy::neg_cmp_op_on_partial_ord,
    clippy::type_complexity
)]

/// Record an edit for the slow loop a visit was run for (`shard.rs`). Defined before the
/// `mod` lines so that every child module can use it.
macro_rules! journal {
    ($s:ident, $op:expr) => {
        if let Some(j) = $s.journal.as_mut() {
            j.push($op);
        }
    };
}

mod add;
mod churn;
mod cluster;
mod config;
mod construct;
mod counters;
#[cfg(feature = "diagnostics")]
mod diagnostics;
mod estimate;
mod evidence;
mod fpstats;
mod ledger;
mod local;
mod lookback;
mod math;
mod merge;
#[cfg(feature = "diagnostics")]
mod mergelog;
mod noisecorr;
mod observe;
mod prune;
mod refine;
mod reservoir;
mod shard;
mod solve;
mod visit;
mod visitrate;
mod wire;

/// Re-export of the crate-level stage timers (`discover::timing` paths, e.g. qc_eval).
pub use crate::timing;

pub use churn::{AddClass, AddRecord, ChurnConfig, ChurnCounts, RemovalKind, RemovalRecord};
pub use config::{
    EditScope, JointAdmit, JointSign, JointUpdate, MergeRule, RefineGate, SlowLoopConfig,
    PSF_SIGMA_PX,
};
pub use counters::{DueDiag, ReplayStats, ReservoirPlan, SettleStats, SlowStats};
pub use ledger::{
    CellInfo, CellStatus, DeleteReason, DeletedCell, EditCounts, EditEvent, EditKind, TestEvent,
};
pub use lookback::{
    HeldOutRecord, LookBack, LookbackConfig, LookbackNext, LookbackOrder, LookbackOutcome,
    LookbackRequest, SettleSched, LB_BLOCK,
};
#[cfg(feature = "diagnostics")]
pub use mergelog::{flush as merge_log_flush, set_gt as merge_log_set_gt};
pub use shard::{VisitJob, VisitResult, VisitRunner};

/// Measurement hook: called with every library a [`SlowLoop`] publishes
/// ([`SlowLoop::publish_tap`]).
pub type PublishTap = Box<dyn FnMut(&Library) + Send>;
pub use visitrate::{VisitRateStats, VisitSchedule, VISIT_BANK_FRAMES, VISIT_HOLD_FLOOR_RATIO};

#[cfg(feature = "jsbindings")]
mod js;

use std::collections::HashMap;
use std::sync::Arc;

use churn::Churn;
use cluster::ClusterStore;
use fpstats::FpStats;
use ledger::Evidence;
use local::{BgBasis, Cell, Column, Extent, Fit, GramRef, LocalFilter, PatchGrid, Rect};
use noisecorr::NoiseCorr;
use reservoir::{mix, SharedFrames, Tile};
use shard::{InFlight, Op};

use construct::SplitHalves;
use counters::plan_reservoir;
use evidence::LedgerProj;

// Reached as `super::…` by cluster.rs and diagnostics.rs, and by the unit
// tests through `super::*`.
use math::{column_on, paired_z, solve_dense};
use solve::{Frames, Start};

#[cfg(feature = "diagnostics")]
use construct::MeasuredSupport;

#[cfg(all(test, feature = "jsbindings"))]
use crate::trace::BackgroundModel;
#[cfg(test)]
use crate::trace::LibraryConfig;
#[cfg(test)]
use estimate::split_excess;
#[cfg(test)]
use math::{adjusted_r2, corr};
#[cfg(test)]
use observe::whiten;

use crate::preprocess::flatten::GlowFlattener;
use crate::preprocess::gaussian::RecursiveGaussian;
use crate::preprocess::Dims;
use crate::trace::{Footprint, Library, LinearFilter, TraceError};

/// The slow loop. See the module docs.
pub struct SlowLoop {
    dims: Dims,
    cfg: SlowLoopConfig,
    fov: Vec<u8>,
    noise: Vec<f32>,
    inv_sigma: Vec<f32>,
    flattener: GlowFlattener,
    filter: LocalFilter,
    detect: LocalFilter,
    smooth: LocalFilter,
    /// Smoothing at the optics' PSF scale (basins of a footprint's light).
    psf: LocalFilter,
    /// DIAG counters of the support rule: measured supports, and those with
    /// a second significant peak outside the cell's basin.
    pub basin_diag: (u64, u64),
    /// The statistics' split halves (disk pixels, `h_A`, `h_B`, `s_A`,
    /// `s_B`) for the next `finish_cell` (the support rule, and the
    /// support audit).
    support_tmp: Option<SplitHalves>,
    tiles: Vec<Tile>,
    /// The tiles' random slots: one uniform sample of full frames.
    shared: SharedFrames,
    plan: ReservoirPlan,
    tile_visits: Vec<u32>,
    bgs: Vec<Option<BgBasis>>,
    cap_events: usize,
    cap_random: usize,
    /// Per-frame log decay of the event slots' priority.
    ln_decay: f64,
    cells: Vec<Cell>,
    next_id: u64,
    frames: u64,
    pending: bool,
    last_commit: u64,
    credit: i64,
    work: u64,
    rng: u64,
    published: Option<Arc<Library>>,
    stats: SlowStats,
    edits: EditCounts,
    /// Evidence per published cell, by id.
    ledger: HashMap<u64, Evidence>,
    /// Earlier deletions at the spot a cell was added on, by id.
    lives: HashMap<u64, u32>,
    /// Projection of the residual onto each slot of the library the ledger
    /// last read (rebuilt when the version changes).
    lproj: LedgerProj,
    lproj_ids: Vec<u64>,
    deleted: Vec<DeletedCell>,
    /// Structural edits since the last `take_edit_log` (bounded).
    edit_log: Vec<EditEvent>,
    /// Held-out edit tests since the last `take_test_log` (bounded).
    #[cfg(feature = "diagnostics")]
    test_log: Vec<TestEvent>,
    /// DIAG: pixels to sample in `finish_basin` and the samples (h, the
    /// smoothed target, q, tol, in S0, in X, the inverted light before
    /// normalisation, on the mask).
    #[cfg(feature = "diagnostics")]
    pub(crate) probe: Option<(Vec<u32>, Vec<[f32; 8]>)>,
    /// Running footprint statistics per published cell, by id, and the
    /// current weight of a new frame (grows by the inverse forgetting
    /// factor; renormalised).
    fpstats: HashMap<u64, FpStats>,
    /// Joint update (`cluster.rs`): the cluster stores, each member's
    /// cluster, the library cell set they were built for, whether each
    /// cluster's last replay was usable (its members then skip the per-cell
    /// refinement), and a residual buffer.
    clusters: Vec<ClusterStore>,
    cluster_of: HashMap<u64, usize>,
    cluster_ids: Vec<u64>,
    cluster_ok: Vec<bool>,
    cbuf: Vec<f32>,
    /// Counters of the joint update.
    pub replay_stats: ReplayStats,
    /// Stage timers (feature `timing`; zero otherwise). Measurement only.
    pub stage: timing::StageTiming,
    /// Library-build timers and counts (feature `timing`; zero otherwise).
    /// Measurement only.
    pub build: timing::BuildTiming,
    /// Measurement: called with every library this loop publishes (after
    /// the build and its timers). `qc_eval` hashes them.
    pub publish_tap: Option<PublishTap>,
    stats_w: f32,
    stats_gamma: f32,
    rbuf: Vec<f32>,
    /// During [`SlowLoop::observe_lookback`] with a cell set: only these
    /// cells' statistics (and clusters with one of them) take the frame.
    lb_only: Option<std::collections::HashSet<u64>>,
    /// Pairs whose merge was rejected: `(id, id, until_frame)`.
    merge_rejected: Vec<(u64, u64, u64)>,
    /// Pairs the keep tests found redundant, to be merge-tested regardless
    /// of their trace correlation.
    forced: Vec<(u64, u64)>,
    /// Which structural edits visits may make ([`SlowLoop::set_edit_scope`]).
    scope: EditScope,
    /// In [`EditScope::Refine`], make the visits that would not refine at
    /// hand-out instead of as jobs (`next_job_tile` in `shard.rs`). On by
    /// default; tests turn it off to check that the footprints are the same
    /// without it.
    pub(crate) skip_unused: bool,
    /// The Discover visit cap ([`SlowLoop::set_visit_rate`]).
    vrate: visitrate::VisitRate,
    // observe() buffers
    model: Vec<f32>,
    z: Vec<f32>,
    qrow: Vec<f32>,
    coarse: Vec<f32>,
    coarse_blur: Vec<f32>,
    coarse_fov: Vec<bool>,
    coarse_dims: Dims,
    coarse_gauss: RecursiveGaussian,
    sample: Vec<f32>,
    ncorr: NoiseCorr,
    /// Cell-scale noise variance inflation `ρ` (1 = white noise).
    rho: f32,
    /// Add classification (new / re-add / churned).
    churn: Churn,
    /// Parallel visits (`shard.rs`): the edits a visit run for another
    /// slow loop makes (`Some` only in a [`VisitRunner`]), the visits
    /// handed out and not yet applied, and a counter for their ids.
    journal: Option<Vec<Op>>,
    inflight: Vec<InFlight>,
    job_seq: u64,
    /// Bumped by every `set_noise` (a visit must run on the same map).
    noise_gen: u64,
    /// Within a visit: the last problem's Gram terms
    /// ([`Problem::new_reusing`]) and the tile's moat grid (both are
    /// cleared when the visit ends).
    gram_memo: Option<GramRef>,
    grid_memo: std::cell::RefCell<Option<Arc<PatchGrid>>>,
    /// Within a visit: the columns of the last problem on the tile's own
    /// background and its label ([`Problem::sig`]), and the per-frame
    /// solves of labelled problems: `(label, frames id, start key
    /// ([`Start::key`], 0: from zero), work, fits)`.
    /// The same model on the same frames is solved once.
    tile_model: Option<(u64, Arc<Vec<Column>>)>,
    solve_memo: Vec<(u64, u64, u64, u64, Vec<Fit>)>,
    /// The residuals of the last labelled model: `(label, frames id,
    /// work, fits, residuals)`.
    #[allow(clippy::type_complexity)]
    resid_memo: Option<(u64, u64, u64, Vec<Fit>, Vec<Vec<f32>>)>,
    model_seq: u64,
    frames_seq: u64,
    /// The visit memos above and the frames' dot cache (off only in tests,
    /// which compare against the plain computation).
    reuse: bool,
    /// [`SlowLoop::set_reservoir_frozen`].
    res_frozen: bool,
    /// The concurrent settle ([`SlowLoop::observe_settle`]): on, and its
    /// counters.
    cs_on: bool,
    cs_stats: SettleStats,
    /// How tiles came due ([`DueDiag`]; diagnostics only).
    due_diag: DueDiag,
}

impl SlowLoop {
    /// `flattener` is the preprocessing high-pass (used to build published
    /// libraries); `fov` the FOV mask; `noise` the per-pixel noise σ.
    pub fn new(
        dims: Dims,
        fov: Vec<u8>,
        noise: Vec<f32>,
        flattener: GlowFlattener,
        cfg: SlowLoopConfig,
    ) -> Result<SlowLoop, TraceError> {
        cfg.validate()?;
        let n_px = dims.pixels();
        crate::trace::check_len("fov mask", n_px, fov.len())?;
        if LinearFilter::dims(&flattener) != dims {
            return Err(TraceError::Incompatible("flattener frame size".into()));
        }
        let sigma = flattener.sigma();
        // Tiles over the bounding box of the FOV.
        let (mut ymin, mut ymax, mut xmin, mut xmax) = (usize::MAX, 0, usize::MAX, 0);
        for (i, &m) in fov.iter().enumerate() {
            if m != 0 {
                let (y, x) = (i / dims.width, i % dims.width);
                ymin = ymin.min(y);
                ymax = ymax.max(y);
                xmin = xmin.min(x);
                xmax = xmax.max(x);
            }
        }
        let mut tiles = Vec::new();
        if ymin <= ymax {
            let t = cfg.tile_px;
            let m = cfg.margin_px;
            let mut y = ymin;
            while y <= ymax {
                let mut x = xmin;
                while x <= xmax {
                    let core = Rect {
                        y0: y,
                        x0: x,
                        h: t.min(ymax + 1 - y),
                        w: t.min(xmax + 1 - x),
                    };
                    let any = (core.y0..core.y0 + core.h).any(|yy| {
                        fov[yy * dims.width + core.x0..yy * dims.width + core.x0 + core.w]
                            .iter()
                            .any(|&v| v != 0)
                    });
                    if any {
                        let y0 = core.y0.saturating_sub(m);
                        let x0 = core.x0.saturating_sub(m);
                        let y1 = (core.y0 + core.h + m).min(dims.height);
                        let x1 = (core.x0 + core.w + m).min(dims.width);
                        let rect = Rect {
                            y0,
                            x0,
                            h: y1 - y0,
                            w: x1 - x0,
                        };
                        tiles.push(Tile::new(core, rect));
                    }
                    x += t;
                }
                y += t;
            }
        }
        let shared_rect = tiles
            .iter()
            .map(|t| t.rect)
            .reduce(|a, b| a.union(&b))
            .unwrap_or(Rect {
                y0: 0,
                x0: 0,
                h: 0,
                w: 0,
            });
        let plan = plan_reservoir(&cfg, &tiles, shared_rect);
        let (cap_events, cap_random) = (plan.event_slots, plan.random_slots);
        let coarse_dims = Dims {
            width: dims.width.div_ceil(2),
            height: dims.height.div_ceil(2),
        };
        let mut coarse_fov = vec![false; coarse_dims.pixels()];
        for (i, &m) in fov.iter().enumerate() {
            if m != 0 {
                let (y, x) = (i / dims.width, i % dims.width);
                coarse_fov[(y / 2) * coarse_dims.width + x / 2] = true;
            }
        }
        let coarse_sigma = (cfg.cell_diameter_px / 8.0).max(0.6);
        let coarse_gauss = RecursiveGaussian::new(coarse_dims, coarse_sigma)
            .map_err(|e| TraceError::InvalidConfig(e.to_string()))?;
        let n_tiles = tiles.len();
        let mut s = SlowLoop {
            dims,
            fov,
            noise: Vec::new(),
            inv_sigma: Vec::new(),
            flattener,
            filter: LocalFilter::new(sigma),
            detect: LocalFilter::new((cfg.cell_diameter_px / 4.0).max(0.6)),
            smooth: LocalFilter::new((cfg.cell_diameter_px / 10.0).max(0.6)),
            psf: LocalFilter::new(cfg.psf_sigma_px),
            basin_diag: (0, 0),
            support_tmp: None,
            tiles,
            shared: SharedFrames::new(shared_rect),
            plan,
            tile_visits: vec![0; n_tiles],
            bgs: vec![None; n_tiles],
            cap_events,
            cap_random,
            ln_decay: -std::f64::consts::LN_2 / f64::from(cfg.event_half_life_frames),
            cells: Vec::new(),
            next_id: 1,
            frames: 0,
            pending: false,
            last_commit: 0,
            credit: 0,
            work: 0,
            rng: mix(cfg.seed ^ 0x5eed),
            published: None,
            stats: SlowStats::default(),
            edits: EditCounts::default(),
            ledger: HashMap::new(),
            lives: HashMap::new(),
            lproj: LedgerProj {
                version: u64::MAX,
                ..LedgerProj::default()
            },
            lproj_ids: Vec::new(),
            deleted: Vec::new(),
            edit_log: Vec::new(),
            #[cfg(feature = "diagnostics")]
            test_log: Vec::new(),
            #[cfg(feature = "diagnostics")]
            probe: None,
            fpstats: HashMap::new(),
            clusters: Vec::new(),
            cluster_of: HashMap::new(),
            cluster_ids: Vec::new(),
            cluster_ok: Vec::new(),
            cbuf: Vec::new(),
            replay_stats: ReplayStats::default(),
            stage: timing::StageTiming::default(),
            build: timing::BuildTiming::default(),
            publish_tap: None,
            stats_w: 1.0,
            stats_gamma: 0.5f32.powf(1.0 / cfg.stats_half_life_frames),
            rbuf: Vec::new(),
            lb_only: None,
            res_frozen: false,
            cs_on: false,
            cs_stats: SettleStats::default(),
            due_diag: DueDiag::default(),
            merge_rejected: Vec::new(),
            forced: Vec::new(),
            scope: EditScope::All,
            model: vec![0.0; n_px],
            z: vec![0.0; n_px],
            qrow: Vec::new(),
            coarse: vec![0.0; coarse_dims.pixels()],
            coarse_blur: vec![0.0; coarse_dims.pixels()],
            coarse_fov,
            coarse_dims,
            coarse_gauss,
            sample: Vec::new(),
            ncorr: NoiseCorr::new(n_px),
            rho: 1.0,
            churn: Churn::new(cfg.churn, cfg.cell_diameter_px),
            journal: None,
            inflight: Vec::new(),
            job_seq: 0,
            noise_gen: 0,
            gram_memo: None,
            grid_memo: std::cell::RefCell::new(None),
            tile_model: None,
            solve_memo: Vec::new(),
            resid_memo: None,
            model_seq: 0,
            frames_seq: 0,
            reuse: true,
            skip_unused: true,
            vrate: visitrate::VisitRate::default(),
            cfg,
        };
        s.set_noise(noise)?;
        Ok(s)
    }

    /// Restrict the structural edits from now on (default
    /// [`EditScope::All`]). Applies to visits run by [`SlowLoop::step`] and
    /// to the visits handed out from now on (a [`VisitJob`] carries the
    /// scope, so a [`VisitRunner`] follows it). A refine replay (the app's
    /// Refine stage, qc_eval's `--later-passes refine`) sets
    /// [`EditScope::Refine`] and feeds the recording again from frame 0.
    pub fn set_edit_scope(&mut self, scope: EditScope) {
        self.scope = scope;
        if !self.joint_active() {
            self.clear_clusters();
        }
    }

    /// The structural edits allowed now ([`SlowLoop::set_edit_scope`]).
    pub fn edit_scope(&self) -> EditScope {
        self.scope
    }

    /// Replace the noise map (σ per pixel). New patches are whitened with it.
    pub fn set_noise(&mut self, noise: Vec<f32>) -> Result<(), TraceError> {
        // The patch grid's whitening comes from the noise map.
        *self.grid_memo.get_mut() = None;
        crate::trace::check_len("noise map", self.dims.pixels(), noise.len())?;
        if noise.iter().any(|v| !v.is_finite() || *v < 0.0) {
            return Err(TraceError::InvalidConfig(
                "noise map must be finite and >= 0".into(),
            ));
        }
        self.inv_sigma = noise
            .iter()
            .zip(&self.fov)
            .map(|(&s, &m)| if m != 0 && s > 0.0 { 1.0 / s } else { 0.0 })
            .collect();
        self.noise = noise;
        self.noise_gen += 1;
        #[cfg(feature = "diagnostics")]
        diagnostics::noise(self);
        Ok(())
    }

    pub fn config(&self) -> &SlowLoopConfig {
        &self.cfg
    }

    /// How tiles came due so far ([`DueDiag`]).
    pub fn due_diag(&self) -> DueDiag {
        self.due_diag
    }

    /// Diagnostics: every tile's count of new reservoir slots since its
    /// last visit (a tile is due for a visit from [`SlowLoop::due_slots`]
    /// on), into `out`.
    pub fn tile_fresh(&self, out: &mut Vec<u32>) {
        out.clear();
        out.extend(self.tiles.iter().map(|t| t.fresh));
    }

    /// The count of new reservoir slots that makes a tile due for a visit.
    pub fn due_slots(&self) -> u32 {
        self.cfg.visit_after_slots
    }

    pub fn stats(&self) -> SlowStats {
        self.stats
    }

    /// Cells in the working set (published or not).
    /// Measured cell-scale variance inflation of the noise over white noise
    /// (1 without spatial correlation; see [`SlowLoopConfig::noise_corr`]).
    pub fn noise_inflation(&self) -> f32 {
        self.rho
    }

    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// Frames observed so far.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Work spent so far (approximately multiply-adds).
    pub fn work(&self) -> u64 {
        self.work
    }

    /// Bytes held by the reservoir now, and the per-tile slot counts.
    pub fn reservoir_bytes(&self) -> usize {
        self.tiles.iter().map(Tile::bytes).sum::<usize>() + self.shared.bytes()
    }

    /// `(event, random)` slots per tile.
    pub fn slots_per_tile(&self) -> (usize, usize) {
        (self.cap_events, self.cap_random)
    }

    /// How the reservoir is sized, and whether its byte cap limits it.
    pub fn reservoir_plan(&self) -> ReservoirPlan {
        self.plan
    }

    /// Split-half noise of cell `id`'s footprint estimate, relative to its
    /// size, on the pixels of `support`: `‖h_A − h_B‖ / 2 / ‖(h_A + h_B) / 2‖`
    /// (the two halves of the running statistics are independent, each with
    /// twice the variance of the full estimate, so half their difference is
    /// the noise of the full estimate). `None` without usable halves or
    /// overlap. Scale free, so it compares with a relative footprint change.
    pub fn footprint_noise(&self, id: u64, support: &[u32]) -> Option<f64> {
        let st = self.fpstats.get(&id)?;
        let (ha, hb, _, _) = st.halves()?;
        let want: std::collections::HashSet<u32> = support.iter().copied().collect();
        let (mut d2, mut m2) = (0.0f64, 0.0f64);
        for (i, p) in st.pix.iter().enumerate() {
            if want.contains(p) {
                let (a, b) = (f64::from(ha[i]), f64::from(hb[i]));
                d2 += (a - b) * (a - b);
                m2 += (0.5 * (a + b)) * (0.5 * (a + b));
            }
        }
        (m2 > 0.0 && d2.is_finite()).then(|| 0.5 * (d2 / m2).sqrt())
    }

    /// `(id, frame it entered the working set)` of every working-set cell.
    pub fn births(&self) -> Vec<(u64, u64)> {
        self.cells.iter().map(|c| (c.id, c.born)).collect()
    }

    /// Evidence on every working-set cell (cells not yet published have
    /// `frames == 0`).
    pub fn cell_infos(&self) -> Vec<CellInfo> {
        self.cells.iter().map(|c| self.info(c)).collect()
    }

    /// Evidence on one cell, if it is in the working set.
    pub fn cell_info(&self, id: u64) -> Option<CellInfo> {
        self.cells.iter().find(|c| c.id == id).map(|c| self.info(c))
    }

    /// Ledger state per published cell: `(id, last coordinate, baseline,
    /// scale)`. For diagnostics.
    #[doc(hidden)]
    pub fn debug_ledger(&self) -> Vec<(u64, f32, f32, f32)> {
        let mut v: Vec<_> = self
            .ledger
            .iter()
            .map(|(&id, e)| (id, e.last_u, e.base, e.scale))
            .collect();
        v.sort_by_key(|e| e.0);
        v
    }

    /// Edits since the last call (adds, merges, deletes, refines, commits),
    /// for a per-interval display.
    pub fn take_edit_counts(&mut self) -> EditCounts {
        std::mem::take(&mut self.edits)
    }

    /// Cells deleted since the last call, with the evidence they were
    /// deleted on.
    pub fn take_deleted(&mut self) -> Vec<DeletedCell> {
        std::mem::take(&mut self.deleted)
    }

    /// Cumulative add classification: new adds, re-adds, adds churned
    /// (removed again soon), removals of established cells.
    pub fn churn_counts(&self) -> ChurnCounts {
        self.churn.counts()
    }

    /// Adds since the last call, with their class and the evidence for it.
    pub fn take_add_log(&mut self) -> Vec<AddRecord> {
        self.churn.take_adds()
    }

    /// Removals (deletes, merges) since the last call, with the removed
    /// cell's age and whether it counted as churn.
    pub fn take_removal_log(&mut self) -> Vec<RemovalRecord> {
        self.churn.take_removals()
    }

    /// Structural edits since the last call (at most the latest 100 000),
    /// with the cells involved and the held-out margin of each decision.
    pub fn take_edit_log(&mut self) -> Vec<EditEvent> {
        std::mem::take(&mut self.edit_log)
    }

    /// Held-out edit tests (refine, merge, split, absorb) since the last
    /// call, accepted or not (at most the latest 200 000).
    #[cfg(feature = "diagnostics")]
    pub fn take_test_log(&mut self) -> Vec<TestEvent> {
        std::mem::take(&mut self.test_log)
    }

    #[cfg(feature = "diagnostics")]
    fn log_test(&mut self, kind: EditKind, id: u64, other: u64, accepted: bool, z: f64) {
        if self.test_log.len() >= 200_000 {
            self.test_log.drain(..100_000);
        }
        self.test_log.push(TestEvent {
            frame: self.frames,
            kind,
            id,
            other,
            accepted,
            z: z as f32,
        });
    }

    fn log(&mut self, kind: EditKind, id: u64, other: u64, center: (f32, f32), margin: f32) {
        if self.edit_log.len() >= 100_000 {
            self.edit_log.drain(..50_000);
        }
        self.edit_log.push(EditEvent {
            frame: self.frames,
            kind,
            id,
            other,
            center,
            margin,
        });
    }

    /// The nearest cell to `(y, x)` other than `skip` (0 when none).
    fn nearest(&self, y: f32, x: f32, skip: u64) -> u64 {
        self.cells
            .iter()
            .filter(|c| c.id != skip)
            .map(|c| (c.id, (c.center.0 - y).powi(2) + (c.center.1 - x).powi(2)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map_or(0, |c| c.0)
    }

    fn info(&self, c: &Cell) -> CellInfo {
        let ev = self.ledger.get(&c.id);
        CellInfo {
            id: c.id,
            born: c.born,
            status: if ev.is_some_and(|e| e.established) {
                CellStatus::Established
            } else {
                CellStatus::Probation
            },
            frames: ev.map_or(0, |e| e.frames),
            transients: ev.map_or(0, |e| e.transients),
            dips: ev.map_or(0, |e| e.dips),
            peak_z: ev.map_or(0.0, |e| e.peak_z),
            passes: ev.map_or(0, |e| e.passes),
            fails: ev.map_or(0, |e| e.fails),
            redundant: ev.map_or(0, |e| e.redundant),
            center: c.center,
        }
    }

    /// The last published library.
    pub fn library(&self) -> Option<&Arc<Library>> {
        self.published.as_ref()
    }

    /// Start from existing footprints (unfiltered, `id`s kept), e.g. to
    /// resume or to refine a library from another source. They keep their
    /// own extent (clipped to the FOV).
    /// Returns how many were kept. Published with the next commit.
    pub fn seed(&mut self, footprints: &[Footprint]) -> Result<usize, TraceError> {
        let mut kept = 0;
        for fp in footprints {
            crate::trace::check_len("footprint values", fp.height * fp.width, fp.values.len())?;
            if self.cells.iter().any(|c| c.id == fp.id) {
                return Err(TraceError::InvalidFootprint(format!(
                    "duplicate id {}",
                    fp.id
                )));
            }
            if fp.y0 + fp.height > self.dims.height || fp.x0 + fp.width > self.dims.width {
                return Err(TraceError::InvalidFootprint(format!(
                    "id {}: outside the frame",
                    fp.id
                )));
            }
            let rect = Rect {
                y0: fp.y0,
                x0: fp.x0,
                h: fp.height,
                w: fp.width,
            };
            if let Some(c) = Cell::from_canvas(
                fp.id,
                rect,
                &fp.values,
                self.dims,
                &self.fov,
                &self.cfg.library,
                Extent::Given,
                &mut self.filter,
                &[],
            ) {
                self.next_id = self.next_id.max(fp.id + 1);
                self.cells.push(c);
                kept += 1;
            }
        }
        self.pending = true;
        Ok(kept)
    }

    /// Add cells found by the history review
    /// ([`crate::compress::review`]): the session's compressed history shows
    /// them, the add test on a tile's reservoir did not. Each gets a new id
    /// and starts on probation like any add, so the keep tests still apply.
    /// A candidate on an existing cell, or on a spot where a cell was
    /// deleted and the cooldown has not run out, is skipped. Returns how
    /// many were added; published with the next commit.
    pub fn add_reviewed(&mut self, footprints: &[Footprint]) -> Result<usize, TraceError> {
        let d = self.cfg.cell_diameter_px;
        let quiet = self.cfg.reject_cooldown_frames;
        let now = self.frames;
        let mut added = 0;
        for fp in footprints {
            crate::trace::check_len("footprint values", fp.height * fp.width, fp.values.len())?;
            if fp.y0 + fp.height > self.dims.height || fp.x0 + fp.width > self.dims.width {
                return Err(TraceError::InvalidFootprint(
                    "reviewed candidate outside the frame".into(),
                ));
            }
            let rect = Rect {
                y0: fp.y0,
                x0: fp.x0,
                h: fp.height,
                w: fp.width,
            };
            let Some(mut cell) = Cell::from_canvas(
                self.next_id,
                rect,
                &fp.values,
                self.dims,
                &self.fov,
                &self.cfg.library,
                Extent::Given,
                &mut self.filter,
                &[],
            ) else {
                continue;
            };
            let (cy, cx) = cell.center;
            let close = |y: f32, x: f32| (y - cy).powi(2) + (x - cx).powi(2) <= (0.5 * d).powi(2);
            let taken = self.cells.iter().any(|c| close(c.center.0, c.center.1));
            let entombed = self.tile_of(cy, cx).is_some_and(|ti| {
                self.tiles[ti]
                    .tombs
                    .iter()
                    .any(|r| r.2 + quiet * (1u64 << (2 * r.3.min(6))) > now && close(r.0, r.1))
            });
            if taken || entombed {
                continue;
            }
            cell.born = now;
            self.edits.adds += 1;
            self.stats.adds += 1;
            self.stats.review_adds += 1;
            let nb = self.nearest(cy, cx, cell.id);
            self.log(EditKind::Add, cell.id, nb, cell.center, 0.0);
            self.churn
                .on_add(now, cell.id, cell.center, &cell.pix, &cell.filt);
            self.next_id += 1;
            let bbox = cell.bbox;
            self.cells.push(cell);
            self.touch(bbox);
            added += 1;
        }
        if added > 0 {
            self.pending = true;
        }
        Ok(added)
    }
}

#[cfg(test)]
mod tests;
