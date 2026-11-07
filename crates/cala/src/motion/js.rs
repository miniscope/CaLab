//! wasm-bindgen surface of the motion corrector, batched: every call takes
//! one contiguous buffer of `count` frames (as `readFrames` produces) and
//! writes corrected `f32` frames plus flat records into caller-owned arrays.
//!
//! A flat record is `[dy, dx, quality, flags, residual...]`
//! (`recordLen` values; see `MotionRecord::write_flat`).

use wasm_bindgen::prelude::*;

use super::{
    Frame, Frames, Interpolation, MotionConfig, MotionCorrector, MotionError, MotionRecord,
    NonRigidConfig, Warper,
};

fn js_err(func: &str, e: MotionError) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

/// Motion-correction options; `new MotionOptions()` gives the defaults.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct MotionOptions {
    /// Largest rigid shift searched, px.
    #[wasm_bindgen(js_name = maxShift)]
    pub max_shift: f32,
    /// Cap on the automatic registration-region side (0 = none).
    #[wasm_bindgen(js_name = roiMaxSide)]
    pub roi_max_side: u32,
    #[wasm_bindgen(js_name = dogSigmaSmall)]
    pub dog_sigma_small: f32,
    #[wasm_bindgen(js_name = dogSigmaLarge)]
    pub dog_sigma_large: f32,
    /// Sub-pixel DFT upsampling (<= 1 = parabolic fallback).
    pub upsample: u32,
    #[wasm_bindgen(js_name = warmupIterations)]
    pub warmup_iterations: u32,
    /// Running-template time constant in frames (0 = frozen).
    #[wasm_bindgen(js_name = templateTau)]
    pub template_tau: f32,
    #[wasm_bindgen(js_name = anchorWeight)]
    pub anchor_weight: f32,
    /// Enable piecewise-rigid refinement.
    pub nonrigid: bool,
    #[wasm_bindgen(js_name = gridRows)]
    pub grid_rows: u32,
    #[wasm_bindgen(js_name = gridCols)]
    pub grid_cols: u32,
    #[wasm_bindgen(js_name = maxPatchShift)]
    pub max_patch_shift: f32,
    #[wasm_bindgen(js_name = temporalAlpha)]
    pub temporal_alpha: f32,
    /// Bilinear instead of bicubic resampling.
    pub bilinear: bool,
}

#[wasm_bindgen]
impl MotionOptions {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MotionOptions {
        let c = MotionConfig::default();
        let n = NonRigidConfig::default();
        MotionOptions {
            max_shift: c.max_shift,
            roi_max_side: c.roi_max_side as u32,
            dog_sigma_small: c.dog_sigma_small,
            dog_sigma_large: c.dog_sigma_large,
            upsample: c.upsample,
            warmup_iterations: c.warmup_iterations as u32,
            template_tau: c.template_tau,
            anchor_weight: c.anchor_weight,
            nonrigid: false,
            grid_rows: n.grid.0 as u32,
            grid_cols: n.grid.1 as u32,
            max_patch_shift: n.max_patch_shift,
            temporal_alpha: n.temporal_alpha,
            bilinear: false,
        }
    }
}

impl Default for MotionOptions {
    fn default() -> Self {
        Self::new()
    }
}

impl MotionOptions {
    fn to_config(self) -> MotionConfig {
        MotionConfig {
            max_shift: self.max_shift,
            roi_max_side: self.roi_max_side as usize,
            dog_sigma_small: self.dog_sigma_small,
            dog_sigma_large: self.dog_sigma_large,
            upsample: self.upsample,
            warmup_iterations: self.warmup_iterations as usize,
            template_tau: self.template_tau,
            anchor_weight: self.anchor_weight,
            nonrigid: self.nonrigid.then(|| NonRigidConfig {
                grid: (self.grid_rows as usize, self.grid_cols as usize),
                max_patch_shift: self.max_patch_shift,
                temporal_alpha: self.temporal_alpha,
                ..NonRigidConfig::default()
            }),
            interpolation: if self.bilinear {
                Interpolation::Bilinear
            } else {
                Interpolation::Bicubic
            },
            ..MotionConfig::default()
        }
    }
}

/// Streaming motion corrector (see the Rust `MotionCorrector`).
#[wasm_bindgen(js_name = MotionCorrector)]
pub struct JsMotionCorrector {
    inner: MotionCorrector,
}

