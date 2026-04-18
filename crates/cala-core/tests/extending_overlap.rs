//! Tests for spatial-support overlap detection (Phase 3 Task 6).

use calab_cala_core::extending::overlap::{
    overlap_count, overlap_fraction, patch_to_frame_support,
};

// ----- patch_to_frame_support -----

#[test]
fn patch_to_frame_support_maps_rowmajor_indices() {
    // 3×3 patch at (y=1..4, x=2..5) in a 10-wide frame.
    // Non-zero pixels at patch positions (0,0), (1,1), (2,2).
    let mut a = vec![0.0f32; 9];
    a[0] = 0.5; // (0,0) → frame (1, 2)
    a[4] = 1.0; // (1,1) → frame (2, 3)
    a[8] = 0.3; // (2,2) → frame (3, 4)
    let support = patch_to_frame_support(&a, 3, 3, 1..4, 2..5, 10, 0.1);
    // Frame indices: (1*10+2)=12, (2*10+3)=23, (3*10+4)=34.
    assert_eq!(support, vec![12, 23, 34]);
}

#[test]
fn patch_to_frame_support_threshold_drops_small_pixels() {
    // 2×2 patch at frame origin, frame_width = 10. Cutoff = 0.1 × 1.0.
    //   patch (0,0)=1.0  → frame pixel 0      (kept)
    //   patch (0,1)=0.05 → below cutoff       (dropped)
    //   patch (1,0)=0.5  → frame pixel 10     (kept)
    //   patch (1,1)=0.2  → frame pixel 11     (kept)
    let a = vec![1.0, 0.05, 0.5, 0.2];
    let support = patch_to_frame_support(&a, 2, 2, 0..2, 0..2, 10, 0.1);
    assert_eq!(support, vec![0, 10, 11]);
}

#[test]
fn patch_to_frame_support_empty_on_zero_a() {
    let support = patch_to_frame_support(&[0.0, 0.0, 0.0, 0.0], 2, 2, 0..2, 0..2, 10, 0.1);
    assert!(support.is_empty());
}

#[test]
fn patch_to_frame_support_is_strictly_ascending() {
    // Fully-populated patch → every pixel lands in support. With
    // frame_width > patch_w, indices across rows jump by > patch_w so
    // the result stays monotonically increasing.
    let a = vec![1.0; 6]; // 2×3 patch
    let support = patch_to_frame_support(&a, 2, 3, 0..2, 0..3, 7, 0.05);
    // Frame positions: (0,0)=0, (0,1)=1, (0,2)=2, (1,0)=7, (1,1)=8, (1,2)=9.
    assert_eq!(support, vec![0, 1, 2, 7, 8, 9]);
    for win in support.windows(2) {
        assert!(win[0] < win[1], "support must be strictly ascending");
    }
}

// ----- overlap_count / overlap_fraction -----

#[test]
fn overlap_count_is_zero_when_disjoint() {
    assert_eq!(overlap_count(&[1, 2, 3], &[4, 5, 6]), 0);
}

#[test]
fn overlap_count_is_full_when_identical() {
    assert_eq!(overlap_count(&[1, 2, 3], &[1, 2, 3]), 3);
}

#[test]
fn overlap_count_partial() {
    // Sorted intersection of [1, 3, 5, 7] and [3, 4, 5, 6] = {3, 5} → 2.
    assert_eq!(overlap_count(&[1, 3, 5, 7], &[3, 4, 5, 6]), 2);
}

#[test]
fn overlap_count_handles_empty_inputs() {
    assert_eq!(overlap_count(&[], &[1, 2, 3]), 0);
    assert_eq!(overlap_count(&[1, 2, 3], &[]), 0);
    assert_eq!(overlap_count(&[], &[]), 0);
}

#[test]
fn overlap_fraction_divides_by_min_cardinality() {
    // |a| = 4, |b| = 2, overlap = 2 → 2 / min(4,2) = 2/2 = 1.0.
    let f = overlap_fraction(&[1, 2, 3, 4], &[2, 3]);
    assert!((f - 1.0).abs() < 1e-6);
}

#[test]
fn overlap_fraction_is_zero_with_empty_input() {
    assert_eq!(overlap_fraction(&[], &[1, 2]), 0.0);
    assert_eq!(overlap_fraction(&[1, 2], &[]), 0.0);
}

#[test]
fn overlap_fraction_partial_match() {
    // |a| = 3, |b| = 3, overlap = 1 → 1/3.
    let f = overlap_fraction(&[1, 2, 3], &[3, 4, 5]);
    assert!((f - 1.0 / 3.0).abs() < 1e-6);
}
