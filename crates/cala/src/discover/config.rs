//! Slow-loop settings: [`SlowLoopConfig`], its rule enums and [`EditScope`].

use super::reservoir::mix;
use super::ChurnConfig;
use crate::trace::{BackgroundModel, LibraryConfig, TraceError};

/// The optics' point-spread σ, px (UCLA Miniscope at its native
/// resolution): the default of [`SlowLoopConfig::psf_sigma_px`].
pub const PSF_SIGMA_PX: f32 = 1.5;

/// When the statistics path proposes a refinement (S2.1c, the minimal
/// refine gate). Absorptions, merges and the reservoir path are unaffected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RefineGate {
    /// The estimate disagrees with the current footprint beyond its χ²
    /// null (`n + 3 sqrt(2 n)` standard errors) and the proposal turns the
    /// whitened column by at least `refine_min_change` (the rule before
    /// S2.1c).
    Legacy,
    /// The default. The change exceeds the estimate's own split-half noise:
    /// `Î = ‖h/a − cur‖² − ½‖(h_A − h_B)/a‖² > 0` (whitened, in units of
    /// the current column, `a` the estimate's fit scale on it). A cell
    /// without split halves falls back to [`RefineGate::Legacy`].
    #[default]
    SplitHalf,
}

/// Where footprints of overlapping cells are updated jointly from a
/// replay of their stored history (`cluster.rs`, the Stage 1 design in
/// `demix-bench/design_joint_update.md`): a cluster of cells whose
/// normalised whitened overlap is at least `cluster_rho_min` keeps, per
/// fitting frame, the K numbers of its residual in a K-dim basis; a refine
/// visit re-solves the stored frames' traces with the current footprints
/// and refits the footprints jointly, and the cluster's members are
/// proposed and gated together. Cells outside clusters keep the per-cell
/// running statistics. Off by default (experimental).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum JointUpdate {
    /// Per-cell statistics only.
    #[default]
    Off,
    /// Joint replay in [`EditScope::Refine`] visits (the app's Refine
    /// stage); the store accumulates only there.
    Refine,
    /// Joint replay in every visit (Discover too): the clusters follow the
    /// library's cell set, and a store restarts when its members change (a
    /// member's disk moving keeps the store, re-expressed on the new pixels).
    All,
}

/// Sign rule of the joint replay's footprint step (filtered space, where a
/// true footprint is slightly negative in its high-pass moat). The
/// rotation between a bitten newcomer and its over-filled neighbour is a
/// free direction of a linear footprint fit (`A R`, `R⁻¹ C`); what pins it
/// is the newcomer's light clipped at zero on the older cell's far side.
/// On the quick demixing tier (17 Nov 2026) `All` lowered the 0.75-1 D bite
/// share 0.50 -> 0.36 and the < 1 D trace correlation excess +0.14 ->
/// +0.10; `Off` gave 0.50 -> 0.42 and no correlation gain; `Own` was no
/// different from `Off` (`tools/cala-eval/results/2026-11-17-cluster-replay.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum JointSign {
    /// A plain per-pixel joint least-squares fit; the sign rule enters only
    /// through the finish path's inversion (`a ≥ 0`).
    Off,
    /// Each member's coefficient ≥ 0 where its current filtered column is
    /// positive (the moat stays free).
    Own,
    /// Each member's coefficient ≥ 0 on its whole disk (the design toys'
    /// non-negative footprint step; the moat is clipped there and comes
    /// back through the finish path's inversion).
    #[default]
    All,
}

/// Which members of a replayed cluster are proposed. The replay's split
/// halves are fitted in the store's one basis, which is estimated from all
/// stored frames; their difference therefore misses the basis's own noise
/// and understates the estimate's noise (toy: `a_member_at_the_truth_is_not_proposed`).
/// Even so `Cluster` is the default: on static s5 + pairs s5 (18 Nov 2026)
/// `Member` proposed about half as often, and the bites healed less
/// (0.75-1 D bite share 0.34 -> 0.46): a bitten member heals by small
/// accepted steps, each below its own split-half noise. The held-out gate
/// decides either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum JointAdmit {
    /// Stage 1: every significant member, when the members' summed
    /// split-half excess (from the replay's halves) is positive.
    #[default]
    Cluster,
    /// Each member on its own evidence, the per-cell path's rule: proposed
    /// when its estimate differs from its current column by more than its
    /// split-half noise, taken from the joint fit's standard errors
    /// (`½ n (s_A² + s_B²)` whitened, the expectation of `½‖h_A − h_B‖²`
    /// for a per-pixel fit). The others keep their columns; the proposed
    /// members are still gated together.
    Member,
}

