//! Extract on factors: the linear functionals of a frame that the trace
//! solver reads, taken from a window's factors without rebuilding a frame.
//!
//! With the frame model of [`super::blend`],
//! `ŷ_t(p) = Σ_k b_k(p) (μ_k(p) + W_k(p, :) · v_k(t))`, a functional `f` (a
//! vector over pixels) of a frame is
//!
//! ```text
//! fᵀ ŷ_t = Σ_k (fᵀ diag(b_k) W_k) · v_k(t) + Σ_k fᵀ diag(b_k) μ_k
//! ```
//!
//! [`WindowProjector`] holds the row `fᵀ diag(b_k) W_k` of every functional
//! and tile it touches and the constant; a frame then costs `rank`
//! multiply-adds per row. The functionals are those of
//! [`crate::trace::TraceEngine::process_projected`]: each cell's filtered column (its
//! support part minus the moat's block means against the block sums over
//! the field of view), and the background model's (a dot product with each
//! map of a basis, a mean over each cell's ring).
//!
//! Missing samples: a factor window holds no missing pixel (a missing
//! sample is the pixel's mean over the window, [`super::TileFactors::valid`]
//! says how often), so nothing is filled per frame as
//! [`crate::trace::TraceEngine::process_into`] does. [`WindowProjector::min_valid`] tells
//! which cells that concerns.

// Index loops over cells and tiles read more clearly than zipped iterators here.
#![allow(clippy::needless_range_loop)]

use std::sync::Arc;

use super::WindowFactors;
use crate::trace::{BgTerms, FrameTraces, Library, SolverConfig, TraceEngine, TraceError};

/// The rows of the functionals that touch one tile.
struct TileRows {
    rank: usize,
    /// Functional indices (cells first, then the background's), in the order met.
    funcs: Vec<u32>,
    /// `funcs.len() x rank`, row-major.
    rows: Vec<f32>,
}

/// The solver's functionals of every frame of one window, for one library.
pub struct WindowProjector {
    library_version: u64,
    cells: usize,
    background: usize,
    frames: usize,
    /// Index of the window's first frame.
    start: u64,
    /// Per tile of the window: `(x0, y0, w, h, rank)`.
    geometry: Vec<(usize, usize, usize, usize, usize)>,
    /// The constant of every functional: `Σ_k fᵀ diag(b_k) μ_k`.
    offset: Vec<f32>,
    tiles: Vec<TileRows>,
    min_valid: Vec<f32>,
}

/// `[x0, y0, x1, y1]` (ends exclusive) around the pixels `pix` of a frame
/// `width` wide; no pixel gives a box that overlaps nothing.
fn bbox(pix: &[u32], width: usize) -> [usize; 4] {
    let mut b = [usize::MAX, usize::MAX, 0, 0];
    for &q in pix {
        let (y, x) = (q as usize / width, q as usize % width);
        b = [b[0].min(x), b[1].min(y), b[2].max(x + 1), b[3].max(y + 1)];
    }
    b
}

fn overlaps(b: &[usize; 4], g: (usize, usize, usize, usize)) -> bool {
    b[0] < g.0 + g.2 && g.0 < b[2] && b[1] < g.1 + g.3 && g.1 < b[3]
}

/// `row += w * src` and the same for the constant.
#[inline]
fn add_scaled(row: &mut [f32], c0: &mut f32, w: f32, src: &[f32], mean: f32) {
    *c0 += w * mean;
    for (o, &s) in row.iter_mut().zip(src) {
        *o += w * s;
    }
}

