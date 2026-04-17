//! Tests for band (row + column) mean subtraction.
//!
//! Semantics pinned here: **double-centering** —
//!   `x'[i,j] = x[i,j] - rowmean[i] - colmean[j] + globalmean`.
//! Removes row and column stripe artifacts in one pass. Invariants:
//! every row mean and every column mean of the output is zero within
//! f32 roundoff. The operation is parameter-free.

use calab_cala_core::assets::{Frame, FrameMut};
use calab_cala_core::preprocess::band_subtract;

fn run(input: &[f32], h: usize, w: usize) -> Vec<f32> {
    let mut output = vec![0.0_f32; h * w];
    band_subtract(
        Frame::new(input, h, w).unwrap(),
        &mut FrameMut::new(&mut output, h, w).unwrap(),
    )
    .unwrap();
    output
}

fn row_mean(data: &[f32], w: usize, y: usize) -> f32 {
    let start = y * w;
    data[start..start + w].iter().sum::<f32>() / w as f32
}

fn col_mean(data: &[f32], h: usize, w: usize, x: usize) -> f32 {
    let mut s = 0.0_f32;
    for y in 0..h {
        s += data[y * w + x];
    }
    s / h as f32
}

fn assert_close(actual: f32, expected: f32, tol: f32, ctx: &str) {
    let diff = (actual - expected).abs();
    assert!(
        diff <= tol,
        "{ctx}: expected {expected}, got {actual} (diff {diff} > tol {tol})"
    );
}

#[test]
fn constant_input_produces_zero_output() {
    // rowmean = colmean = globalmean = c, so x - r - c + m = c - c - c + c = 0.
    let (h, w) = (5, 7);
    let input = vec![3.25_f32; h * w];
    let out = run(&input, h, w);
    for (i, &v) in out.iter().enumerate() {
        assert!(v.abs() < 1e-6, "pixel {i}: {v} should be ~0");
    }
}

#[test]
fn all_row_means_are_zero_after_subtraction() {
    // Invariant: every row mean of the output is zero within f32 tol,
    // regardless of input content.
    let (h, w) = (6, 8);
    let input: Vec<f32> = (0..h * w).map(|i| i as f32 * 0.37 - 2.0).collect();
    let out = run(&input, h, w);
    for y in 0..h {
        let rm = row_mean(&out, w, y);
        assert!(rm.abs() < 1e-5, "row {y} mean should be ~0, got {rm}");
    }
}

#[test]
fn all_col_means_are_zero_after_subtraction() {
    let (h, w) = (6, 8);
    let input: Vec<f32> = (0..h * w).map(|i| i as f32 * 0.37 - 2.0).collect();
    let out = run(&input, h, w);
    for x in 0..w {
        let cm = col_mean(&out, h, w, x);
        assert!(cm.abs() < 1e-5, "col {x} mean should be ~0, got {cm}");
    }
}

#[test]
fn stripes_plus_signal_recovers_signal() {
    // Build input = row_stripe[y] + col_stripe[x] + signal[y,x], where
    // signal is zero-row-mean AND zero-col-mean. Band subtraction should
    // recover signal exactly (up to f32 roundoff).
    let (h, w) = (4, 6);
    let row_stripe = [1.0_f32, 2.5, -0.5, 4.0];
    let col_stripe = [0.1_f32, 0.2, 0.3, 0.4, 0.5, 0.6];
    // Checkerboard-like signal with zero row and col means.
    let mut signal = vec![0.0_f32; h * w];
    for y in 0..h {
        for x in 0..w {
            let v = if (y + x) % 2 == 0 { 1.0 } else { -1.0 };
            signal[y * w + x] = v;
        }
    }
    // Sanity-check our synthetic signal actually has zero band means.
    for y in 0..h {
        assert!(row_mean(&signal, w, y).abs() < 1e-6);
    }
    for x in 0..w {
        assert!(col_mean(&signal, h, w, x).abs() < 1e-6);
    }

    let mut input = vec![0.0_f32; h * w];
    for y in 0..h {
        for x in 0..w {
            input[y * w + x] = row_stripe[y] + col_stripe[x] + signal[y * w + x];
        }
    }
    let out = run(&input, h, w);

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            assert_close(out[idx], signal[idx], 1e-5, &format!("({y},{x})"));
        }
    }
}

#[test]
fn is_linear() {
    let (h, w) = (5, 5);
    let a: Vec<f32> = (0..h * w).map(|i| (i as f32 * 0.13).sin()).collect();
    let b: Vec<f32> = (0..h * w).map(|i| (i as f32 * 0.29).cos()).collect();
    let (alpha, beta) = (0.7_f32, -1.4_f32);
    let mix: Vec<f32> = (0..h * w).map(|i| alpha * a[i] + beta * b[i]).collect();

    let fa = run(&a, h, w);
    let fb = run(&b, h, w);
    let fmix = run(&mix, h, w);

    for i in 0..h * w {
        let expected = alpha * fa[i] + beta * fb[i];
        assert_close(fmix[i], expected, 1e-5, &format!("linearity pixel {i}"));
    }
}

#[test]
fn shape_mismatch_errors() {
    let input = vec![0.0_f32; 12];
    let mut output = vec![0.0_f32; 6];
    let res = band_subtract(
        Frame::new(&input, 3, 4).unwrap(),
        &mut FrameMut::new(&mut output, 2, 3).unwrap(),
    );
    assert!(res.is_err());
}
