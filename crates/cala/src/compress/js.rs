//! wasm-bindgen surface of the compression, for a Web Worker.
//!
//! The worker keeps a window of frames as `Int16Array` (`quantizeFrames`),
//! cuts it into tiles and hands each tile to `TileCompressor.compress`, so
//! only one tile at a time is copied into the WASM heap.

use wasm_bindgen::prelude::*;

use super::{compress_tile, quantize, CompressConfig, TileFactors};

fn js_err(func: &str, e: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

/// `out[i] = round(frames[i] * quant)` in `i16` (non-finite values count as 0).
#[wasm_bindgen(js_name = quantizeFrames)]
pub fn quantize_frames(frames: &[f32], quant: f32, out: &mut [i16]) -> Result<(), JsError> {
    if frames.len() != out.len() {
        return Err(js_err(
            "quantizeFrames",
            format!("{} values in, {} out", frames.len(), out.len()),
        ));
    }
    if !(quant.is_finite() && quant > 0.0) {
        return Err(js_err("quantizeFrames", "quant must be positive"));
    }
    for (o, &v) in out.iter_mut().zip(frames) {
        *o = quantize(v, quant);
    }
    Ok(())
}

/// Compresses one tile of one window at a time.
#[wasm_bindgen(js_name = TileCompressor)]
pub struct JsTileCompressor {
    cfg: CompressConfig,
}

#[wasm_bindgen(js_class = TileCompressor)]
impl JsTileCompressor {
    /// `quant`: the scale of the quantized frames (`quantizeFrames`).
    #[wasm_bindgen(constructor)]
    pub fn new(quant: f32) -> Result<JsTileCompressor, JsError> {
        console_error_panic_hook::set_once();
        if !(quant.is_finite() && quant > 0.0) {
            return Err(js_err("TileCompressor", "quant must be positive"));
        }
        Ok(JsTileCompressor {
            cfg: CompressConfig {
                quant,
                ..CompressConfig::default()
            },
        })
    }

    /// Starting and largest rank of a tile.
    #[wasm_bindgen(js_name = setRank)]
    pub fn set_rank(&mut self, k0: u32, max_rank: u32) -> Result<(), JsError> {
        if k0 == 0 || max_rank < k0 {
            return Err(js_err("setRank", "need 1 <= k0 <= maxRank"));
        }
        self.cfg.k0 = k0 as usize;
        self.cfg.max_rank = max_rank as usize;
        Ok(())
    }

    /// `raw`: `frames x pixels` quantized values of one tile, a frame per row.
    pub fn compress(
        &self,
        raw: &[i16],
        frames: u32,
        pixels: u32,
        seed: u32,
    ) -> Result<JsTileFactors, JsError> {
        let (t, p) = (frames as usize, pixels as usize);
        if t < 2 || p < 2 || raw.len() != t * p {
            return Err(js_err(
                "compress",
                format!("{} values for {t} frames x {p} pixels", raw.len()),
            ));
        }
        Ok(JsTileFactors {
            inner: compress_tile(raw, t, p, &self.cfg, u64::from(seed)),
        })
    }
}

/// `Y ≈ mean · 1ᵀ + W · Vᵀ` of one tile.
#[wasm_bindgen(js_name = TileFactors)]
pub struct JsTileFactors {
    inner: TileFactors,
}

#[wasm_bindgen(js_class = TileFactors)]
impl JsTileFactors {
    #[wasm_bindgen(getter)]
    pub fn rank(&self) -> u32 {
        self.inner.rank as u32
    }

    /// Rank of the last randomized SVD (before the cut).
    #[wasm_bindgen(getter, js_name = svdRank)]
    pub fn svd_rank(&self) -> u32 {
        self.inner.svd_rank as u32
    }

    /// `Σ (y − mean)²` over the tile and the window, and the part kept.
    #[wasm_bindgen(getter)]
    pub fn energy(&self) -> f64 {
        self.inner.energy
    }

    #[wasm_bindgen(getter, js_name = keptEnergy)]
    pub fn kept_energy(&self) -> f64 {
        self.inner.kept_energy
    }

    /// `pixels x rank`, row-major.
    pub fn spatial(&self) -> Vec<f32> {
        self.inner.spatial.clone()
    }

    /// `frames x rank`, row-major.
    pub fn temporal(&self) -> Vec<f32> {
        self.inner.temporal.clone()
    }

    pub fn mean(&self) -> Vec<f32> {
        self.inner.mean.clone()
    }
}
