//! wasm-bindgen surface of the compression, for a Web Worker.
//!
//! The worker keeps a window of frames as `Int16Array` (`quantizeFrames`),
//! cuts it into tiles and hands each tile to `TileCompressor.compress`, so
//! only one tile at a time is copied into the WASM heap.
//!
//! `HistoryReview` (see `review.rs`) keeps the factors of every window and
//! scans them a few grid rows per call, so its worker can read messages
//! between calls.

use wasm_bindgen::prelude::*;

use super::review::{
    candidates, candidates_to_wire, scan_band, scan_rows, KnownCell, ReviewConfig, SpotStats,
};
use super::{compress_tile, quantize, quantize_tiles, CompressConfig, TileFactors, WindowFactors};
use crate::preprocess::Dims;
use crate::trace::Library;

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

/// Quantize `count` frames into tile order: for each tile (row by row over
/// the frame, `tile` px squares, smaller at the right and bottom edge), its
/// `count x pixels` values, a frame per row. A tile's block of every batch
/// of a window, one after the other, is the input of
/// `TileCompressor.compress`.
#[wasm_bindgen(js_name = quantizeTiles)]
pub fn quantize_tiles_js(
    frames: &[f32],
    count: u32,
    width: u32,
    height: u32,
    tile: u32,
    quant: f32,
    out: &mut [i16],
) -> Result<(), JsError> {
    let dims =
        Dims::new(width as usize, height as usize).map_err(|e| js_err("quantizeTiles", e))?;
    let n = count as usize * dims.pixels();
    if frames.len() != n || out.len() != n {
        return Err(js_err(
            "quantizeTiles",
            format!(
                "{} values in, {} out, {n} expected",
                frames.len(),
                out.len()
            ),
        ));
    }
    if tile == 0 || !(quant.is_finite() && quant > 0.0) {
        return Err(js_err("quantizeTiles", "tile and quant must be positive"));
    }
    quantize_tiles(frames, count as usize, dims, tile as usize, quant, out);
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

    /// `raw`: `frames x (w * h)` quantized values of the tile at `(x0, y0)`,
    /// a frame per row.
    #[allow(clippy::too_many_arguments)]
    pub fn compress(
        &self,
        raw: &[i16],
        frames: u32,
        x0: u32,
        y0: u32,
        w: u32,
        h: u32,
        seed: u32,
    ) -> Result<JsTileFactors, JsError> {
        let (t, p) = (frames as usize, w as usize * h as usize);
        if t < 2 || p < 2 || raw.len() != t * p {
            return Err(js_err(
                "compress",
                format!("{} values for {t} frames x {p} pixels", raw.len()),
            ));
        }
        let mut inner = compress_tile(raw, t, p, &self.cfg, u64::from(seed));
        (inner.x0, inner.y0, inner.w, inner.h) = (x0 as usize, y0 as usize, w as usize, h as usize);
        Ok(JsTileFactors { inner })
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

    /// The factors as bytes (`TileFactors::to_bytes`), for a file.
    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.inner.to_bytes()
    }
}

/// A compressed window read back from its factor file, to rebuild frames.
#[wasm_bindgen(js_name = FactorWindow)]
pub struct JsFactorWindow {
    inner: WindowFactors,
}

#[wasm_bindgen(js_class = FactorWindow)]
impl JsFactorWindow {
    /// `bytes`: a whole factor file (`CALAFAC1`, see `WindowFactors::to_bytes`).
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<JsFactorWindow, JsError> {
        console_error_panic_hook::set_once();
        WindowFactors::from_bytes(bytes)
            .map(|inner| JsFactorWindow { inner })
            .ok_or_else(|| js_err("FactorWindow.fromBytes", "truncated or corrupt factor file"))
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.dims.width as u32
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.dims.height as u32
    }

    #[wasm_bindgen(getter)]
    pub fn frames(&self) -> u32 {
        self.inner.frames as u32
    }

    /// Stream index of the window's first frame.
    #[wasm_bindgen(getter)]
    pub fn start(&self) -> f64 {
        self.inner.start as f64
    }

    /// Frames `t0..t0 + count` of the window rebuilt into `out`
    /// (`count * width * height` values, frame after frame).
    pub fn reconstruct(&self, t0: u32, count: u32, out: &mut [f32]) -> Result<(), JsError> {
        let (t0, count) = (t0 as usize, count as usize);
        let px = self.inner.dims.pixels();
        if t0 + count > self.inner.frames || out.len() != count * px {
            return Err(js_err(
                "reconstruct",
                format!(
                    "frames {t0}..{} of {}, {} values out",
                    t0 + count,
                    self.inner.frames,
                    out.len()
                ),
            ));
        }
        self.inner.reconstruct_range(t0, count, out);
        Ok(())
    }
}

/// A review in progress: the library's cells, the grid rows and the spots
/// scanned so far.
struct ReviewRun {
    cells: Vec<(Vec<u32>, Vec<f32>)>,
    rows: Vec<usize>,
    next: usize,
    stats: Vec<SpotStats>,
}

