//! History review: cells the slow loop missed, found in the compressed
//! session history.
//!
//! # Why
//!
//! The slow loop's add test judges a candidate on the frames a tile's
//! reservoir holds. A dim cell is invisible in any such sample, but it
//! repeats over minutes. The factors of [`super::WindowCompressor`] keep the
//! whole session, so a test on them can use all of it and be its own noise
//! reference.
//!
//! # The test at one spot
//!
//! On a square patch around the spot, the library's cells and a smooth
//! background (polynomial of order 2) are removed from every frame by least
//! squares. The windows are split into two halves (even and odd). Each half
//! gives the leading spatial pattern of what is left, within a disk around
//! the spot. A noise pattern does not repeat, a cell's does:
//!
//! * `cos`: cosine between the two halves' patterns;
//! * `gain`: variance one half's pattern explains in the other half's
//!   frames, over the patch's average direction;
//! * `events`: calcium-like (positive only) events of one half's pattern in
//!   the other half's frames, per 1000 frames (the smaller of the two);
//! * `width`, `shift`: Gaussian width of the summed pattern and its peak's
//!   distance from the spot, px;
//! * `neighbour_corr`: largest correlation between the pattern's time
//!   course and a library cell's, the pattern fitted jointly with the model
//!   (the leftover of an imperfect footprint follows its cell).
//!
//! `gain` and `events` are thresholded in MADs of their own values at spots
//! far from every library cell ([`candidates`]).
//!
//! # No frames are rebuilt
//!
//! A window's frames on the patch are `X = C Sᵀ` (`C`: the time courses of
//! the tiles under the patch, `S`: their spatial factors on the patch).
//! Removing the model is a projection of `S` (`A = P⊥ S`), and every
//! statistic needs only `A`, the small Gram matrix `G = Cᵀ C` and, for the
//! event score, one time course `C (Aᵀ h)`.

// Index loops over factor columns read more clearly here.
#![allow(clippy::needless_range_loop)]

use super::{TileFactors, WindowFactors};
use crate::preprocess::Dims;
use crate::trace::Footprint;

/// Polynomial order of the background removed from every frame.
const BG_ORDER: usize = 2;
/// Power iterations for a half's leading pattern.
const POWER_ITERATIONS: usize = 60;
/// Values before a candidate's footprint in the wire format.
const WIRE_HEADER: usize = 6;

/// Settings of the review. Pixel sizes suit somata of about 10 px.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewConfig {
    /// Half the patch edge, px (patch: `2 * patch_half + 1`).
    pub patch_half: usize,
    /// The pattern is looked for within this radius of the spot, px.
    pub disk_px: f32,
    /// Grid step of the scan, px.
    pub stride: usize,
    /// Spots stay within this share of the frame's short side from its
    /// centre.
    pub fov_share: f32,
    /// Shape: the halves' patterns agree and look like one cell at the spot.
    pub min_cos: f32,
    pub max_width_px: f32,
    pub max_shift_px: f32,
    /// `gain` and `events` in MADs above the background spots' median.
    pub min_gain_z: f32,
    pub min_events_z: f32,
    /// A candidate's time course does not follow a library cell's; within
    /// `on_cell_px` of a library cell the stricter bound applies.
    pub max_neighbour_corr: f32,
    pub max_neighbour_corr_on_cell: f32,
    pub on_cell_px: f32,
    /// Background spots are at least this far from every library cell, px.
    pub background_px: f32,
    /// Candidates closer than this are one, px.
    pub cluster_px: f32,
    /// Fewest windows for a review (each half needs two).
    pub min_windows: usize,
    /// Threads sharing the scan (1 on wasm).
    pub threads: usize,
}

impl Default for ReviewConfig {
    fn default() -> ReviewConfig {
        ReviewConfig {
            patch_half: 14,
            disk_px: 7.0,
            stride: 4,
            fov_share: 0.44,
            min_cos: 0.9,
            max_width_px: 3.3,
            max_shift_px: 3.0,
            min_gain_z: 5.0,
            min_events_z: 5.0,
            max_neighbour_corr: 0.6,
            max_neighbour_corr_on_cell: 0.3,
            on_cell_px: 4.0,
            background_px: 10.0,
            cluster_px: 6.0,
            min_windows: 4,
            threads: 1,
        }
    }
}

/// A library cell: pixel indices (row-major in the frame) and unfiltered
/// values.
#[derive(Debug, Clone, Copy)]
pub struct KnownCell<'a> {
    pub pix: &'a [u32],
    pub val: &'a [f32],
}

/// The statistics of one grid spot (module docs).
#[derive(Debug, Clone)]
pub struct SpotStats {
    pub y: usize,
    pub x: usize,
    pub cos: f32,
    pub gain: f32,
    pub events: f32,
    pub width: f32,
    pub shift: f32,
    pub neighbour_corr: f32,
    /// Top-left corner of the patch.
    pub y0: usize,
    pub x0: usize,
    /// The two halves' summed pattern on the patch (positive part; kept only
    /// for spots that pass the shape rule).
    pub pattern: Option<Vec<f32>>,
}

/// A cell the history shows and the library does not have.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// Peak of the pattern (row, column), px.
    pub center: (f32, f32),
    pub gain_z: f32,
    pub events_z: f32,
    /// The pattern as an unfiltered footprint (peak 1); its `id` is 0.
    pub footprint: Footprint,
}

