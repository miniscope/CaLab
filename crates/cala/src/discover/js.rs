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

use std::sync::Arc;

use wasm_bindgen::prelude::*;

use super::{SlowLoop, SlowLoopConfig};
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
        console_error_panic_hook::set_once();
        let dims = Dims::new(width as usize, height as usize).map_err(|e| js_err("SlowLoop", e))?;
        let mask = FovMask::from_mask(dims, fov).map_err(|e| js_err("SlowLoop", e))?;
        let fcfg = FlattenConfig {
            cell_diameter_px,
            sigma_px: (flatten_sigma_px > 0.0).then_some(flatten_sigma_px),
            ..FlattenConfig::default()
        };
        let mut flat = GlowFlattener::new(&mask, &fcfg).map_err(|e| js_err("SlowLoop", e))?;
        let cfg = SlowLoopConfig {
            cell_diameter_px,
            ..SlowLoopConfig::default()
        };
        let empty = LibraryBuilder::new(dims)
            .config(cfg.library)
            .fov(fov.to_vec())
            .noise(noise.to_vec())
            .background(cfg.background.clone())
            .version(0)
            .build(&mut flat)
            .map_err(|e| js_err("SlowLoop", e))?;
        let inner = SlowLoop::new(dims, fov.to_vec(), noise.to_vec(), flat, cfg)
            .map_err(|e| js_err("SlowLoop", e))?;
        Ok(JsSlowLoop {
            inner,
            libs: vec![Arc::new(empty)],
            traces: FrameTraces::default(),
        })
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
    /// the library with `version`. Returns `false`, observing nothing, when
    /// that version is no longer held.
    pub fn observe(
        &mut self,
        frame: &[f32],
        version: f64,
        traces: &[f32],
    ) -> Result<bool, JsError> {
        let Some(lib) = self.lib(version) else {
            return Ok(false);
        };
        self.traces.frame_index = self.inner.frames();
        self.traces.library_version = lib.version();
        self.traces.traces.clear();
        self.traces.traces.extend_from_slice(traces);
        self.traces.background.clear();
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

    /// Counters: visits, proposals, adds, rejects, merges, merge tests,
    /// refines, commits, deletes, splits, absorbs, then the add
    /// classification: new adds, re-adds, churned adds, churned re-adds,
    /// established removals (all cumulative; see `ChurnCounts`).
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

impl JsSlowLoop {
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
