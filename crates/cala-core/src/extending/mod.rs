//! Extend loop — slow-cycle component discovery and curation
//! (design §3, thesis §3.3).
//!
//! Runs on a consistent snapshot of `(Ã, W, M)` and a window of recent
//! residuals, proposing `PipelineMutation`s (register / merge /
//! deprecate) back to the fit loop. Submodules split the pipeline
//! along the cala reference algorithmic stages:
//!
//! - `segment`    — max-variance patch + rank-1 NMF + quality gates
//! - `overlap`    — spatial support intersection
//! - `redundancy` — temporal-trace correlation vs existing components
//! - `merge`      — reconstructed-movie rank-1 NMF for an overlapping
//!   + correlated pair
//!
//! Scaffold only: each submodule ships a typed stub in Phase 3 Task 1
//! and is filled in by its dedicated task (3–7).

pub mod driver;
pub mod merge;
pub mod mutation;
pub mod overlap;
pub mod redundancy;
pub mod segment;
