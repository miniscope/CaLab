//! Tests for the max-variance patch-selection stage of the extend
//! loop (thesis Algorithm 9 lines 1–4, Phase 3 Task 3).

use calab_cala_core::buffers::bipbuf::ResidualRingBuf;
use calab_cala_core::extending::segment::{
    argmax_yx, extract_patch_stack, patch_bounds, select_max_variance_patch, variance_map,
};

const F32_TOL: f32 = 1e-5;

fn approx(a: f32, b: f32, ctx: &str) {
    assert!(
        (a - b).abs() <= F32_TOL,
        "{ctx}: {a} vs {b} (tol {F32_TOL})"
    );
}

fn push_constant_frame(buf: &mut ResidualRingBuf, v: f32) {
    let f = vec![v; buf.frame_len()];
    buf.push(&f);
}

// ----- variance_map -----

#[test]
fn variance_map_is_zero_on_empty_buffer() {
    let buf = ResidualRingBuf::new(6, 4);
    let m = variance_map(&buf);
    assert_eq!(m.len(), 6);
    for v in m {
        approx(v, 0.0, "empty buffer variance");
    }
}

#[test]
fn variance_map_is_zero_on_constant_residual() {
    let mut buf = ResidualRingBuf::new(4, 5);
    for _ in 0..5 {
        push_constant_frame(&mut buf, 3.5);
    }
    let m = variance_map(&buf);
    for v in m {
        approx(v, 0.0, "constant residual variance");
    }
}

#[test]
fn variance_map_matches_hand_computed() {
    // 2-pixel frame, 3 frames. Pixel 0: [1, 2, 3] → var = 2/3.
    // Pixel 1: [1, 1, 4] → mean=2, mean_sq=(1+1+16)/3=6, var = 6−4 = 2.
    let mut buf = ResidualRingBuf::new(2, 3);
    buf.push(&[1.0, 1.0]);
    buf.push(&[2.0, 1.0]);
    buf.push(&[3.0, 4.0]);
    let m = variance_map(&buf);
    approx(m[0], 2.0 / 3.0, "pixel 0 variance");
    approx(m[1], 2.0, "pixel 1 variance");
}

#[test]
fn variance_map_is_nonnegative() {
    // A pathological input with near-identical pixel values can
    // produce a tiny negative variance in f32. The implementation
    // clamps to zero.
    let mut buf = ResidualRingBuf::new(2, 4);
    for _ in 0..4 {
        buf.push(&[0.3333333, -0.3333333]);
    }
    let m = variance_map(&buf);
    for v in m {
        assert!(v >= 0.0, "variance must be non-negative (got {v})");
    }
}

// ----- argmax_yx -----

#[test]
fn argmax_yx_finds_peak_pixel() {
    // 3×4 map, max at (y=1, x=2).
    let mut map = vec![0.0f32; 12];
    map[4 + 2] = 5.0;
    map[0] = 1.0;
    let (y, x, v) = argmax_yx(&map, 3, 4).unwrap();
    assert_eq!((y, x), (1, 2));
    approx(v, 5.0, "max value");
}

#[test]
fn argmax_yx_breaks_ties_by_lowest_linear_index() {
    let map = vec![2.0f32; 9];
    let (y, x, v) = argmax_yx(&map, 3, 3).unwrap();
    assert_eq!((y, x), (0, 0));
    approx(v, 2.0, "tied max value");
}

#[test]
fn argmax_yx_returns_none_on_all_nan() {
    let map = vec![f32::NAN; 4];
    assert!(argmax_yx(&map, 2, 2).is_none());
}

// ----- patch_bounds -----

#[test]
fn patch_bounds_produces_full_patch_when_in_interior() {
    let (y, x) = patch_bounds(5, 5, 2, 10, 10);
    assert_eq!(y, 3..8);
    assert_eq!(x, 3..8);
}

#[test]
fn patch_bounds_clips_to_corners() {
    let (y, x) = patch_bounds(0, 0, 2, 10, 10);
    assert_eq!(y, 0..3);
    assert_eq!(x, 0..3);

    let (y, x) = patch_bounds(9, 9, 2, 10, 10);
    assert_eq!(y, 7..10);
    assert_eq!(x, 7..10);
}

#[test]
fn patch_bounds_large_radius_returns_full_frame() {
    let (y, x) = patch_bounds(3, 3, 50, 7, 7);
    assert_eq!(y, 0..7);
    assert_eq!(x, 0..7);
}

// ----- extract_patch_stack -----

