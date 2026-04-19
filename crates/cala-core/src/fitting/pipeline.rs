//! Per-frame OMF step composing the primitive fit nodes
//! (thesis §3.2.3, Algorithm 6).
//!
//! Pipeline order:
//! 1. `EvaluateTraces`        — NNLS-BCD for `c̃_t` given current `Ã`
//! 2. Residual for throttling — `R_raw = y_t − Ã c̃_t`
//! 3. `trace_throttle`        — Eq. 3.39 underfit correction
//! 4. Append corrected `c̃_t` to trace history
//! 5. `EvaluateSuffStats`     — recursive-mean update of `W`, `M`
//! 6. `EvaluateFootprints`    — CD update of `Ã` from `W`, `M`
//! 7. Final residual           — `R_t = y_t − Ã_new c̃_t` (output for Extend)
//!
//! Throttle placement note: the thesis describes throttling as
//! "during the residual computation" (step 7 of Alg 6). We apply it
//! *before* the suff-stats and footprint updates so those see the
//! corrected traces — same end state, but `W`/`M` do not accumulate
//! the over-estimated pre-throttle traces, which matches the "data
//! cleaning" framing at the end of thesis §3.2.3.

use crate::assets::{Footprints, Groups, SuffStats, Traces};
use crate::config::{ComponentClass, FitConfig};
use crate::extending::mutation::{
    DeprecateReason, Epoch, MutationQueue, PipelineMutation, Snapshot,
};

use super::{
    evaluate_footprints, evaluate_residual, evaluate_suff_stats, evaluate_traces, trace_throttle,
};

/// Holds all persistent OMF state and runs one frame per `step`.
#[derive(Debug)]
pub struct FitPipeline {
    fp: Footprints,
    traces: Traces,
    ss: SuffStats,
    cfg: FitConfig,
    /// Scratch buffer for the residual — reused across frames to avoid
    /// per-frame allocation in the fit hot path.
    residual: Vec<f32>,
    /// Monotonic counter that advances every time the fit side applies
    /// a `PipelineMutation` (Phase 3 Task 10). Per-frame `step` calls
    /// do not bump the epoch — epoch only tracks structural changes
    /// to `(Ã, C̃, W, M, G)`, not numeric updates.
    epoch: Epoch,
}

impl FitPipeline {
    pub fn new(fp: Footprints, cfg: FitConfig) -> Self {
        let k = fp.len();
        let pixels = fp.pixels();
        Self {
            traces: Traces::new(k),
            ss: SuffStats::new(pixels, k),
            residual: vec![0.0f32; pixels],
            fp,
            cfg,
            epoch: 0,
        }
    }

    /// Current asset epoch — advances on every mutation apply.
    pub fn epoch(&self) -> Epoch {
        self.epoch
    }

