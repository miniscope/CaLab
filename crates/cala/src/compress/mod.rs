//! Windowed low-rank compression of a frame stream (prototype).
//!
//! A window of `T` frames is cut into square tiles; each tile's movie
//! `Y` (`P` pixels x `T` frames) is stored as
//!
//! ```text
//! Y  ≈  mean · 1ᵀ  +  W · Vᵀ        W: P x r,  V: T x r (orthonormal columns)
//! ```
//!
//! from a randomized SVD (Halko et al., `n_iter` power iterations) whose
//! rank is cut by the lag-1 autocorrelation of each temporal component:
//! spatial filters leave the noise white in time, while calcium transients,
//! background drift and motion residue are temporally correlated, so a
//! component is kept when its time course is not white. The rank starts at
//! `k0` and doubles while any of the last `ADAPT_MARGIN` components passes.
//!
//! Every later use of the frames that is linear in `y` (the fast loop's
//! projections `ãᵀ y`, a footprint update `Σ y cᵀ`) can then run on `W` and
//! `V` without the frames: `ãᵀ y_t = (ãᵀ W) v_t + ãᵀ mean`.
//!
//! [`WindowCompressor`] buffers one window of frames per tile as `i16`
//! (`round(value * quant)`) and returns a [`WindowFactors`] when the window
//! is full, so memory is one window at two bytes per pixel and frame.
//!
//! The kernels follow MiniMe's `minime-core` (`compress.rs`): the products
//! with `Y` are float32 GEMMs over chunks of [`CHUNK`] frames, converted
//! from the buffer chunk by chunk; the Householder QR, the small SVD (from
//! the eigenvectors of `B Bᵀ`) and the autocorrelations run in float64.

mod linalg;
pub mod review;

#[cfg(feature = "jsbindings")]
mod js;

use linalg::{qr_q, sym_eig};

use crate::preprocess::Dims;

/// Extra random directions beyond the requested rank.
const N_OVERSAMPLES: usize = 10;
/// Trailing components that must all fail the cut for the rank to stop growing.
const ADAPT_MARGIN: usize = 10;
/// Magic and header length of a factor file ([`WindowFactors::to_bytes`]).
const FILE_MAGIC: &[u8; 8] = b"CALAFAC1";
const FILE_HEADER: usize = 36;
/// Frames converted to float32 at a time for a product with `Y`.
const CHUNK: usize = 512;

/// Settings of the compression.
#[derive(Debug, Clone, PartialEq)]
pub struct CompressConfig {
    /// Tile edge, px.
    pub tile: usize,
    /// Frames per window.
    pub window: usize,
    /// Starting rank.
    pub k0: usize,
    /// Largest rank of a tile.
    pub max_rank: usize,
    /// Power iterations of the randomized SVD.
    pub n_iter: usize,
    /// A component is kept when its lag-1 autocorrelation exceeds
    /// `max(z / sqrt(T), rho_min)`.
    pub rho_min: f64,
    pub z: f64,
    pub seed: u64,
    /// Buffered values are `round(value * quant)` in `i16`: a resolution of
    /// `1 / quant` and a range of `± 32767 / quant` (64: 1/64 grey level,
    /// ± 512 grey levels, for 8-bit recordings).
    pub quant: f32,
    /// Threads that share a window's tiles (native builds; wasm uses one).
    pub threads: usize,
}

impl Default for CompressConfig {
    fn default() -> CompressConfig {
        CompressConfig {
            tile: 64,
            window: 600,
            k0: 40,
            max_rank: 300,
            n_iter: 1,
            rho_min: 0.2,
            z: 4.0,
            seed: 0,
            quant: 64.0,
            threads: 1,
        }
    }
}

/// One tile of one window.
#[derive(Debug, Clone)]
pub struct TileFactors {
    pub x0: usize,
    pub y0: usize,
    pub w: usize,
    pub h: usize,
    pub rank: usize,
    /// `P x rank`, row-major: left factors scaled by the singular values.
    pub spatial: Vec<f32>,
    /// `T x rank`, row-major: orthonormal time courses.
    pub temporal: Vec<f32>,
    /// Per-pixel mean over the window.
    pub mean: Vec<f32>,
    /// `Σ (y − mean)²` over the tile and the window, and the part kept.
    pub energy: f64,
    pub kept_energy: f64,
    /// Rank of the last randomized SVD (before the cut).
    pub svd_rank: usize,
}

impl TileFactors {
    pub fn pixels(&self) -> usize {
        self.w * self.h
    }

    pub fn bytes(&self) -> usize {
        4 * (self.spatial.len() + self.temporal.len() + self.mean.len())
    }

