//! wasm-bindgen surface of the preprocessing chain, for a Web Worker.
//!
//! Frames cross the boundary in batches: one contiguous buffer of `count`
//! frames (`u8` or `u16` in, `f32` out, row-major, frame after frame), so a
//! worker can hand over what `readFrames` produced without per-frame calls.
//! Per-frame records come back as one flat `Float64Array` with a fixed stride
//! ([`RECORD_STRIDE`] fields per frame, documented on
//! [`JsPreprocessor::process_frames`]).
//!
//! Motion correction is not in here yet: use `frontFrames`, register the
//! frames, then `backFrames`; `processFrames` is the no-motion shortcut.

use wasm_bindgen::prelude::*;

use super::flicker::{FlickerMode, FlickerRecord};
use super::lines::LineMode;
use super::warmup::WarmupAccumulator;
use super::{
    Calibration, Dims, PreprocessConfig, PreprocessError, PreprocessState, Preprocessor, RawPixel,
};

/// Fields per frame in the record array of `processFrames`.
pub const RECORD_STRIDE: usize = 10;
/// Fields per frame from `frontFrames`.
pub const FRONT_RECORD_STRIDE: usize = 6;
/// Fields per frame from `backFrames`.
pub const HALF_RECORD_STRIDE: usize = 4;

fn js_err(func: &str, e: PreprocessError) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

/// `count` frames of `n` samples each, or an error naming the mismatch.
fn check_batch(func: &str, len: usize, count: u32, n: usize) -> Result<usize, JsError> {
    let count = count as usize;
    match count.checked_mul(n) {
        Some(total) if total == len => Ok(count),
        _ => Err(JsError::new(&format!(
            "{func}: buffer holds {len} samples, expected {count} frames of {n}"
        ))),
    }
}

/// Settings for every stage; the defaults are the documented ones.
#[wasm_bindgen(js_name = PreprocessConfig)]
#[derive(Clone)]
pub struct JsPreprocessConfig {
    inner: PreprocessConfig,
}

#[wasm_bindgen(js_class = PreprocessConfig)]
impl JsPreprocessConfig {
    /// Defaults for a recording at `fps` frames per second (0 = 20 fps).
    #[wasm_bindgen(constructor)]
    pub fn new(fps: f32) -> JsPreprocessConfig {
        console_error_panic_hook::set_once();
        JsPreprocessConfig {
            inner: PreprocessConfig::for_fps(fps),
        }
    }

    #[wasm_bindgen(setter, js_name = warmupFrames)]
    pub fn set_warmup_frames(&mut self, v: u32) {
        self.inner.warmup_frames = v as usize;
    }

    #[wasm_bindgen(getter, js_name = warmupFrames)]
    pub fn warmup_frames(&self) -> u32 {
        self.inner.warmup_frames as u32
    }

    /// Expected soma diameter in pixels (sets the flattening σ = 2x this).
    #[wasm_bindgen(setter, js_name = cellDiameterPx)]
    pub fn set_cell_diameter_px(&mut self, v: f32) {
        self.inner.flatten.cell_diameter_px = v;
    }

    #[wasm_bindgen(getter, js_name = cellDiameterPx)]
    pub fn cell_diameter_px(&self) -> f32 {
        self.inner.flatten.cell_diameter_px
    }

    /// Explicit flattening σ in pixels; 0 = derive from the cell diameter.
    #[wasm_bindgen(setter, js_name = flattenSigmaPx)]
    pub fn set_flatten_sigma_px(&mut self, v: f32) {
        self.inner.flatten.sigma_px = (v > 0.0).then_some(v);
    }

    #[wasm_bindgen(getter, js_name = flattenSigmaPx)]
    pub fn flatten_sigma_px(&self) -> f32 {
        self.inner.flatten.sigma()
    }

    /// 0 off, 1 rows, 2 columns, 3 both.
    #[wasm_bindgen(setter, js_name = lineMode)]
    pub fn set_line_mode(&mut self, v: u8) {
        self.inner.lines = LineMode::from_code(v).unwrap_or(LineMode::Off);
    }

