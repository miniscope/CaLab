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

use std::sync::Arc;

use wasm_bindgen::prelude::*;

use super::{SlowLoop, SlowLoopConfig, VisitJob, VisitResult, VisitRunner};
use crate::compress::review::footprints_from_wire;
use crate::preprocess::flatten::{FlattenConfig, GlowFlattener};
use crate::preprocess::fov::FovMask;
use crate::preprocess::Dims;
use crate::trace::js::JsTraceLibrary;
use crate::trace::{FrameTraces, Library, LibraryBuilder};

/// Published versions kept for `observe` (frames in flight from the fast
/// worker may still carry traces of a recent older version).
const KEEP_VERSIONS: usize = 6;

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
        )?;
        Ok(JsSlowLoop {
            inner,
            libs: vec![Arc::new(empty)],
            traces: FrameTraces::default(),
        })
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
    ) -> Result<bool, JsError> {
        let Some(lib) = self.lib(version) else {
            return Ok(false);
        };
        self.traces.frame_index = self.inner.frames();
        self.traces.library_version = lib.version();
        self.traces.traces.clear();
        self.traces.traces.extend_from_slice(traces);
        self.traces.background.clear();
        if let Some(bg) = background {
            if bg.len() != lib.background_len() {
                return Err(js_err(
                    "observe",
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
        self.inner
            .observe(frame, &lib, &self.traces)
            .map_err(|e| js_err("observe", e))?;
        Ok(true)
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
fn build(
    func: &str,
    width: u32,
    height: u32,
    fov: &[u8],
    noise: &[f32],
    cell_diameter_px: f32,
    flatten_sigma_px: f32,
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
    let cfg = SlowLoopConfig {
        cell_diameter_px,
        ..SlowLoopConfig::default()
    };
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
    /// A loop around `inner` that knows `lib` (tests: the JS surface driven
    /// natively).
    #[cfg(test)]
    pub(super) fn from_loop(inner: SlowLoop, lib: Arc<Library>) -> JsSlowLoop {
        JsSlowLoop {
            inner,
            libs: vec![lib],
            traces: FrameTraces::default(),
        }
    }

    #[cfg(test)]
    pub(super) fn inner(&self) -> &SlowLoop {
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
