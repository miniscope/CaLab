//! The fast loop: per-frame cell traces from a footprint library.
//!
//! Given preprocessed frames (flattened, registered, floor-subtracted; see
//! [`crate::preprocess`]) and a library of cell footprints, the fast loop
//! solves every frame for one non-negative activity value per cell plus a few
//! background coefficients, in time independent of the recording length.
//!
//! # Forward model
//!
//! ```text
//! y_t  =  Σ_i (H a_i) c_i(t)  +  Σ_k g_k β_k(t)  +  noise
//! ```
//!
//! * `a_i ≥ 0` is cell `i`'s footprint in the **unfiltered** image. The
//!   preprocessing high-pass `H` (glow flattening, a linear operator) acts on
//!   the cells too, so the model column is the *filtered* footprint `H a_i`,
//!   computed by running the same flattener on the footprint
//!   ([`LinearFilter`]). It has negative lobes and is never clipped: fitting
//!   `max(H a, 0)` or a footprint estimated non-negative in filtered space
//!   leaks 3-11 % of each neighbour into a trace (experiments for milestone 3).
//! * Each footprint lives on a tight disk-shaped support, about 2.5 core
//!   half-widths (~15 px for a 12 px soma, [`LibraryConfig`]). A wider support
//!   lets the scatter halo and background pull on the trace; truncating at a
//!   percentage of the peak instead adds crosstalk.
//! * The background `Σ_k g_k β_k` is either nothing, a global mode (one fixed
//!   spatial map, one scalar per frame: the common-mode flicker and gain of
//!   1-photon data), the global mode plus a few smooth low-rank components
//!   (local neuropil), or a CNMF-E-style ring estimate around each cell
//!   ([`BackgroundModel`]). Spatial maps come from the data
//!   ([`BackgroundLearner`]).
//!
//! # Solve
//!
//! Per frame the solver needs only the projections `ã_iᵀ y` (one pass over
//! each support), `g_kᵀ y` and, for the ring model, the ring means. The rest
//! (the sparse Gram matrix `ã_iᵀ ã_j`, the cross terms with the background
//! maps and their inverse Gram) is precomputed once per [`Library`]. The
//! background coefficients are eliminated exactly (they are unconstrained),
//! so each coordinate step minimises the joint objective over `c_i` with `β`
//! re-solved, and cells are swept in overlap groups (connected components of
//! the footprint-overlap graph), warm-started from the previous frame.
//! Convergence is measured in noise units: a sweep that moves no trace by
//! more than `tol` of its own noise standard deviation stops the group.
//!
//! # Library swaps and re-extraction
//!
//! A [`Library`] is immutable and carries a version number; the engine holds
//! it in an `Arc`, and [`TraceEngine::set_library`] swaps it between frames
//! (the slow loop's job), carrying each surviving cell's warm start over by
//! its id. [`extract_span`] re-runs preprocessing (from a saved
//! [`crate::preprocess::PreprocessState`] and the motion records) and the
//! trace solve over a span of raw frames, which is how pass 2 back-propagates
//! a newer library into earlier frames.

mod background;
mod extract;
mod library;
mod solver;

#[cfg(feature = "jsbindings")]
pub(crate) mod js;

use std::fmt;

pub use background::{BackgroundFit, BackgroundLearner, BackgroundModel};
pub use extract::{extract_preprocessed, extract_span, ReplayRegistrar};
pub(crate) use library::{support_disk, BgTerms, Support};
pub use library::{
    Footprint, IdentityFilter, Library, LibraryBuilder, LibraryConfig, LinearFilter,
};
pub use solver::{FrameTraces, SolverConfig, TraceEngine, TraceState};

use crate::preprocess::PreprocessError;

/// Error returned by every fallible trace entry point.
#[derive(Debug, Clone, PartialEq)]
pub enum TraceError {
    /// A configuration value is out of range.
    InvalidConfig(String),
    /// A buffer does not hold the expected number of elements.
    LengthMismatch {
        what: &'static str,
        expected: usize,
        got: usize,
    },
    /// A footprint is malformed (outside the frame, negative, non-finite).
    InvalidFootprint(String),
    /// A library or state does not fit the engine (frame size, cell count).
    Incompatible(String),
    /// A preprocessing step failed during re-extraction.
    Preprocess(PreprocessError),
}

impl fmt::Display for TraceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TraceError::InvalidConfig(m) => write!(f, "invalid trace config: {m}"),
            TraceError::LengthMismatch {
                what,
                expected,
                got,
            } => write!(f, "{what}: expected {expected} elements, got {got}"),
            TraceError::InvalidFootprint(m) => write!(f, "invalid footprint: {m}"),
            TraceError::Incompatible(m) => write!(f, "incompatible: {m}"),
            TraceError::Preprocess(e) => write!(f, "preprocessing: {e}"),
        }
    }
}

impl std::error::Error for TraceError {}

impl From<PreprocessError> for TraceError {
    fn from(e: PreprocessError) -> TraceError {
        TraceError::Preprocess(e)
    }
}

pub(crate) fn check_len(what: &'static str, expected: usize, got: usize) -> Result<(), TraceError> {
    if expected == got {
        Ok(())
    } else {
        Err(TraceError::LengthMismatch {
            what,
            expected,
            got,
        })
    }
}

#[cfg(test)]
mod tests;