    /// Deep-clone of the extend-visible state `(Ã, W, M, epoch)`
    /// (design §7.2). `C̃` is not part of the snapshot — extend
    /// reads only the most recent window from the residual ring and
    /// per-component traces it is passed explicitly.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot::new(self.fp.clone(), self.ss.clone(), self.epoch)
    }

    /// Apply one mutation atomically, extending `(Ã, C̃, W, M)` in a
    /// single step and bumping the epoch on success. Groups are
    /// rebuilt each `step` so no direct `G` surgery is needed here.
    ///
    /// Returns `Applied { new_epoch }` on success, `Stale` when the
    /// mutation references ids that have been deprecated since its
    /// snapshot, or `Invalid` on self-inconsistent input.
    pub fn apply_mutation(&mut self, mutation: PipelineMutation) -> ApplyOutcome {
        match mutation {
            PipelineMutation::Register {
                class,
                support,
                values,
                trace,
                ..
            } => self.apply_register(class, support, values, trace),
            PipelineMutation::Merge {
                merge_ids,
                class,
                support,
                values,
                trace,
                ..
            } => self.apply_merge(merge_ids, class, support, values, trace),
            PipelineMutation::Deprecate { id, .. } => self.apply_deprecate(id),
        }
    }

    /// Drain a mutation queue and apply each mutation in FIFO order.
    /// Returns `(applied, stale)` counts; `invalid` rejections are
    /// lumped with `stale` (the archive metrics surface both as
    /// "dropped on apply" in Phase 6).
    pub fn drain_apply(&mut self, queue: &mut MutationQueue) -> ApplyBatchReport {
        let mut applied = 0u32;
        let mut stale = 0u32;
        let mut invalid = 0u32;
        for m in queue.drain() {
            match self.apply_mutation(m) {
                ApplyOutcome::Applied { .. } => applied += 1,
                ApplyOutcome::Stale => stale += 1,
                ApplyOutcome::Invalid(_) => invalid += 1,
            }
        }
        ApplyBatchReport {
            applied,
            stale,
            invalid,
        }
    }

    /// Drain a mutation queue like `drain_apply`, but also return an
    /// `AppliedEvent` per successfully-applied mutation. This is what
    /// W2 uses to surface real `birth`/`merge`/`deprecate` events on
    /// the pipeline bus (Phase 7 task 1) instead of the Phase 6
    /// placeholder metric.
    pub fn drain_apply_events(
        &mut self,
        queue: &mut MutationQueue,
    ) -> (ApplyBatchReport, Vec<AppliedEvent>) {
        let width = self.fp.width();
        let mut report = ApplyBatchReport::default();
        let mut events = Vec::new();
        for m in queue.drain() {
            // Inspect before moving. We clone the small `Vec<u32>` /
            // `Vec<f32>` payloads so we can emit them in the event
            // regardless of whether apply succeeds — see below for
            // the success gate.
            let preview = AppliedEventPreview::from_mutation(&m, self.fp.next_id(), width);
            match self.apply_mutation(m) {
                ApplyOutcome::Applied { .. } => {
                    report.applied += 1;
                    events.push(preview.into_event());
                }
                ApplyOutcome::Stale => report.stale += 1,
                ApplyOutcome::Invalid(_) => report.invalid += 1,
            }
        }
        (report, events)
    }

    fn apply_register(
        &mut self,
        class: ComponentClass,
        support: Vec<u32>,
        values: Vec<f32>,
        trace: Vec<f32>,
    ) -> ApplyOutcome {
        if support.len() != values.len() {
            return ApplyOutcome::Invalid("support / values length mismatch");
        }
        self.fp.push_component_classified(support, values, class);
        let history = build_new_component_history(self.traces.len(), &trace, None);
        self.traces.insert_component_with_history(&history);
        self.ss.insert_empty_component();
        self.epoch += 1;
        ApplyOutcome::Applied {
            new_epoch: self.epoch,
        }
    }

    fn apply_merge(
        &mut self,
        merge_ids: [u32; 2],
        class: ComponentClass,
        support: Vec<u32>,
        values: Vec<f32>,
        trace: Vec<f32>,
    ) -> ApplyOutcome {
        if support.len() != values.len() {
            return ApplyOutcome::Invalid("support / values length mismatch");
        }
        if merge_ids[0] == merge_ids[1] {
            return ApplyOutcome::Invalid("merge ids must differ");
        }
        let (pos_a, pos_b) = match (
            self.fp.position_of(merge_ids[0]),
            self.fp.position_of(merge_ids[1]),
        ) {
            (Some(a), Some(b)) => (a, b),
            _ => return ApplyOutcome::Stale,
        };

        // Pre-compute merged pre-window history = column_a + column_b.
        // The column read happens before we mutate Traces so indices
        // are still valid.
        let column_a = self.traces.column(pos_a);
        let column_b = self.traces.column(pos_b);
        let summed_history: Vec<f32> = column_a.iter().zip(&column_b).map(|(a, b)| a + b).collect();

        // Remove higher index first so the lower index stays stable.
        let (first, second) = if pos_a > pos_b {
            (pos_a, pos_b)
        } else {
            (pos_b, pos_a)
        };
        self.fp.deprecate_by_id(merge_ids[0]);
        self.fp.deprecate_by_id(merge_ids[1]);
        self.traces.remove_component(first);
        self.traces.remove_component(second);
        self.ss.remove_component(first);
        self.ss.remove_component(second);

        // Register the merged component.
        self.fp.push_component_classified(support, values, class);
        let history = build_new_component_history(self.traces.len(), &trace, Some(summed_history));
        self.traces.insert_component_with_history(&history);
        self.ss.insert_empty_component();

        self.epoch += 1;
        ApplyOutcome::Applied {
            new_epoch: self.epoch,
        }
    }

    fn apply_deprecate(&mut self, id: u32) -> ApplyOutcome {
        let Some(pos) = self.fp.position_of(id) else {
            return ApplyOutcome::Stale;
        };
        self.fp.deprecate_by_id(id);
        self.traces.remove_component(pos);
        self.ss.remove_component(pos);
        self.epoch += 1;
        ApplyOutcome::Applied {
            new_epoch: self.epoch,
        }
    }

    pub fn footprints(&self) -> &Footprints {
        &self.fp
    }

    pub fn traces(&self) -> &Traces {
        &self.traces
    }

    pub fn suff_stats(&self) -> &SuffStats {
        &self.ss
    }

    pub fn config(&self) -> &FitConfig {
        &self.cfg
    }

    /// Most recent residual frame (length `pixels()`).
    pub fn last_residual(&self) -> &[f32] {
        &self.residual
    }

    /// Run one OMF frame. Returns the residual `R_t` so callers can
    /// feed it to an Extend loop (Phase 3) or inspect for diagnostics.
    pub fn step(&mut self, y: &[f32]) -> &[f32] {
        assert_eq!(
            y.len(),
            self.fp.pixels(),
            "y length {} must equal pixels {}",
            y.len(),
            self.fp.pixels()
        );

        // 1. Trace update (NNLS-BCD grouped by spatial overlap).
        //    Groups are rebuilt each frame because `EvaluateFootprints`
        //    may have shrunk support on the previous frame, which in
        //    turn can split a group into disjoint ones.
        let c_prev: Vec<f32> = match self.traces.last() {
            Some(prev) => prev.to_vec(),
            None => vec![0.0f32; self.fp.len()],
        };
        let groups = Groups::from_footprints(&self.fp);
        let mut c = evaluate_traces(&self.fp, &groups, y, &c_prev, &self.cfg);

        // 2. Residual for throttle (against current Ã — this frame's
        //    footprint update has not happened yet).
        evaluate_residual(&self.fp, &c, y, &mut self.residual);

        // 3. Underfit correction.
        trace_throttle(&self.fp, &mut c, &self.residual);

        // 4. Record corrected trace in history.
        self.traces.push(&c);

        // 5–6. Learn from the corrected trace.
        evaluate_suff_stats(&mut self.ss, y, &c, &self.cfg);
        evaluate_footprints(&mut self.fp, &self.ss, &self.cfg);

        // 7. Final residual. Post-throttle c, post-update Ã — the
        //    frame-t residual the Extend loop will consume.
        evaluate_residual(&self.fp, &c, y, &mut self.residual);
        &self.residual
    }
}