    /// Global flicker correction: 0 off, 1 additive (sensor offset), 2
    /// multiplicative (LED gain), 3 both (default).
    #[wasm_bindgen(setter, js_name = flickerMode)]
    pub fn set_flicker_mode(&mut self, v: u8) {
        self.inner.flicker.mode = FlickerMode::from_code(v).unwrap_or(FlickerMode::Off);
    }

    #[wasm_bindgen(getter, js_name = flickerMode)]
    pub fn flicker_mode(&self) -> u8 {
        self.inner.flicker.mode.code()
    }

    /// Time constant of the flicker reference image, frames.
    #[wasm_bindgen(setter, js_name = flickerTauFrames)]
    pub fn set_flicker_tau_frames(&mut self, v: f32) {
        self.inner.flicker.tau_frames = v;
    }

    #[wasm_bindgen(getter, js_name = flickerTauFrames)]
    pub fn flicker_tau_frames(&self) -> f32 {
        self.inner.flicker.tau_frames
    }

    #[wasm_bindgen(setter, js_name = hotPixelKSigma)]
    pub fn set_hot_k_sigma(&mut self, v: f32) {
        self.inner.hot.k_sigma = v;
    }

    #[wasm_bindgen(setter, js_name = fovRelThreshold)]
    pub fn set_fov_rel_threshold(&mut self, v: f32) {
        self.inner.fov.rel_threshold = v;
    }

    #[wasm_bindgen(setter, js_name = fovFitDisk)]
    pub fn set_fov_fit_disk(&mut self, v: bool) {
        self.inner.fov.fit_disk = v;
    }

    #[wasm_bindgen(setter, js_name = backgroundBoxcar)]
    pub fn set_background_boxcar(&mut self, v: u32) {
        self.inner.background.boxcar = v as usize;
    }

    /// Upward relaxation time constant in frames (0 = pure running minimum).
    #[wasm_bindgen(setter, js_name = backgroundRelaxFrames)]
    pub fn set_background_relax_frames(&mut self, v: f32) {
        self.inner.background.relax_frames = v;
    }

    #[wasm_bindgen(setter, js_name = backgroundSnapshotEvery)]
    pub fn set_background_snapshot_every(&mut self, v: u32) {
        self.inner.background.snapshot_every = v;
    }
}

/// Accumulates the warm-up frames, then builds a [`JsPreprocessor`].
#[wasm_bindgen(js_name = PreprocessWarmup)]
pub struct JsWarmup {
    acc: WarmupAccumulator,
    cfg: PreprocessConfig,
}

#[wasm_bindgen(js_class = PreprocessWarmup)]
impl JsWarmup {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, config: &JsPreprocessConfig) -> Result<JsWarmup, JsError> {
        console_error_panic_hook::set_once();
        let dims = Dims::new(width as usize, height as usize)
            .map_err(|e| js_err("PreprocessWarmup", e))?;
        config
            .inner
            .validate()
            .map_err(|e| js_err("PreprocessWarmup", e))?;
        Ok(JsWarmup {
            acc: WarmupAccumulator::new(dims),
            cfg: config.inner,
        })
    }

    /// Add `count` 8-bit frames from one contiguous buffer.
    #[wasm_bindgen(js_name = pushFrames)]
    pub fn push_frames(&mut self, frames: &[u8], count: u32) -> Result<(), JsError> {
        self.push(frames, count)
    }

    /// Add `count` 16-bit frames.
    #[wasm_bindgen(js_name = pushFrames16)]
    pub fn push_frames16(&mut self, frames: &[u16], count: u32) -> Result<(), JsError> {
        self.push(frames, count)
    }

    fn push<T: RawPixel>(&mut self, frames: &[T], count: u32) -> Result<(), JsError> {
        let n = self.acc.dims().pixels();
        check_batch("pushFrames", frames.len(), count, n)?;
        for f in frames.chunks_exact(n) {
            self.acc.push(f).map_err(|e| js_err("pushFrames", e))?;
        }
        Ok(())
    }

    /// Frames pushed so far.
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> f64 {
        self.acc.count() as f64
    }

    /// Estimate the calibration (FOV mask, hot pixels) and build the chain.
    pub fn finish(&self) -> Result<JsPreprocessor, JsError> {
        let cal =
            Calibration::from_warmup(&self.acc, &self.cfg).map_err(|e| js_err("finish", e))?;
        let inner = Preprocessor::new(cal, &self.cfg).map_err(|e| js_err("finish", e))?;
        Ok(JsPreprocessor { inner })
    }
}

