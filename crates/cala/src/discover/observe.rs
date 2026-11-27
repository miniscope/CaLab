//! Per-frame input: the residual score that fills the reservoirs, and the
//! frames the concurrent settle and look-back feed to the statistics.

use super::local::Rect;
use super::math::MAD_TO_SIGMA;
use super::reservoir::mix;
use super::{timing, SettleStats, SlowLoop};
use crate::trace::{BackgroundModel, FrameTraces, Library, TraceError};

impl SlowLoop {
    /// Feed one preprocessed frame and the fast loop's result for it.
    /// `lib` must be the library that produced `traces`.
    pub fn observe(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
    ) -> Result<(), TraceError> {
        let n_px = self.dims.pixels();
        self.stage.observe_calls += u64::from(timing::ON);
        let scale = self.score_residual(frame, lib, traces)?;
        self.visit_rate_frame();
        let mut lap = timing::Lap::start();
        self.work += (n_px * 4 + self.coarse.len() * 30) as u64;
        if self.cfg.noise_corr {
            self.work += self.ncorr.push(&self.z, &self.fov, self.dims);
            self.rho = self.ncorr.rho(self.cfg.cell_diameter_px);
        }
        lap.lap(&mut self.stage.observe[3]);
        self.update_ledger(frame, lib, traces);
        lap.lap(&mut self.stage.observe[4]);
        let frame_idx = self.frames;
        let test = self.is_test(frame_idx);
        let (per_cell, clusters) = self.update_fpstats(frame, lib, traces, !test);
        self.stage.observe[5] += per_cell;
        self.stage.observe[6] += clusters;
        let mut lap = timing::Lap::start();
        if self.res_frozen {
            self.frames += 1;
            return Ok(());
        }
        // Random slots: one uniform sample for every tile.
        self.rng = mix(self.rng);
        let w = self.dims.width;
        let took = self
            .shared
            .offer(&self.z, w, frame_idx, test, self.cap_random, self.rng);
        for ti in 0..self.tiles.len() {
            let score = self.tile_score(ti, scale);
            let tile = &mut self.tiles[ti];
            let before = tile.fresh;
            tile.offer(
                &self.z,
                w,
                frame_idx,
                score,
                test,
                self.cap_events,
                self.ln_decay,
            );
            if let Some(j) = took {
                tile.set_random(j, frame_idx, test);
            }
            let due = self.cfg.visit_after_slots;
            self.due_diag.slots += u64::from(before < due && tile.fresh >= due);
        }
        lap.lap(&mut self.stage.observe[7]);
        if test {
            self.take_probes(lib, frame_idx);
        }
        lap.lap(&mut self.stage.observe[8]);
        self.frames += 1;
        Ok(())
    }

    /// Turn the concurrent settle on. Until this is called
    /// [`SlowLoop::observe_settle`] refuses to run and nothing else changes.
    pub fn enable_settle(&mut self) {
        self.cs_on = true;
    }

    /// Counters of the concurrent settle.
    pub fn settle_stats(&self) -> SettleStats {
        self.cs_stats
    }

    /// Concurrent settle: feed one *past* frame while Discover goes on.
    /// The frame keeps the side it had as a live frame (`held_out`): a
    /// fitting frame updates the footprint statistics and the cluster
    /// stores of every cell, solved with the current library, as
    /// [`SlowLoop::observe_lookback`] does; a held-out frame never does.
    /// No frame counter, reservoir, ledger, probes or noise correlation:
    /// Discover's clocks and its evidence for new cells are those of the
    /// live frames alone, and the ordinary visits do all the refining.
    pub fn observe_settle(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
        held_out: bool,
    ) -> Result<(), TraceError> {
        if !self.cs_on {
            return Err(TraceError::Incompatible(
                "the concurrent settle is not enabled".into(),
            ));
        }
        self.check_frame(frame, lib, traces)?;
        let w0 = self.work;
        if held_out {
            self.cs_stats.frames_test += 1;
        } else {
            self.observe_lookback_fit(frame, lib, traces, None)?;
            self.cs_stats.frames_fit += 1;
        }
        self.cs_stats.work += self.work - w0;
        Ok(())
    }

