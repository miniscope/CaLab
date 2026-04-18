//! Tests for `ResidualRingBuf` — the 2n-allocated residual ring
//! (design §5 `buffers/bipbuf.rs`, Phase 3 Task 2).
//!
//! Invariants under test:
//! - `window().len() == len() * frame_len`
//! - Oldest-to-newest order over `window()` regardless of wrap state
//! - Contiguity is preserved after arbitrary wraps (single `&[f32]`)
//! - Constructor rejects zero frame_len / capacity
//! - `push` rejects frames of the wrong length

use calab_cala_core::buffers::bipbuf::ResidualRingBuf;

const F32_TOL: f32 = 1e-6;

fn approx_eq(actual: &[f32], expected: &[f32], ctx: &str) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{ctx}: length mismatch ({} vs {})",
        actual.len(),
        expected.len()
    );
    for (i, (a, e)) in actual.iter().zip(expected).enumerate() {
        assert!(
            (a - e).abs() <= F32_TOL,
            "{ctx}: element {i} differs ({a} vs {e}, tol {F32_TOL})"
        );
    }
}

fn synthetic_frame(frame_len: usize, seed: u32) -> Vec<f32> {
    (0..frame_len).map(|i| (i as u32 + seed * 17) as f32).collect()
}

// ----- constructor / zero-state -----

#[test]
fn empty_buffer_has_no_frames() {
    let buf = ResidualRingBuf::new(4, 3);
    assert_eq!(buf.frame_len(), 4);
    assert_eq!(buf.capacity(), 3);
    assert_eq!(buf.len(), 0);
    assert!(buf.is_empty());
    assert!(!buf.is_full());
    assert!(buf.latest().is_none());
    assert_eq!(buf.window().len(), 0);
}

#[test]
#[should_panic(expected = "frame_len must be positive")]
fn new_rejects_zero_frame_len() {
    let _ = ResidualRingBuf::new(0, 4);
}

#[test]
#[should_panic(expected = "capacity must be positive")]
fn new_rejects_zero_capacity() {
    let _ = ResidualRingBuf::new(4, 0);
}

// ----- partial-fill behavior -----

#[test]
fn single_push_yields_one_frame_window() {
    let mut buf = ResidualRingBuf::new(3, 5);
    let f = [1.0, 2.0, 3.0];
    buf.push(&f);
    assert_eq!(buf.len(), 1);
    assert!(!buf.is_full());
    approx_eq(buf.window(), &f, "single-frame window");
    approx_eq(buf.frame(0), &f, "frame(0) == pushed");
    approx_eq(buf.latest().unwrap(), &f, "latest == pushed");
}

#[test]
fn partial_fill_preserves_push_order() {
    let mut buf = ResidualRingBuf::new(2, 5);
    let f0 = [1.0, 2.0];
    let f1 = [3.0, 4.0];
    let f2 = [5.0, 6.0];
    buf.push(&f0);
    buf.push(&f1);
    buf.push(&f2);
    assert_eq!(buf.len(), 3);
    assert!(!buf.is_full());
    approx_eq(buf.window(), &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], "order");
    approx_eq(buf.frame(0), &f0, "oldest");
    approx_eq(buf.frame(2), &f2, "newest");
    approx_eq(buf.latest().unwrap(), &f2, "latest");
}

// ----- full buffer, no wrap -----

#[test]
fn full_buffer_returns_all_frames_in_order() {
    let mut buf = ResidualRingBuf::new(2, 3);
    let f0 = [1.0, 2.0];
    let f1 = [3.0, 4.0];
    let f2 = [5.0, 6.0];
    buf.push(&f0);
    buf.push(&f1);
    buf.push(&f2);
    assert!(buf.is_full());
    assert_eq!(buf.len(), 3);
    approx_eq(
        buf.window(),
        &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        "full window pre-wrap",
    );
}

// ----- wrap behavior -----

#[test]
fn single_wrap_drops_oldest_preserves_order() {
    let mut buf = ResidualRingBuf::new(2, 3);
    for s in 0..4 {
        buf.push(&synthetic_frame(2, s));
    }
    // Pushed: f0, f1, f2, f3. Window should be [f1, f2, f3].
    assert_eq!(buf.len(), 3);
    let mut expected = Vec::new();
    expected.extend_from_slice(&synthetic_frame(2, 1));
    expected.extend_from_slice(&synthetic_frame(2, 2));
    expected.extend_from_slice(&synthetic_frame(2, 3));
    approx_eq(buf.window(), &expected, "single-wrap window");
    approx_eq(buf.frame(0), &synthetic_frame(2, 1), "oldest after wrap");
    approx_eq(buf.frame(2), &synthetic_frame(2, 3), "newest after wrap");
}

