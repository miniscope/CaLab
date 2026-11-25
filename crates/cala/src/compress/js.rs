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
use super::gpu::GpuTile;
use super::project::{never_valid_under, FactorExtractor, WindowProjector};
use super::review::{
    candidates, candidates_to_wire, scan_band, scan_rows, KnownCell, ReviewConfig, SpotStats,
};
use super::{
    chol_inv_upper, compress_tile, quantize, quantize_tiles, tile_config, CompressConfig,
    TileFactors, WindowFactors, WindowStats,
};
use crate::preprocess::Dims;
use crate::trace::{FrameTraces, Library, SolverConfig, TraceState};

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
    /// a frame per row. `prev_rank`: the rank this tile kept in the previous
    /// window (absent or 0: none), where its sketch starts (`k0_after`).
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
        prev_rank: Option<u32>,
    ) -> Result<JsTileFactors, JsError> {
        let (t, p) = (frames as usize, w as usize * h as usize);
        if t < 2 || p < 1 || raw.len() != t * p {
            return Err(js_err(
                "compress",
                format!("{} values for {t} frames x {p} pixels", raw.len()),
            ));
        }
        let cfg = tile_config(&self.cfg, prev_rank.map(|r| r as usize));
        let mut inner = compress_tile(raw, t, p, &cfg, u64::from(seed));
        (inner.x0, inner.y0, inner.w, inner.h) = (x0 as usize, y0 as usize, w as usize, h as usize);
        Ok(JsTileFactors { inner })
    }
}

fn check_quant(func: &str, quant: f32) -> Result<(), JsError> {
    if quant.is_finite() && quant > 0.0 {
        Ok(())
    } else {
        Err(js_err(func, "quant must be positive"))
    }
}

/// Exact per-pixel sums of a window's quantized frames (`quantizeFrames`),
/// in frame layout: the statistics a GPU-compressed window's tiles start from.
#[wasm_bindgen(js_name = WindowStats)]
pub struct JsWindowStats {
    inner: WindowStats,
}

#[wasm_bindgen(js_class = WindowStats)]
impl JsWindowStats {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Result<JsWindowStats, JsError> {
        console_error_panic_hook::set_once();
        let dims =
            Dims::new(width as usize, height as usize).map_err(|e| js_err("WindowStats", e))?;
        Ok(JsWindowStats {
            inner: WindowStats::new(dims.width, dims.height),
        })
    }

    /// Add whole quantized frames, one after the other.
    pub fn push(&mut self, frames: &[i16]) -> Result<(), JsError> {
        let n = self.inner.pixels();
        if !frames.len().is_multiple_of(n) {
            return Err(js_err(
                "push",
                format!("{} values are not whole frames of {n} pixels", frames.len()),
            ));
        }
        self.inner.push(frames);
        Ok(())
    }

    /// Frames added since the last reset.
    pub fn frames(&self) -> u32 {
        self.inner.frames() as u32
    }

    pub fn reset(&mut self) {
        self.inner.reset()
    }

    /// Per frame pixel, the mean over the window's valid samples (0 where
    /// none): what the GPU subtracts.
    pub fn mean(&self, quant: f32) -> Result<Vec<f32>, JsError> {
        check_quant("mean", quant)?;
        Ok(self.inner.mean(quant))
    }
}

/// One tile of a window compressed on the GPU: `l`, `nIter` and `omega` say
/// what to sketch, `finish` takes the GPU's `Q` and `Bᵀ = Yᵀ Q`.
#[wasm_bindgen(js_name = GpuTileJob)]
pub struct JsGpuTileJob {
    inner: GpuTile,
}

