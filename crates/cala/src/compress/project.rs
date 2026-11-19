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
//! [`TraceEngine::process_projected`]: each cell's filtered column (its
//! support part minus the moat's block means against the block sums over
//! the field of view), and the background model's (a dot product with each
//! map of a basis, a mean over each cell's ring).
//!
//! Missing samples: a factor window holds no missing pixel (a missing
//! sample is the pixel's mean over the window, [`super::TileFactors::valid`]
//! says how often), so nothing is filled per frame as
//! [`TraceEngine::process_into`] does. [`WindowProjector::min_valid`] tells
//! which cells that concerns.

// Index loops over cells and tiles read more clearly than zipped iterators here.
#![allow(clippy::needless_range_loop)]

use super::WindowFactors;
use crate::trace::{BgTerms, Library, TraceError};

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
    cells: usize,
    background: usize,
    frames: usize,
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
        let (n, n_bg) = (lib.len(), lib.background_len());
        let (width, height) = (wf.dims.width, wf.dims.height);
        let n_px = wf.dims.pixels();
        let layout = wf.layout();
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

        let mut offset = vec![0.0f32; n + n_bg];
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
                    offset[i] += c0;
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
                        offset[n + a] += c0;
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
                            offset[n + i] += c0;
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
            cells: n,
            background: n_bg,
            frames: wf.frames,
            offset,
            tiles,
            min_valid,
        })
    }

    /// The functionals of frame `t` (`0..frames`) of the window this was
    /// built from: `out` holds [`Self::functionals`] values, the cells'
    /// projections, then the background's.
    pub fn project(&self, wf: &WindowFactors, t: usize, out: &mut [f32]) {
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

    /// Frames of the window this was built from.
    pub fn frames(&self) -> usize {
        self.frames
    }

    /// Per cell: the smallest share of the window's frames in which a pixel
    /// of its support was not missing (1: none of its pixels was ever missing).
    pub fn min_valid(&self) -> &[f32] {
        &self.min_valid
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
        let cfg = FlattenConfig {
            cell_diameter_px: 4.0,
            ..FlattenConfig::default()
        };
        let mut flat = GlowFlattener::new(&FovMask::full(dims()), &cfg).unwrap();
        let mut b = LibraryBuilder::new(dims()).background(model).version(1);
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
        let mut blocks = vec![0.0f64; lib.grid_len()];
        if bs > 0 {
            let gw = W.div_ceil(bs);
            for (y, row) in frame.chunks(W).enumerate() {
                for (bx, seg) in row.chunks(bs).enumerate() {
                    blocks[(y / bs) * gw + bx] += seg.iter().map(|&v| f64::from(v)).sum::<f64>();
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
        for tiling in [Tiling::Plain, Tiling::Offset] {
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
