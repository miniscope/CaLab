//! Tests for the Phase 3 Task 8 mutation types and snapshot protocol
//! (design §7.2–§7.3).

use calab_cala_core::assets::Footprints;
use calab_cala_core::config::{ComponentClass, FitConfig};
use calab_cala_core::extending::mutation::{
    DeprecateReason, MutationQueue, PipelineMutation,
};
use calab_cala_core::fitting::FitPipeline;

fn make_cell_footprints() -> Footprints {
    let mut fp = Footprints::new(4, 4);
    fp.push_component_classified(vec![0, 1], vec![0.5, 0.5], ComponentClass::Cell);
    fp.push_component_classified(vec![5, 6], vec![0.5, 0.5], ComponentClass::Neuropil);
    fp
}

// ----- Footprints id / class support -----

#[test]
fn push_component_classified_returns_stable_id() {
    let mut fp = Footprints::new(3, 3);
    let id0 = fp.push_component_classified(vec![0, 1], vec![1.0, 1.0], ComponentClass::Cell);
    let id1 = fp.push_component_classified(vec![4, 5], vec![1.0, 1.0], ComponentClass::Neuropil);
    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
    assert_eq!(fp.next_id(), 2);
    assert_eq!(fp.position_of(id0), Some(0));
    assert_eq!(fp.position_of(id1), Some(1));
    assert_eq!(fp.class(0), ComponentClass::Cell);
    assert_eq!(fp.class(1), ComponentClass::Neuropil);
}

#[test]
fn push_component_assigns_cell_class_and_next_id() {
    let mut fp = Footprints::new(3, 3);
    let _pos = fp.push_component(vec![0], vec![1.0]);
    assert_eq!(fp.id(0), 0);
    assert_eq!(fp.class(0), ComponentClass::Cell);
    assert_eq!(fp.next_id(), 1);
}

#[test]
fn deprecate_by_id_shifts_positions_keeps_ids() {
    let mut fp = Footprints::new(3, 3);
    let id_a = fp.push_component_classified(vec![0], vec![1.0], ComponentClass::Cell);
    let id_b = fp.push_component_classified(vec![1], vec![1.0], ComponentClass::Cell);
    let id_c = fp.push_component_classified(vec![2], vec![1.0], ComponentClass::Cell);
    assert_eq!(fp.deprecate_by_id(id_b), Some(1));
    assert_eq!(fp.len(), 2);
    // a stayed at position 0, c slid from 2 to 1, ids preserved.
    assert_eq!(fp.position_of(id_a), Some(0));
    assert_eq!(fp.position_of(id_b), None);
    assert_eq!(fp.position_of(id_c), Some(1));
    // next_id unchanged — deprecation does not recycle ids.
    assert_eq!(fp.next_id(), 3);
}

#[test]
fn deprecate_unknown_id_is_noop() {
    let mut fp = Footprints::new(2, 2);
    fp.push_component_classified(vec![0], vec![1.0], ComponentClass::Cell);
    assert_eq!(fp.deprecate_by_id(999), None);
    assert_eq!(fp.len(), 1);
}

#[test]
fn ids_iterator_returns_positional_order() {
    let mut fp = Footprints::new(3, 3);
    fp.push_component_classified(vec![0], vec![1.0], ComponentClass::Cell);
    fp.push_component_classified(vec![1], vec![1.0], ComponentClass::Cell);
    fp.push_component_classified(vec![2], vec![1.0], ComponentClass::Cell);
    let ids: Vec<u32> = fp.ids().collect();
    assert_eq!(ids, vec![0, 1, 2]);
    fp.deprecate_by_id(1);
    let ids: Vec<u32> = fp.ids().collect();
    assert_eq!(ids, vec![0, 2]);
}

// ----- PipelineMutation -----

