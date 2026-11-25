//! Stage timers of the slow loop (measurement only; feature `timing`).
//!
//! Without the feature every [`Lap`] is a zero-sized no-op and the sums in
//! [`StageTiming`] stay zero, so a normal build does exactly what it did
//! before. With it, `observe` is split into its stages and every visit into
//! its phases (wall ms, summed), natively on `std::time::Instant` and in
//! the browser on `performance.now()` (about 0.1 ms resolution without
//! cross-origin isolation: read sums over many frames, never one frame).
//! Nothing here is read back by the loop; it changes no result.

/// The stages of [`super::SlowLoop::observe`], in order.
pub const OBS_PARTS: [&str; 9] = [
    "render",
    "whiten",
    "scale",
    "ncorr",
    "ledger",
    "fpstats",
    "clusters",
    "reservoir",
    "probes",
];

/// The phases of a visit (`visit_tests`), in order. `load` reads the
/// tile's reservoir frames, `solve` the tile's model solve (and its
/// re-solve after a split).
pub const VISIT_PARTS: [&str; 7] = ["keep", "load", "solve", "split", "refine", "merge", "add"];

/// What a visit phase changed: adds, merges, refines, splits, deletes,
/// absorbs, proposals (counts from [`super::SlowStats`] deltas).
pub const EDIT_KINDS: [&str; 7] = [
    "adds",
    "merges",
    "refines",
    "splits",
    "deletes",
    "absorbs",
    "proposals",
];

/// Summed stage times (ms) and calls.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StageTiming {
    /// `observe` calls timed, and ms per stage.
    pub observe_calls: u64,
    pub observe: [f64; OBS_PARTS.len()],
    /// Visits timed (`visit_tests` calls), and ms and edits per phase.
    pub visit_calls: u64,
    pub visit: [f64; VISIT_PARTS.len()],
    pub visit_edits: [[u64; EDIT_KINDS.len()]; VISIT_PARTS.len()],
}

impl StageTiming {
    /// Flattened for JS: `[observe_calls, observe.., visit_calls, visit..,
    /// visit_edits (phase-major)..]`.
    pub fn to_vec(&self) -> Vec<f64> {
        let mut v = vec![self.observe_calls as f64];
        v.extend(self.observe);
        v.push(self.visit_calls as f64);
        v.extend(self.visit);
        for row in &self.visit_edits {
            v.extend(row.iter().map(|&x| x as f64));
        }
        v
    }

    /// Add another loop's sums (a visit worker's, in a replay).
    pub fn add(&mut self, o: &StageTiming) {
        self.observe_calls += o.observe_calls;
        self.visit_calls += o.visit_calls;
        for (a, b) in self.observe.iter_mut().zip(o.observe) {
            *a += b;
        }
        for (a, b) in self.visit.iter_mut().zip(o.visit) {
            *a += b;
        }
        for (ra, rb) in self.visit_edits.iter_mut().zip(o.visit_edits) {
            for (a, b) in ra.iter_mut().zip(rb) {
                *a += b;
            }
        }
    }
}

/// The parts of a library build (`SlowLoop::publish`:
/// `LibraryBuilder::build` then the working-set rebuild), in order:
///
/// - `prep`: supports, moat blocks, the reuse check of unchanged cells;
/// - `filter`: canvas packing and the filter passes (with the moat block
///   means and skirts of the filtered cells);
/// - `finish`: `Core::finish` (block FOV counts and noise, `vc`);
/// - `setup`: assemble's extents, neighbour grid and pair-reuse table;
/// - `cell`: assemble's per-cell scans (paint, diagonal, noise, clear);
/// - `pair`: the off-diagonal Gram terms (computed or copied);
/// - `ring_scan`: ring sums and ring pixels of each cell;
/// - `ring_q`: the ring couplings (paint, computed or copied, clear);
/// - `rest`: groups, sorting rows, background terms other than the ring;
/// - `cells`: `publish` rebuilding its working set from the library.
///
/// `cell`, `pair`, `ring_scan` and `ring_q` are lapped per cell, natively
/// only (the browser clock is too coarse); in a WASM build their time is
/// in `rest`.
pub const BUILD_PARTS: [&str; 10] = [
    "prep",
    "filter",
    "finish",
    "setup",
    "cell",
    "pair",
    "ring_scan",
    "ring_q",
    "rest",
    "cells",
];

