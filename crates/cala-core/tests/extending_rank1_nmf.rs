//! Tests for the rank-1 non-negative factorization used by the
//! Phase 3 extend loop (Task 4).

use calab_cala_core::extending::segment::rank1_nmf;

const F32_TOL: f32 = 1e-5;

fn outer_product(a: &[f32], c: &[f32]) -> Vec<f32> {
    let t = c.len();
    let p = a.len();
    let mut out = vec![0.0f32; t * p];
    for ti in 0..t {
        for pi in 0..p {
            out[ti * p + pi] = a[pi] * c[ti];
        }
    }
    out
}

fn l2(v: &[f32]) -> f32 {
    v.iter().map(|&x| x * x).sum::<f32>().sqrt()
}

fn approx(a: f32, b: f32, tol: f32, ctx: &str) {
    assert!(
        (a - b).abs() <= tol,
        "{ctx}: {a} vs {b} (tol {tol})"
    );
}

#[test]
fn rank1_nmf_recovers_seeded_factorization() {
    // a_true is a 3×3 gaussian-ish hotspot; c_true is a 12-tap impulse
    // trace. Build X = a c^T exactly and confirm ALS recovers both.
    let a_true = vec![
        0.0, 0.2, 0.0, //
        0.2, 1.0, 0.2, //
        0.0, 0.2, 0.0,
    ];
    let c_true = vec![
        0.0, 0.1, 0.3, 0.8, 2.0, 1.5, 0.9, 0.4, 0.2, 0.1, 0.05, 0.0,
    ];
    let t = c_true.len();
    let p = a_true.len();
    let x = outer_product(&a_true, &c_true);
    let out = rank1_nmf(&x, t, p, 100, 1e-6);

    // a is normalized to unit L2.
    approx(l2(&out.a), 1.0, F32_TOL, "‖a‖ should be 1");
    // Compare a direction to the normalized truth.
    let a_true_norm = l2(&a_true);
    let a_true_unit: Vec<f32> = a_true.iter().map(|v| v / a_true_norm).collect();
    let cos = out
        .a
        .iter()
        .zip(&a_true_unit)
        .map(|(x, y)| x * y)
        .sum::<f32>();
    approx(cos, 1.0, 1e-4, "a direction should match truth");

    // c should scale as the true c × a_true_norm (since we pulled the
    // norm out of a into c).
    let expected_c: Vec<f32> = c_true.iter().map(|v| v * a_true_norm).collect();
    for (i, (got, want)) in out.c.iter().zip(&expected_c).enumerate() {
        approx(*got, *want, 1e-4, &format!("c[{i}]"));
    }

    assert!(out.converged, "clean rank-1 data should converge");
    assert!(out.recon_error < 1e-5, "recon error on exact rank-1 should be ~0 (got {})", out.recon_error);
}

#[test]
fn rank1_nmf_handles_all_zero_input() {
    let x = vec![0.0f32; 20];
    let out = rank1_nmf(&x, 5, 4, 50, 1e-5);
    assert_eq!(out.iterations, 0);
    assert!(out.converged);
    approx(out.recon_error, 0.0, F32_TOL, "zero-input recon error");
    assert!(out.a.iter().all(|&v| v == 0.0), "a should be zero");
    assert!(out.c.iter().all(|&v| v == 0.0), "c should be zero");
}

#[test]
fn rank1_nmf_is_nonnegative() {
    // Even on a signed residual, `a` and `c` must be ≥ 0 by
    // construction (projected updates).
    let t = 6;
    let p = 4;
    let x: Vec<f32> = (0..(t * p)).map(|i| (i as f32).sin()).collect();
    let out = rank1_nmf(&x, t, p, 50, 1e-5);
    assert!(out.a.iter().all(|&v| v >= 0.0), "a must be non-negative");
    assert!(out.c.iter().all(|&v| v >= 0.0), "c must be non-negative");
}

