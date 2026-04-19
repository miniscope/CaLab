//! `#[wasm_bindgen]` surface for `apps/cala` (browser) workers.
//!
//! Nothing algorithmic lives here. Each type is a thin wrapper that:
//! 1. parses a JSON config string through `bindings::config_json`,
//!    so every tuning knob stays overridable from JS (no
//!    hard-coded magic numbers);
//! 2. delegates to the owning numerical core types
//!    (`PreprocessPipeline`, `FitPipeline`, `OwnedAviReader`,
//!    `MutationQueue`).
//!
//! Error surface: parse / shape / pipeline failures are converted to
//! `JsValue` strings. Callers see `Promise` rejections with readable
//! messages rather than opaque WASM unreachable traps.
//!
//! The binding types are intentionally conservative:
//! - Float32Array in, Float32Array out (no serialized numeric data).
//! - Config is always a JSON string so there is a single source of
//!   truth per tuning parameter — the `DEFAULT_*` constant in
//!   `crate::config`.
//! - Asset-touching bindings expose opaque handles (`Fitter`,
//!   `SnapshotHandle`, `MutationQueueHandle`) so JS cannot reach
//!   into interior structure.

use wasm_bindgen::prelude::*;

use super::config_json::{
    parse_extend_config, parse_fit_config, parse_preprocess_config, parse_recording_metadata,
    ConfigParseError,
};
use crate::assets::{Footprints, Frame, FrameMut};
use crate::buffers::bipbuf::ResidualRingBuf;
use crate::config::{ExtendConfig, GrayscaleMethod, RecordingMetadata};
use crate::extending::driver as extend_driver;
use crate::extending::mutation::{
    DeprecateReason, Epoch, MutationQueue, PipelineMutation, Snapshot,
};
use crate::fitting::FitPipeline;
use crate::io::{decode_grayscale_f32, OwnedAviReader};
use crate::preprocess::PreprocessPipeline;

// ── Small error conversion helpers ─────────────────────────────────

fn js_err<T: std::fmt::Display>(kind: &str, e: T) -> JsValue {
    JsValue::from_str(&format!("cala-core {kind}: {e}"))
}

fn config_err(e: ConfigParseError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn str_to_grayscale_method(s: &str) -> Result<GrayscaleMethod, JsValue> {
    match s {
        "Green" => Ok(GrayscaleMethod::Green),
        "Luminance" => Ok(GrayscaleMethod::Luminance),
        other => Err(js_err(
            "grayscale",
            format!("unknown GrayscaleMethod '{other}' (expected 'Green' or 'Luminance')"),
        )),
    }
}

// ── Init ───────────────────────────────────────────────────────────

/// Install the console panic hook. Call once, early, from each
/// worker so `panic!` surfaces in the browser console instead of
/// appearing as a WASM trap.
#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

// ── AVI reader ─────────────────────────────────────────────────────

/// Owning wrapper over `OwnedAviReader`. Parses the RIFF container
/// once in `new`, caches the frame index, then decodes individual
/// frames directly from the held buffer without re-walking the
/// container. Safe to construct from a `File.slice()` `ArrayBuffer`
/// handed across the JS ↔ WASM boundary.
#[wasm_bindgen]
pub struct AviReader {
    inner: OwnedAviReader,
}

#[wasm_bindgen]
impl AviReader {
    /// Parse an AVI. `bytes` is copied into WASM memory once; frame
    /// reads are zero-copy slices into that owned buffer.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<AviReader, JsValue> {
        OwnedAviReader::new(bytes.to_vec())
            .map(|inner| AviReader { inner })
            .map_err(|e| js_err("avi", format!("{e:?}")))
    }

    #[wasm_bindgen(js_name = width)]
    pub fn width(&self) -> u32 {
        self.inner.width()
    }

    #[wasm_bindgen(js_name = height)]
    pub fn height(&self) -> u32 {
        self.inner.height()
    }

    #[wasm_bindgen(js_name = frameCount)]
    pub fn frame_count(&self) -> u32 {
        self.inner.frame_count()
    }

    #[wasm_bindgen(js_name = fps)]
    pub fn fps(&self) -> f32 {
        self.inner.fps()
    }

    #[wasm_bindgen(js_name = channels)]
    pub fn channels(&self) -> u8 {
        self.inner.channels()
    }

    #[wasm_bindgen(js_name = bitDepth)]
    pub fn bit_depth(&self) -> u16 {
        self.inner.bit_depth()
    }

    /// Decode one frame into a new `Float32Array`.
    ///
    /// `method` picks the 24-bit → grayscale reduction:
    /// `"Green"` (default on miniscope raw) or `"Luminance"` (Rec.601).
    /// Ignored for 8-bit streams.
    #[wasm_bindgen(js_name = readFrameGrayscaleF32)]
    pub fn read_frame_grayscale_f32(&self, n: u32, method: &str) -> Result<Vec<f32>, JsValue> {
        let m = str_to_grayscale_method(method)?;
        let pixels = self.inner.width() as usize * self.inner.height() as usize;
        let mut out = vec![0.0f32; pixels];
        self.inner
            .read_frame_grayscale_f32(n, &mut out, m)
            .map_err(|e| js_err("avi", format!("{e:?}")))?;
        Ok(out)
    }
}

