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
//!   wherever the cell's light is significant, `support_z`); the target is
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
//!   with its fast-loop trace on a disk wider than its support. The
//!   least-squares footprint from all frames so far is their ratio; its
//!   standard error falls as frames come in. A cell is refined from it
//!   when the estimate disagrees with the current footprint beyond its own
//!   noise (a χ² test) *and* the change lowers held-out χ² (paired z ≥
//!   `refine_z`). Converged footprints stop being proposed. The reservoir's
//!   noisier estimate is used only for young cells.
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

mod churn;
#[cfg(feature = "diagnostics")]
mod diagnostics;
mod fastcore;
mod fpstats;
mod ledger;
mod local;
mod noisecorr;
mod reservoir;
mod shard;
mod wire;

pub use churn::{AddClass, AddRecord, ChurnConfig, ChurnCounts, RemovalKind, RemovalRecord};
pub use ledger::{
    CellInfo, CellStatus, DeleteReason, DeletedCell, EditCounts, EditEvent, EditKind,
};
pub use shard::{VisitJob, VisitResult, VisitRunner};

#[cfg(feature = "jsbindings")]
mod js;

use std::collections::HashMap;
use std::sync::Arc;

use churn::Churn;
use fpstats::{FpStats, FAST_BLOCK};
use ledger::Evidence;
use local::{
    rank1, rank2_split, BgBasis, Cell, Column, Extent, Fit, LocalFilter, PatchGrid, Problem, Rect,
};
use noisecorr::NoiseCorr;
use reservoir::{mix, SharedFrames, Slot, Tile};
use shard::{InFlight, Op};

use crate::preprocess::flatten::GlowFlattener;
use crate::preprocess::gaussian::RecursiveGaussian;
use crate::preprocess::Dims;
use crate::trace::{
    BackgroundModel, Footprint, FrameTraces, Library, LibraryBuilder, LibraryConfig, LinearFilter,
    TraceError,
};

/// The optics' point-spread σ, px (UCLA Miniscope at its native
/// resolution): the scale light is smoothed at before its basins are
/// traced, so a basin is not cut by single-pixel noise.
const PSF_SIGMA_PX: f32 = 1.5;

/// How far the transient-band core test (`fastcore.rs`) acts. Each level
/// includes the ones before it; `Off` collects nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CoreTest {
    /// No transient-band statistics, no test.
    #[default]
    Off,
    /// Collect the statistics ([`SlowLoop::fast_report`]); no decision
    /// uses them.
    Report,
    /// Also grow supports on the measured noise of the transient band and
    /// trim each refined footprint to its held-out core's basin.
    Trim,
    /// Also delete cells past probation that have no held-out, soma-sized
    /// core (two consecutive failing checks).
    Delete,
}

impl CoreTest {
    /// Whether the transient-band statistics are collected.
    pub fn collects(self) -> bool {
        self != CoreTest::Off
    }
    /// Whether the test changes footprints.
    pub fn trims(self) -> bool {
        matches!(self, CoreTest::Trim | CoreTest::Delete)
    }
}

/// Settings of the slow loop. Pixel sizes follow the expected cell diameter.
#[derive(Debug, Clone, PartialEq)]
pub struct SlowLoopConfig {
    /// Expected soma diameter, px (the preprocessing's `cell_diameter_px`).
    pub cell_diameter_px: f32,
    /// Tile side, px.
    pub tile_px: usize,
    /// Extra margin stored around each tile, px. Supports have no upper
    /// bound, so a large cell near the core's edge can reach past its
    /// patch: the patch then sees it clipped, and reservoir refits leave
    /// it to the running statistics, which see all of it.
    pub margin_px: usize,
    /// Reservoir size: stored frames per tile (event plus random slots).
    /// Recall rises steeply with it up to about this many (measured at
    /// 600 x 600: 31 / 63 / 126 / 252 frames per tile gave recall .52 /
    /// .67 / .76 / .78 at 8 min), and a visit's cost grows with it.
    pub frames_per_tile: usize,
    /// Cap on the reservoir's bytes (event slots, shared random frames and
    /// probes). When `frames_per_tile` does not fit (large sensors), the
    /// slots per tile are cut until it does, and
    /// [`SlowLoop::reservoir_plan`] reports it.
    pub reservoir_max_bytes: usize,
    /// Share of each tile's slots that hold a uniform sample of all frames.
    pub random_share: f32,
    /// Event-slot priority halves every this many frames.
    pub event_half_life_frames: f32,
    /// One frame in this many is held out for testing.
    pub holdout_every: u32,
    /// Required held-out χ² improvement over a noise column, in standard
    /// deviations of that null.
    pub accept_z: f32,
    /// A held-out trace value counts as an event above this many σ.
    pub event_z: f32,
    /// Held-out events a new cell needs.
    pub min_events: u32,
    /// Trace correlation (fitting frames) above which a merge is tried.
    pub merge_corr: f32,
    /// Accepted adds per tile visit.
    pub max_adds_per_visit: usize,
    /// Rejected proposals per tile visit before moving on.
    pub max_rejects_per_visit: usize,
    /// Refine footprints on every n-th visit of a tile (0 = never).
    pub refine_every_visits: u32,
    /// Minimum frames between published library versions.
    pub commit_interval_frames: u64,
    /// Base cooldown of a rejected spot, frames.
    pub reject_cooldown_frames: u64,
    /// Fitting / held-out frames a tile needs before it is visited.
    pub min_fit_frames: usize,
    pub min_test_frames: usize,
    /// New slots that make a tile due for a visit.
    pub visit_after_slots: u32,
    /// Evidence ledger: a run of the trace above (below) its baseline counts
    /// as a transient (dip) when it peaks beyond `event_z` σ and lasts at
    /// least this many frames.
    pub event_frames: u32,
    /// Transients after birth that move a cell from probation to
    /// established (with dips below `dip_ratio` of them).
    pub establish_events: u32,
    /// A cell without a single transient this many frames after its birth
    /// is deleted: no evidence since its birth.
    pub probation_frames: u64,
    /// Keep test on probe frames (held-out frames after a cell's birth on
    /// which its fast-loop trace peaks beyond `event_z` σ): a probe passes
    /// when dropping the cell raises that frame's χ² by more than a noise
    /// column would by `keep_z` standard deviations (a smooth local bump is
    /// free in both arms, as in the add test).
    pub keep_z: f32,
    /// A cell is deleted once its failed probes reach `delete_fails` and
    /// outnumber its passes `fail_ratio` to one.
    pub delete_fails: u32,
    pub fail_ratio: f32,
    /// Probe frames stored per tile, and the minimum frames between two
    /// probes of one cell.
    pub probes_per_tile: usize,
    pub probe_gap_frames: u64,
    /// Running footprint statistics: half-life of the forgetting, frames.
    pub stats_half_life_frames: f32,
    /// Statistics disk = support radius plus this many cell diameters.
    pub stats_margin_cells: f32,
    /// A footprint estimated from the statistics is used once its peak
    /// pixel is this many standard errors above zero.
    pub stats_min_snr: f32,
    /// The support of a footprint estimated from the statistics reaches
    /// out to where its light is significant: each 1 px ring around the
    /// centre belongs to it while the ring's mean light is this many
    /// standard errors above zero (no size cap; never tighter than the
    /// seed rule, so bright cells take their full extent as the frames
    /// accumulate and dim ones keep at least their 2.5 half-widths).
    pub support_z: f32,
    /// A refinement is accepted when its per-frame held-out χ² gains are
    /// positive with a paired z (mean over standard error) above this...
    pub refine_z: f32,
    /// ...and an absorption (the best of several alternatives) above this.
    pub absorb_z: f32,
    /// An alternative competes with adding a candidate only when it
    /// explains at least this share of the candidate's held-out gain.
    pub absorb_share: f32,
    /// ...and changes the whitened filtered footprint by at least this
    /// share of its norm (smaller changes are not proposed).
    pub refine_min_change: f32,
    /// Cells are refined from the reservoir (while their running statistics
    /// are not yet precise) only this many frames after their birth.
    pub reservoir_refine_frames: u64,
    /// Try splitting cells on every n-th visit of a tile (0 = never).
    pub split_every_visits: u32,
    /// A pair of cells is kept apart when separating them beats the best
    /// single-cell alternative on held-out frames by this many standard
    /// deviations of the noise-column null (v2: `accept_z`). Below
    /// `accept_z`, this is hysteresis: a cell that once passed the add test
    /// is not removed on the next unlucky set of test frames.
    pub merge_z: f32,
    /// Compare a merge with the pair refitted on the same fitting frames
    /// (not only with their current footprints). The merged arm is a fresh
    /// fit; without this, two distinct cells whose footprints lag the data
    /// lose to one fresh footprint and are merged (v3 churn on real data).
    pub merge_refit_pair: bool,
    /// The refitted pair is the baseline only when its weaker part
    /// carries at least this share of the stronger one's fitted energy
    /// (and the two supports overlap by less than half).
    pub merge_refit_min_share: f32,
    /// Measure the spatial correlation of the noise and widen every noise
    /// null by the variance it adds at cell scale (see `noisecorr.rs`):
    /// sub-pixel motion correction resamples the noise, and a test that
    /// assumes independent pixels then takes noise blobs for cells. No
    /// effect on white noise.
    pub noise_corr: bool,
    /// In the add test, both arms get the spatial gradients of the nearest
    /// cells as free nuisance terms: residual registration error moves a
    /// bright cell's light by a fraction of a pixel, which leaves a dipole
    /// beside it that is not a new cell.
    pub shift_nuisance: bool,
    /// In the add test, the candidate's held-out trace is also checked
    /// against the nearby cells' traces *jointly*: when a combination of
    /// them explains it (adjusted R² ≥ `merge_corr`²) it is their leftover
    /// light (truncated tails, high-pass moats, footprints that lag motion),
    /// not a new cell, even when no single neighbour's trace follows it.
    /// Off by default: it lifts precision on the minisim recordings but
    /// costs Minian-matched cells on the workshop recording, where
    /// neighbouring cells co-fire in population events
    /// (tools/cala-diagnostics/LEFTOVER_LIGHT.md).
    pub joint_neighbours: bool,
    /// Transient-band core test (see [`CoreTest`]). Off by default: bright
    /// compact cells can still fail its noise half (their own light
    /// dominates every contrast window of a small statistics disk).
    pub core_test: CoreTest,
    /// Trim every refined footprint to the significant, single-peaked
    /// basin of its light (`basin_trim_from`, seeded at the footprint's
    /// peak). Off by default.
    pub basin_trim: bool,
    /// Classification of adds (new / re-add / churned) for the QC; does not
    /// change any decision.
    pub churn: ChurnConfig,
    pub library: LibraryConfig,
    /// Background model of the published libraries.
    pub background: BackgroundModel,
    pub seed: u64,
}

impl Default for SlowLoopConfig {
    fn default() -> SlowLoopConfig {
        SlowLoopConfig {
            cell_diameter_px: 10.0,
            tile_px: 64,
            margin_px: 24,
            frames_per_tile: 128,
            reservoir_max_bytes: 1536 << 20,
            random_share: 0.3,
            event_half_life_frames: 2000.0,
            holdout_every: 3,
            accept_z: 5.0,
            event_z: 4.0,
            min_events: 2,
            merge_corr: 0.6,
            max_adds_per_visit: 4,
            max_rejects_per_visit: 3,
            refine_every_visits: 2,
            commit_interval_frames: 100,
            reject_cooldown_frames: 400,
            min_fit_frames: 16,
            min_test_frames: 8,
            visit_after_slots: 6,
            event_frames: 3,
            establish_events: 3,
            probation_frames: 4800,
            keep_z: 2.0,
            delete_fails: 4,
            fail_ratio: 4.0,
            probes_per_tile: 8,
            probe_gap_frames: 100,
            stats_half_life_frames: 6000.0,
            stats_margin_cells: 0.4,
            stats_min_snr: 4.0,
            support_z: 2.0,
            refine_z: 3.0,
            absorb_z: 3.0,
            absorb_share: 0.8,
            refine_min_change: 0.03,
            reservoir_refine_frames: 2400,
            split_every_visits: 4,
            merge_refit_pair: true,
            merge_refit_min_share: 0.1,
            merge_z: 2.0,
            noise_corr: true,
            shift_nuisance: true,
            joint_neighbours: false,
            core_test: CoreTest::Off,
            basin_trim: false,
            churn: ChurnConfig::default(),
            library: LibraryConfig::default(),
            background: BackgroundModel::Ring {
                inner_px: 12.0,
                outer_px: 20.0,
            },
            seed: 0,
        }
    }
}

impl SlowLoopConfig {
    /// The held-out split: slow-loop frame `frame` (0 = the first frame
    /// the loop observes) is a test frame. A hash of the frame index and
    /// `seed`, one frame in `holdout_every`. Public so evaluation code can
    /// score exactly the frames the slow loop never fitted on.
    pub fn is_test(&self, frame: u64) -> bool {
        mix(frame ^ self.seed.rotate_left(17)).is_multiple_of(u64::from(self.holdout_every))
    }

    pub fn validate(&self) -> Result<(), TraceError> {
        self.library.validate()?;
        let ok = self.cell_diameter_px.is_finite()
            && self.cell_diameter_px >= 2.0
            && self.tile_px >= 8
            && self.frames_per_tile >= 2
            && self.random_share >= 0.0
            && self.random_share < 1.0
            && self.event_half_life_frames > 0.0
            && self.holdout_every >= 2
            && self.accept_z.is_finite()
            && self.event_z.is_finite()
            && self.merge_corr.is_finite()
            && self.min_fit_frames >= 2
            && self.min_test_frames >= 2
            && self.event_frames >= 1
            && self.keep_z.is_finite()
            && self.fail_ratio.is_finite()
            && self.delete_fails >= 1
            && self.stats_half_life_frames > 0.0
            && self.stats_margin_cells.is_finite()
            && self.stats_margin_cells >= 0.0
            && self.stats_min_snr.is_finite()
            && self.support_z.is_finite()
            && self.refine_z.is_finite()
            && self.absorb_z.is_finite()
            && self.absorb_share.is_finite()
            && self.refine_min_change.is_finite()
            && self.merge_z.is_finite()
            && self.churn.is_valid();
        if ok {
            Ok(())
        } else {
            Err(TraceError::InvalidConfig(format!("{self:?}")))
        }
    }
}

/// How the reservoir is sized ([`SlowLoop::reservoir_plan`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReservoirPlan {
    /// Stored frames per tile (event plus random slots), and the split.
    pub frames_per_tile: usize,
    pub event_slots: usize,
    pub random_slots: usize,
    /// The configured target (`SlowLoopConfig::frames_per_tile`).
    pub target_frames_per_tile: usize,
    /// Bytes with every slot full (event patches, shared random frames and
    /// probes), and the cap.
    pub capacity_bytes: usize,
    pub max_bytes: usize,
    /// Fewest stored frames per tile with which a visit can run (enough
    /// fitting and held-out frames on average).
    pub min_frames_per_tile: usize,
}

impl ReservoirPlan {
    /// The byte cap cut the frames per tile below the target.
    pub fn limited(&self) -> bool {
        self.frames_per_tile < self.target_frames_per_tile
    }

    /// A message for the user when the cap limits discovery.
    pub fn warning(&self) -> Option<String> {
        if !self.limited() {
            return None;
        }
        let mb = self.max_bytes as f64 / f64::from(1u32 << 20);
        // Below about 1.5 times the minimum, few tiles ever hold enough
        // frames of both kinds for a visit.
        Some(if self.frames_per_tile * 2 < self.min_frames_per_tile * 3 {
            format!(
                "Cell discovery is starved: the reservoir memory cap ({mb:.0} MB) leaves \
                 {} frames per tile for this frame size, and a tile visit needs about {}. \
                 Few or no cells will be found.",
                self.frames_per_tile,
                self.min_frames_per_tile * 3 / 2
            )
        } else {
            format!(
                "The reservoir memory cap ({mb:.0} MB) limits the slow loop to {} frames \
                 per tile for this frame size (target {}): cells are found more slowly.",
                self.frames_per_tile, self.target_frames_per_tile
            )
        })
    }
}

/// Counters for diagnostics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SlowStats {
    pub visits: u64,
    pub proposals: u64,
    pub adds: u64,
    pub rejects: u64,
    pub merges: u64,
    pub merge_tests: u64,
    pub refines: u64,
    pub commits: u64,
    /// Cells deleted for lack of support.
    pub deletes: u64,
    /// Proposals rejected by the held-out pre-test (before any fit).
    pub pretest_rejects: u64,
    /// Merge tests that kept the two cells apart.
    pub merge_rejects: u64,
    /// Work spent loading frames, refining, merging and adding.
    pub work_load: u64,
    pub work_refine: u64,
    pub work_merge: u64,
    pub work_add: u64,
    pub work_keep: u64,
    /// Probe frames tested, how many of those tests failed, and how many
    /// were inconclusive (too little of the cell's light on the probe to
    /// tell it from the free local bump; counted neither way).
    pub keep_tests: u64,
    pub keep_fails: u64,
    pub keep_inconclusive: u64,
    /// Candidates taken up by growing an existing cell, cells split, and
    /// split tests.
    pub absorbs: u64,
    pub splits: u64,
    pub split_tests: u64,
    pub work_split: u64,
    pub work_stats: u64,
}

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
    /// DIAG counters of the basin rule: calls, light removed (sum of fractions), second significant peaks.
    pub basin_diag: (u64, f64, u64),
    /// Transient-band estimate (on the statistics disk), its
    /// measured standard error and the held-out core (if one passed) for
    /// the next `finish_cell`.
    fast_tmp: Option<(Vec<f32>, f64, Option<(f32, f32)>)>,
    /// Last core check per cell (frame) and consecutive failed checks;
    /// counters: proposals with a passing core, without one, cells deleted.
    fast_checked: HashMap<u64, u64>,
    fast_strikes: HashMap<u64, u32>,
    pub fast_diag: (u64, u64, u64),
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
    /// Running footprint statistics per published cell, by id, and the
    /// current weight of a new frame (grows by the inverse forgetting
    /// factor; renormalised).
    fpstats: HashMap<u64, FpStats>,
    stats_w: f32,
    stats_gamma: f32,
    rbuf: Vec<f32>,
    /// Pairs whose merge was rejected: `(id, id, until_frame)`.
    merge_rejected: Vec<(u64, u64, u64)>,
    /// Pairs the keep tests found redundant, to be merge-tested regardless
    /// of their trace correlation.
    forced: Vec<(u64, u64)>,
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
}

