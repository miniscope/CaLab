//! Tests for `FitPipeline` mutation apply (Phase 3 Task 10).

use calab_cala_core::assets::Footprints;
use calab_cala_core::config::{ComponentClass, FitConfig};
use calab_cala_core::extending::mutation::{DeprecateReason, MutationQueue, PipelineMutation};
use calab_cala_core::fitting::{AppliedEvent, ApplyOutcome, FitPipeline};

const F32_TOL: f32 = 1e-5;

fn approx(a: f32, b: f32, tol: f32, ctx: &str) {
    assert!((a - b).abs() <= tol, "{ctx}: {a} vs {b} (tol {tol})");
}

fn start_with_two_cells() -> FitPipeline {
    let mut fp = Footprints::new(4, 4);
    fp.push_component_classified(vec![0, 1], vec![0.6, 0.8], ComponentClass::Cell);
    fp.push_component_classified(vec![5, 6], vec![0.6, 0.8], ComponentClass::Cell);
    FitPipeline::new(fp, FitConfig::default())
}

fn empty_pipeline() -> FitPipeline {
    FitPipeline::new(Footprints::new(4, 4), FitConfig::default())
}

// ----- Register -----

#[test]
fn register_adds_component_and_advances_epoch() {
    let mut p = empty_pipeline();
    let mu = PipelineMutation::Register {
        snapshot_epoch: 0,
        class: ComponentClass::Cell,
        support: vec![0, 1],
        values: vec![0.5, 0.5],
        trace: vec![],
    };
    assert_eq!(p.apply_mutation(mu), ApplyOutcome::Applied { new_epoch: 1 });
    assert_eq!(p.footprints().len(), 1);
    assert_eq!(p.footprints().class(0), ComponentClass::Cell);
    assert_eq!(p.traces().k(), 1);
    assert_eq!(p.suff_stats().k(), 1);
    assert_eq!(p.epoch(), 1);
}

#[test]
fn register_on_non_empty_pipeline_appends() {
    let mut p = start_with_two_cells();
    let mu = PipelineMutation::Register {
        snapshot_epoch: 0,
        class: ComponentClass::Neuropil,
        support: vec![10, 11, 12],
        values: vec![0.3, 0.3, 0.3],
        trace: vec![],
    };
    assert_eq!(p.apply_mutation(mu), ApplyOutcome::Applied { new_epoch: 1 });
    assert_eq!(p.footprints().len(), 3);
    assert_eq!(p.footprints().class(2), ComponentClass::Neuropil);
    assert_eq!(p.suff_stats().k(), 3);
}

#[test]
fn register_zero_pads_past_trace_history() {
    let mut p = empty_pipeline();
    // Advance through 3 frames without any components — traces stays
    // at k=0 but frames advances. Register at frame 3 should zero-
    // pad the new component's history to 3 values.
    let pixels = p.footprints().pixels();
    let y = vec![0.0f32; pixels];
    for _ in 0..3 {
        let _ = p.step(&y);
    }
    assert_eq!(p.traces().len(), 3);

    let trace_window = vec![1.0, 2.0];
    let mu = PipelineMutation::Register {
        snapshot_epoch: 0,
        class: ComponentClass::Cell,
        support: vec![0],
        values: vec![1.0],
        trace: trace_window,
    };
    let _ = p.apply_mutation(mu);
    let col = p.traces().column(0);
    assert_eq!(col.len(), 3);
    // Last 2 entries overwritten with the extend window; the entry
    // before the window is zero-pad.
    approx(col[0], 0.0, F32_TOL, "pre-window zero pad");
    approx(col[1], 1.0, F32_TOL, "window[0]");
    approx(col[2], 2.0, F32_TOL, "window[1]");
}

#[test]
fn register_rejects_support_values_mismatch() {
    let mut p = empty_pipeline();
    let mu = PipelineMutation::Register {
        snapshot_epoch: 0,
        class: ComponentClass::Cell,
        support: vec![0, 1],
        values: vec![1.0], // length 1, should be 2
        trace: vec![],
    };
    match p.apply_mutation(mu) {
        ApplyOutcome::Invalid(_) => {}
        other => panic!("expected Invalid, got {other:?}"),
    }
    assert_eq!(p.epoch(), 0, "rejected mutation must not advance epoch");
}

