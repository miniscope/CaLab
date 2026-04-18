//! Tests for Pearson-correlation redundancy check (Phase 3 Task 6).

use calab_cala_core::extending::redundancy::pearson_correlation;

fn approx(a: f32, b: f32, tol: f32, ctx: &str) {
    assert!((a - b).abs() <= tol, "{ctx}: {a} vs {b} (tol {tol})");
}

#[test]
fn pearson_identical_is_one() {
    let x = vec![1.0, 2.0, 3.0, 4.0, 5.0];
    approx(pearson_correlation(&x, &x), 1.0, 1e-5, "identical → 1");
}

#[test]
fn pearson_anticorrelated_is_minus_one() {
    let x = vec![1.0, 2.0, 3.0, 4.0, 5.0];
    let y: Vec<f32> = x.iter().map(|v| -v).collect();
    approx(pearson_correlation(&x, &y), -1.0, 1e-5, "anti → -1");
}

#[test]
fn pearson_scaled_and_shifted_equals_one() {
    // Pearson is invariant to linear scale + offset.
    let x = vec![1.0, 2.0, 3.0, 4.0, 5.0];
    let y: Vec<f32> = x.iter().map(|v| 3.0 * v + 2.0).collect();
    approx(pearson_correlation(&x, &y), 1.0, 1e-5, "affine → 1");
}

#[test]
fn pearson_constant_vector_is_zero() {
    // Zero variance → return 0 (defensive; mathematically undefined).
    let x = vec![1.0, 2.0, 3.0];
    let y = vec![5.0; 3];
    approx(pearson_correlation(&x, &y), 0.0, 1e-5, "constant y");
    approx(pearson_correlation(&y, &x), 0.0, 1e-5, "constant x");
}

#[test]
fn pearson_both_constant_is_zero() {
    let x = vec![2.0; 5];
    let y = vec![7.0; 5];
    approx(pearson_correlation(&x, &y), 0.0, 1e-5, "both constant");
}

#[test]
fn pearson_empty_is_zero() {
    approx(pearson_correlation(&[], &[]), 0.0, 1e-5, "empty");
}

#[test]
fn pearson_orthogonal_signals_near_zero() {
    // Sine and cosine over one full period — orthogonal → correlation
    // should be ~0 within sampling noise.
    let n = 128usize;
    let twopi = std::f32::consts::TAU;
    let x: Vec<f32> = (0..n).map(|i| (i as f32 / n as f32 * twopi).sin()).collect();
    let y: Vec<f32> = (0..n).map(|i| (i as f32 / n as f32 * twopi).cos()).collect();
    let c = pearson_correlation(&x, &y);
    assert!(c.abs() < 0.05, "orthogonal signals should correlate near 0 (got {c})");
}

#[test]
fn pearson_result_clamped_to_unit_interval() {
    // Construct a pair where floating-point accumulation could push
    // the ratio just past ±1, then confirm the output is clamped.
    let x = vec![1e10f32, 1e10 + 1.0, 1e10 + 2.0];
    let y = vec![2e10f32, 2e10 + 2.0, 2e10 + 4.0];
    let c = pearson_correlation(&x, &y);
    assert!((-1.0..=1.0).contains(&c), "correlation should be in [-1, 1] (got {c})");
}

#[test]
#[should_panic(expected = "length mismatch")]
fn pearson_length_mismatch_panics() {
    let _ = pearson_correlation(&[1.0, 2.0], &[1.0, 2.0, 3.0]);
}
