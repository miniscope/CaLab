//! wasm-bindgen surface of the slow loop, for a Web Worker of its own.
//!
//! The app runs the fast loop (preprocessing, motion, trace solve) and the
//! slow loop in separate workers so the slow loop's stalls never hold up a
//! frame. The fast worker sends each preprocessed frame with its traces and
//! the version of the library that produced them; `observe` looks that
//! library up among the versions this slow loop published (plus the empty
//! version 0 the fast loop starts with) and skips frames from versions it no
//! longer holds. Published libraries go back to the fast worker as
//! `TraceLibrary.toBytes()`.
//!
//! With visit workers (`VisitWorker`, one per Web Worker; see `shard.rs`)
//! the slow loop only observes: `takeJob` hands out a tile visit as bytes,
//! a `VisitWorker` built with the same arguments runs it, `applyJob` takes
//! its result back, and `housekeep` publishes.
//!
//! Run stages (`apps/cala/docs/stages.md`): Discover is a run with the
//! default edit scope from an empty library; a Refine run keeps this loop
//! (all its state), sets the `refine` scope and is fed the recording again
//! from frame 0. The same path as qc_eval's `--later-passes refine`.

use std::sync::Arc;

use wasm_bindgen::prelude::*;

use super::{
    EditScope, HeldOutRecord, JointSign, JointUpdate, LookBack, LookbackConfig, LookbackNext,
    LookbackOutcome, SettleSched, SlowLoop, SlowLoopConfig, VisitJob, VisitResult, VisitRunner,
};
use crate::compress::review::footprints_from_wire;
use crate::preprocess::flatten::{FlattenConfig, GlowFlattener};
use crate::preprocess::fov::FovMask;
use crate::preprocess::Dims;
use crate::trace::js::JsTraceLibrary;
use crate::trace::{FrameTraces, Library, LibraryBuilder};

/// Published versions kept for `observe` (frames in flight from the fast
/// worker may still carry traces of a recent older version).
const KEEP_VERSIONS: usize = 6;
/// Block numbers of the concurrent settle's chunks start below minus this
/// (`SlowLoop.settleTake`).
const SETTLE_BLOCK_BASE: f64 = 1_000_000.0;