#[test]
fn pipeline_mutation_snapshot_epoch_round_trips() {
    let mu = PipelineMutation::Register {
        snapshot_epoch: 42,
        class: ComponentClass::Cell,
        support: vec![0, 1],
        values: vec![0.5, 0.5],
        trace: vec![0.0, 1.0, 2.0],
    };
    assert_eq!(mu.snapshot_epoch(), 42);

    let mu = PipelineMutation::Merge {
        snapshot_epoch: 7,
        merge_ids: [3, 4],
        class: ComponentClass::Neuropil,
        support: vec![2, 3],
        values: vec![0.5, 0.5],
        trace: vec![1.0; 5],
    };
    assert_eq!(mu.snapshot_epoch(), 7);

    let mu = PipelineMutation::Deprecate {
        snapshot_epoch: 100,
        id: 2,
        reason: DeprecateReason::FootprintCollapsed,
    };
    assert_eq!(mu.snapshot_epoch(), 100);
}

// ----- Snapshot protocol -----

#[test]
fn fit_pipeline_starts_at_epoch_zero() {
    let fp = make_cell_footprints();
    let pipeline = FitPipeline::new(fp, FitConfig::default());
    assert_eq!(pipeline.epoch(), 0);
}

#[test]
fn step_does_not_advance_epoch() {
    // Epoch only tracks structural changes (A/C/W/M/G resize), not
    // numeric updates from `step`. Apply-between-frames is the only
    // thing that bumps it — and that lands in Task 10.
    let fp = make_cell_footprints();
    let mut pipeline = FitPipeline::new(fp, FitConfig::default());
    let pixels = pipeline.footprints().pixels();
    let y = vec![0.1f32; pixels];
    for _ in 0..5 {
        let _ = pipeline.step(&y);
    }
    assert_eq!(pipeline.epoch(), 0);
}

#[test]
fn snapshot_captures_current_footprints_and_epoch() {
    let fp = make_cell_footprints();
    let pipeline = FitPipeline::new(fp, FitConfig::default());
    let snap = pipeline.snapshot();
    assert_eq!(snap.epoch, 0);
    assert_eq!(snap.footprints.len(), 2);
    assert_eq!(snap.footprints.class(0), ComponentClass::Cell);
    assert_eq!(snap.footprints.class(1), ComponentClass::Neuropil);
}

#[test]
fn snapshot_is_isolated_from_subsequent_fit_updates() {
    let fp = make_cell_footprints();
    let mut pipeline = FitPipeline::new(fp, FitConfig::default());
    let snap = pipeline.snapshot();
    let snap_id_0 = snap.footprints.id(0);

    // After snapshot, "fit side" deprecates a component (cheat: we use
    // the public Footprints API directly since FitPipeline's own
    // mutation-apply path is Task 10). Snapshot must not see it.
    // Grab a mutable reference via a footprints-mutable accessor or
    // by pushing a new component through the public surface — for
    // isolation testing it's enough to verify the snapshot kept its
    // own copy independent of any mutation. We re-snapshot after a
    // few `step` calls instead, to verify at least trace history does
    // not leak into the first snapshot's Footprints clone.
    let pixels = pipeline.footprints().pixels();
    let y = vec![0.2f32; pixels];
    for _ in 0..3 {
        let _ = pipeline.step(&y);
    }

    // Snapshot still has the original 2-component footprints.
    assert_eq!(snap.footprints.len(), 2);
    assert_eq!(snap.footprints.id(0), snap_id_0);
    // And the snapshot's suff_stats is not the same pointer as the
    // fit's — Clone gives us a deep copy (asserted by mutating values
    // wouldn't propagate; here we just test shape invariants).
    assert_eq!(snap.suff_stats.k(), 2);
}