#[wasm_bindgen(js_class = GpuTileJob)]
impl JsGpuTileJob {
    /// The tile `(x0, y0, w, h)` of the window in `stats`. `seed`: as for
    /// `TileCompressor.compress`. `prev_rank`: the rank this tile kept in the
    /// previous window (absent or 0: none).
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        stats: &JsWindowStats,
        quant: f32,
        x0: u32,
        y0: u32,
        w: u32,
        h: u32,
        seed: u32,
        prev_rank: Option<u32>,
    ) -> Result<JsGpuTileJob, JsError> {
        check_quant("GpuTileJob", quant)?;
        let (x0, y0, w, h) = (x0 as usize, y0 as usize, w as usize, h as usize);
        let (width, height) = stats.inner.size();
        if w == 0 || h == 0 || x0 + w > width || y0 + h > height {
            return Err(js_err(
                "GpuTileJob",
                format!("tile ({x0}, {y0}, {w}, {h}) outside the {width} x {height} frame"),
            ));
        }
        let t = stats.inner.frames();
        if t < 2 {
            return Err(js_err(
                "GpuTileJob",
                format!("{t} frames, at least 2 needed"),
            ));
        }
        let cfg = CompressConfig {
            quant,
            ..CompressConfig::default()
        };
        let s = stats.inner.tile(x0, y0, w, h, quant);
        let prev = prev_rank.filter(|&r| r > 0).map(|r| r as usize);
        Ok(JsGpuTileJob {
            inner: GpuTile::new(&cfg, s, (x0, y0, w, h), t, u64::from(seed), prev),
        })
    }

    /// Sketch columns of the current sketch.
    pub fn l(&self) -> u32 {
        self.inner.l() as u32
    }

    /// Power iterations of a sketch.
    #[wasm_bindgen(js_name = nIter)]
    pub fn n_iter(&self) -> u32 {
        self.inner.n_iter() as u32
    }

    /// The current sketch's `Ω` (`frames x l`, row-major).
    pub fn omega(&self) -> Vec<f32> {
        self.inner.omega()
    }

    /// The tile's bytes (`TileFactors.toBytes`), or `undefined` when the
    /// sketch grew (sketch again with the new `l` and `omega`). `q` is
    /// `w * h x stride`, `bt` is `frames x stride`, row-major, of which the
    /// first `l` columns are read.
    pub fn finish(
        &mut self,
        q: &[f32],
        bt: &[f32],
        stride: u32,
    ) -> Result<Option<Vec<u8>>, JsError> {
        let (stride, l) = (stride as usize, self.inner.l());
        let (p, t) = self.inner.dims();
        if stride < l || q.len() != p * stride || bt.len() != t * stride {
            return Err(js_err(
                "finish",
                format!(
                    "q {} and bt {} values with stride {stride}; {} and {} with stride >= {l} expected",
                    q.len(),
                    bt.len(),
                    p * stride,
                    t * stride
                ),
            ));
        }
        if self.inner.finished() {
            return Err(js_err("finish", "the tile is already finished"));
        }
        Ok(self.inner.finish(q, bt, stride))
    }

    /// The rank the finished tile kept (0 before).
    pub fn rank(&self) -> u32 {
        self.inner.rank() as u32
    }
}

/// CholeskyQR's `R⁻¹` for a batch: `g` holds `ls.length` Gram matrices of
/// `stride x stride` (row-major, the first `ls[i] x ls[i]` read); returns as
/// many `R⁻¹` blocks, zero outside `ls[i] x ls[i]`. Errors if one is not
/// positive definite after the diagonal shifts.
///
/// No production caller: the GPU compressor computes `R⁻¹` with its WGSL
/// `CHOL` kernel; this is that kernel's reference rule, used in tests.
#[wasm_bindgen(js_name = cholInvUpperBatch)]
pub fn chol_inv_upper_batch(g: &[f32], stride: u32, ls: &[u32]) -> Result<Vec<f32>, JsError> {
    let s = stride as usize;
    if s == 0 || g.len() != ls.len() * s * s || ls.iter().any(|&l| l as usize > s) {
        return Err(js_err(
            "cholInvUpperBatch",
            format!(
                "{} values for {} blocks of {s} x {s}, each l <= {s}",
                g.len(),
                ls.len()
            ),
        ));
    }
    let mut out = Vec::with_capacity(g.len());
    for (i, (block, &l)) in g.chunks_exact(s * s).zip(ls).enumerate() {
        let r = chol_inv_upper(block, s, l as usize).ok_or_else(|| {
            js_err(
                "cholInvUpperBatch",
                format!("block {i} is not positive definite"),
            )
        })?;
        out.extend_from_slice(&r);
    }
    Ok(out)
}

