//! Residual ring buffer for the extend loop.
//!
//! Scaffold only — the 2n-allocated contiguous-slice ring implementation
//! lands in Task 2. This stub pins the public surface (constructor,
//! `push`, contiguous window access) so downstream scaffolds (segment,
//! mutation harness) can import the type.

/// Residual ring buffer. Stores the most recent `capacity` frames of
/// length `frame_len` each, exposing them as a single contiguous slice
/// via `window`.
#[derive(Debug)]
pub struct ResidualRingBuf {
    frame_len: usize,
    capacity: usize,
}

impl ResidualRingBuf {
    /// Allocate a ring that holds up to `capacity` frames of
    /// `frame_len` pixels each. Panics on zero.
    pub fn new(frame_len: usize, capacity: usize) -> Self {
        assert!(frame_len > 0, "frame_len must be positive");
        assert!(capacity > 0, "capacity must be positive");
        Self {
            frame_len,
            capacity,
        }
    }

    pub fn frame_len(&self) -> usize {
        self.frame_len
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }
}