/// Scan the field of view and return the candidates (module docs). Empty
/// with fewer than `min_windows` windows.
pub fn review(
    windows: &[WindowFactors],
    cells: &[KnownCell],
    dims: Dims,
    cfg: &ReviewConfig,
) -> Vec<Candidate> {
    let stats = scan(windows, cells, dims, cfg);
    candidates(&stats, cells, dims, cfg)
}

/// The statistics of every grid spot in the field of view.
pub fn scan(
    windows: &[WindowFactors],
    cells: &[KnownCell],
    dims: Dims,
    cfg: &ReviewConfig,
) -> Vec<SpotStats> {
    let rows = scan_rows(windows, dims, cfg);
    let threads = if cfg!(target_arch = "wasm32") {
        1
    } else {
        cfg.threads.clamp(1, rows.len().max(1))
    };
    if threads == 1 {
        return scan_band(windows, cells, dims, cfg, &rows);
    }
    // Contiguous bands of rows, so a thread's tile-group cache keeps hitting.
    let per = rows.len().div_ceil(threads);
    std::thread::scope(|s| {
        let hs: Vec<_> = rows
            .chunks(per)
            .map(|c| s.spawn(move || scan_band(windows, cells, dims, cfg, c)))
            .collect();
        hs.into_iter()
            .flat_map(|h| h.join().expect("review thread"))
            .collect()
    })
}

/// The grid rows [`scan`] visits, top to bottom. Empty when the history
/// cannot be reviewed: fewer than `min_windows` windows, a frame smaller
/// than a patch, or windows with different tiles.
pub fn scan_rows(windows: &[WindowFactors], dims: Dims, cfg: &ReviewConfig) -> Vec<usize> {
    let size = 2 * cfg.patch_half + 1;
    if windows.len() < cfg.min_windows.max(4)
        || dims.height < size
        || dims.width < size
        || !same_layout(windows)
    {
        return Vec::new();
    }
    (0..dims.height).step_by(cfg.stride.max(1)).collect()
}

/// The part of [`scan`] on the grid rows `rows` (some of [`scan_rows`]).
/// Bands scanned one after the other, in order, give the statistics of
/// `scan`; a caller that must not block for a whole review scans a few rows
/// at a time.
pub fn scan_band(
    windows: &[WindowFactors],
    cells: &[KnownCell],
    dims: Dims,
    cfg: &ReviewConfig,
    rows: &[usize],
) -> Vec<SpotStats> {
    if rows.is_empty() {
        return Vec::new();
    }
    let ctx = Context::new(windows, cells, dims, cfg);
    let (cy, cx) = (dims.height as f32 / 2.0, dims.width as f32 / 2.0);
    let radius = cfg.fov_share * dims.height.min(dims.width) as f32;
    let mut cache = GroupCache::default();
    let mut out = Vec::new();
    for &y in rows {
        for x in (0..dims.width).step_by(cfg.stride.max(1)) {
            if (y as f32 - cy).hypot(x as f32 - cx) <= radius {
                out.push(ctx.spot(y, x, &mut cache));
            }
        }
    }
    out
}

/// Candidates as one `f32` array, for a message between workers: per
/// candidate `[y0, x0, height, width, gain_z, events_z]`, then the
/// footprint's `height * width` values.
pub fn candidates_to_wire(found: &[Candidate]) -> Vec<f32> {
    let mut out = Vec::new();
    for c in found {
        let fp = &c.footprint;
        out.extend([
            fp.y0 as f32,
            fp.x0 as f32,
            fp.height as f32,
            fp.width as f32,
            c.gain_z,
            c.events_z,
        ]);
        out.extend_from_slice(&fp.values);
    }
    out
}

/// The footprints (id 0) in [`candidates_to_wire`] data; `None` when it is
/// cut short or a header is not a whole, non-negative number.
pub fn footprints_from_wire(wire: &[f32]) -> Option<Vec<Footprint>> {
    let whole = |v: f32| (v >= 0.0 && v.fract() == 0.0 && v < 16_777_216.0).then_some(v as usize);
    let mut out = Vec::new();
    let mut at = 0;
    while at < wire.len() {
        let head = wire.get(at..at + WIRE_HEADER)?;
        let (y0, x0, height, width) = (
            whole(head[0])?,
            whole(head[1])?,
            whole(head[2])?,
            whole(head[3])?,
        );
        at += WIRE_HEADER;
        let values = wire.get(at..at + height * width)?.to_vec();
        at += height * width;
        out.push(Footprint {
            id: 0,
            y0,
            x0,
            height,
            width,
            values,
        });
    }
    Some(out)
}

