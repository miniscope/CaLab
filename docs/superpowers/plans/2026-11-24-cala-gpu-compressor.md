# cala GPU compressor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a recording compresses its frames on the GPU while Discover runs, so its Final settle and Extract read factors
and the run finishes sooner than on the file.

**Architecture:** the compress worker already receives every batch after the back half. With `?factors=gpu` it
quantizes the batch to `i16` (WASM), adds it to exact per-pixel integer sums (WASM `WindowStats`) and uploads it into a
ring buffer on the GPU. At each window's end the GPU runs today's randomized SVD per tile (the CPU compressor's own
random draws, CholeskyQR2 for the QR steps); WASM finishes each tile (eigen step, lag-1 cut, growth, bytes). The factor
files are today's v2 files, so the settle reader and Extract read them unchanged. The settle then runs on the whole
settle pool.

**Tech Stack:** Rust (`crates/cala`, wasm-bindgen), TypeScript + WGSL (WebGPU in a dedicated worker), Solid, Vitest,
Playwright (`live-measure.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-24-cala-gpu-compressor-design.md`

## Global Constraints

- Discover never waits for the compressor; a GPU that falls behind or is lost gives up the run's factors (file path).
- Factor files stay format v2 (`CALAFAC2` header via `factorHeader`, then per tile `u32` length + `TileFactors::to_bytes`).
- Memory per run is fixed by the window length, not the recording length.
- Window ladder 600 → 300 → 150 (floor set by Task 1), first that allocates wins; none: no factors.
- Streams are unchanged (CPU compress pool).
- `?factors=gpu` until the gate (Task 7) passes; only then the default for recordings, `?factors=0` off.
- Owner's rules: unit tests only for logic that can hang, lose data or change an export, plus the e2e and the
  measurements; commits one sentence with a conventional prefix, no body, no attribution; no machine paths or user
  names in committed files; push or PR only with the owner's yes; never bare `git stash`; long shell commands in a
  script under the git-ignored `.scratch/`; measurements in local Google Chrome with the profile on the evaluation SSD,
  never while another session measures; the input folder of `live-measure.mjs` must be a real folder (not a symlink)
  of numbered plain AVIs.
- Format and lint before each commit: `cargo fmt` and `cargo clippy --release --all-targets --features jsbindings`
  in `crates/cala`; `npx prettier --write` and `npx eslint` on changed TS; `npm run typecheck` at the repo root.

## Review Focus

1. **A recording whose ranks grow past the GPU sketch (l > 128)** must not hang or write a broken file: the run gives
   up its factors with a reason (Task 3 test with a fake job that keeps growing).
2. **A window length that does not divide the recording** (last window shorter, a last window of 1 frame) must give a
   file whose windows cover every frame but a 1-frame tail, as the CPU path does (Task 4 test).
3. **An odd number of pixels per frame** (e.g. 33 x 33): ring frames are padded to whole `u32` words, so a slot never
   starts mid-word and the tile values do not shift by one sample (Task 3 `ringFrameBytes` test).
4. **Missing samples (`-32768`)** count as the pixel's mean, as on the CPU (Task 2 stats test with missing samples).
5. **A new run while a window is still compressing on the GPU** must not write the old run's tiles into the new run's
   folder (Task 4 test: reset during a pending `compress`).

---

## File Structure

| file                                                                                                                                                     | responsibility                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `crates/cala/src/compress/mod.rs` (modify)                                                                                                               | split `rsvd` and `compress_tile` into reusable steps; `WindowStats`, `TileStats`, `omega_draws`, `chol_inv_upper` |
| `crates/cala/src/compress/gpu.rs` (create)                                                                                                               | `GpuTile`: one tile's sketch sizes, draws and finish from a GPU sketch                                            |
| `crates/cala/src/compress/js.rs` (modify)                                                                                                                | bindings `WindowStats`, `GpuTileJob`, `cholInvUpperBatch`, `quantizeFrames`                                       |
| `apps/cala/src/lib/gpu-compress-kernels.ts` (create)                                                                                                     | WGSL sources                                                                                                      |
| `apps/cala/src/lib/gpu-compress.ts` (create)                                                                                                             | `RingClock`, the ladder, `GpuCompressor` (device, buffers, one window to tile bytes)                              |
| `apps/cala/src/lib/compress-runner.ts` (modify)                                                                                                          | routes a GPU run's chunks; windows, overflow, device loss, status                                                 |
| `apps/cala/src/workers/compress-types.ts`, `compress-feed.ts`, `factor-run.ts`, `pipeline-store.ts`, `App.tsx`, `factor-settle.ts`, `export.ts` (modify) | the `?factors=gpu` flag, status and export fields, the settle's wait                                              |
| `apps/cala/src/lib/slow-runner.ts` (modify)                                                                                                              | the settle on factors over the whole settle pool                                                                  |
| `apps/cala/src/__tests__/gpu-compress.test.ts` (create)                                                                                                  | ring clock, ladder, growth limit                                                                                  |
| `tools/cala-eval/results/2026-11-2x-*.md` (create)                                                                                                       | Task 1, 5, 6, 7 reports                                                                                           |

---

### Task 1: Window length check (measurement only)

**Files:**

- Create: `.scratch/probe_window_length.py` (git-ignored, not committed)
- Create: `tools/cala-eval/results/2026-11-25-gpu-window-length.md`

**Interfaces:**

- Produces: the ladder's floor, a constant used in Task 3: `GPU_WINDOW_LADDER` (`[600, 300, 150]` or `[600, 300]`).

- [ ] **Step 1: Write the probe**

Inputs: the 2,400-frame `CALAWIN1` files of 24 Nov (V4 from `cafast_v4_3h` files 17-19, wl24 from frame 20,000 of
`runs/svd_dimcells_20261117/work/frames.i16`); rebuild them with `.scratch/make_window_multi.py` if the scratchpad
was cleared. The probe reuses `today()` from `.scratch/probe_singlepass.py` (the CPU algorithm in numpy).

```python
"""Window length check: the same 1,200 frames compressed as 2 x 600, 4 x 300 and 8 x 150 windows."""
import sys

import numpy as np

from probe_singlepass import load, today

def run(path: str, start: int, total: int) -> None:
    data, w, h = load(path)
    data = data[start : start + total]
    rows = []
    for win in (600, 300, 150):
        err = sig = 0.0
        rank = tiles = floats = 0
        for w0 in range(0, total, win):
            block = data[w0 : w0 + win]
            for y0 in range(0, h, 64):
                for x0 in range(0, w, 64):
                    a = block[:, y0 : y0 + 64, x0 : x0 + 64].reshape(win, -1).T.copy()
                    a -= a.mean(1, keepdims=True)
                    lr, r = today(a, np.random.default_rng(w0 * 1000 + tiles))
                    err += float(((a - lr) ** 2).sum())
                    sig += float((a * a).sum())
                    rank += r
                    tiles += 1
                    floats += r * (a.shape[0] + win) + 3 * a.shape[0]
        rows.append((win, rank / tiles, err / sig, floats * 4 / total))
    print(path.split("/")[-1])
    for win, r, e, b in rows:
        print(f"  W={win}: mean rank {r:.2f}, residual share {e:.4f}, {b:.0f} bytes/frame")

if __name__ == "__main__":
    run(sys.argv[1], 0, 1200)
```

- [ ] **Step 2: Run it**

Run (MiniMe's venv has numpy; from `.scratch/`):
`<MiniMe venv>/bin/python probe_window_length.py <scratchpad>/v4_4w.i16` and the same for `wl24_4w.i16`.
Expected: three lines per recording. "Residual share" is the part of the frames the factors leave out (noise plus
what the cut dropped); a shorter window that keeps less signal shows a higher share and a lower rank.

- [ ] **Step 3: Decide the floor and write the report**

Rule: a window length is allowed if its mean rank is within 10 % of W = 600's and its residual share within 1 % of
W = 600's on both recordings. The ladder is 600, then every allowed shorter length in descending order. Write
`tools/cala-eval/results/2026-11-25-gpu-window-length.md` (short: data, method, the table, the rule, the ladder).

- [ ] **Step 4: Commit**

```bash
git add tools/cala-eval/results/2026-11-25-gpu-window-length.md
git commit -m "docs(cala-eval): how short a factor window may be before it keeps less signal"
```

---

### Task 2: Rust: the CPU compressor's steps, reusable for a GPU sketch

**Files:**

- Modify: `crates/cala/src/compress/mod.rs` (`TileMatrix::new` stats, `rsvd`, `compress_tile`)
- Create: `crates/cala/src/compress/gpu.rs`
- Modify: `crates/cala/src/compress/js.rs`
- Test: `crates/cala/src/compress/gpu.rs` (`#[cfg(test)]`)

**Interfaces:**

- Produces (Rust, `compress` module):
  - `pub struct WindowStats` with `new(width: usize, height: usize)`, `push(&mut self, frames: &[i16])`,
    `frames(&self) -> usize`, `reset(&mut self)`, `tile(&self, x0, y0, w, h, quant: f32) -> TileStats`
  - `pub struct TileStats { pub mean: Vec<f32>, pub ss: Vec<f64>, pub valid: Vec<f32>, pub energy: f64 }`
  - `pub fn omega_draws(seed: u64, t: usize, skip: usize, l: usize) -> Vec<f32>` (draws `skip .. skip + t*l` of the
    tile's `Normals` stream, `(t, l)` row-major)
  - `pub fn chol_inv_upper(g: &[f32], stride: usize, l: usize) -> Option<Vec<f32>>` (`R⁻¹`, `stride x stride`,
    zero outside `l x l`, with `Rᵀ R = G[..l, ..l]`; `None` if not positive definite after shifts)
  - `pub struct GpuTile` (in `gpu.rs`), see Step 5
- Produces (JS, `cala-wasm.ts` re-exports): `WindowStats`, `GpuTileJob`, `cholInvUpperBatch(g, stride, ls)`,
  `quantizeFrames(frames, quant)`.

- [ ] **Step 1: Stats from integer sums, shared by `TileMatrix::new` and `WindowStats`**

In `mod.rs`, move the mean / ss / valid / energy computation of `TileMatrix::new` (the code after the accumulation
loop, lines ~708-760) into:

```rust
/// Per-pixel statistics of one tile and window from its exact integer sums
/// (`acc` = Σ v, `sq` = Σ v², `cnt` = valid samples, over `t` frames).
pub struct TileStats {
    pub mean: Vec<f32>,
    pub ss: Vec<f64>,
    pub valid: Vec<f32>,
    pub energy: f64,
}

fn stats_from_sums(acc: &[i64], sq: &[i64], cnt: &[u32], t: usize, quant: f32) -> TileStats {
    // the existing formulas of TileMatrix::new, unchanged: mean (0 when cnt = 0),
    // ss = max(0, sq - acc²/cnt) / quant², valid = cnt / t, energy = Σ ss
}
```

`TileMatrix::new` keeps its accumulation loop and calls `stats_from_sums`. Then add:

```rust
/// Exact per-pixel integer sums of a window of quantized frames in frame
/// layout (the GPU compressor's side of `TileMatrix::new`).
pub struct WindowStats {
    width: usize,
    height: usize,
    acc: Vec<i64>,
    sq: Vec<i64>,
    cnt: Vec<u32>,
    frames: usize,
}

impl WindowStats {
    pub fn new(width: usize, height: usize) -> WindowStats {
        let n = width * height;
        WindowStats { width, height, acc: vec![0; n], sq: vec![0; n], cnt: vec![0; n], frames: 0 }
    }
    /// Add whole frames (`frames.len()` a multiple of the frame's pixels).
    pub fn push(&mut self, frames: &[i16]) {
        let n = self.width * self.height;
        for f in frames.chunks_exact(n) {
            for (i, &v) in f.iter().enumerate() {
                if v != MISSING {
                    let v = i64::from(v);
                    self.acc[i] += v;
                    self.sq[i] += v * v;
                    self.cnt[i] += 1;
                }
            }
            self.frames += 1;
        }
    }
    pub fn frames(&self) -> usize { self.frames }
    /// Per frame pixel, `stats_from_sums`'s mean (0 where no valid sample).
    pub fn mean(&self, quant: f32) -> Vec<f32> {
        stats_from_sums(&self.acc, &self.sq, &self.cnt, self.frames, quant).mean
    }
    pub fn reset(&mut self) {
        self.acc.fill(0); self.sq.fill(0); self.cnt.fill(0); self.frames = 0;
    }
    /// The statistics of the tile `(x0, y0, w, h)`, pixels row by row as `compress_tile` reads them.
    pub fn tile(&self, x0: usize, y0: usize, w: usize, h: usize, quant: f32) -> TileStats {
        let mut acc = Vec::with_capacity(w * h);
        let mut sq = Vec::with_capacity(w * h);
        let mut cnt = Vec::with_capacity(w * h);
        for y in y0..y0 + h {
            let r = y * self.width + x0;
            acc.extend_from_slice(&self.acc[r..r + w]);
            sq.extend_from_slice(&self.sq[r..r + w]);
            cnt.extend_from_slice(&self.cnt[r..r + w]);
        }
        stats_from_sums(&acc, &sq, &cnt, self.frames, quant)
    }
}
```

- [ ] **Step 2: Split `rsvd` and `compress_tile` (no behaviour change)**

In `mod.rs`:

```rust
/// Sketch columns and rank of a rank-`k` randomized SVD of a `p x t` tile.
pub fn sketch_dims(p: usize, t: usize, k: usize) -> (usize, usize) {
    let l = (k + N_OVERSAMPLES).min(p).min(t);
    (l, k.min(l))
}

/// The SVD from the range basis `q` (`p x l`, row-major, `stride` columns)
/// and `bt = Yᵀ q` (`t x l`, `stride` columns): the tail of `rsvd`.
fn svd_from_qb(q: &[f32], bt: &[f32], p: usize, t: usize, l: usize, k: usize, stride: usize) -> Svd
```

Move the body of `rsvd` after `let bt = y.t_matmul(&q, l);` into `svd_from_qb`, reading `q[i * stride + a]` and
`bt[i * stride + a]` instead of `q[i * l + a]` / `bt[i * l + a]`. `rsvd` becomes: sketch and power iterations as now,
then `svd_from_qb(&q, &bt, p, t, l, k, l)`.

Split the loop of `compress_tile`:

```rust
/// The rank cut's threshold for a window of `t` frames.
pub fn rank_threshold(cfg: &CompressConfig, t: usize) -> f64 {
    (cfg.z / (t as f64).sqrt()).max(cfg.rho_min)
}

/// The largest rank of a `p`-pixel tile over `t` frames.
pub fn rank_cap(cfg: &CompressConfig, p: usize, t: usize) -> usize {
    cfg.max_rank.min(p.saturating_sub(1)).min(t.saturating_sub(1)).max(1)
}

/// `Some(next k)` when one of the last `ADAPT_MARGIN` components passes the cut and `k` may still grow.
fn grow(svd: &Svd, k: usize, k_cap: usize, thr: f64, t: usize) -> Option<usize>

/// The kept components as a tile (position left at 0), from the statistics of its frames.
fn pack_tile(svd: Svd, stats: TileStats, t: usize, p: usize, thr: f64) -> TileFactors
```

`compress_tile` becomes:

```rust
let y = TileMatrix::new(raw, t, p, cfg.quant);
let k_cap = rank_cap(cfg, p, t);
let mut k = cfg.k0.clamp(1, k_cap);
let mut rng = Normals::new(seed);
let thr = rank_threshold(cfg, t);
loop {
    let svd = rsvd(&y, k, cfg.n_iter, &mut rng);
    match grow(&svd, k, k_cap, thr, t) {
        Some(k2) => k = k2,
        None => return pack_tile(svd, y.stats(), t, p, thr),
    }
}
```

(`TileMatrix` keeps its `TileStats` in a field `stats`; `y.stats()` moves it out or clones it; `pack_tile` contains the
existing code from `if !keep.iter().any(...)` to the end, with `y.ss` → `stats.ss`, `y.mean` → `stats.mean`, etc.)

- [ ] **Step 3: Run the existing compress tests (the refactor must not change a byte)**

Run: `cd crates/cala && cargo test --release --lib compress`
Expected: all pass (63 + 1 before this task).

- [ ] **Step 4: Draws and the batched Cholesky**

```rust
/// Draws `skip .. skip + t * l` of a tile's random stream (`Normals::new(seed)`),
/// `(t, l)` row-major: the `Ω` that `compress_tile` uses for a sketch of `l`
/// columns after sketches that took `skip` draws.
pub fn omega_draws(seed: u64, t: usize, skip: usize, l: usize) -> Vec<f32> {
    let mut rng = Normals::new(seed);
    for _ in 0..skip { rng.next(); }
    (0..t * l).map(|_| rng.next()).collect()
}

/// `R⁻¹` of the Cholesky factor of `G[..l, ..l]` (`G` is `stride x stride`,
/// row-major), as `stride x stride` with zeros outside `l x l`: CholeskyQR's
/// step. A non-positive pivot retries with a diagonal shift of `1e-10`, `1e-8`,
/// ... `1e-2` times the trace; `None` if all fail.
pub fn chol_inv_upper(g: &[f32], stride: usize, l: usize) -> Option<Vec<f32>> {
    let tr: f64 = (0..l).map(|i| f64::from(g[i * stride + i])).sum();
    for shift in [0.0, 1e-10, 1e-8, 1e-6, 1e-4, 1e-2] {
        let mut r = vec![0.0f64; l * l];
        let mut ok = true;
        'rows: for i in 0..l {
            for j in i..l {
                let mut s = f64::from(g[i * stride + j]) + if i == j { shift * tr } else { 0.0 };
                for k in 0..i { s -= r[k * l + i] * r[k * l + j]; }
                if i == j {
                    if s <= 0.0 { ok = false; break 'rows; }
                    r[i * l + i] = s.sqrt();
                } else {
                    r[i * l + j] = s / r[i * l + i];
                }
            }
        }
        if !ok { continue; }
        let mut out = vec![0.0f32; stride * stride];
        for j in 0..l {
            let mut col = vec![0.0f64; j + 1];
            for i in (0..=j).rev() {
                let mut s = if i == j { 1.0 } else { 0.0 };
                for k in i + 1..=j { s -= r[i * l + k] * col[k]; }
                col[i] = s / r[i * l + i];
            }
            for i in 0..=j { out[i * stride + j] = col[i] as f32; }
        }
        return Some(out);
    }
    None
}
```

`Normals::next` must be callable here (it is private to `mod.rs`; `omega_draws` lives in `mod.rs`).

- [ ] **Step 5: `GpuTile`**

Create `crates/cala/src/compress/gpu.rs` and add `pub mod gpu;` to `mod.rs`:

```rust
//! One tile of a window compressed on the GPU: the sketch sizes and random
//! draws `compress_tile` would use, and the finish from the GPU's range basis
//! `Q` and `Bᵀ = Yᵀ Q` (the eigen step, the lag-1 cut, the growth rule, the
//! bytes). With the same draws the result is `compress_tile`'s up to float
//! rounding (CholeskyQR instead of Householder QR, other summation order).

use super::{
    grow, omega_draws, pack_tile, rank_cap, rank_threshold, sketch_dims, svd_from_qb,
    tile_config, CompressConfig, TileStats,
};

pub struct GpuTile {
    cfg: CompressConfig,
    stats: Option<TileStats>,
    seed: u64,
    t: usize,
    p: usize,
    pos: (usize, usize, usize, usize),
    k: usize,
    k_cap: usize,
    thr: f64,
    /// Draws taken by earlier sketches of this tile.
    drawn: usize,
    rank: usize,
}

impl GpuTile {
    pub fn new(cfg: &CompressConfig, stats: TileStats, pos: (usize, usize, usize, usize),
               t: usize, seed: u64, prev_rank: Option<usize>) -> GpuTile {
        let p = pos.2 * pos.3;
        let cfg = tile_config(cfg, prev_rank);
        let k_cap = rank_cap(&cfg, p, t);
        GpuTile { k: cfg.k0.clamp(1, k_cap), thr: rank_threshold(&cfg, t), cfg, stats: Some(stats),
                  seed, t, p, pos, k_cap, drawn: 0, rank: 0 }
    }
    /// Sketch columns of the current sketch.
    pub fn l(&self) -> usize { sketch_dims(self.p, self.t, self.k).0 }
    pub fn n_iter(&self) -> usize { self.cfg.n_iter }
    /// The current sketch's `Ω` (`t x l`, row-major).
    pub fn omega(&self) -> Vec<f32> { omega_draws(self.seed, self.t, self.drawn, self.l()) }
    /// Finish from `q` (`p x stride`) and `bt` (`t x stride`). `None`: the
    /// sketch grew (call `l`, `omega` again and sketch anew).
    pub fn finish(&mut self, q: &[f32], bt: &[f32], stride: usize) -> Option<Vec<u8>> {
        let (l, k) = sketch_dims(self.p, self.t, self.k);
        let svd = svd_from_qb(q, bt, self.p, self.t, l, k, stride);
        if let Some(k2) = grow(&svd, self.k, self.k_cap, self.thr, self.t) {
            self.drawn += self.t * l;
            self.k = k2;
            return None;
        }
        let mut tf = pack_tile(svd, self.stats.take().expect("finished once"), self.t, self.p, self.thr);
        (tf.x0, tf.y0, tf.w, tf.h) = self.pos;
        self.rank = tf.rank;
        Some(tf.to_bytes())
    }
    pub fn rank(&self) -> usize { self.rank }
}
```

(`grow`, `pack_tile`, `svd_from_qb`, `omega_draws` become `pub(super)` or `pub(crate)`.)

- [ ] **Step 6: Write the equivalence test (a CPU emulation of the GPU path)**

In `gpu.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::{chol_inv_upper, compress_tile, quantize, TileFactors, WindowStats, MISSING};

    /// `C = A B` with `A` `m x k`, `B` `k x n` (row-major, f32).
    fn mm(a: &[f32], b: &[f32], m: usize, k: usize, n: usize) -> Vec<f32> {
        let mut c = vec![0.0f32; m * n];
        for i in 0..m { for kk in 0..k { let v = a[i * k + kk]; if v == 0.0 { continue; }
            for j in 0..n { c[i * n + j] += v * b[kk * n + j]; } } }
        c
    }
    fn tr(a: &[f32], m: usize, n: usize) -> Vec<f32> {
        let mut o = vec![0.0f32; m * n];
        for i in 0..m { for j in 0..n { o[j * m + i] = a[i * n + j]; } }
        o
    }
    fn cholqr2(y: &[f32], m: usize, l: usize) -> Vec<f32> {
        let mut q = y.to_vec();
        for _ in 0..2 {
            let g = mm(&tr(&q, m, l), &q, l, m, l);
            let r = chol_inv_upper(&g, l, l).expect("positive definite");
            q = mm(&q, &r, m, l, l);
        }
        q
    }

    /// The GPU path in plain Rust: centred `A` (`p x t`), `Ω` from the tile,
    /// CholeskyQR2, `n_iter` power iterations, `Bᵀ = Aᵀ Q`, `finish`.
    fn via_gpu_path(raw: &[i16], w: usize, h: usize, t: usize, seed: u64, prev: Option<usize>) -> TileFactors {
        let cfg = CompressConfig::default();
        let mut stats = WindowStats::new(w, h);
        stats.push(raw);
        let s = stats.tile(0, 0, w, h, cfg.quant);
        let p = w * h;
        let mut a = vec![0.0f32; p * t];
        for tt in 0..t { for i in 0..p {
            let v = raw[tt * p + i];
            a[i * t + tt] = if v == MISSING { 0.0 } else { f32::from(v) / cfg.quant - s.mean[i] };
        } }
        let mut job = GpuTile::new(&cfg, s, (0, 0, w, h), t, seed, prev);
        loop {
            let l = job.l();
            let mut q = cholqr2(&mm(&a, &job.omega(), p, t, l), p, l);
            for _ in 0..job.n_iter() {
                let z = cholqr2(&mm(&tr(&a, p, t), &q, t, p, l), t, l);
                q = cholqr2(&mm(&a, &z, p, t, l), p, l);
            }
            let bt = mm(&tr(&a, p, t), &q, t, p, l);
            if let Some(bytes) = job.finish(&q, &bt, l) {
                return TileFactors::from_bytes(&bytes).unwrap();
            }
        }
    }

    fn synth_raw(w: usize, h: usize, t: usize, missing: bool) -> Vec<i16> {
        // 5 Gaussian blobs with slow random-walk traces plus white noise, quantized at 64;
        // with `missing`, every 7th sample of pixel 3 is MISSING.
        let mut out = Vec::with_capacity(w * h * t);
        let mut state = 12345u64;
        let mut rnd = || { state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                           ((state >> 33) as f32 / (1u64 << 31) as f32) - 0.5 };
        let centres = [(5.0, 6.0), (20.0, 9.0), (12.0, 22.0), (27.0, 27.0), (8.0, 28.0)];
        let mut amp = [0.0f32; 5];
        for tt in 0..t {
            for a in amp.iter_mut() { *a = (*a * 0.95 + rnd()).max(0.0); }
            for y in 0..h { for x in 0..w {
                let mut v = 2.0 * rnd();
                for (c, (cx, cy)) in centres.iter().enumerate() {
                    let d2 = (x as f32 - cx).powi(2) + (y as f32 - cy).powi(2);
                    v += 8.0 * amp[c] * (-d2 / 8.0).exp();
                }
                let i = y * w + x;
                out.push(if missing && i == 3 && tt % 7 == 0 { MISSING } else { quantize(v, 64.0) });
            } }
        }
        out
    }

    fn assert_close(g: &TileFactors, c: &TileFactors) {
        assert_eq!(g.rank, c.rank, "rank");
        assert_eq!(g.svd_rank, c.svd_rank, "svd rank");
        assert_eq!(g.mean, c.mean);
        assert_eq!(g.valid, c.valid);
        let t = g.temporal.len() / g.rank;
        let p = g.mean.len();
        // Compare W Vᵀ (sign- and rotation-free).
        let lr = |f: &TileFactors| { let mut o = vec![0.0f64; p * t];
            for i in 0..p { for j in 0..t { for r in 0..f.rank {
                o[i * t + j] += f64::from(f.spatial[i * f.rank + r]) * f64::from(f.temporal[j * f.rank + r]); } } }
            o };
        let (a, b) = (lr(g), lr(c));
        let d: f64 = a.iter().zip(&b).map(|(x, y)| (x - y).powi(2)).sum();
        let n: f64 = b.iter().map(|y| y * y).sum();
        assert!(d / n < 1e-6, "relative difference {}", d / n);
        for (x, y) in g.discarded.iter().zip(&c.discarded) { assert!((x - y).abs() <= 1e-3 * y.abs().max(1e-3)); }
    }

    #[test]
    fn the_gpu_path_gives_compress_tiles_factors() {
        let (w, h, t) = (32, 32, 300);
        for (missing, prev) in [(false, None), (true, None), (false, Some(6))] {
            let raw = synth_raw(w, h, t, missing);
            let cfg = CompressConfig { k0: prev.map_or(40, |r| crate::compress::k0_after(r, 40)), ..CompressConfig::default() };
            let cpu = compress_tile(&raw, t, w * h, &cfg, 9);
            let gpu = via_gpu_path(&raw, w, h, t, 9, prev);
            assert_close(&gpu, &cpu);
        }
    }

    #[test]
    fn a_tile_whose_tail_passes_grows_and_draws_on() {
        // k0 = 2 forces growth on a 5-blob tile.
        let (w, h, t) = (32, 32, 300);
        let raw = synth_raw(w, h, t, false);
        let cfg = CompressConfig { k0: 2, adapt_k0: false, ..CompressConfig::default() };
        let cpu = compress_tile(&raw, t, w * h, &cfg, 4);
        let mut stats = WindowStats::new(w, h);
        stats.push(&raw);
        let job = GpuTile::new(&cfg, stats.tile(0, 0, w, h, cfg.quant), (0, 0, w, h), t, 4, None);
        assert_eq!(job.l(), 12);
        assert!(cpu.svd_rank > 2, "the CPU tile grew");
    }
}
```

(`via_gpu_path` uses `CompressConfig::default()` inside; for the `prev` case `GpuTile::new` applies `tile_config`
itself, which is why the CPU side builds its `cfg` with `k0_after`.)

- [ ] **Step 7: Run the new tests**

Run: `cd crates/cala && cargo test --release --lib compress::gpu`
Expected: PASS. If `the_gpu_path_gives_compress_tiles_factors` fails on `rank`, print both `svd.s` and the lag-1
values at the cut: a component exactly at the threshold may flip with rounding; in that case use a synthetic tile with
clearer separation (larger blob amplitude), not a looser assertion.

- [ ] **Step 8: Bindings**

In `js.rs`:

```rust
#[wasm_bindgen(js_name = WindowStats)]
pub struct JsWindowStats { inner: WindowStats }

#[wasm_bindgen(js_class = WindowStats)]
impl JsWindowStats {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> JsWindowStats {
        JsWindowStats { inner: WindowStats::new(width as usize, height as usize) }
    }
    pub fn push(&mut self, frames: &[i16]) { self.inner.push(frames) }
    pub fn frames(&self) -> u32 { self.inner.frames() as u32 }
    pub fn reset(&mut self) { self.inner.reset() }
    /// Per frame pixel, the mean over the window's valid samples (0 where none): what the GPU subtracts.
    pub fn mean(&self, quant: f32) -> Vec<f32> { self.inner.mean(quant) }
}

#[wasm_bindgen(js_name = GpuTileJob)]
pub struct JsGpuTileJob { inner: GpuTile }

#[wasm_bindgen(js_class = GpuTileJob)]
impl JsGpuTileJob {
    /// `prev_rank`: the rank this tile kept in the previous window (absent or 0: none).
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(stats: &JsWindowStats, quant: f32, x0: u32, y0: u32, w: u32, h: u32, seed: u32,
               prev_rank: Option<u32>) -> JsGpuTileJob {
        let cfg = CompressConfig { quant, ..CompressConfig::default() };
        let (x0, y0, w, h) = (x0 as usize, y0 as usize, w as usize, h as usize);
        let s = stats.inner.tile(x0, y0, w, h, quant);
        let prev = prev_rank.filter(|&r| r > 0).map(|r| r as usize);
        JsGpuTileJob { inner: GpuTile::new(&cfg, s, (x0, y0, w, h), stats.inner.frames(), u64::from(seed), prev) }
    }
    pub fn l(&self) -> u32 { self.inner.l() as u32 }
    #[wasm_bindgen(js_name = nIter)]
    pub fn n_iter(&self) -> u32 { self.inner.n_iter() as u32 }
    pub fn omega(&self) -> Vec<f32> { self.inner.omega() }
    /// The tile's bytes (`TileFactors::to_bytes`), or `undefined` when the sketch grew.
    pub fn finish(&mut self, q: &[f32], bt: &[f32], stride: u32) -> Option<Vec<u8>> {
        self.inner.finish(q, bt, stride as usize)
    }
    pub fn rank(&self) -> u32 { self.inner.rank() as u32 }
}

/// CholeskyQR's `R⁻¹` for a batch: `g` holds `ls.len()` Gram matrices of
/// `stride x stride`; returns as many `R⁻¹` blocks. Errors if one is not
/// positive definite after the shifts.
#[wasm_bindgen(js_name = cholInvUpperBatch)]
pub fn chol_inv_upper_batch(g: &[f32], stride: u32, ls: &[u32]) -> Result<Vec<f32>, JsError> {
    let s = stride as usize;
    let mut out = Vec::with_capacity(ls.len() * s * s);
    for (i, &l) in ls.iter().enumerate() {
        let block = &g[i * s * s..(i + 1) * s * s];
        let r = chol_inv_upper(block, s, l as usize)
            .ok_or_else(|| js_err("cholInvUpperBatch", format!("tile {i} is not positive definite")))?;
        out.extend_from_slice(&r);
    }
    Ok(out)
}

/// Frames quantized as the compressor buffers them (`quantize`; non-finite: missing).
#[wasm_bindgen(js_name = quantizeFrames)]
pub fn quantize_frames(frames: &[f32], quant: f32) -> Vec<i16> {
    frames.iter().map(|&v| if v.is_finite() { quantize(v, quant) } else { MISSING }).collect()
}
```

Check `WindowCompressor::push`'s handling of non-finite values and match it exactly in `quantize_frames` (it is the
reference: "a non-finite pixel is a missing sample"). Add `WindowStats`, `GpuTileJob`, `cholInvUpperBatch`,
`quantizeFrames` to the exports of `apps/cala/src/lib/cala-wasm.ts` (both export lists there, as for
`TileCompressor`).

- [ ] **Step 9: Build, test, lint, commit**

Run: `cd crates/cala && cargo test --release --lib && cargo fmt && cargo clippy --release --all-targets --features jsbindings`
and at the repo root `npm run typecheck` (rebuilds the WASM package).
Expected: all pass, no warnings.

```bash
git add crates/cala apps/cala/src/lib/cala-wasm.ts
git commit -m "feat(cala): the compressor's steps a GPU sketch needs, with the CPU's draws, in WASM"
```

---

### Task 3: The GPU compressor (kernels, ring, ladder)

**Files:**

- Create: `apps/cala/src/lib/gpu-compress-kernels.ts`
- Create: `apps/cala/src/lib/gpu-compress.ts`
- Test: `apps/cala/src/__tests__/gpu-compress.test.ts`

**Interfaces:**

- Consumes: `WindowStats`, `GpuTileJob`, `cholInvUpperBatch` (Task 2); `GPU_WINDOW_LADDER` floor (Task 1).
- Produces:

```ts
export const GPU_WINDOW_LADDER: readonly number[]; // from Task 1, e.g. [600, 300, 150]
export const GPU_TILE_BATCH = 12;
export const GPU_MAX_STRIDE = 128; // sketch columns the work buffers hold

/** Which stream frames the ring holds and which it may overwrite. Pure. */
export class RingClock {
  constructor(window: number, slack: number);
  readonly size: number; // window + slack
  /** Ring slot of stream frame `f`. */
  slot(f: number): number;
  /** Frames `[start, start + count)` fit without overwriting a frame >= `keepFrom`. */
  fits(start: number, count: number, keepFrom: number): boolean;
}

/** What the compressor needs of the WASM `WindowStats` (tests pass fakes). */
export interface WindowStatsLike {
  push(frames: Int16Array): void;
  frames(): number;
  reset(): void;
  mean(quant: number): Float32Array;
  free(): void;
}

/** What the compressor needs of the WASM `GpuTileJob` (tests pass fakes). */
export interface GpuTileJobLike {
  l(): number;
  nIter(): number;
  omega(): Float32Array;
  finish(q: Float32Array, bt: Float32Array, stride: number): Uint8Array | undefined;
  rank(): number;
  free(): void;
}

export interface GpuWindowJob {
  index: number; // factor file index
  start: number; // stream frame of the window's first frame
  frames: number;
  stats: WindowStatsLike;
  seeds: (tile: number) => number;
  prevRanks: (tile: number) => number | undefined;
}

export interface GpuWindowResult {
  tiles: Uint8Array[];
  ranks: number[];
  ms: number;
}

export interface GpuCompressorLike {
  readonly window: number;
  readonly slack: number;
  /** Upload quantized frames (frame layout) at stream frame `start`; the caller checks `RingClock.fits` first. */
  upload(frames: Int16Array, start: number, count: number): void;
  /** Compress one window whose frames are uploaded; rejects with `GpuSketchTooLarge` or a device error. */
  compress(job: GpuWindowJob): Promise<GpuWindowResult>;
  /** Resolves with a reason when the device is lost. */
  readonly lost: Promise<string>;
  destroy(): void;
}

export class GpuSketchTooLarge extends Error {}

/** Try the ladder; `{ reason }` when no window length fits or there is no WebGPU. */
export async function openGpuCompressor(o: {
  width: number;
  height: number;
  tile: number;
  tiling: string;
  quant: number;
  gpu?: GPU | undefined; // navigator.gpu (tests pass a fake or undefined)
  layout: (w: number, h: number, tile: number, tiling: string) => Uint32Array; // tileLayout
  /** Default: `new GpuTileJob(stats as WindowStats, ...)` (WASM). */
  jobs?: (
    stats: WindowStatsLike,
    quant: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
    seed: number,
    prevRank: number | undefined,
  ) => GpuTileJobLike;
}): Promise<GpuCompressorLike | { reason: string }>;

export function ringFrameBytes(hw: number): number; // (hw + (hw & 1)) * 2
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/cala/src/__tests__/gpu-compress.test.ts
import { describe, expect, it } from 'vitest';
import { RingClock, openGpuCompressor, GPU_WINDOW_LADDER } from '../lib/gpu-compress.ts';

describe('RingClock', () => {
  it('maps stream frames to slots and refuses to overwrite a window not yet compressed', () => {
    const r = new RingClock(600, 150);
    expect(r.size).toBe(750);
    expect(r.slot(0)).toBe(0);
    expect(r.slot(751)).toBe(1);
    // Window [0, 600) compressing; frames up to 750 fit, 751 would overwrite frame 1.
    expect(r.fits(600, 150, 0)).toBe(true);
    expect(r.fits(600, 151, 0)).toBe(false);
    // Once window 0 is done (keepFrom 600), the next 600 frames fit.
    expect(r.fits(750, 450, 600)).toBe(true);
    expect(r.fits(750, 451, 600)).toBe(false);
  });
});

describe('openGpuCompressor', () => {
  const layout = () => new Uint32Array([0, 0, 64, 64]);
  it('says why without WebGPU', async () => {
    const r = await openGpuCompressor({
      width: 64,
      height: 64,
      tile: 64,
      tiling: 'plain',
      quant: 64,
      gpu: undefined,
      layout,
    });
    expect(r).toEqual({ reason: 'This browser has no WebGPU.' });
  });
  it('walks down the ladder when a window length does not fit', async () => {
    const tried: number[] = [];
    const gpu = fakeGpu((bytes) => {
      tried.push(bytes);
      return bytes < 600 * 64 * 64 * 2;
    });
    const r = await openGpuCompressor({
      width: 64,
      height: 64,
      tile: 64,
      tiling: 'plain',
      quant: 64,
      gpu,
      layout,
    });
    expect('reason' in r).toBe(false);
    expect((r as { window: number }).window).toBe(GPU_WINDOW_LADDER[1]);
  });
  it('gives no compressor when no window length fits', async () => {
    const gpu = fakeGpu(() => false);
    const r = await openGpuCompressor({
      width: 64,
      height: 64,
      tile: 64,
      tiling: 'plain',
      quant: 64,
      gpu,
      layout,
    });
    expect(r).toEqual({ reason: expect.stringContaining('GPU memory') });
  });
});

describe('ringFrameBytes', () => {
  it('pads an odd frame to whole u32 words so every ring slot starts on a word', () => {
    expect(ringFrameBytes(33 * 33)).toBe(1090 * 2);
    expect(ringFrameBytes(600 * 600)).toBe(600 * 600 * 2);
    for (let slot = 0; slot < 5; slot++) expect((slot * ringFrameBytes(33 * 33)) % 4).toBe(0);
  });
});

/**
 * A fake `GPU` whose device reports out-of-memory for a ring buffer unless
 * `ok(bytes)`; other buffers always allocate; pipelines and queues are no-ops.
 */
function fakeGpu(ok: (ringBytes: number) => boolean): GPU {
  let pending: GPUError | null = null;
  const buffer = (size: number) => ({
    size,
    destroy: () => {},
    mapAsync: async () => {},
    getMappedRange: () => new ArrayBuffer(size),
    unmap: () => {},
  });
  const pass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
  const device = {
    limits: {},
    lost: new Promise(() => {}),
    queue: { writeBuffer() {}, submit() {}, onSubmittedWorkDone: async () => {} },
    pushErrorScope() {},
    popErrorScope: async () => {
      const e = pending;
      pending = null;
      return e;
    },
    createBuffer: (d: GPUBufferDescriptor) => {
      if (d.label === 'ring' && !ok(d.size)) pending = { message: 'out of memory' } as GPUError;
      return buffer(d.size);
    },
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      copyBufferToBuffer() {},
      finish: () => ({}),
    }),
    destroy() {},
  };
  const adapter = {
    limits: { maxBufferSize: 2 ** 32, maxStorageBufferBindingSize: 2 ** 32 },
    info: {},
    requestDevice: async () => device,
  };
  return { requestAdapter: async () => adapter } as unknown as GPU;
}
```

Give the ring buffer `label: 'ring'` in `openGpuCompressor` so the fake can tell it apart. The ladder test assumes
`GPU_WINDOW_LADDER` has at least two lengths; if Task 1 left only 600, change it to expect the "no window length fits"
reason instead. Export `ringFrameBytes(hw: number): number` (`(hw + (hw & 1)) * 2`) from `gpu-compress.ts` and use it
for every ring offset.

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/cala && npx vitest run src/__tests__/gpu-compress.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: The kernels**

Create `apps/cala/src/lib/gpu-compress-kernels.ts` with the four WGSL sources below. They are the 24 Nov probe's
kernels (`.scratch/gpuprobe/probe.js`, checked against numpy's SVD to 0.1 on a V4 tile) generalised to tiles of any
size up to 64 x 64, a ring of frames, `stride` columns (a multiple of 64, at most `GPU_MAX_STRIDE`), the mean per
frame pixel and missing samples.

```ts
/** Uniforms of `GEMM` (8 x u32, `invq` as f32 at index 6). */
export const GEMM = /* wgsl */ `
struct Dims { M: u32, K: u32, trans: u32, T: u32, W: u32, HWp: u32, invq: f32, base: u32, R: u32, stride: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> frames: array<u32>;
@group(0) @binding(1) var<storage, read> tiles: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> mean: array<f32>;
@group(0) @binding(3) var<storage, read> B: array<f32>;
@group(0) @binding(4) var<storage, read_write> C: array<f32>;
@group(0) @binding(5) var<uniform> d: Dims;
var<workgroup> As: array<array<f32, 16>, 64>;
var<workgroup> Bs: array<array<f32, 64>, 16>;
fn aval(slot: u32, p: u32, t: u32) -> f32 {
  let tl = tiles[slot];
  if (p >= tl.z * tl.w || t >= d.T) { return 0.0; }
  let pix = (tl.y + p / tl.z) * d.W + tl.x + (p % tl.z);
  let idx = ((d.base + t) % d.R) * d.HWp + pix;
  let word = frames[idx >> 1u];
  var v: u32 = word >> 16u;
  if ((idx & 1u) == 0u) { v = word & 0xffffu; }
  let s = bitcast<i32>(v << 16u) >> 16u;
  if (s == -32768) { return 0.0; }
  return f32(s) * d.invq - mean[pix];
}
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let slot = wg.z; let row0 = wg.x * 64u; let col0 = wg.y * 64u;
  let tx = lid.x; let ty = lid.y; let li = ty * 16u + tx;
  var acc: array<array<f32, 4>, 4>;
  for (var k0 = 0u; k0 < d.K; k0 += 16u) {
    for (var e = 0u; e < 4u; e++) {
      let flat = li * 4u + e;
      var r: u32; var k: u32;
      if (d.trans == 0u) { r = flat % 64u; k = flat / 64u; } else { k = flat % 16u; r = flat / 16u; }
      let gr = row0 + r; let gk = k0 + k;
      var v = 0.0;
      if (gr < d.M && gk < d.K) {
        if (d.trans == 0u) { v = aval(slot, gr, gk); } else { v = aval(slot, gk, gr); }
      }
      As[r][k] = v;
    }
    for (var e = 0u; e < 4u; e++) {
      let flat = li * 4u + e; let k = flat / 64u; let c = flat % 64u;
      let gk = k0 + k;
      var v = 0.0;
      if (gk < d.K) { v = B[slot * d.K * d.stride + gk * d.stride + col0 + c]; }
      Bs[k][c] = v;
    }
    workgroupBarrier();
    for (var k = 0u; k < 16u; k++) {
      for (var i = 0u; i < 4u; i++) {
        let a = As[ty * 4u + i][k];
        for (var j = 0u; j < 4u; j++) { acc[i][j] += a * Bs[k][tx * 4u + j]; }
      }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i++) {
    let gr = row0 + ty * 4u + i;
    if (gr < d.M) {
      for (var j = 0u; j < 4u; j++) { C[slot * d.M * d.stride + gr * d.stride + col0 + tx * 4u + j] = acc[i][j]; }
    }
  }
}`;

/** `G = Yᵀ Y` per slot (`stride x stride`), `Y` is `M x stride`. Dispatch (stride/64, stride/64, slots). */
export const GRAM = /* wgsl */ `
struct G { M: u32, stride: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> Y: array<f32>;
@group(0) @binding(1) var<storage, read_write> Gm: array<f32>;
@group(0) @binding(2) var<uniform> g: G;
var<workgroup> Ya: array<array<f32, 64>, 16>;
var<workgroup> Yb: array<array<f32, 64>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let slot = wg.z; let a0 = wg.x * 64u; let b0 = wg.y * 64u;
  let tx = lid.x; let ty = lid.y; let li = ty * 16u + tx;
  var acc: array<array<f32, 4>, 4>;
  for (var r0 = 0u; r0 < g.M; r0 += 16u) {
    for (var e = 0u; e < 4u; e++) {
      let flat = li * 4u + e; let r = flat / 64u; let c = flat % 64u;
      var va = 0.0; var vb = 0.0;
      if (r0 + r < g.M) {
        let o = slot * g.M * g.stride + (r0 + r) * g.stride;
        va = Y[o + a0 + c]; vb = Y[o + b0 + c];
      }
      Ya[r][c] = va; Yb[r][c] = vb;
    }
    workgroupBarrier();
    for (var r = 0u; r < 16u; r++) {
      for (var i = 0u; i < 4u; i++) {
        let a = Ya[r][ty * 4u + i];
        for (var j = 0u; j < 4u; j++) { acc[i][j] += a * Yb[r][tx * 4u + j]; }
      }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i++) {
    for (var j = 0u; j < 4u; j++) {
      Gm[slot * g.stride * g.stride + (a0 + ty * 4u + i) * g.stride + b0 + tx * 4u + j] = acc[i][j];
    }
  }
}`;

/** `Q = Y R⁻¹` per slot (`R⁻¹` upper triangular, `stride x stride`). Dispatch (stride/64, ceil(M/4), slots). */
export const APPLY = /* wgsl */ `
struct G { M: u32, stride: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> Y: array<f32>;
@group(0) @binding(1) var<storage, read> R: array<f32>;
@group(0) @binding(2) var<storage, read_write> Q: array<f32>;
@group(0) @binding(3) var<uniform> g: G;
@compute @workgroup_size(64, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(workgroup_id) wg: vec3<u32>) {
  let slot = wg.z; let c = gid.x; let r = gid.y;
  if (r >= g.M || c >= g.stride) { return; }
  let yo = slot * g.M * g.stride + r * g.stride;
  let ro = slot * g.stride * g.stride;
  var s = 0.0;
  for (var k = 0u; k <= c; k++) { s += Y[yo + k] * R[ro + k * g.stride + c]; }
  Q[yo + c] = s;
}`;
```

`M` for `trans = 0` is always 4096 (rows past a tile's `w * h` read 0); for `trans = 1` it is the window's frames.

- [ ] **Step 4: `gpu-compress.ts`**

Write the module with these parts (all from the probe, adapted):

1. `RingClock` (pure, used by the runner and the tests):

```ts
export class RingClock {
  readonly size: number;
  constructor(
    readonly window: number,
    readonly slack: number,
  ) {
    this.size = window + slack;
  }
  slot(f: number): number {
    return f % this.size;
  }
  fits(start: number, count: number, keepFrom: number): boolean {
    return start + count - keepFrom <= this.size;
  }
}
```

2. Constants: `GPU_WINDOW_LADDER` (Task 1), `GPU_TILE_BATCH = 12`, `GPU_MAX_STRIDE = 128`, slack
   `Math.ceil(window / 4)`.
3. `openGpuCompressor`: `gpu` undefined → `{ reason: 'This browser has no WebGPU.' }`; `requestAdapter({ powerPreference:
'high-performance' })` null → `{ reason: 'No WebGPU adapter.' }`; `requestDevice` with `requiredLimits` set to the
   adapter's `maxBufferSize` and `maxStorageBufferBindingSize`. Tiles from `layout(width, height, tile, tiling)`
   (`x0, y0, w, h` per tile, as `tileLayout` returns them). Frame stride in pixels `HWp = HW + (HW & 1)`. For each
   `W` of the ladder: `pushErrorScope('out-of-memory')`, create the ring (`label: 'ring'`, `(W + slack) * HWp * 2`
   bytes, rounded up to 4), the mean buffer (`HW * 4`), the tile-record buffer (`GPU_TILE_BATCH * 16`), `omega`,
   `Y`, `Q` (`GPU_TILE_BATCH * 4096 * GPU_MAX_STRIDE * 4` each), `Z`, `Ztmp` (`GPU_TILE_BATCH * W * GPU_MAX_STRIDE * 4`),
   `G` and `Rinv` (`GPU_TILE_BATCH * GPU_MAX_STRIDE² * 4`), two map-read buffers for `Q` and `Bt`;
   `popErrorScope()`; a `GPUError` or a thrown `RangeError` → destroy what was made and try the next `W`. None fits →
   `{ reason: 'Not enough GPU memory for a window of 150 frames.' }` (name the ladder's last length).
4. `upload(frames, start, count)`: for each frame `f`, `queue.writeBuffer(ring, ring.slot(start + f) * HWp * 2, ...)`
   with the frame's `Int16Array` view padded to an even length when `HW` is odd (copy into a scratch `Int16Array` of
   `HWp`).
5. `compress(job)`:
   - mean: `job.stats.mean(quant)` (Task 2, per frame pixel), uploaded to `mean` before the first batch.
   - `jobs = tiles.map((t, i) => new GpuTileJob(job.stats, quant, t.x0, t.y0, t.w, t.h, job.seeds(i), job.prevRanks(i)))`
   - queue = all tile indices; while the queue is not empty: take up to `GPU_TILE_BATCH`; `stride` = the batch's
     largest `l()` rounded up to 64; `stride > GPU_MAX_STRIDE` → free the jobs and throw `GpuSketchTooLarge`;
     write the tile records and each slot's `omega()` (`T x l` into `T x stride`, zero padded); run
     `Y = A Ω` (GEMM `trans 0`, `M 4096`, `K frames`), `cholqr2(Y)`, `n_iter` times (`Z = Aᵀ Q`, `cholqr2(Z)`,
     `Y = A Z`, `cholqr2(Y)`), `Bt = Aᵀ Q`; read back `Q` (slots x 4096 x stride) and `Bt` (slots x frames x stride);
     per slot `bytes = job.finish(q_slot, bt_slot, stride)`: `undefined` → push the tile back on the queue, else keep
     the bytes and `job.rank()`, free the job.
   - `cholqr2(buf, M)`: twice: GRAM into `G` (dispatch `stride/64, stride/64, slots`), copy to the map-read buffer, map,
     `cholInvUpperBatch(G, stride, ls)` (WASM), write `Rinv`, APPLY into the other buffer; the second pass writes back
     into `buf`.
   - Return `{ tiles, ranks, ms }` (wall time of `compress`).
6. `lost`: `device.lost.then((i) => i.message || 'The GPU device was lost.')`.
7. `destroy()`: destroy every buffer and the device.

Uniform layout: `GEMM`'s `Dims` is 12 x u32 (48 bytes, `invq` as f32 at index 6); `GRAM` and `APPLY` take 4 x u32.
Build bind groups per dispatch as the probe does.

- [ ] **Step 5: Run the tests**

Run: `cd apps/cala && npx vitest run src/__tests__/gpu-compress.test.ts`
Expected: PASS.

- [ ] **Step 6: The growth limit test (Review Focus 1)**

Add to `gpu-compress.test.ts`: a test that drives `compress` through a fake device whose `GpuTileJob` stand-in grows
past `GPU_MAX_STRIDE` and expects `GpuSketchTooLarge`. To make this testable without WebGPU, give
`openGpuCompressor` an optional `jobs` factory (`(stats, quant, x0, y0, w, h, seed, prev) => GpuTileJobLike`,
default the WASM class) and test with a stand-in whose `l()` returns 140:

```ts
it('gives up a window whose sketch outgrows the GPU buffers', async () => {
  const big = {
    l: () => 140,
    nIter: () => 2,
    omega: () => new Float32Array(0),
    finish: () => undefined,
    rank: () => 0,
    free: () => {},
  };
  const r = await openGpuCompressor({
    width: 64,
    height: 64,
    tile: 64,
    tiling: 'plain',
    quant: 64,
    gpu: fakeGpu(() => true),
    layout,
    jobs: () => big,
  });
  if ('reason' in r) throw new Error(r.reason);
  await expect(
    r.compress({
      index: 0,
      start: 0,
      frames: 10,
      stats: {} as never,
      seeds: () => 0,
      prevRanks: () => undefined,
    }),
  ).rejects.toBeInstanceOf(GpuSketchTooLarge);
});
```

(`compress` must check `stride` before any GPU call, so the fake device needs no compute.)

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npx prettier --write apps/cala/src/lib/gpu-compress.ts apps/cala/src/lib/gpu-compress-kernels.ts apps/cala/src/__tests__/gpu-compress.test.ts
npx eslint apps/cala/src/lib/gpu-compress.ts apps/cala/src/__tests__/gpu-compress.test.ts
npm run typecheck
git add apps/cala/src/lib/gpu-compress.ts apps/cala/src/lib/gpu-compress-kernels.ts apps/cala/src/__tests__/gpu-compress.test.ts crates/cala
git commit -m "feat(cala): a WebGPU window compressor with a ring of frames and a window length that fits the GPU"
```

---

### Task 4: The compress worker runs a recording on the GPU (`?factors=gpu`)

**Files:**

- Modify: `apps/cala/src/lib/factor-run.ts` (`PageFactors.factorsGpu`, `factorRunPlan` input `factorsGpu`)
- Modify: `apps/cala/src/lib/pipeline-store.ts` (signal like `factorsFile`; pass `gpu: true` into the compress options)
- Modify: `apps/cala/src/App.tsx` (`?factors=gpu` sets `factorsFile` and `factorsGpu`; the settle's `wait`)
- Modify: `apps/cala/src/workers/compress-types.ts` (`CompressInit.gpu?: boolean`; `CompressStatus.window?`,
  `backend?: 'cpu' | 'gpu'`)
- Modify: `apps/cala/src/lib/compress-feed.ts` (`CompressFeedOptions.gpu`, passed into `init`)
- Modify: `apps/cala/src/lib/compress-runner.ts`
- Modify: `apps/cala/src/lib/export.ts`, `apps/cala/src/lib/run-stages.ts` (export `compress_window`,
  `compress_backend`)
- Modify: `apps/cala/src/workers/compress-worker.ts` (pass `openGpu` into the runner)
- Test: `apps/cala/src/__tests__/compress.test.ts`

**Interfaces:**

- Consumes: `openGpuCompressor`, `RingClock`, `GpuCompressorLike`, `GpuSketchTooLarge` (Task 3); `WindowStats`,
  `quantizeFrames` (Task 2).
- Produces: `CompressRunnerDeps.openGpu?: (init: CompressInit) => Promise<GpuCompressorLike | { reason: string }>`;
  `CompressStatus.window`, `CompressStatus.backend`; export fields `compress_window`, `compress_backend`;
  `GPU_TEXT` reasons exported from `compress-runner.ts`.

- [ ] **Step 1: Thread the flag**

Follow `backlogCap` everywhere it flows (`grep -rn backlogCap apps/cala/src`) and add `gpu?: boolean` beside it:
`CompressFeedOptions` → the feed's `init` message (`CompressInit`) → the runner's `init`. In `factor-run.ts`:
`PageFactors.factorsGpu = p.get('factors') === 'gpu'`, and `factorsFile` true for `gpu` too
(`p.get('factors') === 'file' || p.get('factors') === 'gpu'`). In `App.tsx` next to `setFactorsFile`:
`pipeline.setFactorsGpu(pageFactors.factorsGpu)`; in `pipeline-store.ts` pass `gpu: factorsGpu()` into the compress
options where `backlogCap` is passed. In `App.tsx`'s `fileChoice.act(...)` call set
`wait: (params.has('debug') && params.has('fwait')) || pageFactors.factorsGpu` (a GPU run is never more than a window
and its slack behind).

- [ ] **Step 2: Write the failing runner tests**

In `compress.test.ts`, a new `describe('a recording compressed on the GPU', ...)` with a fake `GpuCompressorLike`:

```ts
function fakeGpuCompressor(window: number, slack: number) {
  const pending: { job: GpuWindowJob; resolve: (r: GpuWindowResult) => void }[] = [];
  let lose: (reason: string) => void = () => {};
  const gpu: GpuCompressorLike = {
    window,
    slack,
    upload: () => {},
    compress: (job) => new Promise((resolve) => pending.push({ job, resolve })),
    lost: new Promise((r) => (lose = r)),
    destroy: () => {},
  };
  /** Answer the oldest pending window with one 8-byte tile per layout tile. */
  const answer = (tiles: number) => {
    const p = pending.shift()!;
    p.resolve({
      tiles: Array.from({ length: tiles }, () => new Uint8Array(8)),
      ranks: Array(tiles).fill(3),
      ms: 1,
    });
  };
  return { gpu, pending, answer, lose: (r: string) => lose(r) };
}
```

Tests (each runner built with `openGpu: async () => fake.gpu`, `init` with `gpu: true`, `tiling: 'offset'`, a 64 x 64
frame and `window` from the feed ignored):

1. **windows of the GPU's length cover every frame but a 1-frame tail** (Review Focus 2): window 50, slack 13; push
   121 frames in chunks of 10 with `final` close; answer each pending window; expect factor files `f0.bin`, `f1.bin`
   with `start/frames` `(0, 50)`, `(50, 50)` and `(100, 20)` in the status's `compressed`, and no file for frame 120
   only when the total is 101 (a second case: 101 frames → windows `(0,50)`, `(50,50)` and no third).
2. **a GPU that falls behind gives the factors up and never blocks** (overflow): window 50, slack 13; never answer;
   push 200 frames; every `handle` call resolves; exactly one `error` with `GPU_TEXT.behind`; the store holds no
   files; later chunks are ignored.
3. **a lost device ends the factors** : call `lose('gone')` after the first window; expect one `error` whose message
   contains `gone`; no more files are written after it.
4. **a new run during a pending window writes nothing of the old run** (Review Focus 5): start session 7, fill one
   window (pending), `init` session 8, then answer the pending window; expect no `f0.bin` of session 7 in the store
   and session 8's status at 0 windows.
5. **no GPU: the run says why and has no factors**: `openGpu: async () => ({ reason: 'This browser has no WebGPU.' })`;
   expect one `error` whose message contains that reason, no window files written for any chunk.

- [ ] **Step 3: Run them to see them fail**

Run: `cd apps/cala && npx vitest run src/__tests__/compress.test.ts -t "on the GPU"`
Expected: FAIL.

- [ ] **Step 4: Implement the GPU route in `CompressRunner`**

- `deps.openGpu?: (init: CompressInit) => Promise<GpuCompressorLike | { reason: string }>` and
  `deps.stats?: (w: number, h: number) => WindowStatsLike` (default the WASM `WindowStats`), `deps.quantizeFrames?`
  (default the WASM function).
- On `init` with `msg.gpu`: after the existing setup, `const g = await this.deps.openGpu!(msg)`; if the epoch
  changed meanwhile, `g.destroy?.()` and return; `'reason' in g` → `this.gaveUp = true`,
  `this.stopText = GPU_TEXT.none(g.reason)`, post the error once; otherwise keep `this.gpu = g`,
  `this.ring = new RingClock(g.window, g.slack)`, two `WindowStats` (`this.gstats = [a, b]`), `this.gwin = { index:
0, start: 0, frames: 0 }`, `this.keepFrom = 0`, and `g.lost.then((r) => this.gpuFail(GPU_TEXT.lost(r), epoch))`.
- On `chunk` when `this.gpu`: (no window file) `const q = quantizeFrames(msg.data, quant)`; walk the chunk frame by
  frame range: while frames remain, `n = min(remaining, g.window - this.gwin.frames)`; check
  `this.ring.fits(start, n, this.keepFrom)` else `gpuFail(GPU_TEXT.behind)` and return; `g.upload(q.subarray(...),
start, n)`; `stats[current].push(...)`; `this.gwin.frames += n`; when `this.gwin.frames === g.window` →
  `this.closeGpuWindow()`.
- `close` with `final`: close the open GPU window if it has at least 2 frames (a 1-frame tail is dropped, as the CPU
  path does), set `final`, post.
- `closeGpuWindow()`: push `{ index, start, frames, stats }` onto `this.gpending`, swap the stats object (the other one
  is reset), start the next window `{ index + 1, start + frames, 0 }`, `kick()`.
- The run loop (`run()` / `compress()`): when `this.gpu`, take `gpending[0]`, `await g.compress({ ..., seeds: (i) =>
((index << 20) ^ i) >>> 0, prevRanks: (i) => this.tileRanks[i] })`; if the epoch changed, drop the result (no
  write); else write `f<index>.bin` exactly as the CPU path writes (header via `deps.header(width, height, tile,
tiling, frames, tiles.length, start)`, then per tile `u32` length + bytes), set `this.tileRanks[i] = ranks[i]`,
  `this.keepFrom = start + frames`, push to `done`, update `windows`, `frames`, `factorBytes`, `meanRank`,
  `msPerFrame = ms / frames`, `fps`, post the status. A rejection: `GpuSketchTooLarge` → `gpuFail(GPU_TEXT.sketch)`;
  anything else → `gpuFail(GPU_TEXT.error(message))`.
- `gpuFail(text, epoch?)`: once per run: `await this.clear()` (drops files, as `giveUp` does), `gaveUp = true`,
  `stopText = text`, post `{ type: 'error', session, message: text }`, `gpu.destroy()`.
- `clear()` also destroys `this.gpu` and resets the GPU fields.
- Status: `window: this.gpu?.window ?? init.window`, `backend: this.gpu ? 'gpu' : 'cpu'`; `pending` and
  `pendingFrames` from `gpending` when on the GPU.
- `GPU_TEXT`:

```ts
export const GPU_TEXT = {
  none: (why: string) => `No factors: the GPU compressor could not start (${why}).`,
  behind: 'No factors: the GPU compressor fell a window behind Discover.',
  lost: (why: string) => `No factors: the GPU was lost (${why}).`,
  sketch: 'No factors: a tile needed a larger sketch than the GPU compressor holds.',
  error: (why: string) => `No factors: the GPU compressor failed (${why}).`,
} as const;
```

In `compress-worker.ts` pass `openGpu: (init) => openGpuCompressor({ width: init.width, height: init.height, tile:
init.tile, tiling: init.tiling, quant: init.quant, gpu: (navigator as Navigator & { gpu?: GPU }).gpu, layout:
tileLayout })`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/cala && npx vitest run src/__tests__/compress.test.ts`
Expected: PASS (the new ones and the existing 25).

- [ ] **Step 6: Export fields**

Follow `fpsAfter` (`grep -rn fpsAfter apps/cala/src`) from the status into the run record (`run-stages.ts`) and
`export.ts`; add `window` and `backend` the same way; export `compress_window` and `compress_backend` beside
`compress_fps_after`, and document them in the comment above (`export.ts:119`).

- [ ] **Step 7: e2e (the fallback)**

In `e2e/cala-factors.spec.ts`, add a test like `Cala: without ?factors=file a recording is unchanged` but opening the
page with `?factors=gpu`: CI's Chromium has no WebGPU, so expect Extract to finish and the Run panel to show the file as
the source with a reason containing `GPU compressor could not start`. Run locally:
`npm run build:e2e && E2E_PORT=4391 npx playwright test e2e/cala-factors.spec.ts` (headless Chromium; if the local
Chromium has WebGPU and the test takes the GPU path, assert the reason only when `navigator.gpu` is absent, which
`page.evaluate(() => 'gpu' in navigator)` tells).

- [ ] **Step 8: Docs, lint, typecheck, full tests, commit**

`apps/cala/USER_GUIDE.md`: one paragraph under the factor switches: `?factors=gpu` (experimental): the recording's
frames are compressed on the GPU while Discover runs; the settle and Extract read the factors; without WebGPU or with
too little GPU memory the run reads the file and says why. `docs/CHANGELOG.md` `[Unreleased]` `Added`: one entry.

```bash
npx prettier --write <changed TS/MD files>
npx eslint apps/cala/src
npm run typecheck
cd apps/cala && npx vitest run
git add apps/cala docs/CHANGELOG.md e2e/cala-factors.spec.ts
git commit -m "feat(cala): ?factors=gpu compresses a recording on the GPU while Discover runs"
```

---

### Task 5: GPU factors against the CPU's, in the app (measurement)

**Files:**

- Modify: `apps/cala/src/lib/compress-runner.ts` (`?debug&gpucheck=N`)
- Modify: `apps/cala/scripts/live-measure.mjs` (record `compress.check` and `compress.backend` / `window`)
- Create: `tools/cala-eval/results/2026-11-2x-gpu-compressor-check.md`

**Interfaces:**

- Consumes: Task 4's runner; `compress_tile` through the WASM `TileCompressor.compress(raw, frames, x0, y0, w, h,
seed, prevRank)`.
- Note: the spec's "a tile whose Cholesky still fails is compressed on the CPU" is replaced in this plan by giving up
  the run's factors (`GPU_TEXT.error`); this check counts how often it happens. If it does, add the CPU fallback.
- Produces: `CompressStatus.check?: { windows: number; loss: number; floor: number; rankDiff: number }`.

- [ ] **Step 1: The check**

With `CompressInit.gpuCheck = N` (from `?debug&gpucheck=N`, threaded like `gpu` in Task 4), the runner keeps the
quantized frames of the first `N` windows on the CPU (in memory: at 600 px, 600 frames are 432 MB, so use N ≤ 2 at
600 px) and, after the GPU's window, compresses every tile with `TileCompressor` (same seed, same `prevRank`), once
more with seed `+ 7_000_000` (the noise floor), and adds `‖Ŷ_gpu − Ŷ_cpu‖²`, `‖Ŷ_cpu‖²`, `‖Ŷ_cpu2 − Ŷ_cpu‖²` and
`|rank_gpu − rank_cpu|` (decode both tiles with `TileFactors.fromBytes`-equivalent JS or a small WASM helper
`lowRankDiff(a: &[u8], b: &[u8]) -> Vec<f64>` returning `[diff², ref²]`, added to `js.rs`). Report the sums in the
status as `check`.

- [ ] **Step 2: Measure**

Inputs (real folders of numbered plain AVIs, on the evaluation SSD): 2,000 frames of V4 (`cafast_v4_2h` files 0-1)
and the 41 converted wl24 files (`runs/recording-factors-20261124/input_wl24_split`). Run `live-measure.mjs --mode file
--query "factors=gpu&gpucheck=2"` for each (script under `.scratch/`, profile on the SSD).
Expected (quality bar): `loss / ref` below `floor / ref`, `rankDiff / tiles` below 0.3. Also record Discover's time
against a `--query ""` run on the same input (two runs each) and the GPU's `msPerFrame`.

- [ ] **Step 3: Report and commit**

```bash
git add apps/cala tools/cala-eval/results/2026-11-2x-gpu-compressor-check.md
git commit -m "docs(cala-eval): the GPU compressor's factors against the CPU's, and Discover beside it"
```

If the bar fails: stop and report to the owner before Task 6.

---

### Task 6: The settle on factors over the whole settle pool

**Files:**

- Modify: `apps/cala/src/lib/slow-runner.ts` (`factors()`, the `wait.file` branch, ~line 1668)
- Test: `apps/cala/src/__tests__/lookback-runner.test.ts` (or the slow-runner test file that covers `factors`)

**Interfaces:**

- Consumes: the look-back worker's `factors` request (`lookback-worker.ts:217`), which swaps any worker's frame server
  to a `FactorReader`.

- [ ] **Step 1: Write the failing test**

Find the existing test of a `?factors=file` run that answers `factors` with a source (`grep -n "factorFile" -r
apps/cala/src/__tests__`). Copy it into a new test with a settle pool of 2 (`setSettlePool`, joined to the run as the
existing pool tests do) and expect every pool port (1 and 2) as well as port 0 to receive
`{ type: 'factors', session, factors: source }` before any settle request goes to it.

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/cala && npx vitest run -t "settle pool"` (the new test's name)
Expected: FAIL (only port 0 gets `factors`).

- [ ] **Step 3: Implement**

In `factors()`, `wait.file` with a source: send the `factors` message to port 0 and to every port in
`this.settlePorts()`; a pool port that joins later (the join path, ~line 624) gets the same message right after it is
sent the run's back state when `this.factorLive` is true (keep the source in a field `this.factorSource`). Then
`sendLibrary` to each, as now for port 0.

- [ ] **Step 4: Run the tests**

Run: `cd apps/cala && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Measure the settle**

One `?factors=gpu` run on the 10,000-frame V4 input (`runs/recording-factors-20261124/gpu_contention/input_10k`):
settle time and frames/s from the metrics (`factors.settleS`, `settleFed`) against the file run's (`alone`: 141 s) and
the settle source must be `factors`. Add the numbers to Task 5's report.

- [ ] **Step 6: Commit**

```bash
git add apps/cala tools/cala-eval/results
git commit -m "perf(cala): a recording's settle on factors runs on the whole settle pool"
```

---

### Task 7: The gate, then the default

**Files:**

- Create: `tools/cala-eval/results/2026-11-2x-gpu-recording-gate.md`
- Modify (only if the gate passes): `apps/cala/src/lib/factor-run.ts`, `App.tsx`, `USER_GUIDE.md`,
  `docs/CHANGELOG.md`, `e2e/cala-factors.spec.ts`

- [ ] **Step 1: The runs**

A script under the run folder (as `run_all.sh` of 24 Nov): the 1 h V4 input (`runs/factors-v4-speed-20261123/input_1h`,
the real folder) and the wl24 split input, each `--query ""` (file) and `--query "factors=gpu"`, two runs each,
alternating, profile emptied before each. About 4 x 40 min + 4 x 2 min. Check no other measurement runs first
(`pgrep -fl live-measure`).

- [ ] **Step 2: The settle evaluation**

Slice 1's settle evaluation (`SET-F` against `SET-R`, see `tools/cala-eval/results/2026-11-24-settle-factors.md` for
the command) on the V4 recording with the GPU run's factors.

- [ ] **Step 3: Report**

Table per recording and arm: Discover, settle (source), Extract (source), Discover end to Extract done, cells; the
quality lines (settle evaluation, per-cell trace difference in sd: median and largest between the arms' Extract traces
on cells matched by footprint overlap). The gates: Discover end to Extract done shorter, Discover at most 5 % longer,
quality as the spec says.

- [ ] **Step 4: Commit the report**

```bash
git add tools/cala-eval/results/2026-11-2x-gpu-recording-gate.md
git commit -m "docs(cala-eval): a recording on GPU factors against the file, 1 h V4 and wl24"
```

- [ ] **Step 5: Only if every gate passes: the default**

`factorsFromPage`: a recording without a factor switch is a GPU factor run (`factorsGpu` and `factorsFile` true unless
`?factors=0` or `?factors=file`); the no-WebGPU fallback keeps such a page on the file. Update the e2e `without
?factors=file a recording is unchanged` (now: a recording without switches runs on the GPU or says why it reads the
file), USER_GUIDE, CHANGELOG (`Changed`). Run the full checks (as Task 4 Step 8), then:

```bash
git commit -am "feat(cala): recordings compress on the GPU and settle and extract on their factors by default; ?factors=0 turns it off"
```

If a gate fails: no default change; the report says which gate and by how much; stop for the owner.