/// Per-mutation outcome reported by `FitPipeline::apply_mutation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// Mutation applied; `new_epoch` is the epoch after advancing.
    Applied { new_epoch: Epoch },
    /// Mutation dropped because one of its referenced ids is no
    /// longer live. Extend will retry with a fresh snapshot.
    Stale,
    /// Mutation was self-inconsistent (shape mismatch, degenerate
    /// merge, etc). `'static` reason string for logging.
    Invalid(&'static str),
}

/// Aggregated outcome of `FitPipeline::drain_apply`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ApplyBatchReport {
    pub applied: u32,
    pub stale: u32,
    pub invalid: u32,
}

/// Per-mutation payload returned alongside the apply outcome by
/// [`FitPipeline::drain_apply_events`]. Maps 1:1 onto the JS-side
/// `PipelineEvent` birth/merge/deprecate variants (§9.2). Kept in this
/// module (not the runtime `events.ts`) because it is the Rust
/// structural shape — the WASM binding converts to a JS value at the
/// boundary. Serde attrs target the JS event shape directly so
/// `serde_wasm_bindgen::to_value` produces `{kind:"birth", ...}` etc.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(tag = "kind", rename_all = "camelCase"))]
pub enum AppliedEvent {
    Birth {
        id: u32,
        class: ComponentClass,
        support: Vec<u32>,
        values: Vec<f32>,
        patch: (u32, u32),
    },
    Merge {
        ids: [u32; 2],
        into: u32,
        class: ComponentClass,
        support: Vec<u32>,
        values: Vec<f32>,
    },
    Deprecate {
        id: u32,
        reason: DeprecateReason,
    },
}