impl WindowProjector {
    /// The rows of `lib`'s functionals on the factors of `wf`. An error when
    /// the library's frame is not the window's.
    pub fn new(lib: &Library, wf: &WindowFactors) -> Result<WindowProjector, TraceError> {
        if lib.dims() != wf.dims {
            return Err(TraceError::InvalidConfig(format!(
                "library of {:?}, factors of {:?}",
                lib.dims(),
                wf.dims
            )));
        }
        let layout = wf.layout();
        let fits = layout.grid().len() == wf.tiles.len()
            && layout
                .grid()
                .iter()
                .zip(&wf.tiles)
                .all(|(g, t)| *g == (t.x0, t.y0, t.w, t.h));
        if !fits {
            return Err(TraceError::InvalidConfig(
                "the tiles of the factors do not fit their layout".into(),
            ));
        }
        let (n, n_bg) = (lib.len(), lib.background_len());
        let (width, height) = (wf.dims.width, wf.dims.height);
        let n_px = wf.dims.pixels();
        let fov = lib.fov();
        let (bs, gl) = (lib.block_px(), lib.grid_len());
        let gw = if bs > 0 { width.div_ceil(bs) } else { 0 };

        // Per cell: the box around its support and its moat's blocks, and around its ring.
        let cell_box: Vec<[usize; 4]> = (0..n)
            .map(|i| {
                let mut b = bbox(lib.core_col(i).0, width);
                for &blk in lib.lowpass(i).0 {
                    let (by, bx) = (blk as usize / gw, blk as usize % gw);
                    b = [
                        b[0].min(bx * bs),
                        b[1].min(by * bs),
                        b[2].max(((bx + 1) * bs).min(width)),
                        b[3].max(((by + 1) * bs).min(height)),
                    ];
                }
                b
            })
            .collect();
        let ring_box: Vec<[usize; 4]> = match &lib.bg {
            BgTerms::Ring {
                ring_start,
                ring_pix,
                ..
            } => (0..n)
                .map(|i| bbox(&ring_pix[ring_start[i]..ring_start[i + 1]], width))
                .collect(),
            _ => Vec::new(),
        };

        // Summed in float64 across tiles, as the frame route sums its basis terms.
        let mut offset = vec![0.0f64; n + n_bg];
        let mut min_valid = vec![1.0f32; n];
        let mut tiles = Vec::with_capacity(wf.tiles.len());
        // Reused per tile: the place of each moat block's sums, `u32::MAX` for none.
        let mut blk_slot = vec![u32::MAX; gl];
        for (tf, wt) in wf.tiles.iter().zip(layout.weights()) {
            let r = tf.rank;
            let g = (tf.x0, tf.y0, tf.w, tf.h);
            // Tile-local index of frame pixel `q`, if the tile covers it.
            let local = |q: u32| -> Option<usize> {
                let (y, x) = (q as usize / width, q as usize % width);
                (x >= g.0 && x < g.0 + g.2 && y >= g.1 && y < g.1 + g.3)
                    .then(|| (y - g.1) * g.2 + (x - g.0))
            };
            let spatial = |p: usize| &tf.spatial[p * r..(p + 1) * r];

            // The moat: the blended factors summed over each block's pixels in
            // the field of view, within this tile.
            let mut used: Vec<u32> = Vec::new();
            let mut blk_rows: Vec<f32> = Vec::new();
            let mut blk_mean: Vec<f32> = Vec::new();
            if gl > 0 {
                for y in 0..g.3 {
                    for x in 0..g.2 {
                        let q = (g.1 + y) * width + g.0 + x;
                        if fov[q] == 0 {
                            continue;
                        }
                        let blk = lib.block_of(q as u32);
                        if blk_slot[blk] == u32::MAX {
                            blk_slot[blk] = used.len() as u32;
                            used.push(blk as u32);
                            blk_rows.resize(blk_rows.len() + r, 0.0);
                            blk_mean.push(0.0);
                        }
                        let s = blk_slot[blk] as usize;
                        let p = y * g.2 + x;
                        add_scaled(
                            &mut blk_rows[s * r..(s + 1) * r],
                            &mut blk_mean[s],
                            wt[p],
                            spatial(p),
                            tf.mean[p],
                        );
                    }
                }
            }

            let mut funcs: Vec<u32> = Vec::new();
            let mut rows: Vec<f32> = Vec::new();
            let mut row = vec![0.0f32; r];
            for i in 0..n {
                if !overlaps(&cell_box[i], g) {
                    continue;
                }
                row.fill(0.0);
                let (mut c0, mut hit) = (0.0f32, false);
                let (pix, vc) = lib.core_col(i);
                for (&q, &a) in pix.iter().zip(vc) {
                    if let Some(p) = local(q) {
                        hit = true;
                        add_scaled(&mut row, &mut c0, a * wt[p], spatial(p), tf.mean[p]);
                        min_valid[i] = min_valid[i].min(tf.valid[p]);
                    }
                }
                let (blks, low) = lib.lowpass(i);
                for (&blk, &l) in blks.iter().zip(low) {
                    let s = blk_slot[blk as usize];
                    if s != u32::MAX {
                        hit = true;
                        let s = s as usize;
                        add_scaled(
                            &mut row,
                            &mut c0,
                            -l,
                            &blk_rows[s * r..(s + 1) * r],
                            blk_mean[s],
                        );
                    }
                }
                if hit {
                    funcs.push(i as u32);
                    rows.extend_from_slice(&row);
                    offset[i] += f64::from(c0);
                }
            }
            match &lib.bg {
                BgTerms::Basis { k, maps, .. } => {
                    for a in 0..*k {
                        let map = &maps[a * n_px..(a + 1) * n_px];
                        row.fill(0.0);
                        let mut c0 = 0.0f32;
                        for y in 0..g.3 {
                            for x in 0..g.2 {
                                let p = y * g.2 + x;
                                let w = map[(g.1 + y) * width + g.0 + x] * wt[p];
                                add_scaled(&mut row, &mut c0, w, spatial(p), tf.mean[p]);
                            }
                        }
                        funcs.push((n + a) as u32);
                        rows.extend_from_slice(&row);
                        offset[n + a] += f64::from(c0);
                    }
                }
                BgTerms::Ring {
                    ring_start,
                    ring_pix,
                    ..
                } => {
                    for i in 0..n {
                        if !overlaps(&ring_box[i], g) {
                            continue;
                        }
                        let px = &ring_pix[ring_start[i]..ring_start[i + 1]];
                        // Not empty: an empty ring's box overlaps nothing.
                        let inv = 1.0 / px.len() as f32;
                        row.fill(0.0);
                        let (mut c0, mut hit) = (0.0f32, false);
                        for &q in px {
                            if let Some(p) = local(q) {
                                hit = true;
                                add_scaled(&mut row, &mut c0, inv * wt[p], spatial(p), tf.mean[p]);
                            }
                        }
                        if hit {
                            funcs.push((n + i) as u32);
                            rows.extend_from_slice(&row);
                            offset[n + i] += f64::from(c0);
                        }
                    }
                }
                BgTerms::None => {}
            }
            for &blk in &used {
                blk_slot[blk as usize] = u32::MAX;
            }
            tiles.push(TileRows {
                rank: r,
                funcs,
                rows,
            });
        }
        Ok(WindowProjector {
            library_version: lib.version(),
            cells: n,
            background: n_bg,
            frames: wf.frames,
            start: wf.start,
            geometry: wf
                .tiles
                .iter()
                .map(|t| (t.x0, t.y0, t.w, t.h, t.rank))
                .collect(),
            offset: offset.into_iter().map(|v| v as f32).collect(),
            tiles,
            min_valid,
        })
    }