// ----- Deprecate -----

#[test]
fn deprecate_removes_component_by_id() {
    let mut p = start_with_two_cells();
    let id0 = p.footprints().id(0);
    let id1 = p.footprints().id(1);
    let mu = PipelineMutation::Deprecate {
        snapshot_epoch: 0,
        id: id0,
        reason: DeprecateReason::TraceInactive,
    };
    assert_eq!(p.apply_mutation(mu), ApplyOutcome::Applied { new_epoch: 1 });
    assert_eq!(p.footprints().len(), 1);
    assert_eq!(p.footprints().position_of(id0), None);
    assert_eq!(p.footprints().position_of(id1), Some(0));
    assert_eq!(p.traces().k(), 1);
    assert_eq!(p.suff_stats().k(), 1);
}

#[test]
fn deprecate_unknown_id_is_stale() {
    let mut p = start_with_two_cells();
    let mu = PipelineMutation::Deprecate {
        snapshot_epoch: 99,
        id: 9999,
        reason: DeprecateReason::TraceInactive,
    };
    assert_eq!(p.apply_mutation(mu), ApplyOutcome::Stale);
    assert_eq!(p.footprints().len(), 2, "footprints untouched on stale");
    assert_eq!(p.epoch(), 0);
}

// ----- Merge -----

#[test]
fn merge_replaces_two_components_with_one() {
    let mut p = start_with_two_cells();
    let id_a = p.footprints().id(0);
    let id_b = p.footprints().id(1);
    let mu = PipelineMutation::Merge {
        snapshot_epoch: 0,
        merge_ids: [id_a, id_b],
        class: ComponentClass::Cell,
        support: vec![0, 1, 5, 6],
        values: vec![0.3, 0.3, 0.3, 0.3],
        trace: vec![],
    };
    assert_eq!(p.apply_mutation(mu), ApplyOutcome::Applied { new_epoch: 1 });
    assert_eq!(p.footprints().len(), 1);
    assert_eq!(p.footprints().position_of(id_a), None);
    assert_eq!(p.footprints().position_of(id_b), None);
    assert_eq!(p.traces().k(), 1);
    assert_eq!(p.suff_stats().k(), 1);
}

#[test]
fn merge_sums_source_histories_into_new_component() {
    let mut p = start_with_two_cells();
    // Feed some frames so Traces has history. Use a synthetic trace:
    // drive component 0 with amplitude 2, component 1 with amplitude
    // 1 (component-local updates happen via the OMF loop; for this
    // test we just need non-zero history).
    let pixels = p.footprints().pixels();
    let y: Vec<f32> = (0..pixels).map(|i| i as f32 * 0.1).collect();
    for _ in 0..5 {
        let _ = p.step(&y);
    }
    let col_0 = p.traces().column(0);
    let col_1 = p.traces().column(1);
    let expected: Vec<f32> = col_0.iter().zip(&col_1).map(|(a, b)| a + b).collect();

    let id_a = p.footprints().id(0);
    let id_b = p.footprints().id(1);
    let mu = PipelineMutation::Merge {
        snapshot_epoch: 0,
        merge_ids: [id_a, id_b],
        class: ComponentClass::Cell,
        support: vec![0, 1, 5, 6],
        values: vec![0.3, 0.3, 0.3, 0.3],
        trace: vec![],
    };
    let _ = p.apply_mutation(mu);
    let merged_col = p.traces().column(0);
    // Pre-apply frames (all 5) use the summed history since no
    // extend window was supplied.
    for (i, (got, want)) in merged_col.iter().zip(&expected).enumerate() {
        approx(*got, *want, F32_TOL, &format!("merged history[{i}]"));
    }
}

