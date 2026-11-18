# cala: Refine and Extract on SVD factors

Design spec, 17 Nov 2026. Based on main `20de18c0` (v2.19.1).

## Goal

Make the low-rank compression of the frame stream a regular part of a cala run:

1. **Extract** solves the traces from the factors, without the frames.
2. **Refine** updates the footprints from the factors and repeats until the
   footprints have stopped changing. The number of Refine runs is no longer a
   setting.
3. **A live stream is kept as factors**, so a live run can Refine and Extract.
4. **Tile lines do not hurt cells** that sit on them.
5. **Measured**: how close the results are to today's, how much faster the
   stages are, and what the smaller history allows in memory.

## Not in scope

- Discover stays on raw frames (reservoir, add, merge, split, keep tests).
- No change to motion correction, preprocessing, QC or the export's cell data.
- Opening a saved factor folder later as a recording (later, own spec).
- Using the factors for more Discover tests beyond the existing history review.

## Where main is today

- `?compress` (`crates/cala/src/compress`, `apps/cala/src/lib/compress-*.ts`):
  the fast loop's input (preprocessed, motion-corrected frames) is compressed
  per 64 px tile and 600-frame window by a randomized SVD, with the rank cut by
  the lag-1 autocorrelation of each time course. Tiles do not overlap
  (`tile_grid`). A missing pixel (moved in from outside the sensor by
  registration) is stored as 0 (`quantize`).
- The factors feed the back-fill, which rebuilds frames 16 at a time and runs
  the normal `TraceEngine`, and the history review (`compress/review.rs`),
  which works on the factors directly.
- Refine and Extract replay the raw file from frame 0: decode, preprocess,
  replay the motion record, solve. A live stream has no file, so it gets
  Discover only (`apps/cala/docs/stages.md`).
- How much a Refine run refines depends on the machine's speed, and the user
  sets the number of runs (0 to 5 in a multi-session run).

PRs and branches this builds on or must be measured against (#411 and #416
are in v2.20.0):

| PR or branch               | What                                                               | Effect here                                                                         |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| #411                       | Replay setup of Refine and Extract in one module                   | The factor path plugs in at that module                                             |
| #416                       | Refine gate accepts any held-out gain (`refine_z` 0)               | Changes the raw baseline; factor Refine uses this rule; sets the stop rule (§5)     |
| #412                       | Neighbour-shadow ring floor, default off                           | None while off; rerun the closeness check if it flips                               |
| `feat/cala-cluster-replay` | Joint refit of overlapping cells in Refine from stored frames, off | Its `ClusterHistory` frame store can be backed by the factors in phase 3, if merged |

`test/svd-dim-cells` (local) has `examples/svd_dimcells.rs`, which dumps the
compressor's input and compresses a recording at chosen ranks. The harness of
phase 0 starts from it.

## Notation

For one window of `T` frames and tile `k` with `P_k` pixels:

```text
ŷ_t(p) = Σ_k b_k(p) · [ μ_k(p) + W_k(p,:) · v_k(t) ]
```

- `W_k` (`P_k × r_k`): spatial factors, scaled by the singular values.
- `V_k` (`T × r_k`, rows `v_k(t)`): orthonormal time courses.
- `μ_k`: per-pixel mean over the window.
- `b_k`: blending weight of tile `k`; `Σ_k b_k(p) = 1` at every pixel. Without
  overlap `b_k` is 1 on the tile.

Any quantity that is linear in the frame is then a small product. For a vector
`f` over pixels (a footprint column, a ring, a background map):

```text
fᵀ ŷ_t = Σ_k (fᵀ diag(b_k) W_k) · v_k(t)  +  Σ_k fᵀ diag(b_k) μ_k
```

The bracket is computed once per window; each frame then costs `r_k`
multiply-adds per tile under `f`, instead of one per pixel of `f`.

## Design

### 1. Factor format v2

`TileFactors` and the factor file (`CALAFAC1` to `CALAFAC2`; v1 files still
read) gain:

- **Tile geometry with overlap** (section 2).
- **Discarded variance** `d_k(p) = var_t y(p) − ‖W_k(p,:)‖² / T`: what the rank
  cut removed at each pixel. One vector of `P_k` values per tile, computed from
  sums the compressor already has. It lets the factor path state the full
  residual energy, `Σ_t r_t(p)² = Σ_t r̂_t(p)² + T · d_k(p)`, so tests in noise
  units keep a correct noise level.
- **Valid share** per pixel: the fraction of the window's frames in which the
  pixel was not missing. A missing sample enters the SVD as the pixel's mean
  over its valid samples (zero after centring) instead of 0. A pixel valid in
  less than `MIN_VALID_SHARE` (0.1, the constant `fpstats.rs` already uses) is
  left out of that window's statistics.

### 2. Tiling: overlap and blending

A cell on a tile line is split between tiles. Each part has fewer pixels, so a
dim cell's component is more likely to fail the rank cut in one tile or both.
The linear algebra above is exact for any tiling; the tile line matters only
through what the compression drops.