/// The candidates among scanned spots: shape rule, `gain` and `events` in
/// MADs above the background spots, not following a neighbour; the
/// strongest of every cluster.
pub fn candidates(
    stats: &[SpotStats],
    cells: &[KnownCell],
    dims: Dims,
    cfg: &ReviewConfig,
) -> Vec<Candidate> {
    let centres: Vec<(f32, f32)> = cells.iter().map(|c| centroid(c, dims.width)).collect();
    let dlib: Vec<f32> = stats
        .iter()
        .map(|s| {
            centres
                .iter()
                .map(|c| (c.0 - s.y as f32).hypot(c.1 - s.x as f32))
                .fold(f32::INFINITY, f32::min)
        })
        .collect();
    let bg: Vec<usize> = (0..stats.len())
        .filter(|&i| dlib[i] >= cfg.background_px)
        .collect();
    if bg.len() < 30 {
        return Vec::new();
    }
    let scale = |f: fn(&SpotStats) -> f32| -> Option<(f32, f32)> {
        let mut v: Vec<f32> = bg.iter().map(|&i| f(&stats[i])).collect();
        let med = median(&mut v);
        let mut dev: Vec<f32> = v.iter().map(|x| (x - med).abs()).collect();
        let mad = 1.4826 * median(&mut dev);
        (mad > 0.0).then_some((med, mad))
    };
    let (Some(g), Some(e)) = (scale(|s| s.gain), scale(|s| s.events)) else {
        return Vec::new();
    };
    let z = |v: f32, (med, mad): (f32, f32)| (v - med) / mad;
    let mut pass: Vec<(usize, f32, f32)> = stats
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let (gz, ez) = (z(s.gain, g), z(s.events, e));
            let ok = s.pattern.is_some()
                && gz >= cfg.min_gain_z
                && ez >= cfg.min_events_z
                && s.neighbour_corr < cfg.max_neighbour_corr
                && (dlib[i] > cfg.on_cell_px || s.neighbour_corr < cfg.max_neighbour_corr_on_cell);
            ok.then_some((i, gz, ez))
        })
        .collect();
    pass.sort_by(|a, b| b.1.total_cmp(&a.1));
    let size = 2 * cfg.patch_half + 1;
    let mut out: Vec<Candidate> = Vec::new();
    let mut kept: Vec<(f32, f32)> = Vec::new();
    for (i, gz, ez) in pass {
        let s = &stats[i];
        let here = (s.y as f32, s.x as f32);
        if kept
            .iter()
            .any(|k| (k.0 - here.0).hypot(k.1 - here.1) <= cfg.cluster_px)
        {
            continue;
        }
        kept.push(here);
        let pattern = s.pattern.as_ref().expect("pattern");
        let (peak, top) =
            pattern
                .iter()
                .enumerate()
                .fold((0, 0.0f32), |b, (k, &v)| if v > b.1 { (k, v) } else { b });
        if top <= 0.0 {
            continue;
        }
        out.push(Candidate {
            center: ((s.y0 + peak / size) as f32, (s.x0 + peak % size) as f32),
            gain_z: gz,
            events_z: ez,
            footprint: Footprint {
                id: 0,
                y0: s.y0,
                x0: s.x0,
                height: size,
                width: size,
                values: pattern.iter().map(|v| v / top).collect(),
            },
        });
    }
    out
}

/// Every window has the same tiles in the same order.
fn same_layout(windows: &[WindowFactors]) -> bool {
    let rect = |t: &TileFactors| (t.x0, t.y0, t.w, t.h);
    let first: Vec<_> = windows[0].tiles.iter().map(rect).collect();
    windows
        .iter()
        .all(|w| w.tiles.len() == first.len() && w.tiles.iter().map(rect).eq(first.iter().copied()))
}

fn centroid(c: &KnownCell, width: usize) -> (f32, f32) {
    let (mut sy, mut sx, mut m) = (0.0f64, 0.0f64, 0.0f64);
    for (&p, &v) in c.pix.iter().zip(c.val) {
        let v = f64::from(v);
        sy += v * (p as usize / width) as f64;
        sx += v * (p as usize % width) as f64;
        m += v;
    }
    if m > 0.0 {
        ((sy / m) as f32, (sx / m) as f32)
    } else {
        (f32::NEG_INFINITY, f32::NEG_INFINITY)
    }
}