fn js_err(func: &str, e: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

/// Streaming cell discovery (see the `discover` module docs).
#[wasm_bindgen(js_name = SlowLoop)]
pub struct JsSlowLoop {
    inner: SlowLoop,
    /// Version 0 (empty) and the most recent published versions.
    libs: Vec<Arc<Library>>,
    traces: FrameTraces,
    /// Held-out decision per stream frame (`observe` with `stream`).
    held: HeldOutRecord,
    /// Look-back (concurrent Refine; off unless `enableLookback`).
    lookback: Option<LookBack>,
    lb: LbCounts,
    /// The concurrent settle, frames only (off unless `enableSettle`): its
    /// frame picker, the chunks started, and its counters.
    settle: Option<SettleSched>,
    cs: CsCounts,
}

/// Counters of the concurrent settle's JS surface (`settleStats`).
#[derive(Clone, Copy, Debug, Default)]
struct CsCounts {
    chunks: u64,
    taken: u64,
    fit: u64,
    held_out: u64,
    dropped: u64,
}

/// Look-back counters of the JS surface (`lookbackStats`).
#[derive(Clone, Copy, Debug, Default)]
struct LbCounts {
    pushed: u64,
    held_out: u64,
    dropped: u64,
    idle: bool,
    /// The look-back floor (`setLookbackFloor`), for a settle enabled later.
    floor: usize,
}

/// Slow-loop options the app can set (see `SlowLoop.withConfig`).
fn slow_config(
    func: &str,
    joint_update: &str,
    joint_sign: &str,
    merge_guard_min_sep: f32,
) -> Result<impl Fn(&mut SlowLoopConfig), JsError> {
    let ju = match joint_update {
        "off" => JointUpdate::Off,
        "refine" => JointUpdate::Refine,
        "all" => JointUpdate::All,
        o => {
            return Err(js_err(
                func,
                format!("jointUpdate: off|refine|all, not {o:?}"),
            ))
        }
    };
    let js = match joint_sign {
        "off" => JointSign::Off,
        "own" => JointSign::Own,
        "all" => JointSign::All,
        o => return Err(js_err(func, format!("jointSign: off|own|all, not {o:?}"))),
    };
    if !(merge_guard_min_sep >= 0.0) {
        return Err(js_err(
            func,
            "mergeGuardMinSep must be >= 0 (Infinity = off)",
        ));
    }
    Ok(move |c: &mut SlowLoopConfig| {
        c.joint_update = ju;
        c.joint_sign_rule = js;
        c.merge_guard_min_sep = merge_guard_min_sep;
    })
}

#[wasm_bindgen(js_class = SlowLoop)]
impl JsSlowLoop {
    /// `fov` and `noise` (per-pixel σ of the preprocessed frames) come from
    /// the preprocessor; `cell_diameter_px` and `flatten_sigma_px` (0 =
    /// derived from the diameter) must match its flattening settings.
    #[wasm_bindgen(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        fov: &[u8],
        noise: &[f32],
        cell_diameter_px: f32,
        flatten_sigma_px: f32,
    ) -> Result<JsSlowLoop, JsError> {
        let (inner, empty) = build(
            "SlowLoop",
            width,
            height,
            fov,
            noise,
            cell_diameter_px,
            flatten_sigma_px,
            |_| {},
        )?;
        Ok(JsSlowLoop::wrap(inner, Arc::new(empty)))
    }

    /// As the constructor, with the slow-loop options look-back runs with:
    /// `jointUpdate` (`off` = the default, `refine`, `all`: the cluster
    /// history replay), `jointSign` (`off`, `own`, `all` = the default) and
    /// `mergeGuardMinSep` (cell diameters; `Infinity` = the default, off).
    /// Visit workers must be built with the same options
    /// (`VisitWorker.withConfig`). The validated look-back configuration is
    /// `all`, `all`, 0.6.
    #[wasm_bindgen(js_name = withConfig)]
    #[allow(clippy::too_many_arguments)]
    pub fn with_config(
        width: u32,
        height: u32,
        fov: &[u8],
        noise: &[f32],
        cell_diameter_px: f32,
        flatten_sigma_px: f32,
        joint_update: &str,
        joint_sign: &str,
        merge_guard_min_sep: f32,
    ) -> Result<JsSlowLoop, JsError> {
        let set = slow_config("SlowLoop", joint_update, joint_sign, merge_guard_min_sep)?;
        let (inner, empty) = build(
            "SlowLoop",
            width,
            height,
            fov,
            noise,
            cell_diameter_px,
            flatten_sigma_px,
            set,
        )?;
        Ok(JsSlowLoop::wrap(inner, Arc::new(empty)))
    }

    /// Hand out the next tile visit for a `VisitWorker` (bytes), or
    /// `undefined` when no tile is due or every due one conflicts with a
    /// visit out. The slow loop never waits for it.
    #[wasm_bindgen(js_name = takeJob)]
    pub fn take_job(&mut self) -> Option<Vec<u8>> {
        self.inner.take_job_bytes()
    }

    /// Apply a `VisitWorker` result (bytes from `run`).
    #[wasm_bindgen(js_name = applyJob)]
    pub fn apply_job(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let r = VisitResult::from_bytes(bytes).map_err(|e| js_err("applyJob", e))?;
        self.inner.apply_job(r).map_err(|e| js_err("applyJob", e))
    }

    /// With visit workers, instead of `step`: trimming decisions, and a new
    /// library when edits are due to be published.
    pub fn housekeep(&mut self) -> Result<Option<JsTraceLibrary>, JsError> {
        let out = self.inner.housekeep().map_err(|e| js_err("housekeep", e))?;
        Ok(out.map(|lib| self.keep(lib)))
    }

    /// Cap ordinary Discover visits at `rate` per observed frame (0: off,
    /// the default; see `discover/visitrate.rs`).
    #[wasm_bindgen(js_name = setVisitRate)]
    pub fn set_visit_rate(&mut self, rate: f64) {
        self.inner.set_visit_rate(rate);
    }

    /// The visit cap's counters: `[rate, credit, frames, visits,
    /// cappedFrames, dueTiles]`.
    #[wasm_bindgen(js_name = visitRateStats)]
    pub fn visit_rate_stats(&self) -> Vec<f64> {
        let v = self.inner.visit_rate_stats();
        vec![
            v.rate,
            v.credit,
            v.frames as f64,
            v.visits as f64,
            v.capped_frames as f64,
            v.due_tiles as f64,
        ]
    }

    /// Visits handed out and not yet applied.
    #[wasm_bindgen(getter, js_name = jobsInFlight)]
    pub fn jobs_in_flight(&self) -> u32 {
        self.inner.jobs_in_flight() as u32
    }

    /// Work spent so far (about multiply-adds), visits included.
    #[wasm_bindgen(getter)]
    pub fn work(&self) -> f64 {
        self.inner.work() as f64
    }

    /// Replace the noise map (the preprocessor's estimate keeps improving).
    #[wasm_bindgen(js_name = setNoise)]
    pub fn set_noise(&mut self, noise: &[f32]) -> Result<(), JsError> {
        self.inner
            .set_noise(noise.to_vec())
            .map_err(|e| js_err("setNoise", e))
    }

    /// Restrict the structural edits from now on: `all` (Discover, the
    /// default), `refine` (the Refine stage: footprints keep converging,
    /// the cell set is frozen), `refine-prune` or `refine-merge` (see
    /// `EditScope`; not used by the app). For a Refine run, call it with
    /// `refine` after Discover's `finalize`, then feed the recording again
    /// from frame 0 (`observe` / `step` or visit jobs, as in Discover) and
    /// `finalize` at its end. Visits handed out from now on carry the scope.
    #[wasm_bindgen(js_name = setEditScope)]
    pub fn set_edit_scope(&mut self, scope: &str) -> Result<(), JsError> {
        let s = EditScope::from_name(scope)
            .ok_or_else(|| js_err("setEditScope", format!("unknown scope {scope:?}")))?;
        self.inner.set_edit_scope(s);
        Ok(())
    }

    /// The current edit scope's name (`setEditScope`).
    #[wasm_bindgen(getter, js_name = editScope)]
    pub fn edit_scope(&self) -> String {
        self.inner.edit_scope().name().to_string()
    }

    /// Whether frames solved with library `version` can still be observed.
    #[wasm_bindgen(js_name = knowsVersion)]
    pub fn knows_version(&self, version: f64) -> bool {
        self.lib(version).is_some()
    }

    /// Feed one preprocessed frame and its traces (library slot order) from
    /// the library with `version`, with the background coefficients the same
    /// solve gave (`TraceEngine.lastBackground`, one frame's worth: the
    /// per-cell ring levels under the ring model). Without `background` the
    /// ledger and footprint statistics carry the local background, so pass
    /// it. Returns `false`, observing nothing, when that version is no
    /// longer held.
    pub fn observe(
        &mut self,
        frame: &[f32],
        version: f64,
        traces: &[f32],
        background: Option<Vec<f32>>,
        stream: Option<f64>,
    ) -> Result<bool, JsError> {
        if !self.stream_ok(stream) {
            // Without it the frame's held-out decision is not recorded and a
            // look-back re-read could fit on a test frame.
            return Err(js_err("observe", "look-back is on: pass the stream index"));
        }
        let Some(lib) = self.lib(version) else {
            return Ok(false);
        };
        let slow_index = self.inner.frames();
        self.fill_traces(&lib, traces, background, "observe")?;
        self.inner
            .observe(frame, &lib, &self.traces)
            .map_err(|e| js_err("observe", e))?;
        if let Some(s) = stream {
            self.held.note(s as u64, slow_index, &self.inner);
        }
        Ok(true)
    }

    // ---- look-back (concurrent Refine inside Discover) -------------------
    //
    // The scheduler (`discover/lookback.rs`) lives here, beside the slow
    // loop; a driver re-reads the frames it asks for (`lookbackTake`),
    // preprocesses them as the live pipeline did, solves them with a trace
    // engine on a published library and hands them back with
    // `observeLookback`. Feed Discover's frames with `observe(.., stream)`
    // so re-read frames keep their held-out decision.

    /// Turn look-back on: `rate` look-back frames per Discover frame, at
    /// most `maxFrames` frames before its birth per cell (validated: 2,
    /// 3000). Only before the first observed frame; from then on `observe`
    /// must be given the stream index (so every re-read frame keeps the
    /// held-out decision `observe` made, or the hashed one for frames the
    /// slow loop never saw).
    #[wasm_bindgen(js_name = enableLookback)]
    pub fn enable_lookback(&mut self, rate: f64, max_frames: u32) -> Result<(), JsError> {
        if !(rate > 0.0) || max_frames == 0 {
            return Err(js_err("enableLookback", "rate and maxFrames must be > 0"));
        }
        if self.inner.frames() > 0 {
            // Earlier frames' held-out decisions were not recorded.
            return Err(js_err(
                "enableLookback",
                "call it before the first observed frame",
            ));
        }
        self.lookback = Some(LookBack::new(LookbackConfig {
            rate,
            max_frames: max_frames as usize,
            ..LookbackConfig::default()
        }));
        Ok(())
    }

    /// Whether look-back is on.
    #[wasm_bindgen(getter, js_name = lookbackEnabled)]
    pub fn lookback_enabled(&self) -> bool {
        self.lookback.is_some()
    }

    /// Discover has seen stream frames `0..seen`, `frames` of them new
    /// since the last call: note births in the newest published library and
    /// add `rate * frames` of look-back budget.
    #[wasm_bindgen(js_name = lookbackNote)]
    pub fn lookback_note(&mut self, seen: f64, frames: f64) {
        let lib = self.libs.last().expect("version 0").clone();
        if let Some(lb) = self.lookback.as_mut() {
            lb.note_frame(&lib, seen.max(0.0) as usize);
            let rate = lb.config().rate;
            lb.add_credit(rate * frames.max(0.0));
        }
    }

    /// Look back from stream frame `frame` on only (it only rises): the
    /// first frame of the current session of a multi-session recording
    /// (the app's Joint run), for need-driven look-back and the concurrent
    /// settle alike. Frames before it are never handed out again.
    #[wasm_bindgen(js_name = setLookbackFloor)]
    pub fn set_lookback_floor(&mut self, frame: f64) {
        let f = frame.max(0.0) as usize;
        if let Some(lb) = self.lookback.as_mut() {
            lb.set_floor(f);
        }
        self.lb.floor = self.lb.floor.max(f);
        if let Some(s) = self.settle.as_mut() {
            s.set_floor(f);
        }
    }

    /// Add look-back budget directly (frames; the drain after the last
    /// frame).
    #[wasm_bindgen(js_name = lookbackAddCredit)]
    pub fn lookback_add_credit(&mut self, frames: f64) {
        if let Some(lb) = self.lookback.as_mut() {
            lb.add_credit(frames.max(0.0));
        }
    }

    /// Take up to `max` look-back frames to supply, flattened as
    /// `[frame, block, n, id_1..id_n, frame, block, n, ...]` (stream frame
    /// index; block sequence number: start a fresh copy of the live
    /// preprocessor state when it changes; the cell ids that take it). The
    /// budget is spent at hand-out. Empty when the budget is spent or no
    /// cell needs anything (`lookbackIdle`).
    #[wasm_bindgen(js_name = lookbackTake)]
    pub fn lookback_take(&mut self, max: u32) -> Vec<f64> {
        let mut out = Vec::new();
        let lib = self.libs.last().expect("version 0").clone();
        let Some(lb) = self.lookback.as_mut() else {
            return out;
        };
        self.lb.idle = false;
        for _ in 0..max {
            match lb.next(&self.inner, &lib) {
                LookbackNext::Frame(r) => {
                    out.push(r.frame as f64);
                    out.push(r.block as f64);
                    out.push(r.ids.len() as f64);
                    out.extend(r.ids.iter().map(|&i| i as f64));
                    lb.frame_done(LookbackOutcome::Observed);
                }
                LookbackNext::NoCredit => break,
                LookbackNext::Idle => {
                    self.lb.idle = true;
                    break;
                }
            }
        }
        out
    }

    /// Whether the last `lookbackTake` stopped because no cell needs
    /// anything.
    #[wasm_bindgen(getter, js_name = lookbackIdle)]
    pub fn lookback_idle(&self) -> bool {
        self.lb.idle
    }

    /// Feed a look-back frame (`lookbackTake`): the preprocessed stream
    /// frame `stream`, its traces from library `version` (and background,
    /// as `observe`), for the cells `ids` only. Only the running footprint
    /// statistics and cluster stores take it; the slow loop's clocks do not
    /// move. `false` when the version is no longer held (dropped) or the
    /// frame is held out.
    #[wasm_bindgen(js_name = observeLookback)]
    #[allow(clippy::too_many_arguments)]
    pub fn observe_lookback(
        &mut self,
        frame: &[f32],
        version: f64,
        traces: &[f32],
        background: Option<Vec<f32>>,
        stream: f64,
        ids: &[f64],
    ) -> Result<bool, JsError> {
        let Some(lib) = self.lib(version) else {
            self.lb.dropped += 1;
            return Ok(false);
        };
        self.fill_traces(&lib, traces, background, "observeLookback")?;
        let held = self.held.held_out(stream.max(0.0) as u64, &self.inner);
        let only: Vec<u64> = ids.iter().map(|&i| i as u64).collect();
        let fit = self
            .inner
            .observe_lookback_flagged(frame, &lib, &self.traces, held, Some(&only))
            .map_err(|e| js_err("observeLookback", e))?;
        if fit {
            self.lb.pushed += 1;
        } else {
            self.lb.held_out += 1;
        }
        Ok(fit)
    }

    // ---- concurrent settle, frames only (settling while Discover runs) ---
    //
    // qc_eval's `--csettle S --csettle-mode frames` with visit workers
    // (arm `CS2F`): while Discover runs, a driver re-reads saved frames
    // spread over everything seen so far (`settleTake`), solves the ones
    // on the fitting side with a published library and hands them back
    // (`observeSettle`); they update the footprint statistics and cluster
    // stores of every cell, and the ordinary visits do all the refining.
    // No settle visits, no quiet rule, nothing offered to the reservoir.
    // How many frames are due is the driver's business.

    /// Turn the concurrent settle on (frames only): saved frames are
    /// re-read `chunk` in a row, the chunks spread evenly over the history
    /// (`SettleSched`). Needs look-back (`enableLookback`), whose record
    /// holds every stream frame's held-out decision.
    #[wasm_bindgen(js_name = enableSettle)]
    pub fn enable_settle(&mut self, chunk: u32) -> Result<(), JsError> {
        if self.lookback.is_none() {
            return Err(js_err("enableSettle", "call enableLookback first"));
        }
        if chunk == 0 {
            return Err(js_err("enableSettle", "chunk must be > 0"));
        }
        self.inner.enable_settle(0);
        // The share is unused here: the driver keeps the dose.
        let mut sched = SettleSched::new(0.0, chunk as usize);
        sched.set_floor(self.lb.floor);
        self.settle = Some(sched);
        Ok(())
    }

    /// Whether the concurrent settle is on.
    #[wasm_bindgen(getter, js_name = settleEnabled)]
    pub fn settle_enabled(&self) -> bool {
        self.settle.is_some()
    }

    /// Take up to `max` saved frames to re-read among stream frames
    /// `0..seen`, flattened as `[frame, block, held, frame, block, held,
    /// ...]`: the stream frame index; the chunk it belongs to (start a
    /// fresh copy of the live preprocessor state when it changes; values
    /// below -1,000,000, so never a look-back block's or the end settle's);
    /// and 1 when the frame is held out (preprocess it, so the chunk's
    /// preprocessor runs on, but do not solve it or hand it back). Empty
    /// while less than one chunk is saved, or with the settle off.
    #[wasm_bindgen(js_name = settleTake)]
    pub fn settle_take(&mut self, seen: f64, max: u32) -> Vec<f64> {
        let mut out = Vec::new();
        let Some(sched) = self.settle.as_mut() else {
            return out;
        };
        let seen = seen.max(0.0) as usize;
        for _ in 0..max {
            let Some((f, new)) = sched.next_frame(seen) else {
                break;
            };
            self.cs.chunks += u64::from(new);
            self.cs.taken += 1;
            out.push(f as f64);
            out.push(-(SETTLE_BLOCK_BASE + self.cs.chunks as f64));
            out.push(f64::from(u8::from(
                self.held.held_out(f as u64, &self.inner),
            )));
        }
        out
    }

    /// Feed a re-read frame of the concurrent settle (`settleTake`): the
    /// preprocessed stream frame `stream`, its traces from library
    /// `version` (and background, as `observe`). A fitting frame updates
    /// the footprint statistics and cluster stores of every cell; nothing
    /// else moves (no frame counter, reservoir, ledger or probes). A
    /// held-out frame is refused here whatever the driver did: it never
    /// reaches fitting. `false` when the frame is held out or the version
    /// is no longer held (dropped).
    #[wasm_bindgen(js_name = observeSettle)]
    pub fn observe_settle(
        &mut self,
        frame: &[f32],
        version: f64,
        traces: &[f32],
        background: Option<Vec<f32>>,
        stream: f64,
    ) -> Result<bool, JsError> {
        if self.settle.is_none() {
            return Err(js_err("observeSettle", "the concurrent settle is off"));
        }
        if self.held.held_out(stream.max(0.0) as u64, &self.inner) {
            self.cs.held_out += 1;
            return Ok(false);
        }
        let Some(lib) = self.lib(version) else {
            self.cs.dropped += 1;
            return Ok(false);
        };
        self.fill_traces(&lib, traces, background, "observeSettle")?;
        // Not offered to the reservoir, so the key is unused.
        self.inner
            .observe_settle(frame, &lib, &self.traces, 0, false, false)
            .map_err(|e| js_err("observeSettle", e))?;
        self.cs.fit += 1;
        Ok(true)
    }

    /// A held-out frame of `settleTake` was passed over by the driver
    /// (not solved, not handed back): count it.
    #[wasm_bindgen(js_name = settleSkipped)]
    pub fn settle_skipped(&mut self, frames: f64) {
        self.cs.held_out += frames.max(0.0) as u64;
    }

    /// `[taken, fit, heldOut, dropped]`: frames of the concurrent settle
    /// handed out, taken into the footprint statistics, held out (never
    /// fitted) and dropped (library version gone).
    #[wasm_bindgen(js_name = settleStats)]
    pub fn settle_stats(&self) -> Vec<f64> {
        [
            self.cs.taken,
            self.cs.fit,
            self.cs.held_out,
            self.cs.dropped,
        ]
        .map(|v| v as f64)
        .to_vec()
    }

    /// Split-half noise of every cell's footprint in the newest published
    /// library (`SlowLoop::footprint_noise` on its filtered support):
    /// `[id, noise, id, noise, ...]`, NaN where there is no estimate. The
    /// noise is relative to the footprint's size, so it compares with a
    /// relative footprint change (the settle's checkpoints and the Refine
    /// readout: the share of cells that moved more than their own noise).
    #[wasm_bindgen(js_name = footprintNoise)]
    pub fn footprint_noise(&self) -> Vec<f64> {
        let lib = self.libs.last().expect("version 0").clone();
        let mut out = Vec::with_capacity(2 * lib.len());
        for slot in 0..lib.len() {
            let id = lib.ids()[slot];
            let (pix, _) = lib.filtered(slot);
            out.push(id as f64);
            out.push(self.inner.footprint_noise(id, pix).unwrap_or(f64::NAN));
        }
        out
    }

    /// Split-half noise of one cell's footprint estimate on the given pixels
    /// (`SlowLoop::footprint_noise` on `support`), relative to the norm of the
    /// mean estimate on those pixels; NaN without an estimate. The "still
    /// moving" hint divides each region's change (core, edge) by the noise on
    /// that region.
    #[wasm_bindgen(js_name = footprintNoiseOn)]
    pub fn footprint_noise_on(&self, id: f64, support: &[u32]) -> f64 {
        self.inner
            .footprint_noise(id as u64, support)
            .unwrap_or(f64::NAN)
    }

    /// Mark every tile due for a visit (the drain: visits turn the
    /// look-back statistics into footprints without new frames).
    #[wasm_bindgen(js_name = markAllDue)]
    pub fn mark_all_due(&mut self) {
        self.inner.mark_all_due();
    }

    /// `[requested, pushed, heldOut, dropped, births, inNeed, recordBytes]`:
    /// look-back frames handed out, observed, held out, dropped (library
    /// version gone), births noted, cells still in need, held-out record
    /// size.
    #[wasm_bindgen(js_name = lookbackStats)]
    pub fn lookback_stats(&self) -> Vec<f64> {
        let (req, births, need) = self
            .lookback
            .as_ref()
            .map_or((0, 0, 0), |l| (l.frames(), l.births(), l.in_need()));
        [
            req,
            self.lb.pushed,
            self.lb.held_out,
            self.lb.dropped,
            births,
            need as u64,
            self.held.bytes() as u64,
        ]
        .map(|v| v as f64)
        .to_vec()
    }

    /// Spend about `budget` work units on discovery; returns the new
    /// library when edits were published.
    pub fn step(&mut self, budget: f64) -> Result<Option<JsTraceLibrary>, JsError> {
        let out = self
            .inner
            .step(budget.max(0.0) as u64)
            .map_err(|e| js_err("step", e))?;
        Ok(out.map(|lib| self.keep(lib)))
    }

    /// The last published library (none before the first publish), without
    /// publishing: for a look-back worker that joins a run mid-way.
    #[wasm_bindgen(js_name = publishedLibrary)]
    pub fn published_library(&self) -> Option<JsTraceLibrary> {
        self.inner
            .library()
            .map(|l| JsTraceLibrary::from_arc(l.clone()))
    }

    /// Publish any accepted edits now (end of the recording).
    pub fn finalize(&mut self) -> Result<JsTraceLibrary, JsError> {
        let lib = self.inner.finalize().map_err(|e| js_err("finalize", e))?;
        Ok(self.keep(lib))
    }

    /// Cells in the working set (published or not).
    #[wasm_bindgen(getter, js_name = cellCount)]
    pub fn cell_count(&self) -> u32 {
        self.inner.len() as u32
    }

    /// Frames observed so far.
    #[wasm_bindgen(getter)]
    pub fn frames(&self) -> f64 {
        self.inner.frames() as f64
    }

    #[wasm_bindgen(getter, js_name = reservoirBytes)]
    pub fn reservoir_bytes(&self) -> f64 {
        self.inner.reservoir_bytes() as f64
    }

    /// Frames the reservoir stores per tile (event plus random slots).
    #[wasm_bindgen(getter, js_name = framesPerTile)]
    pub fn frames_per_tile(&self) -> u32 {
        self.inner.reservoir_plan().frames_per_tile as u32
    }

    /// Why discovery is slower than it could be, when the reservoir's
    /// memory cap limits the frames per tile (large sensors).
    #[wasm_bindgen(getter, js_name = reservoirWarning)]
    pub fn reservoir_warning(&self) -> Option<String> {
        self.inner.reservoir_plan().warning()
    }

    /// Add the candidates of a history review (`HistoryReview.finish`) as
    /// new cells on probation; one on an existing cell or a recently deleted
    /// spot is skipped. Returns how many were added; they are published
    /// with the next commit. Call it while no visit is out (`jobsInFlight`
    /// 0): a visit in flight does not know the new cells.
    #[wasm_bindgen(js_name = addReviewed)]
    pub fn add_reviewed(&mut self, candidates: &[f32]) -> Result<u32, JsError> {
        let fps = footprints_from_wire(candidates)
            .ok_or_else(|| js_err("addReviewed", "malformed candidates"))?;
        let added = self
            .inner
            .add_reviewed(&fps)
            .map_err(|e| js_err("addReviewed", e))?;
        Ok(added as u32)
    }

    /// Counters: visits, proposals, adds, rejects, merges, merge tests,
    /// refines, commits, deletes, splits, absorbs, then the add
    /// classification: new adds, re-adds, churned adds, churned re-adds,
    /// established removals (all cumulative; see `ChurnCounts`), then the
    /// adds that came from the history review.
    pub fn stats(&self) -> Vec<f64> {
        let s = self.inner.stats();
        let c = self.inner.churn_counts();
        [
            s.visits,
            s.proposals,
            s.adds,
            s.rejects,
            s.merges,
            s.merge_tests,
            s.refines,
            s.commits,
            s.deletes,
            s.splits,
            s.absorbs,
            c.adds_new,
            c.adds_readd,
            c.churned,
            c.churned_readd,
            c.established_removals,
            s.review_adds,
        ]
        .map(|v| v as f64)
        .to_vec()
    }

    /// Evidence status of every working-set cell: `(id, established 0/1,
    /// transients since birth)` triples.
    #[wasm_bindgen(js_name = cellStatus)]
    pub fn cell_status(&self) -> Vec<f64> {
        self.inner
            .cell_infos()
            .iter()
            .flat_map(|c| {
                [
                    c.id as f64,
                    if c.status == super::CellStatus::Established {
                        1.0
                    } else {
                        0.0
                    },
                    c.transients as f64,
                ]
            })
            .collect()
    }
}