// ── Preprocess ─────────────────────────────────────────────────────

/// Owning wrapper over `PreprocessPipeline` (hot-pixel → [opt butter]
/// → [opt band] → motion → [opt denoise]). All knobs come from the
/// `cfg_json` string — see `PreprocessConfig`'s `serde` shape.
#[wasm_bindgen]
pub struct Preprocessor {
    pipeline: PreprocessPipeline,
    height: u32,
    width: u32,
}

#[wasm_bindgen]
impl Preprocessor {
    /// Construct a preprocessor.
    ///
    /// - `height`, `width`: frame dimensions (must match all frames
    ///   pushed through `process_frame_*`).
    /// - `metadata_json`: JSON matching `RecordingMetadata`'s serde
    ///   shape, e.g. `{"pixel_size_um":2.0}`.
    /// - `cfg_json`: JSON matching `PreprocessConfig`'s serde shape;
    ///   `"{}"` applies every `DEFAULT_*` value.
    #[wasm_bindgen(constructor)]
    pub fn new(
        height: u32,
        width: u32,
        metadata_json: &str,
        cfg_json: &str,
    ) -> Result<Preprocessor, JsValue> {
        let metadata = parse_recording_metadata(metadata_json).map_err(config_err)?;
        let cfg = parse_preprocess_config(cfg_json).map_err(config_err)?;
        let pipeline = PreprocessPipeline::new(height as usize, width as usize, &metadata, cfg);
        Ok(Preprocessor {
            pipeline,
            height,
            width,
        })
    }

    /// Reset motion anchors. The next `process_frame_*` call behaves
    /// as a first-frame (no global anchor contribution yet).
    #[wasm_bindgen(js_name = reset)]
    pub fn reset(&mut self) {
        self.pipeline.reset();
    }

    /// Run one preprocess step on an `f32` grayscale frame
    /// (`height × width`, row-major). Returns a new `Float32Array`
    /// containing the cleaned frame.
    #[wasm_bindgen(js_name = processFrameF32)]
    pub fn process_frame_f32(&mut self, input: &[f32]) -> Result<Vec<f32>, JsValue> {
        let pixels = (self.height as usize) * (self.width as usize);
        if input.len() != pixels {
            return Err(js_err(
                "preprocess",
                format!(
                    "input length {} does not match height·width = {}",
                    input.len(),
                    pixels
                ),
            ));
        }
        let mut out = vec![0.0f32; pixels];
        {
            let input_view = Frame::new(input, self.height as usize, self.width as usize)
                .map_err(|e| js_err("preprocess", format!("input shape: {e:?}")))?;
            let mut output_view =
                FrameMut::new(&mut out, self.height as usize, self.width as usize)
                    .map_err(|e| js_err("preprocess", format!("output shape: {e:?}")))?;
            self.pipeline
                .process_frame(input_view, &mut output_view)
                .map_err(|e| js_err("preprocess", format!("{e:?}")))?;
        }
        Ok(out)
    }

    /// Convenience: decode raw AVI bytes to grayscale and preprocess
    /// in one call. Avoids a round-trip across the JS boundary for
    /// the intermediate f32 buffer.
    #[wasm_bindgen(js_name = processFrameU8)]
    pub fn process_frame_u8(
        &mut self,
        input: &[u8],
        channels: u8,
        method: &str,
    ) -> Result<Vec<f32>, JsValue> {
        let pixels = (self.height as usize) * (self.width as usize);
        let m = str_to_grayscale_method(method)?;
        let mut gray = vec![0.0f32; pixels];
        decode_grayscale_f32(input, pixels, channels, &mut gray, m)
            .map_err(|e| js_err("preprocess", format!("decode: {e:?}")))?;
        self.process_frame_f32(&gray)
    }
}

// ── Fit ────────────────────────────────────────────────────────────

/// Owning wrapper over `FitPipeline` — the per-frame OMF step. Starts
/// with an empty `Footprints` (`num_components() == 0`); the fit
/// worker grows the model by draining the `MutationQueueHandle`.
#[wasm_bindgen]
pub struct Fitter {
    pipeline: FitPipeline,
    height: u32,
    width: u32,
}