/// The preprocessing chain for one recording.
#[wasm_bindgen(js_name = Preprocessor)]
pub struct JsPreprocessor {
    inner: Preprocessor,
}

impl JsPreprocessor {
    fn process<T: RawPixel>(
        &mut self,
        input: &[T],
        count: u32,
        out: &mut [f32],
    ) -> Result<Vec<f64>, JsError> {
        let n = self.inner.dims().pixels();
        let count = check_batch("processFrames", input.len(), count, n)?;
        check_batch("processFrames (output)", out.len(), count as u32, n)?;
        let mut rec = Vec::with_capacity(count * RECORD_STRIDE);
        for (raw, o) in input.chunks_exact(n).zip(out.chunks_exact_mut(n)) {
            let r = self
                .inner
                .process_frame(raw, o)
                .map_err(|e| js_err("processFrames", e))?;
            rec.extend_from_slice(&[
                r.back.frame_index as f64,
                f64::from(r.front.input_mean),
                f64::from(r.front.lowpass_mean),
                f64::from(r.front.row_rms),
                f64::from(r.front.col_rms),
                f64::from(r.back.floor_mean),
                f64::from(r.back.floor_lowered_fraction),
                f64::from(u8::from(r.back.snapshot)),
                f64::from(r.front.flicker.offset),
                f64::from(r.front.flicker.gain),
            ]);
        }
        Ok(rec)
    }

    fn front<T: RawPixel>(
        &mut self,
        input: &[T],
        count: u32,
        out: &mut [f32],
    ) -> Result<Vec<f64>, JsError> {
        let n = self.inner.dims().pixels();
        let count = check_batch("frontFrames", input.len(), count, n)?;
        check_batch("frontFrames (output)", out.len(), count as u32, n)?;
        let mut rec = Vec::with_capacity(count * FRONT_RECORD_STRIDE);
        for (raw, o) in input.chunks_exact(n).zip(out.chunks_exact_mut(n)) {
            let r = self
                .inner
                .front(raw, o)
                .map_err(|e| js_err("frontFrames", e))?;
            rec.extend_from_slice(&[
                f64::from(r.input_mean),
                f64::from(r.lowpass_mean),
                f64::from(r.row_rms),
                f64::from(r.col_rms),
                f64::from(r.flicker.offset),
                f64::from(r.flicker.gain),
            ]);
        }
        Ok(rec)
    }
}

impl JsPreprocessor {
    /// [`Self::front`] with recorded flicker (`offset`, `gain` per frame) instead of new estimates.
    fn front_replay<T: RawPixel>(
        &mut self,
        input: &[T],
        count: u32,
        offset: &[f32],
        gain: &[f32],
        out: &mut [f32],
    ) -> Result<Vec<f64>, JsError> {
        let n = self.inner.dims().pixels();
        let count = check_batch("frontFramesReplay", input.len(), count, n)?;
        check_batch("frontFramesReplay (output)", out.len(), count as u32, n)?;
        if offset.len() != count || gain.len() != count {
            return Err(JsError::new(&format!(
                "frontFramesReplay: {} offsets and {} gains for {count} frames",
                offset.len(),
                gain.len()
            )));
        }
        let mut rec = Vec::with_capacity(count * FRONT_RECORD_STRIDE);
        for (i, (raw, o)) in input
            .chunks_exact(n)
            .zip(out.chunks_exact_mut(n))
            .enumerate()
        {
            let flicker = FlickerRecord {
                offset: offset[i],
                gain: gain[i],
                ..FlickerRecord::default()
            };
            let r = self
                .inner
                .front_replay(raw, o, &flicker)
                .map_err(|e| js_err("frontFramesReplay", e))?;
            rec.extend_from_slice(&[
                f64::from(r.input_mean),
                f64::from(r.lowpass_mean),
                f64::from(r.row_rms),
                f64::from(r.col_rms),
                f64::from(r.flicker.offset),
                f64::from(r.flicker.gain),
            ]);
        }
        Ok(rec)
    }
}

