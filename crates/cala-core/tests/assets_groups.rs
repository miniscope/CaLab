//! Tests for the `G` group-overlap partition (thesis §3.2.3,
//! Algorithm 7 line 9).
//!
//! `G` is the partition of components into connected components of the
//! spatial-overlap graph: components `i` and `j` are in the same group
//! iff their positive supports overlap (or are transitively linked via
//! chains of overlaps). Within a group, BCD must iterate jointly
//! because `AᵀA[i, j] ≠ 0`. Across groups, updates are independent so
//! groups can be processed in any order (or in parallel).

use calab_cala_core::assets::{Footprints, Groups};

#[test]
fn empty_footprints_have_no_groups() {
    let fp = Footprints::new(2, 2);
    let g = Groups::from_footprints(&fp);
    assert_eq!(g.len(), 0);
    assert_eq!(g.num_components(), 0);
}

#[test]
fn single_component_forms_one_group_of_itself() {
    let mut fp = Footprints::new(2, 2);
    fp.push_component(vec![0, 1], vec![1.0, 1.0]);
    let g = Groups::from_footprints(&fp);
    assert_eq!(g.len(), 1);
    assert_eq!(g.group(0), &[0usize]);
    assert_eq!(g.group_of(0), 0);
}

#[test]
fn disjoint_components_form_separate_groups() {
    let mut fp = Footprints::new(2, 4); // pixels = 8
    fp.push_component(vec![0, 1], vec![1.0, 1.0]);
    fp.push_component(vec![4, 5], vec![1.0, 1.0]);
    fp.push_component(vec![6, 7], vec![1.0, 1.0]);
    let g = Groups::from_footprints(&fp);
    assert_eq!(g.len(), 3);
    // Each component is alone in its group.
    let mut seen = vec![0u32; 3];
    for gi in 0..g.len() {
        let members = g.group(gi);
        assert_eq!(members.len(), 1);
        seen[members[0]] += 1;
    }
    assert_eq!(seen, vec![1, 1, 1]);
}

#[test]
fn overlapping_components_share_one_group() {
    let mut fp = Footprints::new(1, 4);
    fp.push_component(vec![0, 1, 2], vec![1.0, 1.0, 1.0]);
    fp.push_component(vec![2, 3], vec![1.0, 1.0]); // shares pixel 2
    let g = Groups::from_footprints(&fp);
    assert_eq!(g.len(), 1);
    let mut members = g.group(0).to_vec();
    members.sort();
    assert_eq!(members, vec![0, 1]);
    assert_eq!(g.group_of(0), g.group_of(1));
}

#[test]
fn transitive_overlap_collapses_into_single_group() {
    // A–B overlap at pixel 2, B–C overlap at pixel 6. A and C do not
    // overlap directly, but transitively through B they belong to the
    // same group — that's the connected-component definition.
    let mut fp = Footprints::new(1, 10);
    fp.push_component(vec![0, 1, 2], vec![1.0, 1.0, 1.0]); // A
    fp.push_component(vec![2, 5, 6], vec![1.0, 1.0, 1.0]); // B (shares 2 with A, 6 with C)
    fp.push_component(vec![6, 8, 9], vec![1.0, 1.0, 1.0]); // C
    let g = Groups::from_footprints(&fp);
    assert_eq!(g.len(), 1);
    assert_eq!(g.group_of(0), g.group_of(1));
    assert_eq!(g.group_of(1), g.group_of(2));
}

#[test]
fn groups_are_a_partition_of_all_components() {
    // Every component appears in exactly one group, and the total
    // count across groups equals `fp.len()`. This is the partition
    // invariant BCD relies on.
    let mut fp = Footprints::new(2, 5); // pixels = 10
    fp.push_component(vec![0], vec![1.0]);
    fp.push_component(vec![1, 2], vec![1.0, 1.0]);
    fp.push_component(vec![2, 3], vec![1.0, 1.0]);
    fp.push_component(vec![7, 8], vec![1.0, 1.0]);
    let g = Groups::from_footprints(&fp);
    let mut hit = vec![false; fp.len()];
    let mut total = 0;
    for gi in 0..g.len() {
        for &member in g.group(gi) {
            assert!(
                !hit[member],
                "component {member} appears in multiple groups"
            );
            hit[member] = true;
            total += 1;
        }
    }
    assert_eq!(total, fp.len());
    assert!(
        hit.iter().all(|&h| h),
        "every component must appear in some group"
    );
}

#[test]
fn group_members_are_sorted_ascending() {
    // Downstream BCD code iterates `group(gi)` and wants a stable
    // order; sorted-ascending is the natural pick (matches component
    // creation order for the common case of no gaps).
    let mut fp = Footprints::new(1, 6);
    fp.push_component(vec![0, 1], vec![1.0, 1.0]);
    fp.push_component(vec![1, 2], vec![1.0, 1.0]);
    fp.push_component(vec![2, 3], vec![1.0, 1.0]);
    fp.push_component(vec![3, 4], vec![1.0, 1.0]);
    let g = Groups::from_footprints(&fp);
    assert_eq!(g.len(), 1);
    assert_eq!(g.group(0), &[0usize, 1, 2, 3]);
}
