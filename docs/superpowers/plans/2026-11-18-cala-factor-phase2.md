# cala factor pipeline, phase 2: Extract on factors

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The traces of a library are solved from a window's factors without rebuilding a frame; the result equals the solve on rebuilt frames to float32 rounding, meets gate A1 against the raw run, and replaces the app's back-fill.

**Architecture:** The trace solver reads a frame only through linear functionals: each cell's projection onto its filtered column and the background model's sums. `TraceEngine` gains an entry point that takes those numbers instead of the pixels. A new `WindowProjector` forms, once per window and library, the row `fᵀ diag(b_k) W_k` of every functional `f` and tile `k` it touches (with the tiling's blending weights `b_k`), so a frame costs `rank` multiply-adds per row. `FactorExtractor` ties the two together; `qc_eval` gets it as a third arm (C) beside raw frames (A) and rebuilt frames (B), and the app's compress worker uses it for the back-fill.

**Tech Stack:** Rust (crate `calab-cala`), wasm-bindgen, TypeScript with vitest (`apps/cala`), Python 3 with numpy (`tools/cala-eval`).

**Spec:** `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md` (Notation, §4 "Extract on factors", "Checking that results are the same", Amendment 1: A1 and A6, A7). Builds on the phase 1 plan `docs/superpowers/plans/2026-11-18-cala-factor-phase1.md`.

**Precondition:** phase 1 is merged into the branch this starts from and the user has accepted its gate. This plan uses phase 1's names: `WindowFactors::{tile, tiling, layout, reconstruct}`, `TileFactors::valid`, `Tiling`, the arm `chosen`, `factor_closeness.a1_gate`, `factor_arms.line_step`, `CompressRunnerDeps`, the batch driver's compress status.

## Global Constraints

- Gate of this phase (spec, phases table): arm B against arm C agrees to float32 rounding (a Rust unit test that runs with `cargo test`, and the harness on the recordings), and arm A against arm C meets gate A1.
- Gate A1, on QC-pass cells: (1) with usable truth (raw run's median truth correlation at least 0.8 and at least 20 matched cells) the change of the truth correlation has a median of at least -0.01 and a 5th percentile of at least -0.05; (2) footprint loss at most 0.02; (3) without usable truth, trace loss (lag-1 correlation) at most 0.08; (4) footprint jump at tile lines at most 0.10 above the raw run's.
- The factor engine does no per-frame fill of missing pixels: a missing sample is the pixel's mean over the window (phase 1). Cells near the border of the field of view are reported separately; they are not left out of the gate.
- `TraceEngine::process_into` must stay bit-identical: the existing tests `signed_traces_leave_the_solve_bit_identical`, `reextraction_reproduces_the_online_pass` and `library_install_from_terms_matches_full_rebuild_at_the_same_frame` pass unchanged.
- `?compress` stays opt-in in the app.
- Rust checks, run from `crates/cala`: `cargo fmt --all --check`, `cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings`, `cargo test --no-default-features --features jsbindings`.
- App checks, run from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, and `npx prettier --check` on every file touched outside `crates`.
- Python: type hints on function signatures; `uvx ruff format` and `uvx ruff check --fix` on every Python file touched; never install into a global environment.
- The shell in this worktree refuses long compound commands (`cd ... &&` chains, loops, heredocs). Put anything complex in a script file and run it with one plain command.
- Raw data is read only. Run outputs go to a folder outside the repository. No machine paths or user names in committed files.
- Commits: one sentence, conventional prefix, no body, no co-author trailer and no tool or assistant attribution. Do not push.
- Branch: `feat/cala-factor-extract`, cut from the phase 1 branch.

## Review Focus

1. A recording with missing pixels (the motion band): the factor engine and the frame engine handle them differently, so their traces differ there. The difference must be reported by distance to the border, not averaged away. Pinned in Task 4.
2. A cell on a tile line, and on a line of each of the two offset grids: its projection must use the blending weights of every tile that covers it. Pinned in Tasks 2 and 3.
3. A library whose frame size is not the factors', and projections of the wrong length: errors, not panics (a panic traps the WASM module). Pinned in Tasks 1 and 2.
4. A library with no cells and a cell whose ring has no pixel: no division by zero, no out-of-range index. Pinned in Tasks 2 and 3.
5. A back-fill that is cut short by a reset or a new run must free its WASM objects and post nothing for the old session. Pinned in Task 5.

## File Structure

| File                                                                                                                       | Change          | Responsibility                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------- |
| `crates/cala/src/trace/solver.rs`                                                                                          | modify          | `process_projected`; `solve_frame` split into project and solve |
| `crates/cala/src/trace/tests.rs`                                                                                           | modify          | test of `process_projected`                                     |
| `crates/cala/src/compress/project.rs`                                                                                      | create          | `WindowProjector`, `FactorExtractor`                            |
| `crates/cala/src/compress/mod.rs`                                                                                          | modify          | `pub mod project;`                                              |
| `crates/cala/src/compress/js.rs`                                                                                           | modify          | `FactorExtractor` binding                                       |
| `crates/cala/examples/qc_eval.rs`                                                                                          | modify          | `--extract-engine frames                                        | factors` |
| `tools/cala-eval/factor_closeness.py`, `test_factor_closeness.py`                                                          | modify          | `trace_gap`, `engine_report`                                    |
| `tools/cala-eval/factor_arms.py`, `test_factor_arms.py`                                                                    | modify          | arm `c_chosen`, Extract times                                   |
| `apps/cala/src/lib/cala-wasm.ts`, `lib/compress-runner.ts`, `workers/compress-worker.ts`                                   | modify          | the back-fill runs on the factor engine                         |
| `apps/cala/src/__tests__/compress.test.ts`                                                                                 | modify          | tests                                                           |
| `apps/cala/scripts/batch-session.mjs`                                                                                      | modify          | back-fill time in the status file                               |
| `tools/cala-eval/results/<date>-factor-phase2.md`, `docs/CHANGELOG.md`, `apps/cala/README.md`, `tools/cala-eval/README.md` | create / modify | results and docs                                                |

---

### Task 1: The solver takes projections instead of a frame

**Files:**

- Modify: `crates/cala/src/trace/solver.rs` (`solve_frame`, at about lines 516 to 711)
- Test: `crates/cala/src/trace/tests.rs`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `TraceEngine::process_projected(&mut self, cells: &[f32], background: &[f32], out: &mut FrameTraces) -> Result<(), TraceError>`. `cells[i]` is the dot product of the frame with cell `i`'s filtered column (its support part minus the moat). `background` holds `Library::background_len()` values: for a basis model the dot product of the frame with each map, for a ring model each cell's ring mean, nothing without a background.

- [ ] **Step 1: Write the failing test**

Add to `crates/cala/src/trace/tests.rs`:

```rust
/// What `process_into` reads of a frame (full field of view), computed outside the engine.
fn projections_of(lib: &Library, frame: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let bs = lib.block_px();
    let mut blocks = vec![0.0f32; lib.grid_len()];
    if bs > 0 {
        let gw = W.div_ceil(bs);
        for (y, row) in frame.chunks(W).enumerate() {
            for (bx, seg) in row.chunks(bs).enumerate() {
                blocks[(y / bs) * gw + bx] += seg.iter().sum::<f32>();
            }
        }
    }
    let cells = (0..lib.len())
        .map(|i| {
            let (p, v) = lib.core_col(i);
            let mut s: f32 = p.iter().zip(v).map(|(&q, &a)| a * frame[q as usize]).sum();
            let (bi, li) = lib.lowpass(i);
            for (&b, &l) in bi.iter().zip(li) {
                s -= l * blocks[b as usize];
            }
            s
        })
        .collect();
    let background = match &lib.bg {
        BgTerms::Basis { k, maps, .. } => (0..*k)
            .map(|a| {
                maps[a * W * H..(a + 1) * W * H]
                    .iter()
                    .zip(frame)
                    .map(|(&g, &y)| f64::from(g) * f64::from(y))
                    .sum::<f64>() as f32
            })
            .collect(),
        BgTerms::Ring {
            ring_start,
            ring_pix,
            ..
        } => (0..lib.len())
            .map(|i| {
                let px = &ring_pix[ring_start[i]..ring_start[i + 1]];
                if px.is_empty() {
                    0.0
                } else {
                    px.iter().map(|&q| frame[q as usize]).sum::<f32>() / px.len() as f32
                }
            })
            .collect(),
        BgTerms::None => Vec::new(),
    };
    (cells, background)
}

#[test]
fn projections_solve_like_the_frame() {
    let c = traces(6, 40, 3);
    let frames = filtered_frames(&c, 0.3, 9);
    for model in [
        BackgroundModel::None,
        BackgroundModel::Basis(vec![global_map()]),
        BackgroundModel::Ring {
            inner_px: 7.0,
            outer_px: 12.0,
        },
    ] {
        let lib = Arc::new(library(&[0, 1, 2, 3, 4, 5], model, 1));
        let mut by_frame = TraceEngine::new(lib.clone(), tight()).unwrap();
        let mut by_proj = TraceEngine::new(lib.clone(), tight()).unwrap();
        by_frame.set_consolidated_ring_gradient(true);
        by_proj.set_consolidated_ring_gradient(true);
        let (mut a, mut b) = (FrameTraces::default(), FrameTraces::default());
        for (t, f) in frames.iter().enumerate() {
            by_frame.process_into(f, &mut a).unwrap();
            let (cells, background) = projections_of(&lib, f);
            assert_eq!(background.len(), lib.background_len());
            by_proj.process_projected(&cells, &background, &mut b).unwrap();
            assert_eq!((b.frame_index, b.library_version), (t as u64, 1));
            for (i, (x, y)) in a.traces.iter().zip(&b.traces).enumerate() {
                assert!(
                    (x - y).abs() <= 1e-3 * (1.0 + x.abs()),
                    "frame {t} cell {i}: {x} from the frame, {y} from its projections"
                );
            }
            assert_eq!(a.background.len(), b.background.len());
            for (x, y) in a.background.iter().zip(&b.background) {
                assert!((x - y).abs() <= 1e-3 * (1.0 + x.abs()));
            }
        }
        assert_eq!(by_proj.next_frame(), frames.len() as u64);
        // Wrong lengths are errors, not panics.
        assert!(by_proj.process_projected(&[0.0; 5], &[], &mut b).is_err());
        let bad = vec![0.0f32; lib.background_len() + 1];
        assert!(by_proj.process_projected(&[0.0; 6], &bad, &mut b).is_err());
        assert!(by_proj
            .process_projected(&[f32::NAN; 6], &bad[1..], &mut b)
            .is_err());
    }
}
```

- [ ] **Step 2: Run to see it fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings trace::tests::projections_solve`
Expected: does not compile (`process_projected` is not defined).

- [ ] **Step 3: Split `solve_frame` and add the entry point**

In `crates/cala/src/trace/solver.rs`, `solve_frame` becomes two calls; its doc comment stays:

```rust
    fn solve_frame(
        &mut self,
        lib: &Library,
        frame: &[f32],
        out: &mut FrameTraces,
        refill: bool,
    ) -> Result<(), TraceError> {
        self.project_frame(lib, frame, refill);
        self.solve_projected(lib, out)
    }
```

`project_frame` is the first half of the old body, unchanged in order and arithmetic, with three things left out (they move to `solve_projected`): the check for a non-finite `b`, the subtraction `q[a] -= x[i * k + a] * c_i` of the basis branch, and the assignment of `ring_rhs` in the ring branch.

```rust
    /// The frame's part of a solve: the moat's block sums, each cell's
    /// projection `b`, and the background's sums (`q` for a basis, before
    /// the cells' share is taken off; `ring` for a ring). `refill`: see
    /// [`Self::solve_frame`].
    fn project_frame(&mut self, lib: &Library, frame: &[f32], refill: bool) {
        // ... the old body from `let n_px = lib.dims().pixels();` down to the end of the
        // `for i in 0..n { ... self.b[i] = s; }` loop, unchanged ...
        match &lib.bg {
            BgTerms::Basis { k, maps, .. } => {
                // ... the old branch down to and including
                // `for a in 0..k { ... self.q[a] = s; }`, unchanged; without the loop over `self.c` ...
            }
            BgTerms::Ring {
                ring_start,
                ring_pix,
                ..
            } => {
                for i in 0..n {
                    if skip(i) {
                        continue;
                    }
                    let px = &ring_pix[ring_start[i]..ring_start[i + 1]];
                    let mut sum = 0.0f32;
                    for &q in px {
                        sum += frame[q as usize];
                    }
                    self.ring[i] = if px.is_empty() {
                        0.0
                    } else {
                        sum / px.len() as f32
                    };
                }
            }
            BgTerms::None => {}
        }
    }
```

`solve_projected` is the rest:

```rust
    /// Solve from `b` and the background's sums as [`Self::project_frame`]
    /// or [`Self::process_projected`] left them, and fill `out`.
    fn solve_projected(&mut self, lib: &Library, out: &mut FrameTraces) -> Result<(), TraceError> {
        let n = lib.len();
        if let Some(i) = self.b.iter().position(|v| !v.is_finite()) {
            return Err(TraceError::InvalidConfig(format!(
                "frame {} has non-finite pixels under cell {}",
                self.next_frame,
                lib.ids()[i]
            )));
        }
        match &lib.bg {
            BgTerms::Basis { k, x, .. } => {
                let k = *k;
                for (i, &ci) in self.c.iter().enumerate() {
                    if ci != 0.0 {
                        for a in 0..k {
                            self.q[a] -= f64::from(x[i * k + a]) * f64::from(ci);
                        }
                    }
                }
            }
            BgTerms::Ring { s, .. } => {
                if self.consolidated_ring_grad {
                    // For a cell a refill skipped, `b` and `ring` are unchanged, so this
                    // writes the value it already has.
                    for i in 0..n {
                        self.ring_rhs[i] = self.b[i] - s[i] * self.ring[i];
                    }
                }
            }
            BgTerms::None => {}
        }
        // ... the old body from `let sweeps = self.solve(lib);` to the final `Ok(())`, unchanged ...
    }
```

Add below `process_into`:

```rust
    /// Solve one frame from its projections instead of its pixels.
    ///
    /// `cells[i]` is the dot product of the frame with cell `i`'s filtered
    /// column (the support part minus the moat). `background` holds
    /// [`Library::background_len`] values: for a basis model the dot product
    /// of the frame with each map, for a ring model each cell's ring mean,
    /// nothing without a background. The solve, the warm start and the
    /// output are those of [`Self::process_into`]; missing pixels are the
    /// caller's matter (there is no fill here).
    pub fn process_projected(
        &mut self,
        cells: &[f32],
        background: &[f32],
        out: &mut FrameTraces,
    ) -> Result<(), TraceError> {
        let lib = self.lib.clone();
        let lib = &*lib;
        check_len("cell projections", lib.len(), cells.len())?;
        check_len("background projections", lib.background_len(), background.len())?;
        self.b.copy_from_slice(cells);
        match &lib.bg {
            BgTerms::Basis { .. } => {
                for (q, &v) in self.q.iter_mut().zip(background) {
                    *q = f64::from(v);
                }
            }
            BgTerms::Ring { .. } => self.ring.copy_from_slice(background),
            BgTerms::None => {}
        }
        let r = self.solve_projected(lib, out);
        self.next_frame += 1;
        r
    }
```

If `self.b`, `self.q` or `self.ring` are not sized `lib.len()`, `k` and `lib.len()` by `install` for the model at hand, size them in `install` (not here) and say so in your report.

- [ ] **Step 4: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings trace::`
Expected: all pass, the new test and, unchanged, `signed_traces_leave_the_solve_bit_identical`, `reextraction_reproduces_the_online_pass`, `missing_pixels_get_zero_weight` and `consolidated_ring_gradient_matches_two_walk_solver`. If one of the bit-identity tests fails, the split changed an order of operations: fix the split, never the test.

- [ ] **Step 5: Check and commit**

Run `cargo fmt --all` and the clippy command. Then:

```bash
git add crates/cala/src/trace
git commit -m "feat(cala): the trace solver can take a frame's projections instead of its pixels"
```

---

### Task 2: Project the solver's functionals onto a window's factors

**Files:**

- Create: `crates/cala/src/compress/project.rs`
- Modify: `crates/cala/src/compress/mod.rs` (add `pub mod project;` beside `pub mod blend;`)

**Interfaces:**

- Consumes: `WindowFactors::{dims, tiles, layout}`, `TileFactors::{x0, y0, w, h, rank, spatial, temporal, mean, valid}`, `BlendLayout::weights` (phase 1); `Library::{dims, len, core_col, lowpass, block_px, block_of, grid_len, fov, background_len, bg}` and `BgTerms` (crate-visible).
- Produces:
  - `WindowProjector::new(lib: &Library, wf: &WindowFactors) -> Result<WindowProjector, TraceError>`
  - `WindowProjector::project(&self, wf: &WindowFactors, t: usize, out: &mut [f32])`: `out` holds `functionals()` values, the cells' projections first, then the background's, in the order `TraceEngine::process_projected` takes them.
  - `WindowProjector::cells(&self) -> usize`, `background(&self) -> usize`, `functionals(&self) -> usize`, `frames(&self) -> usize`
  - `WindowProjector::min_valid(&self) -> &[f32]`: per cell, the smallest valid share of a pixel of its support in this window.

- [ ] **Step 1: Write the failing tests**

Create `crates/cala/src/compress/project.rs` with only the module doc, the imports and this test module (the implementation follows in Step 3):

```rust
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
            .build(&mut crate::trace::IdentityFilter(Dims::new(64, 56).unwrap()))
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
```

The tolerance `1e-4 * s + 1e-3` is float32 rounding of sums of a few hundred terms of total size `s`. If a functional misses it, report the numbers; do not widen it.

- [ ] **Step 2: Run to see them fail**

Add `pub mod project;` to `crates/cala/src/compress/mod.rs`. Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::project`
Expected: does not compile (`WindowProjector` is not defined).

- [ ] **Step 3: Implement**

The top of `crates/cala/src/compress/project.rs`:

````rust
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
                        add_scaled(&mut row, &mut c0, -l, &blk_rows[s * r..(s + 1) * r], blk_mean[s]);
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
            tiles.push(TileRows { rank: r, funcs, rows });
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
````

The test module gets `Library`, `BgTerms` and `WindowFactors` through `use super::*`.

- [ ] **Step 4: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::project`
Expected: the three tests pass.

- [ ] **Step 5: Check and commit**

Run `cargo fmt --all` and the clippy command. Then:

```bash
git add crates/cala/src/compress
git commit -m "feat(cala): the solver's functionals of a frame from a window's factors (WindowProjector)"
```

---

### Task 3: FactorExtractor, and arm B against arm C

**Files:**

- Modify: `crates/cala/src/compress/project.rs`

**Interfaces:**

- Consumes: `TraceEngine::process_projected` (Task 1), `WindowProjector` (Task 2).
- Produces:
  - `FactorExtractor::new(lib: Arc<Library>, cfg: SolverConfig) -> Result<FactorExtractor, TraceError>`
  - `FactorExtractor::engine_mut(&mut self) -> &mut TraceEngine` (for settings such as `set_consolidated_ring_gradient`)
  - `FactorExtractor::library(&self) -> &Arc<Library>`
  - `FactorExtractor::set_library(&mut self, lib: Arc<Library>) -> Result<(), TraceError>`
  - `FactorExtractor::solve(&mut self, wf: &WindowFactors, proj: &WindowProjector, t0: usize, count: usize, sink: impl FnMut(&FrameTraces)) -> Result<(), TraceError>`

- [ ] **Step 1: Write the failing test**

Add to the test module of `project.rs`:

```rust
    fn tight() -> SolverConfig {
        SolverConfig {
            tol: 1e-4,
            max_sweeps: 20_000,
            relax: 1.5,
        }
    }

    #[test]
    fn traces_from_the_factors_equal_traces_from_the_rebuilt_frames() {
        // Arm C (the factor engine) against arm B (the frame engine on frames
        // rebuilt from the same factors): float32 rounding apart.
        for tiling in [Tiling::Plain, Tiling::Offset] {
            let wf = window(tiling, 120, None);
            for model in models() {
                let lib = Arc::new(library(model, CENTRES.len()));
                let mut by_frame = TraceEngine::new(lib.clone(), tight()).unwrap();
                by_frame.set_consolidated_ring_gradient(true);
                let mut ex = FactorExtractor::new(lib.clone(), tight()).unwrap();
                ex.engine_mut().set_consolidated_ring_gradient(true);
                let proj = WindowProjector::new(&lib, &wf).unwrap();
                let mut c: Vec<Vec<f32>> = Vec::new();
                // In two calls, as the app solves a window in batches.
                ex.solve(&wf, &proj, 0, 50, |tr| c.push(tr.traces.clone())).unwrap();
                ex.solve(&wf, &proj, 50, 70, |tr| c.push(tr.traces.clone())).unwrap();
                assert_eq!(c.len(), 120);
                let mut frame = vec![0.0f32; W * H];
                let mut out = FrameTraces::default();
                for (t, ct) in c.iter().enumerate() {
                    wf.reconstruct(t, &mut frame);
                    by_frame.process_into(&frame, &mut out).unwrap();
                    for (i, (a, b)) in out.traces.iter().zip(ct).enumerate() {
                        assert!(
                            (a - b).abs() <= 1e-3 * (1.0 + a.abs()),
                            "{tiling:?} frame {t} cell {i}: {a} from frames, {b} from factors"
                        );
                    }
                }
                assert!(ex.solve(&wf, &proj, 100, 21, |_| {}).is_err(), "beyond the window");
            }
        }
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
        ex.solve(&wf, &proj, 0, 2, |tr| n += tr.traces.len()).unwrap();
        assert_eq!(n, 6);
    }
```

- [ ] **Step 2: Run to see them fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::project`
Expected: does not compile (`FactorExtractor` is not defined).

- [ ] **Step 3: Implement**

Extend the imports at the top of `project.rs` to

```rust
use std::sync::Arc;

use super::WindowFactors;
use crate::trace::{BgTerms, FrameTraces, Library, SolverConfig, TraceEngine, TraceError};
```

(the test module gets them through `use super::*`), and append above the test module:

```rust
/// Extract on factors: solves a library's traces frame by frame from the
/// factors of a window, without rebuilding a frame.
pub struct FactorExtractor {
    engine: TraceEngine,
    /// One frame's functionals: the cells', then the background's.
    vals: Vec<f32>,
    out: FrameTraces,
}

impl FactorExtractor {
    pub fn new(lib: Arc<Library>, cfg: SolverConfig) -> Result<FactorExtractor, TraceError> {
        let n = lib.len() + lib.background_len();
        Ok(FactorExtractor {
            engine: TraceEngine::new(lib, cfg)?,
            vals: vec![0.0; n],
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
    pub fn set_library(&mut self, lib: Arc<Library>) -> Result<(), TraceError> {
        let n = lib.len() + lib.background_len();
        self.engine.set_library(lib)?;
        self.vals.resize(n, 0.0);
        Ok(())
    }

    /// Solve frames `t0..t0 + count` of `wf` with the rows of `proj` (built
    /// for this library and this window); `sink` gets each frame's result.
    pub fn solve(
        &mut self,
        wf: &WindowFactors,
        proj: &WindowProjector,
        t0: usize,
        count: usize,
        mut sink: impl FnMut(&FrameTraces),
    ) -> Result<(), TraceError> {
        let n = self.engine.library().len();
        if proj.cells() != n || proj.functionals() != self.vals.len() {
            return Err(TraceError::InvalidConfig(format!(
                "projector of {} cells and {} functionals, library of {n} and {}",
                proj.cells(),
                proj.functionals(),
                self.vals.len()
            )));
        }
        if t0 + count > wf.frames || proj.frames() != wf.frames {
            return Err(TraceError::InvalidConfig(format!(
                "frames {t0}..{} of a window of {}",
                t0 + count,
                wf.frames
            )));
        }
        for t in t0..t0 + count {
            proj.project(wf, t, &mut self.vals);
            let (cells, background) = self.vals.split_at(n);
            self.engine.process_projected(cells, background, &mut self.out)?;
            sink(&self.out);
        }
        Ok(())
    }
}
```

- [ ] **Step 4: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::project`
Expected: all five tests of the module pass. The first of this task is the phase's "B against C to float32 rounding" check; it runs with every `cargo test`. If it fails for one tiling or model only, report which and the largest difference: do not widen the tolerance.

- [ ] **Step 5: Check and commit**

Run `cargo fmt --all`, the clippy command and the whole test suite. Then:

```bash
git add crates/cala/src/compress/project.rs
git commit -m "feat(cala): Extract on factors (FactorExtractor), equal to the solve on rebuilt frames to rounding"
```

---

### Task 4: Arm C in the harness

**Files:**

- Modify: `crates/cala/examples/qc_eval.rs` (flag docs, flag parsing near `--extract-pass`, the Extract block at about line 4626, the tests)
- Modify: `tools/cala-eval/factor_closeness.py`, `tools/cala-eval/test_factor_closeness.py`
- Modify: `tools/cala-eval/factor_arms.py`, `tools/cala-eval/test_factor_arms.py`

**Interfaces:**

- Consumes: `FactorExtractor`, `WindowProjector` (Tasks 2, 3); `FactorDump`, `FactorReplay::new(dir, dims)`, `factor_config`, the arm `chosen`, `line_step`, `a1_gate` (phases 0 and 1).
- Produces:
  - `qc_eval --extract-engine frames|factors` (default `frames`). With `factors`, the Extract pass solves from the factor files of `--factors-out` with the factor engine; it needs `--extract-pass` and `--replay-source factors`. Output files are unchanged (`extract_trace.f32`, `extract_ids.tsv`, an `extract` row in `stage_times.tsv` whose `pre_s` is the time to build the projectors).
  - `factor_closeness.trace_gap(ta: dict[int, np.ndarray], tb: dict[int, np.ndarray]) -> dict[int, float]`
  - `factor_closeness.engine_report(ref: Path, test: Path, band: float = 16.0) -> str`
  - `factor_arms.arms(...)["c_chosen"]`; `factor_arms.extract_row(run: Path) -> tuple[str, float, float, float] | None`

- [ ] **Step 1: Write the failing tests**

In the `tests` module of `crates/cala/examples/qc_eval.rs` (import what is missing from `calab_cala::trace`: `Footprint`, `IdentityFilter`, `LibraryBuilder`):

```rust
    #[test]
    fn extract_from_factors_matches_the_replayed_frames() {
        let dims = Dims::new(96, 70).unwrap();
        // One full window and a short last one.
        let frames = slow_stream(dims, FACTOR_WINDOW + 50);
        let dir = std::env::temp_dir().join(format!("qc_eval_extract_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut fd = FactorDump::new(&dir, dims, Tiling::Offset, factor_config(&[]));
        for f in &frames {
            fd.push(f);
        }
        fd.finish();
        let mut b = LibraryBuilder::new(dims);
        for (id, (y0, x0)) in [(10usize, 12usize), (40, 58)].into_iter().enumerate() {
            b.push(Footprint {
                id: id as u64,
                y0,
                x0,
                height: 9,
                width: 9,
                values: vec![1.0; 81],
            });
        }
        let lib = Arc::new(b.build(&mut IdentityFilter(dims)).unwrap());
        let tight = SolverConfig {
            tol: 1e-4,
            max_sweeps: 20_000,
            relax: 1.5,
        };
        let mut got: Vec<f32> = Vec::new();
        let (read_s, pre_s, solve_s) =
            extract_from_factors(&dir, &lib, tight, frames.len(), |tr| got.extend_from_slice(tr));
        assert!(read_s >= 0.0 && pre_s >= 0.0 && solve_s >= 0.0);
        assert_eq!(got.len(), frames.len() * 2);
        let mut eng = TraceEngine::new(lib.clone(), tight).unwrap();
        eng.set_consolidated_ring_gradient(true);
        let mut fr = FactorReplay::new(&dir, dims);
        let mut tr = FrameTraces::default();
        let mut y = vec![0.0f32; dims.pixels()];
        for t in 0..frames.len() {
            fr.frame(t, &mut y);
            eng.process_into(&y, &mut tr).unwrap();
            for (i, a) in tr.traces.iter().enumerate() {
                let b = got[t * 2 + i];
                assert!(
                    (a - b).abs() <= 1e-3 * (1.0 + a.abs()),
                    "frame {t} cell {i}: {a} from frames, {b} from factors"
                );
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
```

In `tools/cala-eval/test_factor_closeness.py` (alias `FC` as in the file; `math` and `numpy as np` imported):

```python
class TraceGap(unittest.TestCase):
    def test_gap_is_the_largest_difference_in_units_of_the_first_traces_sd(self) -> None:
        a = np.array([0.0, 2.0, 0.0, 2.0], dtype=np.float32)  # sd 1
        bump = np.array([0.0, 0.5, 0.0, 0.0], dtype=np.float32)
        flat = np.zeros(4, dtype=np.float32)
        gap = FC.trace_gap({1: a, 2: a, 3: flat, 5: a}, {1: a + bump, 2: a, 3: flat + 1, 4: a})
        self.assertAlmostEqual(gap[1], 0.5)
        self.assertEqual(gap[2], 0.0)
        self.assertTrue(math.isnan(gap[3]), "a constant first trace has no sd")
        self.assertEqual(sorted(gap), [1, 2, 3], "only cells of both runs")

    def test_traces_of_different_length_compare_over_the_common_part(self) -> None:
        a = np.array([0.0, 2.0, 0.0, 2.0, 9.0], dtype=np.float32)
        gap = FC.trace_gap({1: a[:4]}, {1: a})
        self.assertEqual(gap[1], 0.0)
```

In `tools/cala-eval/test_factor_arms.py`, class `Arms` (add `"c_chosen"` to the expected list of `test_arm_names`):

```python
    def test_the_factor_engine_arm_differs_from_chosen_only_in_the_extract_engine(self) -> None:
        a = A.arms(5)
        self.assertEqual(a["c_chosen"], a["chosen"] + ["--extract-engine", "factors"])
        self.assertEqual(A.line_step("c_chosen"), 32)
        self.assertIn("c_chosen", A.default_arms(a))

    def test_extract_row_reads_the_extract_stage(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "c_chosen"
            run.mkdir()
            (run / "stage_times.tsv").write_text(
                "stage\tread_s\tpre_s\tcompress_s\tsolve_s\tslow_s\twall_s\n"
                "pass1\t1.00\t2.00\t0.00\t3.00\t4.00\t11.00\n"
                "extract\t0.10\t0.20\t0.00\t0.70\t0.00\t1.10\n"
            )
            self.assertEqual(A.extract_row(run), ("c_chosen", 0.2, 0.7, 1.1))
            self.assertIsNone(A.extract_row(Path(d) / "missing"))
```

- [ ] **Step 2: Run to see them fail**

From `crates/cala`: `cargo test --no-default-features --features jsbindings --example qc_eval` (does not compile: `extract_from_factors`). From the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval` (errors: `trace_gap`, `extract_row`, the arm `c_chosen`).

- [ ] **Step 3: Implement in `qc_eval.rs`**

Add `use calab_cala::compress::project::{FactorExtractor, WindowProjector};`. In the flag docs, after `--extract-pass`:

```rust
//!   --extract-engine E  with `--extract-pass`: frames (default; solve each
//!                      replayed frame) | factors (the factor engine on the
//!                      files of `--factors-out`, no frame is read or
//!                      rebuilt; needs `--replay-source factors`)
```

After the line that parses `extract_pass`:

```rust
    let extract_factors = match arg_value(&args, "--extract-engine").as_deref() {
        None | Some("frames") => false,
        Some("factors") => true,
        Some(o) => panic!("--extract-engine: frames or factors, not {o:?}"),
    };
    assert!(
        !extract_factors || (extract_pass && replay_factors),
        "--extract-engine factors needs --extract-pass and --replay-source factors"
    );
```

Below `FactorReplay`:

```rust
/// `--extract-engine factors`: solve every frame of the recording from the
/// factor files in `dir` (a [`FactorDump`]'s) with the factor engine; `sink`
/// gets each frame's traces. Returns the seconds spent reading the files,
/// building the projectors and solving.
fn extract_from_factors(
    dir: &Path,
    lib: &Arc<Library>,
    cfg: SolverConfig,
    t_len: usize,
    mut sink: impl FnMut(&[f32]),
) -> (f64, f64, f64) {
    let mut ex = FactorExtractor::new(lib.clone(), cfg).unwrap();
    ex.engine_mut().set_consolidated_ring_gradient(true);
    let (mut read_s, mut pre_s, mut solve_s) = (0.0f64, 0.0f64, 0.0f64);
    let mut start = 0usize;
    while start < t_len {
        let path = dir.join(format!("w{start:07}.fac"));
        let t0 = Instant::now();
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        let wf = WindowFactors::from_bytes(&bytes)
            .unwrap_or_else(|| panic!("{path:?}: not a factor file"));
        read_s += t0.elapsed().as_secs_f64();
        assert!(wf.frames > 0, "{path:?}: an empty window");
        let t0 = Instant::now();
        let proj = WindowProjector::new(lib, &wf).unwrap();
        pre_s += t0.elapsed().as_secs_f64();
        let t0 = Instant::now();
        ex.solve(&wf, &proj, 0, wf.frames, |tr| sink(&tr.traces))
            .unwrap();
        solve_s += t0.elapsed().as_secs_f64();
        start += wf.frames;
    }
    (read_s, pre_s, solve_s)
}
```

In the Extract block, wrap the existing `while s < frames { ... }` loop:

```rust
        if extract_factors {
            let dir = factors_out
                .as_deref()
                .expect("--extract-engine factors needs --factors-out");
            (read_s, pre_s, solve_s) =
                extract_from_factors(dir, &lib, SolverConfig::default(), t_len, |tr| {
                    write_f32s(&mut out, tr);
                });
        } else {
            // ... the existing loop, unchanged ...
        }
```

and in the `println!` of the block replace the source expression by

```rust
            if extract_factors {
                "factor engine"
            } else if replay.is_some() {
                "factors"
            } else {
                "raw"
            }
```

If `lib` is not an `Arc<Library>` at that point or `factors_out` is out of scope there, adapt the two names and say so in your report; do not change what the block writes.

- [ ] **Step 4: Implement the Python side**

`tools/cala-eval/factor_closeness.py`, below `a1_passes`:

```python
def trace_gap(ta: dict[int, np.ndarray], tb: dict[int, np.ndarray]) -> dict[int, float]:
    """Per cell of both runs: the largest absolute difference of its two traces, over the
    standard deviation of the first (NaN when the first trace is constant)."""
    out: dict[int, float] = {}
    for cid in sorted(set(ta) & set(tb)):
        n = min(len(ta[cid]), len(tb[cid]))
        a = ta[cid][:n].astype(np.float64)
        b = tb[cid][:n].astype(np.float64)
        sd = float(np.std(a)) if n else 0.0
        out[cid] = float(np.max(np.abs(a - b))) / sd if sd > 0 else NAN
    return out


def engine_report(ref: Path, test: Path, band: float = 16.0) -> str:
    """Markdown: the traces of the factor engine (`test`) against those of the frame engine
    on frames rebuilt from the same factors (`ref`), by the cell's distance to the border.

    The two engines differ where pixels are missing: the frame engine fills them per frame,
    the factors hold the pixel's mean over the window. That is the border band.
    """
    (h, w), _ = read_footprints(ref / "footprints.bin")
    same = (ref / "footprints.bin").read_bytes() == (test / "footprints.bin").read_bytes()
    gap = trace_gap(read_traces(ref), read_traces(test))
    cen = read_centroids(ref)

    def border(cid: int) -> float:
        cy, cx = cen.get(cid, (NAN, NAN))
        return NAN if math.isnan(cy) else min(cy, cx, h - 1 - cy, w - 1 - cx)

    sets = [
        ("all cells", list(gap)),
        (f"{band:g} px or more from the border", [c for c in gap if border(c) >= band]),
        (f"under {band:g} px from the border", [c for c in gap if border(c) < band]),
    ]
    out = [
        f"### `{test.name}` against `{ref.name}`: factor engine against rebuilt frames",
        "",
        f"The two runs have the same footprints: {'yes' if same else 'no'}.",
        "",
        "| cells | n | largest trace difference over the trace's sd, median | largest |",
        "| --- | --- | --- | --- |",
    ]
    for name, ids in sets:
        v = np.asarray([gap[c] for c in ids], dtype=np.float64)
        v = v[np.isfinite(v)]
        top = f"{v.max():.4f}" if len(v) else "n/a"
        out.append(f"| {name} | {len(v)} | {q(v, 50)} | {top} |")
    return "\n".join(out + [""])
```

`tools/cala-eval/factor_arms.py`: in `arms`, after `out["chosen"]`:

```python
    out["c_chosen"] = out["chosen"] + ["--extract-engine", "factors"]
```

`line_step`: add `"c_chosen"` to the names that give 32. Below `cost_row`:

```python
def extract_row(run: Path) -> tuple[str, float, float, float] | None:
    """(arm, seconds preparing, seconds solving, wall seconds) of the Extract pass."""
    path = run / "stage_times.tsv"
    if not path.exists():
        return None
    for r in factor_closeness.read_tsv(path):
        if r["stage"] == "extract":
            return (run.name, float(r["pre_s"]), float(r["solve_s"]), float(r["wall_s"]))
    return None
```

In `report`: treat `c_chosen` like `chosen` in the comparison with `raw` (arm A against arm C, with gate A1), and after the loop over the arms add

```python
    if "chosen" in have and "c_chosen" in have:
        text.append(
            factor_closeness.engine_report(out_dir / "chosen", out_dir / "c_chosen")
        )
    rows = [r for r in (extract_row(out_dir / n) for n in have) if r]
    if rows:
        text += [
            "| arm | Extract: preparing s | solving s | wall s |",
            "| --- | --- | --- | --- |",
        ]
        text += [f"| {a} | {p:.2f} | {s:.2f} | {w:.2f} |" for a, p, s, w in rows]
        text.append("")
```

Add `c_chosen` to the module docstring: "`c_chosen`: as `chosen`, with the Extract pass solved by the factor engine (arm C)".

- [ ] **Step 5: Run the tests**

From `crates/cala`: `cargo test --no-default-features --features jsbindings`. From the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`. Expected: all pass.

- [ ] **Step 6: Format, check and commit**

`cargo fmt --all`, the clippy command, `uvx ruff format` and `uvx ruff check --fix` on the four Python files.

```bash
git add crates/cala/examples/qc_eval.rs tools/cala-eval
git commit -m "feat(cala-eval): Extract on factors as arm C of the harness, with its report against arms A and B"
```

---

### Task 5: The app's back-fill runs on the factor engine

**Files:**

- Modify: `crates/cala/src/compress/js.rs`
- Modify: `apps/cala/src/lib/cala-wasm.ts`, `apps/cala/src/lib/compress-runner.ts`, `apps/cala/src/workers/compress-worker.ts`
- Modify: `apps/cala/scripts/batch-session.mjs`
- Test: `apps/cala/src/__tests__/compress.test.ts`

**Interfaces:**

- Consumes: `FactorExtractor`, `WindowProjector` (Tasks 2, 3).
- Produces (WASM, re-exported by `cala-wasm.ts`): class `FactorExtractor`: `new FactorExtractor(library: Uint8Array, tol: number, maxSweeps: number)`, `ids(): Uint32Array`, `open(bytes: Uint8Array): number` (the window's frames), `start: number` (stream index of the open window's first frame), `solve(t0: number, count: number): Float32Array` (`count x cells`), `free()`.
- Produces (TypeScript): `interface FactorExtractLike` in `compress-runner.ts`; `CompressRunnerDeps.extract?(library: Uint8Array): FactorExtractLike` replaces `engine?` and `factors?`; `BackfillEngineLike` and `FactorWindowLike` are removed. The messages to the main thread are unchanged.

- [ ] **Step 1: Write the failing tests**

In `apps/cala/src/__tests__/compress.test.ts`: import `FactorExtractor` from `cala-wasm.ts`; in `runner()`, replace the dependencies `engine` and `factors` by

```ts
    extract: (bytes) => new FactorExtractor(bytes, 0, 0),
```

Add to `describe('back-fill from the factors', ...)`:

```ts
it('gives the traces of the frame engine on the rebuilt frames', async () => {
  const lib = cellLibrary();
  const { feed, sent } = collectingFeed(50);
  for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
  feed.library(lib.version, lib.bytes);
  feed.end();
  const { r, store, toMain } = runner();
  for (const m of sent) await r.handle(m);
  r.backfill(7, lib.version);
  await r.idle();
  const windows = toMain.filter((m) => m.type === 'traces');
  expect(windows.length).toBe(2);

  const library = TraceLibrary.fromBytes(lib.bytes);
  const engine = new TraceEngine(library, 0, 0);
  const frames = new Float32Array(50 * PX);
  try {
    for (const [k, m] of windows.entries()) {
      const win = FactorWindow.fromBytes(store.files.get(factorName(k))!);
      try {
        win.reconstruct(0, 50, frames);
      } finally {
        win.free();
      }
      const want = engine.processFrames(frames, 50);
      expect(m.traces.length).toBe(want.length);
      let worst = 0;
      for (let i = 0; i < want.length; i++) {
        worst = Math.max(worst, Math.abs(m.traces[i] - want[i]));
      }
      // Both solves stop at the default tolerance (0.05 of the trace noise);
      // the tight comparison is the Rust test of `FactorExtractor`.
      expect(worst, `window ${k}`).toBeLessThan(0.1);
    }
  } finally {
    engine.free();
    library.free();
  }
});

it('frees the factor engine and posts nothing more when a reset cuts it short', async () => {
  const lib = cellLibrary();
  const { feed, sent } = collectingFeed(50);
  for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
  feed.library(lib.version, lib.bytes);
  feed.end();
  const toMain: CompressToMain[] = [];
  let freed = 0;
  let solving = false;
  let cut: Promise<void> | null = null;
  const r: CompressRunner = new CompressRunner({
    store: memoryStore(),
    quantize: quantizeTiles,
    create: (quant) => new TileCompressor(quant),
    layout: tileLayout,
    header: factorHeader,
    extract: (bytes) => {
      const inner = new FactorExtractor(bytes, 0, 0);
      return {
        ids: () => inner.ids(),
        open: (file) => inner.open(file),
        get start() {
          return inner.start;
        },
        solve: (t0, n) => {
          solving = true;
          return inner.solve(t0, n);
        },
        free: () => {
          freed++;
          inner.free();
        },
      };
    },
    toMain: { postMessage: (m) => toMain.push(m) },
    // At the first yield after a solve, a reset arrives.
    yieldNow: async () => {
      if (solving && !cut) cut = r.handle({ type: 'reset', session: 7 });
    },
  });
  for (const m of sent) await r.handle(m);
  r.backfill(7, lib.version);
  await r.idle();
  await cut;
  expect(freed).toBe(1);
  expect(toMain.some((m) => m.type === 'traces' || m.type === 'backfilled')).toBe(false);
});
```

- [ ] **Step 2: Run to see them fail**

Run inside `apps/cala`: `npx vitest run src/__tests__/compress.test.ts`
Expected: the file does not load (`FactorExtractor` is not exported).

- [ ] **Step 3: Implement the binding in `crates/cala/src/compress/js.rs`**

Imports: `use std::sync::Arc;`, `use super::project::{FactorExtractor, WindowProjector};`, and `SolverConfig` from `crate::trace`. Below `JsFactorWindow`:

```rust
/// Extract on factors: a library's traces from factor files, without
/// rebuilding a frame.
#[wasm_bindgen(js_name = FactorExtractor)]
pub struct JsFactorExtractor {
    inner: FactorExtractor,
    ids: Vec<u32>,
    /// The open window and the library's rows on it.
    window: Option<(WindowFactors, WindowProjector)>,
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
        let inner = FactorExtractor::new(Arc::new(lib), cfg)
            .map_err(|e| js_err("FactorExtractor", e))?;
        Ok(JsFactorExtractor {
            inner,
            ids,
            window: None,
        })
    }

    /// Cell ids in trace order.
    pub fn ids(&self) -> Vec<u32> {
        self.ids.clone()
    }

    /// Read a factor file and prepare its solve; returns the window's frames.
    pub fn open(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
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

    /// Solve frames `t0..t0 + count` of the open window; returns
    /// `count x cells` traces, frame after frame, in the library's id order.
    pub fn solve(&mut self, t0: u32, count: u32) -> Result<Vec<f32>, JsError> {
        let Some((wf, proj)) = self.window.as_ref() else {
            return Err(js_err("FactorExtractor.solve", "no window is open"));
        };
        let mut out = Vec::with_capacity(count as usize * self.ids.len());
        self.inner
            .solve(wf, proj, t0 as usize, count as usize, |tr| {
                out.extend_from_slice(&tr.traces);
            })
            .map_err(|e| js_err("FactorExtractor.solve", e))?;
        Ok(out)
    }
}
```

- [ ] **Step 4: Implement the TypeScript side**

`apps/cala/src/lib/cala-wasm.ts`: import and re-export `FactorExtractor`.

`apps/cala/src/lib/compress-runner.ts`: replace the interfaces `BackfillEngineLike` and `FactorWindowLike` by

```ts
/** The factor engine for one library: solves a compressed window from its file, without rebuilding frames. */
export interface FactorExtractLike {
  ids(): Uint32Array;
  /** Read a factor file and prepare its solve; returns the window's frames. */
  open(file: Uint8Array): number;
  /** Stream index of the open window's first frame. */
  readonly start: number;
  /** `count x cells` traces of frames `t0..t0 + count` of the open window. */
  solve(t0: number, count: number): Float32Array;
  free(): void;
}

/** Frames solved between two yields of the back-fill. */
const BACKFILL_BATCH = 64;
```

In `CompressRunnerDeps` replace `engine?` and `factors?` by

```ts
  /** For the back-fill (absent: `backfill` does nothing). */
  extract?(library: Uint8Array): FactorExtractLike;
```

`maybeBackfill`:

```ts
  private maybeBackfill(): void {
    const lib = this.library;
    const { extract } = this.deps;
    if (this.loop || this.wanted === null || !lib || lib.version < this.wanted) return;
    if (this.open || this.pending.length > 0 || !extract) return;
    this.wanted = null;
    this.launch(this.runBackfill(lib, extract));
  }
```

`runBackfill`:

```ts
  private async runBackfill(
    lib: { version: number; bytes: Uint8Array },
    makeExtractor: (library: Uint8Array) => FactorExtractLike,
  ): Promise<void> {
    if (!this.init) return;
    const epoch = this.epoch;
    const session = this.session;
    const t0 = this.now();
    const extractor = makeExtractor(lib.bytes);
    try {
      const ids = extractor.ids();
      if (ids.length === 0) return;
      let frames = 0;
      let first = true;
      for (const index of [...this.done]) {
        const file = await this.deps.store.open(factorName(index));
        const bytes = new Uint8Array(file.size());
        file.read(bytes, 0);
        file.close();
        if (epoch !== this.epoch) return;
        const count = extractor.open(bytes);
        const start = extractor.start;
        const traces = new Float32Array(count * ids.length);
        for (let t = 0; t < count; t += BACKFILL_BATCH) {
          const n = Math.min(BACKFILL_BATCH, count - t);
          traces.set(extractor.solve(t, n), t * ids.length);
          await this.yieldNow();
          if (epoch !== this.epoch) return;
        }
        const cellIds = ids.slice();
        this.deps.toMain.postMessage(
          { type: 'traces', session, version: lib.version, first, start, count, ids: cellIds, traces },
          [cellIds.buffer as ArrayBuffer, traces.buffer as ArrayBuffer],
        );
        first = false;
        frames += count;
      }
      this.deps.toMain.postMessage({
        type: 'backfilled',
        session,
        version: lib.version,
        frames,
        msPerFrame: (this.now() - t0) / Math.max(1, frames),
      });
    } finally {
      extractor.free();
    }
  }
```

In the file's header comment, replace the back-fill paragraph by: "Back-fill (`backfill`): once no window is waiting and the requested library has arrived, the factor engine (`FactorExtractor`) solves every window from its factor file with that library, without rebuilding a frame, and the traces of each window go to the main thread."

`apps/cala/src/workers/compress-worker.ts`: replace the `engine` and `factors` dependencies by `extract: (bytes) => new FactorExtractor(bytes, 0, 0),` and drop the imports that are no longer used there.

`apps/cala/scripts/batch-session.mjs`: add to the page snapshot `backfill: c.compress?.backfill?.() ?? null,`. Where the poll loop leaves Discover for the next stage, and the query has `compress`: wait for that step until `s.backfill` is not null (give up after 10 minutes and log it), then store `status.stages.discover.backfill = s.backfill`. (Extract's replay clears the windows, so a back-fill that has not finished would be cut short.)

- [ ] **Step 5: Build the WASM package and run the tests**

Run from the repository root: `npm run build:wasm`. Then inside `apps/cala`: `npx vitest run src/__tests__/compress.test.ts`
Expected: all pass, including the unchanged `solves the traces of every window with the library it is given`.

- [ ] **Step 6: Check and commit**

Run from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, `npx prettier --check apps/cala`; from `crates/cala`: the clippy command and `cargo test --no-default-features --features jsbindings`.

```bash
git add crates/cala apps/cala
git commit -m "feat(cala): the compress worker's back-fill solves from the factors without rebuilding frames"
```

---

### Task 6: Measure arm C and write the report

The controller starts the runs (they need the recordings and take about two hours); a subagent writes the report from their outputs.

**Files:**

- Create: `tools/cala-eval/results/<date of the runs>-factor-phase2.md`
- Modify: `docs/CHANGELOG.md`, `tools/cala-eval/README.md`, `apps/cala/README.md` (the compression section)

**Interfaces:**

- Consumes: the arms `raw`, `null_lo`, `null_hi`, `chosen`, `c_chosen` and their report (Task 4); the batch driver's back-fill record (Task 5).
- Produces: the report with the phase's two gate results. The decision to start phase 3 is the user's.

- [ ] **Step 1: Run the native arms**

Build from `crates/cala`: `cargo build --release --example qc_eval`. Recordings and scale as in phase 1's gate run (its report's "How it was measured"), into a new output folder. Arms: `raw,null_lo,null_hi,chosen,c_chosen` at 200 px, `raw,null_lo,chosen,c_chosen` at 600 px. Check that every arm ended with return code 0 and that each recording's `report.md` says the two runs `chosen` and `c_chosen` have the same footprints.

- [ ] **Step 2: Run the browser timing**

`npm run build:e2e`, then the batch driver with `--query compress --refine-runs 0` on `wl24_01` and on `v4`, one at a time, with nothing else heavy on the machine. The status file then holds the back-fill's milliseconds per frame (the factor engine on Discover's factors) beside the stage times of Extract's raw replay.

- [ ] **Step 3: Write the report**

`tools/cala-eval/results/<date>-factor-phase2.md`, every number produced by a throwaway script from the run folder, sections in this order:

1. **Gate**: (a) arm B against arm C: the unit test `traces_from_the_factors_equal_traces_from_the_rebuilt_frames` passes (give the commit), and per recording the table of `engine_report` (median and largest trace difference in units of the trace's standard deviation, for all cells, cells 16 px or more from the border, and cells nearer). State plainly whether the cells away from the border agree to rounding and how far the border cells are off. (b) arm A against arm C: gate A1 per recording for `c_chosen`, each rule's value and result. Then: "Decision: open, for the user."
2. **How it was measured**: commit, machine, scale, budget, arms.
3. **Speed, native**: per recording the Extract pass of `raw` (raw replay), `chosen` (frames rebuilt from factors) and `c_chosen` (factor engine): seconds preparing, solving and wall, and frames per second (frames over wall seconds). One sentence on what limits the factor engine (building the rows per window against solving).
4. **Speed, browser**: back-fill milliseconds per frame and the frames per second that gives, beside the frames per second of Extract's raw replay from the app's stage records (`tools/cala-eval/stage_times.py` on the cala export).
5. **Missing pixels**: per recording, the share of cells whose support has a pixel with a valid share below 1 (from the border group's size as a proxy, said so), and their trace difference from section 1.
6. **What was not measured**: at least: Refine on factors, live streams, the low-SNR and dense sets, full-length recordings, a library that changes between windows.

Writing rules as in the earlier reports.

- [ ] **Step 4: Docs**

- `docs/CHANGELOG.md`, `## [Unreleased]`: one entry: Extract on factors (`FactorExtractor`: the trace solver takes a frame's projections; the compress worker's back-fill no longer rebuilds frames); `qc_eval --extract-engine factors`.
- `apps/cala/README.md`, compression section: the back-fill paragraph, in the section's style.
- `tools/cala-eval/README.md`: lines for the arm `c_chosen` and for the engine comparison in the arms' report.

`npx prettier --write` on the three files and the report.

- [ ] **Step 5: Final check and commit**

All checks of Global Constraints.

```bash
git add tools/cala-eval/results docs/CHANGELOG.md apps/cala/README.md tools/cala-eval/README.md
git commit -m "docs(cala-eval): phase 2 results: Extract on factors against rebuilt frames and against raw"
```

---

## Not in this phase

- Refine on factors and the settle stop (phase 3), including the separate compression replay that gives Refine its factors.
- Using the factor engine for the file's Extract stage in the app. Extract still replays the raw file and, with `?compress`, leaves the recalibrated factors (phase 1). Switching the stage, the Run panel and the export's record of the source is phase 4.
- A per-frame treatment of missing pixels in the factor engine. This phase measures what the per-window treatment costs in the border band; the spec's `MIN_VALID_SHARE` rule for footprint statistics belongs to phase 3.
- The history review on the offset grids (phase 4).

## Self-review notes

- Spec coverage: §4 steps 1 to 3 are Tasks 2, 3 and 1; "replaces the back-fill's frame rebuild" is Task 5; the three-arm check is Tasks 3 (unit test), 4 and 6; the phase's gate is Task 6. §4's "the harness reports cells in the motion band separately" is `engine_report`.
- Names used across tasks: `process_projected`, `WindowProjector::{new, project, cells, background, functionals, frames, min_valid}`, `FactorExtractor::{new, engine_mut, library, set_library, solve}`, `extract_from_factors`, `--extract-engine`, `trace_gap`, `engine_report`, `extract_row`, arm `c_chosen`, `FactorExtractLike`, `CompressRunnerDeps.extract`.
