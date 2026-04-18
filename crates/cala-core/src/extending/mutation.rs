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

/// Bounded FIFO mutation queue with drop-oldest backpressure
/// (design §7.3, Phase 3 Task 9).
///
/// Single-threaded harness stand-in for the real SAB ring used by the
/// Phase 5 worker runtime. Exposes the same protocol surface —
/// bounded push, FIFO drain, drop counter — so fit-side apply
/// (Task 10) and extend's publish path (later phases) can be exercised
/// without workers.
#[derive(Debug)]
pub struct MutationQueue {
    capacity: usize,
    buf: std::collections::VecDeque<PipelineMutation>,
    drops: u64,
}

impl MutationQueue {
    /// Allocate a queue with the given capacity. Capacity must be ≥ 1
    /// (a zero-capacity queue is useless and would turn every push
    /// into a drop).
    pub fn new(capacity: usize) -> Self {
        assert!(capacity >= 1, "capacity must be ≥ 1 (got {capacity})");
        Self {
            capacity,
            buf: std::collections::VecDeque::with_capacity(capacity),
            drops: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn is_full(&self) -> bool {
        self.buf.len() == self.capacity
    }

    /// Total mutations dropped due to overflow since construction.
    pub fn drops(&self) -> u64 {
        self.drops
    }

    /// Append a mutation. If the queue is at capacity, the oldest
    /// mutation is discarded and `drops` advances by 1.
    pub fn push(&mut self, m: PipelineMutation) {
        if self.buf.len() == self.capacity {
            self.buf.pop_front();
            self.drops = self.drops.saturating_add(1);
        }
        self.buf.push_back(m);
    }

    /// Pop the oldest queued mutation, or `None` when empty.
    pub fn pop(&mut self) -> Option<PipelineMutation> {
        self.buf.pop_front()
    }

    /// FIFO draining iterator. Consumes the entire queue.
    pub fn drain(&mut self) -> std::collections::vec_deque::Drain<'_, PipelineMutation> {
        self.buf.drain(..)
    }
}
