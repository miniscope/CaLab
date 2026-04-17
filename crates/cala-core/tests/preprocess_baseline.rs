//! Tests for per-pixel running-minimum baseline subtraction.
//!
//! Semantics:
//!   state.min_image[i] = min(state.min_image[i], frame[i])   (monotone non-increasing)
//!   output[i]          = frame[i] - state.min_image[i]
//!
//! Initial state is +infinity per pixel, so the first frame through
//! always produces an all-zero output (baseline == current frame).
//! Streaming equivalence: feeding frames f_0..f_t sequentially leaves
//! `min_image` equal to the elementwise batch min of those frames.

use calab_cala_core::assets::{Frame, FrameMut};
use calab_cala_core::preprocess::BaselineState;

fn feed(state: &mut BaselineState, input: &[f32], h: usize, w: usize) -> Vec<f32> {
    let mut output = vec![0.0_f32; h * w];
    state
        .subtract_baseline(
            Frame::new(input, h, w).unwrap(),
            &mut FrameMut::new(&mut output, h, w).unwrap(),
        )
        .unwrap();
    output
}

fn assert_close(actual: f32, expected: f32, tol: f32, ctx: &str) {
    let diff = (actual - expected).abs();
    assert!(
        diff <= tol,
        "{ctx}: expected {expected}, got {actual} (diff {diff} > tol {tol})"
    );
}

#[test]
fn first_frame_output_is_all_zero() {
    let (h, w) = (3, 4);
    let mut state = BaselineState::new(h, w);
    let f0 = vec![7.5_f32; h * w];
    let out = feed(&mut state, &f0, h, w);
    for &v in &out {
        assert_close(v, 0.0, 1e-6, "first-frame pixel");
    }
}

#[test]
fn min_image_is_monotone_non_increasing() {
    // Each frame can only lower a pixel's min, never raise it.
    let (h, w) = (2, 3);
    let mut state = BaselineState::new(h, w);
    let frames: [[f32; 6]; 4] = [
        [5.0, 5.0, 5.0, 5.0, 5.0, 5.0],
        [3.0, 7.0, 4.0, 9.0, 2.0, 6.0],
        [6.0, 6.0, 6.0, 6.0, 6.0, 6.0],
        [1.0, 8.0, 4.0, 1.0, 3.0, 0.5],
    ];
    let mut prev_min: Vec<f32> = vec![f32::INFINITY; h * w];
    for f in &frames {
        feed(&mut state, f, h, w);
        let mi = state.min_image();
        for i in 0..h * w {
            assert!(
                mi.pixels()[i] <= prev_min[i],
                "min at pixel {i} grew: {} -> {}",
                prev_min[i],
                mi.pixels()[i]
            );
        }
        prev_min = mi.pixels().to_vec();
    }
}

#[test]
fn streaming_equivalent_to_batch_min() {
    // After feeding f_0..f_t sequentially, `min_image` must equal the
    // elementwise batch min over all observed frames.
    let (h, w) = (4, 5);
    let mut state = BaselineState::new(h, w);
    let frames: Vec<Vec<f32>> = (0..6)
        .map(|t| {
            (0..h * w)
                .map(|i| ((i as f32 * 1.7 + t as f32 * 2.3).sin() + 1.5) * 10.0)
                .collect()
        })
        .collect();
    for f in &frames {
        feed(&mut state, f, h, w);
    }
    let mi = state.min_image();
    for i in 0..h * w {
        let batch_min = frames.iter().map(|f| f[i]).fold(f32::INFINITY, f32::min);
        assert_close(
            mi.pixels()[i],
            batch_min,
            1e-6,
            &format!("pixel {i} batch min"),
        );
    }
}

#[test]
fn output_equals_frame_minus_running_min() {
    let (h, w) = (2, 2);
    let mut state = BaselineState::new(h, w);
    // Pixel 0 trajectory: 10, 4, 7 → running min: 10, 4, 4 → output: 0, 0, 3
    // Pixel 1 trajectory: 2, 2, 2 → running min: 2, 2, 2 → output: 0, 0, 0
    // Pixel 2 trajectory: 5, 5, 1 → running min: 5, 5, 1 → output: 0, 0, 0
    // Pixel 3 trajectory: 8, 3, 9 → running min: 8, 3, 3 → output: 0, 0, 6
    let frames = [
        [10.0_f32, 2.0, 5.0, 8.0],
        [4.0, 2.0, 5.0, 3.0],
        [7.0, 2.0, 1.0, 9.0],
    ];
    let expected_outputs = [
        [0.0_f32, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0],
        [3.0, 0.0, 0.0, 6.0],
    ];
    for (f, exp) in frames.iter().zip(expected_outputs.iter()) {
        let out = feed(&mut state, f, h, w);
        for i in 0..h * w {
            assert_close(out[i], exp[i], 1e-6, &format!("pixel {i}"));
        }
    }
}

#[test]
fn pixels_are_independent() {
    // Modifying one pixel's history must not change any other pixel's
    // running min.
    let (h, w) = (1, 3);
    let mut a = BaselineState::new(h, w);
    let mut b = BaselineState::new(h, w);

    let frames_a = [[10.0_f32, 5.0, 8.0], [2.0, 7.0, 3.0]];
    let frames_b = [[10.0_f32, 5.0, 8.0], [2.0, 999.0, 3.0]];

    for (fa, fb) in frames_a.iter().zip(frames_b.iter()) {
        feed(&mut a, fa, h, w);
        feed(&mut b, fb, h, w);
    }

    // Pixels 0 and 2 have identical histories in a and b → identical mins.
    assert_close(
        a.min_image().pixels()[0],
        b.min_image().pixels()[0],
        1e-6,
        "p0",
    );
    assert_close(
        a.min_image().pixels()[2],
        b.min_image().pixels()[2],
        1e-6,
        "p2",
    );
    // Pixel 1 diverged — a saw 7, b saw 999.
    assert_close(a.min_image().pixels()[1], 5.0, 1e-6, "p1 a");
    assert_close(b.min_image().pixels()[1], 5.0, 1e-6, "p1 b"); // b: min(5, 999) == 5
}

#[test]
fn reset_clears_state_back_to_infinity() {
    let (h, w) = (2, 2);
    let mut state = BaselineState::new(h, w);
    let f = [3.0_f32, 1.0, 4.0, 1.5];
    feed(&mut state, &f, h, w);
    // After one frame, first-frame output must be zero again after reset.
    state.reset();
    let out = feed(&mut state, &f, h, w);
    for &v in &out {
        assert_close(v, 0.0, 1e-6, "post-reset first frame");
    }
}

#[test]
fn shape_mismatch_errors() {
    let (h, w) = (3, 4);
    let mut state = BaselineState::new(h, w);
    let input = vec![0.0_f32; 6];
    let mut output = vec![0.0_f32; 6];
    let res = state.subtract_baseline(
        Frame::new(&input, 2, 3).unwrap(),
        &mut FrameMut::new(&mut output, 2, 3).unwrap(),
    );
    assert!(res.is_err());
}
