//! Counters and reports of the slow loop, and the reservoir's sizing.

use super::local::Rect;
use super::reservoir::Tile;
use super::SlowLoopConfig;

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

/// How tiles came due for an ordinary visit (diagnostics; counted on the
/// loop that owns the tiles, read by `qc_eval --visit-diag`; nothing reads
/// them back, so they change no result). Each counts a tile going from
/// "not due" to "due".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DueDiag {
    /// A live frame took reservoir slots of the tile.
    pub slots: u64,
    /// An edit to a cell that overlaps the tile, made by a visit of
    /// another tile (or by the loop itself).
    pub touch: u64,
    /// The tile's own visit left it due again.
    pub own: u64,
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
    /// Of `adds`, cells added by the history review (`add_reviewed`).
    pub review_adds: u64,
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
    /// Statistics proposals not made under a basin support rule because
    /// the split halves gave no measured standard error.
    pub support_no_se: u64,
}

/// One tile visit made by [`SlowLoop::step`](super::SlowLoop::step)
/// (`diagnostics` builds, after
/// [`SlowLoop::set_visit_log`](super::SlowLoop::set_visit_log)). Visits run
/// as jobs (`step_via`, `take_job`) are not recorded.
#[cfg(feature = "diagnostics")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisitRecord {
    /// Frames observed when the visit was made.
    pub frame: u64,
    /// The tile visited (index into [`SlowLoop::tile_cores`](super::SlowLoop::tile_cores)).
    pub tile: u32,
    /// The edit scope could add cells (a Discover visit, not a settle one).
    pub grows: bool,
    /// Work units the visit spent, and its wall time in ns (0 on wasm).
    pub work: u64,
    pub ns: u64,
    /// Add proposals made, proposals that passed the held-out pre-test,
    /// cells added, and candidates absorbed into an existing cell.
    pub proposals: u32,
    pub pretest_pass: u32,
    pub adds: u32,
    pub absorbs: u32,
}

/// Counters of the concurrent settle ([`SlowLoop::observe_settle`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SettleStats {
    /// Re-read frames taken (fitting side, held-out side).
    pub frames_fit: u64,
    pub frames_test: u64,
    /// Work units of the settle frames.
    pub work: u64,
}

/// Counters of the joint update ([`JointUpdate`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReplayStats {
    /// Cluster sets built (the library's cell set changed), clusters built
    /// in them, and their members.
    pub builds: u64,
    pub clusters: u64,
    pub members: u64,
    /// Stores started over because a member's statistics disk left the
    /// cluster's pixels.
    pub restarts: u64,
    /// Stores moved to a member's new statistics disk by re-expression
    /// (history kept; new pixels start at the current model).
    pub moves: u64,
    /// Frames a cluster skipped (a missing pixel).
    pub skipped_frames: u64,
    /// Replays run, replays without a result (too few frames, singular),
    /// replays where no member's estimate was significant, replays whose
    /// estimate did not differ from the current footprints beyond its
    /// split-half noise.
    pub replays: u64,
    pub replay_none: u64,
    pub low_snr: u64,
    pub converged: u64,
    /// Cluster proposals gated, accepted, and members replaced.
    pub proposals: u64,
    pub accepted: u64,
    pub members_replaced: u64,
    /// Peak bytes held by the stores.
    pub peak_bytes: u64,
    /// DIAG (`diagnostics` builds only): wall time of the running
    /// footprint statistics, per-cell part and cluster part, ns.
    pub per_cell_ns: u64,
    pub cluster_ns: u64,
    /// Visit jobs (owner side): cluster stores sent, their bytes in the job
    /// encoding, the largest one, and the wall time (ns; not measured in
    /// wasm) of copying them into jobs and of applying the results back.
    pub job_stores: u64,
    pub job_store_bytes: u64,
    pub job_store_max: u64,
    pub job_copy_ns: u64,
    pub job_apply_ns: u64,
}

/// Slots per tile: `cfg.frames_per_tile`, or fewer if that does not fit in
/// `cfg.reservoir_max_bytes` (event patches per tile, random frames once
/// over `shared`, and the probes).
pub(super) fn plan_reservoir(cfg: &SlowLoopConfig, tiles: &[Tile], shared: Rect) -> ReservoirPlan {
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
