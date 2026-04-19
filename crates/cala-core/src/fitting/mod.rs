//! Online matrix factorization (OMF) fit loop.
//!
//! Per-frame portion of the cala pipeline described in thesis §3.2.3
//! (Algorithm 6). One frame goes in, the model state (`Ã`, `C̃`, `W`,
//! `M`, `G`) is updated, and a residual comes out for the (Phase 3)
//! Extend loop to consume.
//!
//! Submodules follow the algorithmic split from the thesis so each
//! primitive can be tested in isolation against its defining equation:
//! `trace_bcd` → Algorithm 7, `suff_stats` → Eq. 3.25, `footprints`
//! → Algorithm 8, `residual` → Eq. 3.24, `throttle` → underfit
//! correction discussion following Eq. 3.24.

mod footprints;
mod pipeline;
mod residual;
mod suff_stats;
mod throttle;
mod trace_bcd;

pub use footprints::evaluate_footprints;
pub use pipeline::{AppliedEvent, ApplyBatchReport, ApplyOutcome, FitPipeline};
pub use residual::evaluate_residual;
pub use suff_stats::evaluate_suff_stats;
pub use throttle::trace_throttle;
pub use trace_bcd::evaluate_traces;