#[test]
fn rank1_nmf_exits_at_max_iter_when_noisy() {
    // A noisy-as-hell (t × p) with no clean rank-1 structure won't hit
    // a tight tolerance — should burn through max_iter.
    let t = 8;
    let p = 6;
    let mut state = 1u32;
    let mut rand = || {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        (state as f32 / u32::MAX as f32) - 0.5
    };
    let x: Vec<f32> = (0..(t * p)).map(|_| rand()).collect();
    let out = rank1_nmf(&x, t, p, 3, 1e-8);
    assert_eq!(out.iterations, 3, "should run full max_iter");
    // recon_error of a rank-1 approximation to a noisy matrix is
    // bounded below by (1 − σ₁² / ‖X‖²)^0.5 but will generally be
    // well above zero.
    assert!(out.recon_error > 0.0, "noisy fit should have residual");
    assert!(out.recon_error < 1.0, "relative error shouldn't exceed 1");
}

#[test]
fn rank1_nmf_normalizes_a_to_unit_l2() {
    // Unit-L2 `a` is a load-bearing contract for downstream quality
    // gates (diameter / compactness are computed from normalized
    // support).
    let a_true = vec![0.5, 1.0, 0.5];
    let c_true = vec![1.0, 2.0, 3.0, 4.0];
    let x = outer_product(&a_true, &c_true);
    let out = rank1_nmf(&x, 4, 3, 50, 1e-6);
    approx(l2(&out.a), 1.0, F32_TOL, "‖a‖ unit L2");
}

#[test]
fn rank1_nmf_recovers_shifted_patch() {
    // The spatial factor has mass off-center — common when the hotspot
    // sits near a patch edge. ALS should still recover both factors.
    let a_true = vec![1.5, 0.8, 0.0, 0.3];
    let c_true = vec![0.1, 0.5, 1.2, 0.9, 0.2];
    let x = outer_product(&a_true, &c_true);
    let out = rank1_nmf(&x, 5, 4, 100, 1e-6);
    let a_norm = l2(&a_true);
    let a_true_unit: Vec<f32> = a_true.iter().map(|v| v / a_norm).collect();
    for (i, (got, want)) in out.a.iter().zip(&a_true_unit).enumerate() {
        approx(*got, *want, 1e-4, &format!("a[{i}]"));
    }
    assert!(out.recon_error < 1e-5);
}

#[test]
#[should_panic(expected = "x length")]
fn rank1_nmf_panics_on_shape_mismatch() {
    let _ = rank1_nmf(&[0.0; 10], 3, 4, 50, 1e-5);
}

#[test]
#[should_panic(expected = "tol must be positive")]
fn rank1_nmf_panics_on_nonpositive_tol() {
    let _ = rank1_nmf(&[0.0; 6], 2, 3, 10, 0.0);
}

#[test]
#[should_panic(expected = "max_iter must be ≥ 1")]
fn rank1_nmf_panics_on_zero_max_iter() {
    let _ = rank1_nmf(&[0.0; 6], 2, 3, 0, 1e-5);
}

#[test]
fn rank1_nmf_recon_error_matches_frobenius_ratio() {
    // On clean rank-1 data, the recon error formula should return ~0
    // when the factorization is exact. Independently compute
    // ‖X − a c^T‖_F / ‖X‖_F and confirm match.
    let a_true = vec![0.2, 1.0, 0.2];
    let c_true = vec![1.0, 2.0, 1.5, 0.5];
    let x = outer_product(&a_true, &c_true);
    let t = 4;
    let p = 3;
    let out = rank1_nmf(&x, t, p, 100, 1e-6);

    let mut num_sq = 0.0f32;
    for ti in 0..t {
        for pi in 0..p {
            let r = x[ti * p + pi] - out.a[pi] * out.c[ti];
            num_sq += r * r;
        }
    }
    let denom: f32 = x.iter().map(|&v| v * v).sum::<f32>().sqrt();
    let expected = num_sq.sqrt() / denom;
    approx(out.recon_error, expected, 1e-6, "recon error formula");
}