/// Record an edit for the slow loop a visit was run for (`shard.rs`).
macro_rules! journal {
    ($s:ident, $op:expr) => {
        if let Some(j) = $s.journal.as_mut() {
            j.push($op);
        }
    };
}

/// Per library slot: the residual weights `h / σ²` on the support, the
/// coordinate normaliser `1 / Σ h² / σ²`, `Σ h / σ²` (for the ring level)
/// and the coordinate's noise σ.
#[derive(Default)]
struct LedgerProj {
    version: u64,
    start: Vec<usize>,
    pix: Vec<u32>,
    w: Vec<f32>,
    inv_n: Vec<f32>,
    wsum: Vec<f32>,
    floor: Vec<f32>,
    /// Tile whose core holds the slot's centre (`usize::MAX`: none).
    tile: Vec<usize>,
}

/// What a residual candidate became.
enum Outcome {
    Add(Cell, f32),
    /// The candidate, the existing cell re-estimated to take it up, margin.
    Absorb(Cell, Cell, u64, f32),
    Reject,
}

/// Held-out verdict on a residual candidate (`SlowLoop::assess_add`).
struct AddVerdict {
    /// χ² gain of adding it (units of the variance the model leaves).
    gain: f64,
    /// It passes the event and neighbour-trace checks.
    ok: bool,
    /// Best competing explanation: its index, gain, and the paired z of
    /// its per-frame gains (`paired_z`).
    alt: Option<(usize, f64, f64)>,
    /// Noise-column null of the test frames (mean, sd).
    null: (f64, f64),
}

/// A tile's model solved on its fitting frames.
struct Solved {
    base: Problem,
    fits: Vec<Fit>,
    resid: Vec<Vec<f32>>,
}

/// A tile's frames loaded for a visit.
struct Frames {
    y: Vec<Vec<f32>>,
    proj: Vec<(Vec<f64>, f64)>,
    /// Frame index of each.
    idx: Vec<u64>,
}

impl Frames {
    fn len(&self) -> usize {
        self.y.len()
    }
}

/// The whitened frame `z = y / σ` and the whitened residual `(y − model) /
/// σ` block-averaged 2 x 2 into `coarse` (non-finite `y` count as 0). Two
/// passes per row, so the first vectorises: `z` and the quarter residual
/// `q`, then each coarse pixel adds its two `q` in the order a single
/// pixel-by-pixel loop would (`(c + q0) + q1`, the upper row first), so the
/// result is bit-identical to that loop.
fn whiten(
    frame: &[f32],
    inv_sigma: &[f32],
    model: &[f32],
    z: &mut [f32],
    coarse: &mut [f32],
    w: usize,
    q: &mut Vec<f32>,
) {
    let cw = w.div_ceil(2);
    q.resize(w, 0.0);
    coarse.iter_mut().for_each(|v| *v = 0.0);
    let rows = frame
        .chunks_exact(w)
        .zip(inv_sigma.chunks_exact(w))
        .zip(model.chunks_exact(w).zip(z.chunks_exact_mut(w)));
    for (row, ((yr, sr), (mr, zr))) in rows.enumerate() {
        for ((((zv, qv), &y), &s), &m) in zr.iter_mut().zip(q.iter_mut()).zip(yr).zip(sr).zip(mr) {
            let fin = y.is_finite();
            *zv = if fin { y * s } else { 0.0 };
            *qv = 0.25 * if fin { (y - m) * s } else { 0.0 };
        }
        let crow = &mut coarse[(row / 2) * cw..(row / 2) * cw + cw];
        let (pairs, tail) = q.as_chunks::<2>();
        for (c, p) in crow.iter_mut().zip(pairs) {
            *c = (*c + p[0]) + p[1];
        }
        if let Some(&t) = tail.first() {
            crow[cw - 1] += t;
        }
    }
}

