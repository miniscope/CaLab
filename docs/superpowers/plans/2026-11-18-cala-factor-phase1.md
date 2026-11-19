# cala factor pipeline, phase 1: factor format v2, offset grids, recalibrated factors

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The compressor writes factor format v2 (tiling in the file, discarded variance, valid share, missing samples handled), runs two power iterations, can cut the frame on two offset grids, and the app's Extract replay writes recalibrated factors; then the chosen combination is measured against gate A1.

**Architecture:** All format knowledge stays in the Rust crate (`crates/cala/src/compress`): the tile layout, the file header and the blended rebuild are functions there, and the app asks WASM for them instead of rebuilding them in TypeScript. The compressor's default tiling stays plain, because the history review reads Discover's live factors and assumes side-by-side tiles; the callers that make factors for Refine and Extract ask for the offset grids. In the app the "compression replay" of this phase is Extract's own replay with the compress feed switched on, so recalibrated factors cost no extra pass.

**Tech Stack:** Rust (crate `calab-cala`, features `jsbindings`), wasm-bindgen, TypeScript with SolidJS and vitest (`apps/cala`), Python 3 with numpy for the evaluation tools (`tools/cala-eval`, run with `uv run --no-project --with numpy`).

**Spec:** `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md` (sections 1 to 3, Amendment 1: A1 to A6, and A7 once approved). Phase 0 evidence: `tools/cala-eval/results/2026-11-18-factor-phase0.md`.

## Global Constraints