    /// Whether `wf` is the window this was built from (same start, length,
    /// tile rectangles and ranks). The check a caller makes once before
    /// projecting frames of `wf`.
    pub fn matches(&self, wf: &WindowFactors) -> bool {
        wf.start == self.start
            && wf.frames == self.frames
            && wf.tiles.len() == self.geometry.len()
            && wf
                .tiles
                .iter()
                .zip(&self.geometry)
                .all(|(t, g)| (t.x0, t.y0, t.w, t.h, t.rank) == *g)
    }

    /// The functionals of frame `t` (`0..frames`) of the window this was
    /// built from: `out` holds [`Self::functionals`] values, the cells'
    /// projections, then the background's.
    pub fn project(&self, wf: &WindowFactors, t: usize, out: &mut [f32]) {
        assert!(
            self.matches(wf),
            "the factors are not the window this projector was built from"
        );
        assert!(t < self.frames, "frame {t} of a window of {}", self.frames);
        assert_eq!(out.len(), self.functionals(), "wrong output length");
        out.copy_from_slice(&self.offset);
        for (rows, tf) in self.tiles.iter().zip(&wf.tiles) {
            let r = rows.rank;
            let v = &tf.temporal[t * r..(t + 1) * r];
            for (j, &f) in rows.funcs.iter().enumerate() {
                let mut s = 0.0f32;
                for (a, b) in rows.rows[j * r..(j + 1) * r].iter().zip(v) {
                    s += a * b;
                }
                out[f as usize] += s;
            }
        }
    }

    pub fn cells(&self) -> usize {
        self.cells
    }

    /// Number of background functionals ([`Library::background_len`]).
    pub fn background(&self) -> usize {
        self.background
    }

    pub fn functionals(&self) -> usize {
        self.cells + self.background
    }

    /// Version of the library this was built for. A library rebuilt with
    /// identical footprints has a new version, so its projector is rebuilt too.
    /// A library read from bytes keeps its stored version, and the version
    /// counter restarts in every process or WASM instance, so two libraries
    /// from different sessions can share a version; the check guards a library
    /// swap within one session.
    pub fn library_version(&self) -> u64 {
        self.library_version
    }

    /// Frames of the window this was built from.
    pub fn frames(&self) -> usize {
        self.frames
    }

    /// Per cell: the smallest share of the window's frames in which a pixel
    /// of its support was not missing (1: none of its pixels was ever missing).
    /// Only the support counts: a missing pixel in the moat or the ring is not
    /// seen here.
    pub fn min_valid(&self) -> &[f32] {
        &self.min_valid
    }
}

/// Extract on factors: solves a library's traces frame by frame from the
/// factors of a window, without rebuilding a frame.
pub struct FactorExtractor {
    engine: TraceEngine,
    /// One frame's functionals: the cells', then the background's; sized in
    /// `solve` from the engine's current library.
    vals: Vec<f32>,
    out: FrameTraces,
}

impl FactorExtractor {
    pub fn new(lib: Arc<Library>, cfg: SolverConfig) -> Result<FactorExtractor, TraceError> {
        Ok(FactorExtractor {
            engine: TraceEngine::new(lib, cfg)?,
            vals: Vec::new(),
            out: FrameTraces::default(),
        })
    }

    /// The solver, for its settings (`set_consolidated_ring_gradient`, `set_signed`).
    pub fn engine_mut(&mut self) -> &mut TraceEngine {
        &mut self.engine
    }

    pub fn library(&self) -> &Arc<Library> {
        self.engine.library()
    }

    /// Swap the library before the next frame (warm starts follow cell ids).
    /// A projector built before the swap is refused by `solve` (its library
    /// version differs); build a new one.
    pub fn set_library(&mut self, lib: Arc<Library>) -> Result<(), TraceError> {
        self.engine.set_library(lib)
    }

