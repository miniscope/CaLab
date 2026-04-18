//! Pipeline mutations and the fit ↔ extend snapshot protocol
//! (design §7.2–§7.3, Phase 3 Task 8).
//!
//! Extend never writes to fit's state directly. Every discovered
//! change is published as a [`PipelineMutation`] tagged with the
//! asset epoch it was computed against. Fit applies mutations at
//! the next frame boundary (Task 10), incrementing the epoch as it
//! goes, and drops any mutation whose `snapshot_epoch` references a
//! state that no longer exists (e.g. one of a `Merge`'s ids has
//! been deprecated since).
//!
//! `Epoch` is a `u64` counter. At 60 fps of extend cycles with ~4
//! apply events per cycle, 2⁶⁴ comfortably exceeds universe
//! lifetimes — no wraparound concern.

use crate::assets::{Footprints, SuffStats};
use crate::config::ComponentClass;

/// Monotonic asset-state counter incremented by every mutation apply.
pub type Epoch = u64;

/// One self-contained change to the model state. Carries its own
/// snapshot epoch so fit can decide whether to apply or discard.
#[derive(Debug, Clone)]
pub enum PipelineMutation {
    /// Register a new component with the given class, support,
    /// values, and trace over the extend window.
    Register {
        snapshot_epoch: Epoch,
        class: ComponentClass,
        support: Vec<u32>,
        values: Vec<f32>,
        trace: Vec<f32>,
    },
    /// Deprecate two existing components and register one merged
    /// component in their place. The merged footprint + trace came
    /// out of a reconstructed-movie rank-1 NMF (Task 7).
    Merge {
        snapshot_epoch: Epoch,
        merge_ids: [u32; 2],
        class: ComponentClass,
        support: Vec<u32>,
        values: Vec<f32>,
        trace: Vec<f32>,
    },
    /// Deprecate a component. Used by curation passes
    /// (footprint-collapse cleanup, near-zero-trace drops).
    Deprecate {
        snapshot_epoch: Epoch,
        id: u32,
        reason: DeprecateReason,
    },
}

impl PipelineMutation {
    pub fn snapshot_epoch(&self) -> Epoch {
        match self {
            Self::Register { snapshot_epoch, .. }
            | Self::Merge { snapshot_epoch, .. }
            | Self::Deprecate { snapshot_epoch, .. } => *snapshot_epoch,
        }
    }
}

/// Why a component is being deprecated. `'static` so mutations stay
/// cheap to clone and transport across channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeprecateReason {
    /// Footprint shrank to empty support during `EvaluateFootprints`.
    FootprintCollapsed,
    /// Trace amplitude stayed at zero for longer than the curation
    /// horizon — likely a false positive from a noisy cycle.
    TraceInactive,
    /// Merged into another component (the surviving one is published
    /// as a `Merge` mutation).
    MergedInto,
    /// Rejected by a post-apply sanity check on the fit side.
    InvalidApply,
}

/// Copy-on-write snapshot of the asset state extend reads from.
///
/// Phase 3 ships a full deep-clone of `(A, W, M)` per snapshot —
/// cheap at the sizes we target (sparse A, small K on W/M). Design
/// §7.2's row-level copy-on-write optimization is a profile-gated
/// future refinement; the protocol surface stays the same.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub footprints: Footprints,
    pub suff_stats: SuffStats,
    pub epoch: Epoch,
}

impl Snapshot {
    /// Construct a snapshot from the current fit state + epoch.
    pub fn new(footprints: Footprints, suff_stats: SuffStats, epoch: Epoch) -> Self {
        Self {
            footprints,
            suff_stats,
            epoch,
        }
    }
}