    /// Little-endian encoding: `CTF1`, u32 x0, y0, w, h, rank, frames,
    /// svd_rank, f64 energy, kept_energy, then f32 mean (`P`), spatial
    /// (`P x rank`) and temporal (`frames x rank`).
    pub fn to_bytes(&self) -> Vec<u8> {
        let frames = self.temporal.len().checked_div(self.rank).unwrap_or(0);
        let mut b = Vec::with_capacity(48 + self.bytes());
        b.extend_from_slice(b"CTF1");
        for v in [
            self.x0,
            self.y0,
            self.w,
            self.h,
            self.rank,
            frames,
            self.svd_rank,
        ] {
            b.extend_from_slice(&(v as u32).to_le_bytes());
        }
        b.extend_from_slice(&self.energy.to_le_bytes());
        b.extend_from_slice(&self.kept_energy.to_le_bytes());
        for a in [&self.mean, &self.spatial, &self.temporal] {
            for v in a.iter() {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        b
    }

    /// Inverse of [`TileFactors::to_bytes`]; `None` for truncated or
    /// inconsistent input.
    pub fn from_bytes(b: &[u8]) -> Option<TileFactors> {
        if b.get(..4)? != b"CTF1" {
            return None;
        }
        let u = |i: usize| -> Option<usize> {
            let o = 4 + 4 * i;
            Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?) as usize)
        };
        let (x0, y0, w, h, rank, frames, svd_rank) =
            (u(0)?, u(1)?, u(2)?, u(3)?, u(4)?, u(5)?, u(6)?);
        let f = |o: usize| -> Option<f64> {
            Some(f64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?))
        };
        let (energy, kept_energy) = (f(32)?, f(40)?);
        let p = w.checked_mul(h)?;
        let (ns, nt) = (p.checked_mul(rank)?, frames.checked_mul(rank)?);
        let total = p.checked_add(ns)?.checked_add(nt)?;
        let body = b.get(48..)?;
        if body.len() != total.checked_mul(4)? {
            return None;
        }
        let vals: Vec<f32> = body
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect();
        Some(TileFactors {
            x0,
            y0,
            w,
            h,
            rank,
            spatial: vals[p..p + ns].to_vec(),
            temporal: vals[p + ns..].to_vec(),
            mean: vals[..p].to_vec(),
            energy,
            kept_energy,
            svd_rank,
        })
    }
}

/// The factors of one window of frames.
#[derive(Debug, Clone)]
pub struct WindowFactors {
    pub dims: Dims,
    /// Index of the window's first frame, and its length.
    pub start: u64,
    pub frames: usize,
    pub tiles: Vec<TileFactors>,
    /// Compute time summed over the tiles (single-thread cost), seconds
    /// (0 on wasm, which has no clock here).
    pub compress_seconds: f64,
}

impl WindowFactors {
    /// Frame `t` of the window (`0..frames`) rebuilt into `out`.
    pub fn reconstruct(&self, t: usize, out: &mut [f32]) {
        let width = self.dims.width;
        for tf in &self.tiles {
            let v = &tf.temporal[t * tf.rank..(t + 1) * tf.rank];
            for y in 0..tf.h {
                let row = (tf.y0 + y) * width + tf.x0;
                for x in 0..tf.w {
                    let p = y * tf.w + x;
                    let wrow = &tf.spatial[p * tf.rank..(p + 1) * tf.rank];
                    let mut s = tf.mean[p];
                    for (a, b) in wrow.iter().zip(v) {
                        s += a * b;
                    }
                    out[row + x] = s;
                }
            }
        }
    }

    /// Frames `t0..t0 + count` of the window rebuilt into `out`, frame
    /// after frame.
    pub fn reconstruct_range(&self, t0: usize, count: usize, out: &mut [f32]) {
        let px = self.dims.pixels();
        for (i, frame) in out.chunks_exact_mut(px).take(count).enumerate() {
            self.reconstruct(t0 + i, frame);
        }
    }

    pub fn bytes(&self) -> usize {
        self.tiles.iter().map(TileFactors::bytes).sum()
    }

    /// The window as a factor file: `CALAFAC1`, u32 width, height, tile,
    /// frames, tiles, f64 stream index of the first frame, then per tile a
    /// u32 byte length and [`TileFactors::to_bytes`]. `tile` is the edge of
    /// the grid the tiles were cut on.
    pub fn to_bytes(&self, tile: usize) -> Vec<u8> {
        let mut b = Vec::with_capacity(FILE_HEADER + self.bytes() + 52 * self.tiles.len());
        b.extend_from_slice(FILE_MAGIC);
        for v in [
            self.dims.width,
            self.dims.height,
            tile,
            self.frames,
            self.tiles.len(),
        ] {
            b.extend_from_slice(&(v as u32).to_le_bytes());
        }
        b.extend_from_slice(&(self.start as f64).to_le_bytes());
        for t in &self.tiles {
            let tb = t.to_bytes();
            b.extend_from_slice(&(tb.len() as u32).to_le_bytes());
            b.extend_from_slice(&tb);
        }
        b
    }