/// The slow loop and the empty version-0 library, from the app's settings.
#[allow(clippy::too_many_arguments)]
fn build(
    func: &str,
    width: u32,
    height: u32,
    fov: &[u8],
    noise: &[f32],
    cell_diameter_px: f32,
    flatten_sigma_px: f32,
    set: impl Fn(&mut SlowLoopConfig),
) -> Result<(SlowLoop, Library), JsError> {
    console_error_panic_hook::set_once();
    let dims = Dims::new(width as usize, height as usize).map_err(|e| js_err(func, e))?;
    let mask = FovMask::from_mask(dims, fov).map_err(|e| js_err(func, e))?;
    let fcfg = FlattenConfig {
        cell_diameter_px,
        sigma_px: (flatten_sigma_px > 0.0).then_some(flatten_sigma_px),
        ..FlattenConfig::default()
    };
    let mut flat = GlowFlattener::new(&mask, &fcfg).map_err(|e| js_err(func, e))?;
    let mut cfg = SlowLoopConfig {
        cell_diameter_px,
        ..SlowLoopConfig::default()
    };
    set(&mut cfg);
    let empty = LibraryBuilder::new(dims)
        .fov(fov.to_vec())
        .noise(noise.to_vec())
        .background(cfg.background.clone())
        .version(0)
        .build(&mut flat)
        .map_err(|e| js_err(func, e))?;
    let inner = SlowLoop::new(dims, fov.to_vec(), noise.to_vec(), flat, cfg)
        .map_err(|e| js_err(func, e))?;
    Ok((inner, empty))
}

