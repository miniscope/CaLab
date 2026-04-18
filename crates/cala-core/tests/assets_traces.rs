//! Tests for the trace history `C̃` (thesis §3.2.3, `C̃ = [C; f]`).
//!
//! `C̃` is the t × k matrix of temporal coefficients for every estimator
//! at every past frame. Phase 2 stores the whole history in RAM — the
//! persistence trait that lets this back onto a lazy-loaded Zarr /
//! OPFS store arrives later (design §5, `buffers/persistence.rs`).

use calab_cala_core::assets::Traces;

const F32_TOL: f32 = 1e-6;

fn assert_slice_close(actual: &[f32], expected: &[f32], ctx: &str) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{ctx}: length mismatch ({} vs {})",
        actual.len(),
        expected.len()
    );
    for (i, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
        let diff = (a - e).abs();
        assert!(
            diff <= F32_TOL,
            "{ctx}[{i}]: expected {e}, got {a} (diff {diff} > tol {F32_TOL})"
        );
    }
}

#[test]
fn new_traces_are_empty() {
    let tr = Traces::new(5);
    assert_eq!(tr.k(), 5);
    assert_eq!(tr.len(), 0);
    assert!(tr.is_empty());
    assert!(tr.last().is_none());
}

#[test]
fn push_grows_length() {
    let mut tr = Traces::new(3);
    tr.push(&[1.0, 2.0, 3.0]);
    assert_eq!(tr.len(), 1);
    tr.push(&[4.0, 5.0, 6.0]);
    assert_eq!(tr.len(), 2);
    assert!(!tr.is_empty());
}

#[test]
fn last_returns_most_recent_trace() {
    let mut tr = Traces::new(2);
    tr.push(&[0.1, 0.2]);
    tr.push(&[0.3, 0.4]);
    assert_slice_close(tr.last().unwrap(), &[0.3, 0.4], "last after two pushes");
}

#[test]
fn get_retrieves_trace_by_frame_index() {
    let mut tr = Traces::new(2);
    tr.push(&[10.0, 20.0]);
    tr.push(&[30.0, 40.0]);
    tr.push(&[50.0, 60.0]);
    assert_slice_close(tr.get(0).unwrap(), &[10.0, 20.0], "frame 0");
    assert_slice_close(tr.get(1).unwrap(), &[30.0, 40.0], "frame 1");
    assert_slice_close(tr.get(2).unwrap(), &[50.0, 60.0], "frame 2");
    assert!(tr.get(3).is_none());
}

#[test]
#[should_panic(expected = "trace length")]
fn push_rejects_wrong_length() {
    let mut tr = Traces::new(3);
    tr.push(&[1.0, 2.0]);
}

#[test]
fn as_matrix_is_row_major_t_by_k() {
    // Row-major `t × k` layout: frame t's trace occupies contiguous
    // indices `t*k .. (t+1)*k`. This matches the `C̃` convention in
    // the thesis and lets a future noob boundary layer hand it off to
    // `xarray` with a simple `.reshape((t, k))`.
    let mut tr = Traces::new(2);
    tr.push(&[1.0, 2.0]);
    tr.push(&[3.0, 4.0]);
    tr.push(&[5.0, 6.0]);
    assert_slice_close(
        tr.as_matrix(),
        &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        "flat layout",
    );
}

#[test]
fn zero_components_is_allowed_but_inert() {
    // Useful as a degenerate starting state before the first estimator
    // is seeded / extended in. `len` advances by one per push of an
    // empty slice so the frame counter still reflects elapsed frames.
    let mut tr = Traces::new(0);
    tr.push(&[]);
    tr.push(&[]);
    assert_eq!(tr.k(), 0);
    assert_eq!(tr.len(), 2);
    assert!(tr.as_matrix().is_empty());
}
