//! Trace history `C̃` (thesis §3.2.3).
//!
//! Row `t` is the trace vector `c̃_t ∈ R^k` for frame `t`. Stored as a
//! flat row-major `Vec<f32>` so the boundary layer can hand it to
//! numpy / xarray as a `(t, k)` view without any copy.
//!
//! Phase 2 holds the whole history in RAM; a `PersistentTraceBacking`
//! trait (design §5) will later back this onto Zarr / OPFS.

#[derive(Debug, Clone)]
pub struct Traces {
    k: usize,
    /// Row-major `len × k` storage. `len = data.len() / max(k, 1)`.
    data: Vec<f32>,
    /// Frame count tracked explicitly so a zero-component history
    /// (`k == 0`) can still advance a counter with each `push`.
    frames: usize,
}

impl Traces {
    pub fn new(k: usize) -> Self {
        Self {
            k,
            data: Vec::new(),
            frames: 0,
        }
    }

    /// Number of components per trace.
    pub fn k(&self) -> usize {
        self.k
    }

    /// Number of frames pushed.
    pub fn len(&self) -> usize {
        self.frames
    }

    pub fn is_empty(&self) -> bool {
        self.frames == 0
    }

    /// Append `c̃_t` for the next frame. `trace.len()` must equal `k()`.
    pub fn push(&mut self, trace: &[f32]) {
        assert_eq!(
            trace.len(),
            self.k,
            "trace length {} must equal k = {}",
            trace.len(),
            self.k
        );
        self.data.extend_from_slice(trace);
        self.frames += 1;
    }

    /// Slice `c̃_t` for frame `t`, or `None` if out of range.
    pub fn get(&self, t: usize) -> Option<&[f32]> {
        if t >= self.frames || self.k == 0 {
            if t >= self.frames {
                return None;
            }
            // k == 0 but frame is in range — return empty slice.
            return Some(&[]);
        }
        let start = t * self.k;
        Some(&self.data[start..start + self.k])
    }

    /// Most recently pushed trace.
    pub fn last(&self) -> Option<&[f32]> {
        if self.frames == 0 {
            None
        } else {
            self.get(self.frames - 1)
        }
    }

    /// Flat row-major `(len × k)` view of the full history.
    pub fn as_matrix(&self) -> &[f32] {
        &self.data
    }
}