/// Median (of the two middle values for an even count); sorts `v`.
fn median(v: &mut [f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(f32::total_cmp);
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

fn median64(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

/// Event evidence of a time course per 1000 frames: squared excess above
/// 3 σ minus squared excess below −3 σ, σ being the noise below the median
/// (calcium events are positive only; noise and motion residue are
/// symmetric).
fn asym_events(c: &[f64]) -> f64 {
    if c.is_empty() {
        return 0.0;
    }
    let med = median64(&mut c.to_vec());
    let (mut low, mut n_low) = (0.0f64, 0usize);
    for &v in c {
        if v < med {
            low += (v - med) * (v - med);
            n_low += 1;
        }
    }
    if n_low == 0 || low <= 0.0 {
        return 0.0;
    }
    let noise = (low / n_low as f64).sqrt();
    let (mut pos, mut neg) = (0.0f64, 0.0f64);
    for &v in c {
        let z = (v - med) / noise;
        pos += (z - 3.0).max(0.0).powi(2);
        neg += (-z - 3.0).max(0.0).powi(2);
    }
    1000.0 * (pos - neg) / c.len() as f64
}

/// `(σ of the positive part around its peak, the peak's distance from the
/// patch centre)`, px.
fn pattern_shape(h: &[f32], size: usize) -> (f32, f32) {
    let (peak, _) = h
        .iter()
        .enumerate()
        .fold((0, 0.0f32), |b, (k, &v)| if v > b.1 { (k, v) } else { b });
    let (py, px) = ((peak / size) as f64, (peak % size) as f64);
    let half = (size / 2) as f64;
    let (mut m, mut s) = (0.0f64, 0.0f64);
    for (k, &v) in h.iter().enumerate() {
        let r2 = ((k / size) as f64 - py).powi(2) + ((k % size) as f64 - px).powi(2);
        if v > 0.0 && r2 <= half * half {
            m += f64::from(v);
            s += f64::from(v) * r2;
        }
    }
    let sigma = if m > 0.0 { (s / (2.0 * m)).sqrt() } else { 0.0 };
    (sigma as f32, (py - half).hypot(px - half) as f32)
}

/// Cholesky factor (lower, row-major) of a symmetric positive matrix with a
/// small ridge; the ridge grows until the factorisation succeeds.
fn cholesky(a: &[f64], n: usize) -> Vec<f64> {
    let top = (0..n)
        .map(|i| a[i * n + i])
        .fold(0.0f64, f64::max)
        .max(1e-30);
    let mut ridge = 1e-10 * top;
    loop {
        let mut l = vec![0.0f64; n * n];
        let mut ok = true;
        'rows: for i in 0..n {
            for j in 0..=i {
                let mut s = a[i * n + j] + if i == j { ridge } else { 0.0 };
                for k in 0..j {
                    s -= l[i * n + k] * l[j * n + k];
                }
                if i == j {
                    if s <= 0.0 {
                        ok = false;
                        break 'rows;
                    }
                    l[i * n + i] = s.sqrt();
                } else {
                    l[i * n + j] = s / l[j * n + j];
                }
            }
        }
        if ok {
            return l;
        }
        ridge *= 100.0;
    }
}

/// Solve `L Lᵀ x = b` in place.
fn chol_solve(l: &[f64], n: usize, b: &mut [f64]) {
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i {
            s -= l[i * n + k] * b[k];
        }
        b[i] = s / l[i * n + i];
    }
    for i in (0..n).rev() {
        let mut s = b[i];
        for k in i + 1..n {
            s -= l[k * n + i] * b[k];
        }
        b[i] = s / l[i * n + i];
    }
}

/// `Cᵀ C` and the column sums of the time courses of a group of tiles, per
/// window. Columns are the tiles' components in the group's order.
struct Gram {
    /// Total rank and each tile's first column.
    rank: usize,
    offsets: Vec<usize>,
    g: Vec<f64>,
    sums: Vec<f64>,
}

/// The Gram matrices of the tile group the last spot used.
#[derive(Default)]
struct GroupCache {
    tiles: Vec<usize>,
    grams: Vec<Gram>,
}

/// One window's factors at a spot, with the model removed.
struct SpotWindow {
    /// `A` on the disk: `D x rank`.
    a: Vec<f32>,
    /// `S` on the disk: `D x rank`.
    s: Vec<f32>,
    /// `Mᵀ S` and `M⁺ S`: `m x rank`.
    z: Vec<f64>,
    w: Vec<f64>,
}

struct Context<'a> {
    windows: &'a [WindowFactors],
    cells: &'a [KnownCell<'a>],
    /// Bounding box of each cell: `(y0, x0, y1, x1)`, inclusive.
    boxes: Vec<(usize, usize, usize, usize)>,
    dims: Dims,
    cfg: &'a ReviewConfig,
    size: usize,
    /// Patch indices of the disk.
    disk: Vec<usize>,
    /// The background columns, `n_bg x size²`.
    bg: Vec<Vec<f32>>,
}