/// Slots per tile: `cfg.frames_per_tile`, or fewer if that does not fit in
/// `cfg.reservoir_max_bytes` (event patches per tile, random frames once
/// over `shared`, and the probes).
fn plan_reservoir(cfg: &SlowLoopConfig, tiles: &[Tile], shared: Rect) -> ReservoirPlan {
    let patch_bytes: usize = tiles.iter().map(|t| t.rect.len() * 2).sum();
    let frame_bytes = shared.len() * 2;
    let split = |n: usize| {
        let random = ((n as f32 * cfg.random_share).round() as usize).max(1);
        (n.saturating_sub(random).max(1), random)
    };
    let bytes = |n: usize| {
        let (e, r) = split(n);
        (e + cfg.probes_per_tile) * patch_bytes + r * frame_bytes
    };
    let target = cfg.frames_per_tile;
    let mut n = target;
    while n > 2 && bytes(n) > cfg.reservoir_max_bytes {
        n -= 1;
    }
    let (event_slots, random_slots) = split(n);
    let k = cfg.holdout_every as usize;
    ReservoirPlan {
        frames_per_tile: event_slots + random_slots,
        event_slots,
        random_slots,
        target_frames_per_tile: target,
        capacity_bytes: bytes(n),
        max_bytes: cfg.reservoir_max_bytes,
        min_frames_per_tile: (cfg.min_test_frames * k)
            .max((cfg.min_fit_frames * k).div_ceil(k - 1)),
    }
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
            psf: LocalFilter::new(PSF_SIGMA_PX),
            basin_diag: (0, 0.0, 0),
            fast_tmp: None,
            fast_checked: HashMap::new(),
            fast_strikes: HashMap::new(),
            fast_diag: (0, 0, 0),
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
            fpstats: HashMap::new(),
            stats_w: 1.0,
            stats_gamma: 0.5f32.powf(1.0 / cfg.stats_half_life_frames),
            rbuf: Vec::new(),
            merge_rejected: Vec::new(),
            forced: Vec::new(),
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
            cfg,
        };
        s.set_noise(noise)?;
        Ok(s)
    }

    /// Replace the noise map (σ per pixel). New patches are whitened with it.
    pub fn set_noise(&mut self, noise: Vec<f32>) -> Result<(), TraceError> {
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

    /// `(id, frame it entered the working set)` of every working-set cell.
    pub fn births(&self) -> Vec<(u64, u64)> {
        self.cells.iter().map(|c| (c.id, c.born)).collect()
    }

    /// Evidence on every working-set cell (cells not yet published have
    /// `frames == 0`).
    /// DIAG: measured / assumed variance of ring means of the running
    /// statistics' footprint estimate: rings (1 px) around the statistics
    /// disk centre; per ring the mean split-half difference against its
    /// white-noise standard error; the median z² over the rings over the
    /// median of χ²₁ (0.455), at least 1. `None` with fewer than 4 rings.
    fn ring_inflation(&self, id: u64) -> Option<f64> {
        let st = self.fpstats.get(&id)?;
        let (ha, hb, sa, sb) = st.halves()?;
        let var0 = sa * sa + sb * sb;
        if !(var0 > 0.0) || !var0.is_finite() {
            return None;
        }
        let w = self.dims.width;
        let mut rs: Vec<(f64, usize)> = Vec::new();
        for (i, &g) in st.pix.iter().enumerate() {
            let (y, x) = ((g as usize / w) as f32, (g as usize % w) as f32);
            let k = ((y - st.center.0).powi(2) + (x - st.center.1).powi(2)).sqrt() as usize;
            if k >= rs.len() {
                rs.resize(k + 1, (0.0, 0));
            }
            let is = f64::from(self.inv_sigma[g as usize]);
            rs[k].0 += f64::from(ha[i] - hb[i]) * is;
            rs[k].1 += 1;
        }
        let mut z2: Vec<f64> = rs
            .iter()
            .filter(|r| r.1 >= 4)
            .map(|&(sd, m)| (sd / m as f64).powi(2) / (var0 / m as f64))
            .collect();
        if z2.len() < 4 {
            return None;
        }
        z2.sort_by(f64::total_cmp);
        Some((z2[z2.len() / 2] / 0.455).max(1.0))
    }

    /// DIAG split-half report of the running statistics on each cell's
    /// support (whitened): id, support px, split-half correlation, empirical
    /// / assumed per-pixel noise variance, mean squared ring-mean z of the
    /// half difference (1 for spatially white noise), mean light in units
    /// of its assumed standard error, rings (support radius).
    pub fn split_report(&self) -> String {
        let mut out = String::from("id\tn\tr_split\tnoise_ratio\tring_z2\tsig_z\tradius\n");
        for c in &self.cells {
            let Some(st) = self.fpstats.get(&c.id) else {
                continue;
            };
            let Some((ha, hb, sa, sb)) = st.halves() else {
                continue;
            };
            let mut a = Vec::new();
            let mut b = Vec::new();
            let mut rk = Vec::new();
            for &g in &c.pix {
                if let Ok(i) = st.pix.binary_search(&g) {
                    let is = self.inv_sigma[g as usize];
                    a.push(f64::from(ha[i] * is));
                    b.push(f64::from(hb[i] * is));
                    let (y, x) = (
                        (g as usize / self.dims.width) as f32,
                        (g as usize % self.dims.width) as f32,
                    );
                    rk.push(((y - c.center.0).powi(2) + (x - c.center.1).powi(2)).sqrt() as usize);
                }
            }
            let n = a.len();
            if n < 10 {
                continue;
            }
            let ma = a.iter().sum::<f64>() / n as f64;
            let mb = b.iter().sum::<f64>() / n as f64;
            let (mut sab, mut saa, mut sbb, mut sdd) = (0.0, 0.0, 0.0, 0.0);
            for i in 0..n {
                sab += (a[i] - ma) * (b[i] - mb);
                saa += (a[i] - ma).powi(2);
                sbb += (b[i] - mb).powi(2);
                sdd += (a[i] - b[i]).powi(2);
            }
            let r = sab / (saa * sbb).sqrt().max(1e-30);
            let var0 = sa * sa + sb * sb;
            let ratio = sdd / n as f64 / var0;
            let kmax = rk.iter().copied().max().unwrap_or(0);
            let mut rs = vec![(0.0f64, 0usize); kmax + 1];
            for i in 0..n {
                rs[rk[i]].0 += a[i] - b[i];
                rs[rk[i]].1 += 1;
            }
            let (mut z2, mut nr) = (0.0, 0usize);
            for &(sd, m) in &rs {
                if m >= 4 {
                    let zz = sd / m as f64 / (var0 / m as f64).sqrt();
                    z2 += zz * zz;
                    nr += 1;
                }
            }
            let se = st.std_err();
            let sig = (ma + mb) / 2.0 / se;
            let _ = std::fmt::Write::write_fmt(
                &mut out,
                format_args!(
                    "{}\t{n}\t{r:.4}\t{ratio:.3}\t{:.3}\t{sig:.3}\t{:.1}\n",
                    c.id,
                    if nr > 0 { z2 / nr as f64 } else { f64::NAN },
                    c.radius
                ),
            );
        }
        out
    }

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
            ) {
                self.next_id = self.next_id.max(fp.id + 1);
                self.cells.push(c);
                kept += 1;
            }
        }
        self.pending = true;
        Ok(kept)
    }

    /// Feed one preprocessed frame and the fast loop's result for it.
    /// `lib` must be the library that produced `traces`.
    pub fn observe(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
    ) -> Result<(), TraceError> {
        let n_px = self.dims.pixels();
        let scale = self.score_residual(frame, lib, traces)?;
        self.work += (n_px * 4 + self.coarse.len() * 30) as u64;
        if self.cfg.noise_corr {
            self.work += self.ncorr.push(&self.z, &self.fov, self.dims);
            self.rho = self.ncorr.rho(self.cfg.cell_diameter_px);
        }
        self.update_ledger(frame, lib, traces);
        let frame_idx = self.frames;
        let test = self.is_test(frame_idx);
        if !test {
            self.update_fpstats(frame, lib, traces);
        }
        // Random slots: one uniform sample for every tile.
        self.rng = mix(self.rng);
        let w = self.dims.width;
        let took = self
            .shared
            .offer(&self.z, w, frame_idx, test, self.cap_random, self.rng);
        for ti in 0..self.tiles.len() {
            let score = self.tile_score(ti, scale);
            let tile = &mut self.tiles[ti];
            tile.offer(
                &self.z,
                w,
                frame_idx,
                score,
                test,
                self.cap_events,
                self.ln_decay,
            );
            if let Some(j) = took {
                tile.set_random(j, frame_idx, test);
            }
        }
        if test {
            self.take_probes(lib, frame_idx);
        }
        self.frames += 1;
        Ok(())
    }

    /// Whitened frame (`z`) and the residual blurred to cell scale
    /// (`coarse_blur`), with the residual's robust noise scale.
    fn score_residual(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
    ) -> Result<f32, TraceError> {
        let n_px = self.dims.pixels();
        crate::trace::check_len("frame", n_px, frame.len())?;
        if lib.dims() != self.dims || traces.library_version != lib.version() {
            return Err(TraceError::Incompatible(
                "traces do not come from this library / frame size".into(),
            ));
        }
        let bg = match lib.background_model() {
            BackgroundModel::Basis(_) => Some(traces.background.as_slice()),
            _ => None,
        };
        lib.render(&traces.traces, bg, &mut self.model)?;
        // Whitened frame (stored) and whitened residual (scored).
        whiten(
            frame,
            &self.inv_sigma,
            &self.model,
            &mut self.z,
            &mut self.coarse,
            self.dims.width,
            &mut self.qrow,
        );
        self.coarse_gauss
            .blur(&self.coarse, &mut self.coarse_blur)
            .map_err(TraceError::Preprocess)?;
        // Robust noise scale of the blurred residual (cells are sparse).
        self.sample.clear();
        for (i, &v) in self.coarse_blur.iter().enumerate().step_by(3) {
            if self.coarse_fov[i] {
                self.sample.push(v.abs());
            }
        }
        let scale = if self.sample.is_empty() {
            1.0
        } else {
            let mid = self.sample.len() / 2;
            let (_, m, _) = self
                .sample
                .select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
            (1.4826 * *m).max(1e-6)
        };
        Ok(scale)
    }

    /// Each tile's score for `frame` (the largest excursion of the blurred
    /// residual in its core, in robust noise units): what `observe` ranks
    /// reservoir frames by. Read-only for the slow loop's state, so a
    /// driver can use it to decide which frames to forward.
    pub fn tile_scores(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
    ) -> Result<Vec<f32>, TraceError> {
        let scale = self.score_residual(frame, lib, traces)?;
        Ok((0..self.tiles.len())
            .map(|ti| self.tile_score(ti, scale))
            .collect())
    }

    fn tile_score(&self, ti: usize, scale: f32) -> f32 {
        let cw = self.coarse_dims.width;
        let core = self.tiles[ti].core;
        let mut best = f32::MIN;
        for y in (core.y0 / 2)..(core.y0 + core.h).div_ceil(2) {
            for x in (core.x0 / 2)..(core.x0 + core.w).div_ceil(2) {
                let i = y * cw + x;
                if self.coarse_fov[i] {
                    best = best.max(self.coarse_blur[i]);
                }
            }
        }
        (best / scale).max(0.0)
    }

    /// Ledger update for one frame: each published cell's unconstrained
    /// coordinate `u = c + hᵀ Σ⁻¹ (y − model − level) / hᵀ Σ⁻¹ h`.
    fn update_ledger(&mut self, frame: &[f32], lib: &Library, traces: &FrameTraces) {
        if self.lproj.version != lib.version() {
            self.build_lproj(lib);
        }
        let ring = matches!(lib.background_model(), BackgroundModel::Ring { .. })
            && traces.background.len() == lib.len();
        let (ez, ef) = (self.cfg.event_z, self.cfg.event_frames);
        let lp = &self.lproj;
        let mut work = 0u64;
        for (slot, &id) in lib.ids().iter().enumerate() {
            let (a, b) = (lp.start[slot], lp.start[slot + 1]);
            let mut g = 0.0f32;
            for k in a..b {
                let p = lp.pix[k] as usize;
                let y = frame[p];
                if y.is_finite() {
                    g += lp.w[k] * (y - self.model[p]);
                }
            }
            work += (b - a) as u64 * 2;
            let level = if ring { traces.background[slot] } else { 0.0 };
            let u = traces.traces[slot] + (g - level * lp.wsum[slot]) * lp.inv_n[slot];
            self.ledger
                .entry(id)
                .or_insert_with(Evidence::new)
                .update(u, lp.floor[slot], ez, ef);
        }
        self.work += work;
    }

    /// Running footprint statistics for one fitting frame (see `fpstats.rs`).
    fn update_fpstats(&mut self, frame: &[f32], lib: &Library, traces: &FrameTraces) {
        if self.fpstats.len() > lib.len() {
            let ids: std::collections::HashSet<u64> = lib.ids().iter().copied().collect();
            self.fpstats.retain(|id, _| ids.contains(id));
            self.fast_checked.retain(|id, _| ids.contains(id));
            self.fast_strikes.retain(|id, _| ids.contains(id));
        }
        self.stats_w /= self.stats_gamma;
        if self.stats_w > 1024.0 {
            let f = 1.0 / self.stats_w;
            self.fpstats.values_mut().for_each(|s| s.scale(f));
            self.stats_w = 1.0;
        }
        let w = self.stats_w;
        let ring = matches!(lib.background_model(), BackgroundModel::Ring { .. })
            && traces.background.len() == lib.len();
        let margin = self.cfg.stats_margin_cells * self.cfg.cell_diameter_px;
        let (width, height) = (self.dims.width, self.dims.height);
        let version = lib.version();
        let mut work = 0u64;
        for (slot, &id) in lib.ids().iter().enumerate() {
            let (center, radius) = lib.support(slot);
            let want = radius + margin;
            let st = self.fpstats.entry(id).or_insert_with(|| {
                FpStats::new(
                    center,
                    want,
                    width,
                    height,
                    &self.fov,
                    self.cfg.core_test.collects(),
                )
            });
            if !st.covers(center, radius) {
                *st = st.moved(center, want, width, height, &self.fov);
            }
            if st.version != version {
                // The column the fast loop used: exact on the support, the
                // moat's block means off it.
                let (spix, sval) = lib.filtered(slot);
                let (lb, lv) = lib.lowpass(slot);
                st.col = st
                    .pix
                    .iter()
                    .map(|p| match spix.binary_search(p) {
                        Ok(k) => sval[k],
                        Err(_) if lib.block_px() > 0 => {
                            let b = lib.block_of(*p) as u32;
                            lb.binary_search(&b).map_or(0.0, |k| -lv[k])
                        }
                        Err(_) => 0.0,
                    })
                    .collect();
                st.version = version;
            }
            let c = traces.traces[slot];
            let level = if ring { traces.background[slot] } else { 0.0 };
            self.rbuf.clear();
            self.rbuf.extend(st.pix.iter().map(|&p| {
                let y = frame[p as usize];
                if y.is_finite() {
                    y - self.model[p as usize] - level
                } else {
                    0.0
                }
            }));
            if c != 0.0 {
                for (r, &v) in self.rbuf.iter_mut().zip(&st.col) {
                    *r += v * c;
                }
            }
            st.push(&self.rbuf, c, w);
            work += st.pix.len() as u64 * 3;
        }
        self.work += work;
        self.stats.work_stats += work;
    }

    /// Held-out frame `frame`: store it as a probe in the tile of each cell
    /// that is in a confirmed transient of its ledger trace (the first
    /// held-out frame of that transient; at most once per
    /// `probe_gap_frames` per cell).
    fn take_probes(&mut self, lib: &Library, frame: u64) {
        let gap = self.cfg.probe_gap_frames;
        let mut per_tile: Vec<(usize, u64)> = Vec::new();
        for (slot, &id) in lib.ids().iter().enumerate() {
            let Some(ev) = self.ledger.get_mut(&id) else {
                continue;
            };
            if !ev.probe_ready || ev.last_probe.is_some_and(|f| f + gap > frame) {
                continue;
            }
            ev.probe_ready = false;
            ev.run_probed = true;
            let ti = self.lproj.tile[slot];
            if ti == usize::MAX {
                continue;
            }
            ev.last_probe = Some(frame);
            per_tile.push((ti, id));
        }
        per_tile.sort_unstable();
        let w = self.dims.width;
        let cap = self.cfg.probes_per_tile;
        let mut i = 0;
        while i < per_tile.len() {
            let ti = per_tile[i].0;
            let mut cells = Vec::new();
            while i < per_tile.len() && per_tile[i].0 == ti {
                cells.push(per_tile[i].1);
                i += 1;
            }
            #[cfg(feature = "diagnostics")]
            diagnostics::probe(self, frame, ti, &cells);
            self.tiles[ti].probe(&self.z, w, frame, cells, cap);
            self.work += self.tiles[ti].rect.len() as u64;
        }
    }

    fn build_lproj(&mut self, lib: &Library) {
        let mut lp = LedgerProj {
            version: lib.version(),
            start: vec![0],
            ..LedgerProj::default()
        };
        for slot in 0..lib.len() {
            let (pix, h) = lib.filtered(slot);
            let (mut n, mut ws) = (0.0f64, 0.0f64);
            for (&p, &v) in pix.iter().zip(h) {
                let is = self.inv_sigma[p as usize];
                let w = v * is * is;
                lp.pix.push(p);
                lp.w.push(w);
                n += f64::from(v * w);
                ws += f64::from(w);
            }
            lp.start.push(lp.pix.len());
            let inv_n = if n > 0.0 { (1.0 / n) as f32 } else { 0.0 };
            lp.inv_n.push(inv_n);
            lp.wsum.push(ws as f32);
            lp.floor.push(inv_n.sqrt());
            let (c, _) = lib.support(slot);
            lp.tile.push(self.tile_of(c.0, c.1).unwrap_or(usize::MAX));
        }
        // Ledger entries of cells no longer published (deleted, merged);
        // cells whose column changed (a new coordinate scale) warm up again.
        let ids: std::collections::HashSet<u64> = lib.ids().iter().copied().collect();
        self.ledger.retain(|id, _| ids.contains(id));
        let old: HashMap<u64, f32> = self
            .lproj_ids
            .iter()
            .copied()
            .zip(self.lproj.inv_n.iter().copied())
            .collect();
        for (slot, &id) in lib.ids().iter().enumerate() {
            if let (Some(&o), Some(ev)) = (old.get(&id), self.ledger.get_mut(&id)) {
                let n = lp.inv_n[slot];
                if (n - o).abs() > 1e-3 * o.abs().max(1e-12) {
                    ev.rewarm();
                }
            }
        }
        self.lproj_ids = lib.ids().to_vec();
        self.lproj = lp;
    }

    /// Keep / delete decisions from the ledger (cheap; runs every step).
    ///
    /// * established: `establish_events` transients after birth, and
    ///   probes passed at least as often as failed;
    /// * deleted as unsupported (any status: a cell is never beyond
    ///   re-testing): failed probes reach `delete_fails` and outnumber the
    ///   passed ones `fail_ratio` to one;
    /// * deleted as silent: no transient at all within `probation_frames`
    ///   of its birth (times one plus the number of earlier deletions at
    ///   its spot);
    /// * mostly redundant with one neighbour: the pair is merge-tested.
    fn prune(&mut self) {
        let cfg = &self.cfg;
        let mut doomed = Vec::new();
        for c in &self.cells {
            let Some(ev) = self.ledger.get_mut(&c.id) else {
                continue;
            };
            let unsupported = ev.fails >= cfg.delete_fails
                && ev.fails as f32 >= cfg.fail_ratio * ev.passes as f32;
            ev.established =
                ev.transients >= cfg.establish_events && ev.passes >= ev.fails && !unsupported;
            if ev.redundant >= 2 && ev.redundant > ev.passes {
                if let Some(p) = ev.partner {
                    let pair = (c.id.min(p), c.id.max(p));
                    if !self.forced.contains(&pair) {
                        self.forced.push(pair);
                    }
                }
            }
            if self.inflight.iter().any(|f| f.ids.contains(&c.id)) {
                continue;
            }
            let lives = u64::from(self.lives.get(&c.id).copied().unwrap_or(0));
            if unsupported {
                doomed.push((c.id, DeleteReason::Unsupported));
            } else if ev.transients == 0 && ev.frames >= cfg.probation_frames * (1 + lives) {
                doomed.push((c.id, DeleteReason::Silent));
            }
        }
        // A cell past probation without a held-out, soma-sized core in its
        // transient-band light is not a cell (`fastcore.rs`). Checked once
        // every two blocks, so each check sees new data in both the groups
        // that choose the core and the ones that test it.
        if self.cfg.core_test == CoreTest::Delete {
            let thr = f64::from(self.cfg.keep_z);
            let mut check = Vec::new();
            for c in &self.cells {
                let Some(ev) = self.ledger.get(&c.id) else {
                    continue;
                };
                if ev.frames < self.cfg.probation_frames
                    || doomed.iter().any(|d| d.0 == c.id)
                    || self.inflight.iter().any(|f| f.ids.contains(&c.id))
                {
                    continue;
                }
                if self
                    .fast_checked
                    .get(&c.id)
                    .is_some_and(|&f| self.frames < f + 2 * FAST_BLOCK)
                {
                    continue;
                }
                check.push((c.id, c.center, c.radius));
            }
            for (id, center, radius) in check {
                self.fast_checked.insert(id, self.frames);
                // Two consecutive failing checks before a deletion: one
                // unlucky check of a real cell must not remove it.
                if let Some(fi) = self.fast_info(id, center, radius) {
                    if !fi.core_ok(thr) {
                        let strikes = self.fast_strikes.entry(id).or_insert(0);
                        *strikes += 1;
                        if *strikes >= 2 {
                            doomed.push((id, DeleteReason::NoCore));
                            self.fast_diag.2 += 1;
                        }
                    } else {
                        self.fast_strikes.remove(&id);
                    }
                }
            }
        }
        for (id, reason) in doomed {
            self.delete(id, reason);
        }
        let live: std::collections::HashSet<u64> = self.cells.iter().map(|c| c.id).collect();
        self.forced
            .retain(|p| live.contains(&p.0) && live.contains(&p.1));
    }

    fn delete(&mut self, id: u64, reason: DeleteReason) {
        let Some(i) = self.cells.iter().position(|c| c.id == id) else {
            return;
        };
        #[cfg(feature = "diagnostics")]
        diagnostics::delete(self, &self.cells[i], reason.as_str());
        let info = self.info(&self.cells[i]);
        let cell = self.cells.remove(i);
        self.ledger.remove(&id);
        self.lives.remove(&id);
        self.fast_checked.remove(&id);
        self.fast_strikes.remove(&id);
        self.deleted.push(DeletedCell {
            info,
            frame: self.frames,
            reason,
        });
        self.stats.deletes += 1;
        self.edits.deletes += 1;
        self.log(EditKind::Delete, id, 0, cell.center, 0.0);
        self.churn
            .on_delete(self.frames, id, cell.center, &cell.pix, &cell.filt);
        self.entomb(cell.center);
        self.pending = true;
        self.touch(cell.bbox);
    }

    /// Mark a spot where a cell was removed: nothing is added there for
    /// 4^k cooldowns after the k-th removal, and a new cell there needs
    /// held-out events from after it.
    fn entomb(&mut self, (cy, cx): (f32, f32)) {
        journal!(self, Op::Entomb(cy, cx));
        self.entomb_at((cy, cx));
    }

    fn entomb_at(&mut self, (cy, cx): (f32, f32)) {
        let now = self.frames;
        let d = self.cfg.cell_diameter_px;
        if let Some(ti) = self.tile_of(cy, cx) {
            let t = &mut self.tiles[ti];
            match t
                .tombs
                .iter_mut()
                .find(|r| (r.0 - cy).powi(2) + (r.1 - cx).powi(2) <= (0.5 * d).powi(2))
            {
                Some(r) => {
                    *r = (cy, cx, now, r.3 + 1);
                }
                None => t.tombs.push((cy, cx, now, 1)),
            }
            self.reject_at(ti, cy, cx);
        }
    }

    /// The tile whose core holds `(y, x)`.
    fn tile_of(&self, y: f32, x: f32) -> Option<usize> {
        let (y, x) = (y.max(0.0) as usize, x.max(0.0) as usize);
        self.tiles.iter().position(|t| t.core.local(y, x).is_some())
    }

    /// The deletion record near `(y, x)`: `(frame, deletions)`.
    fn tomb(&self, ti: usize, y: f32, x: f32) -> Option<(u64, u32)> {
        let d = self.cfg.cell_diameter_px;
        self.tiles[ti]
            .tombs
            .iter()
            .find(|r| (r.0 - y).powi(2) + (r.1 - x).powi(2) <= (0.5 * d).powi(2))
            .map(|r| (r.2, r.3))
    }

    /// Whether slow-loop frame `frame` (0 = the first frame observed) is
    /// held out: never used to fit footprints, only to test edits. See
    /// [`SlowLoopConfig::is_test`].
    pub fn is_test(&self, frame: u64) -> bool {
        self.cfg.is_test(frame)
    }

    /// Spend about `budget` work units (multiply-adds; ~1e9/s native) on
    /// tile visits, carrying any overrun into the next call. Returns a new
    /// library when edits were published; swap it into the fast loop.
    pub fn step(&mut self, budget: u64) -> Result<Option<Arc<Library>>, TraceError> {
        self.prune();
        self.credit = self.credit.saturating_add(budget as i64);
        while self.credit > 0 {
            let Some(ti) = self.next_tile() else {
                // Nothing to do: idle budget is not banked.
                self.credit = 0;
                break;
            };
            let w0 = self.work;
            self.visit(ti)?;
            self.credit -= (self.work - w0) as i64;
        }
        if self.pending && self.frames >= self.last_commit + self.cfg.commit_interval_frames {
            return self.publish().map(Some);
        }
        Ok(None)
    }

    /// Publish any accepted edits now (end of pass 1).
    pub fn finalize(&mut self) -> Result<Arc<Library>, TraceError> {
        if self.pending || self.published.is_none() {
            return self.publish();
        }
        Ok(self.published.clone().expect("published"))
    }

    fn next_tile(&self) -> Option<usize> {
        let mut best: Option<(usize, u32)> = None;
        for (i, t) in self.tiles.iter().enumerate() {
            if t.fresh < self.cfg.visit_after_slots {
                continue;
            }
            if best.is_none_or(|(_, f)| t.fresh > f) {
                best = Some((i, t.fresh));
            }
        }
        best.map(|b| b.0)
    }

    fn publish(&mut self) -> Result<Arc<Library>, TraceError> {
        let mut b = LibraryBuilder::new(self.dims)
            .fov(self.fov.clone())
            .noise(self.noise.clone())
            .background(self.cfg.background.clone());
        // Only edited cells are filtered again.
        let mut changed = self.cells.len();
        if let Some(prev) = &self.published {
            b = b.reuse(prev.clone());
            changed = self
                .cells
                .iter()
                .filter(|c| {
                    prev.slot(c.id)
                        .is_none_or(|s| prev.unfiltered(s).1 != c.raw.as_slice())
                })
                .count();
        }
        let support: usize = self.cells.iter().map(|c| c.pix.len()).sum();
        for c in &self.cells {
            b.push_disk(c.footprint(self.dims), c.center, c.radius);
        }
        let lib = b.build(&mut self.flattener)?;
        // The working set takes the exact filtered columns.
        let w = self.dims.width;
        let mut cells = Vec::with_capacity(lib.len());
        let born: std::collections::HashMap<u64, u64> =
            self.cells.iter().map(|c| (c.id, c.born)).collect();
        for slot in 0..lib.len() {
            let (center, radius) = lib.support(slot);
            let (pix, raw) = lib.unfiltered(slot);
            let (_, filt) = lib.filtered(slot);
            let (low_blk, low) = lib.lowpass(slot);
            let bbox = Rect::around(center.0, center.1, radius, self.dims);
            debug_assert!(pix
                .iter()
                .all(|&g| bbox.local(g as usize / w, g as usize % w).is_some()));
            cells.push(Cell {
                id: lib.ids()[slot],
                center,
                radius,
                bbox,
                pix: pix.to_vec(),
                raw: raw.to_vec(),
                filt: filt.to_vec(),
                low_blk: low_blk.to_vec(),
                low: low.to_vec(),
                born: born.get(&lib.ids()[slot]).copied().unwrap_or(0),
            });
        }
        // Filtering the edited cells (full-frame passes, many cells per
        // pass) and assembling the solve terms.
        self.work +=
            (self.dims.pixels() * 40) as u64 * (1 + changed as u64 / 50) + support as u64 * 40;
        self.cells = cells;
        let lib = Arc::new(lib);
        self.published = Some(lib.clone());
        self.pending = false;
        self.last_commit = self.frames;
        self.stats.commits += 1;
        self.edits.commits += 1;
        Ok(lib)
    }

    // ---- tile visits ------------------------------------------------------

    fn load(&mut self, ti: usize, test: bool) -> Frames {
        let ids: Vec<(bool, usize)> = self.tiles[ti]
            .slots()
            .into_iter()
            .filter(|&s| self.tiles[ti].slot(s).test == test)
            .collect();
        let bg = self.bgs[ti].as_ref().expect("basis");
        let mut y = Vec::with_capacity(ids.len());
        let mut proj = Vec::with_capacity(ids.len());
        let mut idx = Vec::with_capacity(ids.len());
        for s in ids {
            let mut v = Vec::new();
            self.tiles[ti].slot_values(s, &self.shared, &mut v);
            let slot: &mut Slot = self.tiles[ti].slot_mut(s);
            idx.push(slot.frame);
            if slot.proj.is_none() {
                slot.proj = Some(bg.project(&v));
                self.work += (v.len() * (bg.k + 1)) as u64;
            }
            proj.push(slot.proj.clone().expect("set"));
            y.push(v);
        }
        Frames { y, proj, idx }
    }

    /// The moat grid and whitening of a patch.
    fn grid(&self, rect: Rect) -> Arc<PatchGrid> {
        Arc::new(PatchGrid::new(
            rect,
            self.dims,
            &self.inv_sigma,
            &self.fov,
            self.filter.moat().map_or(0, |m| m.0),
        ))
    }

    /// Columns of the cells whose supports meet `rect` (their moats too,
    /// clipped to the patch; cells that reach it only with their moat are
    /// left to the bump background).
    fn columns(&self, rect: Rect, skip: &[u64], extra: &[&Cell]) -> Vec<Column> {
        let w = self.dims.width;
        let grid = self.grid(rect);
        let mut cols: Vec<Column> = self
            .cells
            .iter()
            .filter(|c| c.bbox.intersects(&rect) && !skip.contains(&c.id))
            .map(|c| Column::of(c, &grid, w))
            .filter(|c| !c.pix.is_empty())
            .collect();
        for c in extra {
            cols.push(Column::of(c, &grid, w));
        }
        cols
    }

    fn solve_all(&mut self, pr: &Problem, fr: &Frames) -> Vec<Fit> {
        self.solve_with(pr, &fr.y, &fr.proj)
    }

    fn solve_with(&mut self, pr: &Problem, ys: &[Vec<f32>], proj: &[(Vec<f64>, f64)]) -> Vec<Fit> {
        let mut work = 0;
        let fits = ys
            .iter()
            .zip(proj)
            .map(|(y, (qb, yy))| pr.solve(y, qb, *yy, &mut work))
            .collect();
        self.work += work;
        fits
    }

    fn residuals(&mut self, pr: &Problem, fr: &Frames, fits: &[Fit], ti: usize) -> Vec<Vec<f32>> {
        let bg = self.bgs[ti].as_ref().expect("basis");
        let mut work = 0;
        let out =
            fr.y.iter()
                .zip(fits)
                .map(|(y, f)| {
                    let mut r = vec![0.0f32; y.len()];
                    pr.residual(y, f, bg, &mut r, &mut work);
                    r
                })
                .collect();
        self.work += work;
        out
    }

    fn problem(&mut self, ti: usize, cols: Vec<Column>) -> Problem {
        let bg = self.bgs[ti].as_ref().expect("basis");
        let mut work = 0;
        let pr = Problem::new(cols, bg, self.tiles[ti].rect.len(), &mut work);
        self.work += work;
        pr
    }

    /// Held-out χ² improvement a column of noise would give: mean and sd.
    /// What a column of pure noise buys over `n` frames: mean and sd of the
    /// χ² gain (white noise: 0.5 and 1.25 per frame), scaled by the noise's
    /// cell-scale variance inflation.
    fn null(&self, n: usize) -> (f64, f64) {
        let r = f64::from(self.rho);
        (0.5 * n as f64 * r, (1.25 * n as f64).sqrt() * r)
    }

    /// Trace noise of coordinate `i` of `pr` (white-noise σ times the
    /// inflation of correlated noise).
    fn coord_noise(&self, pr: &Problem, i: usize) -> f32 {
        pr.coord_sigma(i) * self.rho.sqrt()
    }

    fn visit(&mut self, ti: usize) -> Result<(), TraceError> {
        self.visit_begin(ti);
        self.visit_body(ti)
    }

    /// The bookkeeping of a visit (on the slow loop that owns the tile).
    fn visit_begin(&mut self, ti: usize) {
        self.stats.visits += 1;
        self.tiles[ti].fresh = 0;
        self.tiles[ti].last_visit = self.frames;
        self.tile_visits[ti] += 1;
        let now = self.frames;
        self.tiles[ti]
            .rejected
            .retain(|r| r.2 > now || r.3 > 0 && r.2 + 4 * self.cfg.reject_cooldown_frames > now);
    }

    /// The tests and edits of a visit (here, or in a [`VisitRunner`]).
    fn visit_body(&mut self, ti: usize) -> Result<(), TraceError> {
        if self.bgs[ti].is_none() {
            self.bgs[ti] = Some(BgBasis::new(self.tiles[ti].rect));
        }
        let w0 = self.work;
        self.keep_tests(ti);
        self.stats.work_keep += self.work - w0;
        let w0 = self.work;
        let fit_fr = self.load(ti, false);
        let test_fr = self.load(ti, true);
        self.stats.work_load += self.work - w0;
        if fit_fr.len() < self.cfg.min_fit_frames || test_fr.len() < self.cfg.min_test_frames {
            return Ok(());
        }
        let refine = self.cfg.refine_every_visits > 0
            && self.tile_visits[ti].is_multiple_of(self.cfg.refine_every_visits);
        // One solve of the tile's model serves all three edits; refinements
        // and merges made on this visit leave its residual slightly stale for
        // the add proposals, but every edit is tested on the current model.
        let w0 = self.work;
        let mut solved = self.solve_tile(ti, &fit_fr);
        self.stats.work_load += self.work - w0;
        let split = self.cfg.split_every_visits > 0
            && self.tile_visits[ti].is_multiple_of(self.cfg.split_every_visits);
        if split {
            let w0 = self.work;
            if self.split(ti, &solved, &test_fr) {
                solved = self.solve_tile(ti, &fit_fr);
            }
            self.stats.work_split += self.work - w0;
        }
        if refine {
            let w0 = self.work;
            self.refine(ti, &solved, &test_fr);
            self.stats.work_refine += self.work - w0;
        }
        let w0 = self.work;
        self.merge(ti, &fit_fr, &test_fr);
        self.stats.work_merge += self.work - w0;
        let w0 = self.work;
        let Solved { base, fits, resid } = solved;
        self.add(ti, resid, &base, &fits, &test_fr);
        self.stats.work_add += self.work - w0;
        Ok(())
    }

    /// Mark the tiles whose patch overlaps `bbox` as due for a visit.
    fn touch(&mut self, bbox: Rect) {
        journal!(self, Op::Touch(bbox));
        let due = self.cfg.visit_after_slots;
        for t in self.tiles.iter_mut() {
            if t.rect.intersects(&bbox) {
                t.fresh = t.fresh.max(due);
            }
        }
    }

    fn total_chi2(fits: &[Fit]) -> f64 {
        fits.iter().map(|f| f.chi2).sum()
    }

    fn add(
        &mut self,
        ti: usize,
        resid: Vec<Vec<f32>>,
        base: &Problem,
        fits: &[Fit],
        test_fr: &Frames,
    ) {
        let rect = self.tiles[ti].rect;
        let core = self.tiles[ti].core;
        let d = self.cfg.cell_diameter_px;
        let (mut adds, mut rejects) = (0, 0);
        // Residual maps of the fitting frames, computed once; an accepted
        // cell's signal is subtracted from them in place.
        let mut maps: Option<(Vec<Vec<f32>>, Vec<Vec<f32>>, f32, Vec<f32>)> = None;
        let mut resid = Some(resid);
        let mut test_maps: Option<(Vec<Vec<f32>>, f32)> = None;
        while adds < self.cfg.max_adds_per_visit && rejects < self.cfg.max_rejects_per_visit {
            if maps.is_none() {
                let resid = resid.take().expect("first pass");
                // Cell-scale blur of each residual (over the core only), then
                // a robust noise scale.
                let mut blurred = Vec::with_capacity(resid.len());
                for r in &resid {
                    let mut b = vec![0.0f32; r.len()];
                    self.blur_window(rect, core, r, &mut b);
                    blurred.push(b);
                }
                let mut sample: Vec<f32> = blurred
                    .iter()
                    .flat_map(|b| {
                        (0..core.h).step_by(3).flat_map(move |y| {
                            let row = (core.y0 - rect.y0 + y) * rect.w + core.x0 - rect.x0;
                            b[row..row + core.w].iter().step_by(3).map(|v| v.abs())
                        })
                    })
                    .collect();
                let mid = sample.len() / 2;
                let scale = if sample.is_empty() {
                    1.0
                } else {
                    1.4826 * *sample.select_nth_unstable_by(mid, |a, b| a.total_cmp(b)).1
                }
                .max(1e-6);
                let mut score = vec![0.0f32; core.len()];
                self.score_window(rect, core, core, &blurred, scale, &mut score);
                maps = Some((resid, blurred, scale, score));
            }
            let (resid, blurred, scale, score) = maps.as_ref().expect("computed");
            let scale = *scale;
            let mut best: Option<(usize, usize, f32)> = None;
            let now = self.frames;
            for gy in core.y0..core.y0 + core.h {
                for gx in core.x0..core.x0 + core.w {
                    if self.fov[gy * self.dims.width + gx] == 0 {
                        continue;
                    }
                    let (fy, fx) = (gy as f32, gx as f32);
                    let s = score[(gy - core.y0) * core.w + gx - core.x0];
                    if best.is_some_and(|b| s <= b.2) {
                        continue;
                    }
                    let quiet = self.cfg.reject_cooldown_frames;
                    let suppressed = self.tiles[ti].rejected.iter().any(|r| {
                        r.2 > now && (r.0 - fy).powi(2) + (r.1 - fx).powi(2) <= (0.5 * d).powi(2)
                    }) || self.tiles[ti].tombs.iter().any(|r| {
                        // After the k-th deletion at a spot, nothing is
                        // added there for 4^k cooldowns (no add / delete
                        // oscillation).
                        r.2 + quiet * (1u64 << (2 * r.3.min(6))) > now
                            && (r.0 - fy).powi(2) + (r.1 - fx).powi(2) <= (0.5 * d).powi(2)
                    }) || self.cells.iter().any(|c| {
                        (c.center.0 - fy).powi(2) + (c.center.1 - fx).powi(2) <= (0.5 * d).powi(2)
                    });
                    if !suppressed {
                        best = Some((gy, gx, s));
                    }
                }
            }
            let ev = self.cfg.event_z - 2.0;
            let Some((py, px, s)) = best else { break };
            if s < self.cfg.min_events as f32 * ev * ev {
                break;
            }
            self.stats.proposals += 1;
            let l = rect.local(py, px).expect("inside");
            if !self.pretest(ti, test_fr, &mut test_maps, l) {
                self.stats.pretest_rejects += 1;
                self.stats.rejects += 1;
                self.reject(ti, py as f32, px as f32);
                rejects += 1;
                continue;
            }
            let mut c0: Vec<f32> = blurred
                .iter()
                .map(|b| (b[l] / scale - 2.0).max(0.0))
                .collect();
            let id = self.next_id;
            let cand = self.fit_new(id, rect, resid, &mut c0, (py as f32, px as f32));
            let mut lives = 0;
            // Model comparison on held-out frames: a new cell, or an existing
            // cell re-estimated to take the residual up (grown, or with the
            // candidate merged in). A new cell costs a column, so it must
            // beat the best alternative by the add margin (that is what an
            // extra column of pure noise would buy, plus `accept_z` sd); an
            // alternative costs nothing extra but must itself improve on the
            // current model.
            let mut outcome = Outcome::Reject;
            if let Some(cell) = cand {
                let tomb = self
                    .tile_of(cell.center.0, cell.center.1)
                    .and_then(|t| self.tomb(t, cell.center.0, cell.center.1));
                lives = tomb.map_or(0, |t| t.1);
                let (mut alts, kinds) = {
                    let (resid, ..) = maps.as_ref().expect("computed");
                    self.alternatives(ti, &cell, &c0, resid, base, fits)
                };
                let v = self.assess_add(ti, test_fr, &cell, tomb.map(|t| t.0), &alts);
                let (m, sd) = v.null;
                let alt_gain = v.alt.map_or(0.0, |a| a.1.max(0.0));
                let margin = v.gain - alt_gain - m;
                let pen = f64::from(self.cfg.accept_z) * sd;
                // An alternative that explains only part of the new cell's
                // gain is a neighbour stretched over a distinct cell (on the
                // minisim recordings, letting it win cost half the recall):
                // the candidate is then added if it passes the add test on
                // its own. Only an alternative that explains most of it
                // (`absorb_share`) holds the add to the stricter margin.
                let distinct = alt_gain < f64::from(self.cfg.absorb_share) * v.gain;
                if v.ok && (margin > pen || distinct && v.gain - m > pen) {
                    outcome = Outcome::Add(cell, (margin / sd) as f32);
                } else if let Some((k, g, z)) = v.alt {
                    // The best of several alternatives, chosen on these
                    // frames: it needs a larger paired z than a single
                    // refinement does.
                    if g > 0.0 && z > f64::from(self.cfg.absorb_z) {
                        let alt = alts.swap_remove(k);
                        outcome = Outcome::Absorb(cell, alt, kinds[k], z as f32);
                    }
                }
            }
            let taken = match outcome {
                Outcome::Add(mut cell, margin) => {
                    cell.born = self.frames;
                    self.edits.adds += 1;
                    let nb = self.nearest(cell.center.0, cell.center.1, cell.id);
                    self.log(EditKind::Add, cell.id, nb, cell.center, margin);
                    self.churn
                        .on_add(self.frames, cell.id, cell.center, &cell.pix, &cell.filt);
                    journal!(self, Op::ChurnAdd(cell.clone()));
                    if lives > 0 {
                        self.lives.insert(cell.id, lives);
                        journal!(self, Op::LivesInsert(cell.id, lives));
                    }
                    self.next_id += 1;
                    self.stats.adds += 1;
                    self.cells.push(cell.clone());
                    journal!(self, Op::Push(cell.clone()));
                    cell
                }
                Outcome::Absorb(cell, alt, kind, margin) => {
                    // The existing cell takes the residual up; the spot is not
                    // proposed again for a cooldown (doubling with each time).
                    self.stats.absorbs += 1;
                    self.stats.refines += 1;
                    self.edits.absorbs += 1;
                    self.edits.refines += 1;
                    self.log(EditKind::Absorb, alt.id, kind, alt.center, margin);
                    self.touch(alt.bbox);
                    if let Some(ci) = self.cells.iter().position(|c| c.id == alt.id) {
                        journal!(self, Op::Replace(alt.id, alt.clone()));
                        self.cells[ci] = alt;
                    }
                    self.reject(ti, py as f32, px as f32);
                    cell
                }
                Outcome::Reject => {
                    self.stats.rejects += 1;
                    self.reject(ti, py as f32, px as f32);
                    rejects += 1;
                    continue;
                }
            };
            // Blank the explained signal from the residual maps (the
            // candidate's least-squares trace per frame), so the same signal
            // is not proposed again; neighbours are re-solved on the next
            // visit.
            let bbox = taken.bbox;
            let col = Column::of(&taken, &self.grid(rect), self.dims.width);
            let (resid, blurred, scale, score) = maps.as_mut().expect("computed");
            let cc: f32 = col.norm2().max(1e-12);
            for r in resid.iter_mut() {
                let c = (col.dot(r) / cc).max(0.0);
                col.add_to(r, -c);
            }
            let m = (3.0 * self.detect_sigma()).ceil() as usize;
            let win = clip(
                Rect {
                    y0: bbox.y0.saturating_sub(m),
                    x0: bbox.x0.saturating_sub(m),
                    h: bbox.h + 2 * m,
                    w: bbox.w + 2 * m,
                },
                core,
            );
            let scale = *scale;
            for (r, b) in resid.iter().zip(blurred.iter_mut()) {
                self.blur_window(rect, win, r, b);
            }
            self.work += (resid.len() * col.pix.len() * 2) as u64;
            self.score_window(rect, core, win, blurred, scale, score);
            self.pending = true;
            self.touch(bbox);
            self.tiles[ti].fresh = 0;
            adds += 1;
        }
    }

    /// Cheap held-out pre-test of a proposal at patch pixel `l`: the
    /// current model's residual on the held-out frames, blurred to cell
    /// scale, must rise 2 σ above its robust level on at least `min_events`
    /// frames (the add test needs `min_events` held-out transients). The
    /// held-out maps are made once per visit; cells accepted later in the
    /// visit leave them stale, which only makes the pre-test more lenient.
    fn pretest(
        &mut self,
        ti: usize,
        test_fr: &Frames,
        maps: &mut Option<(Vec<Vec<f32>>, f32)>,
        l: usize,
    ) -> bool {
        if maps.is_none() {
            let rect = self.tiles[ti].rect;
            let core = self.tiles[ti].core;
            let cols = self.columns(rect, &[], &[]);
            let base = self.problem(ti, cols);
            let fits = self.solve_all(&base, test_fr);
            let resid = self.residuals(&base, test_fr, &fits, ti);
            let mut blurred = Vec::with_capacity(resid.len());
            for r in &resid {
                let mut b = vec![0.0f32; r.len()];
                self.blur_window(rect, core, r, &mut b);
                blurred.push(b);
            }
            let mut sample: Vec<f32> = blurred
                .iter()
                .flat_map(|b| {
                    (0..core.h).step_by(3).flat_map(move |y| {
                        let row = (core.y0 - rect.y0 + y) * rect.w + core.x0 - rect.x0;
                        b[row..row + core.w].iter().step_by(3).map(|v| v.abs())
                    })
                })
                .collect();
            let mid = sample.len() / 2;
            let scale = if sample.is_empty() {
                1.0
            } else {
                1.4826 * *sample.select_nth_unstable_by(mid, |a, b| a.total_cmp(b)).1
            }
            .max(1e-6);
            *maps = Some((blurred, scale));
        }
        let (blurred, scale) = maps.as_ref().expect("computed");
        let hits = blurred.iter().filter(|b| b[l] / scale > 2.0).count();
        hits >= self.cfg.min_events as usize
    }

    fn detect_sigma(&self) -> f32 {
        (self.cfg.cell_diameter_px / 4.0).max(0.6)
    }

    /// Cell-scale blur of the patch residual `r` into `out`, only over the
    /// window `win` (read with a 3 σ margin, so the window is exact).
    fn blur_window(&mut self, rect: Rect, win: Rect, r: &[f32], out: &mut [f32]) {
        let m = (3.0 * self.detect_sigma()).ceil() as usize;
        let full = Rect {
            y0: rect.y0,
            x0: rect.x0,
            h: rect.h,
            w: rect.w,
        };
        let canvas = clip(
            Rect {
                y0: win.y0.saturating_sub(m),
                x0: win.x0.saturating_sub(m),
                h: win.h + 2 * m,
                w: win.w + 2 * m,
            },
            full,
        );
        let mut src = vec![0.0f32; canvas.len()];
        for y in 0..canvas.h {
            let row = (canvas.y0 - rect.y0 + y) * rect.w + canvas.x0 - rect.x0;
            src[y * canvas.w..(y + 1) * canvas.w].copy_from_slice(&r[row..row + canvas.w]);
        }
        let mut dst = vec![0.0f32; canvas.len()];
        self.detect.blur(canvas.h, canvas.w, &src, &mut dst);
        for y in 0..win.h {
            let crow = (win.y0 - canvas.y0 + y) * canvas.w + win.x0 - canvas.x0;
            let row = (win.y0 - rect.y0 + y) * rect.w + win.x0 - rect.x0;
            out[row..row + win.w].copy_from_slice(&dst[crow..crow + win.w]);
        }
        self.work += (canvas.len() * 15) as u64;
    }

    /// Detection score (summed squared excursions above 2 σ over the fitting
    /// frames) of the core pixels inside `win`.
    fn score_window(
        &mut self,
        rect: Rect,
        core: Rect,
        win: Rect,
        blurred: &[Vec<f32>],
        scale: f32,
        score: &mut [f32],
    ) {
        for y in win.y0..win.y0 + win.h {
            for x in win.x0..win.x0 + win.w {
                let l = rect.local(y, x).expect("window inside rect");
                let mut s = 0.0f32;
                for b in blurred {
                    let z = b[l] / scale - 2.0;
                    if z > 0.0 {
                        s += z * z;
                    }
                }
                score[(y - core.y0) * core.w + x - core.x0] = s;
            }
        }
        self.work += (win.len() * blurred.len()) as u64;
    }

    fn reject(&mut self, ti: usize, y: f32, x: f32) {
        journal!(self, Op::Reject(ti, y, x));
        self.reject_at(ti, y, x);
    }

    fn reject_at(&mut self, ti: usize, y: f32, x: f32) {
        let now = self.frames;
        let d = self.cfg.cell_diameter_px;
        let base = self.cfg.reject_cooldown_frames;
        let t = &mut self.tiles[ti];
        if let Some(r) = t
            .rejected
            .iter_mut()
            .find(|r| (r.0 - y).powi(2) + (r.1 - x).powi(2) <= (0.5 * d).powi(2))
        {
            r.3 = (r.3 + 1).min(6);
            r.2 = now + base * (1 << r.3);
            r.0 = y;
            r.1 = x;
        } else {
            t.rejected.push((y, x, now + base, 0));
        }
    }

    /// Patch-local pixels of the disk `(cy, cx, r)` inside `rect`.
    fn disk(&self, rect: Rect, cy: f32, cx: f32, r: f32) -> Vec<u32> {
        let mut out = Vec::new();
        for y in 0..rect.h {
            for x in 0..rect.w {
                let (gy, gx) = (rect.y0 + y, rect.x0 + x);
                let (dy, dx) = (gy as f32 - cy, gx as f32 - cx);
                if dy * dy + dx * dx <= r * r && self.fov[gy * self.dims.width + gx] != 0 {
                    out.push((y * rect.w + x) as u32);
                }
            }
        }
        out
    }

    /// Unwhiten a filtered footprint `h` on patch pixels `dom`, invert the
    /// high-pass on a canvas around it, and make a cell.
    fn make_cell(
        &mut self,
        id: u64,
        rect: Rect,
        dom: &[u32],
        h: &[f32],
        start: Option<&Cell>,
    ) -> Option<Cell> {
        let w = self.dims.width;
        let (mut ymin, mut ymax, mut xmin, mut xmax) = (usize::MAX, 0, usize::MAX, 0);
        for &p in dom {
            let (y, x) = (rect.y0 + p as usize / rect.w, rect.x0 + p as usize % rect.w);
            ymin = ymin.min(y);
            ymax = ymax.max(y);
            xmin = xmin.min(x);
            xmax = xmax.max(x);
        }
        if dom.is_empty() {
            return None;
        }
        let canvas = Rect {
            y0: ymin,
            x0: xmin,
            h: ymax + 1 - ymin,
            w: xmax + 1 - xmin,
        };
        let mut target = vec![0.0f32; canvas.len()];
        let mut mask = vec![false; canvas.len()];
        for (&p, &v) in dom.iter().zip(h) {
            let (gy, gx) = (rect.y0 + p as usize / rect.w, rect.x0 + p as usize % rect.w);
            let l = canvas.local(gy, gx).expect("inside");
            target[l] = v * self.noise[gy * w + gx];
            mask[l] = true;
        }
        self.finish_cell(id, canvas, target, mask, start, None)
    }

    /// Make a cell from an unwhitened filtered footprint on global pixels.
    /// With `se` (the estimate's standard error per unit pixel noise), the
    /// support is measured: it reaches as far as the cell's light is
    /// significant ([`Self::significant_radius`]); without, it is seeded.
    fn make_cell_global(
        &mut self,
        id: u64,
        pix: &[u32],
        h: &[f32],
        start: Option<&Cell>,
        se: Option<f64>,
    ) -> Option<Cell> {
        let w = self.dims.width;
        if pix.is_empty() {
            return None;
        }
        let (mut ymin, mut ymax, mut xmin, mut xmax) = (usize::MAX, 0, usize::MAX, 0);
        for &g in pix {
            let (y, x) = (g as usize / w, g as usize % w);
            ymin = ymin.min(y);
            ymax = ymax.max(y);
            xmin = xmin.min(x);
            xmax = xmax.max(x);
        }
        let canvas = Rect {
            y0: ymin,
            x0: xmin,
            h: ymax + 1 - ymin,
            w: xmax + 1 - xmin,
        };
        let mut target = vec![0.0f32; canvas.len()];
        let mut mask = vec![false; canvas.len()];
        for (&g, &v) in pix.iter().zip(h) {
            let l = canvas
                .local(g as usize / w, g as usize % w)
                .expect("inside");
            target[l] = v;
            mask[l] = true;
        }
        self.finish_cell(id, canvas, target, mask, start, se)
    }

    /// Smooth the target at the optics' scale, invert the high-pass from
    /// `start` (or the target), normalise and cut to the support disk
    /// (measured with `se`, else seeded).
    fn finish_cell(
        &mut self,
        id: u64,
        canvas: Rect,
        mut target: Vec<f32>,
        mask: Vec<bool>,
        start: Option<&Cell>,
        se: Option<f64>,
    ) -> Option<Cell> {
        let w = self.dims.width;
        let unsmoothed = se.map(|_| target.clone());
        // Footprints are smooth at the scale of the optics (a tenth of a
        // cell diameter): a masked, normalised blur of the target removes the
        // pixel noise of a footprint estimated from a few dozen frames.
        {
            let m: Vec<f32> = mask.iter().map(|&b| if b { 1.0 } else { 0.0 }).collect();
            let tm: Vec<f32> = target.iter().zip(&m).map(|(t, m)| t * m).collect();
            let (mut bt, mut bm) = (vec![0.0f32; canvas.len()], vec![0.0f32; canvas.len()]);
            self.smooth.blur(canvas.h, canvas.w, &tm, &mut bt);
            self.smooth.blur(canvas.h, canvas.w, &m, &mut bm);
            for p in 0..canvas.len() {
                if mask[p] {
                    target[p] = bt[p] / bm[p].max(1e-6);
                }
            }
            self.work += (canvas.len() * 60) as u64;
        }
        let mut a: Vec<f32> = target.iter().map(|v| v.max(0.0)).collect();
        if let Some(c) = start {
            a.iter_mut().for_each(|v| *v = 0.0);
            for (&g, &v) in c.pix.iter().zip(&c.raw) {
                if let Some(l) = canvas.local(g as usize / w, g as usize % w) {
                    if mask[l] {
                        a[l] = v;
                    }
                }
            }
            // Keep the scale of the new target.
            let s: f32 = target.iter().zip(&a).map(|(t, v)| t * v).sum::<f32>()
                / a.iter().map(|v| v * v).sum::<f32>().max(1e-12);
            a.iter_mut().for_each(|v| *v *= s.max(0.0));
        }
        self.filter
            .invert(canvas.h, canvas.w, &mask, &target, &mut a, 40);
        self.work += (canvas.len() * 40 * 60) as u64;
        let peak = a.iter().copied().fold(0.0f32, f32::max);
        if !(peak > 0.0) {
            return None;
        }
        // The transient-band estimate on this canvas (the statistics disk's
        // pixels are this canvas's mask): its significant extent on the
        // measured noise, and the trim to the held-out core's basin.
        let fast = match (&self.fast_tmp, se) {
            (Some((hf, sef, core)), Some(_)) => {
                let mut c = vec![0.0f32; canvas.len()];
                let mut k = 0;
                for (p, &m) in mask.iter().enumerate() {
                    if m {
                        c[p] = hf.get(k).copied().unwrap_or(0.0);
                        k += 1;
                    }
                }
                (k == hf.len()).then_some((c, *sef, *core))
            }
            _ => None,
        };
        let extent = match (se, &unsmoothed, &fast) {
            (Some(_), Some(_), Some((hf, sef, _))) => self
                .significant_radius(canvas, hf, &mask, &a, *sef)
                .map_or(Extent::Seed, Extent::Radius),
            (Some(se), Some(h), None) => self
                .significant_radius(canvas, h, &mask, &a, se)
                .map_or(Extent::Seed, Extent::Radius),
            _ => Extent::Seed,
        };
        if let Some((hf, sef, core)) = &fast {
            let z = f64::from(self.cfg.support_z);
            let seed = core.and_then(|(y, x)| canvas.local(y.round() as usize, x.round() as usize));
            self.basin_trim_from(canvas, hf, &mask, &mut a, *sef, z, seed);
        }
        // Optional: keep only the significant, single-peaked basin of the
        // footprint's light (see `basin_trim`).
        if self.cfg.basin_trim {
            if let (Some(se), Some(h)) = (se, &unsmoothed) {
                let z = f64::from(self.cfg.support_z);
                self.basin_trim(canvas, h, &mask, &mut a, se, z);
            }
        }
        let peak = a.iter().copied().fold(0.0f32, f32::max);
        if !(peak > 0.0) {
            return None;
        }
        a.iter_mut().for_each(|v| *v /= peak);
        Cell::from_canvas(
            id,
            canvas,
            &a,
            self.dims,
            &self.fov,
            &self.cfg.library,
            extent,
            &mut self.filter,
        )
    }

    /// [`Self::basin_trim_from`] seeded at the peak
    /// of `a`, with the all-band estimate.
    fn basin_trim(
        &mut self,
        canvas: Rect,
        h: &[f32],
        mask: &[bool],
        a: &mut [f32],
        se: f64,
        z: f64,
    ) {
        self.basin_trim_from(canvas, h, mask, a, se, z, None);
    }

    /// Basin trim. The footprint's unfiltered light `u = h + L a` (as in
    /// [`Self::significant_radius`]) smoothed at the optics' PSF scale; its
    /// per-pixel standard error `se σ_p sqrt(Σ k²)`. Starting at `seed`
    /// (the held-out core; the peak of `a` without one), pixels join in
    /// order of decreasing `u` (4-connected) while `u` is `z` standard
    /// errors above zero and does not rise more than `z` standard errors
    /// above the lowest light on its way from the seed: one significant,
    /// single-peaked blob, which a gentle slope cannot carry into a
    /// neighbouring cell. Light outside it is set to zero; a neighbour cut
    /// off this way is left to the residual, where it is found as a cell
    /// of its own.
    #[allow(clippy::too_many_arguments)]
    fn basin_trim_from(
        &mut self,
        canvas: Rect,
        h: &[f32],
        mask: &[bool],
        a: &mut [f32],
        se: f64,
        z: f64,
        seed: Option<usize>,
    ) {
        let n = canvas.len();
        let (ch, cw) = (canvas.h, canvas.w);
        let mut low = vec![0.0f32; n];
        self.filter.blur(canvas.h, canvas.w, a, &mut low);
        let m: Vec<f32> = mask.iter().map(|&b| if b { 1.0 } else { 0.0 }).collect();
        let u0: Vec<f32> = (0..n)
            .map(|p| if mask[p] { h[p] + low[p] } else { 0.0 })
            .collect();
        let (mut bu, mut bm) = (vec![0.0f32; n], vec![0.0f32; n]);
        self.psf.blur(ch, cw, &u0, &mut bu);
        self.psf.blur(ch, cw, &m, &mut bm);
        let sp = f64::from(self.psf.sigma());
        let ksum2 = 1.0 / (4.0 * std::f64::consts::PI * sp * sp);
        let w = self.dims.width;
        let mut u = vec![f32::NEG_INFINITY; n];
        let mut tol = vec![0.0f32; n];
        for p in 0..n {
            if mask[p] && bm[p] > 1e-3 {
                u[p] = bu[p] / bm[p];
                let (gy, gx) = (canvas.y0 + p / cw, canvas.x0 + p % cw);
                // normalised blur near the mask edge averages fewer pixels
                let s = se
                    * f64::from(self.noise[gy * w + gx])
                    * (ksum2 / f64::from(bm[p]).max(ksum2)).sqrt();
                tol[p] = (z * s) as f32;
            }
        }
        // seed: the peak of a
        let p0 = seed.filter(|&p| mask[p] && u[p].is_finite()).or_else(|| {
            (0..n)
                .filter(|&p| mask[p])
                .max_by(|&i, &j| a[i].total_cmp(&a[j]))
        });
        let Some(p0) = p0 else { return };
        let mut inb = vec![false; n];
        let mut floor = vec![f32::NEG_INFINITY; n];
        let mut heap = std::collections::BinaryHeap::new();
        let key = |v: f32| (v * 1e6) as i64;
        inb[p0] = true;
        floor[p0] = u[p0];
        heap.push((key(u[p0]), p0));
        while let Some((_, p)) = heap.pop() {
            let (y, x) = (p / cw, p % cw);
            let nb = [
                (y > 0).then(|| p - cw),
                (y + 1 < ch).then(|| p + cw),
                (x > 0).then(|| p - 1),
                (x + 1 < cw).then(|| p + 1),
            ];
            for q in nb.into_iter().flatten() {
                if inb[q] || !mask[q] || !u[q].is_finite() {
                    continue;
                }
                if u[q] > tol[q] && u[q] <= floor[p] + tol[q] {
                    inb[q] = true;
                    floor[q] = floor[p].min(u[q]);
                    heap.push((key(u[q]), q));
                }
            }
        }
        let tot: f64 = a.iter().map(|&v| f64::from(v.max(0.0))).sum();
        let mut cut = 0.0f64;
        // a second significant peak outside the basin: a local max of u that is significant
        let mut second = false;
        for p in 0..n {
            if !inb[p] && mask[p] {
                cut += f64::from(a[p].max(0.0));
                a[p] = 0.0;
                if u[p].is_finite() && u[p] > 2.0 * tol[p] {
                    let (y, x) = (p / cw, p % cw);
                    let mut ismax = true;
                    for (dy, dx) in [
                        (-1i64, 0i64),
                        (1, 0),
                        (0, -1),
                        (0, 1),
                        (-1, -1),
                        (1, 1),
                        (-1, 1),
                        (1, -1),
                    ] {
                        let (yy, xx) = (y as i64 + dy, x as i64 + dx);
                        if yy >= 0
                            && xx >= 0
                            && (yy as usize) < ch
                            && (xx as usize) < cw
                            && u[yy as usize * cw + xx as usize] > u[p]
                        {
                            ismax = false;
                        }
                    }
                    second |= ismax;
                }
            }
        }
        self.basin_diag.0 += 1;
        self.basin_diag.1 += if tot > 0.0 { cut / tot } else { 0.0 };
        self.basin_diag.2 += u64::from(second);
        self.work += (n * 20) as u64;
    }

    /// How far a footprint's light is significant: rings (1 px wide) around
    /// the half-max centroid of `a`, outward while the ring's mean light is
    /// `support_z` standard errors above zero. The light is the unbiased
    /// `h + L a` (filtered estimate `h` plus the low-pass the high-pass took
    /// from the fitted footprint `a`, i.e. the unfiltered light with `h`'s
    /// noise), so the high-pass moat does not end the support early and the
    /// non-negativity of `a` does not bias it. `se` is `h`'s standard error
    /// per unit pixel noise. `None` when `a` is empty.
    fn significant_radius(
        &mut self,
        canvas: Rect,
        h: &[f32],
        mask: &[bool],
        a: &[f32],
        se: f64,
    ) -> Option<f32> {
        let fp = Footprint {
            id: 0,
            y0: canvas.y0,
            x0: canvas.x0,
            height: canvas.h,
            width: canvas.w,
            values: a.to_vec(),
        };
        let (cy, cx) = crate::trace::support_disk(&fp, self.dims).ok()?.center;
        let mut low = vec![0.0f32; canvas.len()];
        self.filter.blur(canvas.h, canvas.w, a, &mut low);
        self.work += (canvas.len() * 30) as u64;
        let w = self.dims.width;
        let mut sum: Vec<f64> = Vec::new();
        let mut var: Vec<f64> = Vec::new();
        for y in 0..canvas.h {
            for x in 0..canvas.w {
                let p = y * canvas.w + x;
                if !mask[p] {
                    continue;
                }
                let (gy, gx) = (canvas.y0 + y, canvas.x0 + x);
                let d = ((gy as f32 - cy).powi(2) + (gx as f32 - cx).powi(2)).sqrt();
                let k = d as usize;
                if k >= sum.len() {
                    sum.resize(k + 1, 0.0);
                    var.resize(k + 1, 0.0);
                }
                sum[k] += f64::from(h[p] + low[p]);
                let sd = se * f64::from(self.noise[gy * w + gx]);
                var[k] += sd * sd;
            }
        }
        let z = f64::from(self.cfg.support_z);
        let rings = sum
            .iter()
            .zip(&var)
            .take_while(|(&s, &v)| v > 0.0 && s > z * v.sqrt())
            .count();
        Some((rings as f32).max(self.cfg.library.min_support_px))
    }

    /// Rank-1 fit of a new cell on a small disk around `peak`.
    fn fit_new(
        &mut self,
        id: u64,
        rect: Rect,
        resid: &[Vec<f32>],
        c: &mut [f32],
        peak: (f32, f32),
    ) -> Option<Cell> {
        let r0 = 0.75 * self.cfg.cell_diameter_px;
        let refs: Vec<&[f32]> = resid.iter().map(|r| r.as_slice()).collect();
        let dom = self.disk(rect, peak.0, peak.1, r0);
        let h = rank1(&refs, &dom, c, 10, false);
        // Recentre on the half-max centroid and fit again.
        let hmax = h.iter().copied().fold(0.0f32, f32::max);
        if !(hmax > 0.0) {
            return None;
        }
        let (mut sw, mut sy, mut sx) = (0.0f32, 0.0f32, 0.0f32);
        for (&p, &v) in dom.iter().zip(&h) {
            if v >= 0.5 * hmax {
                sw += v;
                sy += v * (rect.y0 + p as usize / rect.w) as f32;
                sx += v * (rect.x0 + p as usize % rect.w) as f32;
            }
        }
        let (cy, cx) = (sy / sw, sx / sw);
        let dom = self.disk(rect, cy, cx, r0);
        let h = rank1(&refs, &dom, c, 10, false);
        self.work += (dom.len() * resid.len() * 42) as u64;
        self.make_cell(id, rect, &dom, &h, None)
    }

    /// The tile's background basis plus a free Gaussian bump (σ = one cell
    /// diameter) at `center`, and the frames' projections extended by it.
    fn with_bump(
        &self,
        ti: usize,
        center: (f32, f32),
        ys: &[Vec<f32>],
        proj: &[(Vec<f64>, f64)],
    ) -> (BgBasis, Vec<(Vec<f64>, f64)>) {
        let rect = self.tiles[ti].rect;
        let s = self.cfg.cell_diameter_px;
        let mut bump = vec![0.0f32; rect.len()];
        for y in 0..rect.h {
            for x in 0..rect.w {
                let dy = (rect.y0 + y) as f32 - center.0;
                let dx = (rect.x0 + x) as f32 - center.1;
                bump[y * rect.w + x] = (-(dy * dy + dx * dx) / (2.0 * s * s)).exp();
            }
        }
        let bg = self.bgs[ti].as_ref().expect("basis").with_extra(&bump);
        let proj = ys
            .iter()
            .zip(proj)
            .map(|(y, (q, yy))| {
                let mut q = q.clone();
                q.push(bump.iter().zip(y).map(|(&a, &b)| f64::from(a * b)).sum());
                (q, *yy)
            })
            .collect();
        (bg, proj)
    }

    /// `bg` plus the spatial derivatives of the (up to two) nearest cells
    /// whose support the candidate disk at `center` touches, as free
    /// nuisance maps: a registration error `δ` moves a cell's light by
    /// `(δ · ∇h + ½ δᵀ ∇∇h δ) c_t`, a dipole (and a blur) next to the cell
    /// that is not a new cell.
    fn with_shift_terms(
        &mut self,
        ti: usize,
        center: (f32, f32),
        mut bg: BgBasis,
        mut proj: Vec<(Vec<f64>, f64)>,
        ys: &[Vec<f32>],
    ) -> (BgBasis, Vec<(Vec<f64>, f64)>) {
        let rect = self.tiles[ti].rect;
        let r0 = 0.75 * self.cfg.cell_diameter_px;
        let mut nb: Vec<(f32, usize)> = self
            .cells
            .iter()
            .enumerate()
            .filter_map(|(i, c)| {
                let d = ((c.center.0 - center.0).powi(2) + (c.center.1 - center.1).powi(2)).sqrt();
                (d < c.radius + r0 && c.bbox.intersects(&rect)).then_some((d, i))
            })
            .collect();
        nb.sort_by(|a, b| a.0.total_cmp(&b.0));
        nb.truncate(2);
        let w = self.dims.width;
        let grid = self.grid(rect);
        for (_, i) in nb {
            let col = Column::of(&self.cells[i], &grid, w);
            if col.pix.is_empty() {
                continue;
            }
            // The support part only: the block-constant moat would put
            // steps (not a registration dipole) into the gradients.
            let mut dense = vec![0.0f32; rect.len()];
            for (&p, &v) in col.pix.iter().zip(&col.on_support()) {
                dense[p as usize] = v;
            }
            let n = rect.len();
            let (mut gy, mut gx) = (vec![0.0f32; n], vec![0.0f32; n]);
            let (mut gyy, mut gxx, mut gxy) = (vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]);
            for y in 0..rect.h {
                for x in 0..rect.w {
                    let at = |yy: usize, xx: usize| dense[yy * rect.w + xx];
                    let p = y * rect.w + x;
                    let (yu, yd) = (y.saturating_sub(1), (y + 1).min(rect.h - 1));
                    let (xl, xr) = (x.saturating_sub(1), (x + 1).min(rect.w - 1));
                    gy[p] = 0.5 * (at(yd, x) - at(yu, x));
                    gx[p] = 0.5 * (at(y, xr) - at(y, xl));
                    gyy[p] = at(yd, x) - 2.0 * at(y, x) + at(yu, x);
                    gxx[p] = at(y, xr) - 2.0 * at(y, x) + at(y, xl);
                    gxy[p] = 0.25 * (at(yd, xr) - at(yd, xl) - at(yu, xr) + at(yu, xl));
                }
            }
            // Second order (`½ δᵀ ∇∇h δ`): with the moat modelled, the
            // cell's amplitude is pinned by light the misregistration does
            // not change, so the core's blur by the registration error is
            // left over and must be a nuisance too.
            for g in [gy, gx, gyy, gxx, gxy] {
                bg = bg.with_extra(&g);
                for (y, (q, _)) in ys.iter().zip(proj.iter_mut()) {
                    q.push(g.iter().zip(y).map(|(&a, &b)| f64::from(a * b)).sum());
                }
                self.work += (rect.len() * (ys.len() + bg.k)) as u64;
            }
        }
        (bg, proj)
    }

    /// Keep tests on the tile's probe frames: for each cell a probe was
    /// taken for, does dropping the cell raise that held-out frame's χ²
    /// (in units of the variance the full model leaves, at least the noise)
    /// by more than a noise column would, by `keep_z` standard deviations?
    /// Both arms have the free local bump, so diffuse light (neuropil, a
    /// neighbour's halo) does not count. Each probe is used once.
    ///
    /// The bump (σ = one cell diameter, centred on the cell) overlaps the
    /// cell itself: on the minisim recordings it takes ~70% of a typical
    /// footprint's energy, so a weak transient of a real cell cannot pass.
    /// A probe that is not needed therefore only counts as a *fail* when
    /// the test had the power to pass it: when the cell's light on the
    /// probe, measured without the bump, would have passed by `keep_z`
    /// noise σ had it been shaped like the footprint. Otherwise (a weak
    /// transient, or none of the cell's light on the frame) the probe is
    /// inconclusive and counts neither way, so absence of evidence never
    /// accumulates as evidence against a cell.
    fn keep_tests(&mut self, ti: usize) {
        let probes = std::mem::take(&mut self.tiles[ti].probes);
        if probes.is_empty() {
            return;
        }
        if self.bgs[ti].is_none() {
            self.bgs[ti] = Some(BgBasis::new(self.tiles[ti].rect));
        }
        let rect = self.tiles[ti].rect;
        let mut ids: Vec<u64> = probes
            .iter()
            .flat_map(|p| p.cells.iter().copied())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        let n_px = self.fov_px(rect) as f64;
        let (m, sd) = self.null(1);
        let pass_at = m + f64::from(self.cfg.keep_z) * sd;
        // Noise σ of √(χ² gain) of one column (the noise inflation ρ).
        let sd_unit = f64::from(self.rho).sqrt();
        for id in ids {
            let Some(cell) = self.cells.iter().find(|c| c.id == id) else {
                continue;
            };
            let center = cell.center;
            let mut ys = Vec::new();
            let mut proj = Vec::new();
            {
                let bg = self.bgs[ti].as_ref().expect("basis");
                for p in probes.iter().filter(|p| p.cells.contains(&id)) {
                    let mut v = Vec::new();
                    p.slot.values(&mut v);
                    proj.push(bg.project(&v));
                    ys.push(v);
                }
                self.work += (ys.len() * rect.len() * (bg.k + 1)) as u64;
            }
            // The cell's amplitude on each probe without the bump: the light
            // a fail claims is not shaped like the cell.
            let plain = {
                let mut work = 0;
                let pr = Problem::new(
                    self.columns(rect, &[], &[]),
                    self.bgs[ti].as_ref().expect("basis"),
                    rect.len(),
                    &mut work,
                );
                self.work += work + (rect.len() * ys.len()) as u64;
                let k0 = pr.cols.iter().position(|c| c.id == id);
                let fits = self.solve_with(&pr, &ys, &proj);
                k0.map(|k| fits.iter().map(|f| f64::from(f.c[k])).collect::<Vec<_>>())
            };
            let (bg, proj) = self.with_bump(ti, center, &ys, &proj);
            let mut work = 0;
            let full = Problem::new(self.columns(rect, &[], &[]), &bg, rect.len(), &mut work);
            let red = Problem::new(self.columns(rect, &[id], &[]), &bg, rect.len(), &mut work);
            self.work += work + (rect.len() * (ys.len() + 2 * bg.k)) as u64;
            let f = self.solve_with(&full, &ys, &proj);
            let r = self.solve_with(&red, &ys, &proj);
            let dof = (n_px - (bg.k + full.len()) as f64).max(1.0);
            // Overlap of every other column with this cell's, normalised
            // by the cell's own energy: how much of the cell's signal an
            // increase of that neighbour's coefficient reproduces.
            let Some(ki) = full.cols.iter().position(|c| c.id == id) else {
                continue;
            };
            let dense = full.cols[ki].dense(rect.len());
            let ee: f32 = full.cols[ki].norm2().max(1e-12);
            let share: Vec<f32> = red.cols.iter().map(|c| c.dot(&dense) / ee).collect();
            #[cfg(feature = "diagnostics")]
            let diagnostic_before = self.ledger.get(&id).cloned();
            #[cfg(feature = "diagnostics")]
            let mut diagnostic_outcomes = Vec::new();
            let (mut pass, mut fail, mut redundant, mut inconclusive) = (0, 0, 0, 0);
            let mut partner: Option<(u64, f32)> = None;
            // χ² gain per unit amplitude² with the bump (the cell's energy
            // the bump and background cannot reproduce).
            let q_ii = full.q[ki * full.len() + ki].max(0.0);
            let power_at = pass_at.max(0.0).sqrt() + f64::from(self.cfg.keep_z) * sd_unit;
            for (j, (ff, rr)) in f.iter().zip(&r).enumerate() {
                let s2 = (ff.chi2 / dof).max(1.0);
                if (rr.chi2 - ff.chi2) / s2 > pass_at {
                    pass += 1;
                    #[cfg(feature = "diagnostics")]
                    diagnostic_outcomes.push(diagnostics::Outcome {
                        kind: "pass",
                        partner: 0,
                        took: 0.0,
                    });
                    continue;
                }
                // Not needed: did a neighbour take over at least half of
                // the cell's fitted signal?
                let ci = ff.c[ki];
                let mut best: Option<(u64, f32)> = None;
                for (j, c) in red.cols.iter().enumerate() {
                    let jf = full
                        .cols
                        .iter()
                        .position(|x| x.id == c.id)
                        .expect("same cells");
                    let took = (rr.c[j] - ff.c[jf]) * share[j];
                    if took > 0.5 * ci && best.is_none_or(|b| took > b.1) {
                        best = Some((c.id, took));
                    }
                }
                // Would a real cell with the light the probe shows (without
                // the bump) have passed? If not, the probe cannot tell.
                let c0 = plain.as_ref().map_or(0.0, |c| c[j].max(0.0));
                let powered = (c0 * c0 * q_ii / s2).sqrt() >= power_at;
                match best {
                    Some(b) if ci > 0.0 => {
                        redundant += 1;
                        partner = Some(b);
                        #[cfg(feature = "diagnostics")]
                        diagnostic_outcomes.push(diagnostics::Outcome {
                            kind: "redundant",
                            partner: b.0,
                            took: b.1,
                        });
                    }
                    _ if !powered => {
                        inconclusive += 1;
                        #[cfg(feature = "diagnostics")]
                        diagnostic_outcomes.push(diagnostics::Outcome {
                            kind: "inconclusive",
                            partner: best.map_or(0, |b| b.0),
                            took: best.map_or(0.0, |b| b.1),
                        });
                    }
                    _ => {
                        fail += 1;
                        #[cfg(feature = "diagnostics")]
                        diagnostic_outcomes.push(diagnostics::Outcome {
                            kind: "fail",
                            partner: best.map_or(0, |b| b.0),
                            took: best.map_or(0.0, |b| b.1),
                        });
                    }
                }
            }
            self.stats.keep_tests += (pass + fail + redundant + inconclusive) as u64;
            self.stats.keep_fails += fail as u64;
            self.stats.keep_inconclusive += inconclusive as u64;
            if let Some(ev) = self.ledger.get_mut(&id) {
                ev.passes += pass;
                ev.fails += fail;
                ev.redundant += redundant;
                if let Some(p) = partner {
                    ev.partner = Some(p.0);
                }
                journal!(
                    self,
                    Op::Keep {
                        id,
                        pass,
                        fail,
                        redundant,
                        partner: partner.map(|p| p.0),
                    }
                );
            }
            #[cfg(feature = "diagnostics")]
            diagnostics::keep(
                self,
                id,
                ti,
                &probes,
                &ys,
                &proj,
                &bg,
                &full,
                &red,
                &f,
                &r,
                &share,
                ki,
                dof,
                m,
                sd,
                pass_at,
                diagnostic_before.as_ref(),
                &diagnostic_outcomes,
            );
        }
    }

    /// Held-out test of adding `cell` to the tile's problem.
    ///
    /// Both arms get one extra free background term, a Gaussian of σ = one
    /// cell diameter centred on the candidate: broad local signal (scatter
    /// halo of the neighbours, neuropil, out-of-focus light) is explained
    /// without the candidate, so the candidate must explain *compact*
    /// signal (the patch's 3 x 3 bumps are too smooth to do this alone).
    ///
    /// Near a spot where a cell was deleted (`after` = the frame of the
    /// deletion), only held-out frames after the deletion count as events:
    /// a deleted cell comes back only on new evidence.
    ///
    /// `alts` are the competing explanations of the same residual (an
    /// existing cell's footprint re-estimated to take it up, same id): each
    /// is solved on the same held-out frames, and the verdict reports the
    /// best one's gain.
    fn assess_add(
        &mut self,
        ti: usize,
        test_fr: &Frames,
        cell: &Cell,
        after: Option<u64>,
        alts: &[Cell],
    ) -> AddVerdict {
        let rect = self.tiles[ti].rect;
        let (bg, proj) = self.with_bump(ti, cell.center, &test_fr.y, &test_fr.proj);
        let (bg, proj) = if self.cfg.shift_nuisance {
            self.with_shift_terms(ti, cell.center, bg, proj, &test_fr.y)
        } else {
            (bg, proj)
        };
        self.work += (rect.len() * (test_fr.len() + 2 * bg.k)) as u64;
        let mut work = 0;
        let base = Problem::new(self.columns(rect, &[], &[]), &bg, rect.len(), &mut work);
        let ext = Problem::new(self.columns(rect, &[], &[cell]), &bg, rect.len(), &mut work);
        self.work += work;
        let b = self.solve_with(&base, &test_fr.y, &proj);
        let e = self.solve_with(&ext, &test_fr.y, &proj);
        let k = ext.len() - 1;
        // What the base model leaves is noise *plus* everything not modelled
        // (dim cells below detection, neuropil): measure its variance per
        // pixel and express gains and events in that unit (>= 1, the noise).
        let n_px = self.fov_px(rect) as f64;
        let dof = (test_fr.len() as f64 * (n_px - (bg.k + base.len()) as f64)).max(1.0);
        let chi_b = Self::total_chi2(&b);
        let s2 = (chi_b / dof).max(1.0);
        let sig = self.coord_noise(&ext, k) * s2.sqrt() as f32;
        let null = self.null(test_fr.len());
        let gain = (chi_b - Self::total_chi2(&e)) / s2;
        // Competing explanations, on the same frames and background. The
        // best one is chosen on the even held-out frames and confirmed on
        // the odd ones (its paired z there), so picking the luckiest of
        // several does not pass for evidence.
        let mut alt: Option<(usize, f64, f64)> = None;
        let mut best_even = f64::NEG_INFINITY;
        let even = |f: &[Fit]| f.iter().step_by(2).map(|x| x.chi2).sum::<f64>();
        let odd = |f: &[Fit]| -> Vec<Fit> { f.iter().skip(1).step_by(2).cloned().collect() };
        let (b_even, b_odd) = (even(&b), odd(&b));
        for (i, a) in alts.iter().enumerate() {
            let mut work = 0;
            let pr = Problem::new(
                self.columns(rect, &[a.id], &[a]),
                &bg,
                rect.len(),
                &mut work,
            );
            self.work += work;
            let f = self.solve_with(&pr, &test_fr.y, &proj);
            let g_even = b_even - even(&f);
            if g_even > best_even {
                best_even = g_even;
                let g = (chi_b - Self::total_chi2(&f)) / s2;
                alt = Some((i, g, paired_z(&b_odd, &odd(&f))));
            }
        }
        // Events are transients above the candidate's own held-out median:
        // a static pattern (a floor or vessel-edge residual) with a constant
        // trace explains held-out χ² but is not a cell.
        let mut sorted: Vec<f32> = e.iter().map(|f| f.c[k]).collect();
        sorted.sort_by(f32::total_cmp);
        let base_level = sorted[sorted.len() / 2];
        let events = e
            .iter()
            .zip(&test_fr.idx)
            .filter(|(f, &fi)| {
                after.is_none_or(|a| fi > a) && f.c[k] - base_level >= self.cfg.event_z * sig
            })
            .count() as u32;
        let mut ok = events >= self.cfg.min_events;
        // A candidate whose held-out trace follows a nearby cell's is that
        // cell's unmodelled light (scatter halo, a footprint mismatch), not
        // a new cell: left to the alternatives (and refinement, merging).
        if ok {
            let ck: Vec<f32> = e.iter().map(|f| f.c[k]).collect();
            let mut near: Vec<Vec<f32>> = Vec::new();
            for j in 0..k {
                let Some(cj) = self.cells.iter().find(|c| c.id == ext.cols[j].id) else {
                    continue;
                };
                // Supports that touch.
                let reach = cj.radius + cell.radius;
                let d2 =
                    (cj.center.0 - cell.center.0).powi(2) + (cj.center.1 - cell.center.1).powi(2);
                if d2 <= reach * reach {
                    let tj: Vec<f32> = e.iter().map(|f| f.c[j]).collect();
                    if corr(&ck, &tj) >= self.cfg.merge_corr {
                        ok = false;
                        break;
                    }
                    near.push(tj);
                }
            }
            if ok && self.cfg.joint_neighbours && near.len() >= 2 {
                let r2 = adjusted_r2(&ck, &near);
                self.work += (ck.len() * near.len() * near.len()) as u64;
                if r2 >= self.cfg.merge_corr * self.cfg.merge_corr {
                    ok = false;
                }
            }
        }
        AddVerdict {
            gain,
            ok,
            alt,
            null,
        }
    }

    /// Competing explanations of a residual candidate: each existing cell
    /// whose support the candidate's disk touches (the two nearest),
    /// re-estimated (a) from its running statistics, (b) with its fitted
    /// trace held fixed on its support plus the candidate's disk (the
    /// footprint grows into the residual), (c) by a rank-1 fit of its
    /// signal plus the residual on that domain (the candidate merged in).
    fn alternatives(
        &mut self,
        ti: usize,
        cand: &Cell,
        cand_trace: &[f32],
        resid: &[Vec<f32>],
        base: &Problem,
        fits: &[Fit],
    ) -> (Vec<Cell>, Vec<u64>) {
        let rect = self.tiles[ti].rect;
        let r0 = 0.75 * self.cfg.cell_diameter_px;
        let mut kinds = Vec::new();
        let mut nb: Vec<(f32, u64)> = self
            .cells
            .iter()
            .filter_map(|c| {
                let d = ((c.center.0 - cand.center.0).powi(2)
                    + (c.center.1 - cand.center.1).powi(2))
                .sqrt();
                (d < c.radius + r0).then_some((d, c.id))
            })
            .collect();
        nb.sort_by(|a, b| a.0.total_cmp(&b.0));
        nb.truncate(2);
        let mut out = Vec::new();
        for (_, id) in nb {
            let Some(cell) = self.cells.iter().find(|c| c.id == id).cloned() else {
                continue;
            };
            if let Some(new) = self.stats_proposal(&cell, false) {
                out.push(new);
                kinds.push(1);
            }
            let Some(k) = base.cols.iter().position(|c| c.id == id) else {
                continue;
            };
            let mut dom: Vec<u32> = base.cols[k].pix.clone();
            dom.extend(self.disk(rect, cand.center.0, cand.center.1, r0));
            dom.sort_unstable();
            dom.dedup();
            let dense = base.cols[k].dense(rect.len());
            // The cell's signal plus the residual, on the domain only.
            let data: Vec<Vec<f32>> = resid
                .iter()
                .zip(fits)
                .map(|(r, f)| {
                    let ck = f.c[k];
                    dom.iter()
                        .map(|&p| r[p as usize] + dense[p as usize] * ck)
                        .collect()
                })
                .collect();
            let local: Vec<u32> = (0..dom.len() as u32).collect();
            let refs: Vec<&[f32]> = data.iter().map(|r| r.as_slice()).collect();
            let c0: Vec<f32> = fits.iter().map(|f| f.c[k]).collect();
            if !c0.iter().any(|&v| v > 0.0) {
                continue;
            }
            // Grown or merged in only when the candidate's fitting-frame
            // trace follows the cell's (the residual is that cell's light):
            // otherwise a neighbouring cell would be swallowed whenever a
            // stretched footprint happens to explain part of it (on the
            // minisim recordings this cost half the recall).
            if corr(cand_trace, &c0) < self.cfg.merge_corr {
                continue;
            }
            self.work += (dom.len() * data.len() * 13) as u64;
            let mut c = c0.clone();
            let h = rank1(&refs, &local, &mut c, 1, true);
            if let Some(mut new) = self.make_cell(id, rect, &dom, &h, Some(&cell)) {
                new.born = cell.born;
                out.push(new);
                kinds.push(2);
            }
            let mut c = c0;
            let h = rank1(&refs, &local, &mut c, 10, false);
            if let Some(mut new) = self.make_cell(id, rect, &dom, &h, None) {
                new.born = cell.born;
                out.push(new);
                kinds.push(3);
            }
        }
        (out, kinds)
    }

    /// `id`'s footprint estimated from its running statistics (pixels of
    /// the statistics disk, unwhitened filtered values), once its peak is
    /// `stats_min_snr` standard errors above zero.
    fn stats_estimate(&self, id: u64) -> Option<(Vec<u32>, Vec<f32>)> {
        let st = self.fpstats.get(&id)?;
        let se = st.std_err();
        let h = st.estimate()?;
        let peak = h
            .iter()
            .zip(&st.pix)
            .map(|(&v, &p)| v * self.inv_sigma[p as usize])
            .fold(0.0f32, f32::max);
        (f64::from(peak) >= f64::from(self.cfg.stats_min_snr) * se).then(|| (st.pix.clone(), h))
    }

    /// The footprint of `cell` re-estimated from its running statistics.
    /// With `changed`, only when it differs from the current one by at
    /// least `refine_min_change` (sine of the angle between the whitened
    /// filtered columns).
    fn stats_proposal(&mut self, cell: &Cell, changed: bool) -> Option<Cell> {
        let (pix, h) = self.stats_estimate(cell.id)?;
        if changed && !self.stats_disagree(cell, &pix, &h) {
            return None;
        }
        let se = self.fpstats.get(&cell.id).map(|st| st.std_err());
        // Growth test on the transient-band estimate with its measured
        // noise; trim to the held-out core's basin (in `finish_cell`).
        self.fast_tmp = None;
        let fast = if self.cfg.core_test.trims() {
            self.fast_info(cell.id, cell.center, cell.radius)
        } else {
            None
        };
        if let Some(fi) = fast {
            let ok = fi.core_ok(f64::from(self.cfg.keep_z));
            if ok {
                self.fast_diag.0 += 1;
            } else {
                self.fast_diag.1 += 1;
            }
            let sef = fi.se_white * fi.f_ring.max(0.0).sqrt();
            self.fast_tmp = Some((fi.h, sef, ok.then_some(fi.core)));
        }
        let new = self.make_cell_global(cell.id, &pix, &h, Some(cell), se);
        self.fast_tmp = None;
        let mut new = new?;
        new.born = cell.born;
        if changed && self.change(cell, &new) < self.cfg.refine_min_change {
            return None;
        }
        Some(new)
    }

    /// Whether the statistics' estimate `h` (on `pix`) differs from the
    /// cell's current filtered footprint by more than its own noise: the
    /// whitened squared difference (current footprint scaled to fit, zero
    /// off its support) in units of the estimate's standard error, against
    /// its χ² null (`n + 3 sqrt(2 n)` on `n` pixels). As frames accumulate
    /// the standard error shrinks, so a real mismatch is found ever more
    /// surely while a converged footprint stops being proposed.
    fn stats_disagree(&self, cell: &Cell, pix: &[u32], h: &[f32]) -> bool {
        let Some(st) = self.fpstats.get(&cell.id) else {
            return false;
        };
        let se = st.std_err();
        if !(se > 0.0) || !se.is_finite() {
            return false;
        }
        let block = self.filter.moat().map_or(0, |m| m.0);
        let cur: Vec<f32> = pix
            .iter()
            .map(|&g| cell.column_at(g, self.dims.width, block))
            .collect();
        let (mut hc, mut cc) = (0.0f64, 0.0f64);
        for (k, &p) in pix.iter().enumerate() {
            let is = f64::from(self.inv_sigma[p as usize]);
            hc += f64::from(h[k]) * f64::from(cur[k]) * is * is;
            cc += f64::from(cur[k]) * f64::from(cur[k]) * is * is;
        }
        let a = if cc > 0.0 { hc / cc } else { 0.0 };
        let mut chi = 0.0f64;
        for (k, &p) in pix.iter().enumerate() {
            let is = f64::from(self.inv_sigma[p as usize]);
            let d = (f64::from(h[k]) - a * f64::from(cur[k])) * is / se;
            chi += d * d;
        }
        let n = pix.len() as f64;
        chi > n + 3.0 * (2.0 * n).sqrt()
    }

    /// Sine of the angle between two cells' whitened filtered columns.
    fn change(&self, a: &Cell, b: &Cell) -> f32 {
        let mut m: HashMap<u32, f32> = HashMap::with_capacity(a.pix.len());
        let mut aa = 0.0f64;
        for (&p, &v) in a.pix.iter().zip(&a.filt) {
            let u = v * self.inv_sigma[p as usize];
            aa += f64::from(u * u);
            m.insert(p, u);
        }
        let (mut ab, mut bb) = (0.0f64, 0.0f64);
        for (&p, &v) in b.pix.iter().zip(&b.filt) {
            let w = f64::from(v * self.inv_sigma[p as usize]);
            bb += w * w;
            if let Some(&u) = m.get(&p) {
                ab += f64::from(u) * w;
            }
        }
        if aa <= 0.0 || bb <= 0.0 {
            return 1.0;
        }
        let c = ab / (aa * bb).sqrt();
        (1.0 - c * c).max(0.0).sqrt() as f32
    }

    /// FOV pixels inside `rect`.
    fn fov_px(&self, rect: Rect) -> usize {
        (rect.y0..rect.y0 + rect.h)
            .map(|y| {
                self.fov[y * self.dims.width + rect.x0..y * self.dims.width + rect.x0 + rect.w]
                    .iter()
                    .filter(|&&m| m != 0)
                    .count()
            })
            .sum()
    }

    fn merge(&mut self, ti: usize, fit_fr: &Frames, test_fr: &Frames) {
        let rect = self.tiles[ti].rect;
        let core = self.tiles[ti].core;
        let now = self.frames;
        self.merge_rejected.retain(|r| r.2 > now);
        for _ in 0..4 {
            let cols = self.columns(rect, &[], &[]);
            if cols.len() < 2 {
                return;
            }
            let base = self.problem(ti, cols);
            let fits = self.solve_all(&base, fit_fr);
            let n = base.len();
            let ids: Vec<u64> = base.cols.iter().map(|c| c.id).collect();
            let cell_of =
                |cells: &[Cell], id: u64| cells.iter().position(|c| c.id == id).expect("cell");
            // Best-correlated overlapping pair with the first cell in the core.
            let mut best: Option<(usize, usize, f32)> = None;
            for i in 0..n {
                let ci = &self.cells[cell_of(&self.cells, ids[i])];
                let (iy, ix) = (ci.center.0 as usize, ci.center.1 as usize);
                if core.local(iy, ix).is_none() {
                    continue;
                }
                for j in 0..n {
                    if j == i {
                        continue;
                    }
                    let cj = &self.cells[cell_of(&self.cells, ids[j])];
                    let dist = ((ci.center.0 - cj.center.0).powi(2)
                        + (ci.center.1 - cj.center.1).powi(2))
                    .sqrt();
                    if dist >= ci.radius + cj.radius {
                        continue;
                    }
                    // A pair kept apart recently is not re-tested until its
                    // cooldown ends (otherwise it would block every other
                    // pair of the tile).
                    let (lo, hi) = (ids[i].min(ids[j]), ids[i].max(ids[j]));
                    if self.merge_rejected.iter().any(|r| r.0 == lo && r.1 == hi) {
                        continue;
                    }
                    let a: Vec<f32> = fits.iter().map(|f| f.c[i]).collect();
                    let b: Vec<f32> = fits.iter().map(|f| f.c[j]).collect();
                    // Pairs the keep tests found redundant go first, then
                    // pairs whose footprints largely coincide (a duplicate
                    // takes no signal in an exact fit, so its trace does
                    // not correlate), then correlated pairs.
                    let r = if self.forced.contains(&(lo, hi)) {
                        2.0
                    } else if overlap(&base.cols[i], &base.cols[j], rect.len()) >= 0.5 {
                        1.5
                    } else {
                        corr(&a, &b)
                    };
                    if r >= self.cfg.merge_corr && best.is_none_or(|bb| r > bb.2) {
                        best = Some((i, j, r));
                    }
                }
            }
            let Some((i, j, _)) = best else { return };
            self.stats.merge_tests += 1;
            let resid = self.residuals(&base, fit_fr, &fits, ti);
            let (ci, cj) = (cell_of(&self.cells, ids[i]), cell_of(&self.cells, ids[j]));
            // Data: residual plus both cells' fitted signal.
            let data: Vec<Vec<f32>> = resid
                .iter()
                .zip(&fits)
                .map(|(r, f)| {
                    let mut d = r.clone();
                    for k in [i, j] {
                        base.cols[k].add_to(&mut d, f.c[k]);
                    }
                    d
                })
                .collect();
            let mut dom: Vec<u32> = base.cols[i].pix.clone();
            dom.extend(&base.cols[j].pix);
            dom.sort_unstable();
            dom.dedup();
            let mut c: Vec<f32> = fits.iter().map(|f| f.c[i] + f.c[j]).collect();
            let refs: Vec<&[f32]> = data.iter().map(|r| r.as_slice()).collect();
            let h = rank1(&refs, &dom, &mut c, 10, false);
            self.work += (dom.len() * data.len() * 40) as u64;
            let keep = self.cells[ci].id.min(self.cells[cj].id);
            let pair = (ids[i].min(ids[j]), ids[i].max(ids[j]));
            let cooldown = now + 4 * self.cfg.reject_cooldown_frames;
            let was_forced = self.forced.contains(&pair);
            self.forced.retain(|&p| p != pair);
            journal!(self, Op::ForcedRemove(pair.0, pair.1));
            // Alternatives to keeping the pair, on held-out frames: one cell
            // fitted to both (rank 1 on the union of the supports), or either
            // cell alone with its footprint unchanged (the other being a
            // duplicate or a fragment of it). The best one is taken unless
            // keeping both beats it by the add margin.
            let sep = self.solve_all(&base, test_fr);
            let mut chi_sep = Self::total_chi2(&sep);
            let ovl = overlap(&base.cols[i], &base.cols[j], rect.len());
            // The merged arm is a fresh fit, so the pair is refitted on the
            // same frames too (alternating rank-1 fits of each cell on the
            // union support, the other's signal removed) and the better of
            // the current and the refitted pair is the baseline: otherwise
            // footprints that lag the data lose to any fresh footprint and
            // distinct cells are merged. The refitted pair counts only while
            // it stays two cells: supports that do not largely coincide, and
            // the weaker part carrying `merge_refit_min_share` of the
            // stronger one's energy. A duplicate or a fragment refits into
            // the whole cell plus a weak leftover that only soaks up
            // footprint mismatch (on the minisim recording with motion,
            // letting that leftover count kept 4 in 5 pairs on one GT unit
            // apart); then the current pair is the baseline.
            if self.cfg.merge_refit_pair && ovl < 0.5 {
                let mut ca: Vec<f32> = fits.iter().map(|f| f.c[i]).collect();
                let mut cb: Vec<f32> = fits.iter().map(|f| f.c[j]).collect();
                let mut other: Vec<Vec<f32>> = data
                    .iter()
                    .zip(&fits)
                    .map(|(d, f)| {
                        let mut d = d.clone();
                        base.cols[j].add_to(&mut d, -f.c[j]);
                        d
                    })
                    .collect();
                let refs: Vec<&[f32]> = other.iter().map(|r| r.as_slice()).collect();
                let ha = rank1(&refs, &dom, &mut ca, 5, false);
                for ((o, d), &ct) in other.iter_mut().zip(&data).zip(&ca) {
                    o.copy_from_slice(d);
                    for (&p, &v) in dom.iter().zip(&ha) {
                        o[p as usize] -= v * ct;
                    }
                }
                let refs: Vec<&[f32]> = other.iter().map(|r| r.as_slice()).collect();
                let hb = rank1(&refs, &dom, &mut cb, 5, false);
                self.work += (2 * dom.len() * data.len() * 30) as u64;
                let energy = |h: &[f32], c: &[f32]| {
                    h.iter().map(|v| v * v).sum::<f32>() * c.iter().map(|v| v * v).sum::<f32>()
                };
                let (ea, eb) = (energy(&ha, &ca), energy(&hb, &cb));
                let two = ea.min(eb) >= self.cfg.merge_refit_min_share * ea.max(eb);
                let (idi, idj) = (ids[i], ids[j]);
                if let (true, Some(na), Some(nb)) = (
                    two,
                    self.make_cell(idi, rect, &dom, &ha, None),
                    self.make_cell(idj, rect, &dom, &hb, None),
                ) {
                    let cols = self.columns(rect, &[idi, idj], &[&na, &nb]);
                    let rp = self.problem(ti, cols);
                    let rf = self.solve_all(&rp, test_fr);
                    chi_sep = chi_sep.min(Self::total_chi2(&rf));
                }
            }
            let mut best_arm: Option<(f64, Option<Cell>, usize, usize)> = None;
            if let Some(m) = self.make_cell(keep, rect, &dom, &h, None) {
                let cols = self.columns(rect, &[ids[i], ids[j]], &[&m]);
                let mp = self.problem(ti, cols);
                let mf = self.solve_all(&mp, test_fr);
                let loss = Self::total_chi2(&mf) - chi_sep;
                let (stay, go) = if self.cells[ci].id == keep {
                    (ci, cj)
                } else {
                    (cj, ci)
                };
                best_arm = Some((loss, Some(m), stay, go));
            }
            for (stay, go) in [(ci, cj), (cj, ci)] {
                let cols = self.columns(rect, &[self.cells[go].id], &[]);
                let ap = self.problem(ti, cols);
                let af = self.solve_all(&ap, test_fr);
                let loss = Self::total_chi2(&af) - chi_sep;
                if best_arm.as_ref().is_none_or(|b| loss < b.0) {
                    best_arm = Some((loss, None, stay, go));
                }
            }
            let (mu, s) = self.null(test_fr.len());
            // Footprints that largely coincide and whose held-out traces
            // move together act as one cell even when the second column
            // buys a little χ² (it absorbs footprint mismatch).
            let one = ovl >= 0.5 && {
                let a: Vec<f32> = sep.iter().map(|f| f.c[i]).collect();
                let b: Vec<f32> = sep.iter().map(|f| f.c[j]).collect();
                corr(&a, &b) >= self.cfg.merge_corr
            };
            let accept = best_arm
                .as_ref()
                .is_some_and(|b| one || b.0 < mu + f64::from(self.cfg.merge_z) * s);
            if let (true, Some((loss, merged, stay, go))) = (accept, best_arm) {
                self.stats.merges += 1;
                self.edits.merges += 1;
                let (kept_id, gone) = (self.cells[stay].id, self.cells[go].id);
                let gone_center = self.cells[go].center;
                let gone_young =
                    self.frames.saturating_sub(self.cells[go].born) < self.cfg.probation_frames;
                let mut new = match merged {
                    Some(m) => {
                        // A new footprint: its running statistics start over.
                        self.fpstats.remove(&kept_id);
                        journal!(self, Op::FpRemove(kept_id));
                        m
                    }
                    None => self.cells[stay].clone(),
                };
                new.born = self.cells[ci].born.min(self.cells[cj].born);
                let bbox = new.bbox.union(&self.cells[go].bbox);
                let center = new.center;
                self.log(
                    EditKind::Merge,
                    kept_id,
                    gone,
                    center,
                    ((mu - loss) / s) as f32,
                );
                {
                    let g = &self.cells[go];
                    self.churn
                        .on_merge(self.frames, kept_id, gone, g.center, &g.pix, &g.filt);
                    journal!(self, Op::ChurnMerge(kept_id, g.clone()));
                }
                // The merged cell keeps the stronger evidence record.
                if let Some(ev) = self.ledger.remove(&gone) {
                    self.ledger
                        .entry(kept_id)
                        .or_insert_with(Evidence::new)
                        .absorb(&ev);
                }
                journal!(self, Op::LedgerAbsorb(kept_id, gone));
                self.lives.remove(&gone);
                self.fpstats.remove(&gone);
                journal!(self, Op::Replace(kept_id, new.clone()));
                journal!(self, Op::Remove(gone));
                self.cells[stay] = new;
                self.cells.remove(go);
                self.pending = true;
                self.touch(bbox);
                self.tiles[ti].fresh = 0;
                // The merged cell's surroundings are not re-proposed at once;
                // a young cell merged back marks its spot (the cooldown
                // doubles each time the same residual comes back).
                self.reject(ti, center.0, center.1);
                if gone_young {
                    // The same residual added and merged back again and
                    // again: treat the spot like a deletion's.
                    self.entomb(gone_center);
                }
            } else {
                self.merge_rejected.push((pair.0, pair.1, cooldown));
                journal!(self, Op::MergeRejected(pair.0, pair.1, cooldown));
                self.stats.merge_rejects += 1;
                // Kept apart: they are two cells after all, so the probes
                // that found them redundant no longer count.
                if was_forced {
                    for id in [pair.0, pair.1] {
                        if let Some(ev) = self.ledger.get_mut(&id) {
                            ev.redundant = 0;
                            ev.partner = None;
                        }
                        journal!(self, Op::ClearRedundant(id));
                    }
                }
            }
        }
    }

    /// Split tests: is one of the tile's cells better explained as two
    /// cells with distinct traces? On the fitting frames where the cell is
    /// active, its signal plus the residual on its support is factorised at
    /// rank 2 (non-negative traces), started from the footprint cut in two
    /// across its long axis. When the two parts look distinct there (traces
    /// below `merge_corr`, each with a fifth of the energy, a clear drop in
    /// squared error), both are made cells and tested on held-out frames
    /// like an add: the pair must beat the single cell by the add margin,
    /// and each part needs its own held-out events with traces that do not
    /// move together (or the merge test would undo it). At most one split
    /// per visit. Returns whether the tile's cells changed.
    fn split(&mut self, ti: usize, solved: &Solved, test_fr: &Frames) -> bool {
        let core = self.tiles[ti].core;
        let rect = self.tiles[ti].rect;
        let Solved { base, fits, resid } = solved;
        let d = self.cfg.cell_diameter_px;
        for i in 0..base.len() {
            let id = base.cols[i].id;
            let Some(ci) = self.cells.iter().position(|c| c.id == id) else {
                continue;
            };
            let cell = self.cells[ci].clone();
            if core
                .local(cell.center.0 as usize, cell.center.1 as usize)
                .is_none()
            {
                continue;
            }
            let sig = self.coord_noise(base, i);
            let active: Vec<usize> = (0..fits.len())
                .filter(|&t| fits[t].c[i] >= 2.0 * sig)
                .collect();
            if active.len() < 8 {
                continue;
            }
            let col = &base.cols[i];
            let np = col.pix.len();
            // The column on its support, moat included.
            let cv = col.on_support();
            let data: Vec<Vec<f32>> = active
                .iter()
                .map(|&t| {
                    col.pix
                        .iter()
                        .zip(&cv)
                        .map(|(&p, &v)| resid[t][p as usize] + v * fits[t].c[i])
                        .collect()
                })
                .collect();
            self.stats.split_tests += 1;
            self.work += (np * active.len() * 60) as u64;
            let Some((ha, hb, h1)) = rank2_split(&data, &cv, &col.pix, rect.w, self.cfg.merge_corr)
            else {
                continue;
            };
            let new_id = self.next_id;
            let Some(mut a) = self.make_cell(id, rect, &col.pix, &ha, None) else {
                continue;
            };
            let Some(mut b) = self.make_cell(new_id, rect, &col.pix, &hb, None) else {
                continue;
            };
            let sep =
                ((a.center.0 - b.center.0).powi(2) + (a.center.1 - b.center.1).powi(2)).sqrt();
            if sep < 0.3 * d {
                continue;
            }
            a.born = cell.born;
            b.born = self.frames;
            // Held-out test, free bump at the cell in both arms.
            let (bg, proj) = self.with_bump(ti, cell.center, &test_fr.y, &test_fr.proj);
            let mut work = 0;
            let one = Problem::new(self.columns(rect, &[], &[]), &bg, rect.len(), &mut work);
            let two = Problem::new(
                self.columns(rect, &[id], &[&a, &b]),
                &bg,
                rect.len(),
                &mut work,
            );
            self.work += work + (rect.len() * (test_fr.len() + 2 * bg.k)) as u64;
            let f1 = self.solve_with(&one, &test_fr.y, &proj);
            let f2 = self.solve_with(&two, &test_fr.y, &proj);
            let n_px = self.fov_px(rect) as f64;
            let dof = (test_fr.len() as f64 * (n_px - (bg.k + one.len()) as f64)).max(1.0);
            let chi1 = Self::total_chi2(&f1);
            let s2 = (chi1 / dof).max(1.0);
            let gain = (chi1 - Self::total_chi2(&f2)) / s2;
            let (m, sd) = self.null(test_fr.len());
            if gain <= m + f64::from(self.cfg.accept_z) * sd {
                continue;
            }
            // Two columns also fit an imperfect single footprint better
            // than one does: the pair must beat the best single-cell
            // re-estimate (rank 1 on the same frames, or the running
            // statistics) by the add margin too.
            let mut singles = Vec::new();
            if let Some(mut c1) = self.make_cell(id, rect, &col.pix, &h1, None) {
                c1.born = cell.born;
                singles.push(c1);
            }
            if let Some(c1) = self.stats_proposal(&cell, false) {
                singles.push(c1);
            }
            let mut best_single = 0.0f64;
            for c1 in &singles {
                let mut work = 0;
                let pr = Problem::new(self.columns(rect, &[id], &[c1]), &bg, rect.len(), &mut work);
                self.work += work;
                let f = self.solve_with(&pr, &test_fr.y, &proj);
                best_single = best_single.max((chi1 - Self::total_chi2(&f)) / s2);
            }
            if gain - best_single <= m + f64::from(self.cfg.accept_z) * sd {
                continue;
            }
            let (ka, kb) = (two.len() - 2, two.len() - 1);
            let ta: Vec<f32> = f2.iter().map(|f| f.c[ka]).collect();
            let tb: Vec<f32> = f2.iter().map(|f| f.c[kb]).collect();
            if corr(&ta, &tb) >= self.cfg.merge_corr {
                continue;
            }
            let events = |t: &[f32], k: usize| {
                let mut s: Vec<f32> = t.to_vec();
                s.sort_by(f32::total_cmp);
                let lvl = s[s.len() / 2];
                let sig = self.coord_noise(&two, k) * s2.sqrt() as f32;
                t.iter()
                    .filter(|&&v| v - lvl >= self.cfg.event_z * sig)
                    .count() as u32
            };
            if events(&ta, ka) < self.cfg.min_events || events(&tb, kb) < self.cfg.min_events {
                continue;
            }
            // Each part is a cell by the add test's rules: its held-out
            // trace must not follow a neighbour's (then it is that
            // neighbour's light, for refinement to give back).
            // Neighbours whose supports touch the part's.
            let follows = |t: &[f32], c: (f32, f32), r: f32| {
                (0..two.len() - 2).any(|j| {
                    self.cells
                        .iter()
                        .find(|x| x.id == two.cols[j].id)
                        .is_some_and(|cj| {
                            (cj.center.0 - c.0).powi(2) + (cj.center.1 - c.1).powi(2)
                                <= (cj.radius + r).powi(2)
                                && corr(t, &f2.iter().map(|f| f.c[j]).collect::<Vec<_>>())
                                    >= self.cfg.merge_corr
                        })
                })
            };
            if follows(&ta, a.center, a.radius) || follows(&tb, b.center, b.radius) {
                continue;
            }
            // Accepted.
            self.next_id += 1;
            self.stats.splits += 1;
            self.edits.splits += 1;
            self.log(
                EditKind::Split,
                id,
                new_id,
                a.center,
                ((gain - m) / sd) as f32,
            );
            self.churn.on_split(self.frames, new_id);
            self.fpstats.remove(&id);
            journal!(self, Op::ChurnSplit(new_id));
            journal!(self, Op::FpRemove(id));
            journal!(self, Op::Replace(id, a.clone()));
            journal!(self, Op::Push(b.clone()));
            let bbox = a.bbox.union(&b.bbox).union(&cell.bbox);
            self.cells[ci] = a;
            self.cells.push(b);
            // The merge test does not undo it for a long cooldown.
            let until = self.frames + 16 * self.cfg.reject_cooldown_frames;
            self.merge_rejected
                .push((id.min(new_id), id.max(new_id), until));
            journal!(
                self,
                Op::MergeRejected(id.min(new_id), id.max(new_id), until)
            );
            self.pending = true;
            self.touch(bbox);
            self.tiles[ti].fresh = 0;
            return true;
        }
        false
    }

    /// The tile's current model solved on its fitting frames.
    fn solve_tile(&mut self, ti: usize, fit_fr: &Frames) -> Solved {
        let rect = self.tiles[ti].rect;
        let cols = self.columns(rect, &[], &[]);
        let base = self.problem(ti, cols);
        let fits = self.solve_all(&base, fit_fr);
        let resid = self.residuals(&base, fit_fr, &fits, ti);
        Solved { base, fits, resid }
    }

    /// Refinement of the tile's cells. A cell whose running statistics are
    /// precise enough is re-estimated from them (all fitting frames so
    /// far); otherwise from the reservoir's fitting frames where it is
    /// active. The new footprint is kept when it lowers held-out χ² by
    /// `refine_z` sd of the noise-column null. Converged footprints (the
    /// statistics' estimate within `refine_min_change` of the current one)
    /// are not proposed, so refinements die out as the estimates settle.
    fn refine(&mut self, ti: usize, solved: &Solved, test_fr: &Frames) {
        let core = self.tiles[ti].core;
        let rect = self.tiles[ti].rect;
        let Solved { base, fits, resid } = solved;
        if base.len() == 0 {
            return;
        }
        let base_test = self.solve_all(base, test_fr);
        let chi_base = Self::total_chi2(&base_test);
        let n_px = self.fov_px(rect) as f64;
        let dof = (test_fr.len() as f64
            * (n_px - (self.bgs[ti].as_ref().expect("basis").k + base.len()) as f64))
            .max(1.0);
        let s2 = (chi_base / dof).max(1.0);
        let mut updates = Vec::new();
        for i in 0..base.len() {
            let id = base.cols[i].id;
            let Some(ci) = self.cells.iter().position(|c| c.id == id) else {
                continue;
            };
            let cell = self.cells[ci].clone();
            if core
                .local(cell.center.0 as usize, cell.center.1 as usize)
                .is_none()
            {
                continue;
            }
            let from_stats = self.stats_estimate(id).is_some();
            let new = if from_stats {
                match self.stats_proposal(&cell, true) {
                    Some(n) => n,
                    None => continue,
                }
            } else if self.frames.saturating_sub(cell.born) > self.cfg.reservoir_refine_frames {
                // Past its youth a cell is refined from its running
                // statistics only (a footprint from a few dozen reservoir
                // frames is too noisy to keep replacing).
                continue;
            } else {
                let sig = self.coord_noise(base, i);
                let active: Vec<usize> = (0..fits.len())
                    .filter(|&t| fits[t].c[i] >= 2.0 * sig)
                    .collect();
                if active.len() < 3 {
                    continue;
                }
                let r = cell.radius + 2.0;
                // A footprint the patch cannot hold whole is left to its
                // running statistics (which see all of it).
                let whole = Rect::around(cell.center.0, cell.center.1, r, self.dims);
                if clip(whole, rect) != whole {
                    continue;
                }
                let dom = self.disk(rect, cell.center.0, cell.center.1, r);
                let data: Vec<Vec<f32>> = active
                    .iter()
                    .map(|&t| {
                        let mut d = resid[t].clone();
                        base.cols[i].add_to(&mut d, fits[t].c[i]);
                        d
                    })
                    .collect();
                let refs: Vec<&[f32]> = data.iter().map(|r| r.as_slice()).collect();
                let mut c: Vec<f32> = active.iter().map(|&t| fits[t].c[i]).collect();
                let h = rank1(&refs, &dom, &mut c, 1, true);
                self.work += (dom.len() * data.len()) as u64;
                let Some(mut new) = self.make_cell(id, rect, &dom, &h, Some(&cell)) else {
                    continue;
                };
                new.born = cell.born;
                if self.change(&cell, &new) < self.cfg.refine_min_change {
                    continue;
                }
                new
            };
            let cols = self.columns(rect, &[id], &[&new]);
            let pr = self.problem(ti, cols);
            let f = self.solve_all(&pr, test_fr);
            let gain = (chi_base - Self::total_chi2(&f)) / s2;
            let z = paired_z(&base_test, &f);
            // A reservoir estimate is noisy and re-proposed on every
            // visit, so it needs the stronger evidence an absorption does.
            let need = if from_stats {
                self.cfg.refine_z
            } else {
                self.cfg.absorb_z
            };
            if gain > 0.0 && z > f64::from(need) {
                updates.push((id, new, z as f32, if from_stats { 1 } else { 2 }));
            }
        }
        for (id, new, margin, source) in updates {
            if let Some(ci) = self.cells.iter().position(|c| c.id == id) {
                #[cfg(feature = "diagnostics")]
                diagnostics::refine(self, &self.cells[ci], &new, margin, source);
                self.stats.refines += 1;
                self.edits.refines += 1;
                self.log(EditKind::Refine, id, source, new.center, margin);
                let bbox = new.bbox;
                journal!(self, Op::Replace(id, new.clone()));
                self.cells[ci] = new;
                self.pending = true;
                self.touch(bbox);
            }
        }
        self.tiles[ti].fresh = 0;
    }
}