/// The counts of [`BuildTiming`], in order: builds, cells, cells filtered
/// (changed), filter passes (canvases), Gram pair terms computed and
/// copied, ring couplings computed and copied, grid-block look-ups of a
/// pixel (`block_of` or its table; the cached ones are not counted), and the
/// calibration pass (`block_of` over every support pixel once per build,
/// timed on its own: `cal_ms` / `cal_calls` is the cost of one call).
pub const BUILD_COUNTS: [&str; 10] = [
    "builds",
    "cells",
    "filtered",
    "passes",
    "pairs_computed",
    "pairs_copied",
    "ring_computed",
    "ring_copied",
    "block_of_calls",
    "cal_calls",
];

/// Summed library-build times (ms) and counts (feature `timing`; zero
/// otherwise). Measurement only.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BuildTiming {
    pub ms: [f64; BUILD_PARTS.len()],
    pub counts: [u64; BUILD_COUNTS.len()],
    /// The calibration pass's ms (not part of any build part).
    pub cal_ms: f64,
}

impl BuildTiming {
    /// `[ms.., counts.., cal_ms]`.
    pub fn to_vec(&self) -> Vec<f64> {
        let mut v: Vec<f64> = self.ms.to_vec();
        v.extend(self.counts.iter().map(|&c| c as f64));
        v.push(self.cal_ms);
        v
    }

    /// Add `n` to count `k` (no-op without `timing`).
    #[inline(always)]
    pub fn count(&mut self, _k: usize, _n: u64) {
        #[cfg(feature = "timing")]
        {
            self.counts[_k] += _n;
        }
    }
}

/// Index of a [`BUILD_PARTS`] entry.
pub mod part {
    pub const PREP: usize = 0;
    pub const FILTER: usize = 1;
    pub const FINISH: usize = 2;
    pub const SETUP: usize = 3;
    pub const CELL: usize = 4;
    pub const PAIR: usize = 5;
    pub const RING_SCAN: usize = 6;
    pub const RING_Q: usize = 7;
    pub const REST: usize = 8;
    pub const CELLS: usize = 9;
}

/// Index of a [`BUILD_COUNTS`] entry.
pub mod count {
    pub const BUILDS: usize = 0;
    pub const CELLS: usize = 1;
    pub const FILTERED: usize = 2;
    pub const PASSES: usize = 3;
    pub const PAIRS_COMPUTED: usize = 4;
    pub const PAIRS_COPIED: usize = 5;
    pub const RING_COMPUTED: usize = 6;
    pub const RING_COPIED: usize = 7;
    pub const BLOCK_OF: usize = 8;
    pub const CAL: usize = 9;
}

/// Whether the timers are compiled in.
pub const ON: bool = cfg!(feature = "timing");

/// Whether the per-cell laps of a build run (native `timing` builds only).
pub const FINE: bool = ON && !cfg!(target_arch = "wasm32");

#[cfg(all(feature = "timing", target_arch = "wasm32", feature = "jsbindings"))]
mod clock {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = performance, js_name = now)]
        fn perf_now() -> f64;
    }

    pub fn now_ms() -> f64 {
        perf_now()
    }
}

#[cfg(all(feature = "timing", not(target_arch = "wasm32")))]
mod clock {
    use std::sync::OnceLock;
    use std::time::Instant;

    static T0: OnceLock<Instant> = OnceLock::new();

    pub fn now_ms() -> f64 {
        T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1e3
    }
}

#[cfg(all(
    feature = "timing",
    target_arch = "wasm32",
    not(feature = "jsbindings")
))]
mod clock {
    pub fn now_ms() -> f64 {
        0.0
    }
}

/// A running mark: each [`Lap::lap`] adds the time since the last mark to
/// a sum and moves the mark. Zero-sized and free without `timing`.
pub struct Lap {
    #[cfg(feature = "timing")]
    t: f64,
}

impl Lap {
    #[inline(always)]
    pub fn start() -> Lap {
        Lap {
            #[cfg(feature = "timing")]
            t: clock::now_ms(),
        }
    }

    #[inline(always)]
    pub fn lap(&mut self, _sum: &mut f64) {
        #[cfg(feature = "timing")]
        {
            let t = clock::now_ms();
            *_sum += t - self.t;
            self.t = t;
        }
    }

    /// [`Lap::lap`] where the clock is fine enough for per-cell laps
    /// ([`FINE`]); elsewhere the mark stays, so the time goes to the next
    /// plain lap.
    #[inline(always)]
    pub fn lap_fine(&mut self, sum: &mut f64) {
        if FINE {
            self.lap(sum);
        }
    }
}
