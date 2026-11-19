//! wasm-bindgen surface of the compression, for a Web Worker.
//!
//! The worker quantizes each incoming batch of frames into tile order
//! (`quantizeTiles`, on the tiles of `tileLayout`) and appends it to the
//! window's file. A closed window is compressed tile by tile from that file:
//! each tile's frames go to `TileCompressor.compress`, so only one tile at a
//! time is copied into the WASM heap. The factor file is `factorHeader`, then
//! per tile a u32 byte length and `TileFactors.toBytes()`; `FactorWindow`
//! reads it back to rebuild frames, and `FactorExtractor` solves a library's
//! traces from it without rebuilding any.
//!
//! `HistoryReview` (see `review.rs`) keeps the factors of every window and
//! scans them a few grid rows per call, so its worker can read messages
//! between calls.

use std::sync::Arc;

use wasm_bindgen::prelude::*;

use super::blend::{grid_of, BlendLayout, Tiling};
use super::project::{FactorExtractor, WindowProjector};
use super::review::{
    candidates, candidates_to_wire, scan_band, scan_rows, KnownCell, ReviewConfig, SpotStats,
};
use super::{compress_tile, quantize_tiles, CompressConfig, TileFactors, WindowFactors};
use crate::preprocess::Dims;
use crate::trace::{Library, SolverConfig};

fn js_err(func: &str, e: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{func}: {e}"))
}

fn parse_tiling(func: &str, s: &str) -> Result<Tiling, JsError> {
    Tiling::parse(s)
        .ok_or_else(|| js_err(func, format!("tiling {s:?}: plain, overlap:N or offset")))
}

/// The frame size, tile edge and tiling of a call, checked.
fn checked(
    func: &str,
    width: u32,
    height: u32,
    tile: u32,
    tiling: &str,
) -> Result<(Dims, usize, Tiling), JsError> {
    let dims = Dims::new(width as usize, height as usize).map_err(|e| js_err(func, e))?;
    if tile < 2 {
        return Err(js_err(func, "tile must be at least 2"));
    }
    Ok((dims, tile as usize, parse_tiling(func, tiling)?))
}

/// Why a header with `tiles` records cannot describe this frame, if so.
fn header_mismatch(dims: Dims, tile: usize, tiling: Tiling, tiles: usize) -> Option<String> {
    let want = BlendLayout::tile_count(dims, tile, tiling);
    (tiles != want).then(|| format!("{tiles} tiles, {want} expected for this frame and tiling"))
}

/// The tiles of a tiling, `(x0, y0, w, h)` one after the other, in the order
/// `quantizeTiles` writes them and a factor file holds them.
#[wasm_bindgen(js_name = tileLayout)]
pub fn tile_layout(width: u32, height: u32, tile: u32, tiling: &str) -> Result<Vec<u32>, JsError> {
    let (dims, tile, tiling) = checked("tileLayout", width, height, tile, tiling)?;
    Ok(grid_of(dims, tile, tiling)
        .iter()
        .flat_map(|g| [g.0 as u32, g.1 as u32, g.2 as u32, g.3 as u32])
        .collect())
}

/// The header of a factor file (`WindowFactors::header_bytes`): the tile
/// records (`u32` byte length, then `TileFactors.toBytes()`) follow it.
#[wasm_bindgen(js_name = factorHeader)]
pub fn factor_header(
    width: u32,
    height: u32,
    tile: u32,
    tiling: &str,
    frames: u32,
    tiles: u32,
    start: f64,
) -> Result<Vec<u8>, JsError> {
    let (dims, tile, tiling) = checked("factorHeader", width, height, tile, tiling)?;
    if !(start.is_finite() && start >= 0.0) {
        return Err(js_err("factorHeader", "start must be a frame index"));
    }
    if let Some(e) = header_mismatch(dims, tile, tiling, tiles as usize) {
        return Err(js_err("factorHeader", e));
    }
    Ok(WindowFactors::header_bytes(
        dims,
        tile,
        tiling,
        frames as usize,
        tiles as usize,
        start as u64,
    ))
}

/// Quantize `count` frames into tile order: for each tile of the tiling
/// (`tileLayout`), its `count x pixels` values, a frame per row. A tile's
/// block of every batch of a window, one after the other, is the input of
/// `TileCompressor.compress`. `out` holds `count` times the pixels of all
/// tiles (more than the frames when tiles overlap).
#[wasm_bindgen(js_name = quantizeTiles)]
#[allow(clippy::too_many_arguments)]
pub fn quantize_tiles_js(
    frames: &[f32],
    count: u32,
    width: u32,
    height: u32,
    tile: u32,
    tiling: &str,
    quant: f32,
    out: &mut [i16],
) -> Result<(), JsError> {
    let (dims, tile, tiling) = checked("quantizeTiles", width, height, tile, tiling)?;
    let grid = grid_of(dims, tile, tiling);
    let total: usize = grid.iter().map(|g| g.2 * g.3).sum();
    let count = count as usize;
    if frames.len() != count * dims.pixels() || out.len() != count * total {
        return Err(js_err(
            "quantizeTiles",
            format!(
                "{} values in, {} out; {} and {} expected",
                frames.len(),
                out.len(),
                count * dims.pixels(),
                count * total
            ),
        ));
    }
    if !(quant.is_finite() && quant > 0.0) {
        return Err(js_err("quantizeTiles", "quant must be positive"));
    }
    quantize_tiles(frames, count, dims, &grid, quant, out);
    Ok(())
}

