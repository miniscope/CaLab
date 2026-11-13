//! wasm-bindgen surface of the QC monitor.
//!
//! `QcMonitor.processFrames(engine, frames, count)` runs the fast loop on a
//! batch (exactly like `TraceEngine.processFrames`, same return value) and
//! feeds every frame and its traces to the monitor. Metrics are read back as
//! flat arrays with their field names (`cellFields`, `globalFields`).

use wasm_bindgen::prelude::*;

use super::{CellQc, GlobalQc, QcConfig, QcMonitor};
use crate::preprocess::Dims;
use crate::trace::js::JsTraceEngine;
use crate::trace::TraceError;

fn js_err(func: &str, e: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

/// Field names of `QcMonitor.spanStats`.
const SPAN_FIELDS: [&str; 7] = [
    "peak_snr",
    "sigma",
    "baseline",
    "events",
    "event_rate",
    "zero_frac",
    "low_snr",
];

/// Online quality control alongside a `TraceEngine`.
#[wasm_bindgen(js_name = QcMonitor)]
pub struct JsQcMonitor {
    inner: QcMonitor,
}

#[wasm_bindgen(js_class = QcMonitor)]
impl JsQcMonitor {
    /// `fov` (0/1 per pixel) and `noise` (σ per pixel) of the preprocessing;
    /// `fps` the frame rate (every QC duration follows it); `window_frames`
    /// the trace history (0 = the default 60 s at `fps`).
    #[wasm_bindgen(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        fov: &[u8],
        noise: &[f32],
        fps: f32,
        window_frames: u32,
    ) -> Result<JsQcMonitor, JsError> {
        console_error_panic_hook::set_once();
        let dims =
            Dims::new(width as usize, height as usize).map_err(|e| js_err("QcMonitor", e))?;
        // Every QC duration at the recording's frame rate.
        let mut cfg = QcConfig::for_fps(fps);
        if window_frames > 0 {
            cfg.window_frames = window_frames as usize;
        }
        let inner = QcMonitor::new(dims, fov.to_vec(), noise.to_vec(), cfg)
            .map_err(|e| js_err("QcMonitor", e))?;
        Ok(JsQcMonitor { inner })
    }

    #[wasm_bindgen(js_name = setNoise)]
    pub fn set_noise(&mut self, noise: &[f32]) -> Result<(), JsError> {
        self.inner
            .set_noise(noise.to_vec())
            .map_err(|e| js_err("setNoise", e))
    }

    /// Solve `count` frames with `engine` and observe each; returns the
    /// traces (`count x cells`), as `TraceEngine.processFrames` does.
    #[wasm_bindgen(js_name = processFrames)]
    pub fn process_frames(
        &mut self,
        engine: &mut JsTraceEngine,
        frames: &[f32],
        count: u32,
    ) -> Result<Vec<f32>, JsError> {
        self.process_frames_shifted(engine, frames, count, &[], &[])
    }

    /// [`Self::process_frames`] with each frame's rigid registration shift
    /// (`dy`, `dx`, px; empty = unknown), which feeds `motion_r2`.
    #[wasm_bindgen(js_name = processFramesShifted)]
    pub fn process_frames_shifted(
        &mut self,
        engine: &mut JsTraceEngine,
        frames: &[f32],
        count: u32,
        dy: &[f32],
        dx: &[f32],
    ) -> Result<Vec<f32>, JsError> {
        let have = dy.len() == count as usize && dx.len() == count as usize;
        let n = engine.inner.library().dims().pixels();
        if frames.len() != n * count as usize {
            return Err(js_err(
                "processFrames",
                TraceError::LengthMismatch {
                    what: "frames",
                    expected: n * count as usize,
                    got: frames.len(),
                },
            ));
        }
        let mut out = Vec::with_capacity(count as usize * engine.inner.library().len());
        engine.batch_background.clear();
        for (k, f) in frames.chunks_exact(n).enumerate() {
            engine
                .inner
                .process_into(f, &mut engine.out)
                .map_err(|e| js_err("processFrames", e))?;
            let lib = engine.inner.library().clone();
            self.inner
                .observe_shifted(f, &lib, &engine.out, have.then(|| (dy[k], dx[k])))
                .map_err(|e| js_err("processFrames", e))?;
            out.extend_from_slice(&engine.out.traces);
            engine
                .batch_background
                .extend_from_slice(&engine.out.background);
        }
        Ok(out)
    }

    /// Comma-separated names of [`Self::span_stats`]' values.
    #[wasm_bindgen(js_name = spanStatsFields)]
    pub fn span_stats_fields() -> String {
        SPAN_FIELDS.join(",")
    }

    /// The monitor's trace statistics of one cell, on any span of its trace
    /// (chronological), at frame rate `fps`: `QcConfig::trace_stats` with
    /// `QcConfig::for_fps(fps)`. After Extract the app calls it on each
    /// session's frames (the whole span, or its last window). `modelSigma`:
    /// the cell's model trace noise, or NaN when unknown (exact zeros count
    /// as zero, no fallback σ). Values in `spanStatsFields` order.
    #[wasm_bindgen(js_name = spanStats)]
    pub fn span_stats(trace: &[f32], model_sigma: f32, fps: f32) -> Result<Vec<f64>, JsError> {
        let cfg = QcConfig::for_fps(fps);
        cfg.validate().map_err(|e| js_err("spanStats", e))?;
        let st = cfg.trace_stats(trace, model_sigma, &mut Vec::new());
        let f = |v: f32| f64::from(v);
        let minutes = trace.len() as f64 / f64::from(fps) / 60.0;
        Ok(vec![
            f(st.peak_snr),
            f(st.sigma),
            f(st.baseline),
            f64::from(st.events),
            f64::from(st.events) / minutes,
            f(st.zero_frac),
            f64::from(u8::from(cfg.pass.low_snr(&st))),
        ])
    }

    /// The window the monitor reads at frame rate `fps`, frames.
    #[wasm_bindgen(js_name = windowFrames)]
    pub fn window_frames(fps: f32) -> u32 {
        QcConfig::for_fps(fps).window_frames as u32
    }

    /// Comma-separated names of the per-cell fields.
    #[wasm_bindgen(js_name = cellFields)]
    pub fn cell_fields() -> String {
        CellQc::FIELDS.join(",")
    }

    /// Comma-separated names of the global fields.
    #[wasm_bindgen(js_name = globalFields)]
    pub fn global_fields() -> String {
        GlobalQc::FIELDS.join(",")
    }

    /// Per-cell metrics, `cells x cellFields` row-major, library slot order.
    #[wasm_bindgen(js_name = cellMetrics)]
    pub fn cell_metrics(&self) -> Vec<f64> {
        self.inner.cells().flat_map(|c| c.to_row()).collect()
    }

    #[wasm_bindgen(js_name = globalMetrics)]
    pub fn global_metrics(&self) -> Vec<f64> {
        let (bw, bh, _) = self.inner.residual_map();
        self.inner.global().to_row(bw * bh).to_vec()
    }

    /// Neighbours of the cell in `slot`: (id, overlap, trace r) triples.
    pub fn neighbours(&self, slot: u32) -> Vec<f64> {
        self.inner
            .neighbours_of(slot as usize)
            .iter()
            .flat_map(|p| [p.id as f64, f64::from(p.overlap), f64::from(p.r)])
            .collect()
    }

    /// Residual map (blocks of `residualMapDims`), NaN outside the FOV.
    #[wasm_bindgen(js_name = residualMap)]
    pub fn residual_map(&self) -> Vec<f32> {
        self.inner.residual_map().2
    }

    /// `[blocks wide, blocks high, block px]`.
    #[wasm_bindgen(js_name = residualMapDims)]
    pub fn residual_map_dims(&self) -> Vec<u32> {
        let (bw, bh, _) = self.inner.residual_map();
        vec![bw as u32, bh as u32, self.inner.config().block_px as u32]
    }
}