/// Which merge tests may merge (S2.1c merge redesign).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MergeRule {
    /// The held-out test alone: a single column (merged footprint, or
    /// either cell dropped) explains the tile's held-out frames within
    /// `merge_z` of the pair, or the `one` shortcut (the rule before
    /// S2.1c).
    Legacy,
    /// The default. The held-out test, and a pair whose footprints do not largely
    /// coincide (overlap below ½, the bound of the `one` shortcut) must
    /// also have the same measured shape: on the union of their supports
    /// the cells' running-statistics estimates, best scaled onto each
    /// other, differ by no more than their own split-half noise,
    /// `Î = ‖h_X − a h_Y‖² − ½‖h_X,A − h_X,B‖² − a² ½‖h_Y,A − h_Y,B‖² ≤ 0`
    /// both ways (whitened; the refine gate's statistic for a pair). A
    /// pair either cell of which has no split halves yet (a young cell)
    /// falls back to [`MergeRule::Legacy`].
    #[default]
    SplitHalf,
}

/// Which structural edits the slow loop may make (S2.3b: refinement-only
/// later passes). Refinements of existing footprints are always allowed;
/// the default allows everything. A visit that may only refine skips the
/// add proposals (and with them absorbs and re-adds), splits and merges;
/// [`EditScope::Refine`] also skips the keep tests and every deletion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EditScope {
    /// Every edit (adds, absorbs, splits, merges, keep tests, deletions).
    #[default]
    All,
    /// Refinements only: the cell set is frozen.
    Refine,
    /// Refinements, keep tests and deletions (pruning).
    RefinePrune,
    /// Refinements, keep tests, deletions and merges.
    RefineMerge,
}

impl EditScope {
    /// Whether new cells may appear (adds, absorbs, splits).
    pub fn grows(self) -> bool {
        self == EditScope::All
    }
    /// Whether cells may be removed by the keep tests and probation.
    pub fn prunes(self) -> bool {
        self != EditScope::Refine
    }
    /// Whether pairs may be merged.
    pub fn merges(self) -> bool {
        matches!(self, EditScope::All | EditScope::RefineMerge)
    }

    /// Every scope, in wire order.
    pub const ALL: [EditScope; 4] = [
        EditScope::All,
        EditScope::Refine,
        EditScope::RefinePrune,
        EditScope::RefineMerge,
    ];

    /// The scope's name: `all`, `refine`, `refine-prune` or `refine-merge`
    /// (qc_eval's `--later-passes` values and the app's
    /// `SlowLoop.setEditScope` argument; the app's Refine stage is `refine`).
    pub fn name(self) -> &'static str {
        match self {
            EditScope::All => "all",
            EditScope::Refine => "refine",
            EditScope::RefinePrune => "refine-prune",
            EditScope::RefineMerge => "refine-merge",
        }
    }

    /// The scope with [`EditScope::name`] `name`.
    pub fn from_name(name: &str) -> Option<EditScope> {
        Self::ALL.into_iter().find(|s| s.name() == name)
    }

    /// The wire code (a visit job carries its loop's scope).
    pub(crate) fn code(self) -> u8 {
        Self::ALL.iter().position(|&s| s == self).unwrap() as u8
    }

    pub(crate) fn from_code(code: u8) -> Option<EditScope> {
        Self::ALL.get(code as usize).copied()
    }
}

