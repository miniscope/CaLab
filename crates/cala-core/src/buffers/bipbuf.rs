//! Residual ring buffer for the extend loop.
//!
//! "Bip-buffer" in the sense of design §5: a single `Vec<f32>` sized
//! `2 × capacity × frame_len` where every push writes the frame into
//! *both* the primary slot and its mirror at offset `capacity`. The
//! mirror guarantees the most recent `capacity` frames are always
//! readable as a single contiguous `&[f32]` slice regardless of how
//! many times the head pointer has wrapped — no `VecDeque`-style
//! two-slice splitting, no per-cycle copy to a scratch window.
//!
//! Invariants:
//! - Each frame is exactly `frame_len` pixels.
//! - `len()` counts frames currently in the window, saturating at
//!   `capacity`. Oldest-to-newest order over `window()`.
//! - `window().len() == len() * frame_len`. Memory is contiguous.

/// Residual ring buffer with an O(1) contiguous window slice.
#[derive(Debug)]
pub struct ResidualRingBuf {
    frame_len: usize,
    capacity: usize,
    /// Mirrored storage: `2 * capacity * frame_len` f32s. Primary
    /// region is `[0, capacity * frame_len)`; mirror is
    /// `[capacity * frame_len, 2 * capacity * frame_len)`.
    storage: Vec<f32>,
    /// Slot (0..capacity) of the next frame to write. Once the
    /// buffer is full, this is also the slot of the *oldest* frame.
    head: usize,
    /// Frames currently in the window, clamped to `capacity`.
    count: usize,
}

impl ResidualRingBuf {
    /// Allocate a ring holding up to `capacity` frames of `frame_len`
    /// pixels each. Panics on zero for either argument.
    pub fn new(frame_len: usize, capacity: usize) -> Self {
        assert!(frame_len > 0, "frame_len must be positive (got 0)");
        assert!(capacity > 0, "capacity must be positive (got 0)");
        let total = capacity
            .checked_mul(frame_len)
            .and_then(|n| n.checked_mul(2))
            .expect("2 * capacity * frame_len overflowed usize");
        Self {
            frame_len,
            capacity,
            storage: vec![0.0f32; total],
            head: 0,
            count: 0,
        }
    }

    pub fn frame_len(&self) -> usize {
        self.frame_len
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Number of frames currently in the window (0..=capacity).
    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn is_full(&self) -> bool {
        self.count == self.capacity
    }

    /// Push `frame` as the newest entry, dropping the oldest when full.
    pub fn push(&mut self, frame: &[f32]) {
        assert_eq!(
            frame.len(),
            self.frame_len,
            "frame length {} must equal frame_len {}",
            frame.len(),
            self.frame_len
        );
        let primary_start = self.head * self.frame_len;
        let mirror_start = (self.head + self.capacity) * self.frame_len;
        let end = self.frame_len;
        self.storage[primary_start..primary_start + end].copy_from_slice(frame);
        self.storage[mirror_start..mirror_start + end].copy_from_slice(frame);

        self.head = (self.head + 1) % self.capacity;
        if self.count < self.capacity {
            self.count += 1;
        }
    }

    /// Contiguous slice over the most recent `len()` frames in push
    /// order: oldest at pixel 0, newest at pixel
    /// `(len() - 1) * frame_len`.
    pub fn window(&self) -> &[f32] {
        if self.count == 0 {
            return &self.storage[0..0];
        }
        if self.count < self.capacity {
            // Never wrapped. Slots 0..count hold the frames in push order
            // in the primary region.
            &self.storage[0..self.count * self.frame_len]
        } else {
            // Full. `head` is the oldest-frame slot. The mirror
            // guarantees `[head, head + capacity)` lives in one
            // contiguous memory range.
            let start = self.head * self.frame_len;
            let end = start + self.capacity * self.frame_len;
            &self.storage[start..end]
        }
    }

    /// Slice for the `i`-th frame in the window
    /// (0 = oldest, `len() - 1` = newest).
    pub fn frame(&self, i: usize) -> &[f32] {
        assert!(
            i < self.count,
            "frame index {i} out of range (len = {})",
            self.count
        );
        let window = self.window();
        &window[i * self.frame_len..(i + 1) * self.frame_len]
    }

    /// Most-recently-pushed frame, or `None` if the buffer is empty.
    pub fn latest(&self) -> Option<&[f32]> {
        if self.count == 0 {
            None
        } else {
            Some(self.frame(self.count - 1))
        }
    }

    /// Drop all frames. Storage capacity is preserved.
    pub fn clear(&mut self) {
        self.head = 0;
        self.count = 0;
    }
}