/// Runs tile visits handed out by a `SlowLoop` in another worker. Build it
/// with the same arguments as that loop and give it the same noise maps in
/// the same order.
#[wasm_bindgen(js_name = VisitWorker)]
pub struct JsVisitWorker {
    inner: VisitRunner,
}

#[wasm_bindgen(js_class = VisitWorker)]
impl JsVisitWorker {
    #[wasm_bindgen(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        fov: &[u8],
        noise: &[f32],
        cell_diameter_px: f32,
        flatten_sigma_px: f32,
    ) -> Result<JsVisitWorker, JsError> {
        let (inner, _) = build(
            "VisitWorker",
            width,
            height,
            fov,
            noise,
            cell_diameter_px,
            flatten_sigma_px,
            |_| {},
        )?;
        Ok(JsVisitWorker {
            inner: VisitRunner::new(inner),
        })
    }

    /// As the constructor, with the slow loop's options
    /// (`SlowLoop.withConfig`; they must match).
    #[wasm_bindgen(js_name = withConfig)]
    #[allow(clippy::too_many_arguments)]
    pub fn with_config(
        width: u32,
        height: u32,
        fov: &[u8],
        noise: &[f32],
        cell_diameter_px: f32,
        flatten_sigma_px: f32,
        joint_update: &str,
        joint_sign: &str,
        merge_guard_min_sep: f32,
    ) -> Result<JsVisitWorker, JsError> {
        let set = slow_config("VisitWorker", joint_update, joint_sign, merge_guard_min_sep)?;
        let (inner, _) = build(
            "VisitWorker",
            width,
            height,
            fov,
            noise,
            cell_diameter_px,
            flatten_sigma_px,
            set,
        )?;
        Ok(JsVisitWorker {
            inner: VisitRunner::new(inner),
        })
    }

    #[wasm_bindgen(js_name = setNoise)]
    pub fn set_noise(&mut self, noise: &[f32]) -> Result<(), JsError> {
        self.inner
            .set_noise(noise.to_vec())
            .map_err(|e| js_err("setNoise", e))
    }

    /// Run one visit (`SlowLoop.takeJob` bytes); returns the result bytes
    /// for `SlowLoop.applyJob`.
    pub fn run(&mut self, job: &[u8]) -> Result<Vec<u8>, JsError> {
        let job = VisitJob::from_bytes(job).map_err(|e| js_err("run", e))?;
        let r = self.inner.run(job).map_err(|e| js_err("run", e))?;
        Ok(r.to_bytes())
    }
}