    /// Experimental (evaluation only, off by default): while frozen,
    /// [`SlowLoop::observe`] leaves the reservoir and the probes as they
    /// are (no slot is replaced, no tile becomes due through new slots);
    /// everything else (statistics, ledger, clocks) runs as usual. It
    /// separates what a replayed pass gains from fresh reservoir frames
    /// from what it gains from the statistics.
    #[doc(hidden)]
    pub fn set_reservoir_frozen(&mut self, frozen: bool) {
        self.res_frozen = frozen;
    }

    /// Feed one *past* frame re-read from the saved recording (the
    /// look-back cursor of concurrent Refine): only the running footprint
    /// statistics and the cluster stores take it, solved with the current
    /// library (`traces` from a separate trace engine on `lib`). Nothing
    /// else sees it: no frame counter, ledger, probes, reservoir or noise
    /// correlation, so the slow loop's clocks and held-out tests are those
    /// of Discover alone. `slow_index` is the index the frame had (or
    /// would have had) in the slow loop: a held-out frame stays held out.
    pub fn observe_lookback(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
        slow_index: u64,
        only: Option<&[u64]>,
    ) -> Result<bool, TraceError> {
        self.check_frame(frame, lib, traces)?;
        if self.is_test(slow_index) {
            return Ok(false);
        }
        self.observe_lookback_fit(frame, lib, traces, only)
    }

    /// [`SlowLoop::observe_lookback`] with the held-out decision given
    /// instead of the slow-loop index: a driver whose slow loop did not see
    /// every frame (the app drops batches) records the decision `observe`
    /// made per stream frame ([`HeldOutRecord`]) and passes it here.
    pub fn observe_lookback_flagged(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
        held_out: bool,
        only: Option<&[u64]>,
    ) -> Result<bool, TraceError> {
        self.check_frame(frame, lib, traces)?;
        if held_out {
            return Ok(false);
        }
        self.observe_lookback_fit(frame, lib, traces, only)
    }

    fn observe_lookback_fit(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
        only: Option<&[u64]>,
    ) -> Result<bool, TraceError> {
        let n_px = self.dims.pixels();
        let bg = match lib.background_model() {
            BackgroundModel::Basis(_) => Some(traces.background.as_slice()),
            _ => None,
        };
        lib.render(&traces.traces, bg, &mut self.model)?;
        self.work += n_px as u64;
        self.lb_only = only.map(|ids| ids.iter().copied().collect());
        self.update_fpstats(frame, lib, traces, true);
        self.lb_only = None;
        Ok(true)
    }

    /// Mark every tile due for a visit (no new frames needed): a driver
    /// that fed look-back frames after the last live frame uses it so the
    /// visits turn the new statistics into footprints.
    pub fn mark_all_due(&mut self) {
        let rects: Vec<Rect> = self.tiles.iter().map(|t| t.rect).collect();
        for r in rects {
            self.touch(r);
        }
    }

    /// A frame of this loop's size, and traces solved with `lib` (of the
    /// same size).
    fn check_frame(
        &self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
    ) -> Result<(), TraceError> {
        crate::trace::check_len("frame", self.dims.pixels(), frame.len())?;
        if lib.dims() != self.dims || traces.library_version != lib.version() {
            return Err(TraceError::Incompatible(
                "traces do not come from this library / frame size".into(),
            ));
        }
        Ok(())
    }