    /// Solve frames `t0..t0 + count` of `wf` with the rows of `proj` (built
    /// for this library and this window); `sink` gets each frame's result.
    ///
    /// `FrameTraces::frame_index` counts the frames this extractor has solved,
    /// not the stream index; the window's `start` gives the stream index.
    ///
    /// The checks run before any frame, so a refused call never calls `sink`
    /// and leaves the engine as it was. A solve that fails in frame `t` has
    /// called `sink` for the frames before it; the engine has advanced
    /// through them and stays usable (a rejected frame does not advance it).
    pub fn solve(
        &mut self,
        wf: &WindowFactors,
        proj: &WindowProjector,
        t0: usize,
        count: usize,
        mut sink: impl FnMut(&FrameTraces),
    ) -> Result<(), TraceError> {
        let lib = self.engine.library().clone();
        let n = lib.len();
        let functionals = n + lib.background_len();
        if !proj.matches(wf) {
            return Err(TraceError::InvalidConfig(
                "projector was built from another window".into(),
            ));
        }
        if proj.library_version() != lib.version()
            || proj.cells() != n
            || proj.functionals() != functionals
        {
            return Err(TraceError::InvalidConfig(format!(
                "projector of library {} ({} cells, {} functionals), engine library {} ({n}, {functionals})",
                proj.library_version(),
                proj.cells(),
                proj.functionals(),
                lib.version()
            )));
        }
        let Some(end) = t0.checked_add(count).filter(|&e| e <= wf.frames) else {
            return Err(TraceError::InvalidConfig(format!(
                "frames {t0}+{count} of a window of {}",
                wf.frames
            )));
        };
        self.vals.resize(functionals, 0.0);
        for t in t0..end {
            proj.project(wf, t, &mut self.vals);
            let (cells, background) = self.vals.split_at(n);
            self.engine
                .process_projected(cells, background, &mut self.out)?;
            sink(&self.out);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::blend::Tiling;
    use crate::compress::{CompressConfig, WindowCompressor};
    use crate::preprocess::flatten::{FlattenConfig, GlowFlattener};
    use crate::preprocess::fov::FovMask;
    use crate::preprocess::Dims;
    use crate::trace::{BackgroundModel, Footprint, LibraryBuilder};

    pub(super) const W: usize = 96;
    pub(super) const H: usize = 80;
    /// Centres `(y, x)`: inside a tile, on the line x = 64, on the line y = 64,
    /// on a crossing of the offset grid's lines (32, 32), near the right border.
    const CENTRES: [(usize, usize); 5] = [(20, 20), (30, 64), (64, 40), (32, 32), (50, 80)];

    pub(super) fn dims() -> Dims {
        Dims::new(W, H).unwrap()
    }

    fn footprint(id: u64, (cy, cx): (usize, usize)) -> Footprint {
        let r = 6usize;
        let mut values = Vec::new();
        for y in 0..2 * r + 1 {
            for x in 0..2 * r + 1 {
                let (dy, dx) = (y as f32 - r as f32, x as f32 - r as f32);
                values.push((-(dy * dy + dx * dx) / (2.0 * 2.2 * 2.2)).exp());
            }
        }
        Footprint {
            id,
            y0: cy - r,
            x0: cx - r,
            height: 2 * r + 1,
            width: 2 * r + 1,
            values,
        }
    }

    pub(super) fn models() -> Vec<BackgroundModel> {
        let map = (0..W * H)
            .map(|i| 0.6 + 0.4 * (i % W) as f32 / W as f32)
            .collect();
        vec![
            BackgroundModel::None,
            BackgroundModel::Basis(vec![map]),
            BackgroundModel::Ring {
                inner_px: 7.0,
                outer_px: 12.0,
            },
        ]
    }

    /// A library of `cells` of the centres on high-passed data (so with a moat).
    pub(super) fn library(model: BackgroundModel, cells: usize) -> Library {
        library_v(model, cells, 1)
    }

    pub(super) fn library_v(model: BackgroundModel, cells: usize, version: u64) -> Library {
        let cfg = FlattenConfig {
            cell_diameter_px: 4.0,
            ..FlattenConfig::default()
        };
        let mut flat = GlowFlattener::new(&FovMask::full(dims()), &cfg).unwrap();
        let mut b = LibraryBuilder::new(dims())
            .background(model)
            .version(version);
        for (i, &c) in CENTRES.iter().take(cells).enumerate() {
            b.push(footprint(i as u64, c));
        }
        b.build(&mut flat).unwrap()
    }

    /// A window of the cells with slow traces on a slowly changing floor and a
    /// little noise. `missing`: a pixel that is not finite in the first frames.
    pub(super) fn window(
        tiling: Tiling,
        frames: usize,
        missing: Option<(usize, usize)>,
    ) -> WindowFactors {
        let cfg = CompressConfig {
            window: frames,
            tiling,
            ..CompressConfig::default()
        };
        let mut wc = WindowCompressor::new(dims(), cfg);
        let fps: Vec<Footprint> = CENTRES
            .iter()
            .enumerate()
            .map(|(i, &c)| footprint(i as u64, c))
            .collect();
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut out = None;
        for t in 0..frames {
            let mut f = vec![0.0f32; W * H];
            for (i, v) in f.iter_mut().enumerate() {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let noise = (state >> 40) as f32 / (1u64 << 24) as f32 - 0.5;
                let slope = (i % W) as f32 / W as f32;
                *v = 20.0 + 2.0 * (t as f32 / 17.0).sin() * slope + 0.2 * noise;
            }
            for (k, fp) in fps.iter().enumerate() {
                let c = 6.0 * (1.0 + (t as f32 / (5.0 + k as f32)).sin());
                for y in 0..fp.height {
                    for x in 0..fp.width {
                        f[(fp.y0 + y) * W + fp.x0 + x] += c * fp.values[y * fp.width + x];
                    }
                }
            }
            if let Some((pixel, n)) = missing {
                if t < n {
                    f[pixel] = f32::NAN;
                }
            }
            out = wc.push(&f).or(out);
        }
        out.expect("a full window")
    }

    /// The functionals as `TraceEngine::process_into` computes them from a frame
    /// (full field of view), in float64, and the summed size of each one's terms.
    fn reference(lib: &Library, frame: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let bs = lib.block_px();
        let fov = lib.fov();
        let mut blocks = vec![0.0f64; lib.grid_len()];
        if bs > 0 {
            let gw = W.div_ceil(bs);
            for (y, row) in frame.chunks(W).enumerate() {
                for (bx, seg) in row.chunks(bs).enumerate() {
                    // The frame route leaves pixels outside the field of view out of the block sums.
                    let m = &fov[y * W + bx * bs..y * W + bx * bs + seg.len()];
                    blocks[(y / bs) * gw + bx] += seg
                        .iter()
                        .zip(m)
                        .filter(|(_, &m)| m != 0)
                        .map(|(&v, _)| f64::from(v))
                        .sum::<f64>();
                }
            }
        }
        let (mut vals, mut scale) = (Vec::new(), Vec::new());
        for i in 0..lib.len() {
            let (p, v) = lib.core_col(i);
            let (mut s, mut m) = (0.0f64, 0.0f64);
            for (&q, &a) in p.iter().zip(v) {
                let x = f64::from(a) * f64::from(frame[q as usize]);
                s += x;
                m += x.abs();
            }
            let (bi, li) = lib.lowpass(i);
            for (&b, &l) in bi.iter().zip(li) {
                let x = f64::from(l) * blocks[b as usize];
                s -= x;
                m += x.abs();
            }
            vals.push(s as f32);
            scale.push(m as f32);
        }
        match &lib.bg {
            BgTerms::Basis { k, maps, .. } => {
                for a in 0..*k {
                    let (mut s, mut m) = (0.0f64, 0.0f64);
                    for (&g, &y) in maps[a * W * H..(a + 1) * W * H].iter().zip(frame) {
                        let x = f64::from(g) * f64::from(y);
                        s += x;
                        m += x.abs();
                    }
                    vals.push(s as f32);
                    scale.push(m as f32);
                }
            }
            BgTerms::Ring {
                ring_start,
                ring_pix,
                ..
            } => {
                for i in 0..lib.len() {
                    let px = &ring_pix[ring_start[i]..ring_start[i + 1]];
                    let s: f64 = px.iter().map(|&q| f64::from(frame[q as usize])).sum();
                    let n = px.len().max(1) as f64;
                    vals.push((s / n) as f32);
                    scale.push((s.abs() / n) as f32);
                }
            }
            BgTerms::None => {}
        }
        (vals, scale)
    }

    #[test]
    fn projections_equal_the_dot_products_with_the_rebuilt_frame() {
        for tiling in [Tiling::Plain, Tiling::Overlap(8), Tiling::Offset] {
            let wf = window(tiling, 120, None);
            for model in models() {
                let lib = library(model, CENTRES.len());
                let proj = WindowProjector::new(&lib, &wf).unwrap();
                assert_eq!(
                    (proj.cells(), proj.background(), proj.frames()),
                    (lib.len(), lib.background_len(), 120)
                );
                assert!(proj.min_valid().iter().all(|&v| v == 1.0));
                let mut frame = vec![0.0f32; W * H];
                let mut got = vec![0.0f32; proj.functionals()];
                for t in [0, 37, 119] {
                    wf.reconstruct(t, &mut frame);
                    proj.project(&wf, t, &mut got);
                    let (want, scale) = reference(&lib, &frame);
                    for (j, ((g, w), s)) in got.iter().zip(&want).zip(&scale).enumerate() {
                        assert!(
                            (g - w).abs() <= 1e-4 * s + 1e-3,
                            "{tiling:?} frame {t} functional {j}: {g} vs {w} (terms {s})"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn projections_leave_pixels_outside_the_field_of_view_out_of_the_block_sums() {
        let wf = window(Tiling::Offset, 60, None);
        // Dark band: the right 20 columns and the bottom 10 rows.
        let mask: Vec<u8> = (0..W * H)
            .map(|i| u8::from(i % W < W - 20 && i / W < H - 10))
            .collect();
        let cfg = FlattenConfig {
            cell_diameter_px: 4.0,
            ..FlattenConfig::default()
        };
        let fov = FovMask::from_mask(dims(), &mask).unwrap();
        let mut flat = GlowFlattener::new(&fov, &cfg).unwrap();
        let mut b = LibraryBuilder::new(dims())
            .background(BackgroundModel::None)
            .fov(mask)
            .version(1);
        for (i, &c) in CENTRES.iter().enumerate() {
            b.push(footprint(i as u64, c));
        }
        let lib = b.build(&mut flat).unwrap();
        let proj = WindowProjector::new(&lib, &wf).unwrap();
        let mut frame = vec![0.0f32; W * H];
        let mut got = vec![0.0f32; proj.functionals()];
        for t in [0, 29, 59] {
            wf.reconstruct(t, &mut frame);
            proj.project(&wf, t, &mut got);
            let (want, scale) = reference(&lib, &frame);
            for (j, ((g, w), s)) in got.iter().zip(&want).zip(&scale).enumerate() {
                assert!(
                    (g - w).abs() <= 1e-4 * s + 1e-3,
                    "frame {t} functional {j}: {g} vs {w} (terms {s})"
                );
            }
        }
    }

    #[test]
    fn a_basis_background_with_an_empty_library() {
        let wf = window(Tiling::Offset, 60, None);
        let lib = library(models().remove(1), 0);
        let proj = WindowProjector::new(&lib, &wf).unwrap();
        assert_eq!((proj.cells(), proj.functionals()), (0, 1));
        let mut got = [0.0f32];
        let mut frame = vec![0.0f32; W * H];
        wf.reconstruct(5, &mut frame);
        proj.project(&wf, 5, &mut got);
        let want: f64 = (0..W * H)
            .map(|i| f64::from(0.6 + 0.4 * (i % W) as f32 / W as f32) * f64::from(frame[i]))
            .sum();
        assert!((f64::from(got[0]) - want).abs() <= 1e-4 * want.abs());
    }

    #[test]
    fn matches_only_the_window_it_was_built_from() {
        let wf = window(Tiling::Offset, 60, None);
        let lib = library(BackgroundModel::None, 2);
        let proj = WindowProjector::new(&lib, &wf).unwrap();
        assert!(proj.matches(&wf));
        let mut later = wf.clone();
        later.start += 60;
        assert!(!proj.matches(&later));
        let mut other_rank = wf.clone();
        other_rank.tiles[0].rank += 1;
        assert!(!proj.matches(&other_rank));
        let mut shorter = wf.clone();
        shorter.tiles.pop();
        assert!(!proj.matches(&shorter));
        // Tiles that do not fit their layout are refused.
        assert!(WindowProjector::new(&lib, &shorter).is_err());
    }

    fn tight() -> SolverConfig {
        SolverConfig {
            tol: 1e-4,
            max_sweeps: 20_000,
            relax: 1.5,
        }
    }

    /// What the two arms gave over a window.
    struct ArmGap {
        /// Per cell: the largest `|a - b| / (1 + |a|)` over the frames, a from
        /// the frame engine, b from the factor engine.
        worst: Vec<f32>,
        /// Largest and summed difference of the sweep counts.
        sweeps_max: u32,
        sweeps_sum: u32,
    }

    /// Arm C (the factor engine, in two calls as the app solves a window in
    /// batches) against arm B (the frame engine on frames rebuilt from the same
    /// factors). `missing`: a `(pixel, n)` that was not finite in the first `n`
    /// frames of the window; B gets it back as NaN in those frames, as the
    /// harness's replay does.
    fn compare_arms(
        wf: &WindowFactors,
        lib: &Arc<Library>,
        consolidated: bool,
        missing: Option<(usize, usize)>,
    ) -> ArmGap {
        let frames = wf.frames;
        let mut by_frame = TraceEngine::new(lib.clone(), tight()).unwrap();
        by_frame.set_consolidated_ring_gradient(consolidated);
        let mut ex = FactorExtractor::new(lib.clone(), tight()).unwrap();
        ex.engine_mut().set_consolidated_ring_gradient(consolidated);
        let proj = WindowProjector::new(lib, wf).unwrap();
        // Per frame: traces, sweeps, frame index.
        let mut c: Vec<(Vec<f32>, u32, u64)> = Vec::new();
        let split = frames / 2;
        for (t0, count) in [(0, split), (split, frames - split)] {
            ex.solve(wf, &proj, t0, count, |tr| {
                c.push((tr.traces.clone(), tr.sweeps, tr.frame_index));
            })
            .unwrap();
        }
        assert_eq!(c.len(), frames);
        let mut frame = vec![0.0f32; W * H];
        let mut out = FrameTraces::default();
        let mut gap = ArmGap {
            worst: vec![0.0; lib.len()],
            sweeps_max: 0,
            sweeps_sum: 0,
        };
        for (t, (ct, sweeps, index)) in c.iter().enumerate() {
            wf.reconstruct(t, &mut frame);
            if let Some((pixel, n)) = missing {
                if t < n {
                    frame[pixel] = f32::NAN;
                }
            }
            by_frame.process_into(&frame, &mut out).unwrap();
            assert_eq!(*index, t as u64, "the frame index continues across calls");
            for (w, (a, b)) in gap.worst.iter_mut().zip(out.traces.iter().zip(ct)) {
                *w = w.max((a - b).abs() / (1.0 + a.abs()));
            }
            // Both arms warm-start from the previous frame, so their sweep
            // counts stay together; a cold start would not.
            let d = out.sweeps.abs_diff(*sweeps);
            gap.sweeps_max = gap.sweeps_max.max(d);
            gap.sweeps_sum += d;
        }
        gap
    }

    /// The gap the two arms may have: set by the f32 rounding of the two input
    /// routes, amplified by the solve, not by the stopping tolerance (it does
    /// not move with `tol`); 2e-4 is about 2.5 times the worst gap measured.
    const ARM_TOL: f32 = 2e-4;

    /// `loose`: a cell with its own, recorded bound.
    fn assert_arms_agree(label: &str, gap: &ArmGap, loose: Option<(usize, f32)>) {
        for (i, w) in gap.worst.iter().enumerate() {
            let tol = match loose {
                Some((cell, bound)) if cell == i => bound,
                _ => ARM_TOL,
            };
            assert!(*w <= tol, "{label} cell {i}: gap {w:e}");
        }
        assert!(
            gap.sweeps_max <= 2,
            "{label}: sweeps differ by {} in a frame",
            gap.sweeps_max
        );
        assert!(
            gap.sweeps_sum <= 30,
            "{label}: sweeps differ by {} in all",
            gap.sweeps_sum
        );
    }

    #[test]
    fn traces_from_the_factors_equal_traces_from_the_rebuilt_frames() {
        for tiling in [Tiling::Plain, Tiling::Overlap(8), Tiling::Offset] {
            let wf = window(tiling, 120, None);
            for model in models() {
                let lib = Arc::new(library(model, CENTRES.len()));
                let gap = compare_arms(&wf, &lib, true, None);
                assert_arms_agree(&format!("{tiling:?}"), &gap, None);
                let proj = WindowProjector::new(&lib, &wf).unwrap();
                let mut ex = FactorExtractor::new(lib.clone(), tight()).unwrap();
                assert!(
                    ex.solve(&wf, &proj, 100, 21, |_| {}).is_err(),
                    "beyond the window"
                );
            }
        }
    }

    #[test]
    fn the_arms_agree_with_the_ring_gradient_not_consolidated() {
        // The app's FactorExtractor leaves the setting at its default (off);
        // the harness and the test above turn it on.
        for tiling in [Tiling::Plain, Tiling::Offset] {
            let wf = window(tiling, 120, None);
            for model in models() {
                let lib = Arc::new(library(model, CENTRES.len()));
                let gap = compare_arms(&wf, &lib, false, None);
                assert_arms_agree(&format!("{tiling:?} unconsolidated"), &gap, None);
            }
        }
    }

    #[test]
    fn signed_traces_from_the_factors_equal_signed_traces_from_the_rebuilt_frames() {
        // The signed trace is the trace plus the gradient over the curvature at
        // the solution; the gradient reads the projections only, so the factor
        // engine gives the frame engine's signed traces to the same rounding.
        for tiling in [Tiling::Plain, Tiling::Offset] {
            let wf = window(tiling, 60, None);
            for model in models() {
                let lib = Arc::new(library(model, CENTRES.len()));
                let mut by_frame = TraceEngine::new(lib.clone(), tight()).unwrap();
                by_frame.set_signed(true);
                let mut ex = FactorExtractor::new(lib.clone(), tight()).unwrap();
                ex.engine_mut().set_signed(true);
                let proj = WindowProjector::new(&lib, &wf).unwrap();
                let mut signed: Vec<Vec<f32>> = Vec::new();
                ex.solve(&wf, &proj, 0, wf.frames, |tr| {
                    signed.push(tr.signed.clone())
                })
                .unwrap();
                assert_eq!(signed.len(), wf.frames);
                let mut frame = vec![0.0f32; W * H];
                let mut out = FrameTraces::default();
                for (t, s) in signed.iter().enumerate() {
                    wf.reconstruct(t, &mut frame);
                    by_frame.process_into(&frame, &mut out).unwrap();
                    assert_eq!(s.len(), lib.len(), "{tiling:?} frame {t}");
                    for (i, (a, b)) in out.signed.iter().zip(s).enumerate() {
                        assert!(
                            (a - b).abs() <= 10.0 * ARM_TOL * (1.0 + a.abs()),
                            "{tiling:?} frame {t} cell {i}: {a} from the frame, {b} from the factors"
                        );
                    }
                }
            }
        }
    }

    /// The centres' library with the right 20 columns and the bottom 10 rows
    /// outside the field of view.
    fn library_with_a_partial_fov(model: BackgroundModel) -> Library {
        let mask: Vec<u8> = (0..W * H)
            .map(|i| u8::from(i % W < W - 20 && i / W < H - 10))
            .collect();
        let cfg = FlattenConfig {
            cell_diameter_px: 4.0,
            ..FlattenConfig::default()
        };
        let fov = FovMask::from_mask(dims(), &mask).unwrap();
        let mut flat = GlowFlattener::new(&fov, &cfg).unwrap();
        let mut b = LibraryBuilder::new(dims())
            .background(model)
            .fov(mask)
            .version(1);
        for (i, &c) in CENTRES.iter().enumerate() {
            b.push(footprint(i as u64, c));
        }
        b.build(&mut flat).unwrap()
    }

    #[test]
    fn the_arms_agree_with_a_ring_or_basis_background_and_a_partial_field_of_view() {
        let wf = window(Tiling::Offset, 120, None);
        for (name, model) in ["basis", "ring"]
            .into_iter()
            .zip(models().into_iter().skip(1))
        {
            for consolidated in [true, false] {
                let lib = Arc::new(library_with_a_partial_fov(model.clone()));
                let gap = compare_arms(&wf, &lib, consolidated, None);
                // Cell 4 straddles the edge of the field of view. Measured 2.1e-4
                // (ring, consolidated) and 2.0e-4 (ring, not), just past the
                // other cells' bound; still rounding, not a different model
                // (a different treatment of the ring would be far larger).
                let label = format!("fov {name}, consolidated {consolidated}");
                assert_arms_agree(&label, &gap, Some((4, 3e-4)));
            }
        }
    }

    #[test]
    fn a_pixel_missing_in_part_of_the_window_is_read_differently_by_the_two_arms() {
        // Cell 0's centre pixel, missing in the first 30 of 120 frames: the
        // factors hold its mean over the other 90 frames, arm B puts the NaN
        // back and its engine treats the pixel as missing in those frames.
        let (pixel, n) = (20 * W + 20, 30);
        let wf = window(Tiling::Offset, 120, Some((pixel, n)));
        let lib = Arc::new(library(BackgroundModel::None, CENTRES.len()));
        let proj = WindowProjector::new(&lib, &wf).unwrap();
        assert!(proj.min_valid()[0] < 1.0);
        assert!(proj.min_valid()[1..].iter().all(|&v| v == 1.0));
        let gap = compare_arms(&wf, &lib, true, Some((pixel, n)));
        // Cells far from the pixel agree as before.
        for i in [1, 2, 4] {
            assert!(gap.worst[i] <= ARM_TOL, "cell {i}: gap {:e}", gap.worst[i]);
        }
        // Cell 0 differs. Measured 8.9e-2 (relative, as above); the upper
        // bound is loose. The lower one only says the missing pixel reaches
        // the solve: closing this gap is a deliberate change of the engines
        // and then changes this test.
        assert!(
            (ARM_TOL..=0.2).contains(&gap.worst[0]),
            "cell 0: gap {:e}",
            gap.worst[0]
        );
        // Cell 3 has no missing pixel in its support (`min_valid` is 1) but
        // its low-pass term takes in the block of the pixel: measured 1.7e-3.
        // `min_valid` does not see a missing pixel in the moat.
        assert!(
            (ARM_TOL..=5e-3).contains(&gap.worst[3]),
            "cell 3: gap {:e}",
            gap.worst[3]
        );
    }

    #[test]
    fn an_extractor_refuses_a_projector_of_another_library() {
        let wf = window(Tiling::Plain, 60, None);
        let five = Arc::new(library(BackgroundModel::None, 5));
        let three = library(BackgroundModel::None, 3);
        let mut ex = FactorExtractor::new(five, tight()).unwrap();
        let proj = WindowProjector::new(&three, &wf).unwrap();
        assert!(ex.solve(&wf, &proj, 0, 1, |_| {}).is_err());
        ex.set_library(Arc::new(three)).unwrap();
        let mut n = 0;
        ex.solve(&wf, &proj, 0, 2, |tr| n += tr.traces.len())
            .unwrap();
        assert_eq!(n, 6);
    }

    #[test]
    fn an_extractor_refuses_a_projector_of_another_window_without_panicking() {
        let plain = window(Tiling::Plain, 60, None);
        let offset = window(Tiling::Offset, 60, None);
        let lib = Arc::new(library(BackgroundModel::None, 3));
        let mut ex = FactorExtractor::new(lib.clone(), tight()).unwrap();
        let proj = WindowProjector::new(&lib, &plain).unwrap();
        let mut calls = 0;
        assert!(ex.solve(&offset, &proj, 0, 5, |_| calls += 1).is_err());
        assert_eq!(calls, 0, "refused before any frame");
        // The engine is untouched: the right window still solves from frame 0.
        ex.solve(&plain, &proj, 0, 5, |_| calls += 1).unwrap();
        assert_eq!(calls, 5);
    }

    #[test]
    fn a_projector_of_a_same_sized_library_of_another_version_is_refused() {
        let wf = window(Tiling::Plain, 60, None);
        let first = Arc::new(library_v(BackgroundModel::None, 3, 1));
        let second = Arc::new(library_v(BackgroundModel::None, 3, 2));
        let mut ex = FactorExtractor::new(first.clone(), tight()).unwrap();
        let old = WindowProjector::new(&first, &wf).unwrap();
        ex.solve(&wf, &old, 0, 5, |_| {}).unwrap();
        ex.set_library(second.clone()).unwrap();
        assert!(ex.solve(&wf, &old, 5, 5, |_| panic!("refused")).is_err());
        let new = WindowProjector::new(&second, &wf).unwrap();
        assert_eq!(new.library_version(), 2);
        let mut n = 0;
        ex.solve(&wf, &new, 5, 5, |_| n += 1).unwrap();
        assert_eq!(n, 5);
    }

    #[test]
    fn a_library_swapped_through_the_engine_is_followed() {
        let wf = window(Tiling::Plain, 60, None);
        let five = Arc::new(library_v(BackgroundModel::None, 5, 1));
        let three = Arc::new(library_v(BackgroundModel::None, 3, 2));
        let mut ex = FactorExtractor::new(five.clone(), tight()).unwrap();
        let old = WindowProjector::new(&five, &wf).unwrap();
        ex.solve(&wf, &old, 0, 2, |_| {}).unwrap();
        ex.engine_mut().set_library(three.clone()).unwrap();
        assert!(ex.solve(&wf, &old, 2, 1, |_| {}).is_err());
        let new = WindowProjector::new(&three, &wf).unwrap();
        let mut n = 0;
        ex.solve(&wf, &new, 2, 2, |tr| n += tr.traces.len())
            .unwrap();
        assert_eq!(n, 6);
    }

    #[test]
    fn a_non_finite_projection_stops_the_solve_and_leaves_the_extractor_usable() {
        let clean = window(Tiling::Plain, 60, None);
        let mut bad = clean.clone();
        // Frame 30 of the first tile (it holds cells) has a NaN in its row.
        let rank = bad.tiles[0].rank;
        bad.tiles[0].temporal[30 * rank] = f32::NAN;
        let lib = Arc::new(library(BackgroundModel::None, 3));
        let proj = WindowProjector::new(&lib, &bad).unwrap();
        let mut ex = FactorExtractor::new(lib.clone(), tight()).unwrap();
        let mut seen = 0u64;
        let r = ex.solve(&bad, &proj, 0, 60, |tr| {
            assert_eq!(tr.frame_index, seen);
            seen += 1;
        });
        assert!(r.is_err());
        assert_eq!(seen, 30, "the sink got the frames before the bad one");
        // A rejected frame does not advance the engine: the clean window goes on
        // from frame 30 and gives what a fresh extractor gives, to the solve's
        // tolerance.
        let good = WindowProjector::new(&lib, &clean).unwrap();
        let mut again = Vec::new();
        ex.solve(&clean, &good, 0, 10, |tr| {
            again.push((tr.frame_index, tr.traces.clone()));
        })
        .unwrap();
        assert_eq!(again[0].0, 30);
        let mut fresh = FactorExtractor::new(lib.clone(), tight()).unwrap();
        let mut k = 0;
        fresh
            .solve(&clean, &good, 0, 10, |tr| {
                for (a, b) in tr.traces.iter().zip(&again[k].1) {
                    assert!(
                        (a - b).abs() <= 1e-3 * (1.0 + a.abs()),
                        "frame {k}: {a} vs {b}"
                    );
                }
                k += 1;
            })
            .unwrap();
        assert_eq!(k, 10);
    }

    #[test]
    fn an_empty_range_solves_nothing_and_a_huge_one_is_refused() {
        let wf = window(Tiling::Plain, 60, None);
        let lib = Arc::new(library(BackgroundModel::None, 3));
        let mut ex = FactorExtractor::new(lib.clone(), tight()).unwrap();
        let proj = WindowProjector::new(&lib, &wf).unwrap();
        ex.solve(&wf, &proj, 60, 0, |_| panic!("no frame")).unwrap();
        assert!(ex.solve(&wf, &proj, 1, usize::MAX, |_| {}).is_err());
    }

    #[test]
    fn another_frame_size_and_an_empty_library() {
        let wf = window(Tiling::Offset, 60, None);
        let small = LibraryBuilder::new(Dims::new(64, 56).unwrap())
            .build(&mut crate::trace::IdentityFilter(
                Dims::new(64, 56).unwrap(),
            ))
            .unwrap();
        assert!(WindowProjector::new(&small, &wf).is_err());
        let empty = library(BackgroundModel::None, 0);
        let proj = WindowProjector::new(&empty, &wf).unwrap();
        assert_eq!(proj.functionals(), 0);
        proj.project(&wf, 3, &mut []);
    }

    #[test]
    fn a_pixel_missing_in_part_of_the_window_lowers_the_cells_valid_share() {
        // The centre pixel of cell 0, missing in 30 of 120 frames.
        let wf = window(Tiling::Offset, 120, Some((20 * W + 20, 30)));
        let lib = library(BackgroundModel::None, CENTRES.len());
        let proj = WindowProjector::new(&lib, &wf).unwrap();
        assert!((proj.min_valid()[0] - 0.75).abs() < 1e-6);
        assert!(proj.min_valid()[1..].iter().all(|&v| v == 1.0));
    }
}