#[test]
fn extract_patch_stack_pulls_correct_pixels_per_frame() {
    // 3×3 frame, two frames in the buffer.
    let mut buf = ResidualRingBuf::new(9, 2);
    let f0: Vec<f32> = (0..9).map(|i| i as f32).collect(); // 0..8
    let f1: Vec<f32> = (10..19).map(|i| i as f32).collect(); // 10..18
    buf.push(&f0);
    buf.push(&f1);
    // Patch = rows 1..3, cols 1..3 → per frame shape (2, 2).
    let stack = extract_patch_stack(&buf, 3, 3, 1..3, 1..3);
    // Frame 0 patch: rows (1,2), cols (1,2). f0 row-major:
    //   row 0: 0 1 2
    //   row 1: 3 4 5
    //   row 2: 6 7 8
    // Patch = 4 5 7 8.
    // Frame 1 patch = 14 15 17 18.
    let expected = vec![4.0, 5.0, 7.0, 8.0, 14.0, 15.0, 17.0, 18.0];
    assert_eq!(stack.len(), expected.len());
    for (i, (a, e)) in stack.iter().zip(&expected).enumerate() {
        approx(*a, *e, &format!("patch pixel {i}"));
    }
}

// ----- select_max_variance_patch -----

#[test]
fn select_returns_none_on_empty_buffer() {
    let buf = ResidualRingBuf::new(16, 4);
    assert!(select_max_variance_patch(&buf, 4, 4, 2).is_none());
}

#[test]
fn select_picks_injected_hotspot() {
    // 5×5 frame, 10 frames. All zero except pixel (2,3) gets a
    // sinusoidal trace — clearly maximal variance there.
    let height = 5usize;
    let width = 5usize;
    let frames = 10usize;
    let mut buf = ResidualRingBuf::new(height * width, frames);
    for t in 0..frames {
        let mut f = vec![0.0f32; height * width];
        f[2 * width + 3] = (t as f32).sin() * 4.0;
        buf.push(&f);
    }
    let sel = select_max_variance_patch(&buf, height, width, 1).unwrap();
    assert_eq!(sel.center_yx, (2, 3), "argmax pixel");
    assert!(
        sel.max_variance > 1.0,
        "variance at injected pixel should be large (got {})",
        sel.max_variance
    );
    assert_eq!(sel.y_range, 1..4);
    assert_eq!(sel.x_range, 2..5);
    assert_eq!(sel.patch_h, 3);
    assert_eq!(sel.patch_w, 3);
    assert_eq!(sel.window_len, frames);
    assert_eq!(sel.time_stack.len(), frames * 3 * 3);
}

#[test]
fn select_patch_is_clipped_at_edges() {
    // Hotspot at (0, 0). Radius 2 → patch should clip to 3×3 at corner.
    let height = 6usize;
    let width = 6usize;
    let frames = 8usize;
    let mut buf = ResidualRingBuf::new(height * width, frames);
    for t in 0..frames {
        let mut f = vec![0.0f32; height * width];
        f[0] = (t as f32).cos() * 3.0;
        buf.push(&f);
    }
    let sel = select_max_variance_patch(&buf, height, width, 2).unwrap();
    assert_eq!(sel.center_yx, (0, 0));
    assert_eq!(sel.y_range, 0..3);
    assert_eq!(sel.x_range, 0..3);
    assert_eq!(sel.patch_h, 3);
    assert_eq!(sel.patch_w, 3);
    assert_eq!(sel.time_stack.len(), frames * 3 * 3);
}

#[test]
fn select_time_stack_preserves_frame_order() {
    // One-pixel variance, two frames — the time-stack newest/oldest
    // ordering should match the buffer's window() order.
    let mut buf = ResidualRingBuf::new(4, 3);
    for t in 0..3 {
        let mut f = vec![0.0f32; 4];
        f[0] = t as f32; // hotspot at (0, 0)
        buf.push(&f);
    }
    let sel = select_max_variance_patch(&buf, 2, 2, 0).unwrap();
    assert_eq!(sel.patch_h, 1);
    assert_eq!(sel.patch_w, 1);
    // Oldest-first time stack on the single patch pixel = [0, 1, 2].
    assert_eq!(sel.time_stack.len(), 3);
    approx(sel.time_stack[0], 0.0, "oldest patch pixel");
    approx(sel.time_stack[1], 1.0, "middle patch pixel");
    approx(sel.time_stack[2], 2.0, "newest patch pixel");
}

#[test]
#[should_panic(expected = "frame shape")]
fn select_panics_on_shape_mismatch() {
    let mut buf = ResidualRingBuf::new(16, 3);
    buf.push(&[0.0; 16]);
    let _ = select_max_variance_patch(&buf, 5, 5, 1);
}