/// Intersection of two rectangles (empty when disjoint).
fn clip(a: Rect, b: Rect) -> Rect {
    let y0 = a.y0.max(b.y0);
    let x0 = a.x0.max(b.x0);
    let y1 = (a.y0 + a.h).min(b.y0 + b.h).max(y0);
    let x1 = (a.x0 + a.w).min(b.x0 + b.w).max(x0);
    Rect {
        y0,
        x0,
        h: y1 - y0,
        w: x1 - x0,
    }
}

/// Paired z of the per-frame χ² gains of `alt` over `base` (same frames):
/// mean gain over its standard error. Scale-free, so it suits footprint
/// changes, whose χ² effect grows with the cell's activity.
fn paired_z(base: &[Fit], alt: &[Fit]) -> f64 {
    let n = base.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let d: Vec<f64> = base.iter().zip(alt).map(|(b, a)| b.chi2 - a.chi2).collect();
    let m = d.iter().sum::<f64>() / n;
    let v = d.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (n - 1.0);
    if v <= 0.0 {
        return if m > 0.0 { f64::INFINITY } else { 0.0 };
    }
    m / (v / n).sqrt()
}

/// Cosine similarity of two patch columns.
fn overlap(a: &Column, b: &Column, n: usize) -> f32 {
    let ab = b.dot(&a.dense(n));
    let (aa, bb) = (a.norm2(), b.norm2());
    if aa <= 0.0 || bb <= 0.0 {
        0.0
    } else {
        ab / (aa * bb).sqrt()
    }
}