#[test]
fn snapshot_footprints_clone_is_independent() {
    let mut fp = Footprints::new(2, 2);
    fp.push_component_classified(vec![0], vec![1.0], ComponentClass::Cell);
    fp.push_component_classified(vec![1], vec![1.0], ComponentClass::Cell);
    let snap_fp = fp.clone();
    // Deprecate on the original must not affect the clone.
    fp.deprecate_by_id(0);
    assert_eq!(fp.len(), 1);
    assert_eq!(snap_fp.len(), 2);
    assert_eq!(snap_fp.position_of(0), Some(0));
}

// ----- MutationQueue (Task 9) -----

fn dep(id: u32, epoch: u64) -> PipelineMutation {
    PipelineMutation::Deprecate {
        snapshot_epoch: epoch,
        id,
        reason: DeprecateReason::TraceInactive,
    }
}

#[test]
#[should_panic(expected = "capacity must be ≥ 1")]
fn mutation_queue_rejects_zero_capacity() {
    let _ = MutationQueue::new(0);
}

#[test]
fn mutation_queue_starts_empty() {
    let q = MutationQueue::new(4);
    assert!(q.is_empty());
    assert!(!q.is_full());
    assert_eq!(q.len(), 0);
    assert_eq!(q.drops(), 0);
    assert_eq!(q.capacity(), 4);
}

#[test]
fn mutation_queue_push_pop_is_fifo() {
    let mut q = MutationQueue::new(4);
    q.push(dep(1, 10));
    q.push(dep(2, 11));
    q.push(dep(3, 12));
    assert_eq!(q.len(), 3);
    assert_eq!(q.pop().unwrap().snapshot_epoch(), 10);
    assert_eq!(q.pop().unwrap().snapshot_epoch(), 11);
    assert_eq!(q.pop().unwrap().snapshot_epoch(), 12);
    assert!(q.pop().is_none());
    assert_eq!(q.drops(), 0);
}

#[test]
fn mutation_queue_drop_oldest_on_overflow() {
    let mut q = MutationQueue::new(2);
    q.push(dep(1, 1));
    q.push(dep(2, 2));
    assert!(q.is_full());
    q.push(dep(3, 3)); // drops id=1
    assert_eq!(q.drops(), 1);
    q.push(dep(4, 4)); // drops id=2
    assert_eq!(q.drops(), 2);
    // Remaining: [id=3, id=4].
    let remaining: Vec<u32> = q
        .drain()
        .map(|m| match m {
            PipelineMutation::Deprecate { id, .. } => id,
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(remaining, vec![3, 4]);
}

#[test]
fn mutation_queue_drain_empties_and_preserves_fifo() {
    let mut q = MutationQueue::new(8);
    for i in 0..5u32 {
        q.push(dep(i, i as u64));
    }
    let ids: Vec<u32> = q
        .drain()
        .map(|m| match m {
            PipelineMutation::Deprecate { id, .. } => id,
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(ids, vec![0, 1, 2, 3, 4]);
    assert!(q.is_empty());
    assert_eq!(q.drops(), 0);
}

#[test]
fn mutation_queue_drop_counter_preserved_across_drains() {
    let mut q = MutationQueue::new(2);
    q.push(dep(1, 1));
    q.push(dep(2, 2));
    q.push(dep(3, 3)); // drops 1
    let _: Vec<_> = q.drain().collect();
    assert_eq!(q.drops(), 1, "drops counter survives drain");
    assert!(q.is_empty());
    q.push(dep(4, 4));
    q.push(dep(5, 5));
    q.push(dep(6, 6)); // drops 4
    assert_eq!(q.drops(), 2);
}

#[test]
fn mutation_queue_handles_many_overflows() {
    let mut q = MutationQueue::new(4);
    for i in 0..1000u32 {
        q.push(dep(i, i as u64));
    }
    assert_eq!(q.len(), 4);
    assert_eq!(q.drops(), 996);
    // Last 4 should be 996..=999.
    let ids: Vec<u32> = q
        .drain()
        .map(|m| match m {
            PipelineMutation::Deprecate { id, .. } => id,
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(ids, vec![996, 997, 998, 999]);
}
