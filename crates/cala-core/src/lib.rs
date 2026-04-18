//! CaLa numerical core.
//!
//! Implements the streaming calcium imaging demixing pipeline described in
//! `.planning/CALA_DESIGN.md`. Modules are added as Phase 1+ tasks land
//! test-first per design §4.1.

#![deny(unsafe_op_in_unsafe_fn)]

pub mod assets;
pub mod buffers;
pub mod config;
pub mod extending;
pub mod fitting;
pub mod io;
pub mod preprocess;