/// Compresses one tile of one window at a time.
#[wasm_bindgen(js_name = TileCompressor)]
pub struct JsTileCompressor {
    cfg: CompressConfig,
}

#[wasm_bindgen(js_class = TileCompressor)]
impl JsTileCompressor {
    /// `quant`: the scale of the quantized frames (`quantizeTiles`).
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
        if t < 2 || p < 1 || raw.len() != t * p {
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
    /// `bytes`: a whole factor file (`CALAFAC2`, or v1 `CALAFAC1`; see `WindowFactors::to_bytes`).
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

    /// Edge of the grid the tiles were cut on, px.
    #[wasm_bindgen(getter)]
    pub fn tile(&self) -> u32 {
        self.inner.tile as u32
    }

    /// `plain`, `overlap:N` or `offset`.
    #[wasm_bindgen(getter)]
    pub fn tiling(&self) -> String {
        self.inner.tiling.name()
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

/// Extract on factors: a library's traces from factor files, without
/// rebuilding a frame.
#[wasm_bindgen(js_name = FactorExtractor)]
pub struct JsFactorExtractor {
    inner: FactorExtractor,
    ids: Vec<u32>,
    /// The open window and the library's rows on it; they are replaced together.
    window: Option<(WindowFactors, WindowProjector)>,
    /// Signed traces of the last `solve` (empty while `setSigned` is off).
    signed: Vec<f32>,
}

#[wasm_bindgen(js_class = FactorExtractor)]
impl JsFactorExtractor {
    /// `library`: `TraceLibrary.toBytes()`. `tol` (noise units) and
    /// `max_sweeps`: 0 = defaults.
    #[wasm_bindgen(constructor)]
    pub fn new(library: &[u8], tol: f32, max_sweeps: u32) -> Result<JsFactorExtractor, JsError> {
        console_error_panic_hook::set_once();
        let lib = Library::from_bytes(library).map_err(|e| js_err("FactorExtractor", e))?;
        let mut cfg = SolverConfig::default();
        if tol > 0.0 {
            cfg.tol = tol;
        }
        if max_sweeps > 0 {
            cfg.max_sweeps = max_sweeps;
        }
        let ids = lib.ids().iter().map(|&v| v as u32).collect();
        let inner =
            FactorExtractor::new(Arc::new(lib), cfg).map_err(|e| js_err("FactorExtractor", e))?;
        Ok(JsFactorExtractor {
            inner,
            ids,
            window: None,
            signed: Vec::new(),
        })
    }

    /// Cell ids in trace order.
    pub fn ids(&self) -> Vec<u32> {
        self.ids.clone()
    }

    /// Also compute the signed (unclipped) traces (`TraceEngine.setSigned`);
    /// off by default. The traces themselves are the same either way.
    #[wasm_bindgen(js_name = setSigned)]
    pub fn set_signed(&mut self, on: bool) {
        self.inner.engine_mut().set_signed(on);
    }

    /// The signed traces of the last `solve`, laid out as its traces
    /// (`count x cells`, frame after frame): each trace plus the residual's
    /// projection on the cell. Empty unless `setSigned(true)`.
    #[wasm_bindgen(js_name = lastSigned)]
    pub fn last_signed(&self) -> Vec<f32> {
        self.signed.clone()
    }

    /// Read a factor file and prepare its solve; returns the window's frames.
    pub fn open(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        // A failed open leaves no window behind: `solve` then says so.
        self.window = None;
        let wf = WindowFactors::from_bytes(bytes)
            .ok_or_else(|| js_err("FactorExtractor.open", "truncated or corrupt factor file"))?;
        let proj = WindowProjector::new(self.inner.library(), &wf)
            .map_err(|e| js_err("FactorExtractor.open", e))?;
        let frames = wf.frames as u32;
        self.window = Some((wf, proj));
        Ok(frames)
    }

    /// Stream index of the open window's first frame (0 before `open`).
    #[wasm_bindgen(getter)]
    pub fn start(&self) -> f64 {
        self.window.as_ref().map_or(0.0, |w| w.0.start as f64)
    }

    /// Each cell's smallest valid share on the open window (1 = every support
    /// pixel had data in every frame), in trace order. An error with no
    /// window open.
    #[wasm_bindgen(js_name = minValid)]
    pub fn min_valid(&self) -> Result<Vec<f32>, JsError> {
        let Some((_, proj)) = self.window.as_ref() else {
            return Err(js_err("FactorExtractor.minValid", "no window is open"));
        };
        Ok(proj.min_valid().to_vec())
    }

    /// Solve frames `t0..t0 + count` of the open window; returns
    /// `count x cells` traces, frame after frame, in the library's id order.
    /// The traces carry no frame index: the first row is frame `t0` of the
    /// window, whose stream index is `start + t0`.
    pub fn solve(&mut self, t0: u32, count: u32) -> Result<Vec<f32>, JsError> {
        self.signed.clear();
        let signed_on = self.inner.engine_mut().signed();
        let Some((wf, proj)) = self.window.as_ref() else {
            return Err(js_err("FactorExtractor.solve", "no window is open"));
        };
        // Checked here too so that a wild `count` never sizes the buffer.
        let end = (t0 as usize).saturating_add(count as usize);
        if end > wf.frames {
            return Err(js_err(
                "FactorExtractor.solve",
                format!("frames {t0}..{end} of {}", wf.frames),
            ));
        }
        let Some(len) = (count as usize).checked_mul(self.ids.len()) else {
            return Err(js_err(
                "FactorExtractor.solve",
                format!("{count} frames of {} cells", self.ids.len()),
            ));
        };
        let mut out = Vec::with_capacity(len);
        let mut signed = Vec::with_capacity(if signed_on { len } else { 0 });
        self.inner
            .solve(wf, proj, t0 as usize, count as usize, |tr| {
                out.extend_from_slice(&tr.traces);
                if signed_on {
                    signed.extend_from_slice(&tr.signed);
                }
            })
            .map_err(|e| js_err("FactorExtractor.solve", e))?;
        self.signed = signed;
        Ok(out)
    }
}

/// The history review reads side-by-side tiles only; a blended tiling is refused.
fn ensure_plain(w: &WindowFactors) -> Result<(), String> {
    if w.tiling == Tiling::Plain {
        Ok(())
    } else {
        Err(format!(
            "the review reads plain tiles, this window is {}",
            w.tiling.name()
        ))
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
    /// (`CALAFAC2`, or v1 `CALAFAC1`). Not while a review runs. Returns the windows held.
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
        ensure_plain(&w).map_err(|e| js_err("addWindow", e))?;
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

    /// Bytes of the factors held: every array of every tile
    /// ([`WindowFactors::bytes`]), the per-pixel `discarded` and `valid`
    /// included.
    #[wasm_bindgen(getter, js_name = factorBytes)]
    pub fn factor_bytes(&self) -> f64 {
        self.windows.iter().map(WindowFactors::bytes).sum::<usize>() as f64
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

#[cfg(test)]
mod tests {
    use super::*;

    fn window(tiling: Tiling) -> WindowFactors {
        let dims = Dims::new(8, 8).unwrap();
        let cfg = CompressConfig {
            tile: 4,
            window: 3,
            k0: 1,
            tiling,
            ..CompressConfig::default()
        };
        let mut wc = super::super::WindowCompressor::new(dims, cfg);
        let mut out = None;
        for t in 0..3 {
            out = wc.push(&[t as f32; 64]);
        }
        out.expect("a full window")
    }

    #[test]
    fn a_header_must_count_the_tiles_of_its_tiling() {
        let dims = Dims::new(40, 24).unwrap();
        for tiling in [Tiling::Plain, Tiling::Offset] {
            let n = BlendLayout::tile_count(dims, 16, tiling);
            assert!(header_mismatch(dims, 16, tiling, n).is_none());
            assert!(header_mismatch(dims, 16, tiling, n + 1).is_some());
        }
    }

    #[test]
    fn factor_bytes_counts_every_array_a_window_holds() {
        let w = window(Tiling::Plain);
        let mut review = JsHistoryReview::new(8, 8).unwrap();
        review.add_window(&w.to_bytes()).unwrap();
        review.add_window(&w.to_bytes()).unwrap();
        let per_window: usize = w
            .tiles
            .iter()
            .map(|t| 4 * (t.spatial.len() + t.temporal.len() + 3 * t.pixels()))
            .sum();
        assert_eq!(per_window, w.bytes());
        assert_eq!(review.factor_bytes(), (2 * per_window) as f64);
    }

    #[test]
    fn the_review_takes_plain_windows_only() {
        assert!(ensure_plain(&window(Tiling::Plain)).is_ok());
        let err = ensure_plain(&window(Tiling::Offset)).unwrap_err();
        assert!(err.contains("offset"), "{err}");
        assert!(ensure_plain(&window(Tiling::Overlap(2))).is_err());
    }
}
