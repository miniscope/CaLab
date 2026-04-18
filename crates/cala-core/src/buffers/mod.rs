//! Streaming buffers shared by the fit and extend loops.
//!
//! Phase 3 introduces `bipbuf`, a 2n-allocated circular buffer that
//! gives extend an O(1) contiguous slice over the most recent W
//! residual frames without per-cycle copies. Further persistence-
//! oriented buffers (OPFS / Zarr trace backing) arrive in later
//! phases; see design §5 for the planned layout.

pub mod bipbuf;