    /// Inverse of [`WindowFactors::to_bytes`]: `None` for truncated input or
    /// tiles that do not fit the frame or the window's length.
    pub fn from_bytes(b: &[u8]) -> Option<WindowFactors> {
        if b.get(..8)? != FILE_MAGIC {
            return None;
        }
        let u = |o: usize| -> Option<usize> {
            Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?) as usize)
        };
        let (width, height, frames, n) = (u(8)?, u(12)?, u(20)?, u(24)?);
        let start = f64::from_le_bytes(b.get(28..36)?.try_into().ok()?);
        if !(start.is_finite() && start >= 0.0) {
            return None;
        }
        let dims = Dims::new(width, height).ok()?;
        let mut tiles = Vec::with_capacity(n.min(1 << 16));
        let mut at = FILE_HEADER;
        for _ in 0..n {
            let len = u(at)?;
            let end = at.checked_add(4)?.checked_add(len)?;
            let t = TileFactors::from_bytes(b.get(at + 4..end)?)?;
            let fits = t.x0.checked_add(t.w)? <= width
                && t.y0.checked_add(t.h)? <= height
                && t.temporal.len() == frames.checked_mul(t.rank)?;
            if !fits {
                return None;
            }
            tiles.push(t);
            at = end;
        }
        (at == b.len()).then_some(WindowFactors {
            dims,
            start: start as u64,
            frames,
            tiles,
            compress_seconds: 0.0,
        })
    }

    /// Mean rank over the tiles.
    pub fn mean_rank(&self) -> f64 {
        let n = self.tiles.len().max(1) as f64;
        self.tiles.iter().map(|t| t.rank as f64).sum::<f64>() / n
    }

    /// Fraction of the mean-removed energy the factors keep.
    pub fn kept_fraction(&self) -> f64 {
        let e: f64 = self.tiles.iter().map(|t| t.energy).sum();
        let k: f64 = self.tiles.iter().map(|t| t.kept_energy).sum();
        k / e.max(1e-300)
    }
}

/// A tile to compress: its index, `(x0, y0, w, h)` and its buffered frames.
type Job<'a> = (usize, &'a (usize, usize, usize, usize), &'a mut Vec<i16>);

/// Buffers frames tile by tile and compresses each full window.
pub struct WindowCompressor {
    dims: Dims,
    cfg: CompressConfig,
    /// `(x0, y0, w, h)` of each tile.
    grid: Vec<(usize, usize, usize, usize)>,
    /// Per tile, `n x P` row-major, quantized.
    buf: Vec<Vec<i16>>,
    n: usize,
    start: u64,
    windows: u64,
}

impl WindowCompressor {
    pub fn new(dims: Dims, cfg: CompressConfig) -> WindowCompressor {
        let grid = tile_grid(dims, cfg.tile);
        let buf = grid
            .iter()
            .map(|g| Vec::with_capacity(g.2 * g.3 * cfg.window))
            .collect();
        WindowCompressor {
            dims,
            cfg,
            grid,
            buf,
            n: 0,
            start: 0,
            windows: 0,
        }
    }

    /// Frames buffered in the open window.
    pub fn pending(&self) -> usize {
        self.n
    }

    /// Bytes held by the open window.
    pub fn buffer_bytes(&self) -> usize {
        self.buf.iter().map(|b| b.len() * 2).sum()
    }

    /// Add a frame (non-finite pixels count as 0); returns the window's
    /// factors when it is full.
    pub fn push(&mut self, frame: &[f32]) -> Option<WindowFactors> {
        let width = self.dims.width;
        let q = self.cfg.quant;
        for (g, b) in self.grid.iter().zip(&mut self.buf) {
            for y in 0..g.3 {
                let row = (g.1 + y) * width + g.0;
                b.extend(frame[row..row + g.2].iter().map(|&v| quantize(v, q)));
            }
        }
        self.n += 1;
        (self.n >= self.cfg.window).then(|| self.flush()).flatten()
    }

    /// Compress the frames buffered so far (the last, shorter window).
    pub fn flush(&mut self) -> Option<WindowFactors> {
        if self.n == 0 {
            return None;
        }
        let t = self.n;
        let (cfg, windows) = (&self.cfg, self.windows);
        let jobs: Vec<Job> = self
            .grid
            .iter()
            .zip(&mut self.buf)
            .enumerate()
            .map(|(i, (g, b))| (i, g, b))
            .collect();
        let run = |(i, g, b): Job| {
            // No clock on wasm32-unknown-unknown (`Instant::now` panics).
            #[cfg(not(target_arch = "wasm32"))]
            let t0 = std::time::Instant::now();
            let seed = cfg.seed ^ (windows << 20) ^ i as u64;
            let mut tf = compress_tile(b, t, g.2 * g.3, cfg, seed);
            (tf.x0, tf.y0, tf.w, tf.h) = *g;
            b.clear();
            #[cfg(not(target_arch = "wasm32"))]
            let secs = t0.elapsed().as_secs_f64();
            #[cfg(target_arch = "wasm32")]
            let secs = 0.0;
            (i, tf, secs)
        };
        let threads = if cfg!(target_arch = "wasm32") {
            1
        } else {
            cfg.threads.max(1)
        };
        let mut done: Vec<(usize, TileFactors, f64)> = if threads == 1 {
            jobs.into_iter().map(run).collect()
        } else {
            let mut lanes: Vec<Vec<_>> = (0..threads).map(|_| Vec::new()).collect();
            for (k, j) in jobs.into_iter().enumerate() {
                lanes[k % threads].push(j);
            }
            std::thread::scope(|s| {
                let hs: Vec<_> = lanes
                    .into_iter()
                    .map(|lane| s.spawn(|| lane.into_iter().map(run).collect::<Vec<_>>()))
                    .collect();
                hs.into_iter()
                    .flat_map(|h| h.join().expect("tile compression"))
                    .collect()
            })
        };
        done.sort_by_key(|d| d.0);
        let compress_seconds = done.iter().map(|d| d.2).sum();
        let tiles = done.into_iter().map(|d| d.1).collect();
        let out = WindowFactors {
            dims: self.dims,
            start: self.start,
            frames: t,
            tiles,
            compress_seconds,
        };
        self.start += t as u64;
        self.n = 0;
        self.windows += 1;
        Some(out)
    }
}