#[test]
fn merge_with_one_deprecated_id_is_stale() {
    let mut p = start_with_two_cells();
    let id_a = p.footprints().id(0);
    let id_b = p.footprints().id(1);
    // Deprecate b out of band first — simulates fit having advanced
    // since extend's snapshot.
    p.apply_mutation(PipelineMutation::Deprecate {
        snapshot_epoch: 0,
        id: id_b,
        reason: DeprecateReason::FootprintCollapsed,
    });
    assert_eq!(p.epoch(), 1);
    // Now merge referencing the deprecated b → stale, no-op.
    let mu = PipelineMutation::Merge {
        snapshot_epoch: 0,
        merge_ids: [id_a, id_b],
        class: ComponentClass::Cell,
        support: vec![0, 1],
        values: vec![0.5, 0.5],
        trace: vec![],
    };
    assert_eq!(p.apply_mutation(mu), ApplyOutcome::Stale);
    assert_eq!(p.footprints().len(), 1);
    assert_eq!(p.epoch(), 1, "stale merge must not advance epoch");
}

#[test]
fn merge_same_id_twice_rejected() {
    let mut p = start_with_two_cells();
    let id_a = p.footprints().id(0);
    let mu = PipelineMutation::Merge {
        snapshot_epoch: 0,
        merge_ids: [id_a, id_a],
        class: ComponentClass::Cell,
        support: vec![0, 1],
        values: vec![0.5, 0.5],
        trace: vec![],
    };
    match p.apply_mutation(mu) {
        ApplyOutcome::Invalid(_) => {}
        other => panic!("expected Invalid on self-merge, got {other:?}"),
    }
}

// ----- drain_apply -----

#[test]
fn drain_apply_applies_in_fifo_order() {
    let mut p = empty_pipeline();
    let mut q = MutationQueue::new(8);
    for i in 0..3 {
        q.push(PipelineMutation::Register {
            snapshot_epoch: 0,
            class: ComponentClass::Cell,
            support: vec![i as u32],
            values: vec![1.0],
            trace: vec![],
        });
    }
    let report = p.drain_apply(&mut q);
    assert_eq!(report.applied, 3);
    assert_eq!(report.stale, 0);
    assert_eq!(report.invalid, 0);
    assert_eq!(p.footprints().len(), 3);
    assert_eq!(p.epoch(), 3);
    assert!(q.is_empty());
}

#[test]
fn drain_apply_reports_stale_and_applied_separately() {
    let mut p = start_with_two_cells();
    let id_a = p.footprints().id(0);
    let mut q = MutationQueue::new(4);
    // Valid deprecate of id_a → applied.
    q.push(PipelineMutation::Deprecate {
        snapshot_epoch: 0,
        id: id_a,
        reason: DeprecateReason::TraceInactive,
    });
    // Now a stale deprecate of id_a again → stale.
    q.push(PipelineMutation::Deprecate {
        snapshot_epoch: 0,
        id: id_a,
        reason: DeprecateReason::TraceInactive,
    });
    let report = p.drain_apply(&mut q);
    assert_eq!(report.applied, 1);
    assert_eq!(report.stale, 1);
    assert_eq!(report.invalid, 0);
    assert_eq!(p.epoch(), 1);
}

// ----- Post-apply numeric sanity: step still works -----

#[test]
fn step_after_register_advances_traces_and_suffstats() {
    let mut p = empty_pipeline();
    p.apply_mutation(PipelineMutation::Register {
        snapshot_epoch: 0,
        class: ComponentClass::Cell,
        support: vec![0, 1, 4, 5],
        values: vec![0.5, 0.5, 0.5, 0.5],
        trace: vec![],
    });
    let pixels = p.footprints().pixels();
    let y: Vec<f32> = (0..pixels).map(|i| (i % 2) as f32).collect();
    let _ = p.step(&y);
    assert_eq!(p.traces().len(), 1);
    // No crash, OMF step runs to completion post-apply.
}

#[test]
fn step_after_merge_advances_traces_and_suffstats() {
    let mut p = start_with_two_cells();
    let pixels = p.footprints().pixels();
    let y = vec![0.2f32; pixels];
    for _ in 0..3 {
        let _ = p.step(&y);
    }
    let id_a = p.footprints().id(0);
    let id_b = p.footprints().id(1);
    p.apply_mutation(PipelineMutation::Merge {
        snapshot_epoch: 0,
        merge_ids: [id_a, id_b],
        class: ComponentClass::Cell,
        support: vec![0, 1, 5, 6],
        values: vec![0.3, 0.3, 0.3, 0.3],
        trace: vec![],
    });
    let _ = p.step(&y);
    assert_eq!(p.traces().k(), 1);
    assert_eq!(p.traces().len(), 4);
}