#[wasm_bindgen(js_class = Preprocessor)]
impl JsPreprocessor {
    /// The whole chain without motion correction, `count` 8-bit frames from
    /// `input` into `out` (`count · width · height` floats). Returns
    /// [`RECORD_STRIDE`] numbers per frame: frame index, input mean in the
    /// FOV, subtracted glow mean, row and column offset RMS, subtracted
    /// background mean, fraction of pixels whose background snapped down,
    /// snapshot taken (0/1), flicker offset `a_t` (grey levels), flicker gain
    /// `m_t` (relative).
    #[wasm_bindgen(js_name = processFrames)]
    pub fn process_frames(
        &mut self,
        input: &[u8],
        count: u32,
        out: &mut [f32],
    ) -> Result<Vec<f64>, JsError> {
        self.process(input, count, out)
    }

    /// [`Self::process_frames`] for 16-bit input.
    #[wasm_bindgen(js_name = processFrames16)]
    pub fn process_frames16(
        &mut self,
        input: &[u16],
        count: u32,
        out: &mut [f32],
    ) -> Result<Vec<f64>, JsError> {
        self.process(input, count, out)
    }

    /// The sensor-coordinate half (hot pixels, flicker, flattening, lines).
    /// Advances the flicker reference; everything else is stateless. Returns
    /// [`FRONT_RECORD_STRIDE`] numbers per frame: input mean, glow mean, row
    /// RMS, column RMS, flicker offset `a_t`, flicker gain `m_t`.
    #[wasm_bindgen(js_name = frontFrames)]
    pub fn front_frames(
        &mut self,
        input: &[u8],
        count: u32,
        out: &mut [f32],
    ) -> Result<Vec<f64>, JsError> {
        self.front(input, count, out)
    }

    #[wasm_bindgen(js_name = frontFrames16)]
    pub fn front_frames16(
        &mut self,
        input: &[u16],
        count: u32,
        out: &mut [f32],
    ) -> Result<Vec<f64>, JsError> {
        self.front(input, count, out)
    }

    /// [`Self::front_frames`] replaying recorded flicker (`offset`, `gain`
    /// per frame, as `frontFrames` returned them) instead of estimating it:
    /// stateless, so any frames in any order reproduce the original front
    /// half bit for bit. Same record layout as `frontFrames`.
    #[wasm_bindgen(js_name = frontFramesReplay)]
    pub fn front_frames_replay(
        &mut self,
        input: &[u8],
        count: u32,
        offset: &[f32],
        gain: &[f32],
        out: &mut [f32],
    ) -> Result<Vec<f64>, JsError> {
        self.front_replay(input, count, offset, gain, out)
    }

    #[wasm_bindgen(js_name = frontFramesReplay16)]
    pub fn front_frames_replay16(
        &mut self,
        input: &[u16],
        count: u32,
        offset: &[f32],
        gain: &[f32],
        out: &mut [f32],
    ) -> Result<Vec<f64>, JsError> {
        self.front_replay(input, count, offset, gain, out)
    }

    /// The tissue-coordinate half (background, noise map), in place on
    /// registered frames. Returns [`HALF_RECORD_STRIDE`] numbers per frame:
    /// frame index, background mean, lowered fraction, snapshot (0/1).
    #[wasm_bindgen(js_name = backFrames)]
    pub fn back_frames(&mut self, frames: &mut [f32], count: u32) -> Result<Vec<f64>, JsError> {
        let n = self.inner.dims().pixels();
        let count = check_batch("backFrames", frames.len(), count, n)?;
        let mut rec = Vec::with_capacity(count * HALF_RECORD_STRIDE);
        for f in frames.chunks_exact_mut(n) {
            let r = self.inner.back(f).map_err(|e| js_err("backFrames", e))?;
            rec.extend_from_slice(&[
                r.frame_index as f64,
                f64::from(r.floor_mean),
                f64::from(r.floor_lowered_fraction),
                f64::from(u8::from(r.snapshot)),
            ]);
        }
        Ok(rec)
    }