#[wasm_bindgen]
impl Fitter {
    /// Construct a fitter for a fixed-shape frame stream.
    ///
    /// `cfg_json` parses against `FitConfig`'s serde shape. `"{}"`
    /// means every `DEFAULT_*` value applies.
    #[wasm_bindgen(constructor)]
    pub fn new(height: u32, width: u32, cfg_json: &str) -> Result<Fitter, JsValue> {
        let cfg = parse_fit_config(cfg_json).map_err(config_err)?;
        let footprints = Footprints::new(height as usize, width as usize);
        let pipeline = FitPipeline::new(footprints, cfg);
        Ok(Fitter {
            pipeline,
            height,
            width,
        })
    }

    /// Current asset epoch. Advances once per successful mutation
    /// apply; not touched by per-frame `step` calls.
    #[wasm_bindgen(js_name = epoch)]
    pub fn epoch(&self) -> u64 {
        self.pipeline.epoch()
    }

    /// Number of live components in `Ã`.
    #[wasm_bindgen(js_name = numComponents)]
    pub fn num_components(&self) -> u32 {
        self.pipeline.footprints().len() as u32
    }

    #[wasm_bindgen(js_name = height)]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[wasm_bindgen(js_name = width)]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Run one OMF frame. Returns the residual `R_t` as a new
    /// `Float32Array` so the extend worker can read it.
    #[wasm_bindgen(js_name = step)]
    pub fn step(&mut self, y: &[f32]) -> Result<Vec<f32>, JsValue> {
        let pixels = (self.height as usize) * (self.width as usize);
        if y.len() != pixels {
            return Err(js_err(
                "fit",
                format!(
                    "frame length {} does not match height·width = {}",
                    y.len(),
                    pixels
                ),
            ));
        }
        Ok(self.pipeline.step(y).to_vec())
    }

    /// Latest trace vector `c_t` (length = `num_components()`), or an
    /// empty `Float32Array` before the first `step()` has landed.
    #[wasm_bindgen(js_name = lastTrace)]
    pub fn last_trace(&self) -> Vec<f32> {
        match self.pipeline.traces().last() {
            Some(c) => c.to_vec(),
            None => Vec::new(),
        }
    }

    /// Drain every mutation in `queue` and apply in FIFO order. The
    /// returned flat `Uint32Array` carries `[applied, stale, invalid]`
    /// counts — ready to push to the archive worker for dashboard
    /// metrics.
    #[wasm_bindgen(js_name = drainApply)]
    pub fn drain_apply(&mut self, queue: &mut MutationQueueHandle) -> Vec<u32> {
        let report = self.pipeline.drain_apply(&mut queue.inner);
        vec![report.applied, report.stale, report.invalid]
    }

    /// Take an extend-visible snapshot of `(Ã, W, M, epoch)` — design
    /// §7.2. Returned as an opaque handle; Phase 5 only surfaces
    /// `epoch()` on it, full read accessors are Phase 7 extend work.
    #[wasm_bindgen(js_name = takeSnapshot)]
    pub fn take_snapshot(&self) -> SnapshotHandle {
        SnapshotHandle {
            inner: self.pipeline.snapshot(),
        }
    }
}

// ── Snapshot ───────────────────────────────────────────────────────

/// Opaque handle to a `Snapshot`. Only `epoch` is surfaced in Phase 5;
/// full extend-side access lands with the real extend worker.
#[wasm_bindgen]
pub struct SnapshotHandle {
    inner: Snapshot,
}

#[wasm_bindgen]
impl SnapshotHandle {
    #[wasm_bindgen(js_name = epoch)]
    pub fn epoch(&self) -> u64 {
        self.inner.epoch
    }

    #[wasm_bindgen(js_name = numComponents)]
    pub fn num_components(&self) -> u32 {
        self.inner.footprints.len() as u32
    }

    #[wasm_bindgen(js_name = pixels)]
    pub fn pixels(&self) -> u32 {
        self.inner.footprints.pixels() as u32
    }
}

// ── Mutation queue ─────────────────────────────────────────────────

/// Opaque handle to a `MutationQueue`. Extend pushes; fit drains via
/// `Fitter::drain_apply`. Construction reads `mutation_queue_capacity`
/// from `ExtendConfig`'s JSON (default 32 per design §7.3).
#[wasm_bindgen]
pub struct MutationQueueHandle {
    inner: MutationQueue,
}

#[wasm_bindgen]
impl MutationQueueHandle {
    /// Construct a queue whose capacity comes from `extend_cfg_json`'s
    /// `mutation_queue_capacity` field. JS callers pass the same JSON
    /// used to build the `ExtendConfig` — single source of truth.
    #[wasm_bindgen(constructor)]
    pub fn new(extend_cfg_json: &str) -> Result<MutationQueueHandle, JsValue> {
        let cfg = parse_extend_config(extend_cfg_json).map_err(config_err)?;
        Ok(MutationQueueHandle {
            inner: MutationQueue::new(cfg.mutation_queue_capacity),
        })
    }