/// Frames quantized as `WindowCompressor` buffers them (`quantize`: a
/// non-finite pixel is a missing sample).
#[wasm_bindgen(js_name = quantizeFrames)]
pub fn quantize_frames(frames: &[f32], quant: f32) -> Result<Vec<i16>, JsError> {
    check_quant("quantizeFrames", quant)?;
    Ok(frames.iter().map(|&v| quantize(v, quant)).collect())
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

    /// 1 for each pixel with no valid sample in any frame of the window (a
    /// rebuilt frame reads its window mean there; the live frame had NaN).
    #[wasm_bindgen(js_name = neverValid)]
    pub fn never_valid(&self) -> Vec<u8> {
        self.inner.never_valid().into_iter().map(u8::from).collect()
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
/// rebuilding a frame. A window whose pixels without data lie under a
/// functional (`neverValidUnder`) is solved on frames instead (`solveFrames`),
/// with the same engine.
#[wasm_bindgen(js_name = FactorExtractor)]
pub struct JsFactorExtractor {
    inner: FactorExtractor,
    ids: Vec<u32>,
    /// The open window and the library's rows on it; they are replaced together.
    window: Option<(WindowFactors, WindowProjector)>,
    /// The open window has a pixel without data under a functional.
    never: bool,
    /// The signed traces of the last solve (empty unless `setSigned(true)`).
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
            never: false,
            signed: Vec::new(),
        })
    }

    /// Cell ids in trace order.
    pub fn ids(&self) -> Vec<u32> {
        self.ids.clone()
    }

    /// Also compute the signed (unclipped) traces (`lastSigned`).
    #[wasm_bindgen(js_name = setSigned)]
    pub fn set_signed(&mut self, on: bool) {
        self.inner.engine_mut().set_signed(on);
    }

    /// Start the next frame's solve cold, as a new extractor would.
    #[wasm_bindgen(js_name = coldStart)]
    pub fn cold_start(&mut self) -> Result<(), JsError> {
        self.inner
            .engine_mut()
            .restore(&TraceState::default())
            .map_err(|e| js_err("FactorExtractor.coldStart", e))
    }

    /// Read a factor file and prepare its solve; returns the window's frames.
    pub fn open(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        // A failed open leaves no window behind: `solve` then says so.
        self.window = None;
        let wf = WindowFactors::from_bytes(bytes)
            .ok_or_else(|| js_err("FactorExtractor.open", "truncated or corrupt factor file"))?;
        let proj = WindowProjector::new(self.inner.library(), &wf)
            .map_err(|e| js_err("FactorExtractor.open", e))?;
        self.never = never_valid_under(self.inner.library(), &wf);
        let frames = wf.frames as u32;
        self.window = Some((wf, proj));
        Ok(frames)
    }

    /// The open window has a pixel without data under a cell, its moat, a ring
    /// or a basis map: solve it on rebuilt frames (`solveFrames`).
    #[wasm_bindgen(js_name = neverValidUnder)]
    pub fn never_valid_under(&self) -> bool {
        self.never
    }

    /// Stream index of the open window's first frame (0 before `open`).
    #[wasm_bindgen(getter)]
    pub fn start(&self) -> f64 {
        self.window.as_ref().map_or(0.0, |w| w.0.start as f64)
    }

    /// Solve frames `t0..t0 + count` of the open window; returns
    /// `count x cells` traces, frame after frame, in the library's id order.
    /// The traces carry no frame index: the first row is frame `t0` of the
    /// window, whose stream index is `start + t0`.
    pub fn solve(&mut self, t0: u32, count: u32) -> Result<Vec<f32>, JsError> {
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
        let signed = &mut self.signed;
        signed.clear();
        self.inner
            .solve(wf, proj, t0 as usize, count as usize, |tr| {
                out.extend_from_slice(&tr.traces);
                signed.extend_from_slice(&tr.signed);
            })
            .map_err(|e| js_err("FactorExtractor.solve", e))?;
        Ok(out)
    }

    /// Solve `count` frames (`count x pixels`, frame after frame; NaN for a
    /// missing pixel) with the same engine, its missing-pixel fill included.
    #[wasm_bindgen(js_name = solveFrames)]
    pub fn solve_frames(&mut self, frames: &[f32], count: u32) -> Result<Vec<f32>, JsError> {
        let px = self.inner.library().dims().pixels();
        let Some(n) = (count as usize)
            .checked_mul(px)
            .filter(|&n| n == frames.len())
        else {
            return Err(js_err(
                "FactorExtractor.solveFrames",
                format!("{} values for {count} frames of {px} pixels", frames.len()),
            ));
        };
        let mut out = Vec::with_capacity((count as usize).saturating_mul(self.ids.len()));
        self.signed.clear();
        let mut tr = FrameTraces::default();
        for frame in frames[..n].chunks(px) {
            self.inner
                .engine_mut()
                .process_into(frame, &mut tr)
                .map_err(|e| js_err("FactorExtractor.solveFrames", e))?;
            out.extend_from_slice(&tr.traces);
            self.signed.extend_from_slice(&tr.signed);
        }
        Ok(out)
    }

    /// The signed (unclipped) traces of the last `solve` or `solveFrames`,
    /// laid out as its traces (empty unless `setSigned(true)`).
    #[wasm_bindgen(js_name = lastSigned)]
    pub fn last_signed(&self) -> Vec<f32> {
        self.signed.clone()
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