/// `(x0, y0, w, h)` of the tiles of a frame, row by row; the tiles at the
/// right and bottom edge are smaller when `tile` does not divide the frame.
pub fn tile_grid(dims: Dims, tile: usize) -> Vec<(usize, usize, usize, usize)> {
    let tile = tile.max(1);
    let mut grid = Vec::new();
    for y0 in (0..dims.height).step_by(tile) {
        for x0 in (0..dims.width).step_by(tile) {
            grid.push((
                x0,
                y0,
                tile.min(dims.width - x0),
                tile.min(dims.height - y0),
            ));
        }
    }
    grid
}

/// Quantize `count` frames (frame after frame in `frames`) into tile order:
/// for each tile of [`tile_grid`], its `count x P` values, a frame per row,
/// which is what [`compress_tile`] reads. `out` holds as many values as
/// `frames`.
pub fn quantize_tiles(
    frames: &[f32],
    count: usize,
    dims: Dims,
    tile: usize,
    quant: f32,
    out: &mut [i16],
) {
    let (width, px) = (dims.width, dims.pixels());
    debug_assert_eq!(frames.len(), count * px);
    debug_assert_eq!(out.len(), count * px);
    let mut o = 0;
    for (x0, y0, w, h) in tile_grid(dims, tile) {
        for t in 0..count {
            for y in 0..h {
                let row = t * px + (y0 + y) * width + x0;
                for (d, &v) in out[o..o + w].iter_mut().zip(&frames[row..row + w]) {
                    *d = quantize(v, quant);
                }
                o += w;
            }
        }
    }
}

/// `round(v * quant)` in `i16`; non-finite values count as 0.
///
/// Rounds half away from zero like `f32::round`, written out with `trunc`:
/// on wasm `round` is a libm call per pixel, `trunc` an instruction the
/// loop over a frame vectorizes with.
#[inline]
pub fn quantize(v: f32, quant: f32) -> i16 {
    let s = if v.is_finite() { v * quant } else { 0.0 };
    let t = s.trunc();
    let r = if (s - t).abs() >= 0.5 {
        t + 1.0f32.copysign(s)
    } else {
        t
    };
    r.clamp(-32767.0, 32767.0) as i32 as i16
}

// ---------------------------------------------------------------------------
// One tile
// ---------------------------------------------------------------------------

/// `Y` (`P x T`, mean removed) of one tile, held as `(T, P)` quantized
/// values and used in float32 chunks of [`CHUNK`] frames.
struct TileMatrix<'a> {
    raw: &'a [i16],
    t: usize,
    p: usize,
    inv_quant: f32,
    /// Per-pixel mean, in the frames' units.
    mean: Vec<f32>,
    /// `Σ (y − mean)²` over the tile.
    energy: f64,
}

impl<'a> TileMatrix<'a> {
    fn new(raw: &'a [i16], t: usize, p: usize, quant: f32) -> TileMatrix<'a> {
        debug_assert_eq!(raw.len(), t * p);
        // Integer column sums are exact (|v| < 2^15, v² < 2^30).
        let mut acc = vec![0i64; p];
        let mut sq = vec![0i64; p];
        for row in raw.chunks_exact(p) {
            for ((a, s), &v) in acc.iter_mut().zip(sq.iter_mut()).zip(row) {
                let v = i64::from(v);
                *a += v;
                *s += v * v;
            }
        }
        let (tf, q) = (t as f64, f64::from(quant));
        let mean = acc.iter().map(|&a| (a as f64 / tf / q) as f32).collect();
        let energy = acc
            .iter()
            .zip(&sq)
            .map(|(&a, &s)| (s as f64 - (a as f64) * (a as f64) / tf).max(0.0))
            .sum::<f64>()
            / (q * q);
        TileMatrix {
            raw,
            t,
            p,
            inv_quant: 1.0 / quant,
            mean,
            energy,
        }
    }

    /// Frames `c0..c0 + n` as `(n, P)` row-major float32, mean removed.
    fn block(&self, c0: usize, n: usize, buf: &mut Vec<f32>) {
        buf.clear();
        let s = self.inv_quant;
        for row in self.raw[c0 * self.p..(c0 + n) * self.p].chunks_exact(self.p) {
            buf.extend(
                row.iter()
                    .zip(&self.mean)
                    .map(|(&v, &m)| f32::from(v) * s - m),
            );
        }
    }

    /// `Yᵀ Q`: `(T, l)` row-major from `q` `(P, l)` row-major.
    fn t_matmul(&self, q: &[f32], l: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; self.t * l];
        let mut x = Vec::new();
        for c0 in (0..self.t).step_by(CHUNK) {
            let n = CHUNK.min(self.t - c0);
            self.block(c0, n, &mut x);
            let c = &mut out[c0 * l..(c0 + n) * l];
            // SAFETY: `x` is (n, P), `q` is (P, l) and `c` is (n, l), all
            // row-major with the strides given; the buffers do not overlap.
            unsafe {
                matrixmultiply::sgemm(
                    n,
                    self.p,
                    l,
                    1.0,
                    x.as_ptr(),
                    self.p as isize,
                    1,
                    q.as_ptr(),
                    l as isize,
                    1,
                    0.0,
                    c.as_mut_ptr(),
                    l as isize,
                    1,
                );
            }
        }
        out
    }