    #[wasm_bindgen(js_name = capacity)]
    pub fn capacity(&self) -> u32 {
        self.inner.capacity() as u32
    }

    #[wasm_bindgen(js_name = len)]
    pub fn len(&self) -> u32 {
        self.inner.len() as u32
    }

    #[wasm_bindgen(js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    #[wasm_bindgen(js_name = isFull)]
    pub fn is_full(&self) -> bool {
        self.inner.is_full()
    }

    #[wasm_bindgen(js_name = drops)]
    pub fn drops(&self) -> u64 {
        self.inner.drops()
    }

    /// Enqueue a deprecate mutation. Phase 5 exposes deprecate as the
    /// minimal push surface — register / merge pushes light up in
    /// Phase 7 when extend actually generates them. `reason` takes
    /// the serde-variant string (`"FootprintCollapsed"`, etc).
    #[wasm_bindgen(js_name = pushDeprecate)]
    pub fn push_deprecate(
        &mut self,
        snapshot_epoch: u64,
        id: u32,
        reason: &str,
    ) -> Result<(), JsValue> {
        let reason = match reason {
            "FootprintCollapsed" => DeprecateReason::FootprintCollapsed,
            "TraceInactive" => DeprecateReason::TraceInactive,
            "MergedInto" => DeprecateReason::MergedInto,
            "InvalidApply" => DeprecateReason::InvalidApply,
            other => {
                return Err(js_err(
                    "mutation",
                    format!("unknown DeprecateReason '{other}'"),
                ))
            }
        };
        self.inner.push(PipelineMutation::Deprecate {
            snapshot_epoch: snapshot_epoch as Epoch,
            id,
            reason,
        });
        Ok(())
    }
}

// ── Extend driver ──────────────────────────────────────────────────

/// Wraps a `ResidualRingBuf` plus the parsed `ExtendConfig` /
/// `RecordingMetadata` so the browser W3 worker can drive one
/// `extending::driver::run_cycle` per extend tick without re-parsing
/// JSON every call. The caller pushes residuals each fit frame and
/// invokes `runCycle` on whatever cadence the worker chooses
/// (design §7.2, §13 bounded-work-per-cycle).
#[wasm_bindgen]
pub struct Extender {
    residual_buf: ResidualRingBuf,
    extend_cfg: ExtendConfig,
    recording: RecordingMetadata,
    height: u32,
    width: u32,
}

#[wasm_bindgen]
impl Extender {
    /// Construct an Extender. `residual_window_len` is typically
    /// `ExtendConfig::extend_window_frames` but stays an explicit
    /// argument so the caller can size the buffer against whatever
    /// window they ship to fit without re-reading the config.
    #[wasm_bindgen(constructor)]
    pub fn new(
        height: u32,
        width: u32,
        residual_window_len: u32,
        extend_cfg_json: &str,
        metadata_json: &str,
    ) -> Result<Extender, JsValue> {
        let extend_cfg = parse_extend_config(extend_cfg_json).map_err(config_err)?;
        let recording = parse_recording_metadata(metadata_json).map_err(config_err)?;
        let residual_buf = ResidualRingBuf::new(
            (height as usize) * (width as usize),
            residual_window_len as usize,
        );
        Ok(Extender {
            residual_buf,
            extend_cfg,
            recording,
            height,
            width,
        })
    }

    /// Push one residual frame (length = `height * width`). Drop-oldest
    /// when the window is full.
    #[wasm_bindgen(js_name = pushResidual)]
    pub fn push_residual(&mut self, residual: &[f32]) -> Result<(), JsValue> {
        let pixels = (self.height as usize) * (self.width as usize);
        if residual.len() != pixels {
            return Err(js_err(
                "extend",
                format!(
                    "residual length {} does not match height·width = {}",
                    residual.len(),
                    pixels
                ),
            ));
        }
        self.residual_buf.push(residual);
        Ok(())
    }

    /// Length of the residual window that would feed the next cycle.
    /// Cosmetic accessor the worker exposes as a vitals metric.
    #[wasm_bindgen(js_name = residualLen)]
    pub fn residual_len(&self) -> u32 {
        self.residual_buf.len() as u32
    }

    /// Run one extend cycle against `fitter`'s current state.
    /// Proposals land on `queue` (drop-oldest); returns the number
    /// actually pushed this call so the worker can report an
    /// extend-cycle metric.
    #[wasm_bindgen(js_name = runCycle)]
    pub fn run_cycle(&mut self, fitter: &Fitter, queue: &mut MutationQueueHandle) -> u32 {
        extend_driver::run_cycle(
            &self.residual_buf,
            &fitter.pipeline,
            self.height as usize,
            self.width as usize,
            &self.recording,
            &self.extend_cfg,
            &mut queue.inner,
        )
    }
}
