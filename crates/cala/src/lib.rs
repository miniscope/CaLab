//! cala: a streaming, in-browser pipeline from raw 1-photon Miniscope video to
//! per-cell footprints and traces.
//!
//! Modules, in pipeline order:
//!
//! * [`avi`]: the frame source, an AVI header and frame-offset parser that
//!   works on byte ranges, so the browser can read a multi-gigabyte file with
//!   `File.slice` without loading it.
//! * [`preprocess`]: hot pixels, glow flattening (the spatial high-pass), line
//!   artifacts, background floor and noise map.
//! * [`motion`]: rigid and piecewise-rigid motion correction.
//! * [`discover`]: the slow loop, streaming cell discovery (add, merge,
//!   refine footprints) that publishes new library versions to the fast loop.
//! * [`trace`]: the fast loop, per-frame cell traces from a (swappable)
//!   footprint library, and re-extraction of past frames.
//! * [`qc`]: online quality control of traces, footprints and demixing,
//!   computed alongside the fast loop from the data alone.
//!
//! Errors are typed ([`AviError`]); nothing on a public path panics, because a
//! panic is a trap that leaves the WASM module unusable in its worker.

pub mod avi;
pub mod discover;
pub mod motion;
pub mod preprocess;
pub mod qc;
pub mod trace;

pub use avi::{AviError, AviHeader, AviInfo, PixelFormat};

/// The crate version, `version` in this crate's Cargo.toml.
pub const CALA_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(feature = "jsbindings")]
mod js_avi;

#[cfg(feature = "pybindings")]
mod py_api;

/// WASM export of [`CALA_VERSION`], so the app can report the core's version.
#[cfg(feature = "jsbindings")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn cala_version() -> String {
    CALA_VERSION.to_string()
}