fn known(cells: &[(Vec<u32>, Vec<f32>)]) -> Vec<KnownCell<'_>> {
    cells
        .iter()
        .map(|(pix, val)| KnownCell { pix, val })
        .collect()
}

/// The history review (`compress::review`) for a Web Worker: holds the
/// factors of every compressed window of the session and looks for cells the
/// library lacks. One review is `begin`, `scan` until it returns 0, `finish`.
#[wasm_bindgen(js_name = HistoryReview)]
pub struct JsHistoryReview {
    dims: Dims,
    cfg: ReviewConfig,
    windows: Vec<WindowFactors>,
    run: Option<ReviewRun>,
}

#[wasm_bindgen(js_class = HistoryReview)]
impl JsHistoryReview {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Result<JsHistoryReview, JsError> {
        console_error_panic_hook::set_once();
        let dims =
            Dims::new(width as usize, height as usize).map_err(|e| js_err("HistoryReview", e))?;
        Ok(JsHistoryReview {
            dims,
            cfg: ReviewConfig::default(),
            windows: Vec::new(),
            run: None,
        })
    }

    /// Add the next window, in stream order: a whole factor file
    /// (`CALAFAC1`). Not while a review runs. Returns the windows held.
    #[wasm_bindgen(js_name = addWindow)]
    pub fn add_window(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        if self.run.is_some() {
            return Err(js_err("addWindow", "a review is running"));
        }
        let w = WindowFactors::from_bytes(bytes)
            .ok_or_else(|| js_err("addWindow", "truncated or corrupt factor file"))?;
        if w.dims != self.dims {
            return Err(js_err("addWindow", "window of another frame size"));
        }
        self.windows.push(w);
        Ok(self.windows.len() as u32)
    }

    /// Forget the oldest window (to bound the memory of a long session).
    /// Not while a review runs.
    #[wasm_bindgen(js_name = dropOldest)]
    pub fn drop_oldest(&mut self) -> Result<(), JsError> {
        if self.run.is_some() {
            return Err(js_err("dropOldest", "a review is running"));
        }
        if !self.windows.is_empty() {
            self.windows.remove(0);
        }
        Ok(())
    }

    /// Windows held.
    #[wasm_bindgen(getter)]
    pub fn windows(&self) -> u32 {
        self.windows.len() as u32
    }

    /// Bytes of the factors held.
    #[wasm_bindgen(getter, js_name = factorBytes)]
    pub fn factor_bytes(&self) -> f64 {
        let values: usize = self
            .windows
            .iter()
            .flat_map(|w| &w.tiles)
            .map(|t| t.spatial.len() + t.temporal.len() + t.mean.len())
            .sum();
        (4 * values) as f64
    }

    /// Start a review against `library` (`TraceLibrary.toBytes()`; empty: no
    /// cells yet), whose cells are regressed out. Returns the grid rows to
    /// scan: 0 when the history is too short to review, and no review is
    /// then started.
    pub fn begin(&mut self, library: &[u8]) -> Result<u32, JsError> {
        let mut cells = Vec::new();
        if !library.is_empty() {
            let lib = Library::from_bytes(library).map_err(|e| js_err("begin", e))?;
            if lib.dims() != self.dims {
                return Err(js_err("begin", "library of another frame size"));
            }
            for slot in 0..lib.len() {
                let (pix, val) = lib.unfiltered(slot);
                cells.push((pix.to_vec(), val.to_vec()));
            }
        }
        let rows = scan_rows(&self.windows, self.dims, &self.cfg);
        let n = rows.len() as u32;
        self.run = (n > 0).then_some(ReviewRun {
            cells,
            rows,
            next: 0,
            stats: Vec::new(),
        });
        Ok(n)
    }

    /// Scan the next `rows` grid rows of the review; returns the rows left.
    pub fn scan(&mut self, rows: u32) -> Result<u32, JsError> {
        let Some(run) = self.run.as_mut() else {
            return Err(js_err("scan", "no review is running"));
        };
        let end = run.rows.len().min(run.next + rows.max(1) as usize);
        let band = scan_band(
            &self.windows,
            &known(&run.cells),
            self.dims,
            &self.cfg,
            &run.rows[run.next..end],
        );
        run.stats.extend(band);
        run.next = end;
        Ok((run.rows.len() - end) as u32)
    }

    /// End the review: the candidates of the spots scanned, per candidate
    /// `[y0, x0, height, width, gain_z, events_z]` then its footprint's
    /// `height * width` values (peak 1). `SlowLoop.addReviewed` takes this
    /// array.
    pub fn finish(&mut self) -> Result<Vec<f32>, JsError> {
        let Some(run) = self.run.take() else {
            return Err(js_err("finish", "no review is running"));
        };
        let found = candidates(&run.stats, &known(&run.cells), self.dims, &self.cfg);
        Ok(candidates_to_wire(&found))
    }

    /// Drop a review in progress.
    pub fn cancel(&mut self) {
        self.run = None;
    }
}