impl JsSlowLoop {
    fn wrap(inner: SlowLoop, start: Arc<Library>) -> JsSlowLoop {
        JsSlowLoop {
            inner,
            libs: vec![start],
            traces: FrameTraces::default(),
            held: HeldOutRecord::default(),
            lookback: None,
            lb: LbCounts::default(),
            settle: None,
            cs: CsCounts::default(),
        }
    }

    /// `observe` may go ahead: with look-back on, only with the stream
    /// index (its held-out decision must be recorded).
    pub(crate) fn stream_ok(&self, stream: Option<f64>) -> bool {
        self.lookback.is_none() || stream.is_some()
    }

    /// A loop built from parts (tests: another config, a seeded library).
    #[cfg(test)]
    pub(crate) fn from_parts(inner: SlowLoop, start: Arc<Library>) -> JsSlowLoop {
        JsSlowLoop::wrap(inner, start)
    }

    /// `self.traces` from a JS frame's traces and background.
    fn fill_traces(
        &mut self,
        lib: &Library,
        traces: &[f32],
        background: Option<Vec<f32>>,
        func: &str,
    ) -> Result<(), JsError> {
        self.traces.frame_index = self.inner.frames();
        self.traces.library_version = lib.version();
        self.traces.traces.clear();
        self.traces.traces.extend_from_slice(traces);
        self.traces.background.clear();
        if let Some(bg) = background {
            if bg.len() != lib.background_len() {
                return Err(js_err(
                    func,
                    format!(
                        "background has {} values, library {} expects {}",
                        bg.len(),
                        lib.version(),
                        lib.background_len()
                    ),
                ));
            }
            self.traces.background = bg;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn inner(&self) -> &SlowLoop {
        &self.inner
    }

    fn lib(&self, version: f64) -> Option<Arc<Library>> {
        self.libs
            .iter()
            .find(|l| l.version() as f64 == version)
            .cloned()
    }

    fn keep(&mut self, lib: Arc<Library>) -> JsTraceLibrary {
        if !self.libs.iter().any(|l| l.version() == lib.version()) {
            self.libs.push(lib.clone());
            // Keep version 0 and the newest ones.
            while self.libs.len() > KEEP_VERSIONS + 1 {
                self.libs.remove(1);
            }
        }
        JsTraceLibrary::from_arc(lib)
    }
}