Arms to measure in phase 0 (cost is compression time and factor size relative
to no overlap):

| Arm              | Layout                                                   | Cost  |
| ---------------- | -------------------------------------------------------- | ----- |
| none             | 64 px tiles (today)                                      | 1×    |
| overlap 8        | each tile grown 8 px per side, raised-cosine ramp        | 1.56× |
| overlap 16       | each tile grown 16 px per side (about one cell diameter) | 2.25× |
| two offset grids | a second grid shifted 32 px, triangular weights          | 2×    |

The blending window is separable in x and y and derived from the geometry, so
it is not stored. Blended factors `diag(b_k) W_k` and `b_k ⊙ μ_k` are formed
when a window is loaded.

Rule for the choice: the cheapest arm in which cells within 8 px of a tile line
are as close to the raw result as cells further away, within the null spread
(see Closeness).

### 3. Factor store

- Compression is on for every run, without `?compress`. `?compress=off` turns
  it off, and Refine and Extract then replay the raw file as today.
- Factor files stay in the origin private file system for the run. When the
  run has a results folder with write access, they are also written to
  `<run>/factors/f<window>.bin`, so a live session keeps its factors.
- A live stream must be compressed in real time. If one compress worker falls
  behind the frame rate with the chosen overlap, tiles are shared across
  workers (the native build already has `threads`).

### 4. Extract on factors

New `compress/project.rs` and a solver entry that takes projections:

1. Per window and library: stack every linear functional the solver reads
   (filtered footprint columns on their supports, moat block means, ring means,
   background maps) and form `Q_k = Fᵀ diag(b_k) W_k` and the mean term.
2. Per frame: projections `Σ_k Q_k v_k(t)` plus the mean term.
3. `TraceEngine::process_projected` runs the existing coordinate descent on
   those projections, with the same Gram matrix, overlap groups, warm start and
   stopping rule as `process_into`.

Missing pixels are handled by the valid share per window, not per frame, so
the per-frame imputation of `process_into` is not used. The harness reports
cells in the motion band at the edge of the field of view separately.

This replaces the back-fill's frame rebuild. A library change during Refine
needs only step 1 again.

### 5. Refine on factors

One iteration, with the cell set frozen (`EditScope::Refine`):

1. **Traces**: Extract on factors with the current library, all windows.
2. **Statistics**: for each cell, fill the existing `FpStats` sums from the
   factors. With frame weights `w_t` (1 on fitting frames, 0 on held-out
   frames, by the existing frame hash) and the cell's trace `z`:

   ```text
   Σ_t w_t ŷ_t(p) z_t = Σ_k b_k(p) W_k(p,:) · (V_kᵀ (w ⊙ z))  +  μ(p) Σ_t w_t z_t
   Σ_t w_t m_t(p) z_t = Σ_j ã_j(p) · (Σ_t w_t c_j(t) z_t)  +  background terms
   ```

   `m_t` is the model. The split-half sums use the same formula with the
   weights of the alternate 256-frame blocks. No frame is rebuilt.

3. **Proposals and gate**: unchanged code. `stats_proposal`, the split-half
   gate, the support rule and the held-out comparison run on these sums. The
   held-out comparison uses the same patch solve, fed with projections from the
   factors on the held-out frames.
4. **Publish** the accepted refinements as the next library.

Stop when the footprints have settled: fewer than 2 % of the cells have a
footprint that correlates below 0.99 with its footprint of the previous
iteration (`settle_corr` 0.99, `settle_share` 0.02). A cap (`max_iterations`,
default 20) ends a run that does not settle, and the stage log says so.

The stop is on the size of the changes, not on their count. Since v2.20.0 the
gate accepts any held-out gain (`refine_z` 0, #416), and the accepted
refinements of a raw Refine then do not die out in number: later passes keep
accepting thousands of small ones while the footprints move less and less
(`tools/cala-eval/results/2026-11-17-refine-gate-refill.md`: 1.7 % of cells
below 0.99 by pass 5). The two thresholds start at that level and are checked
in phase 3 against the footprint accuracy on the synthetic sets.

Differences from today's Refine, all to be measured:

- The library is fixed within an iteration, so the statistics need no
  forgetting half-life and every cell uses the statistics path (the reservoir
  path for young cells is not used).
- The result does not depend on the machine's speed.
- The comparison target is a raw Refine repeated until it has settled (5 passes,
  as in `tools/cala-eval/results/2026-11-12-skirt-stability.md`), not one pass.

### 6. Stages and UI

- **Refine**: one action, "Refine until settled". The readout shows the
  iteration, refinements published, the share of cells still changing (the
  stop measure) and the median footprint change per iteration (the existing
  plots, with iterations on the x axis). The
  multi-session setting "number of Refine runs" becomes on or off.
- **Extract**: runs on the factors, after Refine without asking (it takes
  seconds).
- **Streaming**: Refine and Extract are offered once the stream has ended.
- The export's `meta_json.stages` records `source: "factors"` or `"raw"` for
  each stage, with the tiling and the mean rank (export format bump).

## Checking that results are the same

Three arms on the same recording and the same Discover library:

| Arm | Refine and Extract run on                           |
| --- | --------------------------------------------------- |
| A   | raw replay (today)                                  |
| B   | today's engine, fed frames rebuilt from the factors |
| C   | the factor engine                                   |

- **B against C** checks the math. Traces and footprint statistics must agree
  to float32 rounding. This is a unit test in Rust on a fixture and part of CI.
- **A against B** measures what compression loses: rank cut, quantization,
  tile lines, and that the factors hold Discover's preprocessing (flat field
  and noise map as they were at each frame), where a replay applies the final
  ones from frame 0.

