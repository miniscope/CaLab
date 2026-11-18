# cala factor pipeline, phase 0 (harness and baseline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure what Refine and Extract lose when they read frames rebuilt from the SVD factors instead of the raw replay, which tiling removes the tile-line effect, and how long the stages take today.

**Architecture:** No new pipeline. `qc_eval` gets flags that make its later passes (the app's Refine) and a new Extract pass read frames rebuilt from the factors of an earlier pass (arm B of the spec), with the tiling selectable. A small library module adds overlapping and offset tilings with a blending window. Python tools in `tools/cala-eval` run the arms and compare them with the raw run (arm A) against a null spread.

**Tech Stack:** Rust (`crates/cala`, the `qc_eval` example), Python 3 with numpy (`tools/cala-eval`, unittest), Node with Playwright (the browser batch driver).

**Spec:** `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`

One deliberate difference from the spec: the harness is a set of flags on `examples/qc_eval.rs`, not a new `examples/factor_eval.rs`. `qc_eval` already runs Discover, the refine replays and `--factors-out`; a new example would copy 4000 lines of it.

## Global Constraints

- Without the new flags `qc_eval` behaves as before: its library and trace outputs (`footprints*.bin`, `final*.tsv`, `cells.tsv`, `passes.tsv` apart from the wall time) are identical to main `20de18c0`. The only new file of such a run is `stage_times.tsv`.
- Discover (pass 1) is never changed by any new flag.
- Raw recordings are read-only. Every output goes to the run's output directory.
- No path of a developer's machine in any committed file. Recordings are given on the command line; the plan writes `$DATA` for the dataset root.
- At most 4 `qc_eval` runs at once (`tools/cala-eval/README.md`).
- Rust: run cargo from `crates/cala`. Before each commit: `cargo fmt --all --check` and `cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings` pass.
- Python: type hints on every function; `ruff format` and `ruff check --fix` before each commit; run with `uv run --no-project --with numpy python`, never a global environment.
- Markdown and `.mjs`: `npx prettier --check` passes.
- Branch `feat/cala-factor-eval`, cut from `docs/cala-factor-pipeline-spec`. Commit messages are one sentence, with no Claude or Anthropic attribution.
- Line numbers in this plan are those of main `20de18c0`; find each place by the quoted code, not by the number.

## Review Focus

1. **A recording that is not a multiple of 600 frames, or shorter than one window.** The last, short window must be written before the next pass reads it, and the replay must find it. Pinned in Task 2 (650-frame test) and Task 3 (pass-end `finish`).
2. **A frame that is not a multiple of the tile, or smaller than one tile** (200 px = 3 × 64 + 8). The blending weights must still sum to 1 on every pixel. Pinned in Task 1 (200 × 200, 70 × 50, 40 × 40).
3. **Missing pixels (NaN) in a frame.** The compressor stores them as 0. The replay must keep them missing, or arm B changes the missing-pixel handling together with the compression. Pinned in Task 2.
4. **A cell present in one run and not in the other, a constant trace, a run with no cells.** The comparison must report them and not crash or count a NaN as agreement. Pinned in Task 4.
5. **`--replay-source factors` with nothing to replay** (no `--factors-out`, or `--factors-pass` at the last pass without `--extract-pass`). The run must stop with a message, not silently run raw. Pinned in Task 3 (smoke commands).

---

## File Structure

| File                                         | Responsibility                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `crates/cala/src/compress/blend.rs` (new)    | Tilings (`Plain`, `Overlap`, `Offset`), blending weights, blended rebuild   |
| `crates/cala/src/compress/mod.rs`            | `pub mod blend`, `WindowCompressor::with_grid`                              |
| `crates/cala/examples/qc_eval.rs`            | `FactorDump` with a tiling, `FactorReplay`, the new flags, `--extract-pass` |
| `tools/cala-eval/factor_closeness.py` (new)  | Compare two runs: per-cell table, summary, verdict against the null         |
| `tools/cala-eval/factor_arms.py` (new)       | Run the arms of one recording and write its report                          |
| `tools/cala-eval/stage_times.py` (new)       | Stage seconds from a browser export (`cala-export.npz`)                     |
| `tools/cala-eval/test_factor_*.py` (new)     | unittest for the three tools                                                |
| `apps/cala/scripts/batch-session.mjs` (new)  | The unattended browser driver, with a `--query` option                      |
| `tools/cala-eval/results/*-factor-phase0.md` | The measurements and the gate decision                                      |

---

### Task 1: Tilings with a blending window

**Files:**

- Create: `crates/cala/src/compress/blend.rs`
- Modify: `crates/cala/src/compress/mod.rs` (line 31 `pub mod review;`, lines 337-354 `WindowCompressor::new`)

**Interfaces:**

- Consumes: `compress::{WindowFactors, TileFactors, WindowCompressor, CompressConfig, tile_grid}`, `preprocess::Dims` (`Dims::new(width, height) -> Result`, `.width`, `.height`, `.pixels()`).
- Produces:
  - `pub enum Tiling { Plain, Overlap(usize), Offset }`, `Tiling::parse(&str) -> Option<Tiling>` (`plain`, `overlap:N`, `offset`)
  - `BlendLayout::new(dims: Dims, tile: usize, tiling: Tiling) -> BlendLayout`
  - `BlendLayout::grid(&self) -> &[(usize, usize, usize, usize)]` (`(x0, y0, w, h)` per tile)
  - `BlendLayout::weights(&self) -> &[Vec<f32>]` (per tile, `w * h`, row-major)
  - `BlendLayout::reconstruct(&self, wf: &WindowFactors, t: usize, out: &mut [f32])`
  - `BlendLayout::cost(&self) -> f64` (tile pixels over frame pixels)
  - `WindowCompressor::with_grid(dims: Dims, cfg: CompressConfig, grid: Vec<(usize, usize, usize, usize)>) -> WindowCompressor`

- [ ] **Step 1: Write the failing tests**

Create `crates/cala/src/compress/blend.rs` with only the tests (the module does not compile yet):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::{tile_grid, CompressConfig, WindowCompressor};

    const TILINGS: [Tiling; 4] = [
        Tiling::Plain,
        Tiling::Overlap(8),
        Tiling::Overlap(16),
        Tiling::Offset,
    ];

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
    fn plain_layout_is_the_tile_grid() {
        let dims = Dims::new(200, 136).unwrap();
        let lay = BlendLayout::new(dims, 64, Tiling::Plain);
        assert_eq!(lay.grid(), tile_grid(dims, 64).as_slice());
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
        let blobs = [(40.0f32, 64.0f32, 0.05f32), (20.0, 20.0, 0.11), (60.0, 100.0, 0.17)];
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
                ..CompressConfig::default()
            };
            let mut wc = WindowCompressor::with_grid(dims, cfg, lay.grid().to_vec());
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
```

Add to `crates/cala/src/compress/mod.rs`, above `pub mod review;`:

```rust
pub mod blend;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd crates/cala && cargo test --lib compress::blend`
Expected: does not compile, `cannot find type Tiling`, `BlendLayout`, and no `with_grid` on `WindowCompressor`.

- [ ] **Step 3: Implement**

Put this above the test module in `crates/cala/src/compress/blend.rs`:

```rust
//! Tilings with overlapping or offset tiles and a blending window
//! (evaluation prototype for the factor pipeline; the factor file format
//! is unchanged).
//!
//! Every tile is compressed on its own, as before. A frame is rebuilt as
//! the weighted sum of the tiles that cover each pixel, with weights that
//! sum to 1 at every pixel, so a cell on a tile line is not cut in two by
//! the rank cut of two unrelated tiles.

use super::WindowFactors;
use crate::preprocess::Dims;

/// How a frame is cut into tiles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tiling {
    /// Square tiles side by side (the app's grid).
    Plain,
    /// Each tile grown by this many px on every side that has a neighbour;
    /// the weight ramps over the shared band (raised cosine).
    Overlap(usize),
    /// The plain grid plus a second one shifted by half a tile in x and y;
    /// a tile's weight falls linearly towards its inner edges.
    Offset,
}