/// Adjusted R² of the least-squares fit of `y` on the columns `xs` plus an
/// intercept (0 when there are too few samples for the regressors).
fn adjusted_r2(y: &[f32], xs: &[Vec<f32>]) -> f32 {
    let n = y.len();
    let p = xs.len();
    if n < p + 3 {
        return 0.0;
    }
    let mean = |v: &[f32]| v.iter().map(|&x| f64::from(x)).sum::<f64>() / n as f64;
    let my = mean(y);
    let yc: Vec<f64> = y.iter().map(|&v| f64::from(v) - my).collect();
    let xc: Vec<Vec<f64>> = xs
        .iter()
        .map(|x| {
            let m = mean(x);
            x.iter().map(|&v| f64::from(v) - m).collect()
        })
        .collect();
    let syy: f64 = yc.iter().map(|v| v * v).sum();
    if syy <= 0.0 {
        return 0.0;
    }
    let mut g = vec![0.0f64; p * p];
    let mut b = vec![0.0f64; p];
    for a in 0..p {
        for c in a..p {
            let d: f64 = xc[a].iter().zip(&xc[c]).map(|(u, v)| u * v).sum();
            g[a * p + c] = d;
            g[c * p + a] = d;
        }
        b[a] = xc[a].iter().zip(&yc).map(|(u, v)| u * v).sum();
    }
    // A small ridge keeps silent (all-zero) neighbours solvable.
    let tr = (0..p).map(|a| g[a * p + a]).sum::<f64>() / p as f64;
    for a in 0..p {
        g[a * p + a] += 1e-6 * tr.max(1e-12);
    }
    let Some(inv) = local::invert(&g, p) else {
        return 0.0;
    };
    let explained: f64 = (0..p)
        .map(|a| b[a] * (0..p).map(|c| inv[a * p + c] * b[c]).sum::<f64>())
        .sum();
    let r2 = (explained / syy).clamp(0.0, 0.999_999);
    // Few held-out frames for many neighbours fit noise: count the fit only
    // when it is significant (F test at 1e-3, the χ²_p quantile by
    // Wilson-Hilferty, conservative for small n - p - 1).
    let f = (r2 / p as f64) / ((1.0 - r2) / (n - p - 1) as f64);
    let q = 2.0 / (9.0 * p as f64);
    let chi = p as f64 * (1.0 - q + 3.09 * q.sqrt()).powi(3);
    if f * (p as f64) < chi {
        return 0.0;
    }
    (1.0 - (1.0 - r2) * (n - 1) as f64 / (n - p - 1) as f64) as f32
}

fn corr(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let ma = a.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let mb = b.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        let (dx, dy) = (f64::from(x) - ma, f64::from(y) - mb);
        sab += dx * dy;
        saa += dx * dx;
        sbb += dy * dy;
    }
    if saa <= 0.0 || sbb <= 0.0 {
        0.0
    } else {
        (sab / (saa * sbb).sqrt()) as f32
    }
}

#[cfg(test)]
mod tests;
