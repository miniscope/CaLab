//! Per-frame OMF step composing the primitive fit nodes
//! (thesis §3.2.3, Algorithm 6).
//!
//! Pipeline order:
//! 1. `EvaluateTraces`        — NNLS-BCD for `c̃_t` given current `Ã`
//! 2. Residual for throttling — `R_raw = y_t − Ã c̃_t`
//! 3. `trace_throttle`        — Eq. 3.39 underfit correction
//! 4. Append corrected `c̃_t` to trace history
//! 5. `EvaluateSuffStats`     — recursive-mean update of `W`, `M`
//! 6. `EvaluateFootprints`    — CD update of `Ã` from `W`, `M`
//! 7. Final residual           — `R_t = y_t − Ã_new c̃_t` (output for Extend)
//!
//! Throttle placement note: the thesis describes throttling as
//! "during the residual computation" (step 7 of Alg 6). We apply it
//! *before* the suff-stats and footprint updates so those see the
//! corrected traces — same end state, but `W`/`M` do not accumulate
//! the over-estimated pre-throttle traces, which matches the "data
//! cleaning" framing at the end of thesis §3.2.3.

use crate::assets::{Footprints, Groups, SuffStats, Traces};
use crate::config::FitConfig;
use crate::extending::mutation::{Epoch, Snapshot};

use super::{
    evaluate_footprints, evaluate_residual, evaluate_suff_stats, evaluate_traces, trace_throttle,
};

/// Holds all persistent OMF state and runs one frame per `step`.
#[derive(Debug)]
pub struct FitPipeline {
    fp: Footprints,
    traces: Traces,
    ss: SuffStats,
    cfg: FitConfig,
    /// Scratch buffer for the residual — reused across frames to avoid
    /// per-frame allocation in the fit hot path.
    residual: Vec<f32>,
    /// Monotonic counter that advances every time the fit side applies
    /// a `PipelineMutation` (Phase 3 Task 10). Per-frame `step` calls
    /// do not bump the epoch — epoch only tracks structural changes
    /// to `(Ã, C̃, W, M, G)`, not numeric updates.
    epoch: Epoch,
}

impl FitPipeline {
    pub fn new(fp: Footprints, cfg: FitConfig) -> Self {
        let k = fp.len();
        let pixels = fp.pixels();
        Self {
            traces: Traces::new(k),
            ss: SuffStats::new(pixels, k),
            residual: vec![0.0f32; pixels],
            fp,
            cfg,
            epoch: 0,
        }
    }

    /// Current asset epoch — advances on every mutation apply.
    pub fn epoch(&self) -> Epoch {
        self.epoch
    }

    /// Deep-clone of the extend-visible state `(Ã, W, M, epoch)`
    /// (design §7.2). `C̃` is not part of the snapshot — extend
    /// reads only the most recent window from the residual ring and
    /// per-component traces it is passed explicitly.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot::new(self.fp.clone(), self.ss.clone(), self.epoch)
    }

    pub fn footprints(&self) -> &Footprints {
        &self.fp
    }

    pub fn traces(&self) -> &Traces {
        &self.traces
    }

    pub fn suff_stats(&self) -> &SuffStats {
        &self.ss
    }

    pub fn config(&self) -> &FitConfig {
        &self.cfg
    }

    /// Most recent residual frame (length `pixels()`).
    pub fn last_residual(&self) -> &[f32] {
        &self.residual
    }

    /// Run one OMF frame. Returns the residual `R_t` so callers can
    /// feed it to an Extend loop (Phase 3) or inspect for diagnostics.
    pub fn step(&mut self, y: &[f32]) -> &[f32] {
        assert_eq!(
            y.len(),
            self.fp.pixels(),
            "y length {} must equal pixels {}",
            y.len(),
            self.fp.pixels()
        );

        // 1. Trace update (NNLS-BCD grouped by spatial overlap).
        //    Groups are rebuilt each frame because `EvaluateFootprints`
        //    may have shrunk support on the previous frame, which in
        //    turn can split a group into disjoint ones.
        let c_prev: Vec<f32> = match self.traces.last() {
            Some(prev) => prev.to_vec(),
            None => vec![0.0f32; self.fp.len()],
        };
        let groups = Groups::from_footprints(&self.fp);
        let mut c = evaluate_traces(&self.fp, &groups, y, &c_prev, &self.cfg);

        // 2. Residual for throttle (against current Ã — this frame's
        //    footprint update has not happened yet).
        evaluate_residual(&self.fp, &c, y, &mut self.residual);

        // 3. Underfit correction.
        trace_throttle(&self.fp, &mut c, &self.residual);

        // 4. Record corrected trace in history.
        self.traces.push(&c);

        // 5–6. Learn from the corrected trace.
        evaluate_suff_stats(&mut self.ss, y, &c, &self.cfg);
        evaluate_footprints(&mut self.fp, &self.ss, &self.cfg);

        // 7. Final residual. Post-throttle c, post-update Ã — the
        //    frame-t residual the Extend loop will consume.
        evaluate_residual(&self.fp, &c, y, &mut self.residual);
        &self.residual
    }
}