/// Settings of the slow loop. Pixel sizes follow the expected cell diameter.
#[derive(Debug, Clone, PartialEq)]
pub struct SlowLoopConfig {
    /// Expected soma diameter, px (the preprocessing's `cell_diameter_px`).
    pub cell_diameter_px: f32,
    /// The optics' point-spread σ, px: the scale light is smoothed at
    /// before its basins are traced, so a basin is not cut by single-pixel
    /// noise. Default [`PSF_SIGMA_PX`].
    pub psf_sigma_px: f32,
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
    /// Family-wise error rate of one support construction on the
    /// statistics path: the probability that it admits at least one pixel
    /// without light (Bonferroni over the tested pixels). Edits of the cell
    /// set keep their own rates.
    pub support_alpha: f32,
    /// A refinement from the running statistics is accepted when its
    /// per-frame held-out χ² gains are positive with a paired z (mean over
    /// standard error) above this. The default 0 accepts any held-out
    /// gain: the proposal has already passed the statistics' own test over
    /// all fitting frames ([`RefineGate::SplitHalf`]), and a second z ≥ 3
    /// on a tile's few dozen held-out frames vetoed most real changes, in
    /// particular the refill of a footprint born without the light under an
    /// older neighbour (3 was the value before the refine-gate fix). Under
    /// [`RefineGate::Legacy`] a stricter value may be wanted. Refinements
    /// from the reservoir use `absorb_z`...
    pub refine_z: f32,
    /// ...and an absorption (the best of several alternatives) above this.
    pub absorb_z: f32,
    /// An alternative competes with adding a candidate only when it
    /// explains at least this share of the candidate's held-out gain.
    pub absorb_share: f32,
    /// ...and changes the whitened filtered footprint by at least this
    /// share of its norm (smaller changes are not proposed; the reservoir
    /// path, and the statistics path under [`RefineGate::Legacy`]).
    pub refine_min_change: f32,
    /// When the statistics path proposes a refinement (see [`RefineGate`]).
    pub refine_gate: RefineGate,
    /// Which merge tests may merge (see [`MergeRule`]).
    pub merge_rule: MergeRule,
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
    /// The neighbour guards of a merge test (the refitted-pair baseline and
    /// the split-half shape gate) apply to pairs whose footprints overlap by
    /// less than this (cosine). At 0.5 (the historic value) a pair whose
    /// footprints largely coincide skips both guards; real neighbours closer
    /// than ~0.4 cell diameters overlap that much once their footprints are
    /// accurate. Above 1, the guards apply at every overlap.
    pub merge_guard_max_ovl: f32,
    /// The same bound for the refitted-pair baseline alone (the split-half
    /// gate keeps `merge_guard_max_ovl`).
    pub merge_refit_max_ovl: f32,
    /// Pairs whose centres are at least this many cell diameters apart
    /// get the split-half shape gate whatever their overlap. Overlap
    /// grows as two neighbours' footprints become accurate (a real pair
    /// ~0.35 D apart passes 0.5 once neither is bitten), while two
    /// estimates of one soma (a duplicate or a fragment) sit on the same
    /// blob; the centre separation of somatic blobs does not depend on
    /// how complete the footprints are. Infinite (the default) keeps the
    /// overlap rule alone.
    pub merge_guard_min_sep: f32,
    /// Warm starts in a visit's comparisons: every model compared with a
    /// reference model on the same frames (the cell to add, the merged
    /// pair, the refined footprint, the split, the reference itself)
    /// starts its per-frame solve at the reference's solution, mapped by
    /// cell id (new cells at zero). The exit rule is unchanged, so each
    /// solve reaches the same optimum to within its tolerance, in fewer
    /// sweeps; the arms of a comparison share the start, so none is
    /// solved further than the others. Off: every solve starts at zero.
    pub warm_start: bool,
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
    /// Joint footprint update of overlapping cells (see [`JointUpdate`]).
    pub joint_update: JointUpdate,
    /// Cells join a cluster along overlaps `G_ij / sqrt(G_ii G_jj)` (the
    /// whitened filtered columns' Gram) of at least this, strongest first.
    pub cluster_rho_min: f32,
    /// At most this many cells per cluster (2..=8); a union that would
    /// exceed it is refused and that overlap is left to the per-cell
    /// statistics' coupling.
    pub cluster_max: usize,
    /// Experimental: the sign rule of the replay's footprint step (see
    /// [`JointSign`]).
    pub joint_sign_rule: JointSign,
    /// Experimental: alternations per replay inside the store (the design:
    /// 1; more converge the stored window's factorisation further, but the
    /// published footprints then move by more than the gate tests well).
    pub joint_iters: usize,
    /// Which members of a replayed cluster are proposed (see
    /// [`JointAdmit`]).
    pub joint_admit: JointAdmit,
    /// Experimental: the store keeps its own last joint estimate and
    /// re-solves the next replay's traces with it (one more alternation per
    /// visit, carried across visits) instead of with the published columns.
    /// The estimate is never published except through the cluster gate.
    /// Off: on static s5 + pairs s5 (18 Nov 2026) it healed more bites
    /// (0.75-1 D share 0.23 -> 0.17) but raised over-fill (est/true > 1.3,
    /// pairs < 1 D) 0.075 -> 0.112, as more alternations did in Stage 1.
    pub joint_carry: bool,
    /// Experimental: L1 weight `μ` of the replay's trace step. Each stored
    /// frame's traces solve `argmin_{c ≥ 0} ‖U v − A c‖² + 2 μ Σ_k ‖a_k‖ c_k`
    /// (whitened), a soft threshold of `μ` trace-noise SDs per member,
    /// invariant to the footprints' scale. The bitten split (wide − λ·small,
    /// small + λ·wide) reconstructs the frames as well as the true one but
    /// gives the small cell extra events; with unit-norm footprints its L1
    /// is higher by `Σ c_wide ‖a_wide‖ (√(1−ρ²) + ρ − 1) > 0`, so the
    /// penalty breaks the tie towards the sparse, independent split.
    /// 0 (default) is the plain non-negative trace step.
    pub joint_l1: f32,
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
            psf_sigma_px: PSF_SIGMA_PX,
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
            support_alpha: 0.05,
            refine_z: 0.0,
            absorb_z: 3.0,
            absorb_share: 0.8,
            refine_min_change: 0.03,
            refine_gate: RefineGate::SplitHalf,
            merge_rule: MergeRule::SplitHalf,
            reservoir_refine_frames: 2400,
            split_every_visits: 4,
            merge_refit_pair: true,
            merge_refit_min_share: 0.1,
            merge_guard_max_ovl: 0.5,
            merge_refit_max_ovl: 0.5,
            merge_guard_min_sep: f32::INFINITY,
            warm_start: true,
            merge_z: 2.0,
            noise_corr: true,
            shift_nuisance: true,
            joint_neighbours: false,
            joint_update: JointUpdate::Off,
            cluster_rho_min: 0.05,
            cluster_max: 6,
            joint_sign_rule: JointSign::All,
            joint_iters: 1,
            joint_admit: JointAdmit::Cluster,
            joint_carry: false,
            joint_l1: 0.0,
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
    /// The options a visit job must be run with that the job does not
    /// carry (`withConfig` in the app): the cluster replay mode, its sign
    /// rule and the merge guard. A [`VisitRunner`] refuses jobs from a loop
    /// whose fingerprint differs from its own.
    pub fn visit_fingerprint(&self) -> u64 {
        let ju = match self.joint_update {
            JointUpdate::Off => 0u64,
            JointUpdate::Refine => 1,
            JointUpdate::All => 2,
        };
        let js = match self.joint_sign_rule {
            JointSign::Off => 0u64,
            JointSign::Own => 1,
            JointSign::All => 2,
        };
        ju | js << 4
            | u64::from(self.merge_guard_min_sep.to_bits()) << 8
            | u64::from(self.warm_start) << 40
    }

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
            && self.psf_sigma_px.is_finite()
            && self.psf_sigma_px >= 0.6
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
            && self.support_alpha > 0.0
            && self.support_alpha < 1.0
            && self.refine_z.is_finite()
            && self.absorb_z.is_finite()
            && self.absorb_share.is_finite()
            && self.refine_min_change.is_finite()
            && self.merge_z.is_finite()
            && self.cluster_rho_min > 0.0
            && self.cluster_rho_min < 1.0
            && (2..=8).contains(&self.cluster_max)
            && self.joint_iters >= 1
            && self.joint_l1 >= 0.0
            && self.joint_l1.is_finite()
            && self.churn.is_valid();
        if ok {
            Ok(())
        } else {
            Err(TraceError::InvalidConfig(format!("{self:?}")))
        }
    }
}
