//! Tests for `EvaluateFootprints` (thesis §3.2.3, Algorithm 8).
//!
//! The update rule operates on positive support only: each entry
//! `Ã[p, i]` is nudged toward the least-squares minimizer of the
//! accumulated reconstruction error at pixel `p`, then clamped to
//! zero if it would have gone negative. Key invariants:
//!
//! 1. **Single-component exact-fit recovery.** For `K = 1` and one
//!    frame of noiseless `y = Ã_true · c`, one iter sets `Ã[p, 0]`
//!    to `y[p] / c[0]` on support (closed-form derivation below).
//! 2. **Non-negativity.** `max(·, 0)` keeps every stored value
//!    strictly positive; zero/negative entries are dropped by
//!    `compact` at the end of each outer iter.
//! 3. **Support never grows.** Algorithm 8 only reads `p ∈ supp(i)`
//!    — new pixels cannot appear. Support expansion is Extend's job.

use calab_cala_core::assets::{Footprints, SuffStats};
use calab_cala_core::config::FitConfig;
use calab_cala_core::fitting::{evaluate_footprints, evaluate_suff_stats};

const F32_TOL: f32 = 1e-5;

fn assert_close(actual: f32, expected: f32, ctx: &str) {
    let diff = (actual - expected).abs();
    assert!(
        diff <= F32_TOL,
        "{ctx}: expected {expected}, got {actual} (diff {diff} > tol {F32_TOL})"
    );
}

// ----- Degenerate inputs -----

#[test]
fn empty_footprints_is_noop() {
    let mut fp = Footprints::new(2, 2);
    let ss = SuffStats::new(4, 0);
    let cfg = FitConfig::default();
    evaluate_footprints(&mut fp, &ss, &cfg);
    assert_eq!(fp.len(), 0);
}

#[test]
fn no_observations_leaves_footprints_unchanged() {
    // With `M[i, i] == 0` (frame counter 0, no observations), the
    // update has no signal to apply — Algorithm 8's division by
    // `M[i, i]` would be undefined. Implementation guards by skipping.
    let mut fp = Footprints::new(1, 3);
    fp.push_component(vec![0, 1], vec![0.3, 0.7]);
    let ss = SuffStats::new(3, 1);
    let cfg = FitConfig::default();
    evaluate_footprints(&mut fp, &ss, &cfg);
    assert_eq!(fp.support(0), &[0u32, 1]);
    assert_close(fp.values(0)[0], 0.3, "Ã[0,0] untouched");
    assert_close(fp.values(0)[1], 0.7, "Ã[1,0] untouched");
}

// ----- Single-component exact fit -----

#[test]
fn single_component_recovers_footprint_from_one_frame() {
    // Closed form: with K=1 and t=1,
    //   W[p, 0] = y[p] c[0],  M[0, 0] = c[0]²,  Ã[p, :] M[:, 0] = Ã[p, 0] c[0]².
    //   Δ = (y[p] c[0] − Ã[p, 0] c[0]²) / c[0]² = y[p]/c[0] − Ã[p, 0].
    //   New Ã[p, 0] = max(Ã[p, 0] + Δ, 0) = max(y[p]/c[0], 0) = y[p]/c[0].
    // So one update exactly installs the true footprint from one frame.
    let mut fp = Footprints::new(1, 4);
    // Truth footprint: values [1, 2, 3, 4] over pixels {0, 1, 2, 3}.
    let truth = [1.0f32, 2.0, 3.0, 4.0];
    // Seed perturbed: same support, wrong values.
    fp.push_component(vec![0, 1, 2, 3], vec![0.5, 0.5, 0.5, 0.5]);
    let c = [2.0f32];
    // y = truth · c = [2, 4, 6, 8].
    let y: Vec<f32> = truth.iter().map(|v| v * c[0]).collect();

    let mut ss = SuffStats::new(4, 1);
    let cfg = FitConfig::default().with_footprint_max_iter(1);
    evaluate_suff_stats(&mut ss, &y, &c, &cfg);
    evaluate_footprints(&mut fp, &ss, &cfg);

    assert_eq!(fp.support(0), &[0u32, 1, 2, 3]);
    for i in 0..4 {
        assert_close(fp.values(0)[i], truth[i], &format!("Ã[{i},0] recovered"));
    }
}

// ----- Non-negativity + compaction -----

#[test]
fn negative_update_clamps_and_compacts() {
    // Seed Ã has a pixel with a tiny positive value; a single frame
    // with an "anti-aligned" observation pushes its update negative,
    // which the max(·, 0) guard clamps to 0. The compaction pass
    // then removes it from the support.
    let mut fp = Footprints::new(1, 3);
    fp.push_component(vec![0, 1, 2], vec![0.1, 1.0, 0.1]);
    // Target y where pixel 0 would push Ã[0, 0] negative under the
    // K=1 update: y[p]/c[0] → 0.01 (below tol; after subtraction
    // from current 0.1, the clamp fires). The important bit is that
    // the FINAL stored value is strictly > 0 or the entry is dropped.
    let y = [0.001f32, 5.0, 0.001];
    let c = [2.0f32];
    let mut ss = SuffStats::new(3, 1);
    let cfg = FitConfig::default().with_footprint_max_iter(1);
    evaluate_suff_stats(&mut ss, &y, &c, &cfg);
    evaluate_footprints(&mut fp, &ss, &cfg);

    // Every stored value must be strictly positive after compact.
    for (idx, &v) in fp.values(0).iter().enumerate() {
        assert!(
            v > 0.0,
            "entry {idx} has non-positive value {v} after compact"
        );
    }
    // Support must stay a subset of the seed support — no expansion.
    for &p in fp.support(0) {
        assert!(p <= 2, "pixel {p} is outside the seed support {{0,1,2}}");
    }
}

