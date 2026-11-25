//! Tilings with overlapping or offset tiles and a blending window. The
//! tiling of a window is part of its factor file (format v2).
//!
//! Every tile is compressed on its own, as before. A frame is rebuilt as
//! the weighted sum of the tiles that cover each pixel, with weights that
//! sum to 1 at every pixel, so a cell on a tile line is not cut in two by
//! the rank cut of two unrelated tiles.

use super::WindowFactors;
use crate::preprocess::Dims;

/// How a frame is cut into tiles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Tiling {
    /// Square tiles side by side (Discover's live factors in the app).
    #[default]
    Plain,
    /// Each tile grown by this many px on every side that has a neighbour;
    /// the weight ramps over the shared band (raised cosine).
    Overlap(usize),
    /// The plain grid plus a second one shifted by half a tile in x and y;
    /// a tile's weight falls linearly towards its inner edges. The weights
    /// sum to 1, but where a line of one grid crosses a line of the other, a
    /// tile keeps a normalised weight of up to about 0.5 on its own edge
    /// (overlap tilings: at most about 0.004).
    Offset,
}

impl Tiling {
    /// The tiling as two numbers for a file header: the kind (0 plain,
    /// 1 overlap, 2 offset) and the overlap in px (0 for the others). An
    /// overlap of 0 is plain; one beyond `u32::MAX` is clamped (the layout
    /// limits it to half a tile anyway).
    pub fn code(self) -> (u32, u32) {
        match self {
            Tiling::Plain => (0, 0),
            Tiling::Overlap(0) => (0, 0),
            Tiling::Overlap(o) => (1, u32::try_from(o).unwrap_or(u32::MAX)),
            Tiling::Offset => (2, 0),
        }
    }

    /// Inverse of [`Tiling::code`]; `None` for an unknown kind or an overlap of 0.
    pub fn from_code(kind: u32, param: u32) -> Option<Tiling> {
        match (kind, param) {
            (0, 0) => Some(Tiling::Plain),
            (1, o) if o > 0 => Some(Tiling::Overlap(o as usize)),
            (2, 0) => Some(Tiling::Offset),
            _ => None,
        }
    }

    /// `plain`, `overlap:N` or `offset` (what [`Tiling::parse`] reads).
    pub fn name(self) -> String {
        match self {
            Tiling::Plain => "plain".into(),
            Tiling::Overlap(o) => format!("overlap:{o}"),
            Tiling::Offset => "offset".into(),
        }
    }

    /// `plain`, `overlap:N` (N > 0) or `offset`.
    pub fn parse(s: &str) -> Option<Tiling> {
        match s {
            "plain" => Some(Tiling::Plain),
            "offset" => Some(Tiling::Offset),
            _ => s
                .strip_prefix("overlap:")
                .and_then(|n| n.parse::<usize>().ok())
                .filter(|&n| n > 0)
                .map(Tiling::Overlap),
        }
    }
}

/// One tile along one axis: start, length, and whether its low and its high
/// side touch another tile (not the frame border).
type Span = (usize, usize, bool, bool);

/// Tiles along an axis of `n` px: cuts every `tile` px, the first at
/// `first`; each tile is grown by `grow` px on its inner sides.
fn spans(n: usize, tile: usize, first: usize, grow: usize) -> Vec<Span> {
    let mut cuts = vec![0];
    let mut c = first.max(1);
    while c < n {
        cuts.push(c);
        c += tile;
    }
    cuts.push(n);
    cuts.windows(2)
        .map(|w| {
            let (a, b) = (w[0], w[1]);
            let lo = if a > 0 { a.saturating_sub(grow) } else { 0 };
            let hi = if b < n { (b + grow).min(n) } else { n };
            (lo, hi - lo, a > 0, b < n)
        })
        .collect()
}

/// Weight along one axis: 1, falling to 0 over `ramp` px towards each
/// inner side.
fn edge_window(span: Span, ramp: usize, cosine: bool) -> Vec<f32> {
    let (_, n, lo, hi) = span;
    let shape = |u: f32| {
        let u = u.clamp(0.0, 1.0);
        if cosine {
            0.5 - 0.5 * (std::f32::consts::PI * u).cos()
        } else {
            u
        }
    };
    (0..n)
        .map(|i| {
            let mut w = 1.0;
            if ramp > 0 && lo {
                w *= shape((i as f32 + 0.5) / ramp as f32);
            }
            if ramp > 0 && hi {
                w *= shape((n as f32 - i as f32 - 0.5) / ramp as f32);
            }
            w
        })
        .collect()
}