    /// Whitened frame (`z`) and the residual blurred to cell scale
    /// (`coarse_blur`), with the residual's robust noise scale.
    fn score_residual(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
    ) -> Result<f32, TraceError> {
        self.check_frame(frame, lib, traces)?;
        let bg = match lib.background_model() {
            BackgroundModel::Basis(_) => Some(traces.background.as_slice()),
            _ => None,
        };
        let mut lap = timing::Lap::start();
        lib.render(&traces.traces, bg, &mut self.model)?;
        lap.lap(&mut self.stage.observe[0]);
        // Whitened frame (stored) and whitened residual (scored).
        whiten(
            frame,
            &self.inv_sigma,
            &self.model,
            &mut self.z,
            &mut self.coarse,
            self.dims.width,
            &mut self.qrow,
        );
        lap.lap(&mut self.stage.observe[1]);
        self.coarse_gauss
            .blur(&self.coarse, &mut self.coarse_blur)
            .map_err(TraceError::Preprocess)?;
        // Robust noise scale of the blurred residual (cells are sparse).
        self.sample.clear();
        for (i, &v) in self.coarse_blur.iter().enumerate().step_by(3) {
            if self.coarse_fov[i] {
                self.sample.push(v.abs());
            }
        }
        let scale = if self.sample.is_empty() {
            1.0
        } else {
            let mid = self.sample.len() / 2;
            let (_, m, _) = self
                .sample
                .select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
            (MAD_TO_SIGMA * *m).max(1e-6)
        };
        lap.lap(&mut self.stage.observe[2]);
        Ok(scale)
    }

    /// Each tile's score for `frame` (the largest excursion of the blurred
    /// residual in its core, in robust noise units): what `observe` ranks
    /// reservoir frames by. Read-only for the slow loop's state, so a
    /// driver can use it to decide which frames to forward.
    pub fn tile_scores(
        &mut self,
        frame: &[f32],
        lib: &Library,
        traces: &FrameTraces,
    ) -> Result<Vec<f32>, TraceError> {
        let scale = self.score_residual(frame, lib, traces)?;
        Ok((0..self.tiles.len())
            .map(|ti| self.tile_score(ti, scale))
            .collect())
    }

    fn tile_score(&self, ti: usize, scale: f32) -> f32 {
        let cw = self.coarse_dims.width;
        let core = self.tiles[ti].core;
        let mut best = f32::MIN;
        for y in (core.y0 / 2)..(core.y0 + core.h).div_ceil(2) {
            for x in (core.x0 / 2)..(core.x0 + core.w).div_ceil(2) {
                let i = y * cw + x;
                if self.coarse_fov[i] {
                    best = best.max(self.coarse_blur[i]);
                }
            }
        }
        (best / scale).max(0.0)
    }
}

/// The whitened frame `z = y / σ` (NaN where `y` is missing: the reservoir
/// stores it as missing) and the whitened residual `(y − model) / σ`
/// block-averaged 2 x 2 into `coarse` (non-finite `y` count as 0). Two
/// passes per row, so the first vectorises: `z` and the quarter residual
/// `q`, then each coarse pixel adds its two `q` in the order a single
/// pixel-by-pixel loop would (`(c + q0) + q1`, the upper row first), so the
/// result is bit-identical to that loop.
pub(super) fn whiten(
    frame: &[f32],
    inv_sigma: &[f32],
    model: &[f32],
    z: &mut [f32],
    coarse: &mut [f32],
    w: usize,
    q: &mut Vec<f32>,
) {
    let cw = w.div_ceil(2);
    q.resize(w, 0.0);
    coarse.iter_mut().for_each(|v| *v = 0.0);
    let rows = frame
        .chunks_exact(w)
        .zip(inv_sigma.chunks_exact(w))
        .zip(model.chunks_exact(w).zip(z.chunks_exact_mut(w)));
    for (row, ((yr, sr), (mr, zr))) in rows.enumerate() {
        for ((((zv, qv), &y), &s), &m) in zr.iter_mut().zip(q.iter_mut()).zip(yr).zip(sr).zip(mr) {
            let fin = y.is_finite();
            *zv = if fin { y * s } else { f32::NAN };
            *qv = 0.25 * if fin { (y - m) * s } else { 0.0 };
        }
        let crow = &mut coarse[(row / 2) * cw..(row / 2) * cw + cw];
        let (pairs, tail) = q.as_chunks::<2>();
        for (c, p) in crow.iter_mut().zip(pairs) {
            *c = (*c + p[0]) + p[1];
        }
        if let Some(&t) = tail.first() {
            crow[cw - 1] += t;
        }
    }
}