/// Lightweight projection of a `PipelineMutation` captured *before*
/// `apply_mutation` consumes it. Lets `drain_apply_events` emit a
/// fully-populated `AppliedEvent` without re-reading the mutation
/// after it has been moved into apply.
enum AppliedEventPreview {
    Birth {
        id: u32,
        class: ComponentClass,
        support: Vec<u32>,
        values: Vec<f32>,
        patch: (u32, u32),
    },
    Merge {
        ids: [u32; 2],
        into: u32,
        class: ComponentClass,
        support: Vec<u32>,
        values: Vec<f32>,
    },
    Deprecate {
        id: u32,
        reason: DeprecateReason,
    },
}

impl AppliedEventPreview {
    fn from_mutation(m: &PipelineMutation, next_id: u32, width: usize) -> Self {
        match m {
            PipelineMutation::Register {
                class,
                support,
                values,
                ..
            } => Self::Birth {
                id: next_id,
                class: *class,
                support: support.clone(),
                values: values.clone(),
                patch: weighted_centroid(support, values, width),
            },
            PipelineMutation::Merge {
                merge_ids,
                class,
                support,
                values,
                ..
            } => Self::Merge {
                ids: *merge_ids,
                // Merge deprecates both ids and then registers one new
                // component — the surviving id is whatever `next_id`
                // the registration consumes. `apply_merge` pushes
                // after both deprecates, so the id at that moment is
                // `next_id` captured here.
                into: next_id,
                class: *class,
                support: support.clone(),
                values: values.clone(),
            },
            PipelineMutation::Deprecate { id, reason, .. } => Self::Deprecate {
                id: *id,
                reason: *reason,
            },
        }
    }

    fn into_event(self) -> AppliedEvent {
        match self {
            Self::Birth {
                id,
                class,
                support,
                values,
                patch,
            } => AppliedEvent::Birth {
                id,
                class,
                support,
                values,
                patch,
            },
            Self::Merge {
                ids,
                into,
                class,
                support,
                values,
            } => AppliedEvent::Merge {
                ids,
                into,
                class,
                support,
                values,
            },
            Self::Deprecate { id, reason } => AppliedEvent::Deprecate { id, reason },
        }
    }
}

/// Weighted centroid of a sparse footprint in (row, col) frame coords.
/// Used as the `patch` anchor on birth events. Empty support returns
/// `(0, 0)` — caller is expected to filter on support.is_empty(), but
/// we avoid NaN here so event delivery never stalls on degenerate data.
fn weighted_centroid(support: &[u32], values: &[f32], width: usize) -> (u32, u32) {
    let w = width as f32;
    let mut wsum = 0.0f32;
    let mut y_acc = 0.0f32;
    let mut x_acc = 0.0f32;
    for (idx, v) in support.iter().zip(values.iter()) {
        let y = (*idx as f32 / w).floor();
        let x = *idx as f32 - y * w;
        y_acc += y * v;
        x_acc += x * v;
        wsum += v;
    }
    if wsum <= 0.0 {
        return (0, 0);
    }
    ((y_acc / wsum).round() as u32, (x_acc / wsum).round() as u32)
}

/// Construct the per-frame history vector for a newly registered or
/// merged component. Pre-window frames are filled with
/// `prewindow_fill` (zero for fresh discoveries, summed source
/// histories for merges); the last `min(window.len(), frames)`
/// positions are overwritten with the extend-supplied window trace.
fn build_new_component_history(
    frames: usize,
    window_trace: &[f32],
    prewindow_fill: Option<Vec<f32>>,
) -> Vec<f32> {
    let mut history = prewindow_fill.unwrap_or_else(|| vec![0.0f32; frames]);
    assert_eq!(
        history.len(),
        frames,
        "prewindow_fill length {} must match frames {}",
        history.len(),
        frames
    );
    let window_len = window_trace.len().min(frames);
    let start = frames - window_len;
    history[start..frames].copy_from_slice(&window_trace[window_trace.len() - window_len..]);
    history
}
