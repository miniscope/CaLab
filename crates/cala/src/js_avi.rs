//! wasm-bindgen surface of the AVI parser, for use from a Web Worker.
//!
//! Offsets and sizes cross the boundary as `f64` (exact below 2^53) instead of
//! `u64`, which wasm-bindgen would turn into `BigInt`.

use wasm_bindgen::prelude::*;

use crate::avi::{self, AviError};

fn js_err(func: &str, e: AviError) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

/// Parsed AVI header and frame offset table.
#[wasm_bindgen(js_name = AviHeader)]
pub struct JsAviHeader {
    inner: avi::AviHeader,
}

#[wasm_bindgen(js_class = AviHeader)]
impl JsAviHeader {
    /// Parse a file prefix and, optionally, the `idx1` payload. Throws with a
    /// message starting `need more data` when the prefix is too short (see
    /// `neededBytes`).
    pub fn parse(prefix: &[u8], idx1: Option<Vec<u8>>) -> Result<JsAviHeader, JsError> {
        console_error_panic_hook::set_once();
        avi::AviHeader::parse(prefix, idx1.as_deref())
            .map(|inner| JsAviHeader { inner })
            .map_err(|e| js_err("AviHeader.parse", e))
    }

    /// Bytes a retry needs when `parse` threw "need more data"; 0 otherwise.
    #[wasm_bindgen(js_name = neededBytes)]
    pub fn needed_bytes(prefix: &[u8]) -> f64 {
        match avi::AviHeader::parse(prefix, None) {
            Err(AviError::NeedMoreData { needed }) => needed as f64,
            _ => 0.0,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.info().width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.info().height
    }
    #[wasm_bindgen(getter, js_name = bitDepth)]
    pub fn bit_depth(&self) -> u32 {
        self.inner.info().bit_depth
    }
    #[wasm_bindgen(getter)]
    pub fn fourcc(&self) -> String {
        self.inner.info().fourcc.clone()
    }
    #[wasm_bindgen(getter, js_name = frameCount)]
    pub fn frame_count(&self) -> u32 {
        self.inner.frame_count()
    }
    /// Chunk payload bytes per frame, row padding included.
    #[wasm_bindgen(getter, js_name = frameBytes)]
    pub fn frame_bytes(&self) -> u32 {
        self.inner.info().frame_bytes
    }
    #[wasm_bindgen(getter, js_name = rowStride)]
    pub fn row_stride(&self) -> u32 {
        self.inner.info().row_stride
    }
    #[wasm_bindgen(getter, js_name = bottomUp)]
    pub fn bottom_up(&self) -> bool {
        self.inner.info().bottom_up
    }
    /// Declared microseconds per frame. Often wrong; never use for timing.
    #[wasm_bindgen(getter, js_name = declaredUsecPerFrame)]
    pub fn declared_usec_per_frame(&self) -> u32 {
        self.inner.info().declared_usec_per_frame
    }
    #[wasm_bindgen(getter, js_name = moviOffset)]
    pub fn movi_offset(&self) -> f64 {
        self.inner.info().movi_offset as f64
    }
    #[wasm_bindgen(getter, js_name = firstChunkOffset)]
    pub fn first_chunk_offset(&self) -> f64 {
        self.inner.info().first_chunk_offset as f64
    }
    /// File offset where the `idx1` chunk header would start (0 if unknown).
    #[wasm_bindgen(getter, js_name = moviEnd)]
    pub fn movi_end(&self) -> f64 {
        self.inner.info().movi_end as f64
    }
    #[wasm_bindgen(getter, js_name = riffEnd)]
    pub fn riff_end(&self) -> f64 {
        self.inner.info().riff_end as f64
    }
    #[wasm_bindgen(getter, js_name = hasIdx1)]
    pub fn has_idx1(&self) -> bool {
        self.inner.info().has_idx1
    }
    #[wasm_bindgen(getter, js_name = idx1Absolute)]
    pub fn idx1_absolute(&self) -> bool {
        self.inner.info().idx1_absolute
    }

    /// Return bottom-up frames top-down. Default false (matches OpenCV).
    #[wasm_bindgen(setter, js_name = flipBottomUp)]
    pub fn set_flip_bottom_up(&mut self, flip: bool) {
        self.inner.set_flip_bottom_up(flip);
    }
    #[wasm_bindgen(getter, js_name = flipBottomUp)]
    pub fn flip_bottom_up(&self) -> bool {
        self.inner.flip_bottom_up()
    }

    /// Drop frames that do not fit in a file of `file_size` bytes.
    #[wasm_bindgen(js_name = limitToFileSize)]
    pub fn limit_to_file_size(&mut self, file_size: f64) {
        if file_size.is_finite() && file_size >= 0.0 {
            self.inner.limit_to_file_size(file_size as u64);
        }
    }

    /// `[start, end)` file byte range of frame `index`'s chunk (header included).
    #[wasm_bindgen(js_name = frameByteRange)]
    pub fn frame_byte_range(&self, index: u32) -> Result<Vec<f64>, JsError> {
        self.inner
            .frame_range(index)
            .map(|(s, e)| vec![s as f64, e as f64])
            .map_err(|e| js_err("AviHeader.frameByteRange", e))
    }

    /// Validate a chunk read from `frameByteRange` and return the pixels with
    /// the row padding stripped (`width * height * bytes-per-pixel` bytes).
    #[wasm_bindgen(js_name = decodeFrame)]
    pub fn decode_frame(&self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner
            .decode_frame(chunk)
            .map_err(|e| js_err("AviHeader.decodeFrame", e))
    }
}

/// Payload length of the `idx1` chunk, from its 8-byte header (read at
/// `AviHeader.moviEnd`). Throws if the bytes are not an `idx1` header.
#[wasm_bindgen(js_name = aviIdx1PayloadLen)]
pub fn avi_idx1_payload_len(header: &[u8]) -> Result<u32, JsError> {
    avi::idx1_payload_len(header).map_err(|e| js_err("aviIdx1PayloadLen", e))
}

/// True when 12 bytes read at `riffEnd` begin an `AVIX` RIFF chunk (OpenDML).
#[wasm_bindgen(js_name = aviIsAvixContinuation)]
pub fn avi_is_avix_continuation(bytes: &[u8]) -> bool {
    avi::is_avix_continuation(bytes)
}
