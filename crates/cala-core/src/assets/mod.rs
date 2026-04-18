//! Asset types shared by all CaLa numerical modules.
//!
//! For Phase 1 this module exposes only the `Axis` tag enum and the
//! `Frame` / `FrameMut` view types used by preprocess. The full persistent
//! asset suite (footprints A, traces C, suff-stats W/M, groups G, residual R)
//! arrives in Phase 2+; see design §5.

mod footprints;
mod frame;
mod groups;
mod suff_stats;
mod traces;

pub use footprints::Footprints;
pub use frame::{Frame, FrameMut, ShapeError};
pub use groups::Groups;
pub use suff_stats::SuffStats;
pub use traces::Traces;

/// Logical axis labels used across the crate.
///
/// Pinning axis identity with explicit tags (rather than relying on
/// numeric positions) prevents the "dimension 0 means time" bug class
/// that xarray guards against in the Python reference (thesis §3.2.1).
/// Functions that operate on typed slices internally still accept
/// axis tags at the boundary for debug-build correctness checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Axis {
    /// Vertical spatial axis (image rows, y).
    Height,
    /// Horizontal spatial axis (image columns, x).
    Width,
    /// Time axis (frame index).
    Time,
    /// Component axis (neuron / estimator index).
    Component,
}