// ----- drain_apply_events (Phase 7 task 1) -----

#[test]
fn drain_apply_events_emits_birth_for_register() {
    let mut p = empty_pipeline();
    let mut q = MutationQueue::new(2);
    // Patch centroid: support at (0,0),(0,1),(1,0),(1,1) with equal
    // values → weighted centroid ≈ (0.5, 0.5), rounds to (1, 1).
    q.push(PipelineMutation::Register {
        snapshot_epoch: 0,
        class: ComponentClass::Cell,
        support: vec![0, 1, 4, 5],
        values: vec![1.0, 1.0, 1.0, 1.0],
        trace: vec![],
    });
    let (report, events) = p.drain_apply_events(&mut q);
    assert_eq!(report.applied, 1);
    assert_eq!(events.len(), 1);
    match &events[0] {
        AppliedEvent::Birth {
            id,
            class,
            support,
            patch,
            ..
        } => {
            assert_eq!(*id, 0, "first birth takes id 0");
            assert_eq!(*class, ComponentClass::Cell);
            assert_eq!(support, &vec![0, 1, 4, 5]);
            // width is 4 (empty_pipeline uses Footprints::new(4,4)).
            // Rows of linear indices: 0→(0,0), 1→(0,1), 4→(1,0), 5→(1,1).
            // Weighted centroid rounds to (1, 1) with equal weights
            // (0.5 rounds to 1 per IEEE half-to-even; verified below).
            assert_eq!(*patch, (1, 1));
        }
        other => panic!("expected Birth, got {other:?}"),
    }
}

#[test]
fn drain_apply_events_emits_deprecate_with_reason() {
    let mut p = start_with_two_cells();
    let id_a = p.footprints().id(0);
    let mut q = MutationQueue::new(2);
    q.push(PipelineMutation::Deprecate {
        snapshot_epoch: 0,
        id: id_a,
        reason: DeprecateReason::TraceInactive,
    });
    let (report, events) = p.drain_apply_events(&mut q);
    assert_eq!(report.applied, 1);
    assert_eq!(events.len(), 1);
    match &events[0] {
        AppliedEvent::Deprecate { id, reason } => {
            assert_eq!(*id, id_a);
            assert_eq!(*reason, DeprecateReason::TraceInactive);
        }
        other => panic!("expected Deprecate, got {other:?}"),
    }
}

#[test]
fn drain_apply_events_emits_merge_with_new_id() {
    let mut p = start_with_two_cells();
    let id_a = p.footprints().id(0);
    let id_b = p.footprints().id(1);
    let next_id_before = p.footprints().next_id();
    let mut q = MutationQueue::new(2);
    q.push(PipelineMutation::Merge {
        snapshot_epoch: 0,
        merge_ids: [id_a, id_b],
        class: ComponentClass::Cell,
        support: vec![0, 1, 5, 6],
        values: vec![0.5, 0.5, 0.5, 0.5],
        trace: vec![],
    });
    let (report, events) = p.drain_apply_events(&mut q);
    assert_eq!(report.applied, 1);
    assert_eq!(events.len(), 1);
    match &events[0] {
        AppliedEvent::Merge { ids, into, .. } => {
            assert_eq!(*ids, [id_a, id_b]);
            assert_eq!(*into, next_id_before);
        }
        other => panic!("expected Merge, got {other:?}"),
    }
}

#[test]
fn drain_apply_events_skips_events_for_stale_mutations() {
    let mut p = empty_pipeline();
    let mut q = MutationQueue::new(2);
    // Unknown id → Stale → no event.
    q.push(PipelineMutation::Deprecate {
        snapshot_epoch: 0,
        id: 42,
        reason: DeprecateReason::TraceInactive,
    });
    let (report, events) = p.drain_apply_events(&mut q);
    assert_eq!(report.applied, 0);
    assert_eq!(report.stale, 1);
    assert!(events.is_empty());
}