    /// `Y Z`: `(P, l)` row-major from `z` `(T, l)` row-major.
    fn matmul(&self, z: &[f32], l: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; self.p * l];
        let mut x = Vec::new();
        for c0 in (0..self.t).step_by(CHUNK) {
            let n = CHUNK.min(self.t - c0);
            self.block(c0, n, &mut x);
            let zc = &z[c0 * l..(c0 + n) * l];
            // SAFETY: `xᵀ` is `x` (n, P) with swapped strides, `zc` is
            // (n, l) and `out` is (P, l) row-major; no overlap.
            unsafe {
                matrixmultiply::sgemm(
                    self.p,
                    n,
                    l,
                    1.0,
                    x.as_ptr(),
                    1,
                    self.p as isize,
                    zc.as_ptr(),
                    l as isize,
                    1,
                    1.0,
                    out.as_mut_ptr(),
                    l as isize,
                    1,
                );
            }
        }
        out
    }
}

/// Compress one tile: `raw` is `t x p` row-major (a frame per row),
/// quantized with `cfg.quant`. The tile's position is left at 0 for the
/// caller to fill.
pub fn compress_tile(
    raw: &[i16],
    t: usize,
    p: usize,
    cfg: &CompressConfig,
    seed: u64,
) -> TileFactors {
    let y = TileMatrix::new(raw, t, p, cfg.quant);
    let k_cap = cfg
        .max_rank
        .min(p.saturating_sub(1))
        .min(t.saturating_sub(1))
        .max(1);
    let mut k = cfg.k0.clamp(1, k_cap);
    let mut rng = Normals::new(seed);
    let thr = (cfg.z / (t as f64).sqrt()).max(cfg.rho_min);
    let (svd, mut keep) = loop {
        let svd = rsvd(&y, k, cfg.n_iter, &mut rng);
        let keep: Vec<bool> = (0..svd.k)
            .map(|j| lag1_autocorr(&svd.v, t, svd.k, j) > thr)
            .collect();
        let tail = svd.k.saturating_sub(ADAPT_MARGIN);
        if k >= k_cap || !keep[tail..].iter().any(|&b| b) {
            break (svd, keep);
        }
        k = (2 * k).min(k_cap);
    };
    if !keep.iter().any(|&b| b) {
        keep[0] = true;
    }
    let cols: Vec<usize> = (0..svd.k).filter(|&j| keep[j]).collect();
    let rank = cols.len();
    let mut spatial = vec![0.0f32; p * rank];
    let mut temporal = vec![0.0f32; t * rank];
    let mut kept_energy = 0.0;
    for (c, &j) in cols.iter().enumerate() {
        kept_energy += svd.s[j] * svd.s[j];
        for i in 0..p {
            spatial[i * rank + c] = (f64::from(svd.u[i * svd.k + j]) * svd.s[j]) as f32;
        }
        for i in 0..t {
            temporal[i * rank + c] = svd.v[i * svd.k + j];
        }
    }
    TileFactors {
        x0: 0,
        y0: 0,
        w: 0,
        h: 0,
        rank,
        spatial,
        temporal,
        mean: y.mean,
        energy: y.energy,
        kept_energy,
        svd_rank: svd.k,
    }
}

/// Lag-1 autocorrelation of column `j` of the `t x k` matrix `v`.
fn lag1_autocorr(v: &[f32], t: usize, k: usize, j: usize) -> f64 {
    let col = |i: usize| f64::from(v[i * k + j]);
    let mu = (0..t).map(col).sum::<f64>() / t as f64;
    let mut num = 0.0;
    let mut den = 0.0;
    for i in 0..t {
        let a = col(i) - mu;
        den += a * a;
        if i > 0 {
            num += a * (col(i - 1) - mu);
        }
    }
    num / den.max(1e-30)
}