impl<'a> Context<'a> {
    fn new(
        windows: &'a [WindowFactors],
        cells: &'a [KnownCell<'a>],
        dims: Dims,
        cfg: &'a ReviewConfig,
    ) -> Context<'a> {
        let size = 2 * cfg.patch_half + 1;
        let half = cfg.patch_half as f32;
        let disk = (0..size * size)
            .filter(|&k| ((k / size) as f32 - half).hypot((k % size) as f32 - half) <= cfg.disk_px)
            .collect();
        let g: Vec<f32> = (0..size)
            .map(|i| -1.0 + 2.0 * i as f32 / (size - 1) as f32)
            .collect();
        let mut bg = Vec::new();
        for a in 0..=BG_ORDER {
            for b in 0..=BG_ORDER - a {
                bg.push(
                    (0..size * size)
                        .map(|k| g[k / size].powi(a as i32) * g[k % size].powi(b as i32))
                        .collect(),
                );
            }
        }
        let boxes = cells
            .iter()
            .map(|c| {
                let mut b = (usize::MAX, usize::MAX, 0, 0);
                for &p in c.pix {
                    let (y, x) = (p as usize / dims.width, p as usize % dims.width);
                    b = (b.0.min(y), b.1.min(x), b.2.max(y), b.3.max(x));
                }
                b
            })
            .collect();
        Context {
            windows,
            cells,
            boxes,
            dims,
            cfg,
            size,
            disk,
            bg,
        }
    }

    /// The model on the patch at `(y0, x0)`: library cells with at least 4
    /// pixels there, then the background. Returns the columns and the
    /// number of cells.
    fn model(&self, y0: usize, x0: usize) -> (Vec<Vec<f32>>, usize) {
        let size = self.size;
        let mut cols: Vec<Vec<f32>> = Vec::new();
        for (c, b) in self.cells.iter().zip(&self.boxes) {
            if b.2 < y0 || b.0 >= y0 + size || b.3 < x0 || b.1 >= x0 + size {
                continue;
            }
            let mut col = vec![0.0f32; size * size];
            let mut n = 0;
            for (&p, &v) in c.pix.iter().zip(c.val) {
                let (y, x) = (p as usize / self.dims.width, p as usize % self.dims.width);
                if y >= y0 && y < y0 + size && x >= x0 && x < x0 + size {
                    col[(y - y0) * size + (x - x0)] = v;
                    n += 1;
                }
            }
            if n >= 4 {
                cols.push(col);
            }
        }
        let n_cells = cols.len();
        cols.extend(self.bg.iter().cloned());
        (cols, n_cells)
    }

    /// Indices of the tiles under the patch.
    fn group(&self, y0: usize, x0: usize) -> Vec<usize> {
        let size = self.size;
        self.windows[0]
            .tiles
            .iter()
            .enumerate()
            .filter(|(_, t)| {
                t.y0 < y0 + size && y0 < t.y0 + t.h && t.x0 < x0 + size && x0 < t.x0 + t.w
            })
            .map(|(i, _)| i)
            .collect()
    }

    fn gram(&self, win: &WindowFactors, tiles: &[usize]) -> Gram {
        let mut offsets = Vec::with_capacity(tiles.len());
        let mut rank = 0;
        for &i in tiles {
            offsets.push(rank);
            rank += win.tiles[i].rank;
        }
        let mut g = vec![0.0f64; rank * rank];
        let mut sums = vec![0.0f64; rank];
        for (ia, &ta) in tiles.iter().enumerate() {
            let a = &win.tiles[ta];
            for t in 0..win.frames {
                for r in 0..a.rank {
                    sums[offsets[ia] + r] += f64::from(a.temporal[t * a.rank + r]);
                }
            }
            for (ib, &tb) in tiles.iter().enumerate().skip(ia) {
                let b = &win.tiles[tb];
                for t in 0..win.frames {
                    let ra = &a.temporal[t * a.rank..(t + 1) * a.rank];
                    let rb = &b.temporal[t * b.rank..(t + 1) * b.rank];
                    for (i, &u) in ra.iter().enumerate() {
                        let row = (offsets[ia] + i) * rank + offsets[ib];
                        for (j, &v) in rb.iter().enumerate() {
                            g[row + j] += f64::from(u) * f64::from(v);
                        }
                    }
                }
            }
        }
        for i in 0..rank {
            for j in 0..i {
                g[i * rank + j] = g[j * rank + i];
            }
        }
        Gram {
            rank,
            offsets,
            g,
            sums,
        }
    }

    /// The time course `C v` of a window (`v`: one weight per column of the
    /// group), appended to `out`.
    fn time_course(
        &self,
        win: &WindowFactors,
        tiles: &[usize],
        gram: &Gram,
        v: &[f64],
        out: &mut Vec<f64>,
    ) {
        let base = out.len();
        out.resize(base + win.frames, 0.0);
        for (k, &ti) in tiles.iter().enumerate() {
            let t = &win.tiles[ti];
            let w = &v[gram.offsets[k]..gram.offsets[k] + t.rank];
            for f in 0..win.frames {
                let row = &t.temporal[f * t.rank..(f + 1) * t.rank];
                let mut s = 0.0f64;
                for (&a, &b) in row.iter().zip(w) {
                    s += f64::from(a) * b;
                }
                out[base + f] += s;
            }
        }
    }

    /// The statistics of the spot at `(y, x)`.
    fn spot(&self, y: usize, x: usize, cache: &mut GroupCache) -> SpotStats {
        let size = self.size;
        let p = size * size;
        let half = self.cfg.patch_half;
        let y0 = y.saturating_sub(half).min(self.dims.height - size);
        let x0 = x.saturating_sub(half).min(self.dims.width - size);
        let d = self.disk.len();
        let (cols, n_cells) = self.model(y0, x0);
        let m = cols.len();
        // (MᵀM)⁻¹ through its Cholesky factor.
        let mut mtm = vec![0.0f64; m * m];
        for i in 0..m {
            for j in 0..=i {
                let s: f64 = cols[i]
                    .iter()
                    .zip(&cols[j])
                    .map(|(&a, &b)| f64::from(a) * f64::from(b))
                    .sum();
                mtm[i * m + j] = s;
                mtm[j * m + i] = s;
            }
        }
        let chol = cholesky(&mtm, m);
        // The model on the disk: `D x m`.
        let m_disk: Vec<f32> = self
            .disk
            .iter()
            .flat_map(|&k| cols.iter().map(move |c| c[k]))
            .collect();
        let tiles = self.group(y0, x0);
        if cache.tiles != tiles {
            cache.grams = self.windows.iter().map(|w| self.gram(w, &tiles)).collect();
            cache.tiles = tiles.clone();
        }
        let grams = &cache.grams;
        let mut wins: Vec<SpotWindow> = Vec::with_capacity(self.windows.len());
        let mut s_patch: Vec<f32> = Vec::new();
        for (win, gram) in self.windows.iter().zip(grams) {
            let r = gram.rank;
            s_patch.clear();
            s_patch.resize(p * r, 0.0);
            for (k, &ti) in tiles.iter().enumerate() {
                let t = &win.tiles[ti];
                let off = gram.offsets[k];
                let (ya, yb) = (y0.max(t.y0), (y0 + size).min(t.y0 + t.h));
                let (xa, xb) = (x0.max(t.x0), (x0 + size).min(t.x0 + t.w));
                for yy in ya..yb {
                    for xx in xa..xb {
                        let src = ((yy - t.y0) * t.w + (xx - t.x0)) * t.rank;
                        let dst = ((yy - y0) * size + (xx - x0)) * r + off;
                        s_patch[dst..dst + t.rank].copy_from_slice(&t.spatial[src..src + t.rank]);
                    }
                }
            }
            // Z = Mᵀ S, W = (MᵀM)⁻¹ Z.
            let mut z = vec![0.0f64; m * r];
            for (k, col) in cols.iter().enumerate() {
                let zr = &mut z[k * r..(k + 1) * r];
                for (i, &c) in col.iter().enumerate() {
                    if c != 0.0 {
                        let c = f64::from(c);
                        for (o, &s) in zr.iter_mut().zip(&s_patch[i * r..(i + 1) * r]) {
                            *o += c * f64::from(s);
                        }
                    }
                }
            }
            let mut w = z.clone();
            let mut rhs = vec![0.0f64; m];
            for j in 0..r {
                for k in 0..m {
                    rhs[k] = z[k * r + j];
                }
                chol_solve(&chol, m, &mut rhs);
                for k in 0..m {
                    w[k * r + j] = rhs[k];
                }
            }
            // A = S − M W on the disk.
            let mut s = vec![0.0f32; d * r];
            let mut a = vec![0.0f32; d * r];
            for (di, &k) in self.disk.iter().enumerate() {
                let srow = &s_patch[k * r..(k + 1) * r];
                s[di * r..(di + 1) * r].copy_from_slice(srow);
                let arow = &mut a[di * r..(di + 1) * r];
                for (j, o) in arow.iter_mut().enumerate() {
                    let mut v = f64::from(srow[j]);
                    for c in 0..m {
                        v -= f64::from(m_disk[di * m + c]) * w[c * r + j];
                    }
                    *o = v as f32;
                }
            }
            wins.push(SpotWindow { a, s, z, w });
        }
        // out = Σ_w A G (Aᵀ v) over one half's windows.
        let apply = |half_id: usize, v: &[f64], out: &mut [f64]| {
            out.fill(0.0);
            for (k, (sw, gram)) in wins.iter().zip(grams).enumerate() {
                if k % 2 != half_id {
                    continue;
                }
                let r = gram.rank;
                let mut t = vec![0.0f64; r];
                for (di, &vd) in v.iter().enumerate() {
                    for (o, &a) in t.iter_mut().zip(&sw.a[di * r..(di + 1) * r]) {
                        *o += vd * f64::from(a);
                    }
                }
                let mut t2 = vec![0.0f64; r];
                for i in 0..r {
                    let row = &gram.g[i * r..(i + 1) * r];
                    t2[i] = row.iter().zip(&t).map(|(a, b)| a * b).sum();
                }
                for (di, o) in out.iter_mut().enumerate() {
                    let mut sacc = 0.0f64;
                    for (&a, &b) in sw.a[di * r..(di + 1) * r].iter().zip(&t2) {
                        sacc += f64::from(a) * b;
                    }
                    *o += sacc;
                }
            }
        };
        let leading = |half_id: usize| -> Vec<f64> {
            let c = half as f64;
            let mut v: Vec<f64> = self
                .disk
                .iter()
                .map(|&k| {
                    let r2 = ((k / size) as f64 - c).powi(2) + ((k % size) as f64 - c).powi(2);
                    (-r2 / 18.0).exp()
                })
                .collect();
            let mut next = vec![0.0f64; d];
            for _ in 0..POWER_ITERATIONS {
                apply(half_id, &v, &mut next);
                let norm = next.iter().map(|x| x * x).sum::<f64>().sqrt();
                if norm <= 0.0 {
                    break;
                }
                let mut change = 0.0f64;
                for (a, b) in v.iter_mut().zip(&next) {
                    let n = b / norm;
                    change += (n - *a) * (n - *a);
                    *a = n;
                }
                if change < 1e-12 {
                    break;
                }
            }
            let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt().max(1e-30);
            let sign = if v.iter().sum::<f64>() >= 0.0 {
                1.0
            } else {
                -1.0
            };
            v.iter().map(|x| sign * x / norm).collect()
        };
        let ha = leading(0);
        let mut hb = leading(1);
        let mut dot: f64 = ha.iter().zip(&hb).map(|(a, b)| a * b).sum();
        if dot < 0.0 {
            hb.iter_mut().for_each(|v| *v = -*v);
            dot = -dot;
        }
        // Each half's frames on the other half's pattern, and the energies.
        let (mut ca, mut cb) = (Vec::new(), Vec::new());
        let mut energy = 0.0f64;
        for (k, ((sw, gram), win)) in wins.iter().zip(grams).zip(self.windows).enumerate() {
            let r = gram.rank;
            let other = if k % 2 == 0 { &hb } else { &ha };
            let mut v = vec![0.0f64; r];
            for (di, &h) in other.iter().enumerate() {
                let arow = &sw.a[di * r..(di + 1) * r];
                for (o, &a) in v.iter_mut().zip(arow) {
                    *o += h * f64::from(a);
                }
                // tr(A G Aᵀ), row by row.
                for i in 0..r {
                    let ai = f64::from(arow[i]);
                    if ai != 0.0 {
                        let grow = &gram.g[i * r..(i + 1) * r];
                        let mut s = 0.0f64;
                        for (&g, &a) in grow.iter().zip(arow) {
                            s += g * f64::from(a);
                        }
                        energy += ai * s;
                    }
                }
            }
            let out = if k % 2 == 0 { &mut ca } else { &mut cb };
            self.time_course(win, &tiles, gram, &v, out);
        }
        let mean_dir = energy / d as f64;
        let on_other: f64 = ca.iter().chain(&cb).map(|v| v * v).sum();
        let gain = if mean_dir > 0.0 {
            on_other / mean_dir
        } else {
            0.0
        };
        let mut h_img = vec![0.0f32; p];
        for (di, &k) in self.disk.iter().enumerate() {
            h_img[k] = (ha[di] + hb[di]) as f32;
        }
        let (width, shift) = pattern_shape(&h_img, size);
        let events = asym_events(&ca).min(asym_events(&cb));
        h_img.iter_mut().for_each(|v| *v = v.max(0.0));
        let neighbour_corr = self.neighbour_corr(&h_img, &m_disk, m, n_cells, &chol, &wins, grams);
        let shaped = dot as f32 >= self.cfg.min_cos
            && width <= self.cfg.max_width_px
            && shift <= self.cfg.max_shift_px;
        SpotStats {
            y,
            x,
            cos: dot as f32,
            gain: gain as f32,
            events: events as f32,
            width,
            shift,
            neighbour_corr,
            y0,
            x0,
            pattern: shaped.then_some(h_img),
        }
    }

    /// Largest correlation between the pattern's time course and a library
    /// cell's, with the pattern `h` fitted jointly with the model: the
    /// pattern's coefficient is `h⊥·x / h⊥·h` (`h⊥ = P⊥ h`), and a cell's is
    /// its own minus `(M⁺h)` times that.
    #[allow(clippy::too_many_arguments)]
    fn neighbour_corr(
        &self,
        h: &[f32],
        m_disk: &[f32],
        m: usize,
        n_cells: usize,
        chol: &[f64],
        wins: &[SpotWindow],
        grams: &[Gram],
    ) -> f32 {
        if n_cells == 0 {
            return 0.0;
        }
        let hd: Vec<f64> = self.disk.iter().map(|&k| f64::from(h[k])).collect();
        let mut mth = vec![0.0f64; m];
        for (di, &v) in hd.iter().enumerate() {
            for (o, &c) in mth.iter_mut().zip(&m_disk[di * m..(di + 1) * m]) {
                *o += v * f64::from(c);
            }
        }
        let mut q = mth.clone();
        chol_solve(chol, m, &mut q);
        let denom = hd.iter().map(|v| v * v).sum::<f64>()
            - mth.iter().zip(&q).map(|(a, b)| a * b).sum::<f64>();
        if denom <= 1e-12 {
            return 0.0;
        }
        // Sums over all frames of the pattern's coefficient `c` and every
        // cell's `c_k`: Σc, Σc², Σc_k, Σc_k², Σc c_k.
        let (mut n, mut sc, mut scc) = (0.0f64, 0.0f64, 0.0f64);
        let mut sk = vec![0.0f64; n_cells];
        let mut skk = vec![0.0f64; n_cells];
        let mut sck = vec![0.0f64; n_cells];
        for ((sw, gram), win) in wins.iter().zip(grams).zip(self.windows) {
            let r = gram.rank;
            n += win.frames as f64;
            if r == 0 {
                continue;
            }
            let mut uc = vec![0.0f64; r];
            for (di, &v) in hd.iter().enumerate() {
                for (o, &s) in uc.iter_mut().zip(&sw.s[di * r..(di + 1) * r]) {
                    *o += v * f64::from(s);
                }
            }
            for (j, o) in uc.iter_mut().enumerate() {
                let zq: f64 = (0..m).map(|k| sw.z[k * r + j] * q[k]).sum();
                *o = (*o - zq) / denom;
            }
            let g_times = |u: &[f64]| -> Vec<f64> {
                (0..r)
                    .map(|i| {
                        gram.g[i * r..(i + 1) * r]
                            .iter()
                            .zip(u)
                            .map(|(a, b)| a * b)
                            .sum()
                    })
                    .collect()
            };
            let guc = g_times(&uc);
            let dotv = |a: &[f64], b: &[f64]| -> f64 { a.iter().zip(b).map(|(x, y)| x * y).sum() };
            sc += dotv(&gram.sums, &uc);
            scc += dotv(&uc, &guc);
            for k in 0..n_cells {
                let uk: Vec<f64> = (0..r).map(|j| sw.w[k * r + j] - q[k] * uc[j]).collect();
                sk[k] += dotv(&gram.sums, &uk);
                skk[k] += dotv(&uk, &g_times(&uk));
                sck[k] += dotv(&uk, &guc);
            }
        }
        if n <= 0.0 {
            return 0.0;
        }
        let (mc, vc) = (sc / n, (scc / n - (sc / n).powi(2)).max(0.0));
        let mut best = 0.0f64;
        for k in 0..n_cells {
            let (mk, vk) = (sk[k] / n, (skk[k] / n - (sk[k] / n).powi(2)).max(0.0));
            let cov = sck[k] / n - mc * mk;
            let r = cov / ((vc.sqrt() + 1e-9) * (vk.sqrt() + 1e-9));
            best = best.max(r.abs());
        }
        best as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::{CompressConfig, WindowCompressor};

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 40) as f32 + 0.5) / (1u64 << 24) as f32
        }
        fn normal(&mut self) -> f32 {
            (-2.0 * self.next().ln()).sqrt() * (std::f32::consts::TAU * self.next()).cos()
        }
    }

    const N: usize = 96;
    const WINDOW: usize = 200;
    /// A cell: pixel indices and values.
    type Soma = (Vec<u32>, Vec<f32>);

    /// A Gaussian soma (σ 2.5 px, peak 1) as pixel indices and values.
    fn soma(cy: f32, cx: f32) -> Soma {
        let (mut pix, mut val) = (Vec::new(), Vec::new());
        for y in 0..N {
            for x in 0..N {
                let r2 = (y as f32 - cy).powi(2) + (x as f32 - cx).powi(2);
                if r2 <= 64.0 {
                    pix.push((y * N + x) as u32);
                    val.push((-r2 / 12.5).exp());
                }
            }
        }
        (pix, val)
    }

    /// Calcium-like trace: events at random times, decaying over ~8 frames.
    fn trace(rng: &mut Lcg, t: usize, amp: f32) -> Vec<f32> {
        let mut c = vec![0.0f32; t];
        let mut level = 0.0f32;
        for v in c.iter_mut() {
            if rng.next() < 0.02 {
                level += amp;
            }
            *v = level;
            level *= 0.88;
        }
        c
    }

    /// Unit noise plus the given cells, compressed in windows of 200 frames
    /// (64 px tiles: the 96 px frame has four, so patches cross tile edges).
    fn history(cells: &[(Soma, Vec<f32>)], windows: usize) -> Vec<WindowFactors> {
        let dims = Dims::new(N, N).unwrap();
        let cfg = CompressConfig {
            window: WINDOW,
            ..CompressConfig::default()
        };
        let mut wc = WindowCompressor::new(dims, cfg);
        let mut rng = Lcg(7);
        let mut out = Vec::new();
        let mut frame = vec![0.0f32; N * N];
        for t in 0..windows * WINDOW {
            for v in frame.iter_mut() {
                *v = rng.normal();
            }
            for ((pix, val), c) in cells {
                for (&p, &a) in pix.iter().zip(val) {
                    frame[p as usize] += a * c[t];
                }
            }
            out.extend(wc.push(&frame));
        }
        out
    }

    fn movie(windows: usize) -> (Vec<WindowFactors>, [Soma; 2]) {
        let mut rng = Lcg(3);
        let t = windows * WINDOW;
        // One bright cell the library has, one dimmer cell on a tile edge
        // that it lacks.
        let (known, hidden) = (soma(30.0, 30.0), soma(60.0, 62.0));
        let cells = [
            (known.clone(), trace(&mut rng, t, 8.0)),
            (hidden.clone(), trace(&mut rng, t, 4.0)),
        ];
        (history(&cells, windows), [known, hidden])
    }

    fn known(cells: &[Soma]) -> Vec<KnownCell<'_>> {
        cells
            .iter()
            .map(|(pix, val)| KnownCell { pix, val })
            .collect()
    }

    #[test]
    fn a_cell_the_library_lacks_is_found_and_a_known_one_is_not() {
        let (windows, cells) = movie(8);
        let dims = Dims::new(N, N).unwrap();
        let cfg = ReviewConfig::default();
        let found = review(&windows, &known(&cells[..1]), dims, &cfg);
        assert_eq!(
            found.len(),
            1,
            "{:?}",
            found.iter().map(|c| c.center).collect::<Vec<_>>()
        );
        let c = found[0].center;
        assert!(
            (c.0 - 60.0).abs() <= 2.0 && (c.1 - 62.0).abs() <= 2.0,
            "{c:?}"
        );
        let fp = &found[0].footprint;
        assert_eq!(fp.values.len(), fp.height * fp.width);
        assert!(fp.values.iter().all(|v| (0.0..=1.0).contains(v)));
        // With both cells in the library nothing is left to find.
        assert!(review(&windows, &known(&cells), dims, &cfg).is_empty());
    }

    #[test]
    fn threads_do_not_change_the_result() {
        let (windows, cells) = movie(6);
        let dims = Dims::new(N, N).unwrap();
        let one = scan(
            &windows,
            &known(&cells[..1]),
            dims,
            &ReviewConfig::default(),
        );
        let four = scan(
            &windows,
            &known(&cells[..1]),
            dims,
            &ReviewConfig {
                threads: 4,
                ..ReviewConfig::default()
            },
        );
        assert_eq!(one.len(), four.len());
        for (a, b) in one.iter().zip(&four) {
            assert_eq!((a.y, a.x, a.gain, a.events), (b.y, b.x, b.gain, b.events));
        }
    }

    #[test]
    fn bands_of_rows_give_the_scan() {
        let (windows, cells) = movie(6);
        let dims = Dims::new(N, N).unwrap();
        let cfg = ReviewConfig::default();
        let whole = scan(&windows, &known(&cells[..1]), dims, &cfg);
        let rows = scan_rows(&windows, dims, &cfg);
        assert_eq!(rows.len(), N.div_ceil(cfg.stride));
        let banded: Vec<SpotStats> = rows
            .chunks(5)
            .flat_map(|band| scan_band(&windows, &known(&cells[..1]), dims, &cfg, band))
            .collect();
        assert_eq!(whole.len(), banded.len());
        for (a, b) in whole.iter().zip(&banded) {
            assert_eq!((a.y, a.x, a.gain, a.events), (b.y, b.x, b.gain, b.events));
            assert_eq!(a.pattern, b.pattern);
        }
    }

    #[test]
    fn candidates_survive_the_wire() {
        let (windows, cells) = movie(8);
        let dims = Dims::new(N, N).unwrap();
        let found = review(
            &windows,
            &known(&cells[..1]),
            dims,
            &ReviewConfig::default(),
        );
        let wire = candidates_to_wire(&found);
        let back = footprints_from_wire(&wire).unwrap();
        assert_eq!(back.len(), found.len());
        for (fp, c) in back.iter().zip(&found) {
            let want = &c.footprint;
            assert_eq!(
                (fp.id, fp.y0, fp.x0, fp.height, fp.width),
                (0, want.y0, want.x0, want.height, want.width)
            );
            assert_eq!(fp.values, want.values);
        }
        assert_eq!(wire[4], found[0].gain_z);
        assert!(footprints_from_wire(&[]).unwrap().is_empty());
        // Cut short, or a header that is no pixel count.
        assert!(footprints_from_wire(&wire[..wire.len() - 1]).is_none());
        assert!(footprints_from_wire(&[0.0, 0.0, 2.5, 2.0, 0.0, 0.0]).is_none());
    }

    #[test]
    fn too_little_history_decides_nothing() {
        let (windows, cells) = movie(3);
        let dims = Dims::new(N, N).unwrap();
        assert!(scan(
            &windows,
            &known(&cells[..1]),
            dims,
            &ReviewConfig::default()
        )
        .is_empty());
    }
}
