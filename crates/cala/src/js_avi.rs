//! wasm-bindgen surface of the AVI parser, for use from a Web Worker.
//!
//! Offsets and sizes cross the boundary as `f64` (exact below 2^53) instead of
//! `u64`, which wasm-bindgen would turn into `BigInt`.

use wasm_bindgen::prelude::*;

use crate::avi::{self, AviError};
use crate::js_util::{init_panic_hook, js_err};

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
    ///
    /// `file_size` (0 = unknown) bounds the frame count of an index-less file,
    /// so a recording cut short by a crash yields exactly its complete frames.
    pub fn parse(
        prefix: &[u8],
        idx1: Option<Vec<u8>>,
        file_size: f64,
    ) -> Result<JsAviHeader, JsError> {
        init_panic_hook();
        let size = if file_size.is_finite() && file_size > 0.0 {
            file_size as u64
        } else {
            0
        };
        avi::AviHeader::parse_with_size(prefix, idx1.as_deref(), size)
            .map(|inner| JsAviHeader { inner })
            .map_err(|e| js_err("AviHeader.parse", e))
    }

    /// `[riffEnd, moviEnd]` from the header alone (moviEnd is 0 when the movi
    /// size is unknown), to locate the `idx1` chunk before choosing offsets.
    pub fn layout(prefix: &[u8]) -> Result<Vec<f64>, JsError> {
        init_panic_hook();
        avi::AviHeader::parse_header(prefix)
            .map(|l| vec![l.info.riff_end as f64, l.info.movi_end as f64])
            .map_err(|e| js_err("AviHeader.layout", e))
    }

    /// Bytes a retry needs when `parse` threw "need more data"; 0 otherwise.
    #[wasm_bindgen(js_name = neededBytes)]
    pub fn needed_bytes(prefix: &[u8]) -> f64 {
        match avi::AviHeader::parse_header(prefix) {
            Err(AviError::NeedMoreData { needed }) => needed as f64,
            _ => 0.0,
        }
    }

    /// Frames skipped because their idx1 entry had size 0 (dropped by the writer).
    #[wasm_bindgen(getter, js_name = skippedEmptyFrames)]
    pub fn skipped_empty_frames(&self) -> u32 {
        self.inner.skipped_empty_frames()
    }

    /// How many frames from `start` (at most `max`) are stored back to back.
    #[wasm_bindgen(js_name = contiguousRun)]
    pub fn contiguous_run(&self, start: u32, max: u32) -> u32 {
        self.inner.contiguous_run(start, max)
    }

    /// `[start, end)` file byte range of `count` contiguous frames.
    #[wasm_bindgen(js_name = spanByteRange)]
    pub fn span_byte_range(&self, start: u32, count: u32) -> Result<Vec<f64>, JsError> {
        self.inner
            .span_range(start, count)
            .map(|(s, e)| vec![s as f64, e as f64])
            .map_err(|e| js_err("AviHeader.spanByteRange", e))
    }

    /// Decode a span read from `spanByteRange` into `out` (`count` frames
    /// of `width * height` pixels at the file's bytes per pixel, row padding
    /// stripped), one validated chunk after another, with no allocation per
    /// frame.
    #[wasm_bindgen(js_name = decodeSpanInto)]
    pub fn decode_span_into(&self, span: &[u8], count: u32, out: &mut [u8]) -> Result<(), JsError> {
        self.inner
            .decode_span_into(span, count, out)
            .map_err(|e| js_err("AviHeader.decodeSpanInto", e))
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
    #[wasm_bindgen(getter, js_name = bottomUp)]
    pub fn bottom_up(&self) -> bool {
        self.inner.info().bottom_up
    }
    /// Declared microseconds per frame. Often wrong; never use for timing.
    #[wasm_bindgen(getter, js_name = declaredUsecPerFrame)]
    pub fn declared_usec_per_frame(&self) -> u32 {
        self.inner.info().declared_usec_per_frame
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