#[wasm_bindgen(js_class = MotionCorrector)]
impl JsMotionCorrector {
    #[wasm_bindgen(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        options: &MotionOptions,
    ) -> Result<JsMotionCorrector, JsError> {
        console_error_panic_hook::set_once();
        MotionCorrector::new(height as usize, width as usize, options.to_config())
            .map(|inner| JsMotionCorrector { inner })
            .map_err(|e| js_err("MotionCorrector", e))
    }

    /// Values per flat record.
    #[wasm_bindgen(getter, js_name = recordLen)]
    pub fn record_len(&self) -> u32 {
        self.inner.record_len() as u32
    }

    #[wasm_bindgen(getter, js_name = isInitialized)]
    pub fn is_initialized(&self) -> bool {
        self.inner.is_initialized()
    }

    /// Lit field-of-view mask (`width * height`, nonzero = inside) bounding
    /// the automatic registration region. Call before initialising.
    #[wasm_bindgen(js_name = setFovMask)]
    pub fn set_fov_mask(&mut self, mask: &[u8]) -> Result<(), JsError> {
        self.inner
            .set_fov_mask(mask)
            .map_err(|e| js_err("setFovMask", e))
    }

    /// Build the warm-up template from a batch of 8-bit frames.
    #[wasm_bindgen(js_name = initializeU8)]
    pub fn initialize_u8(&mut self, frames: &[u8]) -> Result<(), JsError> {
        self.inner
            .initialize(Frames::U8(frames))
            .map_err(|e| js_err("initializeU8", e))
    }

    /// Build the warm-up template from a batch of float frames.
    #[wasm_bindgen(js_name = initializeF32)]
    pub fn initialize_f32(&mut self, frames: &[f32]) -> Result<(), JsError> {
        self.inner
            .initialize(Frames::F32(frames))
            .map_err(|e| js_err("initializeF32", e))
    }

    /// Correct a batch of 8-bit frames into `out`, records into `records`.
    #[wasm_bindgen(js_name = processU8)]
    pub fn process_u8(
        &mut self,
        frames: &[u8],
        out: &mut [f32],
        records: &mut [f32],
    ) -> Result<(), JsError> {
        self.inner
            .process_batch(Frames::U8(frames), out, records)
            .map_err(|e| js_err("processU8", e))
    }

    /// Correct a batch of float frames into `out`, records into `records`.
    #[wasm_bindgen(js_name = processF32)]
    pub fn process_f32(
        &mut self,
        frames: &[f32],
        out: &mut [f32],
        records: &mut [f32],
    ) -> Result<(), JsError> {
        self.inner
            .process_batch(Frames::F32(frames), out, records)
            .map_err(|e| js_err("processF32", e))
    }

    /// Replay a batch of 8-bit frames with their records (no estimation).
    #[wasm_bindgen(js_name = applyU8)]
    pub fn apply_u8(
        &mut self,
        frames: &[u8],
        records: &[f32],
        out: &mut [f32],
    ) -> Result<(), JsError> {
        self.inner
            .apply_batch(Frames::U8(frames), records, out)
            .map_err(|e| js_err("applyU8", e))
    }

    /// Replay a batch of float frames with their records (no estimation).
    #[wasm_bindgen(js_name = applyF32)]
    pub fn apply_f32(
        &mut self,
        frames: &[f32],
        records: &[f32],
        out: &mut [f32],
    ) -> Result<(), JsError> {
        self.inner
            .apply_batch(Frames::F32(frames), records, out)
            .map_err(|e| js_err("applyF32", e))
    }

    /// Validity mask (1 = source pixel inside the frame) of one flat record.
    #[wasm_bindgen(js_name = validMask)]
    pub fn valid_mask(&mut self, record: &[f32], out: &mut [u8]) -> Result<(), JsError> {
        let rec = MotionRecord::from_flat(record).map_err(|e| js_err("validMask", e))?;
        let warper: Warper = match self.inner.geometry() {
            Some(g) => g.warper().map_err(|e| js_err("validMask", e))?,
            None => return Err(js_err("validMask", MotionError::NotInitialized)),
        };
        warper
            .validity_mask((rec.dy, rec.dx), &rec.residual, out)
            .map_err(|e| js_err("validMask", e))
    }

    /// Correct one 8-bit frame (convenience for interactive use).
    #[wasm_bindgen(js_name = processFrameU8)]
    pub fn process_frame_u8(&mut self, frame: &[u8], out: &mut [f32]) -> Result<Vec<f32>, JsError> {
        let rec = self
            .inner
            .process(Frame::U8(frame), out)
            .map_err(|e| js_err("processFrameU8", e))?;
        let mut flat = vec![0.0; MotionRecord::flat_len(rec.residual.len())];
        rec.write_flat(&mut flat)
            .map_err(|e| js_err("processFrameU8", e))?;
        Ok(flat)
    }

    /// `[y0, x0, height, width]` of the registration region (empty before
    /// initialisation).
    pub fn roi(&self) -> Vec<u32> {
        self.inner.geometry().map_or_else(Vec::new, |g| {
            vec![
                g.roi.y0 as u32,
                g.roi.x0 as u32,
                g.roi.height as u32,
                g.roi.width as u32,
            ]
        })
    }

    /// Patch-centre rows (frame px) of the residual grid.
    #[wasm_bindgen(js_name = nodeYs)]
    pub fn node_ys(&self) -> Vec<f64> {
        self.inner
            .geometry()
            .map_or_else(Vec::new, |g| g.node_ys.clone())
    }

    /// Patch-centre columns (frame px) of the residual grid.
    #[wasm_bindgen(js_name = nodeXs)]
    pub fn node_xs(&self) -> Vec<f64> {
        self.inner
            .geometry()
            .map_or_else(Vec::new, |g| g.node_xs.clone())
    }

    /// The current band-passed template of the registration region.
    pub fn template(&self) -> Vec<f32> {
        self.inner.template().map_or_else(Vec::new, |t| t.to_vec())
    }
}