    /// [`Self::back_frames`] for frames motion-corrected by the rigid shifts
    /// `dy[i]`, `dx[i]` (bicubic): pixels the shift moved in from outside the
    /// sensor's FOV mask are missing, so they do not enter the noise map or
    /// the background, and come out at their recent level (NaN before their
    /// first valid sample; see `Preprocessor::back_masked`).
    #[wasm_bindgen(js_name = backFramesRegistered)]
    pub fn back_frames_registered(
        &mut self,
        frames: &mut [f32],
        count: u32,
        dy: &[f32],
        dx: &[f32],
    ) -> Result<Vec<f64>, JsError> {
        let n = self.inner.dims().pixels();
        let count = check_batch("backFramesRegistered", frames.len(), count, n)?;
        if dy.len() < count || dx.len() < count {
            return Err(JsError::new(&format!(
                "backFramesRegistered: {count} frames but {} / {} shifts",
                dy.len(),
                dx.len()
            )));
        }
        let mut rec = Vec::with_capacity(count * HALF_RECORD_STRIDE);
        for (i, f) in frames.chunks_exact_mut(n).take(count).enumerate() {
            let r = self
                .inner
                .back_rigid(f, (dy[i], dx[i]))
                .map_err(|e| js_err("backFramesRegistered", e))?;
            rec.extend_from_slice(&[
                r.frame_index as f64,
                f64::from(r.floor_mean),
                f64::from(r.floor_lowered_fraction),
                f64::from(u8::from(r.snapshot)),
            ]);
        }
        Ok(rec)
    }

    /// Serialized config, calibration and running state.
    pub fn state(&self) -> Vec<u8> {
        self.inner.state().to_bytes()
    }

    /// A preprocessor that continues exactly where `state` was taken.
    #[wasm_bindgen(js_name = fromState)]
    pub fn from_state(state: &[u8]) -> Result<JsPreprocessor, JsError> {
        console_error_panic_hook::set_once();
        let st = PreprocessState::from_bytes(state).map_err(|e| js_err("fromState", e))?;
        let inner = Preprocessor::from_state(&st).map_err(|e| js_err("fromState", e))?;
        Ok(JsPreprocessor { inner })
    }

    /// Restore the running state (same recording, same calibration).
    pub fn restore(&mut self, state: &[u8]) -> Result<(), JsError> {
        let st = PreprocessState::from_bytes(state).map_err(|e| js_err("restore", e))?;
        self.inner.restore(&st).map_err(|e| js_err("restore", e))
    }

    /// Stop updating the background (pass 2 with the final estimate).
    #[wasm_bindgen(js_name = freezeBackground)]
    pub fn freeze_background(&mut self) {
        self.inner.background_mut().freeze();
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.dims().width as u32
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.dims().height as u32
    }

    #[wasm_bindgen(getter, js_name = framesProcessed)]
    pub fn frames_processed(&self) -> f64 {
        self.inner.frames_processed() as f64
    }

    /// 1 inside the field of view, 0 outside.
    #[wasm_bindgen(js_name = fovMask)]
    pub fn fov_mask(&self) -> Vec<u8> {
        self.inner.calibration().fov().mask().to_vec()
    }

    /// 0 ok, 1 hot, 2 cold, 3 stuck.
    #[wasm_bindgen(js_name = hotPixelFlags)]
    pub fn hot_pixel_flags(&self) -> Vec<u8> {
        self.inner.calibration().hot_pixels().flags().to_vec()
    }

    /// The current background floor.
    pub fn background(&self) -> Vec<f32> {
        self.inner.background().final_estimate().to_vec()
    }

    /// Per-pixel noise σ of the output.
    #[wasm_bindgen(js_name = noiseSigma)]
    pub fn noise_sigma(&self) -> Vec<f32> {
        self.inner.noise().sigma()
    }
}