/// (first cut, growth, ramp length, raised cosine) of each grid of a tiling.
fn grids(tile: usize, tiling: Tiling) -> Vec<(usize, usize, usize, bool)> {
    match tiling {
        Tiling::Plain => vec![(tile, 0, 0, false)],
        Tiling::Overlap(o) => {
            let o = o.min(tile / 2);
            vec![(tile, o, 2 * o, true)]
        }
        Tiling::Offset => vec![(tile, 0, tile / 2, false), (tile / 2, 0, tile / 2, false)],
    }
}

/// Each tile of a tiling, in the order of [`grid_of`]: its spans along x and
/// y, and its grid's ramp length and shape. The one statement of the cut.
fn tile_spans(dims: Dims, tile: usize, tiling: Tiling) -> Vec<(Span, Span, usize, bool)> {
    let tile = tile.max(2);
    let mut out = Vec::new();
    for (first, grow, ramp, cosine) in grids(tile, tiling) {
        let xs = spans(dims.width, tile, first, grow);
        let ys = spans(dims.height, tile, first, grow);
        for &sy in &ys {
            for &sx in &xs {
                out.push((sx, sy, ramp, cosine));
            }
        }
    }
    out
}

/// `(x0, y0, w, h)` of the tiles of a tiling, grid after grid and row by row
/// within a grid; a `tile` below 2 is raised to 2. [`BlendLayout::new`] takes
/// its grid from this; here without the blending weights (cost proportional
/// to the tiles, not to the frame's area).
pub fn grid_of(dims: Dims, tile: usize, tiling: Tiling) -> Vec<(usize, usize, usize, usize)> {
    tile_spans(dims, tile, tiling)
        .iter()
        .map(|(sx, sy, _, _)| (sx.0, sy.0, sx.1, sy.1))
        .collect()
}

/// The tiles of a tiling and each tile's blending weights.
pub struct BlendLayout {
    dims: Dims,
    grid: Vec<(usize, usize, usize, usize)>,
    weights: Vec<Vec<f32>>,
}

impl BlendLayout {
    /// How many tiles `new(dims, tile, tiling)` cuts, without building them
    /// (cost proportional to the frame's edges, not its area).
    pub fn tile_count(dims: Dims, tile: usize, tiling: Tiling) -> usize {
        let tile = tile.max(2);
        let per_axis = |n: usize, first: usize| {
            // Cuts at first, first + tile, ... below n, plus the frame ends.
            let first = first.max(1);
            if first < n {
                (n - 1 - first) / tile + 2
            } else {
                1
            }
        };
        let grid = |first: usize| per_axis(dims.width, first) * per_axis(dims.height, first);
        match tiling {
            Tiling::Plain | Tiling::Overlap(_) => grid(tile),
            Tiling::Offset => grid(tile) + grid(tile / 2),
        }
    }

    pub fn new(dims: Dims, tile: usize, tiling: Tiling) -> BlendLayout {
        let grid = grid_of(dims, tile, tiling);
        let mut weights: Vec<Vec<f32>> = tile_spans(dims, tile, tiling)
            .into_iter()
            .map(|(sx, sy, ramp, cosine)| {
                let wy = edge_window(sy, ramp, cosine);
                let wx = edge_window(sx, ramp, cosine);
                wy.iter()
                    .flat_map(|&a| wx.iter().map(move |&b| a * b))
                    .collect()
            })
            .collect();
        // Normalise: the weights of the tiles that cover a pixel sum to 1.
        let mut sum = vec![0.0f32; dims.pixels()];
        for (g, w) in grid.iter().zip(&weights) {
            for y in 0..g.3 {
                let row = (g.1 + y) * dims.width + g.0;
                for x in 0..g.2 {
                    sum[row + x] += w[y * g.2 + x];
                }
            }
        }
        for (g, w) in grid.iter().zip(&mut weights) {
            for y in 0..g.3 {
                let row = (g.1 + y) * dims.width + g.0;
                for x in 0..g.2 {
                    w[y * g.2 + x] /= sum[row + x];
                }
            }
        }
        BlendLayout {
            dims,
            grid,
            weights,
        }
    }

    /// `(x0, y0, w, h)` of each tile, in the order the compressor takes.
    pub fn grid(&self) -> &[(usize, usize, usize, usize)] {
        &self.grid
    }