#[test]
fn many_wraps_only_retains_last_capacity_frames() {
    let frame_len = 4;
    let capacity = 5;
    let mut buf = ResidualRingBuf::new(frame_len, capacity);
    let total = 37; // arbitrary > 7 × capacity to stress the wrap
    for s in 0..total {
        buf.push(&synthetic_frame(frame_len, s));
    }
    assert!(buf.is_full());
    assert_eq!(buf.len(), capacity);
    let mut expected = Vec::with_capacity(capacity * frame_len);
    for s in (total - capacity as u32)..total {
        expected.extend_from_slice(&synthetic_frame(frame_len, s));
    }
    approx_eq(buf.window(), &expected, "post-many-wraps window");
}

#[test]
fn window_is_one_contiguous_slice_across_wraps() {
    // Structural check: window() always returns a single `&[f32]` whose
    // length equals `len() * frame_len`. Exercising every head position
    // ensures the mirror trick holds at each wrap offset.
    let frame_len = 3;
    let capacity = 4;
    let mut buf = ResidualRingBuf::new(frame_len, capacity);
    let mut counter = 0u32;
    for _ in 0..(capacity * 3 + 1) {
        buf.push(&synthetic_frame(frame_len, counter));
        counter += 1;
        let w = buf.window();
        assert_eq!(
            w.len(),
            buf.len() * frame_len,
            "window len must equal len * frame_len at head {}",
            counter
        );
        // Oldest is at index 0, newest at index (len-1) * frame_len.
        let newest_slice = &w[(buf.len() - 1) * frame_len..];
        approx_eq(
            newest_slice,
            &synthetic_frame(frame_len, counter - 1),
            "newest tracks latest push across wraps",
        );
    }
}

// ----- frame / latest access -----

#[test]
fn frame_indexing_covers_full_window() {
    let mut buf = ResidualRingBuf::new(2, 4);
    for s in 0..6 {
        buf.push(&synthetic_frame(2, s));
    }
    // Last 4 pushes: seeds 2, 3, 4, 5.
    for (i, seed) in [2, 3, 4, 5].iter().enumerate() {
        approx_eq(
            buf.frame(i),
            &synthetic_frame(2, *seed),
            &format!("frame({i}) after wrap"),
        );
    }
}

#[test]
#[should_panic(expected = "frame index")]
fn frame_index_out_of_range_panics() {
    let mut buf = ResidualRingBuf::new(2, 3);
    buf.push(&[1.0, 2.0]);
    let _ = buf.frame(1);
}

// ----- push validation -----

#[test]
#[should_panic(expected = "frame length")]
fn push_with_wrong_length_panics() {
    let mut buf = ResidualRingBuf::new(3, 2);
    buf.push(&[1.0, 2.0]);
}

// ----- clear -----

#[test]
fn clear_returns_to_empty_state() {
    let mut buf = ResidualRingBuf::new(2, 3);
    for s in 0..5 {
        buf.push(&synthetic_frame(2, s));
    }
    assert!(buf.is_full());
    buf.clear();
    assert!(buf.is_empty());
    assert!(!buf.is_full());
    assert_eq!(buf.len(), 0);
    assert_eq!(buf.window().len(), 0);
    assert!(buf.latest().is_none());
    // And filling again works from scratch.
    buf.push(&[9.0, 9.0]);
    approx_eq(buf.window(), &[9.0, 9.0], "push after clear");
}

// ----- mirror writes don't leak stale values across wraps -----

#[test]
fn mirror_write_overwrites_stale_oldest_slot() {
    // A classic "forgot to write the mirror" bug would leave the stale
    // oldest frame visible at the mirror offset, which then shows up
    // as a duplicated frame in the window after wrap. Explicitly
    // assert uniqueness.
    let frame_len = 2;
    let capacity = 3;
    let mut buf = ResidualRingBuf::new(frame_len, capacity);
    for s in 0..capacity as u32 {
        buf.push(&synthetic_frame(frame_len, s));
    }
    // Wrap once.
    buf.push(&synthetic_frame(frame_len, 100));
    let w = buf.window();
    // Expected: [f1, f2, f100].
    approx_eq(
        &w[0..frame_len],
        &synthetic_frame(frame_len, 1),
        "oldest after wrap",
    );
    approx_eq(
        &w[frame_len..2 * frame_len],
        &synthetic_frame(frame_len, 2),
        "middle after wrap",
    );
    approx_eq(
        &w[2 * frame_len..3 * frame_len],
        &synthetic_frame(frame_len, 100),
        "newest after wrap",
    );
}