## Benchmarks

Recordings: simulations with ground truth, one 600 × 600 real recording at
20 fps and two 200 × 200 wireless recordings.

**Closeness** (A against C, and both against ground truth on simulations):

- per cell: Pearson correlation of the traces, cosine of the footprints;
- reported by SNR class (QC pass, low SNR), by distance of the centroid to the
  nearest tile line (under 4, 4 to 8, 8 to 16, over 16 px) and for the motion
  band at the edge;
- relative jump of footprint values across tile lines against other columns;
- on simulations: recall, precision and trace correlation to the truth.

The pass threshold is not a fixed number. Phase 0 measures the **null spread**:
the same metrics between two raw runs that differ only in visit timing. The
factor result passes when it is within that spread for QC-pass cells.

**Speed**: wall time and frames per second per stage, native (`qc_eval`) and in
the browser (headless Chrome), at both frame sizes:

- today: Discover, each Refine run, Extract;
- factors: Discover with compression on (the overhead), Refine until settled
  with its iteration count, Extract.

The existing overnight summary rounds stage times to half a minute (0.5 to
2 min per stage at 200 × 200), which is too coarse; the harness logs seconds.

**Memory**: peak memory per stage (run telemetry already reports it), factor
megabytes per minute of recording, and frames of history per gigabyte against
the reservoir's `i16` patches. Per tile and frame the factors take about
`4 · r · (P_k / T + 1) + 4 · P_k / T` bytes (1.3 kB at rank 40, 64 px, 600
frames) against 8.2 kB as `i16`; phase 0 measures the real mean rank.

## Phases

Each phase gets its own implementation plan. A phase starts only when the gate
before it has passed.

| Phase | Work                                                                                              | Gate at the end                                                             |
| ----- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 0     | Harness (flags on `examples/qc_eval.rs`), arms A and B, null spread, tiling arms, baseline timing | Loss of A against B within the null spread for QC-pass cells; tiling chosen |
| 1     | Format v2: overlap and blending, discarded variance, valid share                                  | v1 and v2 files read; compression time within the live frame budget         |
| 2     | Extract on factors (Rust, WASM binding, compress worker); replaces the back-fill                  | B against C to float32 rounding; A against C within the null spread         |
| 3     | Refine on factors with the settle stop                                                            | Same checks on footprints, against a settled raw Refine                     |
| 4     | App: stages, Run panel, compression on by default, factors kept for live runs                     | e2e run of Discover, Refine, Extract on a file and on a simulated stream    |
| 5     | Browser benchmark report in `tools/cala-eval/results/`; decide the default                        | Decision recorded                                                           |

Raw replay stays available behind `?compress=off` at least until phase 5.

## Main code touched

- `crates/cala/src/compress/mod.rs`: tiling, format v2, variance, valid share.
- `crates/cala/src/compress/project.rs` (new): functionals onto factors.
- `crates/cala/src/trace/solver.rs`: `process_projected`.
- `crates/cala/src/discover/fpstats.rs`, `discover/factor_refine.rs` (new):
  sums from factors, the iteration.
- `crates/cala/src/compress/js.rs`: bindings.
- `crates/cala/examples/qc_eval.rs` (new flags; built as flags on the
  existing example, not as a new `examples/factor_eval.rs`), `tools/cala-eval`:
  harness.
- `apps/cala/src/lib/compress-runner.ts`, `run-stages.ts`, the replay module
  of #411, `components/RunPanel.tsx`, `window-store.ts`.

## Risks

- **Discover-time preprocessing in the factors.** If arm B is too far from arm
  A early in a recording, a file gets one compression replay with the final
  calibration before Refine. A live stream cannot; the report then states the
  difference for live runs.
- **Dim cells.** The rank cut drops most of the noise and can drop a dim cell's
  signal. Reported per SNR class; the remedy is a lower `rho_min` or a higher
  starting rank, at the cost of size.
- **Missing pixels per window, not per frame.** Affects cells in the motion
  band only; measured separately.
- **Live latency.** A window closes after 600 frames (30 s at 20 fps), so the
  newest frames are not yet in the factors while the stream runs. Refine and
  Extract start after the stream ends and the last window is flushed.