    /// Per tile, `w * h` weights, row-major.
    pub fn weights(&self) -> &[Vec<f32>] {
        &self.weights
    }

    /// Pixels compressed over pixels of the frame: the factor by which the
    /// tiling multiplies the compression time and the buffer.
    pub fn cost(&self) -> f64 {
        let tiles: usize = self.grid.iter().map(|g| g.2 * g.3).sum();
        tiles as f64 / self.dims.pixels() as f64
    }

    /// Frame `t` of the window rebuilt into `out` as the weighted sum of
    /// its tiles. `wf` must come from a compressor built on [`Self::grid`].
    pub fn reconstruct(&self, wf: &WindowFactors, t: usize, out: &mut [f32]) {
        assert_eq!(wf.tiles.len(), self.grid.len(), "factors of another tiling");
        let width = self.dims.width;
        out.fill(0.0);
        for (tf, wt) in wf.tiles.iter().zip(&self.weights) {
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
                    out[row + x] += wt[p] * s;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::{CompressConfig, WindowCompressor};

    const TILINGS: [Tiling; 4] = [
        Tiling::Plain,
        Tiling::Overlap(8),
        Tiling::Overlap(16),
        Tiling::Offset,
    ];

    #[test]
    fn tiling_codes_and_names_round_trip() {
        for t in [Tiling::Plain, Tiling::Overlap(8), Tiling::Offset] {
            let (kind, param) = t.code();
            assert_eq!(Tiling::from_code(kind, param), Some(t));
            assert_eq!(Tiling::parse(&t.name()), Some(t));
        }
        assert_eq!(Tiling::default(), Tiling::Plain);
        assert_eq!(Tiling::Overlap(0).code(), (0, 0));
        #[cfg(target_pointer_width = "64")]
        assert_eq!(Tiling::Overlap((1usize << 32) + 8).code(), (1, u32::MAX));
        assert_eq!(Tiling::from_code(7, 0), None);
        assert_eq!(
            Tiling::from_code(1, 0),
            None,
            "an overlap of 0 is plain, not overlap"
        );
    }

    #[test]
    fn tile_count_matches_the_layout() {
        for (w, h) in [(96, 70), (40, 24), (64, 64), (65, 1), (3, 130)] {
            let dims = Dims::new(w, h).unwrap();
            for tile in [2, 3, 16, 64, 100] {
                for tiling in TILINGS {
                    assert_eq!(
                        BlendLayout::tile_count(dims, tile, tiling),
                        BlendLayout::new(dims, tile, tiling).grid().len(),
                        "{w}x{h} tile {tile} {tiling:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn grid_of_is_the_grid_of_the_layout() {
        for (w, h) in [(96, 70), (40, 24), (10, 10), (65, 1), (3, 130), (33, 33)] {
            let dims = Dims::new(w, h).unwrap();
            for tile in [2, 3, 16, 64, 100] {
                for tiling in TILINGS {
                    let g = grid_of(dims, tile, tiling);
                    assert_eq!(
                        g.as_slice(),
                        BlendLayout::new(dims, tile, tiling).grid(),
                        "{w}x{h} tile {tile} {tiling:?}"
                    );
                    assert_eq!(g.len(), BlendLayout::tile_count(dims, tile, tiling));
                }
            }
        }
    }

    #[test]
    fn parse_names() {
        assert_eq!(Tiling::parse("plain"), Some(Tiling::Plain));
        assert_eq!(Tiling::parse("overlap:16"), Some(Tiling::Overlap(16)));
        assert_eq!(Tiling::parse("offset"), Some(Tiling::Offset));
        assert_eq!(Tiling::parse("overlap:0"), None);
        assert_eq!(Tiling::parse("overlap"), None);
        assert_eq!(Tiling::parse("tiles"), None);
    }

    #[test]
    fn weights_sum_to_one_on_every_pixel() {
        for (w, h) in [(200, 200), (600, 600), (70, 50), (40, 40)] {
            let dims = Dims::new(w, h).unwrap();
            for tiling in TILINGS {
                let lay = BlendLayout::new(dims, 64, tiling);
                let mut sum = vec![0.0f32; dims.pixels()];
                for (g, wt) in lay.grid().iter().zip(lay.weights()) {
                    assert_eq!(wt.len(), g.2 * g.3);
                    for y in 0..g.3 {
                        for x in 0..g.2 {
                            sum[(g.1 + y) * w + g.0 + x] += wt[y * g.2 + x];
                        }
                    }
                }
                for (p, s) in sum.iter().enumerate() {
                    assert!((s - 1.0).abs() < 1e-5, "{tiling:?} {w}x{h} pixel {p}: {s}");
                }
            }
        }
    }

    #[test]
    fn the_plain_grid_is_square_tiles_row_by_row() {
        // 200 x 136 in 64 px tiles: 4 columns (the last 8 px wide), 3 rows
        // (the last 8 px high).
        let dims = Dims::new(200, 136).unwrap();
        let mut want = Vec::new();
        for y0 in [0, 64, 128] {
            for x0 in [0, 64, 128, 192] {
                want.push((x0, y0, 64.min(200 - x0), 64.min(136 - y0)));
            }
        }
        assert_eq!(grid_of(dims, 64, Tiling::Plain), want);
        let lay = BlendLayout::new(dims, 64, Tiling::Plain);
        assert_eq!(lay.grid(), want.as_slice());
    }

    #[test]
    fn cost_counts_the_pixels_compressed() {
        let dims = Dims::new(640, 640).unwrap();
        assert_eq!(BlendLayout::new(dims, 64, Tiling::Plain).cost(), 1.0);
        assert_eq!(BlendLayout::new(dims, 64, Tiling::Offset).cost(), 2.0);
        // 8 inner tiles of 96 px and 2 border tiles of 80 px per axis.
        let c = BlendLayout::new(dims, 64, Tiling::Overlap(16)).cost();
        assert!((c - (928.0f64 / 640.0).powi(2)).abs() < 1e-9, "{c}");
    }

    /// Three blobs with slow time courses; the first sits on the tile line
    /// x = 64.
    fn movie(dims: Dims, frames: usize) -> Vec<f32> {
        let blobs = [
            (40.0f32, 64.0f32, 0.05f32),
            (20.0, 20.0, 0.11),
            (60.0, 100.0, 0.17),
        ];
        let px = dims.pixels();
        let mut out = vec![0.0f32; frames * px];
        for t in 0..frames {
            for (cy, cx, f) in blobs {
                let c = 40.0 * (1.0 + (f * t as f32).sin());
                for y in 0..dims.height {
                    for x in 0..dims.width {
                        let d2 = (y as f32 - cy).powi(2) + (x as f32 - cx).powi(2);
                        out[t * px + y * dims.width + x] += c * (-d2 / 32.0).exp();
                    }
                }
            }
        }
        out
    }

    #[test]
    fn a_low_rank_movie_is_rebuilt_under_every_tiling() {
        let dims = Dims::new(128, 80).unwrap();
        let (frames, px) = (120, dims.pixels());
        let y = movie(dims, frames);
        for tiling in TILINGS {
            let lay = BlendLayout::new(dims, 64, tiling);
            let cfg = CompressConfig {
                window: frames,
                k0: 8,
                tiling,
                ..CompressConfig::default()
            };
            let mut wc = WindowCompressor::new(dims, cfg);
            let mut wf = None;
            for f in y.chunks_exact(px) {
                if let Some(w) = wc.push(f) {
                    wf = Some(w);
                }
            }
            let wf = wf.expect("one full window");
            let mut out = vec![0.0f32; px];
            let mut worst = 0.0f32;
            for t in [0, 37, 119] {
                lay.reconstruct(&wf, t, &mut out);
                for (a, b) in out.iter().zip(&y[t * px..(t + 1) * px]) {
                    worst = worst.max((a - b).abs());
                }
            }
            assert!(worst < 0.1, "{tiling:?}: worst error {worst}");
        }
    }

    #[test]
    fn plain_rebuild_equals_the_window_rebuild() {
        let dims = Dims::new(128, 80).unwrap();
        let (frames, px) = (120, dims.pixels());
        let y = movie(dims, frames);
        let cfg = CompressConfig {
            window: frames,
            k0: 8,
            ..CompressConfig::default()
        };
        let mut wc = WindowCompressor::new(dims, cfg);
        let wf = y.chunks_exact(px).find_map(|f| wc.push(f)).unwrap();
        let lay = BlendLayout::new(dims, 64, Tiling::Plain);
        let (mut a, mut b) = (vec![0.0f32; px], vec![0.0f32; px]);
        wf.reconstruct(50, &mut a);
        lay.reconstruct(&wf, 50, &mut b);
        assert_eq!(a, b);
    }
}