// ---------------------------------------------------------------------------
// Randomized SVD
// ---------------------------------------------------------------------------

struct Svd {
    k: usize,
    /// `p x k`.
    u: Vec<f32>,
    s: Vec<f64>,
    /// `t x k`.
    v: Vec<f32>,
}

/// Rank-`k` randomized SVD of `Y` with every product streamed over chunks.
fn rsvd(y: &TileMatrix, k: usize, n_iter: usize, rng: &mut Normals) -> Svd {
    let (p, t) = (y.p, y.t);
    let l = (k + N_OVERSAMPLES).min(p).min(t);
    let k = k.min(l);
    let omega: Vec<f32> = (0..t * l).map(|_| rng.next()).collect();
    let mut q = qr_q(&y.matmul(&omega, l), p, l);
    for _ in 0..n_iter {
        let z = qr_q(&y.t_matmul(&q, l), t, l);
        q = qr_q(&y.matmul(&z, l), p, l);
    }
    // B = Qᵀ Y (l x t), held as Bᵀ (t x l). B Bᵀ = E Λ Eᵀ gives
    // U = Q E, s = sqrt(Λ), V = Bᵀ E / s.
    let bt = y.t_matmul(&q, l);
    let mut g = vec![0.0f64; l * l];
    let mut rowf = vec![0.0f64; l];
    for row in bt.chunks_exact(l) {
        for (d, &v) in rowf.iter_mut().zip(row) {
            *d = f64::from(v);
        }
        for a in 0..l {
            let ra = rowf[a];
            for (gv, &rb) in g[a * l + a..(a + 1) * l].iter_mut().zip(&rowf[a..]) {
                *gv += ra * rb;
            }
        }
    }
    for a in 0..l {
        for b in 0..a {
            g[a * l + b] = g[b * l + a];
        }
    }
    let (evals, evecs) = sym_eig(&g, l);
    let order: Vec<usize> = (0..l).rev().take(k).collect(); // descending
    let s: Vec<f64> = order.iter().map(|&j| evals[j].max(0.0).sqrt()).collect();
    // The kept eigenvectors as (l, k).
    let mut e2 = vec![0.0f64; l * k];
    for a in 0..l {
        for (i, &j) in order.iter().enumerate() {
            e2[a * k + i] = evecs[a * l + j];
        }
    }
    let project = |row: &[f32], d: &mut [f64]| {
        d.fill(0.0);
        for (&ra, e) in row.iter().zip(e2.chunks_exact(k)) {
            let ra = f64::from(ra);
            for (dv, &ev) in d.iter_mut().zip(e) {
                *dv += ra * ev;
            }
        }
    };
    let mut d = vec![0.0f64; k];
    let mut v = vec![0.0f32; t * k];
    for (br, vr) in bt.chunks_exact(l).zip(v.chunks_exact_mut(k)) {
        project(br, &mut d);
        for ((o, &dv), &sv) in vr.iter_mut().zip(&d).zip(&s) {
            *o = if sv > 0.0 { (dv / sv) as f32 } else { 0.0 };
        }
    }
    let mut u = vec![0.0f32; p * k];
    for (qr, ur) in q.chunks_exact(l).zip(u.chunks_exact_mut(k)) {
        project(qr, &mut d);
        for (o, &dv) in ur.iter_mut().zip(&d) {
            *o = dv as f32;
        }
    }
    Svd { k, u, s, v }
}

/// Standard normal draws (splitmix64 + Box-Muller).
struct Normals {
    state: u64,
    spare: Option<f32>,
}

impl Normals {
    fn new(seed: u64) -> Normals {
        Normals {
            state: seed ^ 0x5851_f42d_4c95_7f2d,
            spare: None,
        }
    }