#[test]
fn support_never_grows() {
    // Ã_true has a value at pixel 3, but the seed does not. Algorithm
    // 8 updates only on positive support, so after any number of
    // iterations `fp.support(0)` must remain {0, 1, 2}. Growing the
    // support is Extend's job (Phase 3).
    let mut fp = Footprints::new(1, 4);
    fp.push_component(vec![0, 1, 2], vec![0.5, 0.5, 0.5]);
    let c = [1.0f32];
    // y has energy at pixel 3 (outside seed support).
    let y = [1.0f32, 1.0, 1.0, 10.0];
    let mut ss = SuffStats::new(4, 1);
    let cfg = FitConfig::default().with_footprint_max_iter(20);
    evaluate_suff_stats(&mut ss, &y, &c, &cfg);
    evaluate_footprints(&mut fp, &ss, &cfg);
    assert_eq!(fp.support(0), &[0u32, 1, 2], "support did not expand");
}

// ----- Two-component convergence -----

#[test]
fn two_component_converges_toward_truth_over_many_iters() {
    // Non-overlapping supports → decoupled update → each component
    // converges independently. Perturb seed, feed one frame, iterate
    // EvaluateFootprints enough times to drive Ã to the truth.
    let mut fp = Footprints::new(2, 4); // pixels = 8
    let truth_a = [0.4f32, 0.8, 0.4];
    let truth_b = [0.5f32, 1.0, 0.5];
    fp.push_component(vec![0, 1, 2], vec![0.2, 0.4, 0.2]); // seed off by factor 2
    fp.push_component(vec![5, 6, 7], vec![0.3, 0.6, 0.3]); // seed off
    let c = [3.0f32, 2.0];
    // y = truth · c. Pixels 3, 4 outside both supports → 0.
    let mut y = vec![0.0f32; 8];
    for i in 0..3 {
        y[i] = truth_a[i] * c[0];
    }
    for i in 0..3 {
        y[5 + i] = truth_b[i] * c[1];
    }
    let mut ss = SuffStats::new(8, 2);
    let cfg = FitConfig::default().with_footprint_max_iter(10);
    evaluate_suff_stats(&mut ss, &y, &c, &cfg);
    evaluate_footprints(&mut fp, &ss, &cfg);

    for i in 0..3 {
        assert_close(fp.values(0)[i], truth_a[i], &format!("A[{i},0]"));
        assert_close(fp.values(1)[i], truth_b[i], &format!("A[{i},1]"));
    }
}

#[test]
fn overlapping_components_converge_after_several_iters() {
    // Shared pixel 2 couples the components via M. A single frame is
    // under-determined at the shared pixel — any (a, b) satisfying
    // `a·c[0] + b·c[1] = y[2]` fits, regardless of which split is
    // "true". Feeding frames with distinct c vectors gives the two
    // pixel-2 equations needed to identify (a, b). Many streaming
    // frames = many rows of the linear system.
    let mut fp = Footprints::new(1, 5);
    let truth_a = [0.5f32, 0.5, 1.0];
    let truth_b = [1.0f32, 0.5, 0.5];
    fp.push_component(vec![0, 1, 2], vec![0.2, 0.2, 0.4]);
    fp.push_component(vec![2, 3, 4], vec![0.4, 0.2, 0.2]);

    // Five frames with varying trace amplitudes — enough rows to
    // pin down both components even at the shared pixel.
    let c_series = [
        [2.0f32, 1.0],
        [1.0f32, 3.0],
        [3.0f32, 2.0],
        [1.5f32, 2.5],
        [2.5f32, 1.5],
    ];
    let mut ss = SuffStats::new(5, 2);
    let cfg = FitConfig::default().with_footprint_max_iter(50);
    for c in &c_series {
        let y = [
            truth_a[0] * c[0],
            truth_a[1] * c[0],
            truth_a[2] * c[0] + truth_b[0] * c[1],
            truth_b[1] * c[1],
            truth_b[2] * c[1],
        ];
        evaluate_suff_stats(&mut ss, &y, c, &cfg);
        evaluate_footprints(&mut fp, &ss, &cfg);
    }
    assert_close(fp.values(0)[0], truth_a[0], "A[0,0]");
    assert_close(fp.values(0)[1], truth_a[1], "A[1,0]");
    assert_close(fp.values(0)[2], truth_a[2], "A[2,0]");
    assert_close(fp.values(1)[0], truth_b[0], "A[2,1]");
    assert_close(fp.values(1)[1], truth_b[1], "A[3,1]");
    assert_close(fp.values(1)[2], truth_b[2], "A[4,1]");
}