impl Tiling {
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

/// The tiles of a tiling and each tile's blending weights.
pub struct BlendLayout {
    dims: Dims,
    grid: Vec<(usize, usize, usize, usize)>,
    weights: Vec<Vec<f32>>,
}

impl BlendLayout {
    pub fn new(dims: Dims, tile: usize, tiling: Tiling) -> BlendLayout {
        let tile = tile.max(2);
        // (first cut, growth, ramp length, raised cosine) of each grid.
        let grids: Vec<(usize, usize, usize, bool)> = match tiling {
            Tiling::Plain => vec![(tile, 0, 0, false)],
            Tiling::Overlap(o) => {
                let o = o.min(tile / 2);
                vec![(tile, o, 2 * o, true)]
            }
            Tiling::Offset => vec![(tile, 0, tile / 2, false), (tile / 2, 0, tile / 2, false)],
        };
        let mut grid = Vec::new();
        let mut weights: Vec<Vec<f32>> = Vec::new();
        for (first, grow, ramp, cosine) in grids {
            let xs = spans(dims.width, tile, first, grow);
            let ys = spans(dims.height, tile, first, grow);
            for &sy in &ys {
                let wy = edge_window(sy, ramp, cosine);
                for &sx in &xs {
                    let wx = edge_window(sx, ramp, cosine);
                    grid.push((sx.0, sy.0, sx.1, sy.1));
                    weights.push(
                        wy.iter()
                            .flat_map(|&a| wx.iter().map(move |&b| a * b))
                            .collect(),
                    );
                }
            }
        }
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
```

In `crates/cala/src/compress/mod.rs` replace the body of `WindowCompressor::new` and add `with_grid` after it:

```rust
    pub fn new(dims: Dims, cfg: CompressConfig) -> WindowCompressor {
        let grid = tile_grid(dims, cfg.tile);
        WindowCompressor::with_grid(dims, cfg, grid)
    }

    /// As [`WindowCompressor::new`] with the tiles given as `(x0, y0, w, h)`;
    /// they may overlap (see [`blend::BlendLayout`]).
    pub fn with_grid(
        dims: Dims,
        cfg: CompressConfig,
        grid: Vec<(usize, usize, usize, usize)>,
    ) -> WindowCompressor {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd crates/cala && cargo test --lib compress`
Expected: PASS, the six new tests and every existing `compress` test.

- [ ] **Step 5: Lint and commit**

```bash
cd crates/cala && cargo fmt --all && cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings
git add crates/cala/src/compress/blend.rs crates/cala/src/compress/mod.rs
git commit -m "feat(cala): overlapping and offset tilings with a blending window for the compressor"
```

---

### Task 2: `FactorDump` with a tiling, and `FactorReplay`

**Files:**

- Modify: `crates/cala/examples/qc_eval.rs` (`FactorDump`, lines 2872-2912; the test module at line 4561)

**Interfaces:**

- Consumes: `calab_cala::compress::blend::{BlendLayout, Tiling}`, `WindowCompressor::with_grid`, `WindowFactors::{to_bytes, from_bytes, mean_rank, kept_fraction, bytes}` and its fields `start`, `frames`, `tiles`, `compress_seconds`.
- Produces (all private to `qc_eval.rs`):
  - `const FACTOR_WINDOW: usize = 600;`
  - `FactorDump::new(dir: &Path, dims: Dims, tiling: Tiling) -> FactorDump`, `push(&mut self, frame: &[f32])`, `finish(&mut self)`, field `seconds: f64`
  - `FactorReplay::new(dir: &Path, dims: Dims, tiling: Tiling) -> FactorReplay`, `frame(&mut self, t: usize, y: &mut [f32])`
  - File `<dir>/factors.tsv`: `start  frames  tiles  mean_rank  kept  bytes  compress_s`, one row per window, written by `finish`.

- [ ] **Step 1: Write the failing test**

Add inside `mod tests` of `crates/cala/examples/qc_eval.rs`:

```rust
    /// A blob on the tile line x = 64 whose brightness follows a slow sine.
    fn slow_stream(dims: Dims, frames: usize) -> Vec<Vec<f32>> {
        (0..frames)
            .map(|t| {
                let g = 1.0 + 0.5 * (0.07 * t as f32).sin();
                (0..dims.pixels())
                    .map(|p| {
                        let (y, x) = ((p / dims.width) as f32, (p % dims.width) as f32);
                        let d2 = (y - 35.0).powi(2) + (x - 64.0).powi(2);
                        g * (20.0 + 30.0 * (-d2 / 50.0).exp())
                    })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn factor_replay_returns_the_dumped_frames() {
        let dims = Dims::new(96, 70).unwrap();
        // One full window and a short last one.
        let frames = slow_stream(dims, FACTOR_WINDOW + 50);
        for (k, tiling) in [Tiling::Plain, Tiling::Overlap(8), Tiling::Offset]
            .into_iter()
            .enumerate()
        {
            let dir =
                std::env::temp_dir().join(format!("qc_eval_factors_{}_{k}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let mut fd = FactorDump::new(&dir, dims, tiling);
            for f in &frames {
                fd.push(f);
            }
            fd.finish();
            let log = std::fs::read_to_string(dir.join("factors.tsv")).unwrap();
            assert_eq!(log.lines().count(), 3, "header and two windows: {log}");
            let mut fr = FactorReplay::new(&dir, dims, tiling);
            for t in [0, FACTOR_WINDOW - 1, FACTOR_WINDOW, FACTOR_WINDOW + 49] {
                let mut y = vec![0.0f32; dims.pixels()];
                y[5] = f32::NAN;
                fr.frame(t, &mut y);
                assert!(y[5].is_nan(), "{tiling:?}: a missing pixel stays missing");
                for (p, (a, b)) in y.iter().zip(&frames[t]).enumerate() {
                    if p != 5 {
                        assert!((a - b).abs() < 0.1, "{tiling:?} frame {t} pixel {p}: {a} vs {b}");
                    }
                }
            }
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crates/cala && cargo test --release --example qc_eval factor_replay`
Expected: does not compile, `FactorReplay`, `Tiling` and `FACTOR_WINDOW` are not found and `FactorDump::new` takes two arguments.

- [ ] **Step 3: Implement**

Add to the imports at the top of `qc_eval.rs`:

```rust
use calab_cala::compress::blend::{BlendLayout, Tiling};
use calab_cala::compress::{CompressConfig, WindowCompressor, WindowFactors};
```

Replace the whole `struct FactorDump` and its `impl` by:

```rust
/// Frames per compressed window (the app's).
const FACTOR_WINDOW: usize = 600;

/// `--factors-out`: compresses the preprocessed frames window by window and
/// writes each window's factors to `<dir>/w<start>.fac`; `finish` writes
/// `<dir>/factors.tsv` (a row per window).
struct FactorDump {
    dir: PathBuf,
    tile: usize,
    wc: WindowCompressor,
    /// Seconds spent buffering and compressing.
    seconds: f64,
    log: String,
}

impl FactorDump {
    fn new(dir: &Path, dims: Dims, tiling: Tiling) -> FactorDump {
        std::fs::create_dir_all(dir).unwrap();
        let cfg = CompressConfig {
            window: FACTOR_WINDOW,
            ..CompressConfig::default()
        };
        let layout = BlendLayout::new(dims, cfg.tile, tiling);
        FactorDump {
            dir: dir.to_path_buf(),
            tile: cfg.tile,
            wc: WindowCompressor::with_grid(dims, cfg, layout.grid().to_vec()),
            seconds: 0.0,
            log: String::from("start\tframes\ttiles\tmean_rank\tkept\tbytes\tcompress_s\n"),
        }
    }

    fn write(&mut self, wf: WindowFactors) {
        let _ = writeln!(
            self.log,
            "{}\t{}\t{}\t{:.2}\t{:.5}\t{}\t{:.3}",
            wf.start,
            wf.frames,
            wf.tiles.len(),
            wf.mean_rank(),
            wf.kept_fraction(),
            wf.bytes(),
            wf.compress_seconds
        );
        let name = format!("w{:07}.fac", wf.start);
        std::fs::write(self.dir.join(name), wf.to_bytes(self.tile)).unwrap();
    }

    fn push(&mut self, frame: &[f32]) {
        let t0 = Instant::now();
        let done = self.wc.push(frame);
        self.seconds += t0.elapsed().as_secs_f64();
        if let Some(wf) = done {
            self.write(wf);
        }
    }

    /// Write the last, shorter window and `factors.tsv`.
    fn finish(&mut self) {
        let t0 = Instant::now();
        let done = self.wc.flush();
        self.seconds += t0.elapsed().as_secs_f64();
        if let Some(wf) = done {
            self.write(wf);
        }
        std::fs::write(self.dir.join("factors.tsv"), &self.log).unwrap();
    }
}

/// `--replay-source factors`: frames rebuilt from the factor files a
/// [`FactorDump`] wrote with the same tiling.
struct FactorReplay {
    dir: PathBuf,
    layout: BlendLayout,
    cur: Option<WindowFactors>,
    buf: Vec<f32>,
}

impl FactorReplay {
    fn new(dir: &Path, dims: Dims, tiling: Tiling) -> FactorReplay {
        FactorReplay {
            dir: dir.to_path_buf(),
            layout: BlendLayout::new(dims, CompressConfig::default().tile, tiling),
            cur: None,
            buf: vec![0.0; dims.pixels()],
        }
    }

    /// Replace the pixels of `y` (recording frame `t`) by the frame rebuilt
    /// from the factors. A missing pixel (NaN) stays missing, so the two
    /// replay sources differ only in what the compression drops.
    fn frame(&mut self, t: usize, y: &mut [f32]) {
        let start = (t / FACTOR_WINDOW) * FACTOR_WINDOW;
        if self.cur.as_ref().map(|w| w.start as usize) != Some(start) {
            let path = self.dir.join(format!("w{start:07}.fac"));
            let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
            let wf = WindowFactors::from_bytes(&bytes)
                .unwrap_or_else(|| panic!("{path:?}: not a factor file"));
            self.cur = Some(wf);
        }
        let wf = self.cur.as_ref().unwrap();
        assert!(
            t - start < wf.frames,
            "frame {t} is beyond the factors in {:?}",
            self.dir
        );
        self.layout.reconstruct(wf, t - start, &mut self.buf);
        for (o, &r) in y.iter_mut().zip(&self.buf) {
            if !o.is_nan() {
                *o = r;
            }
        }
    }
}
```

`main` still calls `FactorDump::new(d, dims)`. Change that one call (line 3553) so the file compiles; Task 3 replaces it again:

```rust
    let mut factors = factors_out
        .as_deref()
        .map(|d| FactorDump::new(d, dims, Tiling::Plain));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd crates/cala && cargo test --release --example qc_eval factor_replay`
Expected: PASS (1 test).

- [ ] **Step 5: Lint and commit**

```bash
cd crates/cala && cargo fmt --all && cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings
git add crates/cala/examples/qc_eval.rs
git commit -m "feat(cala): qc_eval factor dump takes a tiling and frames can be replayed from the factors"
```

---

### Task 3: `qc_eval` flags: replay source, tiling, factors pass, later budget, Extract pass, stage times

**Files:**

- Modify: `crates/cala/examples/qc_eval.rs` (header doc near line 71; `main`: argument parsing near line 3132, `pipe.keep_records` at 3493, the pass loop 3551-4206, the final library 4428-4441)
- Modify: `tools/cala-eval/README.md` (one bullet)

**Interfaces:**

- Consumes: `FactorDump`, `FactorReplay`, `FACTOR_WINDOW`, `Tiling` (Task 2); `Pipeline::frame_replay(&mut self, raw: &[u8], out: &mut [f32], t: usize)`; `TraceEngine::{new, set_consolidated_ring_gradient, process_into}`; `write_f32s`.
- Produces (command line and files; Tasks 4 and 5 rely on the exact names):
  - `--tiling plain|overlap:N|offset` (default `plain`)
  - `--replay-source raw|factors` (default `raw`)
  - `--factors-pass P` (default 1): the pass whose frames are compressed
  - `--later-budget U` (default: `--budget`): slow-loop work units per frame in passes ≥ 2
  - `--extract-pass`: after the last pass, replay once with the final library and no slow loop
  - `<out>/extract_trace.f32`: frames × cells, f32 little-endian, frame after frame
  - `<out>/extract_ids.tsv`: `slot  id`
  - `<out>/stage_times.tsv`: `stage  read_s  pre_s  compress_s  solve_s  slow_s  wall_s`, rows `pass1` … `passN`, `extract`

- [ ] **Step 1: Document the flags**

In the header comment of `qc_eval.rs`, replace the three `--factors-out` lines by:

```rust
//!   --factors-out DIR  compress one pass's preprocessed frames in 600-frame
//!                      windows ([`calab_cala::compress`]) and write every
//!                      window's factors to `DIR/w<start>.fac` (`CALAFAC1`) and
//!                      `DIR/factors.tsv` (rank, size and time per window); the
//!                      input of tools/cala-diagnostics/history_wholetest.py
//!   --factors-pass P   the pass whose frames `--factors-out` compresses (1:
//!                      Discover's frames, as the app; 2: the first replay,
//!                      which has the final flat field from frame 0)
//!   --tiling T         tiles of `--factors-out`: plain (default, 64 px side
//!                      by side) | overlap:N (each tile grown N px per inner
//!                      side, blended) | offset (a second grid shifted 32 px)
//!   --replay-source S  what the passes after `--factors-pass` and
//!                      `--extract-pass` solve: raw (default, the replayed
//!                      frames) | factors (those frames rebuilt from
//!                      `--factors-out`; missing pixels stay missing)
//!   --later-budget U   slow-loop work units per frame in passes >= 2
//!                      (default: `--budget`; ignored with `--offered-fps`);
//!                      two raw runs that differ only in it give the null
//!                      spread of a refine replay
//!   --extract-pass     the app's Extract stage: after the last pass, replay
//!                      the recording once more with the final library and no
//!                      slow loop; writes `extract_trace.f32` (frames x cells,
//!                      f32 LE) and `extract_ids.tsv`. Not with `--sessions`
//!   Every run writes `stage_times.tsv`: seconds per pass (and for the
//!   Extract pass) spent reading, preprocessing, compressing, solving traces
//!   and in the slow loop.
```

- [ ] **Step 2: Parse the flags**

After the line `let passes: usize = arg_value(&args, "--passes").map_or(1, |s| s.parse().unwrap());` add:

```rust
    let tiling = arg_value(&args, "--tiling").map_or(Tiling::Plain, |s| {
        Tiling::parse(&s).unwrap_or_else(|| panic!("--tiling: plain, overlap:N or offset, not {s:?}"))
    });
    let replay_factors = match arg_value(&args, "--replay-source").as_deref() {
        None | Some("raw") => false,
        Some("factors") => true,
        Some(o) => panic!("--replay-source: raw or factors, not {o:?}"),
    };
    let factors_pass: usize =
        arg_value(&args, "--factors-pass").map_or(1, |s| s.parse().unwrap());
    let later_budget: u64 =
        arg_value(&args, "--later-budget").map_or(budget, |s| s.parse().unwrap());
    let extract_pass = args.iter().any(|a| a == "--extract-pass");
    assert!(
        (1..=passes).contains(&factors_pass),
        "--factors-pass must be between 1 and --passes ({passes})"
    );
    if replay_factors {
        assert!(
            arg_value(&args, "--factors-out").is_some(),
            "--replay-source factors needs --factors-out DIR"
        );
        assert!(
            factors_pass < passes || extract_pass,
            "--replay-source factors: nothing runs after pass {factors_pass}; add passes or --extract-pass"
        );
        assert!(
            arg_value(&args, "--offered-fps").is_none(),
            "--replay-source factors is not supported with --offered-fps"
        );
    }
```

Change `pipe.keep_records = passes > 1;` to:

```rust
    pipe.keep_records = passes > 1 || extract_pass;
```

- [ ] **Step 3: Wire the pass loop**

Replace the two lines that build `factors` (changed in Task 2) by:

```rust
    let mut factors = factors_out
        .as_deref()
        .map(|d| FactorDump::new(d, dims, tiling));
    let mut replay = replay_factors
        .then(|| FactorReplay::new(factors_out.as_deref().unwrap(), dims, tiling));
    let mut stage_times =
        String::from("stage\tread_s\tpre_s\tcompress_s\tsolve_s\tslow_s\twall_s\n");
```

Directly after `let t_pass = Instant::now();` add:

```rust
        let budget_now = if pass == 0 { budget } else { later_budget };
        let (mut read_s, mut pre_s, mut solve_s, mut slow_s) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
```

In the pass loop, time the read. Replace `let mut raw = rec.read(s, cnt);` (the one inside `for pass in 0..passes`) by:

```rust
            let t0 = Instant::now();
            let mut raw = rec.read(s, cnt);
            read_s += t0.elapsed().as_secs_f64();
```

Replace

```rust
                let shift = if pass == 0 {
                    pipe.frame(f, &mut y)
                } else {
                    pipe.frame_replay(f, &mut y, t_rec)
                };
```

by

```rust
                let t0 = Instant::now();
                let shift = if pass == 0 {
                    pipe.frame(f, &mut y)
                } else {
                    pipe.frame_replay(f, &mut y, t_rec)
                };
                pre_s += t0.elapsed().as_secs_f64();
```

Replace

```rust
                if let (Some(fd), 0) = (factors.as_mut(), pass) {
                    fd.push(&y);
                }
                let warm = diverge.as_ref().map(|_| engine.state());
                let tr = engine.process(&y).unwrap();
```

by

```rust
                // Arm B: the passes after the compressed one solve the frames
                // rebuilt from its factors. Everything upstream (replayed
                // motion, preprocessor state, noise map) is as in a raw run.
                if let (Some(fr), true) = (replay.as_mut(), pass >= factors_pass) {
                    let t0 = Instant::now();
                    fr.frame(t_rec, &mut y);
                    pre_s += t0.elapsed().as_secs_f64();
                }
                if let (Some(fd), true) = (factors.as_mut(), pass + 1 == factors_pass) {
                    fd.push(&y);
                }
                let warm = diverge.as_ref().map(|_| engine.state());
                let t0 = Instant::now();
                let tr = engine.process(&y).unwrap();
                solve_s += t0.elapsed().as_secs_f64();
```

In the untimed slow-loop branch, replace

```rust
                            if forward {
                                sl.observe(&yy, &ll, &tt).unwrap();
                                slow_rec.push(tf as u32);
                                fwd_frames += 1;
                            } else if !drop_step {
                                continue;
                            }
                            let published = match via.as_mut() {
                                Some(r) => sl.step_via(budget, r).unwrap(),
                                None => sl.step(budget).unwrap(),
                            };
```

by

```rust
                            if forward {
                                let t0 = Instant::now();
                                sl.observe(&yy, &ll, &tt).unwrap();
                                slow_s += t0.elapsed().as_secs_f64();
                                slow_rec.push(tf as u32);
                                fwd_frames += 1;
                            } else if !drop_step {
                                continue;
                            }
                            let t0 = Instant::now();
                            let published = match via.as_mut() {
                                Some(r) => sl.step_via(budget_now, r).unwrap(),
                                None => sl.step(budget_now).unwrap(),
                            };
                            slow_s += t0.elapsed().as_secs_f64();
```

At the end of a pass, the block that starts with `let lib = engine.library().clone();` computes `let wall = t_pass.elapsed().as_secs_f64();`. Directly after that `let wall` line add:

```rust
            // The compressed pass ends: its last, short window must be on
            // disk before the next pass replays it.
            let compress_s = match factors.as_mut() {
                Some(fd) if pass + 1 == factors_pass => {
                    fd.finish();
                    fd.seconds
                }
                _ => 0.0,
            };
            let _ = writeln!(
                stage_times,
                "pass{}\t{read_s:.2}\t{pre_s:.2}\t{compress_s:.2}\t{solve_s:.2}\t{slow_s:.2}\t{wall:.2}",
                pass + 1
            );
```

Remove the late finish, which would now write the same window a second time:

```rust
    if let Some(fd) = factors.as_mut() {
        fd.finish();
    }
```

- [ ] **Step 4: Add the Extract pass**

After the final `write_library(&out_dir, "", &lib, dims, gt.as_ref(), ho.as_ref(), slow.as_ref());` call and before `if !dump {` add:

```rust
    // `--extract-pass`: the app's Extract stage. One more replay from frame
    // 0 with the final library and no slow loop.
    if extract_pass {
        assert!(sessions.is_empty(), "--extract-pass does not support --sessions");
        let mut eng = TraceEngine::new(lib.clone(), SolverConfig::default()).unwrap();
        eng.set_consolidated_ring_gradient(true);
        let mut out = BufWriter::new(File::create(out_dir.join("extract_trace.f32")).unwrap());
        let mut tr = FrameTraces::default();
        let (mut read_s, mut pre_s, mut solve_s) = (0.0f64, 0.0f64, 0.0f64);
        let t_ex = Instant::now();
        let mut s = 0u32;
        while s < frames {
            let cnt = 64.min(frames - s);
            let t0 = Instant::now();
            let mut raw = rec.read(s, cnt);
            read_s += t0.elapsed().as_secs_f64();
            if let Some(d) = &drift {
                for (k, f) in raw.chunks_exact_mut(n_px).enumerate() {
                    d.apply(f, s as usize + k);
                }
            }
            for (k, f) in raw.chunks_exact(n_px).enumerate() {
                let t = s as usize + k;
                let t0 = Instant::now();
                pipe.frame_replay(f, &mut y, t);
                if let Some(fr) = replay.as_mut() {
                    fr.frame(t, &mut y);
                }
                pre_s += t0.elapsed().as_secs_f64();
                let t0 = Instant::now();
                eng.process_into(&y, &mut tr).unwrap();
                solve_s += t0.elapsed().as_secs_f64();
                write_f32s(&mut out, &tr.traces);
            }
            s += cnt;
        }
        drop(out);
        let mut ids = String::from("slot\tid\n");
        for (k, id) in lib.ids().iter().enumerate() {
            let _ = writeln!(ids, "{k}\t{id}");
        }
        std::fs::write(out_dir.join("extract_ids.tsv"), ids).unwrap();
        let wall = t_ex.elapsed().as_secs_f64();
        let _ = writeln!(
            stage_times,
            "extract\t{read_s:.2}\t{pre_s:.2}\t0.00\t{solve_s:.2}\t0.00\t{wall:.2}"
        );
        println!(
            "extract pass: {} cells x {t_len} frames, {wall:.1} s ({} source)",
            lib.len(),
            if replay.is_some() { "factors" } else { "raw" }
        );
    }
    std::fs::write(out_dir.join("stage_times.tsv"), &stage_times).unwrap();
```

- [ ] **Step 5: Build, lint, and run the existing tests**

Run: `cd crates/cala && cargo fmt --all && cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings && cargo test --release --example qc_eval`
Expected: no warnings; every `qc_eval` test passes, the Task 2 test included.

- [ ] **Step 6: Smoke runs (the task's tests)**

`REC` is a folder of `0.avi`, `1.avi`, … (use the 200 px synthetic set: `$DATA/synthetic/synth_v4_chal_wl200/raw`). `OUT` is an empty scratch directory.

```bash
cd crates/cala
Q="cargo run --release --example qc_eval -- real $REC"
COMMON="--motion --frames 1800 --passes 3 --later-passes refine --extract-pass"
$Q $OUT/a $COMMON
$Q $OUT/a2 $COMMON --replay-source raw --factors-out $OUT/a2/factors
$Q $OUT/b $COMMON --replay-source factors --factors-out $OUT/b/factors
$Q $OUT/c $COMMON --replay-source factors --factors-out $OUT/c/factors --tiling overlap:16
$Q $OUT/d $COMMON --replay-source factors --factors-out $OUT/d/factors --factors-pass 2
```

Expected, each checked with the command shown:

| Check                                                  | Command                                                                                | Expected                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Compressing on the side changes nothing                | `cmp $OUT/a/footprints.bin $OUT/a2/footprints.bin`                                     | identical                                              |
| Same for the traces                                    | `cmp $OUT/a/extract_trace.f32 $OUT/a2/extract_trace.f32`                               | identical                                              |
| Discover is unchanged by the replay source             | `cmp $OUT/a/footprints_pass1.bin $OUT/b/footprints_pass1.bin`                          | identical                                              |
| The factor arm really reads factors                    | `cmp $OUT/a/extract_trace.f32 $OUT/b/extract_trace.f32`                                | differ                                                 |
| The trace file has frames × cells values               | `wc -c < $OUT/b/extract_trace.f32` against `1800 * 4 * (lines of extract_ids.tsv - 1)` | equal                                                  |
| The short last window exists (1800 = 3 × 600: add one) | rerun `b` with `--frames 1850` into `$OUT/b2`; `ls $OUT/b2/factors`                    | `w0000000.fac` … `w0001800.fac`, `factors.tsv` 5 lines |
| The overlap arm costs more                             | `tail -n +2 $OUT/c/factors/factors.tsv \| cut -f6` against `$OUT/b/...`                | larger bytes per window                                |
| `--factors-pass 2` compresses the first replay         | `cmp $OUT/a/footprints_pass2.bin $OUT/d/footprints_pass2.bin`                          | identical (pass 2 ran raw)                             |
| Stage times are written                                | `cat $OUT/b/stage_times.tsv`                                                           | rows `pass1`, `pass2`, `pass3`, `extract`              |
| Nothing to replay is an error                          | `$Q $OUT/e --frames 600 --replay-source factors`                                       | exits with "needs --factors-out DIR"                   |
| Same, last pass compressed and no Extract              | `$Q $OUT/e --frames 600 --replay-source factors --factors-out $OUT/e/f`                | exits with "nothing runs after pass 1"                 |
| A bad tiling name is an error                          | `$Q $OUT/e --frames 600 --tiling tiles`                                                | exits with "--tiling: plain, overlap:N or offset"      |

If the first two rows differ, a new flag changed the default path: fix that before going on.

- [ ] **Step 7: Document and commit**

Add to the list in `tools/cala-eval/README.md`, after the `split_passes.py` bullet:

```markdown
- Factor pipeline, phase 0 (`docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`):
  `qc_eval --replay-source factors --factors-out DIR [--tiling T] [--factors-pass P]` makes the
  passes after the compressed one, and `--extract-pass`, solve frames rebuilt from the factors;
  `--later-budget U` gives the null spread of a refine replay; `stage_times.tsv` has the seconds
  per pass.
```

```bash
npx prettier --write tools/cala-eval/README.md
git add crates/cala/examples/qc_eval.rs tools/cala-eval/README.md
git commit -m "feat(cala): qc_eval can refine and extract from frames rebuilt from the factors"
```

---

### Task 4: `factor_closeness.py`

**Files:**

- Create: `tools/cala-eval/factor_closeness.py`
- Test: `tools/cala-eval/test_factor_closeness.py`

**Interfaces:**

- Consumes: a `qc_eval` run directory with `footprints.bin`, `final.tsv` (`id`, `cy`, `cx`), `extract_trace.f32`, `extract_ids.tsv`, optionally `cells.tsv` (`frame`, `id`, `pass`); `fp_scales.read_footprints(path) -> ((h, w), {id: (pix, values)})`; optionally a `truth.npz` with `A_data`, `A_indices`, `A_indptr`, `A_shape`, `traces`.
- Produces:
  - `compare(ref: Path, test: Path, tile: int = 64, truth_path: Path | None = None) -> list[dict[str, float]]` with keys `id`, `cy`, `cx`, `edge_px`, `border_px`, `qc_pass`, `in_test`, `fp_cos`, `trace_r`, `truth_r_ref`, `truth_r_test`
  - `report(ref: Path, test: Path, nulls: list[Path], tile: int = 64, band: float = 16.0, truth_path: Path | None = None) -> str` (Markdown)
  - `loss(rows: list[dict[str, float]], key: str) -> float`, `verdict(test_loss: float, null_losses: list[float]) -> str` (`within`, `outside`, `not judged`)
  - Command line: `factor_closeness.py --ref RUN --test RUN [--null RUN ...] [--truth truth.npz] [--tile 64] [--band 16] [--out cells.tsv]`

- [ ] **Step 1: Write the failing tests**

Create `tools/cala-eval/test_factor_closeness.py`:

```python
"""Tests for factor_closeness.py: `python -m unittest discover tools/cala-eval`."""

import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import factor_closeness as F  # noqa: E402

DIMS = (128, 128)


def write_run(
    d: Path,
    cells: dict[int, tuple[list[int], list[float]]],
    traces: dict[int, list[float]],
    qc: dict[int, tuple[int, float]] | None = None,
) -> None:
    """A minimal qc_eval run directory. `qc`: {id: (checkpoint frame, pass)} rows of cells.tsv."""
    d.mkdir(parents=True)
    h, w = DIMS
    with open(d / "footprints.bin", "wb") as f:
        f.write(b"CALAFP01" + struct.pack("<III", h, w, len(cells)))
        for cid, (pix, val) in cells.items():
            f.write(struct.pack("<II", cid, len(pix)))
            f.write(np.asarray(pix, "<u4").tobytes())
            f.write(np.asarray(val, "<f4").tobytes())
            f.write(np.asarray(val, "<f4").tobytes())
    final = ["slot\tid\tcy\tcx"]
    for s, (cid, (pix, val)) in enumerate(cells.items()):
        p, v = np.asarray(pix), np.asarray(val)
        final.append(f"{s}\t{cid}\t{(p // w * v).sum() / v.sum():.2f}\t{(p % w * v).sum() / v.sum():.2f}")
    (d / "final.tsv").write_text("\n".join(final) + "\n")
    ids = list(traces)
    (d / "extract_ids.tsv").write_text("slot\tid\n" + "".join(f"{k}\t{c}\n" for k, c in enumerate(ids)))
    data = np.stack([np.asarray(traces[c], "<f4") for c in ids], axis=1) if ids else np.zeros(0, "<f4")
    data.tofile(d / "extract_trace.f32")
    if qc is not None:
        rows = ["frame\tslot\tid\tpass"]
        rows += [f"{fr}\t0\t{cid:.5f}\t{p:.5f}" for cid, (fr, p) in qc.items()]
        (d / "cells.tsv").write_text("\n".join(rows) + "\n")


def blob(cy: int, cx: int) -> tuple[list[int], list[float]]:
    """A 3 x 3 footprint centred at (cy, cx)."""
    pix = [(cy + dy) * DIMS[1] + cx + dx for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
    return pix, [1.0, 2.0, 1.0, 2.0, 4.0, 2.0, 1.0, 2.0, 1.0]


T = np.sin(np.arange(200) * 0.3)
CELLS = {7: blob(20, 20), 9: blob(63, 90), 11: blob(100, 40)}
TRACES = {7: list(T), 9: list(np.roll(T, 5)), 11: list(np.roll(T, 11))}


class Closeness(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_identical_runs_agree_exactly(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        rows = F.compare(self.root / "a", self.root / "b")
        self.assertEqual([r["id"] for r in rows], [7, 9, 11])
        for r in rows:
            self.assertAlmostEqual(r["trace_r"], 1.0, places=6)
            self.assertAlmostEqual(r["fp_cos"], 1.0, places=6)
            self.assertEqual(r["in_test"], 1.0)

    def test_distance_to_tile_lines_and_border(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        rows = {r["id"]: r for r in F.compare(self.root / "a", self.root / "b")}
        self.assertAlmostEqual(rows[9]["edge_px"], 0.5)  # row 63 beside the line at 63.5
        self.assertAlmostEqual(rows[7]["edge_px"], 43.5)
        self.assertAlmostEqual(rows[7]["border_px"], 20.0)
        self.assertEqual(F.line_distance(10.0, 40, 64), math.inf)

    def test_missing_cell_and_constant_trace_do_not_count_as_agreement(self) -> None:
        cells_b = {7: CELLS[7], 9: CELLS[9]}
        traces_b = {7: [0.0] * 200, 9: TRACES[9]}
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", cells_b, traces_b)
        rows = {r["id"]: r for r in F.compare(self.root / "a", self.root / "b")}
        self.assertEqual(rows[11]["in_test"], 0.0)
        self.assertTrue(math.isnan(rows[11]["fp_cos"]))
        self.assertTrue(math.isnan(rows[11]["trace_r"]))
        self.assertTrue(math.isnan(rows[7]["trace_r"]))
        self.assertAlmostEqual(F.loss(list(rows.values()), "trace_r"), 0.0, places=6)
        text = F.report(self.root / "a", self.root / "b", [])
        self.assertIn("1 of 3 cells are missing", text)

    def test_shifted_footprint_lowers_the_cosine(self) -> None:
        moved = dict(CELLS)
        moved[7] = blob(20, 21)
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", moved, TRACES)
        rows = {r["id"]: r for r in F.compare(self.root / "a", self.root / "b")}
        self.assertLess(rows[7]["fp_cos"], 0.9)
        self.assertGreater(rows[7]["fp_cos"], 0.3)

    def test_qc_comes_from_the_last_checkpoint(self) -> None:
        write_run(self.root / "a", CELLS, TRACES, qc={7: (300, 0.0)})
        with open(self.root / "a" / "cells.tsv", "a") as f:
            f.write("600\t0\t7.00000\t1.00000\n600\t1\t9.00000\t0.00000\n")
        self.assertEqual(F.read_qc(self.root / "a"), {7: True, 9: False})

    def test_verdict(self) -> None:
        self.assertEqual(F.verdict(0.01, [0.02, 0.005]), "within")
        self.assertEqual(F.verdict(0.03, [0.02, 0.005]), "outside")
        self.assertEqual(F.verdict(0.03, []), "not judged")
        self.assertEqual(F.verdict(float("nan"), [0.02]), "not judged")

    def test_a_run_without_cells_reports_and_does_not_crash(self) -> None:
        write_run(self.root / "a", {}, {})
        write_run(self.root / "b", {}, {})
        self.assertEqual(F.compare(self.root / "a", self.root / "b"), [])
        self.assertIn("0 cells", F.report(self.root / "a", self.root / "b", []))

    def test_truth_correlation_uses_units_near_the_cell(self) -> None:
        write_run(self.root / "a", CELLS, TRACES)
        write_run(self.root / "b", CELLS, TRACES)
        h, w = DIMS
        pix, val = blob(21, 20)  # one unit, 1 px from cell 7
        np.savez(
            self.root / "truth.npz",
            A_data=np.asarray(val, "f4"),
            A_indices=np.asarray(pix, "i4"),
            A_indptr=np.asarray([0, len(pix)], "i4"),
            A_shape=np.asarray([1, h * w]),
            traces=np.asarray([TRACES[7]], "f4"),
        )
        rows = {r["id"]: r for r in F.compare(self.root / "a", self.root / "b", truth_path=self.root / "truth.npz")}
        self.assertAlmostEqual(rows[7]["truth_r_ref"], 1.0, places=6)
        self.assertTrue(math.isnan(rows[11]["truth_r_ref"]))  # no unit within 6 px


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run --no-project --with numpy python -m unittest tools/cala-eval/test_factor_closeness.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'factor_closeness'`.

- [ ] **Step 3: Implement**

Create `tools/cala-eval/factor_closeness.py`:

```python
"""Closeness of two `qc_eval` runs of one recording (factor pipeline, phase 0).

    python factor_closeness.py --ref RUN --test RUN [--null RUN ...]
        [--truth truth.npz] [--tile 64] [--band 16] [--out cells.tsv]

`--ref` is the raw run. `--test` is a run whose later passes solved frames
rebuilt from the factors (`qc_eval --replay-source factors`). Each `--null` is
a raw run that differs from `--ref` only in `--later-budget`: the spread
between raw runs that the test run is judged against.

Per cell of the reference run (cells are matched by id; pass 1 is the same in
all runs, and a refine replay keeps the cell set):

- `trace_r`: Pearson correlation of the Extract traces (`extract_trace.f32`);
- `fp_cos`: cosine of the unfiltered footprints (`footprints.bin`);
- `edge_px`: distance of the centroid to the nearest tile line;
- `border_px`: distance of the centroid to the frame border;
- `truth_r_*` (with `--truth`): the best correlation with a ground-truth unit
  whose centroid is within 6 px.

A loss is the median of `1 - value` over the QC-pass cells. The test run is
`within` the null spread when its loss is at most the largest null loss.
Needs numpy.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fp_scales import read_footprints  # noqa: E402

Cell = tuple[np.ndarray, np.ndarray]
Row = dict[str, float]
Truth = tuple[np.ndarray, np.ndarray]

EDGE_BINS: tuple[tuple[float, float], ...] = ((0, 4), (4, 8), (8, 16), (16, float("inf")))
NEAR_PX = 8.0
TRUTH_PX = 6.0
NAN = float("nan")


# ---------------------------------------------------------------------------
# Reading a run
# ---------------------------------------------------------------------------


def read_tsv(path: Path) -> list[dict[str, str]]:
    lines = path.read_text().splitlines()
    if not lines:
        return []
    head = lines[0].split("\t")
    return [dict(zip(head, ln.split("\t"))) for ln in lines[1:] if ln]


def read_traces(run: Path) -> dict[int, np.ndarray]:
    """`{id: trace}` of a run's Extract pass (`extract_trace.f32`, frames x cells)."""
    ids = [int(r["id"]) for r in read_tsv(run / "extract_ids.tsv")]
    if not ids:
        return {}
    x = np.fromfile(run / "extract_trace.f32", "<f4").reshape(-1, len(ids))
    return {cid: x[:, k] for k, cid in enumerate(ids)}


def read_centroids(run: Path) -> dict[int, tuple[float, float]]:
    return {int(r["id"]): (float(r["cy"]), float(r["cx"])) for r in read_tsv(run / "final.tsv")}


def read_qc(run: Path) -> dict[int, bool]:
    """`{id: QC pass}` at the run's last checkpoint; empty when the run has no `cells.tsv`."""
    path = run / "cells.tsv"
    rows = read_tsv(path) if path.exists() else []
    if not rows:
        return {}
    last = max(int(r["frame"]) for r in rows)
    return {int(float(r["id"])): float(r["pass"]) > 0.5 for r in rows if int(r["frame"]) == last}


def read_truth(path: Path, dims: tuple[int, int]) -> Truth:
    """Centroids `(n, 2)` as (y, x) and traces `(n, frames)` of a `truth.npz`."""
    z = np.load(path)
    h, w = dims
    assert h * w in [int(v) for v in z["A_shape"]], f"{path}: footprints are not {h} x {w}"
    ptr = z["A_indptr"]
    idx, val = z["A_indices"].astype(np.int64), z["A_data"].astype(np.float64)
    cen = np.full((len(ptr) - 1, 2), np.nan)
    for k in range(len(ptr) - 1):
        i, v = idx[ptr[k] : ptr[k + 1]], val[ptr[k] : ptr[k + 1]]
        if v.sum() > 0:
            cen[k] = ((i // w * v).sum() / v.sum(), (i % w * v).sum() / v.sum())
    return cen, z["traces"]


# ---------------------------------------------------------------------------
# Per-cell measures
# ---------------------------------------------------------------------------


def pearson(a: np.ndarray, b: np.ndarray) -> float:
    """Correlation over the common length; NaN when either side is constant."""
    n = min(len(a), len(b))
    x, y = a[:n].astype(np.float64), b[:n].astype(np.float64)
    x, y = x - x.mean(), y - y.mean()
    d = float(np.sqrt((x * x).sum() * (y * y).sum()))
    return float((x * y).sum() / d) if d > 0 else NAN


def fp_cosine(a: Cell, b: Cell) -> float:
    da = dict(zip(a[0].tolist(), a[1].tolist()))
    dot = sum(da.get(p, 0.0) * v for p, v in zip(b[0].tolist(), b[1].tolist()))
    d = float(np.sqrt((a[1] ** 2).sum() * (b[1] ** 2).sum()))
    return float(dot / d) if d > 0 else NAN


def line_distance(c: float, n: int, tile: int) -> float:
    """Distance of coordinate `c` to the nearest tile line inside `n` px (lines at k * tile - 0.5)."""
    lines = np.arange(tile, n, tile) - 0.5
    return float(np.abs(lines - c).min()) if len(lines) else float("inf")


def truth_r(trace: np.ndarray, c: tuple[float, float], truth: Truth) -> float:
    cen, tr = truth
    near = np.flatnonzero(np.hypot(cen[:, 0] - c[0], cen[:, 1] - c[1]) <= TRUTH_PX)
    rs = [r for r in (pearson(trace, tr[k]) for k in near) if r == r]
    return max(rs) if rs else NAN


def compare(ref: Path, test: Path, tile: int = 64, truth_path: Path | None = None) -> list[Row]:
    """One row per cell of `ref`, compared with the cell of the same id in `test`."""
    (h, w), fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    ta, tb = read_traces(ref), read_traces(test)
    cen, qc = read_centroids(ref), read_qc(ref)
    truth = read_truth(truth_path, (h, w)) if truth_path else None
    rows: list[Row] = []
    for cid in sorted(fa):
        cy, cx = cen.get(cid, (NAN, NAN))
        both = cid in ta and cid in tb
        rows.append(
            {
                "id": cid,
                "cy": cy,
                "cx": cx,
                "edge_px": min(line_distance(cy, h, tile), line_distance(cx, w, tile)),
                "border_px": min(cy, cx, h - 1 - cy, w - 1 - cx),
                "qc_pass": float(qc.get(cid, True)),
                "in_test": float(cid in fb),
                "fp_cos": fp_cosine(fa[cid], fb[cid]) if cid in fb else NAN,
                "trace_r": pearson(ta[cid], tb[cid]) if both else NAN,
                "truth_r_ref": truth_r(ta[cid], (cy, cx), truth) if truth and cid in ta else NAN,
                "truth_r_test": truth_r(tb[cid], (cy, cx), truth) if truth and cid in tb else NAN,
            }
        )
    return rows


def line_jump(cells: dict[int, Cell], dims: tuple[int, int], tile: int) -> float:
    """Median relative jump of footprint values across tile lines over the same between all
    other neighbouring rows and columns (1: the tile lines do not show in the footprints)."""
    h, w = dims
    on: list[float] = []
    off: list[float] = []
    for pix, val in cells.values():
        if len(val) == 0 or val.max() <= 0:
            continue
        a = np.zeros(h * w)
        a[pix] = val
        a = a.reshape(h, w)
        thr = 0.2 * val.max()
        for axis in (0, 1):
            lo = a[:-1, :] if axis == 0 else a[:, :-1]
            hi = a[1:, :] if axis == 0 else a[:, 1:]
            ok = (lo >= thr) & (hi >= thr)
            jump = np.abs(hi[ok] - lo[ok]) / (0.5 * (hi[ok] + lo[ok]))
            at_line = (np.nonzero(ok)[axis] + 1) % tile == 0
            on.extend(jump[at_line].tolist())
            off.extend(jump[~at_line].tolist())
    if not on or not off or np.median(off) <= 0:
        return NAN
    return float(np.median(on) / np.median(off))


# ---------------------------------------------------------------------------
# Summary and verdict
# ---------------------------------------------------------------------------


def finite(rows: list[Row], key: str) -> np.ndarray:
    v = np.asarray([r[key] for r in rows], dtype=np.float64)
    return v[np.isfinite(v)]


def loss(rows: list[Row], key: str) -> float:
    """Median of `1 - value` over the QC-pass cells with a value."""
    v = finite([r for r in rows if r["qc_pass"]], key)
    return float(np.median(1.0 - v)) if len(v) else NAN


def verdict(test_loss: float, null_losses: list[float]) -> str:
    nulls = [x for x in null_losses if x == x]
    if not nulls or test_loss != test_loss:
        return "not judged"
    return "within" if test_loss <= max(nulls) else "outside"


def groups(rows: list[Row], band: float) -> list[tuple[str, list[Row]]]:
    out = [
        ("all cells", rows),
        ("QC pass", [r for r in rows if r["qc_pass"]]),
        ("not QC pass", [r for r in rows if not r["qc_pass"]]),
    ]
    for lo, hi in EDGE_BINS:
        name = f"tile line {lo:g} to {hi:g} px" if hi < float("inf") else f"tile line over {lo:g} px"
        out.append((name, [r for r in rows if lo <= r["edge_px"] < hi]))
    out.append((f"under {band:g} px from the border", [r for r in rows if r["border_px"] < band]))
    return out


def subsets(rows: list[Row]) -> list[tuple[str, list[Row]]]:
    return [
        ("QC pass", rows),
        (f"QC pass, under {NEAR_PX:g} px from a tile line", [r for r in rows if r["edge_px"] < NEAR_PX]),
        (f"QC pass, {NEAR_PX:g} px or more from a tile line", [r for r in rows if r["edge_px"] >= NEAR_PX]),
    ]


def q(v: np.ndarray, p: float) -> str:
    return f"{np.percentile(v, p):.4f}" if len(v) else "n/a"


def report(
    ref: Path,
    test: Path,
    nulls: list[Path],
    tile: int = 64,
    band: float = 16.0,
    truth_path: Path | None = None,
) -> str:
    """The Markdown comparison of `test` with `ref`, judged against the `nulls`."""
    rows = compare(ref, test, tile, truth_path)
    null_rows = [compare(ref, n, tile, None) for n in nulls]
    missing = sum(1 for r in rows if not r["in_test"])
    out = [f"### `{test.name}` against `{ref.name}`", ""]
    out.append(f"{len(rows)} cells in the reference run; {missing} of {len(rows)} cells are missing in the test run.")
    out += ["", "| cells | n | trace r median | trace r 5th pct | footprint cos median | footprint cos 5th pct |"]
    out.append("| --- | --- | --- | --- | --- | --- |")
    for name, g in groups(rows, band):
        tr, fc = finite(g, "trace_r"), finite(g, "fp_cos")
        out.append(f"| {name} | {len(g)} | {q(tr, 50)} | {q(tr, 5)} | {q(fc, 50)} | {q(fc, 5)} |")
    out += ["", "| cells | measure | loss | largest null loss | against the null |", "| --- | --- | --- | --- | --- |"]
    for k, (name, g) in enumerate(subsets(rows)):
        for key, label in (("trace_r", "trace r"), ("fp_cos", "footprint cos")):
            mine = loss(g, key)
            theirs = [loss(subsets(n)[k][1], key) for n in null_rows]
            top = max([x for x in theirs if x == x], default=NAN)
            out.append(f"| {name} | {label} | {mine:.5f} | {top:.5f} | {verdict(mine, theirs)} |")
    if truth_path:
        a, b = finite(rows, "truth_r_ref"), finite(rows, "truth_r_test")
        out += ["", f"Trace correlation with the truth, median: reference {q(a, 50)}, test {q(b, 50)}."]
    dims, fa = read_footprints(ref / "footprints.bin")
    _, fb = read_footprints(test / "footprints.bin")
    ja, jb = line_jump(fa, dims, tile), line_jump(fb, dims, tile)
    out += ["", f"Footprint jump at tile lines over elsewhere: reference {ja:.3f}, test {jb:.3f}.", ""]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--ref", type=Path, required=True)
    ap.add_argument("--test", type=Path, required=True)
    ap.add_argument("--null", type=Path, action="append", default=[])
    ap.add_argument("--truth", type=Path)
    ap.add_argument("--tile", type=int, default=64)
    ap.add_argument("--band", type=float, default=16.0)
    ap.add_argument("--out", type=Path, help="per-cell table (tsv)")
    a = ap.parse_args()
    print(report(a.ref, a.test, a.null, a.tile, a.band, a.truth))
    if a.out:
        rows = compare(a.ref, a.test, a.tile, a.truth)
        keys = list(rows[0]) if rows else ["id"]
        lines = ["\t".join(keys)] + ["\t".join(f"{r[k]:.6g}" for k in keys) for r in rows]
        a.out.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run --no-project --with numpy python -m unittest tools/cala-eval/test_factor_closeness.py`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and commit**

```bash
uvx ruff format tools/cala-eval/factor_closeness.py tools/cala-eval/test_factor_closeness.py
uvx ruff check --fix tools/cala-eval/factor_closeness.py tools/cala-eval/test_factor_closeness.py
git add tools/cala-eval/factor_closeness.py tools/cala-eval/test_factor_closeness.py
git commit -m "feat(cala-eval): compare a factor-replay run with the raw run against a null spread"
```

---

### Task 5: `factor_arms.py`

**Files:**

- Create: `tools/cala-eval/factor_arms.py`
- Test: `tools/cala-eval/test_factor_arms.py`

**Interfaces:**

- Consumes: the `qc_eval` flags of Task 3; `factor_closeness.report(ref, test, nulls, tile, band, truth_path) -> str`; `<run>/factors/factors.tsv` and `<run>/stage_times.tsv` (Tasks 2 and 3).
- Produces:
  - `arms(refine: int) -> dict[str, list[str]]`: arm name to `qc_eval` flags. Names: `raw`, `null_lo`, `null_hi`, `plain`, `overlap8`, `overlap16`, `offset`, `plain_recal`, and the Extract-only `x_raw`, `x_plain`, `x_overlap8`, `x_overlap16`, `x_offset`.
  - `command(qc_eval: Path, rec: Path, run: Path, flags: list[str], motion: bool, frames: int | None) -> list[str]`
  - `max_rss_mb(log: str) -> float | None`, `cost_row(run: Path) -> tuple[str, float, float, float] | None`
  - `<out>/<arm>/run.json`: `arm`, `cmd`, `returncode`, `wall_s`, `max_rss_mb`
  - Command line: `factor_arms.py --rec AVI_DIR --out DIR [--frames N] [--no-motion] [--refine 5] [--jobs 3] [--arms a,b] [--truth truth.npz] [--qc-eval PATH] [--dry-run]`; writes `<out>/<arm>/` per arm and `<out>/report.md`.

- [ ] **Step 1: Write the failing tests**

Create `tools/cala-eval/test_factor_arms.py`:

```python
"""Tests for factor_arms.py: `python -m unittest discover tools/cala-eval`."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import factor_arms as A  # noqa: E402


class Arms(unittest.TestCase):
    def test_arm_names(self) -> None:
        self.assertEqual(
            sorted(A.arms(5)),
            sorted(
                ["raw", "null_lo", "null_hi", "plain", "overlap8", "overlap16", "offset", "plain_recal"]
                + ["x_raw", "x_plain", "x_overlap8", "x_overlap16", "x_offset"]
            ),
        )

    def test_raw_and_null_differ_only_in_the_later_budget(self) -> None:
        a = A.arms(5)
        self.assertEqual(a["raw"], ["--passes", "6", "--later-passes", "refine", "--extract-pass"])
        self.assertEqual(a["null_lo"], a["raw"] + ["--later-budget", "15000000"])
        self.assertEqual(a["null_hi"], a["raw"] + ["--later-budget", "60000000"])

    def test_factor_arms_replay_from_factors_with_their_tiling(self) -> None:
        a = A.arms(5)
        self.assertEqual(a["overlap16"], a["raw"] + ["--replay-source", "factors", "--tiling", "overlap:16"])
        self.assertEqual(a["plain_recal"], a["plain"] + ["--factors-pass", "2"])
        self.assertEqual(a["x_offset"], ["--passes", "1", "--extract-pass", "--replay-source", "factors", "--tiling", "offset"])
        self.assertEqual(a["x_raw"], ["--passes", "1", "--extract-pass"])

    def test_command_adds_the_factor_folder_inside_the_run(self) -> None:
        cmd = A.command(Path("qc"), Path("rec"), Path("out/plain"), A.arms(5)["plain"], motion=True, frames=6000)
        self.assertEqual(cmd[:4], ["qc", "real", "rec", "out/plain"])
        self.assertIn("--motion", cmd)
        self.assertEqual(cmd[cmd.index("--frames") + 1], "6000")
        self.assertEqual(cmd[cmd.index("--factors-out") + 1], "out/plain/factors")

    def test_raw_command_has_no_factor_folder(self) -> None:
        cmd = A.command(Path("qc"), Path("rec"), Path("out/raw"), A.arms(5)["raw"], motion=False, frames=None)
        self.assertNotIn("--factors-out", cmd)
        self.assertNotIn("--motion", cmd)
        self.assertNotIn("--frames", cmd)

    def test_cost_table_reads_factors_tsv(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "plain"
            (run / "factors").mkdir(parents=True)
            (run / "factors" / "factors.tsv").write_text(
                "start\tframes\ttiles\tmean_rank\tkept\tbytes\tcompress_s\n"
                "0\t600\t100\t30.00\t0.50000\t60000000\t3.000\n"
                "600\t600\t100\t34.00\t0.50000\t60000000\t3.000\n"
            )
            self.assertEqual(A.cost_row(run), ("plain", 32.0, 100.0, 5.0))
            self.assertIsNone(A.cost_row(Path(d) / "raw"))

    def test_peak_memory_is_read_from_the_time_lines(self) -> None:
        log = "pass 1 done\n        2.31 real\n  1234567890  maximum resident set size\n"
        self.assertAlmostEqual(A.max_rss_mb(log), 1234.56789)
        self.assertIsNone(A.max_rss_mb("no time output"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run --no-project --with numpy python -m unittest tools/cala-eval/test_factor_arms.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'factor_arms'`.

- [ ] **Step 3: Implement**

Create `tools/cala-eval/factor_arms.py`:

```python
"""Run the phase-0 arms of the factor pipeline on one recording and write the report.

    python factor_arms.py --rec AVI_DIR --out DIR [--frames N] [--no-motion]
        [--refine 5] [--jobs 3] [--arms raw,plain,...] [--truth truth.npz]
        [--qc-eval PATH] [--dry-run]

Arms (each a `qc_eval real` run in `DIR/<arm>`; pass 1 is the same in all):

- `raw`: Discover, `--refine` refine replays and the Extract pass on the raw replay.
- `null_lo`, `null_hi`: `raw` with half and twice the slow-loop budget in the
  replays. Their distance to `raw` is the null spread.
- `plain`, `overlap8`, `overlap16`, `offset`: the replays and the Extract pass
  solve frames rebuilt from the factors of pass 1, under that tiling.
- `plain_recal`: as `plain`, but the factors are those of the first replay
  (the final flat field from frame 0).
- `x_raw` and `x_<tiling>`: Discover and the Extract pass only, so the two
  Extracts solve with one and the same library.

A finished arm (`run.json` with return code 0) is skipped. Raw data is only
read. Needs numpy (for the report).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import factor_closeness  # noqa: E402

TILINGS: dict[str, str] = {
    "plain": "plain",
    "overlap8": "overlap:8",
    "overlap16": "overlap:16",
    "offset": "offset",
}
DEFAULT_QC_EVAL = Path(__file__).resolve().parents[2] / "crates/cala/target/release/examples/qc_eval"


def arms(refine: int) -> dict[str, list[str]]:
    """Arm name to its `qc_eval` flags (without recording, output and factor folder)."""
    full = ["--passes", str(refine + 1), "--later-passes", "refine", "--extract-pass"]
    extract = ["--passes", "1", "--extract-pass"]
    out = {
        "raw": full,
        "null_lo": full + ["--later-budget", "15000000"],
        "null_hi": full + ["--later-budget", "60000000"],
        "x_raw": extract,
    }
    for name, tiling in TILINGS.items():
        factors = ["--replay-source", "factors", "--tiling", tiling]
        out[name] = full + factors
        out[f"x_{name}"] = extract + factors
    out["plain_recal"] = out["plain"] + ["--factors-pass", "2"]
    return out


def command(qc_eval: Path, rec: Path, run: Path, flags: list[str], motion: bool, frames: int | None) -> list[str]:
    cmd = [str(qc_eval), "real", str(rec), str(run), *flags]
    if "--replay-source" in flags:
        cmd += ["--factors-out", str(run / "factors")]
    if motion:
        cmd.append("--motion")
    if frames is not None:
        cmd += ["--frames", str(frames)]
    return cmd


def done(run: Path) -> bool:
    path = run / "run.json"
    return path.exists() and json.loads(path.read_text()).get("returncode") == 0


def max_rss_mb(log: str) -> float | None:
    """Peak memory from the `/usr/bin/time -l` lines of a run log (macOS reports bytes)."""
    m = re.search(r"(\d+)\s+maximum resident set size", log)
    return int(m.group(1)) / 1e6 if m else None


def run_arm(name: str, cmd: list[str], run: Path) -> int:
    """Run one arm; its output goes to `<run>/run.log`, the result to `<run>/run.json`."""
    run.mkdir(parents=True, exist_ok=True)
    timed = ["/usr/bin/time", "-l", *cmd] if sys.platform == "darwin" else cmd
    t0 = time.time()
    with open(run / "run.log", "w") as log:
        rc = subprocess.run(timed, stdout=log, stderr=subprocess.STDOUT, check=False).returncode
    wall = time.time() - t0
    rss = max_rss_mb((run / "run.log").read_text(errors="replace"))
    record = {"arm": name, "cmd": cmd, "returncode": rc, "wall_s": wall, "max_rss_mb": rss}
    (run / "run.json").write_text(json.dumps(record, indent=1))
    print(f"{name}: return code {rc}, {wall:.0f} s", flush=True)
    return rc


def cost_row(run: Path) -> tuple[str, float, float, float] | None:
    """(arm, mean rank, MB per 1000 frames, compression ms per frame) from `factors/factors.tsv`."""
    path = run / "factors" / "factors.tsv"
    if not path.exists():
        return None
    rows = factor_closeness.read_tsv(path)
    frames = sum(int(r["frames"]) for r in rows)
    if frames == 0:
        return None
    rank = sum(float(r["mean_rank"]) * int(r["frames"]) for r in rows) / frames
    mb = sum(int(r["bytes"]) for r in rows) / 1e6 * 1000 / frames
    ms = sum(float(r["compress_s"]) for r in rows) * 1000 / frames
    return (run.name, rank, mb, ms)


def stage_table(run: Path) -> list[str]:
    path = run / "stage_times.tsv"
    if not path.exists():
        return []
    out = [f"Seconds per stage, `{run.name}`:", "", "| stage | read | preprocess | compress | solve | slow loop | wall |"]
    out.append("| --- | --- | --- | --- | --- | --- | --- |")
    for r in factor_closeness.read_tsv(path):
        cells = [r["stage"], r["read_s"], r["pre_s"], r["compress_s"], r["solve_s"], r["slow_s"], r["wall_s"]]
        out.append("| " + " | ".join(cells) + " |")
    return out + [""]


def report(out_dir: Path, names: list[str], truth: Path | None) -> str:
    """The recording's Markdown report from the finished arms."""
    have = [n for n in names if done(out_dir / n)]
    text = [f"## {out_dir.name}", "", "| arm | wall s | peak memory MB |", "| --- | --- | --- |"]
    for n in have:
        rec = json.loads((out_dir / n / "run.json").read_text())
        rss = rec.get("max_rss_mb")
        text.append(f"| {n} | {rec['wall_s']:.0f} | {'n/a' if rss is None else f'{rss:.0f}'} |")
    text.append("")
    for n in ("raw", "plain"):
        if n in have:
            text += stage_table(out_dir / n)
    costs = [c for c in (cost_row(out_dir / n) for n in have) if c]
    if costs:
        text += ["| arm | mean rank | MB per 1000 frames | compression ms per frame |", "| --- | --- | --- | --- |"]
        text += [f"| {a} | {r:.1f} | {mb:.1f} | {ms:.2f} |" for a, r, mb, ms in costs]
        text.append("")
    nulls = [out_dir / n for n in ("null_lo", "null_hi") if n in have]
    for n in have:
        if n in TILINGS or n == "plain_recal":
            if "raw" in have:
                text.append(factor_closeness.report(out_dir / "raw", out_dir / n, nulls, truth_path=truth))
        elif n.startswith("x_") and n != "x_raw" and "x_raw" in have:
            text.append(factor_closeness.report(out_dir / "x_raw", out_dir / n, [], truth_path=truth))
    return "\n".join(text)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--rec", type=Path, required=True, help="folder of 0.avi, 1.avi, ...")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--frames", type=int)
    ap.add_argument("--no-motion", action="store_true")
    ap.add_argument("--refine", type=int, default=5, help="refine replays after Discover")
    ap.add_argument("--jobs", type=int, default=3, help="runs at once (at most 4 machine-wide)")
    ap.add_argument("--arms", help="comma-separated subset")
    ap.add_argument("--truth", type=Path)
    ap.add_argument("--qc-eval", type=Path, default=DEFAULT_QC_EVAL)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    assert 1 <= a.jobs <= 4, "--jobs must be 1 to 4"
    assert a.refine >= 2, "--refine must be at least 2 (plain_recal compresses pass 2)"
    table = arms(a.refine)
    names = a.arms.split(",") if a.arms else list(table)
    unknown = [n for n in names if n not in table]
    assert not unknown, f"unknown arms: {unknown}"
    cmds = {n: command(a.qc_eval, a.rec, a.out / n, table[n], not a.no_motion, a.frames) for n in names}
    if a.dry_run:
        for c in cmds.values():
            print(" ".join(c))
        return
    assert a.qc_eval.exists(), f"{a.qc_eval}: build it with `cargo build --release --example qc_eval`"
    todo = [n for n in names if not done(a.out / n)]
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        codes = list(pool.map(lambda n: run_arm(n, cmds[n], a.out / n), todo))
    (a.out / "report.md").write_text(report(a.out, names, a.truth))
    print(f"report: {a.out / 'report.md'}")
    if any(codes):
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run --no-project --with numpy python -m unittest tools/cala-eval/test_factor_arms.py`
Expected: PASS (7 tests).

- [ ] **Step 5: Dry run and a short real run**

```bash
cd crates/cala && cargo build --release --example qc_eval && cd ../..
uv run --no-project --with numpy python tools/cala-eval/factor_arms.py \
  --rec $DATA/synthetic/synth_v4_chal_wl200/raw --out $OUT/wl200_short --frames 3000 --refine 2 --dry-run
uv run --no-project --with numpy python tools/cala-eval/factor_arms.py \
  --rec $DATA/synthetic/synth_v4_chal_wl200/raw --out $OUT/wl200_short --frames 3000 --refine 2
```

Expected: the dry run prints 13 commands; the real run ends with return code 0 for every arm and writes `$OUT/wl200_short/report.md` with a table of wall time and peak memory per arm, a stage table, a cost table, and one comparison per factor arm whose verdict column reads `within` or `outside` (not `not judged`). If the default `--qc-eval` path does not exist after the build, find the binary with `find crates -name qc_eval -path '*release/examples*'` and correct `DEFAULT_QC_EVAL`.

- [ ] **Step 6: Lint, document and commit**

Add to `tools/cala-eval/README.md`, after the bullet added in Task 3:

```markdown
- `factor_arms.py --rec AVI_DIR --out DIR`: the phase-0 arms of the factor pipeline on one
  recording (raw, two null runs, four tilings, factors of the first replay, and the Extract-only
  pairs) and `DIR/report.md`. `factor_closeness.py --ref RUN --test RUN [--null RUN ...]` compares
  two of its runs. Both need numpy.
```

```bash
uvx ruff format tools/cala-eval/factor_arms.py tools/cala-eval/test_factor_arms.py
uvx ruff check --fix tools/cala-eval/factor_arms.py tools/cala-eval/test_factor_arms.py
npx prettier --write tools/cala-eval/README.md
git add tools/cala-eval/factor_arms.py tools/cala-eval/test_factor_arms.py tools/cala-eval/README.md
git commit -m "feat(cala-eval): run the factor-pipeline arms of a recording and write its report"
```

---

### Task 6: Browser stage times

**Files:**

- Create: `apps/cala/scripts/batch-session.mjs` (the untracked driver of the `CaLab-overnight` worktree, plus one option)
- Create: `tools/cala-eval/stage_times.py`
- Test: `tools/cala-eval/test_stage_times.py`

**Interfaces:**

- Consumes: a cala export (`.npz`) whose `meta_json` array (uint8, UTF-8 JSON) has `stages`: a list of `{stage, index, started_at, ended_at, outcome, frames, cells}` (`apps/cala/src/lib/export.ts`, format version 3).
- Produces:
  - `stages(npz: Path) -> list[dict[str, float | str]]` with keys `stage`, `index`, `outcome`, `seconds`, `frames`, `cells`, `fps`
  - Command line: `stage_times.py EXPORT.npz [EXPORT.npz ...]` prints one Markdown table per file.
  - `batch-session.mjs --query STR`: appended to the app URL (`Cala/?debug&STR`), so `--query compress` runs with compression on.

- [ ] **Step 1: Write the failing tests**

Create `tools/cala-eval/test_stage_times.py`:

```python
"""Tests for stage_times.py: `python -m unittest discover tools/cala-eval`."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stage_times as S  # noqa: E402


def write_export(path: Path, stages: list[dict]) -> None:
    meta = json.dumps({"stages": stages}).encode()
    np.savez(path, meta_json=np.frombuffer(meta, np.uint8))


class StageTimes(unittest.TestCase):
    def test_seconds_and_frames_per_second(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cala-export.npz"
            write_export(
                p,
                [
                    {"stage": "discover", "index": 1, "started_at": "2026-11-17T10:00:00.000Z",
                     "ended_at": "2026-11-17T10:02:00.000Z", "outcome": "done", "frames": 24000, "cells": 300},
                    {"stage": "refine", "index": 1, "started_at": "2026-11-17T10:02:00.500Z",
                     "ended_at": "2026-11-17T10:03:30.500Z", "outcome": "done", "frames": 24000, "cells": 300},
                ],
            )
            rows = S.stages(p)
            self.assertEqual([r["stage"] for r in rows], ["discover", "refine"])
            self.assertAlmostEqual(rows[0]["seconds"], 120.0)
            self.assertAlmostEqual(rows[0]["fps"], 200.0)
            self.assertAlmostEqual(rows[1]["seconds"], 90.0)

    def test_a_stage_that_never_ended_is_listed_without_a_time(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.npz"
            write_export(p, [{"stage": "extract", "index": 1, "started_at": "2026-11-17T10:00:00Z",
                              "ended_at": None, "outcome": "running", "frames": 0, "cells": 5}])
            rows = S.stages(p)
            self.assertTrue(np.isnan(rows[0]["seconds"]))
            self.assertIn("extract", S.table(p))

    def test_an_export_without_stages_gives_an_empty_table(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "old.npz"
            np.savez(p, meta_json=np.frombuffer(b"{}", np.uint8))
            self.assertEqual(S.stages(p), [])
            self.assertIn("no stage records", S.table(p))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run --no-project --with numpy python -m unittest tools/cala-eval/test_stage_times.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'stage_times'`.

- [ ] **Step 3: Implement `stage_times.py`**

```python
"""Seconds per stage of a cala browser run, from its export.

    python stage_times.py EXPORT.npz [EXPORT.npz ...]

Reads `meta_json.stages` (export format 3 and later): each Discover, Refine and
Extract run with its start and end time. Prints a Markdown table per export.
Needs numpy.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np

Row = dict[str, float | str]


def parse(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def stages(npz: Path) -> list[Row]:
    """One row per stage run: stage, index, outcome, seconds, frames, cells, fps."""
    meta = json.loads(np.load(npz)["meta_json"].tobytes().decode())
    rows: list[Row] = []
    for s in meta.get("stages", []):
        ended = s.get("ended_at")
        seconds = (parse(ended) - parse(s["started_at"])).total_seconds() if ended else float("nan")
        frames = float(s.get("frames") or 0)
        rows.append(
            {
                "stage": str(s["stage"]),
                "index": float(s.get("index") or 0),
                "outcome": str(s.get("outcome", "")),
                "seconds": seconds,
                "frames": frames,
                "cells": float(s.get("cells") or 0),
                "fps": frames / seconds if seconds > 0 else float("nan"),
            }
        )
    return rows


def table(npz: Path) -> str:
    rows = stages(npz)
    out = [f"`{npz.name}`", ""]
    if not rows:
        return "\n".join(out + ["no stage records in this export", ""])
    out += ["| stage | run | outcome | seconds | frames | cells | frames per second |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        out.append(
            f"| {r['stage']} | {r['index']:.0f} | {r['outcome']} | {r['seconds']:.1f} | "
            f"{r['frames']:.0f} | {r['cells']:.0f} | {r['fps']:.0f} |"
        )
    return "\n".join(out + [""])


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for p in sys.argv[1:]:
        print(table(Path(p)))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run --no-project --with numpy python -m unittest tools/cala-eval/test_stage_times.py`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the browser driver with `--query`**

Copy the driver into the repository. `OVERNIGHT` is the `CaLab-overnight` worktree (a sibling folder of this checkout):

```bash
cp $OVERNIGHT/apps/cala/scripts/batch-session.mjs apps/cala/scripts/batch-session.mjs
```

Read the copied file once before editing: it must contain nothing but the driver (no local paths, no credentials). Then make two edits.

In the usage comment at the top, after the line ` *        [--channel chrome]` add:

```js
 *        [--query compress]   appended to the app URL (Cala/?debug&compress)
```

Replace

```js
await page.goto(`${base}Cala/?debug`);
```

by

```js
const query = opt('--query', '');
await page.goto(`${base}Cala/?debug${query ? `&${query}` : ''}`);
```

Check: `node --check apps/cala/scripts/batch-session.mjs` prints nothing, and `grep -n "/Users\|/Volumes" apps/cala/scripts/batch-session.mjs` prints nothing.

- [ ] **Step 6: Lint and commit**

```bash
uvx ruff format tools/cala-eval/stage_times.py tools/cala-eval/test_stage_times.py
uvx ruff check --fix tools/cala-eval/stage_times.py tools/cala-eval/test_stage_times.py
npx prettier --write apps/cala/scripts/batch-session.mjs && npx eslint apps/cala/scripts/batch-session.mjs
git add tools/cala-eval/stage_times.py tools/cala-eval/test_stage_times.py apps/cala/scripts/batch-session.mjs
git commit -m "feat(cala): unattended browser run script and stage times from an export"
```

---

### Task 7: Measurements, report and gate

**Files:**

- Create: `tools/cala-eval/results/<date of the runs>-factor-phase0.md`
- Modify: `docs/CHANGELOG.md` (one line under `## [Unreleased]`)

**Interfaces:**

- Consumes: `factor_arms.py` (Task 5), `stage_times.py` and `batch-session.mjs` (Task 6).
- Produces: the report, and the gate decision the phase 1 plan starts from: go or no-go, the tiling, and whether file recordings need a compression replay.

Recordings (`$DATA` is the dataset root; `$RUNS` an output folder outside the repository and outside every data folder):

| Name      | Folder under `$DATA`                                                     | Size, frames   | Truth |
| --------- | ------------------------------------------------------------------------ | -------------- | ----- |
| `plain`   | `synthetic/synth_v4_chal_plain/raw`                                      | 600 px, 18000  | yes   |
| `lowsnr`  | `synthetic/synth_v4_chal_lowsnr/raw`                                     | 600 px, 18000  | yes   |
| `dense`   | `synthetic/synth_v4_chal_dense/raw`                                      | 600 px, 18000  | yes   |
| `motion`  | `synthetic/synth_v4_chal_motion/raw`                                     | 600 px, 18000  | yes   |
| `wl200`   | `synthetic/synth_v4_chal_wl200/raw`                                      | 200 px, 36000  | yes   |
| `v4`      | `real_v4/v4_dataverse_20min/raw`                                         | 600 px, 20 fps | no    |
| `wl24_01` | `real_wireless/wl24_20251201/processed/cala_residual_history/input_grey` | 200 px         | no    |
| `wl24_04` | `real_wireless/wl24_20251204/processed/cala_residual_history/input_grey` | 200 px         | no    |

The truth file of a synthetic set is `<set>/truth.npz`.

- [ ] **Step 1: Native arms, one recording at a time**

For each recording (`NAME`, `REC`, and `TRUTH` where there is one):

```bash
uv run --no-project --with numpy python tools/cala-eval/factor_arms.py \
  --rec "$REC" --out "$RUNS/$NAME" --refine 5 --jobs 3 --truth "$TRUTH"
```

Start with `wl200`. Run the 600 px recordings one after another (three runs at once is the limit this script sets; do not start a second script beside it). A rerun skips finished arms. Each recording ends with `$RUNS/$NAME/report.md`.

Expected: every arm of every recording has `run.json` with return code 0. An arm that fails: read `$RUNS/$NAME/<arm>/run.log`, fix the cause, rerun the script.

- [ ] **Step 2: Browser stage times**

Build once, then run the two real recordings with and without compression (`RAW` is the recording's folder of AVIs):

```bash
npm ci && npm run build:e2e
node apps/cala/scripts/batch-session.mjs --data "$RAW" --out "$RUNS/browser/v4_default" --tag v4_default --refine-runs 1 --channel chrome
node apps/cala/scripts/batch-session.mjs --data "$RAW" --out "$RUNS/browser/v4_compress" --tag v4_compress --refine-runs 1 --channel chrome --query compress
```

and the same pair for `wl24_01`. Then:

```bash
uv run --no-project --with numpy python tools/cala-eval/stage_times.py $RUNS/browser/*/*.npz > $RUNS/browser/stage_times.md
```

Expected: four exports, each with a Discover, a Refine and an Extract row with outcome `done`. The driver writes a second `.npz` for CaDecon; if `stage_times.py` prints "no stage records" for it, leave it out of the report.

- [ ] **Step 3: Write the report**

Create `tools/cala-eval/results/<date of the runs>-factor-phase0.md` with these sections, filled from the files named:

```markdown
# Factor pipeline, phase 0: loss, tiling and baseline timing

Spec: `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`.
Commit: <git rev-parse --short HEAD>. Machine: <model, cores>.

## Decision

- Gate G0 (loss within the null spread for QC-pass cells): <passed | failed>
- Tiling for phase 1: <plain | overlap 8 | overlap 16 | two offset grids>
- File recordings: factors of <Discover | a compression replay>

## How it was measured

One paragraph: the arms of `factor_arms.py`, 5 refine replays, the null runs
(half and twice the slow-loop budget in the replays), cells matched by id.

## Loss against the null, per recording

One table: a row per recording and factor arm, with the trace and footprint
loss of the QC-pass cells, the largest null loss, and the verdict (from the
second table of each comparison in `$RUNS/<name>/report.md`).

## Tile lines

One table: a row per recording and tiling, with the loss of QC-pass cells under
8 px from a tile line and of those further away, the verdict of each, and the
footprint jump at tile lines (reference and test).

## Discover-time preprocessing

`plain` against `plain_recal` per recording: the two losses side by side.

## Extract alone

`x_<tiling>` against `x_raw` per recording: trace r median and 5th percentile
(the footprints are identical by construction), by SNR class.

## Truth (synthetic sets)

Median trace correlation with the truth: raw, each factor arm.

## Cost of the tilings

Mean rank, MB per 1000 frames and compression ms per frame per arm (the cost
table of each `report.md`), with the ratio to `plain`.

## Baseline timing and memory

Native: the stage table of the `raw` arm per recording (`stage_times.tsv`), and wall time and
peak memory per arm (the first table of each `report.md`).
Browser: `$RUNS/browser/stage_times.md`.

## What was not measured

Arm C does not exist yet. The motion band is only reported, not gated.
Whatever else was left out or failed.
```

Every number comes from a file under `$RUNS`; no number is typed from memory. Do not put `$RUNS` or `$DATA` paths of the machine into the report: name recordings by the names in the table above.

Apply the gate exactly:

- **G0 passes** when, on every recording, the `plain` arm (or `plain_recal`, if only it passes) is `within` for both the trace and the footprint loss of the QC-pass cells.
- **Tiling**: the cheapest arm (order: plain, overlap 8, two offset grids, overlap 16, by the cost table) for which "QC pass, under 8 px from a tile line" is `within` on every recording.
- **File recordings**: a compression replay only if `plain_recal` is `within` where `plain` is `outside`.
- If G0 fails for every arm, the decision is no-go, and the report says which cells carry the loss (SNR class, tile line, border) so the spec's remedies (lower `rho_min`, higher starting rank) can be tried in a follow-up.

- [ ] **Step 4: Changelog and commit**

Add under `## [Unreleased]` in `docs/CHANGELOG.md`:

```markdown
- cala evaluation: `qc_eval` can run the refine replays and an Extract pass on frames rebuilt from
  the compressed factors (`--replay-source factors`, `--tiling`, `--factors-pass`, `--extract-pass`),
  with overlapping and offset tilings in `compress::blend`; `tools/cala-eval/factor_arms.py` and
  `factor_closeness.py` compare them with the raw replay. No change to the app.
```

```bash
npx prettier --write docs/CHANGELOG.md tools/cala-eval/results/*-factor-phase0.md
git add docs/CHANGELOG.md tools/cala-eval/results/*-factor-phase0.md
git commit -m "docs(cala-eval): phase 0 results of the factor pipeline"
```

- [ ] **Step 5: Final check**

```bash
cd crates/cala && cargo fmt --all --check && cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings && cargo test --no-default-features --features jsbindings && cd ../..
uv run --no-project --with numpy python -m unittest discover tools/cala-eval
npm run format:check && npm run lint
```

Expected: all pass. Then report the decision to the user; phase 1 is planned only after they have read the report.