- Compressor settings: tile 64 px, window 600 frames, cut `rho_min` 0.2 and `z` 4, starting rank 40, largest rank 300, quantization 64. `n_iter` becomes 2.
- Tilings: `Tiling::Plain` stays the default of `CompressConfig`. Factors for Refine and Extract use `Tiling::Offset`.
- Factor files: new files are v2 (`CALAFAC2`, tile records `CTF2`). v1 files (`CALAFAC1`, `CTF1`) must still be read.
- A missing sample is a non-finite pixel. It is stored as `i16::MIN` in the quantized buffer and counts as the pixel's mean over its valid samples.
- `?compress` stays opt-in in the app. Compression on by default is phase 4.
- Gate A1 (spec, Amendment 1), on QC-pass cells: (1) with usable truth (raw run's median truth correlation at least 0.8 and at least 20 matched cells) the change of the truth correlation has a median of at least -0.01 and a 5th percentile of at least -0.05; (2) footprint loss at most 0.02; (3) without usable truth, trace loss (lag-1 correlation) at most 0.08; (4) footprint jump at tile lines at most 0.10 above the raw run's.
- Rust checks, run from `crates/cala`: `cargo fmt --all --check`, `cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings`, `cargo test --no-default-features --features jsbindings`.
- App checks, run from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, and `npx prettier --check` on every file touched outside `crates`.
- Python: type hints on function signatures; `uvx ruff format` and `uvx ruff check --fix` on every Python file touched; never install into a global environment.
- The shell in this worktree refuses long compound commands (`cd ... &&` chains, loops, heredocs). Put anything complex in a script file and run it with one plain command.
- Raw data is read only. Run outputs go to a folder outside the repository. No machine paths or user names in committed files.
- Commits: one sentence, conventional prefix, no body, no co-author trailer and no tool or assistant attribution. Do not push.
- Branch: `feat/cala-factor-format-v2`, cut from `feat/cala-factor-eval`.

## Review Focus

1. A frame with missing pixels (the motion band after registration): the pixel's mean and the SVD must not be pulled towards 0, and a pixel missing in every frame must give zeros, not NaN. Pinned in Task 1.
2. A factor file written before this change (v1) must still open and rebuild the same frames. Pinned in Tasks 2 and 3.
3. A v2 file whose tiles do not match the tiling its header names must be refused, not blended with the wrong weights. Pinned in Task 3.
4. A frame smaller than a tile, a last window of fewer frames than the others, and a window of fewer than 2 frames, under the offset grids. Pinned in Tasks 3 and 6.
5. Extract started while Discover's windows are still being compressed or back-filled: the store must end up holding only the replay's windows. Pinned in Task 7.

## File Structure

| File                                                                                                                       | Change          | Responsibility                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------- |
| `crates/cala/src/compress/mod.rs`                                                                                          | modify          | missing samples, v2 records and files, tiling in the config, `n_iter` 2 |
| `crates/cala/src/compress/blend.rs`                                                                                        | modify          | `Tiling` codes and names; module doc                                    |
| `crates/cala/src/compress/js.rs`                                                                                           | modify          | `tileLayout`, `factorHeader`, `quantizeTiles` with a tiling             |
| `crates/cala/examples/qc_eval.rs`                                                                                          | modify          | factor dump and replay read the tiling from the config and the file     |
| `crates/cala/examples/discover_eval.rs`                                                                                    | modify          | `to_bytes()` call                                                       |
| `tools/cala-eval/factor_closeness.py`, `test_factor_closeness.py`                                                          | modify          | gate A1                                                                 |
| `tools/cala-eval/factor_arms.py`, `test_factor_arms.py`                                                                    | modify          | arm `chosen`                                                            |
| `apps/cala/src/workers/compress-types.ts`                                                                                  | modify          | tiling and source in init and status                                    |
| `apps/cala/src/lib/compress-feed.ts`                                                                                       | modify          | tiling and source options                                               |
| `apps/cala/src/lib/compress-runner.ts`                                                                                     | modify          | layout and header from WASM                                             |
| `apps/cala/src/lib/cala-wasm.ts`, `workers/compress-worker.ts`                                                             | modify          | new bindings wired                                                      |
| `apps/cala/src/workers/frame-types.ts`, `trace-worker.ts`, `frame-worker.ts`                                               | modify          | compress settings of a replay                                           |
| `apps/cala/src/lib/pass2-store.ts`, `compress-store.ts`, `App.tsx`                                                         | modify          | Extract feeds the compressor; readout                                   |
| `apps/cala/src/__tests__/compress.test.ts`, `pass2-store.test.ts`                                                          | modify          | tests                                                                   |
| `apps/cala/scripts/batch-session.mjs`                                                                                      | modify          | compress status in the snapshot                                         |
| `tools/cala-eval/results/<date>-factor-phase1.md`, `docs/CHANGELOG.md`, `apps/cala/README.md`, `tools/cala-eval/README.md` | create / modify | results and docs                                                        |

---

### Task 1: Missing samples in the compressor

**Files:**

- Modify: `crates/cala/src/compress/mod.rs` (`quantize` at about line 505, `TileMatrix` at about lines 526 to 581, the doc comment of `WindowCompressor::push`)
- Test: the `tests` module of the same file

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `pub const MISSING: i16 = i16::MIN;`; `quantize(v, quant)` returns `MISSING` for a non-finite `v` and never returns `i16::MIN` otherwise; `TileMatrix` gains the fields `ss: Vec<f64>` (per pixel, the centred sum of squares over its valid samples, in the frames' units) and `valid: Vec<f32>` (per pixel, the share of the window's frames in which it was not missing). Task 2 reads both.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module of `crates/cala/src/compress/mod.rs`:

```rust
    #[test]
    fn a_missing_sample_is_marked_and_counts_as_the_pixels_mean() {
        assert_eq!(quantize(f32::NAN, QUANT), MISSING);
        assert_eq!(quantize(f32::INFINITY, QUANT), MISSING);
        assert_eq!(quantize(-1.0e9, QUANT), -32767, "the clamp never gives MISSING");
        // 2 pixels, 6 frames; pixel 1 is missing in frames 1 and 4.
        let y = [
            1.0f32, 5.0, 2.0, f32::NAN, 3.0, 7.0, 4.0, 9.0, 5.0, f32::NAN, 6.0, 11.0,
        ];
        let raw = quantized(&y);
        let m = TileMatrix::new(&raw, 6, 2, QUANT);
        assert!((m.mean[0] - 3.5).abs() < 1e-6);
        assert!((m.mean[1] - 8.0).abs() < 1e-6, "mean over the 4 valid samples");
        assert_eq!(m.valid, vec![1.0, 4.0 / 6.0]);
        // Pixel 0: sum (y - 3.5)^2 = 17.5; pixel 1: 9 + 1 + 1 + 9 = 20.
        assert!((m.ss[0] - 17.5).abs() < 1e-9 && (m.ss[1] - 20.0).abs() < 1e-9);
        assert!((m.energy - 37.5).abs() < 1e-9);
        let mut b = Vec::new();
        m.block(0, 6, &mut b);
        assert_eq!((b[3], b[9]), (0.0, 0.0), "a missing sample is 0 after centring");
        assert!((b[1] + 3.0).abs() < 1e-6);
    }

    #[test]
    fn a_pixel_missing_in_every_frame_gives_zeros() {
        let (t, p) = (40, 9);
        let mut y = vec![0.0f32; t * p];
        for i in 0..t {
            for j in 0..p {
                y[i * p + j] = 10.0 + (i as f32 / 5.0).sin() * (1.0 + j as f32);
            }
            y[i * p + 4] = f32::NAN;
        }
        let tf = compress_tile(&quantized(&y), t, p, &CompressConfig::default(), 3);
        assert_eq!(tf.mean[4], 0.0);
        // The randomized SVD's basis leaves rounding residue (about 1e-22) on a row of zeros.
        assert!(tf.spatial[4 * tf.rank..5 * tf.rank]
            .iter()
            .all(|&v| v.abs() < 1e-6));
        assert!(tf.spatial.iter().chain(&tf.temporal).all(|v| v.is_finite()));
    }
```

- [ ] **Step 2: Run the tests to see them fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::tests::a_ -- --nocapture`
Expected: does not compile (`MISSING`, `m.valid`, `m.ss` are not defined).

- [ ] **Step 3: Implement**

Replace `quantize` and its doc comment by:

```rust
/// The quantized value of a missing sample (a non-finite pixel). `quantize`
/// clamps to `±32767`, so no finite value maps to it.
pub const MISSING: i16 = i16::MIN;

/// `round(v * quant)` in `i16`; a non-finite value gives [`MISSING`].
///
/// Rounds half away from zero like `f32::round`, written out with `trunc`:
/// on wasm `round` is a libm call per pixel, `trunc` an instruction the
/// loop over a frame vectorizes with. The missing case is a select, not a
/// branch, for the same reason.
#[inline]
pub fn quantize(v: f32, quant: f32) -> i16 {
    let s = v * quant;
    let t = s.trunc();
    let r = if (s - t).abs() >= 0.5 {
        t + 1.0f32.copysign(s)
    } else {
        t
    };
    let q = r.clamp(-32767.0, 32767.0) as i32 as i16;
    if v.is_finite() {
        q
    } else {
        MISSING
    }
}
```

In `struct TileMatrix` add two fields after `energy`:

```rust
    /// Per pixel: `Σ (y − mean)²` over its valid samples.
    ss: Vec<f64>,
    /// Per pixel: the share of the window's frames in which it was not missing.
    valid: Vec<f32>,
```

Replace the body of `TileMatrix::new` by:

```rust
        debug_assert_eq!(raw.len(), t * p);
        // Integer column sums are exact (|v| < 2^15, v² < 2^30).
        let mut acc = vec![0i64; p];
        let mut sq = vec![0i64; p];
        let mut cnt = vec![0u32; p];
        for row in raw.chunks_exact(p) {
            for (((a, s), c), &v) in acc
                .iter_mut()
                .zip(sq.iter_mut())
                .zip(cnt.iter_mut())
                .zip(row)
            {
                if v != MISSING {
                    let v = i64::from(v);
                    *a += v;
                    *s += v * v;
                    *c += 1;
                }
            }
        }
        let q = f64::from(quant);
        // A missing sample counts as the mean of the pixel's valid samples,
        // which is 0 after centring; a pixel with no valid sample is all 0.
        let mean = acc
            .iter()
            .zip(&cnt)
            .map(|(&a, &c)| {
                if c > 0 {
                    (a as f64 / f64::from(c) / q) as f32
                } else {
                    0.0
                }
            })
            .collect();
        let ss: Vec<f64> = acc
            .iter()
            .zip(&sq)
            .zip(&cnt)
            .map(|((&a, &s), &c)| {
                if c > 0 {
                    (s as f64 - (a as f64) * (a as f64) / f64::from(c)).max(0.0) / (q * q)
                } else {
                    0.0
                }
            })
            .collect();
        let energy = ss.iter().sum();
        let valid = cnt.iter().map(|&c| c as f32 / t as f32).collect();
        TileMatrix {
            raw,
            t,
            p,
            inv_quant: 1.0 / quant,
            mean,
            energy,
            ss,
            valid,
        }
```

In `TileMatrix::block` replace the closure of the inner `map` by:

```rust
                    .map(|(&v, &m)| if v == MISSING { 0.0 } else { f32::from(v) * s - m }),
```

Change the doc comment of `WindowCompressor::push` from "non-finite pixels count as 0" to "a non-finite pixel is a missing sample and counts as the pixel's mean over the window".

- [ ] **Step 4: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::`
Expected: the two new tests pass. `quantize_rounds_like_f32_round` fails if it asserts that a non-finite value quantizes to 0: change that one assertion to `MISSING` and say so in your report. No other test may change.

- [ ] **Step 5: Check and commit**

Run from `crates/cala`: `cargo fmt --all`, then the clippy command of Global Constraints. Then:

```bash
git add crates/cala/src/compress/mod.rs
git commit -m "feat(cala): the compressor treats a non-finite pixel as a missing sample, not as 0"
```

---

### Task 2: Tile record v2 with discarded variance and valid share

**Files:**

- Modify: `crates/cala/src/compress/mod.rs` (`TileFactors` at about lines 94 to 195, the end of `compress_tile`)
- Test: the `tests` module of the same file

**Interfaces:**

- Consumes: `TileMatrix::ss`, `TileMatrix::valid` (Task 1).
- Produces: `TileFactors` gains `pub discarded: Vec<f32>` (per pixel, the variance over the window that the rank cut removed: `max(0, ss − ‖W(p,:)‖²) / T`) and `pub valid: Vec<f32>` (per pixel, share of valid frames). `TileFactors::to_bytes` writes a `CTF2` record; `TileFactors::from_bytes` reads `CTF1` (then `discarded` is all 0 and `valid` all 1) and `CTF2`.

Record layout, little-endian: `CTF2`, u32 x0, y0, w, h, rank, frames, svd_rank, f64 energy, f64 kept_energy, then f32 mean (`P`), discarded (`P`), valid (`P`), spatial (`P x rank`), temporal (`frames x rank`). `CTF1` is the same without discarded and valid.

- [ ] **Step 1: Write the failing tests**

```rust
    /// A tile record in the v1 layout (`CTF1`), as files written before format v2.
    fn v1_record(tf: &TileFactors) -> Vec<u8> {
        let frames = tf.temporal.len().checked_div(tf.rank).unwrap_or(0);
        let mut b = b"CTF1".to_vec();
        for v in [tf.x0, tf.y0, tf.w, tf.h, tf.rank, frames, tf.svd_rank] {
            b.extend_from_slice(&(v as u32).to_le_bytes());
        }
        b.extend_from_slice(&tf.energy.to_le_bytes());
        b.extend_from_slice(&tf.kept_energy.to_le_bytes());
        for a in [&tf.mean, &tf.spatial, &tf.temporal] {
            for v in a.iter() {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        b
    }

    #[test]
    fn the_discarded_variance_closes_the_energy() {
        let (t, side) = (300, 24);
        let (noisy, _) = synth(t, side, 4, 1.0);
        let mut tf = compress_tile(&quantized(&noisy), t, side * side, &CompressConfig::default(), 1);
        (tf.w, tf.h) = (side, side);
        assert_eq!(tf.discarded.len(), side * side);
        assert!(tf.discarded.iter().all(|&d| d >= 0.0 && d.is_finite()));
        assert!(tf.valid.iter().all(|&v| v == 1.0));
        let d: f64 = tf.discarded.iter().map(|&v| f64::from(v)).sum::<f64>() * t as f64;
        let rel = (d - (tf.energy - tf.kept_energy)).abs() / tf.energy;
        assert!(rel < 0.02, "discarded {d}, energy {} kept {}", tf.energy, tf.kept_energy);
    }

    #[test]
    fn a_tile_record_round_trips_as_v2_and_still_reads_v1() {
        let (t, side) = (120, 10);
        let (noisy, _) = synth(t, side, 2, 0.5);
        let mut tf = compress_tile(&quantized(&noisy), t, side * side, &CompressConfig::default(), 5);
        (tf.x0, tf.y0, tf.w, tf.h) = (3, 7, side, side);
        let bytes = tf.to_bytes();
        assert_eq!(&bytes[..4], b"CTF2");
        let back = TileFactors::from_bytes(&bytes).expect("v2 record");
        assert_eq!((back.x0, back.y0, back.w, back.h, back.rank), (3, 7, side, side, tf.rank));
        assert_eq!(back.discarded, tf.discarded);
        assert_eq!(back.valid, tf.valid);
        assert_eq!(back.spatial, tf.spatial);
        assert_eq!(back.temporal, tf.temporal);
        let old = TileFactors::from_bytes(&v1_record(&tf)).expect("v1 record");
        assert_eq!(old.spatial, tf.spatial);
        assert_eq!(old.mean, tf.mean);
        assert!(old.discarded.iter().all(|&d| d == 0.0) && old.discarded.len() == side * side);
        assert!(old.valid.iter().all(|&v| v == 1.0) && old.valid.len() == side * side);
        assert!(TileFactors::from_bytes(&bytes[..bytes.len() - 1]).is_none());
        let mut bad = bytes.clone();
        bad[3] = b'9';
        assert!(TileFactors::from_bytes(&bad).is_none());
    }
```

- [ ] **Step 2: Run to see them fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::tests::`
Expected: does not compile (`discarded`, `valid` are not fields of `TileFactors`).

- [ ] **Step 3: Implement**

In `struct TileFactors` add after `mean`:

```rust
    /// Per pixel: the variance over the window that the rank cut removed,
    /// `max(0, Σ (y − mean)² − ‖W(p, :)‖²) / T`. All 0 when read from a v1 file.
    pub discarded: Vec<f32>,
    /// Per pixel: the share of the window's frames in which the pixel was not
    /// missing. All 1 when read from a v1 file.
    pub valid: Vec<f32>,
```

`bytes`:

```rust
    pub fn bytes(&self) -> usize {
        4 * (self.spatial.len()
            + self.temporal.len()
            + self.mean.len()
            + self.discarded.len()
            + self.valid.len())
    }
```

In `to_bytes` write `b"CTF2"` instead of `b"CTF1"`, and write the arrays in the order `[&self.mean, &self.discarded, &self.valid, &self.spatial, &self.temporal]`. Update its doc comment to the layout given above.

Replace `from_bytes` from the magic check on by:

```rust
        let v2 = match b.get(..4)? {
            b"CTF1" => false,
            b"CTF2" => true,
            _ => return None,
        };
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
        // Per-pixel arrays before the factors: mean, and in v2 discarded and valid.
        let head = if v2 { p.checked_mul(3)? } else { p };
        let total = head.checked_add(ns)?.checked_add(nt)?;
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
        let (discarded, valid) = if v2 {
            (vals[p..2 * p].to_vec(), vals[2 * p..3 * p].to_vec())
        } else {
            (vec![0.0; p], vec![1.0; p])
        };
        Some(TileFactors {
            x0,
            y0,
            w,
            h,
            rank,
            spatial: vals[head..head + ns].to_vec(),
            temporal: vals[head + ns..].to_vec(),
            mean: vals[..p].to_vec(),
            discarded,
            valid,
            energy,
            kept_energy,
            svd_rank,
        })
```

At the end of `compress_tile`, before the `TileFactors { ... }` literal:

```rust
    let discarded = (0..p)
        .map(|i| {
            let kept: f64 = spatial[i * rank..(i + 1) * rank]
                .iter()
                .map(|&w| f64::from(w) * f64::from(w))
                .sum();
            ((y.ss[i] - kept).max(0.0) / t as f64) as f32
        })
        .collect();
```

and in the literal add `discarded,` and `valid: y.valid,` (move `y.valid` before `mean: y.mean` is used, or clone: `valid: y.valid.clone()` if the borrow checker asks).

Every other place that builds a `TileFactors` by a struct literal must set the two fields: search with `grep -rn "TileFactors {" crates/cala` and give them `discarded: vec![0.0; p]` and `valid: vec![1.0; p]` for that tile's pixel count `p`.

- [ ] **Step 4: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::`
Expected: all pass. `tile_order_and_bytes_round_trip` may compare byte counts: if it fails only because a record is now `8 * P` bytes longer, update the expected count and say so in your report.

- [ ] **Step 5: Check and commit**

```bash
git add crates/cala
git commit -m "feat(cala): tile records store the discarded variance and the valid share (CTF2), v1 still reads"
```

---

### Task 3: Window files v2 and a tiling in the compressor's config

**Files:**

- Modify: `crates/cala/src/compress/blend.rs` (`Tiling`, module doc)
- Modify: `crates/cala/src/compress/mod.rs` (`CompressConfig`, `WindowFactors`, `WindowCompressor`, `quantize_tiles`, the file constants)
- Modify: `crates/cala/examples/qc_eval.rs` (`FactorDump`, `FactorReplay`), `crates/cala/examples/discover_eval.rs` (the `to_bytes` call at about line 1214)
- Test: the `tests` modules of `mod.rs` and `blend.rs`

**Interfaces:**

- Consumes: `TileFactors` v2 (Task 2).
- Produces:
  - `impl Default for Tiling` (`Plain`); `Tiling::code(self) -> (u32, u32)` (kind 0 plain, 1 overlap, 2 offset; the second value is the overlap in px, else 0); `Tiling::from_code(kind: u32, param: u32) -> Option<Tiling>`; `Tiling::name(self) -> String` (`plain`, `overlap:8`, `offset`; the inverse of `Tiling::parse`).
  - `CompressConfig` gains `pub tiling: Tiling` (default `Tiling::Plain`).
  - `WindowFactors` gains `pub tile: usize` and `pub tiling: Tiling`.
  - `WindowFactors::header_bytes(dims: Dims, tile: usize, tiling: Tiling, frames: usize, tiles: usize, start: u64) -> Vec<u8>` (44 bytes).
  - `WindowFactors::to_bytes(&self) -> Vec<u8>` (no argument any more); `from_bytes` reads v1 and v2.
  - `WindowFactors::reconstruct` and `reconstruct_range` blend when the tiling is not plain.
  - `WindowCompressor::new(dims, cfg)` cuts the frame by `cfg.tiling`; `WindowCompressor::with_grid` is removed.
  - `quantize_tiles(frames: &[f32], count: usize, dims: Dims, grid: &[(usize, usize, usize, usize)], quant: f32, out: &mut [i16])`: `out` holds `count` times the sum of the tiles' pixels.

File layout v2, little-endian: `CALAFAC2`, u32 width, height, tile, frames, tiles, f64 stream index of the first frame, u32 tiling kind, u32 tiling parameter (44 bytes), then per tile a u32 byte length and the tile record. v1: `CALAFAC1`, the same without the two tiling fields (36 bytes); its tiling is plain.

- [ ] **Step 1: Write the failing tests**

In `blend.rs` tests:

```rust
    #[test]
    fn tiling_codes_and_names_round_trip() {
        for t in [Tiling::Plain, Tiling::Overlap(8), Tiling::Offset] {
            let (kind, param) = t.code();
            assert_eq!(Tiling::from_code(kind, param), Some(t));
            assert_eq!(Tiling::parse(&t.name()), Some(t));
        }
        assert_eq!(Tiling::default(), Tiling::Plain);
        assert_eq!(Tiling::from_code(7, 0), None);
        assert_eq!(Tiling::from_code(1, 0), None, "an overlap of 0 is plain, not overlap");
    }
```

In `mod.rs` tests:

```rust
    /// Frame `t` of a slow movie of rank 2 on `dims`.
    fn smooth_frame(dims: Dims, t: usize) -> Vec<f32> {
        let a = t as f32 / 9.0;
        (0..dims.pixels())
            .map(|i| {
                let (x, y) = ((i % dims.width) as f32, (i / dims.width) as f32);
                let b = (x + 2.0 * y) / 11.0;
                20.0 + 9.0 * a.sin() * b.cos() + 5.0 * (0.7 * a).cos() * (2.0 * b).sin()
            })
            .collect()
    }

    fn window_of(dims: Dims, tiling: Tiling, frames: usize) -> WindowFactors {
        let cfg = CompressConfig {
            window: frames,
            tiling,
            ..CompressConfig::default()
        };
        let mut wc = WindowCompressor::new(dims, cfg);
        let mut out = None;
        for t in 0..frames {
            out = wc.push(&smooth_frame(dims, t)).or(out);
        }
        out.expect("a full window")
    }

    fn worst_error(wf: &WindowFactors, t: usize) -> f32 {
        let mut got = vec![0.0f32; wf.dims.pixels()];
        wf.reconstruct(t, &mut got);
        got.iter()
            .zip(&smooth_frame(wf.dims, t))
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max)
    }

    #[test]
    fn a_v2_window_file_keeps_its_tiling_and_rebuilds_blended() {
        // 96 x 70: a thin last tile in y; 40 x 24: a frame smaller than a tile.
        for dims in [Dims::new(96, 70).unwrap(), Dims::new(40, 24).unwrap()] {
            for tiling in [Tiling::Plain, Tiling::Overlap(8), Tiling::Offset] {
                let wf = window_of(dims, tiling, 90);
                assert_eq!((wf.tile, wf.tiling), (64, tiling));
                let bytes = wf.to_bytes();
                assert_eq!(&bytes[..8], b"CALAFAC2");
                let back = WindowFactors::from_bytes(&bytes).expect("v2 file");
                assert_eq!((back.tile, back.tiling), (64, tiling));
                assert_eq!(back.tiles.len(), wf.tiles.len());
                assert!(worst_error(&back, 45) < 0.1, "{dims:?} {tiling:?}");
                let px = dims.pixels();
                let mut range = vec![0.0f32; 2 * px];
                back.reconstruct_range(44, 2, &mut range);
                let mut one = vec![0.0f32; px];
                back.reconstruct(45, &mut one);
                assert_eq!(&range[px..], &one[..]);
            }
        }
    }

    #[test]
    fn a_v1_window_file_still_reads_as_plain() {
        let dims = Dims::new(96, 70).unwrap();
        let wf = window_of(dims, Tiling::Plain, 90);
        let mut v1 = b"CALAFAC1".to_vec();
        for v in [dims.width, dims.height, 64, wf.frames, wf.tiles.len()] {
            v1.extend_from_slice(&(v as u32).to_le_bytes());
        }
        v1.extend_from_slice(&(wf.start as f64).to_le_bytes());
        for t in &wf.tiles {
            let rec = v1_record(t);
            v1.extend_from_slice(&(rec.len() as u32).to_le_bytes());
            v1.extend_from_slice(&rec);
        }
        let old = WindowFactors::from_bytes(&v1).expect("v1 file");
        assert_eq!((old.tile, old.tiling), (64, Tiling::Plain));
        let (mut a, mut b) = (vec![0.0f32; dims.pixels()], vec![0.0f32; dims.pixels()]);
        old.reconstruct(10, &mut a);
        wf.reconstruct(10, &mut b);
        assert_eq!(a, b);
    }

    #[test]
    fn a_file_whose_tiles_do_not_match_its_tiling_is_refused() {
        let dims = Dims::new(96, 70).unwrap();
        let wf = window_of(dims, Tiling::Plain, 90);
        let mut bytes = wf.to_bytes();
        // Header: kind at 36, parameter at 40. Claim the offset grids.
        bytes[36..40].copy_from_slice(&2u32.to_le_bytes());
        assert!(WindowFactors::from_bytes(&bytes).is_none());
        bytes[36..40].copy_from_slice(&9u32.to_le_bytes());
        assert!(WindowFactors::from_bytes(&bytes).is_none(), "unknown tiling kind");
    }

    #[test]
    fn quantize_tiles_follows_the_grid_it_is_given() {
        let dims = Dims::new(40, 24).unwrap();
        let layout = blend::BlendLayout::new(dims, 16, Tiling::Offset);
        let grid = layout.grid();
        let total: usize = grid.iter().map(|g| g.2 * g.3).sum();
        assert!(total > dims.pixels(), "the offset grids cover every pixel twice or more");
        let frames: Vec<f32> = (0..2 * dims.pixels()).map(|i| i as f32 / 8.0).collect();
        let mut out = vec![0i16; 2 * total];
        quantize_tiles(&frames, 2, dims, grid, QUANT, &mut out);
        // Second tile, second frame, its first pixel.
        let (x0, y0, w, h) = grid[1];
        let at = 2 * grid[0].2 * grid[0].3 + w * h;
        let want = quantize(frames[dims.pixels() + y0 * dims.width + x0], QUANT);
        assert_eq!(out[at], want);
    }
```

- [ ] **Step 2: Run to see them fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::`
Expected: does not compile (`Tiling::code`, `cfg.tiling`, `wf.tile`, `to_bytes()` without argument).

- [ ] **Step 3: Implement `Tiling` in `blend.rs`**

Change the derive line of `Tiling` to `#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]` and mark the variant `Plain` with `#[default]`. Add to `impl Tiling`:

```rust
    /// The tiling as two numbers for a file header: the kind (0 plain,
    /// 1 overlap, 2 offset) and the overlap in px (0 for the others).
    pub fn code(self) -> (u32, u32) {
        match self {
            Tiling::Plain => (0, 0),
            Tiling::Overlap(o) => (1, o as u32),
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
```

Replace the first paragraph of the module doc of `blend.rs` by:

```rust
//! Tilings with overlapping or offset tiles and a blending window. The
//! tiling of a window is part of its factor file (format v2).
```

- [ ] **Step 4: Implement the config, the file and the compressor in `mod.rs`**

Add `use blend::{BlendLayout, Tiling};` below the `mod` lines. In `CompressConfig` add the field and its default:

```rust
    /// How the frame is cut into tiles. Plain for the live factors of
    /// Discover (the history review reads them as side-by-side tiles); the
    /// factors that Refine and Extract use are cut on the offset grids.
    pub tiling: Tiling,
```

and `tiling: Tiling::Plain,` in `Default`.

Replace the two file constants by:

```rust
/// Magic and header length of a factor file ([`WindowFactors::to_bytes`]),
/// and of the files written before format v2.
const FILE_MAGIC: &[u8; 8] = b"CALAFAC2";
const FILE_HEADER: usize = 44;
const FILE_MAGIC_V1: &[u8; 8] = b"CALAFAC1";
const FILE_HEADER_V1: usize = 36;
```

In `struct WindowFactors` add after `frames`:

```rust
    /// Edge of the grid the tiles were cut on, px, and how they were cut.
    pub tile: usize,
    pub tiling: Tiling,
```

Replace `reconstruct`, `reconstruct_range`, `to_bytes` and `from_bytes` by:

```rust
    /// The tiles and blending weights of this window's tiling.
    pub fn layout(&self) -> BlendLayout {
        BlendLayout::new(self.dims, self.tile, self.tiling)
    }

    /// Frame `t` of the window (`0..frames`) rebuilt into `out`: the tiles
    /// side by side for a plain tiling, their weighted sum otherwise.
    pub fn reconstruct(&self, t: usize, out: &mut [f32]) {
        if self.tiling == Tiling::Plain {
            self.reconstruct_plain(t, out);
        } else {
            self.layout().reconstruct(self, t, out);
        }
    }

    fn reconstruct_plain(&self, t: usize, out: &mut [f32]) {
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
        let layout = (self.tiling != Tiling::Plain).then(|| self.layout());
        for (i, frame) in out.chunks_exact_mut(px).take(count).enumerate() {
            match &layout {
                Some(l) => l.reconstruct(self, t0 + i, frame),
                None => self.reconstruct_plain(t0 + i, frame),
            }
        }
    }

    pub fn bytes(&self) -> usize {
        self.tiles.iter().map(TileFactors::bytes).sum()
    }

    /// The header of a factor file: `CALAFAC2`, u32 width, height, tile,
    /// frames, tiles, f64 stream index of the first frame, u32 tiling kind
    /// and parameter ([`Tiling::code`]).
    pub fn header_bytes(
        dims: Dims,
        tile: usize,
        tiling: Tiling,
        frames: usize,
        tiles: usize,
        start: u64,
    ) -> Vec<u8> {
        let mut b = Vec::with_capacity(FILE_HEADER);
        b.extend_from_slice(FILE_MAGIC);
        for v in [dims.width, dims.height, tile, frames, tiles] {
            b.extend_from_slice(&(v as u32).to_le_bytes());
        }
        b.extend_from_slice(&(start as f64).to_le_bytes());
        let (kind, param) = tiling.code();
        b.extend_from_slice(&kind.to_le_bytes());
        b.extend_from_slice(&param.to_le_bytes());
        b
    }

    /// The window as a factor file: [`WindowFactors::header_bytes`], then per
    /// tile a u32 byte length and [`TileFactors::to_bytes`].
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = WindowFactors::header_bytes(
            self.dims,
            self.tile,
            self.tiling,
            self.frames,
            self.tiles.len(),
            self.start,
        );
        b.reserve(self.bytes() + 52 * self.tiles.len());
        for t in &self.tiles {
            let tb = t.to_bytes();
            b.extend_from_slice(&(tb.len() as u32).to_le_bytes());
            b.extend_from_slice(&tb);
        }
        b
    }

    /// Inverse of [`WindowFactors::to_bytes`], also for v1 files (`CALAFAC1`,
    /// plain tiling). `None` for truncated input, tiles that do not fit the
    /// frame or the window's length, an unknown tiling, or (v2) tiles that
    /// are not the grid of the tiling the header names.
    pub fn from_bytes(b: &[u8]) -> Option<WindowFactors> {
        let v2 = match b.get(..8)? {
            m if m == FILE_MAGIC => true,
            m if m == FILE_MAGIC_V1 => false,
            _ => return None,
        };
        let u = |o: usize| -> Option<usize> {
            Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?) as usize)
        };
        let (width, height, tile, frames, n) = (u(8)?, u(12)?, u(16)?, u(20)?, u(24)?);
        let start = f64::from_le_bytes(b.get(28..36)?.try_into().ok()?);
        if !(start.is_finite() && start >= 0.0) {
            return None;
        }
        let tiling = if v2 {
            Tiling::from_code(u(36)? as u32, u(40)? as u32)?
        } else {
            Tiling::Plain
        };
        let dims = Dims::new(width, height).ok()?;
        let mut tiles = Vec::with_capacity(n.min(1 << 16));
        let mut at = if v2 { FILE_HEADER } else { FILE_HEADER_V1 };
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
        if at != b.len() {
            return None;
        }
        let wf = WindowFactors {
            dims,
            start: start as u64,
            frames,
            tile,
            tiling,
            tiles,
            compress_seconds: 0.0,
        };
        // A blended rebuild pairs tiles and weights by index: refuse a file
        // whose tiles are not the grid of its tiling.
        if v2 && tile >= 2 {
            let layout = wf.layout();
            let same = layout.grid().len() == wf.tiles.len()
                && layout
                    .grid()
                    .iter()
                    .zip(&wf.tiles)
                    .all(|(g, t)| *g == (t.x0, t.y0, t.w, t.h));
            if !same {
                return None;
            }
        } else if v2 {
            return None;
        }
        Some(wf)
    }
```

`WindowCompressor`: replace `new` and remove `with_grid`:

```rust
    /// Buffers frames for the tiles of `cfg.tiling` on a grid of `cfg.tile` px.
    pub fn new(dims: Dims, cfg: CompressConfig) -> WindowCompressor {
        let grid = BlendLayout::new(dims, cfg.tile, cfg.tiling).grid().to_vec();
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

In `flush`, the `WindowFactors { ... }` literal gains `tile: self.cfg.tile,` and `tiling: self.cfg.tiling,`.

`quantize_tiles`: change the parameter `tile: usize` to `grid: &[(usize, usize, usize, usize)]`, iterate `for &(x0, y0, w, h) in grid`, replace the two `debug_assert_eq!` on lengths by

```rust
    let total: usize = grid.iter().map(|g| g.2 * g.3).sum();
    debug_assert_eq!(frames.len(), count * px);
    debug_assert_eq!(out.len(), count * total);
```

and update its doc comment ("for each tile of `grid` ..."; "`out` holds `count` times the pixels of all tiles").

- [ ] **Step 5: Update the callers**

- `crates/cala/src/compress/js.rs`, `quantize_tiles_js`: pass `&tile_grid(dims, tile as usize)` as the grid for now (Task 5 gives it a tiling). Import `tile_grid` there.
- `crates/cala/examples/qc_eval.rs`:
  - `FactorDump::new(dir, dims, tiling, cfg)`: build `let cfg = CompressConfig { tiling, ..cfg };`, then `wc: WindowCompressor::new(dims, cfg)`. Drop the `layout` local, the `tile` field and the `BlendLayout` import if nothing else uses it. In `write`, call `wf.to_bytes()`.
  - `FactorReplay`: drop the `layout` field and the `tiling` parameter of `FactorReplay::new` (and its argument at the call site); in `frame`, replace `self.layout.reconstruct(wf, t - start, &mut self.buf)` (the names in the file may differ slightly) by `wf.reconstruct(t - start, &mut self.buf)`. The tiling now comes from the file.
  - The test `factor_replay_returns_the_dumped_frames`: `FactorReplay::new(&dir, dims)`.
- `crates/cala/examples/discover_eval.rs`: `wf.to_bytes()` at the one call with an argument.
- Tests in `mod.rs` and `blend.rs` that call `WindowCompressor::with_grid(dims, cfg, layout.grid().to_vec())`: build the compressor with `WindowCompressor::new(dims, CompressConfig { tiling, ..cfg })` instead. Tests that call `to_bytes(tile)`: drop the argument. Any `WindowFactors { ... }` literal gains `tile` and `tiling`.

Find them with `grep -rn "with_grid\|to_bytes(\|WindowFactors {" crates/cala`.

- [ ] **Step 6: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings`
Expected: all pass, including the example's tests and `blend::tests::plain_rebuild_equals_the_window_rebuild`.

- [ ] **Step 7: Check and commit**

Run `cargo fmt --all` and the clippy command. Then:

```bash
git add crates/cala
git commit -m "feat(cala): factor files carry their tiling (CALAFAC2) and the compressor cuts by it, v1 still reads"
```

---

### Task 4: Two power iterations by default

**Files:**

- Modify: `crates/cala/src/compress/mod.rs` (`impl Default for CompressConfig`, the module doc where it names one power iteration)
- Modify: `crates/cala/examples/qc_eval.rs` (the doc comment of `--factors-n-iter`: default 2)
- Test: the `tests` module of `mod.rs`

**Interfaces:**

- Consumes: nothing new.
- Produces: `CompressConfig::default().n_iter == 2`. Every caller that does not set `n_iter` (the app's `TileCompressor`, `qc_eval --factors-out`) now compresses with two.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_second_power_iteration_captures_at_least_as_much_energy() {
        let (t, side) = (300, 24);
        let (noisy, _) = synth(t, side, 6, 3.0);
        let raw = quantized(&noisy);
        let y = TileMatrix::new(&raw, t, side * side, QUANT);
        let captured = |n_iter: usize| -> f64 {
            let svd = rsvd(&y, 20, n_iter, &mut Normals::new(11));
            svd.s.iter().map(|s| s * s).sum()
        };
        let (one, two) = (captured(1), captured(2));
        assert!(two >= one * 0.999, "one iteration {one}, two {two}");
        assert_eq!(CompressConfig::default().n_iter, 2);
    }
```

- [ ] **Step 2: Run to see it fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::tests::a_second`
Expected: FAIL on the last assertion (`left: 1, right: 2`). If the first assertion fails instead, stop and report the two numbers: do not loosen it.

- [ ] **Step 3: Implement**

In `impl Default for CompressConfig`: `n_iter: 2,`. In `examples/qc_eval.rs`, in the doc comment of `--factors-max-rank M, --factors-n-iter I`, change "(default 1)" to "(default 2)".

- [ ] **Step 4: Run all tests of the crate**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings`
Expected: all pass. A test that asserts an exact rank or a byte count of compressed synthetic data may move by a component: if one fails, report its name, the old and the new value, and change only that expected value. The example test `factor_config_is_the_apps_unless_a_cut_flag_is_given` must still pass unchanged.

- [ ] **Step 5: Check and commit**

```bash
git add crates/cala
git commit -m "feat(cala): the compressor's randomized SVD runs two power iterations by default"
```

---

### Task 5: Gate A1 in the closeness report and the arm of the chosen combination

> **Corrected in review (18 Nov 2026).** The code blocks of this task differ from what was built in three points, and the built version is the valid one:
>
> - "Usable truth" is decided on the raw run alone (QC-pass cells with a finite raw truth correlation, at least 20 of them, median at least 0.8), as spec A1 says. The code below decides it on cells matched in both runs.
> - A QC-pass cell that the factor run lost, or whose value is not finite, counts as the worst case in every rule (loss 1.0; truth correlation 0). The spec does not settle this; it is a ruling made during review and is open to the user's decision. The gate table prints how many cells are missing.
> - `line_step` reads `--tiling offset` from the arm's command instead of a list of arm names, and a value exactly at a limit passes (tolerance 1e-9).

**Files:**

- Modify: `tools/cala-eval/factor_closeness.py`, `tools/cala-eval/test_factor_closeness.py`
- Modify: `tools/cala-eval/factor_arms.py`, `tools/cala-eval/test_factor_arms.py`

**Interfaces:**

- Consumes: `qc_eval` flags `--replay-source factors`, `--tiling offset`, `--factors-pass 2` (phase 0); the default of two power iterations (Task 4).
- Produces:
  - `factor_closeness.a1_gate(rows: list[Row], jump_ref: float, jump_test: float) -> list[tuple[str, str, bool | None]]`: one `(rule, measured, passed)` per rule of A1; `passed` is `None` when the rule does not apply.
  - `factor_closeness.a1_passes(gate: list[tuple[str, str, bool | None]]) -> bool`.
  - `factor_closeness.report(...)` ends with a table of the four rules and a line `Gate A1: pass.` or `Gate A1: fail.`.
  - `factor_arms.arms(...)["chosen"]`: the refine replays and the Extract pass on recalibrated factors of the offset grids.
  - `factor_arms.line_step(name: str) -> int`: 32 for the arms whose tiles are the offset grids, else 64; `factor_arms.report` passes it to `factor_closeness.report` as `tile`, so that the lines of both grids count as tile lines.

- [ ] **Step 1: Write the failing tests**

In `tools/cala-eval/test_factor_closeness.py` (use the alias the file already imports `factor_closeness` under; `FC` below):

```python
class A1Gate(unittest.TestCase):
    @staticmethod
    def rows(
        n: int, ref: float, test: float, fp: float = 0.99, r1: float = 0.95
    ) -> list[dict[str, float]]:
        return [
            {
                "qc_pass": 1.0,
                "truth_r_ref": ref,
                "truth_r_test": test,
                "fp_cos": fp,
                "trace_r1": r1,
            }
            for _ in range(n)
        ]

    @staticmethod
    def passed(gate: list[tuple[str, str, bool | None]]) -> list[bool | None]:
        return [ok for _, _, ok in gate]

    def test_usable_truth_decides_and_the_trace_rule_does_not_apply(self) -> None:
        gate = FC.a1_gate(self.rows(25, 0.85, 0.85, r1=0.80), 1.00, 1.05)
        self.assertEqual(self.passed(gate), [True, True, None, True])
        self.assertTrue(FC.a1_passes(gate))

    def test_a_few_much_worse_cells_fail_the_truth_rule(self) -> None:
        rows = self.rows(22, 0.85, 0.85) + self.rows(3, 0.85, 0.70)
        gate = FC.a1_gate(rows, 1.0, 1.0)
        self.assertEqual(self.passed(gate), [False, True, None, True])
        self.assertFalse(FC.a1_passes(gate))

    def test_without_usable_truth_the_trace_loss_decides(self) -> None:
        nan = float("nan")
        none = FC.a1_gate(self.rows(25, nan, nan, r1=0.90), 1.0, 1.0)
        self.assertEqual(self.passed(none), [None, True, False, True])
        # Truth that the raw run itself does not follow is not usable.
        weak = FC.a1_gate(self.rows(25, 0.46, 0.60, r1=0.95), 1.0, 1.0)
        self.assertEqual(self.passed(weak), [None, True, True, True])
        few = FC.a1_gate(self.rows(19, 0.9, 0.5, r1=0.95), 1.0, 1.0)
        self.assertEqual(self.passed(few), [None, True, True, True])

    def test_footprint_and_tile_line_limits(self) -> None:
        gate = FC.a1_gate(self.rows(25, 0.85, 0.85, fp=0.97), 1.10, 1.25)
        self.assertEqual(self.passed(gate), [True, False, None, False])

    def test_cells_that_fail_qc_do_not_count(self) -> None:
        rows = self.rows(25, 0.85, 0.85)
        bad = self.rows(10, 0.85, 0.10, fp=0.1, r1=0.1)
        for r in bad:
            r["qc_pass"] = 0.0
        self.assertTrue(FC.a1_passes(FC.a1_gate(rows + bad, 1.0, 1.0)))
```

In `tools/cala-eval/test_factor_arms.py`, in the class `Arms`:

```python
    def test_the_chosen_arm_is_offset_grids_on_recalibrated_factors(self) -> None:
        a = A.arms(5)
        self.assertEqual(
            a["chosen"],
            a["raw"]
            + ["--replay-source", "factors", "--tiling", "offset"]
            + ["--factors-pass", "2"],
        )
        self.assertIn("chosen", A.default_arms(a))
        self.assertEqual(
            [A.line_step(n) for n in ("chosen", "offset", "x_offset", "plain", "raw")],
            [32, 32, 32, 64, 64],
        )
```

and add `"chosen"` to the expected list of `test_arm_names`.

- [ ] **Step 2: Run to see them fail**

Run from the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`
Expected: errors (`a1_gate`, `line_step` and the arm `chosen` do not exist).

- [ ] **Step 3: Implement the gate in `factor_closeness.py`**

Below the function `verdict`:

```python
# Gate A1 of the spec's Amendment 1 (limits approved 18 Nov 2026).
A1_TRUTH_MEDIAN = -0.01
A1_TRUTH_P5 = -0.05
A1_TRUTH_MIN_R = 0.8
A1_TRUTH_MIN_CELLS = 20
A1_FOOTPRINT_LOSS = 0.02
A1_TRACE_LOSS = 0.08
A1_JUMP_OVER_RAW = 0.10
A1_WORDS = {True: "pass", False: "fail", None: "does not apply"}


def a1_gate(
    rows: list[Row], jump_ref: float, jump_test: float
) -> list[tuple[str, str, bool | None]]:
    """(rule, measured, passed) for the four rules of gate A1, on the QC-pass cells.

    The truth rule applies when the truth is usable: at least `A1_TRUTH_MIN_CELLS`
    cells have a truth correlation in both runs and the reference run's median is at
    least `A1_TRUTH_MIN_R`. The trace rule applies when it is not. `passed` is `None`
    for a rule that does not apply; a value that cannot be computed fails its rule.
    """
    qc = [r for r in rows if r["qc_pass"]]
    pairs = [
        (r["truth_r_ref"], r["truth_r_test"])
        for r in qc
        if math.isfinite(r["truth_r_ref"]) and math.isfinite(r["truth_r_test"])
    ]
    ref = np.asarray([a for a, _ in pairs], dtype=np.float64)
    diff = np.asarray([b - a for a, b in pairs], dtype=np.float64)
    usable = (
        len(pairs) >= A1_TRUTH_MIN_CELLS and float(np.median(ref)) >= A1_TRUTH_MIN_R
    )
    out: list[tuple[str, str, bool | None]] = []
    if usable:
        med, p5 = float(np.median(diff)), float(np.percentile(diff, 5))
        out.append(
            (
                "1 truth",
                f"median {med:+.4f}, 5th pct {p5:+.4f} over {len(diff)} cells",
                med >= A1_TRUTH_MEDIAN and p5 >= A1_TRUTH_P5,
            )
        )
    else:
        out.append(("1 truth", f"no usable truth ({len(pairs)} matched cells)", None))
    fp = loss(rows, "fp_cos")
    out.append(("2 footprints", f"loss {fp:.4f}", fp <= A1_FOOTPRINT_LOSS))
    tr = loss(rows, "trace_r1")
    out.append(
        (
            "3 traces without truth",
            f"loss {tr:.4f}",
            None if usable else tr <= A1_TRACE_LOSS,
        )
    )
    out.append(
        (
            "4 tile lines",
            f"jump {jump_test:.3f} against {jump_ref:.3f}",
            jump_test <= jump_ref + A1_JUMP_OVER_RAW,
        )
    )
    return out


def a1_passes(gate: list[tuple[str, str, bool | None]]) -> bool:
    """True when no rule of the gate failed."""
    return all(ok is not False for _, _, ok in gate)
```

A comparison with NaN is false in Python, so a loss or a jump that could not be computed fails its rule, as the docstring says.

In `report`, replace the last block (from `ja, jb = line_jump(...)` to the `return`) by:

```python
    ja, jb = line_jump(fa, dims, tile), line_jump(fb, dims, tile)
    gate = a1_gate(rows, ja, jb)
    out += [
        "",
        f"Footprint jump at tile lines over elsewhere: reference {ja:.3f}, test {jb:.3f}.",
        "",
        "| A1 rule | measured | result |",
        "| --- | --- | --- |",
    ]
    out += [f"| {rule} | {what} | {A1_WORDS[ok]} |" for rule, what, ok in gate]
    out += ["", f"Gate A1: {'pass' if a1_passes(gate) else 'fail'}.", ""]
    return "\n".join(out)
```

Add one sentence to the module docstring: the report ends with gate A1 of the spec's Amendment 1.

- [ ] **Step 4: Implement the arm in `factor_arms.py`**

In `arms`, after the line that sets `out["plain_recal"]`:

```python
    out["chosen"] = out["offset"] + ["--factors-pass", "2"]
```

Below `default_arms`:

```python
def line_step(name: str) -> int:
    """Distance between tile lines for an arm, px: 32 where the tiles are the two offset grids."""
    return 32 if name in ("chosen", "offset", "x_offset") else 64
```

In `report`, change the condition `if n in TILINGS or n == "plain_recal" or n in REMEDIES:` to also take `n == "chosen"`, and pass `tile=line_step(n)` in both calls of `factor_closeness.report`. In the module docstring add the line:

```text
- `chosen`: the combination chosen after phase 0: the offset grids on recalibrated factors
  (the compressor's default of two power iterations).
```

- [ ] **Step 5: Run the tests**

Run from the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`
Expected: OK. A test of `report` that pins its last lines must be updated to the new ending; say so in your report.

- [ ] **Step 6: Format, lint and commit**

```bash
uvx ruff format tools/cala-eval/factor_closeness.py tools/cala-eval/factor_arms.py tools/cala-eval/test_factor_closeness.py tools/cala-eval/test_factor_arms.py
```

```bash
uvx ruff check --fix tools/cala-eval/factor_closeness.py tools/cala-eval/factor_arms.py tools/cala-eval/test_factor_closeness.py tools/cala-eval/test_factor_arms.py
```

```bash
git add tools/cala-eval
git commit -m "feat(cala-eval): gate A1 in the closeness report and the arm of the chosen combination"
```

---

### Task 6: The app compresses on a tiling and writes v2 files

**Files:**

- Modify: `crates/cala/src/compress/js.rs`
- Modify: `apps/cala/src/lib/cala-wasm.ts`, `apps/cala/src/workers/compress-types.ts`, `apps/cala/src/lib/compress-feed.ts`, `apps/cala/src/lib/compress-runner.ts`, `apps/cala/src/workers/compress-worker.ts`
- Test: `apps/cala/src/__tests__/compress.test.ts`

**Interfaces:**

- Consumes: `BlendLayout::new`, `Tiling::parse`, `Tiling::name`, `WindowFactors::header_bytes`, `quantize_tiles` with a grid (Task 3).
- Produces (WASM, re-exported by `cala-wasm.ts`):
  - `tileLayout(width: number, height: number, tile: number, tiling: string): Uint32Array`, `(x0, y0, w, h)` per tile.
  - `quantizeTiles(frames: Float32Array, count: number, width: number, height: number, tile: number, tiling: string, quant: number, out: Int16Array): void`; `out` holds `count` times the pixels of all tiles.
  - `factorHeader(width: number, height: number, tile: number, tiling: string, frames: number, tiles: number, start: number): Uint8Array`.
  - `FactorWindow.tiling: string`, `FactorWindow.tile: number`; `FactorWindow.reconstruct` blends.
- Produces (TypeScript):
  - `type CompressTiling = 'plain' | 'offset'`, `type CompressSource = 'discover' | 'replay'` in `workers/compress-types.ts`; `CompressInit` and `CompressStatus` each gain `tiling: CompressTiling` and `source: CompressSource`.
  - `CompressFeedOptions` gains `tiling?: CompressTiling` and `source?: CompressSource` (defaults `'plain'`, `'discover'`).
  - `CompressRunnerDeps` gains `layout` and `header`; `tilesOf(rects: Uint32Array): Tile[]` replaces `tileGrid`.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/compress.test.ts`:

Change the imports from `cala-wasm.ts` to include `factorHeader` and `tileLayout`, and import `tilesOf` instead of `tileGrid`. In `runner()`, add to the dependencies `layout: tileLayout,` and `header: factorHeader,`.

Replace `readFactors` by:

```ts
/** The tiles of a v2 factor file: position, rank and the five float arrays. */
function readFactors(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('CALAFAC2');
  const [width, height, tile, frames, n] = [8, 12, 16, 20, 24].map((o) => view.getUint32(o, true));
  const start = view.getFloat64(28, true);
  const [kind, param] = [36, 40].map((o) => view.getUint32(o, true));
  const tiles = [];
  let at = 44;
  for (let i = 0; i < n; i++) {
    const len = view.getUint32(at, true);
    const b = bytes.slice(at + 4, at + 4 + len);
    at += 4 + len;
    const v = new DataView(b.buffer);
    expect(new TextDecoder().decode(b.subarray(0, 4))).toBe('CTF2');
    const [x0, y0, w, h, rank, t] = [4, 8, 12, 16, 20, 24].map((o) => v.getUint32(o, true));
    const p = w * h;
    const floats = new Float32Array(b.buffer.slice(48));
    tiles.push({
      x0,
      y0,
      w,
      h,
      rank,
      frames: t,
      mean: floats.subarray(0, p),
      discarded: floats.subarray(p, 2 * p),
      valid: floats.subarray(2 * p, 3 * p),
      spatial: floats.subarray(3 * p, 3 * p + p * rank),
      temporal: floats.subarray(3 * p + p * rank),
    });
  }
  expect(at).toBe(bytes.length);
  return { width, height, tile, frames, start, kind, param, tiles };
}
```

In the test `lays out the tiles like the quantizer`, build the grid with `const grid = tilesOf(tileLayout(W, H, TILE, 'plain'));` (the expectations stay). In `turns the fed frames into factor files that rebuild them`, add inside the loop over the windows: `expect([f.kind, f.param]).toEqual([0, 0]);` and, for every tile, `expect([...tile.valid].every((v) => v === 1)).toBe(true);`.

Add to `describe('CompressRunner', ...)`:

```ts
/** A feed with its own options whose messages are collected. */
function feedWith(options: Partial<ConstructorParameters<typeof CompressFeed>[0]>) {
  const sent: FastToCompress[] = [];
  const feed = new CompressFeed(
    { width: W, height: H, session: 7, tile: TILE, window: 50, quant: QUANT, ...options },
    { postMessage: (m) => sent.push(m) },
  );
  return { feed, sent };
}

it('compresses on the offset grids and rebuilds the frames blended', async () => {
  const { feed, sent } = feedWith({ tiling: 'offset' });
  for (let s = 0; s < 120; s += 7)
    feed.push(batch(s, Math.min(7, 120 - s)), s, Math.min(7, 120 - s));
  feed.end();
  expect(sent[0]).toMatchObject({ type: 'init', tiling: 'offset', source: 'discover' });
  const { r, store, toMain } = runner();
  for (const m of sent) await r.handle(m);
  await r.idle();

  const tiles = tileLayout(W, H, TILE, 'offset').length / 4;
  expect(tiles).toBe(12);
  const last = toMain[toMain.length - 1];
  if (last.type !== 'status') throw new Error('the last message is not a status');
  expect(last.status).toMatchObject({
    windows: 3,
    frames: 120,
    final: true,
    tiling: 'offset',
    source: 'discover',
  });
  const out = new Float32Array(PX);
  const windows = [
    [0, 50, 0],
    [1, 50, 50],
    [2, 20, 100],
  ] as const;
  for (const [k, frames, start] of windows) {
    const bytes = store.files.get(factorName(k))!;
    const f = readFactors(bytes);
    expect([f.kind, f.tiles.length]).toEqual([2, tiles]);
    const win = FactorWindow.fromBytes(bytes);
    try {
      expect([win.frames, win.start, win.tiling, win.tile]).toEqual([
        frames,
        start,
        'offset',
        TILE,
      ]);
      const t = Math.floor(frames / 2);
      win.reconstruct(t, 1, out);
      const want = frame(start + t);
      let worst = 0;
      for (let i = 0; i < PX; i++) worst = Math.max(worst, Math.abs(out[i] - want[i]));
      if (frames === 50) expect(worst, `window ${k}`).toBeLessThan(0.1);
    } finally {
      win.free();
    }
  }
});

it('skips a last window of one frame under the offset grids', async () => {
  const { feed, sent } = feedWith({ tiling: 'offset' });
  feed.push(batch(0, 51), 0, 51);
  feed.end();
  const { r, store, toMain } = runner();
  for (const m of sent) await r.handle(m);
  await r.idle();
  expect([...store.files.keys()]).toEqual([factorName(0)]);
  const last = toMain[toMain.length - 1];
  if (last.type !== 'status') throw new Error('the last message is not a status');
  expect(last.status).toMatchObject({ windows: 1, frames: 50, pending: 0, final: true });
});

it('marks a missing pixel as not valid instead of pulling its mean to 0', async () => {
  const { feed, sent } = feedWith({});
  const frames = batch(0, 50);
  // Pixel (0, 0) is missing in the first 20 frames.
  for (let t = 0; t < 20; t++) frames[t * PX] = Number.NaN;
  feed.push(frames, 0, 50);
  feed.end();
  const { r, store } = runner();
  for (const m of sent) await r.handle(m);
  await r.idle();
  const first = readFactors(store.files.get(factorName(0))!).tiles[0];
  expect(first.valid[0]).toBeCloseTo(0.6, 6);
  expect(first.valid[1]).toBe(1);
  let mean = 0;
  for (let t = 20; t < 50; t++) mean += frame(t)[0] / 30;
  expect(first.mean[0]).toBeCloseTo(mean, 1);
});
```

- [ ] **Step 2: Run to see them fail**

Run inside `apps/cala`: `npx vitest run src/__tests__/compress.test.ts`
Expected: the file does not load (`tileLayout`, `factorHeader`, `tilesOf` are not exported).

- [ ] **Step 3: Implement the bindings in `crates/cala/src/compress/js.rs`**

Extend the imports of the module by `blend::{BlendLayout, Tiling}` and drop `tile_grid` again. Add a helper below `js_err`:

```rust
fn parse_tiling(func: &str, s: &str) -> Result<Tiling, JsError> {
    Tiling::parse(s).ok_or_else(|| js_err(func, format!("tiling {s:?}: plain, overlap:N or offset")))
}

fn layout_of(func: &str, width: u32, height: u32, tile: u32, tiling: &str) -> Result<BlendLayout, JsError> {
    let dims = Dims::new(width as usize, height as usize).map_err(|e| js_err(func, e))?;
    if tile < 2 {
        return Err(js_err(func, "tile must be at least 2"));
    }
    Ok(BlendLayout::new(dims, tile as usize, parse_tiling(func, tiling)?))
}

/// The tiles of a tiling, `(x0, y0, w, h)` one after the other, in the order
/// `quantizeTiles` writes them and a factor file holds them.
#[wasm_bindgen(js_name = tileLayout)]
pub fn tile_layout(width: u32, height: u32, tile: u32, tiling: &str) -> Result<Vec<u32>, JsError> {
    let layout = layout_of("tileLayout", width, height, tile, tiling)?;
    Ok(layout
        .grid()
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
    let dims = Dims::new(width as usize, height as usize).map_err(|e| js_err("factorHeader", e))?;
    if !(start.is_finite() && start >= 0.0) {
        return Err(js_err("factorHeader", "start must be a frame index"));
    }
    Ok(WindowFactors::header_bytes(
        dims,
        tile as usize,
        parse_tiling("factorHeader", tiling)?,
        frames as usize,
        tiles as usize,
        start as u64,
    ))
}
```

Replace `quantize_tiles_js` by:

```rust
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
    let layout = layout_of("quantizeTiles", width, height, tile, tiling)?;
    let dims = Dims::new(width as usize, height as usize).map_err(|e| js_err("quantizeTiles", e))?;
    let total: usize = layout.grid().iter().map(|g| g.2 * g.3).sum();
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
    quantize_tiles(frames, count, dims, layout.grid(), quant, out);
    Ok(())
}
```

In `impl JsFactorWindow` add two getters after `start`:

```rust
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
```

Change the doc comment of `quantizeFrames` from "non-finite values count as 0" to "a non-finite value gives the missing marker, -32768", and of `FactorWindow.fromBytes` to name both `CALAFAC1` and `CALAFAC2`.

Run from `crates/cala`: `cargo fmt --all` and the clippy command of Global Constraints.

- [ ] **Step 4: Implement the TypeScript side**

`apps/cala/src/lib/cala-wasm.ts`: add `factorHeader` and `tileLayout` to the import from the package and to the re-export list, next to `quantizeTiles`.

`apps/cala/src/workers/compress-types.ts`: above `CompressInit` add

```ts
/** How a frame is cut into tiles (`Tiling` in crates/cala): side by side, or on two grids offset by half a tile. */
export type CompressTiling = 'plain' | 'offset';
/**
 * Which frames a run of windows holds: Discover's, preprocessed with the
 * calibration of the moment, or a replay's, with the final calibration.
 */
export type CompressSource = 'discover' | 'replay';
```

and give `CompressInit` and `CompressStatus` the two fields `tiling: CompressTiling;` and `source: CompressSource;`, each with a one-line doc comment.

`apps/cala/src/lib/compress-feed.ts`: import the two types; add to `CompressFeedOptions`

```ts
  /** How the frame is cut into tiles (default plain: the history review reads side-by-side tiles). */
  tiling?: CompressTiling;
  /** Which frames these are (default Discover's). */
  source?: CompressSource;
```

change the defaults to

```ts
export const COMPRESS_DEFAULTS = {
  tile: 64,
  window: 600,
  quant: 64,
  tiling: 'plain',
  source: 'discover',
} as const;
```

and in `push` destructure `tiling` and `source` from `this.o` and send them in the `init` message:

```ts
this.port.postMessage({
  type: 'init',
  session,
  width,
  height,
  tile,
  window,
  quant,
  tiling,
  source,
});
```

`apps/cala/src/lib/compress-runner.ts`:

- `QuantizeTiles` gains the parameter `tiling: string` between `tile` and `quant`.
- `CompressRunnerDeps` gains

```ts
  /** `tileLayout` of the WASM module: `(x0, y0, w, h)` of every tile. */
  layout(width: number, height: number, tile: number, tiling: string): Uint32Array;
  /** `factorHeader` of the WASM module: the first bytes of a factor file. */
  header(
    width: number,
    height: number,
    tile: number,
    tiling: string,
    frames: number,
    tiles: number,
    start: number,
  ): Uint8Array;
```

- Replace `tileGrid` by

```ts
/** The tiles of a layout (`tileLayout`: x0, y0, w, h each), with their place in a quantized chunk. */
export function tilesOf(rects: Uint32Array): Tile[] {
  const out: Tile[] = [];
  let offset = 0;
  for (let i = 0; i + 3 < rects.length; i += 4) {
    const [x0, y0, w, h] = [rects[i], rects[i + 1], rects[i + 2], rects[i + 3]];
    out.push({ x0, y0, w, h, offset });
    offset += w * h;
  }
  return out;
}
```

and delete the constant `HEADER_BYTES`.

- In the class add the field `/** Pixels of all tiles (more than a frame when tiles overlap). */ private layoutPx = 0;`. In `handle`, case `init`, replace the line that sets `this.tiles` by

```ts
this.tiles = tilesOf(this.deps.layout(msg.width, msg.height, msg.tile, msg.tiling));
this.layoutPx = this.tiles.reduce((s, t) => s + t.w * t.h, 0);
```

- In `handle`, case `chunk`, replace the four lines from `const { width, height, tile, quant } = this.init;` to the `quantize` call by

```ts
const { width, height, tile, tiling, quant } = this.init;
const values = msg.count * this.layoutPx;
if (this.scratch.length < values) this.scratch = new Int16Array(values);
const data = this.scratch.subarray(0, values);
const t0 = this.now();
this.deps.quantize(msg.data, msg.count, width, height, tile, tiling, quant, data);
```

- In `compress`, delete `const px = init.width * init.height;`, replace the header block (from `const head = new DataView(...)` to `let at = HEADER_BYTES;`) by

```ts
const head = this.deps.header(
  init.width,
  init.height,
  init.tile,
  init.tiling,
  job.frames,
  this.tiles.length,
  job.start,
);
dst.write(head, 0);
let at = head.length;
```

and the line `chunkAt += n * px * 2;` by `chunkAt += n * this.layoutPx * 2;`.

- In `post`, add to the status `tiling: this.init?.tiling ?? 'plain',` and `source: this.init?.source ?? 'discover',`.
- In the file's header comment, replace the description of the factor file by: "Factor file `f<index>.bin`: the header of `factorHeader` (`CALAFAC2`, with the tiling), then per tile u32 byte length and `TileFactors.toBytes()`."

`apps/cala/src/workers/compress-worker.ts`: import `factorHeader` and `tileLayout` from `../lib/cala-wasm.ts` and pass `layout: tileLayout,` and `header: factorHeader,` in the runner's dependencies.

Any other construction of a `CompressStatus` or `CompressInit` literal (search `grep -rn "factorBytes\|type: 'init'" apps/cala/src`) gains the two fields; in tests use `tiling: 'plain', source: 'discover'`.

- [ ] **Step 5: Build the WASM package and run the tests**

Run from the repository root: `npm run build:wasm`
Then inside `apps/cala`: `npx vitest run src/__tests__/compress.test.ts src/__tests__/review.test.ts`
Expected: all pass, including the unchanged back-fill tests (the back-fill rebuilds frames through `FactorWindow.reconstruct`).

- [ ] **Step 6: Check and commit**

Run from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, and `npx prettier --check apps/cala/src`. From `crates/cala`: `cargo test --no-default-features --features jsbindings`.

```bash
git add crates/cala apps/cala
git commit -m "feat(cala): the app's compressor takes its tile layout and file header from WASM and writes v2 files"
```

---

### Task 7: Extract's replay writes the recalibrated factors

With `?compress`, Extract's replay also feeds the compress worker, on the offset grids. Its frames have the final calibration, so the windows it leaves are the recalibrated factors, at no extra pass over the file. The runner already drops every earlier window when a new `init` arrives, so Discover's windows (and a back-fill still running on them) are replaced.

**Files:**

- Modify: `apps/cala/src/workers/frame-types.ts` (`CellsSettings`)
- Modify: `apps/cala/src/workers/trace-worker.ts` (the `CompressFeed` of case `start`), `apps/cala/src/workers/frame-worker.ts` (the same construction of the non-pipelined path, at about line 261)
- Modify: `apps/cala/src/lib/pass2-store.ts`, `apps/cala/src/lib/compress-store.ts`, `apps/cala/src/App.tsx` (the `createPass2Store` call at about line 179)
- Modify: `apps/cala/scripts/batch-session.mjs` (the snapshot at about lines 115 to 135 and the places that close a stage)
- Test: `apps/cala/src/__tests__/pass2-store.test.ts`, `apps/cala/src/__tests__/compress.test.ts`

**Interfaces:**

- Consumes: `CompressTiling`, `CompressSource`, the `tiling` and `source` options of `CompressFeed`, `CompressStatus.source` (Task 6).
- Produces:
  - `CellsSettings.compressTiling?: CompressTiling` and `CellsSettings.compressSession?: number`.
  - `createPass2Store(client, pipeline, cells, clock?, blocked?, compressSession?: () => number | null)`.
  - `compressReadout` starts with `Recalibrated factors:` when the status's source is `replay`, and names no back-fill then.
  - The batch driver's `status.json` holds the compress status at the end of Discover and of Extract.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/pass2-store.test.ts`: give `setup` an option `compressSession?: number` and build the store with it:

```ts
return {
  store: createPass2Store(
    client,
    pipeline,
    cells,
    undefined,
    undefined,
    opts.compressSession === undefined ? undefined : () => opts.compressSession ?? null,
  ),
  started,
  steps,
};
```

and add the test:

```ts
it('feeds the compressor on the offset grids when compression is on', async () => {
  const { store, started } = setup({ compressSession: 4 });
  await store.run();
  await settle();
  expect(store.status()).toBe('done');
  expect(started[0].cells).toEqual({
    session: 0,
    discover: false,
    qc: false,
    signed: true,
    projection: true,
    library: Uint8Array.of(1, 2, 3),
    compress: true,
    compressTiling: 'offset',
    compressSession: 4,
  });
});
```

The existing first test already pins that the three fields are absent without it.

In `apps/cala/src/__tests__/compress.test.ts`, in `describe('CompressRunner', ...)`:

```ts
it('a replay of the same session replaces the windows of Discover', async () => {
  const discover = feedWith({});
  discover.feed.push(batch(0, 100), 0, 100);
  discover.feed.end();
  const replay = feedWith({ tiling: 'offset', source: 'replay' });
  replay.feed.push(batch(0, 60), 0, 60);
  replay.feed.end();
  const { r, store, toMain } = runner();
  // The replay starts while Discover's windows are still being compressed.
  for (const m of [...discover.sent, ...replay.sent]) await r.handle(m);
  await r.idle();

  expect([...store.files.keys()].sort()).toEqual([0, 1].map(factorName));
  const win = FactorWindow.fromBytes(store.files.get(factorName(1))!);
  try {
    expect([win.frames, win.start, win.tiling]).toEqual([10, 50, 'offset']);
  } finally {
    win.free();
  }
  const last = toMain[toMain.length - 1];
  if (last.type !== 'status') throw new Error('the last message is not a status');
  expect(last.status).toMatchObject({
    windows: 2,
    frames: 60,
    final: true,
    tiling: 'offset',
    source: 'replay',
  });
  expect(compressReadout(last.status, { version: 3, frames: 100, msPerFrame: 1 })).toMatch(
    /^Recalibrated factors: 2 windows · rank \d[^(]*$/,
  );
});
```

- [ ] **Step 2: Run to see them fail**

Run inside `apps/cala`: `npx vitest run src/__tests__/pass2-store.test.ts src/__tests__/compress.test.ts`
Expected: the new Extract test fails (the three fields are missing; TypeScript also rejects the sixth argument), and the readout assertion fails (`Compression: ...`).

- [ ] **Step 3: Implement**

`apps/cala/src/workers/frame-types.ts`: import `CompressTiling` from `./compress-types.ts` and add to `CellsSettings`, after `compress`:

```ts
  /** With `compress`: how the frame is cut into tiles (default plain). */
  compressTiling?: CompressTiling;
  /** With `compress`: the session the windows' messages carry (default `session`). */
  compressSession?: number;
```

`apps/cala/src/workers/trace-worker.ts`, case `start`: replace the options object of `new CompressFeed(...)` by

```ts
              {
                width: msg.fast.width,
                height: msg.fast.height,
                session: cells.compressSession ?? cells.session,
                ...(cells.compressTiling ? { tiling: cells.compressTiling } : {}),
                // A stage that solves with a given library is a replay: its
                // frames have the final calibration.
                source: cells.library ? 'replay' : 'discover',
              },
```

Make the same change in `apps/cala/src/workers/frame-worker.ts` where the non-pipelined path builds its `CompressFeed`.

`apps/cala/src/lib/pass2-store.ts`: add a sixth parameter to `createPass2Store`:

```ts
  /**
   * With `?compress`: the session of the compress store. The replay then also
   * feeds the compress worker, on the offset grids, and leaves the recalibrated
   * factors (its frames have the final calibration). Null or absent: off.
   */
  compressSession?: () => number | null,
```

and in `run`, replace the cells object passed to `startReplayPipeline` by

```ts
        {
          session: 0,
          discover: false,
          library: bytes,
          signed: true,
          projection: true,
          ...compressCells(compressSession?.() ?? null),
        },
```

with, above `createPass2Store`:

```ts
/** The compress settings of Extract's replay (none when compression is off). */
function compressCells(
  session: number | null,
): Pick<CellsSettings, 'compress' | 'compressTiling' | 'compressSession'> {
  return session === null
    ? {}
    : { compress: true, compressTiling: 'offset', compressSession: session };
}
```

(import the type `CellsSettings` from `../workers/frame-types.ts` if the file does not have it yet).

`apps/cala/src/App.tsx`: pass the session as the sixth argument:

```ts
const pass2 = createPass2Store(
  client,
  pipeline,
  cells,
  undefined,
  () =>
    refine.status() === 'running' || refine.status() === 'finishing' ? 'Refine is running.' : null,
  compress ? () => cells.session() : undefined,
);
```

`apps/cala/src/lib/compress-store.ts`, `compressReadout`: the back-fill belongs to Discover's windows, so it is not named for a replay, and the label says what the windows are:

```ts
/**
 * `Compression: 4 windows · rank 5.6 · 8.6 ms/frame · 41 MB · traces back-filled (2,000 frames, 2.1 ms/frame)`,
 * or `Recalibrated factors: ...` for the windows of Extract's replay.
 */
export function compressReadout(s: CompressStatus | null, b: BackfillInfo | null = null): string {
  if (!s || s.windows === 0) return 'Compression: waiting for the first window';
  const replay = s.source === 'replay';
  const mb = (s.factorBytes / 1048576).toFixed(0);
  const waiting = s.pending > 0 ? ` · ${s.pending} waiting` : '';
  const filled =
    b && !replay
      ? ` · traces back-filled (${b.frames.toLocaleString('en-US')} frames, ${b.msPerFrame.toFixed(1)} ms/frame)`
      : '';
  return (
    `${replay ? 'Recalibrated factors' : 'Compression'}: ${s.windows} windows · ` +
    `rank ${s.meanRank.toFixed(1)} · ${s.msPerFrame.toFixed(1)} ms/frame · ${mb} MB${waiting}${filled}`
  );
}
```

`apps/cala/scripts/batch-session.mjs`: in the page snapshot add the field

```js
        compress: c.compress?.status?.() ?? null,
```

and wherever the script sets `status.stages.<stage>.end = Date.now()` for Discover and for Extract, also set `status.stages.<stage>.compress = s.compress` (the snapshot `s` of that poll). Add `compress` to the usage comment at the top: "`--query compress`: `status.json` then holds the compress status at the end of Discover and of Extract".

- [ ] **Step 4: Run the tests**

Run inside `apps/cala`: `npx vitest run src/__tests__/pass2-store.test.ts src/__tests__/compress.test.ts`
Expected: all pass.

- [ ] **Step 5: Check in the browser**

Run from the repository root: `npm run build:e2e`, then the batch driver on a short recording with `--query compress --refine-runs 0` (its usage comment gives the other options; write the output to a folder outside the repository). Expected in the written `<tag>.status.json`: `stages.discover.compress.source` is `discover` with tiling `plain`; `stages.extract.compress` has `source: "replay"`, `tiling: "offset"`, `final: true`, `pending: 0` and `windows` equal to the recording's frames divided by 600, rounded up (one less if the last window has a single frame). Put the two status objects in your report. If the recording folder is not available to you, say so and leave this step to the controller: do not mark it done.

- [ ] **Step 6: Check and commit**

Run from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, `npx prettier --check apps/cala`.

```bash
git add apps/cala
git commit -m "feat(cala): with ?compress, Extract's replay writes recalibrated factors on the offset grids"
```

---

### Task 8: Measure the chosen combination against gate A1 and write the report

The runs take about two hours and need the recordings; the controller starts them (as in phase 0) and a subagent writes the report from their outputs.

**Files:**

- Create: `tools/cala-eval/results/<date of the runs>-factor-phase1.md`
- Modify: `docs/CHANGELOG.md`, `tools/cala-eval/README.md`, `apps/cala/README.md` (the compression section, at about lines 332 to 363)

**Interfaces:**

- Consumes: the arm `chosen` and gate A1 in the reports (Task 5); the release `qc_eval` built from this branch (Tasks 1 to 4); the batch driver's compress status (Task 7).
- Produces: the report with the gate's result per recording. The decision to start phase 2 is the user's.

- [ ] **Step 1: Build and run the native arms**

Run from `crates/cala`: `cargo build --release --example qc_eval`.

Recordings and scale are those of phase 0 (its report's "How it was measured"): `wl200`, `wl24_01`, `wl24_04` (200 px: first 12000 frames, 5 refine replays, 3 runs at once) and `plain`, `v4`, `motion` (600 px: first 6000 frames, 2 refine replays, 2 runs at once); slow-loop budget 3,000,000. Use a new output folder: the compressor's defaults changed, so no arm of phase 0 may be reused. For each recording run

```bash
uv run --no-project --with numpy python tools/cala-eval/factor_arms.py --rec <recording> --out <runs>/<name> --budget 3000000 --frames <12000 or 6000> --refine <5 or 2> --jobs <3 or 2> --arms <arms> [--truth <truth.npz>]
```

with `<arms>` = `raw,null_lo,null_hi,plain_recal,chosen` at 200 px and `raw,null_lo,plain_recal,chosen` at 600 px. Keep the calls in one script file in the output folder, with a log; check afterwards that every arm ended with return code 0.

- [ ] **Step 2: Run the browser timing**

Run `npm run build:e2e`, then the batch driver with `--query compress --refine-runs 0` on `wl24_01` and on `v4`, one at a time, with nothing else heavy on the machine (check with `pgrep -fl qc_eval` first and write down what else ran).

- [ ] **Step 3: Write the report**

`tools/cala-eval/results/<date>-factor-phase1.md`, with every number produced by a throwaway script from the run folder (not copied by hand; keep the script out of the repository), sections in this order:

1. **Gate A1**: one table, a row per recording, for the arm `chosen`: each rule's measured value and result, and the gate's result, as the last lines of each recording's `report.md` give them. One sentence per failed rule saying by how much. Then: "Decision: open, for the user."
2. **How it was measured**: commit of the build, machine, scale, budget, arms, and that the tile lines of the offset grids are every 32 px in the tile-line measures.
3. **Against plain recalibrated factors**: `chosen` beside `plain_recal`: trace loss, footprint loss, footprint jump, mean rank, megabytes per 1000 frames, compression milliseconds per frame.
4. **Compression time against the frame budget**: native (from `factors.tsv`, single thread) and browser (from the driver's `status.json`: Discover on plain tiles, Extract's replay on the offset grids), in milliseconds per frame beside 1000 divided by the recording's frame rate. State the result of the phase's gate sentence "compression time of that combination within the live frame budget" for both recordings.
5. **Valid share**: on `motion` and `v4`, the share of pixels with a valid share below 1 in the `chosen` factors, from a few factor files (use `WindowFactors::from_bytes` through `examples/history_review.rs` or a short script that reads the v2 layout).
6. **What was not measured**: at least: the low-SNR and dense sets, full-length recordings, the default slow-loop budget, live streams, three or more power iterations.

Writing rules as in the phase 0 report: plain short sentences, recordings by their names, no machine paths, a sentence under every table saying what it shows, what was not verified stated as plainly as what was.

- [ ] **Step 4: Docs**

- `docs/CHANGELOG.md`, under `## [Unreleased]`, `### Changed`: one entry: factor files are format v2 (`CALAFAC2`: tiling, discarded variance, valid share; v1 files still read); a non-finite pixel is a missing sample; the compressor runs two power iterations; with `?compress`, Extract's replay writes recalibrated factors on two offset grids.
- `apps/cala/README.md`, compression section: the same four facts in the section's style, and that the history review still reads Discover's side-by-side tiles.
- `tools/cala-eval/README.md`: a line for the arm `chosen` and for gate A1 in the closeness report.

Run `npx prettier --write` on the three files and the report.

- [ ] **Step 5: Final check and commit**

All checks of Global Constraints, Rust and app.

```bash
git add tools/cala-eval/results docs/CHANGELOG.md apps/cala/README.md tools/cala-eval/README.md
git commit -m "docs(cala-eval): phase 1 results of the factor pipeline against gate A1"
```

---

## Not in this phase

- The history review does not blend overlapping tiles (it stacks the components of every tile that covers a pixel). Discover's live factors therefore stay on plain tiles. Making the review read the offset grids belongs to phase 4, where a live stream's factors are also the ones Refine and Extract use.
- A compression replay that does not solve traces. In this phase the recalibrated factors come from Extract's replay. Phase 3 (Refine on factors) needs them before Refine and adds the separate replay.
- `?compress` on by default, the Run panel and the export's stage record of the factors (phase 4).
- Nothing reads `discarded` or `valid` yet. Extract on factors (phase 2) and Refine on factors (phase 3) do.

## Self-review notes

- Spec coverage: format v2 with tiling geometry, discarded variance and valid share (Tasks 1 to 3); two power iterations (Task 4); offset grids in the compressor and the app (Tasks 3, 6); recalibrated factors for files (Task 7); the phase's gate (Tasks 5, 8). `MIN_VALID_SHARE` is applied by the consumers of `valid` in phases 2 and 3, not here.
- Names used across tasks: `MISSING`, `TileMatrix::ss`, `TileMatrix::valid`, `TileFactors::discarded`, `TileFactors::valid`, `Tiling::code` / `from_code` / `name`, `CompressConfig::tiling`, `WindowFactors::tile` / `tiling` / `layout` / `header_bytes` / `to_bytes()`, `quantize_tiles(.., grid, ..)`, `tileLayout`, `factorHeader`, `tilesOf`, `CompressTiling`, `CompressSource`, `compressTiling`, `compressSession`, `a1_gate`, `a1_passes`, `line_step`, arm `chosen`.