    fn uniform(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut x = self.state;
        x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        x ^= x >> 31;
        ((x >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }

    fn next(&mut self) -> f32 {
        if let Some(v) = self.spare.take() {
            return v;
        }
        let r = (-2.0 * self.uniform().ln()).sqrt();
        let a = std::f64::consts::TAU * self.uniform();
        self.spare = Some((r * a.sin()) as f32);
        (r * a.cos()) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUANT: f32 = 64.0;

    fn quantized(y: &[f32]) -> Vec<i16> {
        y.iter().map(|&v| quantize(v, QUANT)).collect()
    }

    #[test]
    fn quantize_rounds_like_f32_round() {
        let reference = |v: f32, q: f32| -> i16 {
            if v.is_finite() {
                (v * q).round().clamp(-32767.0, 32767.0) as i16
            } else {
                0
            }
        };
        let mut values = vec![
            0.0,
            -0.0,
            0.5 / QUANT,
            -0.5 / QUANT,
            1.5 / QUANT,
            -2.5 / QUANT,
            0.499_999_97 / QUANT,
            511.99,
            -511.99,
            512.0,
            -600.0,
            1e30,
            -1e30,
            f32::MAX,
            f32::MIN_POSITIVE,
            f32::NAN,
            f32::INFINITY,
            f32::NEG_INFINITY,
        ];
        let mut noise = Normals::new(3);
        values.extend((0..20_000).map(|_| 40.0 * noise.next()));
        // Every half step in range, both signs.
        values.extend((-4000..4000).map(|k| (k as f32 + 0.5) / QUANT));
        for v in values {
            for q in [QUANT, 1.0, 7.3] {
                assert_eq!(quantize(v, q), reference(v, q), "v = {v}, quant = {q}");
            }
        }
    }

    /// `n_cells` Gaussian blobs with calcium-like (AR(1)) traces plus white
    /// noise of standard deviation `noise`: `(noisy, clean)` as `t x p`.
    fn synth(t: usize, side: usize, n_cells: usize, noise: f32) -> (Vec<f32>, Vec<f32>) {
        let p = side * side;
        let mut rng = Normals::new(7);
        let mut clean = vec![10.0f32; t * p];
        for c in 0..n_cells {
            let cy = (rng.uniform() * side as f64) as f32;
            let cx = (rng.uniform() * side as f64) as f32;
            let mut tr = 0.0f32;
            for i in 0..t {
                tr *= 0.9;
                if rng.uniform() < 0.03 {
                    tr += 8.0 + c as f32 * 0.1;
                }
                for y in 0..side {
                    for x in 0..side {
                        let d2 = (y as f32 - cy).powi(2) + (x as f32 - cx).powi(2);
                        clean[i * p + y * side + x] += tr * (-d2 / 18.0).exp();
                    }
                }
            }
        }
        let noisy = clean.iter().map(|&v| v + noise * rng.next()).collect();
        (noisy, clean)
    }

    #[test]
    fn keeps_the_cells_and_drops_the_noise() {
        let (t, side, n_cells) = (400, 32, 6);
        let (noisy, clean) = synth(t, side, n_cells, 1.0);
        let cfg = CompressConfig {
            window: t,
            ..CompressConfig::default()
        };
        let mut wc = WindowCompressor::new(Dims::new(side, side).unwrap(), cfg);
        let mut out = None;
        for f in noisy.chunks_exact(side * side) {
            out = wc.push(f).or(out);
        }
        let wf = out.expect("one full window");
        let rank = wf.tiles[0].rank;
        assert!((n_cells..=n_cells + 3).contains(&rank), "rank {rank}");
        // The reconstruction is closer to the clean movie than the noisy one.
        let mut frame = vec![0.0f32; side * side];
        let (mut err_rec, mut err_noisy) = (0.0f64, 0.0f64);
        for i in 0..t {
            wf.reconstruct(i, &mut frame);
            let c = &clean[i * side * side..(i + 1) * side * side];
            let n = &noisy[i * side * side..(i + 1) * side * side];
            for j in 0..c.len() {
                err_rec += f64::from(frame[j] - c[j]).powi(2);
                err_noisy += f64::from(n[j] - c[j]).powi(2);
            }
        }
        assert!(err_rec < 0.1 * err_noisy, "{err_rec} vs {err_noisy}");
        assert!(wf.bytes() * 10 < t * side * side * 4);
    }

    #[test]
    fn tile_order_and_bytes_round_trip() {
        // 2 frames of 5 x 3 px in 2 px tiles: quantize_tiles lays out each
        // tile's frames one after the other.
        let dims = Dims::new(5, 3).unwrap();
        let frames: Vec<f32> = (0..30).map(|i| i as f32).collect();
        let mut out = vec![0i16; 30];
        quantize_tiles(&frames, 2, dims, 2, 1.0, &mut out);
        let grid = tile_grid(dims, 2);
        assert_eq!(grid.len(), 6);
        assert_eq!(grid[2], (4, 0, 1, 2));
        // Tile 0 (x 0..2, y 0..2): frame 0 then frame 1.
        assert_eq!(&out[..8], &[0, 1, 5, 6, 15, 16, 20, 21]);
        // Last tile (x 4, y 2): one pixel per frame.
        assert_eq!(&out[28..], &[14, 29]);

        let (t, side) = (120, 12);
        let (noisy, _) = synth(t, side, 3, 0.5);
        let cfg = CompressConfig::default();
        let mut tf = compress_tile(&quantized(&noisy), t, side * side, &cfg, 4);
        (tf.x0, tf.y0, tf.w, tf.h) = (64, 128, side, side);
        let back = TileFactors::from_bytes(&tf.to_bytes()).expect("decodes");
        assert_eq!((back.x0, back.y0, back.w, back.h), (64, 128, side, side));
        assert_eq!((back.rank, back.svd_rank), (tf.rank, tf.svd_rank));
        assert_eq!(back.spatial, tf.spatial);
        assert_eq!(back.temporal, tf.temporal);
        assert_eq!(back.mean, tf.mean);
        assert_eq!(back.energy, tf.energy);
        let bytes = tf.to_bytes();
        assert!(TileFactors::from_bytes(&bytes[..bytes.len() - 1]).is_none());
    }

    #[test]
    fn a_window_file_round_trips_and_rejects_bad_input() {
        let (t, w, h) = (90, 20, 12);
        let dims = Dims::new(w, h).unwrap();
        let mut frames = Vec::new();
        for i in 0..t {
            for p in 0..w * h {
                let (a, b) = (i as f32 / 7.0, p as f32 / 13.0);
                frames.push(30.0 + 6.0 * a.sin() * b.cos() + 2.0 * (0.4 * a).cos() * b.sin());
            }
        }
        let cfg = CompressConfig {
            tile: 8,
            window: t,
            ..CompressConfig::default()
        };
        let mut wc = WindowCompressor::new(dims, cfg);
        let mut wf = None;
        for f in frames.chunks_exact(w * h) {
            wf = wc.push(f).or(wf);
        }
        let mut wf = wf.expect("one window");
        wf.start = 1200;
        let bytes = wf.to_bytes(8);
        let back = WindowFactors::from_bytes(&bytes).expect("decodes");
        assert_eq!((back.start, back.frames, back.tiles.len()), (1200, t, 6));
        // Rebuilding a range from the decoded window gives the frames back.
        let mut out = vec![0.0f32; 3 * w * h];
        back.reconstruct_range(40, 3, &mut out);
        let want = &frames[40 * w * h..43 * w * h];
        let worst = out
            .iter()
            .zip(want)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 0.1, "worst error {worst}");
        assert!(WindowFactors::from_bytes(&bytes[..bytes.len() - 3]).is_none());
        let mut bad = bytes.clone();
        bad[8..12].copy_from_slice(&10u32.to_le_bytes()); // frame narrower than its tiles
        assert!(WindowFactors::from_bytes(&bad).is_none());
    }

    #[test]
    fn white_noise_keeps_one_component() {
        let (t, side) = (300, 16);
        let mut rng = Normals::new(3);
        let y: Vec<f32> = (0..t * side * side).map(|_| rng.next()).collect();
        let cfg = CompressConfig::default();
        let tf = compress_tile(&quantized(&y), t, side * side, &cfg, 1);
        assert_eq!(tf.rank, 1);
    }

    #[test]
    fn an_exactly_low_rank_tile_is_recovered() {
        // Rank 3 with smooth time courses: the factors reproduce it to the
        // quantization step, and the energy bookkeeping agrees.
        let (t, p) = (700, 400); // more than one CHUNK
        let mut y = vec![0.0f32; t * p];
        for i in 0..t {
            for j in 0..p {
                let (a, b) = (i as f32 / 40.0, j as f32 / 30.0);
                y[i * p + j] = 20.0
                    + 9.0 * a.sin() * b.cos()
                    + 5.0 * (0.7 * a).cos() * (2.0 * b).sin()
                    + 3.0 * (1.9 * a).sin() * (3.0 * b).cos();
            }
        }
        let tf = compress_tile(&quantized(&y), t, p, &CompressConfig::default(), 5);
        assert!((3..=5).contains(&tf.rank), "rank {}", tf.rank);
        let mut worst = 0.0f32;
        for i in (0..t).step_by(37) {
            let v = &tf.temporal[i * tf.rank..(i + 1) * tf.rank];
            for j in (0..p).step_by(11) {
                let w = &tf.spatial[j * tf.rank..(j + 1) * tf.rank];
                let rec = tf.mean[j] + w.iter().zip(v).map(|(x, y)| x * y).sum::<f32>();
                worst = worst.max((rec - y[i * p + j]).abs());
            }
        }
        assert!(worst < 2.0 / QUANT, "worst error {worst}");
        assert!((tf.kept_energy / tf.energy - 1.0).abs() < 1e-3);
    }

    #[test]
    fn projections_match_the_frames() {
        // ãᵀ y from the factors equals ãᵀ of the reconstructed frame.
        let (t, side) = (200, 24);
        let (noisy, _) = synth(t, side, 4, 0.5);
        let p = side * side;
        let tf = compress_tile(&quantized(&noisy), t, p, &CompressConfig::default(), 2);
        let a: Vec<f32> = (0..p).map(|i| ((i % 7) as f32) / 7.0).collect();
        let aw: Vec<f32> = (0..tf.rank)
            .map(|c| (0..p).map(|i| a[i] * tf.spatial[i * tf.rank + c]).sum())
            .collect();
        let am: f32 = a.iter().zip(&tf.mean).map(|(x, m)| x * m).sum();
        for i in [0, 57, 199] {
            let v = &tf.temporal[i * tf.rank..(i + 1) * tf.rank];
            let fast: f32 = am + aw.iter().zip(v).map(|(x, y)| x * y).sum::<f32>();
            let mut slow = 0.0f32;
            for (j, &aj) in a.iter().enumerate() {
                let w = &tf.spatial[j * tf.rank..(j + 1) * tf.rank];
                let rec = tf.mean[j] + w.iter().zip(v).map(|(x, y)| x * y).sum::<f32>();
                slow += aj * rec;
            }
            assert!(
                (fast - slow).abs() < 1e-2 * slow.abs().max(1.0),
                "{fast} {slow}"
            );
        }
    }
}
