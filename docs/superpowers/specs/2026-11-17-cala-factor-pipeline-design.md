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

Chosen after phase 0: the two offset grids (Amendment 1, A3). The rule first
written here, "the cheapest arm within the null spread", could not be met by
any arm.

### 3. Factor store

- Compression is on for every run, without `?compress`. `?compress=off` turns
  it off, and Refine and Extract then replay the raw file as today.
- The randomized SVD runs two power iterations (`n_iter` 2; Amendment 1, A2).
- For a file, the factors that Refine and Extract use are made in one
  compression replay after Discover, with the final calibration. A live stream
  has no replay and uses the factors of Discover, with a flat field seed of the
  same sensor where one exists (Amendment 1, A4).
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

- per cell: lag-1 correlation of the traces (plain Pearson correlation is
  reported but not judged: the factors remove white noise that the raw trace
  keeps), cosine of the footprints;
- reported by SNR class (QC pass, low SNR), by distance of the centroid to the
  nearest tile line (under 4, 4 to 8, 8 to 16, over 16 px) and for the motion
  band at the edge;
- relative jump of footprint values across tile lines against other columns;
- on simulations: recall, precision and trace correlation to the truth.

The pass rule is A1 of Amendment 1: limits on the change of the truth
correlation, on the footprint loss, on the trace loss where there is no truth,
and on the footprint jump at tile lines. Phase 0 measured the **null spread**
(the same metrics between raw runs that differ only in the slow-loop budget).
It is 0.00001 to 0.006, which nothing smaller than the frames can meet, so it
is reported but is not the threshold.

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

| Phase | Work                                                                                                                    | Gate at the end                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Harness (flags on `examples/qc_eval.rs`), arms A and B, null spread, tiling arms, baseline timing                       | Done. Failed as first written (null spread); A against B meets A1 for recalibrated factors with two SVD iterations where run; offset grids chosen                                  |
| 1     | Format v2: offset grids and blending, discarded variance, valid share; two SVD iterations; compression replay for files | v1 and v2 files read; A against B meets A1 on all six recordings for offset grids, recalibrated, two iterations; compression time of that combination within the live frame budget |
| 2     | Extract on factors (Rust, WASM binding, compress worker); replaces the back-fill                                        | B against C to float32 rounding; A against C meets A1                                                                                                                              |
| 4a    | Before phase 4: the factors of Discover with a flat field seed, on a simulated stream                                   | Measured against A1; decides what a live run may claim                                                                                                                             |
| 3     | Refine on factors with the settle stop                                                                                  | Same checks on footprints, against a settled raw Refine                                                                                                                            |
| 4     | App: stages, Run panel, compression on by default, factors kept for live runs                                           | e2e run of Discover, Refine, Extract on a file and on a simulated stream                                                                                                           |
| 5     | Browser benchmark report in `tools/cala-eval/results/`; decide the default                                              | Decision recorded                                                                                                                                                                  |

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

- **Discover-time preprocessing in the factors.** Measured in phase 0: the
  factors of Discover fail the gate on four of six recordings, recalibrated
  factors pass. A file gets one compression replay with the final calibration
  before Refine. A live stream cannot; whether a flat field seed brings its
  factors within the gate is open and is measured before phase 4.
- **Dim cells and low SNR.** The rank cut drops most of the noise and part of
  the signal. Measured in phase 0: at 200 px the trace loss is 0.04 to 0.12
  with two SVD iterations, a looser cut or a higher starting rank close little
  of it, and it has no knee against the size. On real 200 px recordings there
  is no truth to say whether the loss is signal.
- **Missing pixels per window, not per frame.** Affects cells in the motion
  band only; measured separately.
- **Live latency.** A window closes after 600 frames (30 s at 20 fps), so the
  newest frames are not yet in the factors while the stream runs. Refine and
  Extract start after the stream ends and the last window is flushed.

## Amendment 1, after phase 0 (18 Nov 2026)

**Status: approved by the user on 18 Nov 2026.** The text above has been
edited to match; this section holds the reasons and the evidence.
Evidence: `tools/cala-eval/results/2026-11-18-factor-phase0.md` (v2.20.0;
bounded runs: 12000 frames at 200 px, 6000 at 600 px, slow-loop budget
3,000,000). "Loss" is 1 minus the median over QC-pass cells, of the lag-1
trace correlation or the footprint cosine, against the run on raw frames.

### A1. The gate

Replaces "within the null spread" in Benchmarks, in the tiling rule of §2 and
in the gates of phases 0, 2 and 3.

Why: the null spread is 0.00001 to 0.006. Factors with no rank cut at all
(rank up to 300, larger than the frames) still lose 0.002 to 0.003 on the
trace. No setting smaller than the frames can pass, so the rule decides nothing.

The rule, on QC-pass cells:

1. **Truth.** On a synthetic set whose truth match is usable (the raw run's
   median truth correlation is at least 0.8 and at least 20 cells match a
   truth unit), the paired change of the truth correlation, factor run minus
   raw run, has a median of at least −0.01 and a 5th percentile of at least
   −0.05.
2. **Footprints.** Footprint loss at most 0.02, on every recording.
3. **Traces without truth.** On a recording without usable truth, trace loss
   at most 0.08.
4. **Tile lines.** The footprint jump at tile lines is at most 0.10 above the
   raw run's.
5. **Lost cells.** Added on 19 Nov 2026 by Amendment 3, A13: at most as many
   QC-pass cells lost as in the null run that lost most.

The limits are the user's, approved as proposed. The truth limits say "the
typical cell is not worse and the worst cells lose little". The limits 0.02
and 0.08 have no derivation: they lie between what recalibrated factors
measured and what the factors of Discover measured. The null spread stays in
the reports.

Measured against rules 1 to 3 (plain tiling; truth as median, 5th percentile;
otherwise trace loss, footprint loss):

| recording | judged by  | factors of Discover  | recalibrated         | recalibrated, 2 SVD iterations |
| --------- | ---------- | -------------------- | -------------------- | ------------------------------ |
| wl200     | truth      | +0.002, −0.088: fail | −0.003, −0.093: fail | +0.008, −0.042: pass           |
| plain     | truth      | +0.004, −0.027: pass | +0.001, −0.031: pass | not run                        |
| motion    | trace, cos | 0.031, 0.023: fail   | 0.002, 0.001: pass   | not run                        |
| wl24_01   | trace, cos | 0.200, 0.045: fail   | 0.062, 0.014: pass   | 0.044, 0.010: pass             |
| wl24_04   | trace, cos | 0.231, 0.041: fail   | 0.075, 0.011: pass   | 0.056, 0.008: pass             |
| v4        | trace, cos | 0.009, 0.008: pass   | 0.002, 0.000: pass   | not run                        |

`motion` has truth, but the match is not usable (raw median 0.46). The truth
result on `wl200` rests on 25 matched cells, so its 5th percentile is one or
two cells. Plain tiling fails rule 4 on `wl200` (jump 1.82 against 0.98 for
raw); see A3.

### A2. Compressor settings

- **Two power iterations** of the randomized SVD (`n_iter` 2, today 1).
  Measured on the 200 px recordings: 26 to 30 % less trace loss for about 10 %
  more bytes and 40 to 50 % more compression time. Three or more iterations
  were not measured, and neither were two at 600 px.
- **The cut rule stays** (lag-1 autocorrelation above 0.2). It comes within
  0.012 of the trace loss of a fixed rank of 20 at 28 to 57 % of the size, and
  a looser cut (0.08) doubles the bytes to remove a fifth to two fifths of the
  loss. The loss has no knee: a fixed rank of 80, at two thirds of the size of
  the frames, still loses 0.02 to 0.05.
- This replaces the remedy named under Risks ("a lower `rho_min` or a higher
  starting rank"): both were measured and close little.

### A3. Tiling

Chosen: **two offset grids**. Replaces the rule "the cheapest arm within the
null spread" of §2.

- All three tilings remove most of the footprint jump that plain tiling adds:
  with the offset grids the jump is below the raw run's on three recordings
  and at most 0.07 above it on the others.
- The offset grids have the lowest trace loss of the tilings, plain included,
  on four recordings and are within 0.02 of the lowest on the other two
  (`wl24_01`, `motion`). Overlap 16 raised the trace loss against plain on
  every recording, most on `wl200` (0.23 against 0.17).
- Cost, measured: 1.8 to 2.0 times the bytes and 1.8 to 2.2 times the
  compression time of plain tiling. Overlap 8 costs 1.4 to 1.6 times the bytes
  and was not run at 600 px.
- A property of the layout: where a line of one grid crosses a line of the
  other, a tile keeps a weight of about 0.5 on its own edge.

Not measured: any tiling together with recalibrated factors or two SVD
iterations (the tiling arms used the factors of Discover).

### A4. Calibration of the factors

What the factors of Discover lack, as read in the code:

- The flat field divides the raw frame in sensor coordinates, before
  registration. Discover has no map for the first 150 s unless a stored map of
  the same sensor (a seed) is given; later passes apply the last map from
  frame 0. In the registered frame the map's effect moves with each frame's
  shift, so it cannot be applied to stored spatial factors afterwards as one
  factor per pixel.
- The running background floor and noise map start unsettled in Discover and
  continue, settled, in later passes.

On the three real recordings the first map arrived at frame 2999. The three
synthetic sets got no map at all, and recalibration still cut the loss on
`motion` (trace 0.031 to 0.002), so the settled running state matters beside
the flat field. How much each contributes was not measured.

Decided:

- **File recordings**: the factors used by Refine and Extract are made in one
  compression replay after Discover, with the final calibration. This is one
  more pass over the file. The factors made during Discover serve the history
  review as today.
- **Live streams**: there is no replay. The factors of Discover are used, with
  a flat field seed from an earlier session of the same sensor where one
  exists. Rules 1 to 4 are checked for this case on a simulated stream before
  phase 4; until then a live run's factors are not claimed to meet them.

Not measured: the factors of Discover with a seed; how their loss falls with
the length of the recording (the part without a map is a fixed 150 s, a
quarter of the frames in the wireless runs); whether the app stores and loads a
seed.

### A5. What the trade is, by recording type

| recording type | 8-bit frames, MB per 1000 frames | recalibrated factors, plain tiling | trace loss                      |
| -------------- | -------------------------------- | ---------------------------------- | ------------------------------- |
| 200 px         | 40                               | 2.1 to 4.3 (2 SVD iterations)      | 0.04 to 0.12 (2 SVD iterations) |
| 600 px         | 360                              | 14.5 to 22.6 (1 iteration)         | 0.002 to 0.003 (1 iteration)    |

The offset grids about double the factor sizes. At 200 px the loss is 15 to
60 times that at 600 px, and on the wireless recordings
there is no truth to say whether it is lost signal or removed noise.

### A6. Phases

- **Phase 0**: the gate as first written failed on all six recordings. Under
  A1, recalibrated factors with two SVD iterations pass rules 1 to 3 where
  they were run; the gaps are in the table of A1 and in A3.
- **Phase 1** adds `n_iter` 2, the offset grids and the compression replay
  for files. Its gate adds: rules 1 to 4 on all six recordings for the chosen
  combination (offset grids, recalibrated, two iterations), and the
  compression time of that combination within the live frame budget.
- **Phases 2 and 3**: "A against C within the null spread" becomes "A against
  C meets A1". "B against C to float32 rounding" is unchanged.

### A7. Found while planning phases 1 and 2

**Status: approved by the user on 18 Nov 2026**, together with the plans of
phases 1 and 2. Facts read in the code on 18 Nov 2026 and what the plans do
about them.

- **The history review reads side-by-side tiles.** It stacks the components of
  every tile that covers a pixel, without blending weights. So the live
  factors of Discover stay on plain tiles through phases 1 to 3, and only the
  factors made for Refine and Extract use the offset grids. Making the review
  read the offset grids moves to phase 4, where a live stream's factors are
  also the ones Refine and Extract use.
- **No extra pass in phases 1 and 2.** Extract's replay already has the final
  calibration, so in phase 1 it also feeds the compressor and leaves the
  recalibrated factors. The separate compression replay of A4 arrives with
  phase 3, which needs the factors before Refine starts.
- **Flat field seed.** The app already stores a flat field map per device and
  seeds a file run with it. A live stream skips that store today. The seed of
  A4 for live streams therefore needs that changed, in step 4a.
- **Missing samples.** A non-finite pixel is stored as a marker value in the
  quantized buffer (`i16::MIN`), counted per pixel, and enters the SVD as the
  pixel's mean over its valid samples. This is §1's valid share made concrete.
- **Gate A1 in the tools.** The truth rule is evaluated on QC-pass cells
  (the phase 0 numbers in A1's table are over all matched cells), and the tile
  lines of the offset grids are every 32 px in the tile-line measures (phase 0
  measured the offset arm on the 64 px lines only). The phase 1 gate run gives
  the numbers under these definitions.

## Amendment 2, after main's replay and look-back prototypes (19 Nov 2026)

**Status: decided overnight on 19 Nov 2026 by the implementing agent on the
owner's instruction to plan what is not planned and to carry main's flagged
features; for the owner's review.** The text above is not edited; where it
differs, this amendment holds. Evidence: the code of the branch after main was
merged into it (merge `cdccdbab`), and main's reports
`tools/cala-eval/results/2026-11-17-cluster-replay.md`,
`2026-11-18-replay-stage2.md`, `2026-11-18-replay-worker-jobs.md` and
`2026-11-19-concurrent-refine.md`.

On 18 Nov main gained three prototypes. All are behind flags that are off:

- **Cluster history replay** (`--joint-update`, `--joint-sign`;
  `crates/cala/src/discover/cluster.rs`): overlapping cells are refit together
  from a stored history of their cluster.
- **The replay in worker visit jobs**: the visit jobs carry the cluster stores
  (`--via-jobs`, `--visit-workers`).
- **Look-back** (`--lookback`, in the harness only: `LookBack` in
  `crates/cala/examples/qc_eval.rs`): while Discover runs, cells born recently
  and their neighbours are fed past frames again.

The owner has decided that these become part of the pipeline. This amendment
says what that means for the factor design.

### A8. Cluster history replay

What the code does:

- The history is filled in `SlowLoop::observe`, from the frames the slow loop
  is fed (`update_clusters` in `cluster.rs`, about line 935). Per fitting frame
  and cluster it stores `K` numbers, `v_t = Uᵀ r̃_t`. `r̃` is the cluster's
  whitened residual on its pixels against the model of that frame:
  `r̃ = is ⊙ (y − model − ring level + Σ_k a_k c_k)`, with the fast loop's
  traces of the frame. Held-out frames are not stored. No frame store is read.
- The coordinates are kept behind the trait `ClusterHistory` (about line 123).
  Its documentation names another possible backing: "a compressed store of the
  frames that can project any past frame onto a new basis".
- A frame whose residual is not finite on the cluster's pixels is skipped
  (`skipped_frames`, about line 1021).

What follows:

- **Refine replays on rebuilt frames carry the replay unchanged.** A replay on
  frames rebuilt from factors (arm B) feeds `observe` as a raw replay does.
  Phase 2 measures this: its `joint_*` runs are the gate arms with
  `--joint-update all --joint-sign all`, the reference setting of main's
  reports (arm `DR-st2`).
- **Missing samples.** In the harness, a rebuilt frame keeps the missing
  samples of the raw replay (`FactorReplay::frame` writes only where the
  replayed frame is finite), so arm B skips the same frames as a raw run. A
  frame made from the factors alone has no missing sample: the factors store a
  missing sample as the pixel's mean over the window (A7), and a pixel with no
  valid sample in the window as 0. So without a raw replay (the factor engine,
  a live stream, phase 3) the replay skips no frame, except in the look-back
  source (A9), which reads a never-valid pixel as missing. A cluster at the edge of a
  moving field of view then takes window means as data where a raw run skips
  the frame; its residual there is too small and its noise is understated.
  This touches clusters in the motion band only. Phase 3 reports them with the
  border cells, as phase 2 does for the traces.
- **Refine on factors without rebuilding frames (§5, phase 3).** The replay
  needs each fitting frame's coordinates `Uᵀ r̃_t` from the factors. Every term
  of `r̃` is linear in the frame or known in the iteration:

  ```text
  Uᵀ diag(is) ŷ_t = Σ_k (Uᵀ diag(is) diag(b_k) W_k) · v_k(t)  +  Σ_k Uᵀ diag(is) (b_k ⊙ μ_k)
  ```

  The bracket is the cluster's basis projected through the window's spatial
  factors: `K` rows per tile, formed once per window and cluster, as
  `WindowProjector` forms the rows of the solver's functionals. The model terms
  come from the library and the traces of that iteration: `Uᵀ diag(is) a_j`
  once per member and library, times `c_j(t)`, and the ring level of each
  owner. This is the compressed backing that `ClusterHistory` names. On a
  change of basis the coordinates are computed again from the factors instead
  of being re-expressed. The sums the store keeps beside the coordinates (`CY`,
  the sums of `r̃` and `c`) are filled from the factors as the footprint
  statistics of §5 are. The replay's own test (`refine_clusters`) reads the
  tile's held-out frames from the reservoir; in phase 3 they come from the
  factors, like the other held-out tests of §5.

Decided: **phase 3 carries the cluster history replay this way.** Its gate
(footprints against a settled raw Refine) is checked with the joint flags on
(`--joint-update all --joint-sign all`) and off.

Not measured: what the window means at missing samples do to the replay at the
border; the cost of the projection per cluster and window.

### A9. Look-back

What the code does: `LookBack::frame` (`qc_eval.rs`, about line 1111) is the
only place that reads raw frames for the look-back. It reads 64-frame blocks of
the recording by frame range (`rec.read`), preprocesses them again with a copy
of the live preprocessor (`pre.front`, which estimates the flicker again),
applies the stored motion records (`mc.apply`, `mc.validity`,
`pre.back_masked`), solves them with a separate trace engine on the current
library and feeds them to `SlowLoop::observe_lookback`. Everything else in the
three prototypes reads preprocessed frames. Main's report lists what the app
needs: a worker that re-reads the saved raw file by frame range, a copy of the
preprocessing state, and the stored motion records.

A live stream has no raw file.

Decided:

- **The look-back gets a second frame source: the factors written so far in
  the run.** They are already preprocessed and motion-corrected, with the
  calibration of their time (flat field, background floor, noise map,
  flicker), so neither the preprocessing nor the warp is applied again. Only
  the pixels whose valid share in the window is 0 are marked missing, read from
  the factor file (corrected 19 Nov after the review of phase 4a's look-back
  source: the live frame holds a finite filler at samples the motion mask
  removes once the pixel had a valid sample, so the stored motion records are
  not used). A frame can be read once its window is
  written: at most one window (600 frames, 30 s at 20 fps) behind the live
  frame. A cell born in the newest window waits for it. At the end of a stream
  the last window is flushed before the look-back's drain.
- **In the harness** this is a flag on the existing prototype,
  `--lookback-source raw|factors` (phase 4a).
- **In the app** it arrives when main brings the look-back to the app. The
  factor store must then give another worker random access to a window by
  frame range: either the compress worker answers a request with the window's
  factors, or the look-back worker opens a finished window file itself. In
  OPFS, a file with an open synchronous access handle is locked to the worker
  that holds it, so the writer must have closed the file first.
- **Whether look-back on factors is as good as look-back on raw is not
  known.** The factors lose what the rank cut drops (A1, A5), and they carry
  the calibration of their time where a raw look-back applies the current one
  (before the first flat field map, none). Phase 4a measures it together with
  the flat field seed, because both answer the same question: what a live run
  may claim.

### A10. Worker visit jobs

No change to the factor design. The jobs carry the cluster stores and the
replay's results between the slow loop's owner and the visit workers
(`VisitJob`, wire format `VIS9`), and what a store holds is computed in
`observe` on the owner. Whatever feeds `observe` (raw frames, rebuilt frames,
or in phase 3 the coordinates from the factors) fills the stores the jobs
carry.

### A11. Phases

This table replaces the phases table above.

| Phase | Work                                                                                                                                                                                                                                                                                                                                                                                 | Gate at the end                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Harness, arms A and B, null spread, tiling arms, baseline timing                                                                                                                                                                                                                                                                                                                     | Done. Failed as first written (null spread); gate A1 adopted; recalibrated factors with two SVD iterations pass rules 1 to 3 where run; offset grids chosen |
| 1     | Format v2, offset grids, two SVD iterations, recalibrated factors written during Extract's replay                                                                                                                                                                                                                                                                                    | Done. `chosen` meets A1 on all six recordings (bounded runs); compression within the live frame budget on file recordings                                   |
| 2     | Extract on factors (`FactorExtractor`; the compress worker's back-fill)                                                                                                                                                                                                                                                                                                              | B against C to float32 rounding; A against C meets A1; also measured with main's joint flags on. Outcome: see its report                                    |
| 4a    | What a live run may claim, in the harness and the tools only: Discover's factors (offset grids) with and without a flat field seed; look-back on factors against look-back on raw; two cross-session seed runs added by the controller (same mouse and scope model per the dataset notes; scope unit not confirmed). Results: `tools/cala-eval/results/2026-11-19-factor-phase4a.md` | Measured against A1. A failed rule limits what a live run may claim; it does not stop the phase                                                             |
| 3     | Refine on factors with the settle stop, carrying the cluster history replay (A8); the compression replay before Refine for files                                                                                                                                                                                                                                                     | Footprints against a settled raw Refine, with the joint flags on and off                                                                                    |
| 4     | App: stages, Run panel, compression on by default, factors kept for live runs, a flat field seed for live streams (A7), the history review on the offset grids. Main's flags are exposed only where main's app side exists (look-back: the factor store's random access, A9)                                                                                                         | e2e run of Discover, Refine, Extract on a file and on a simulated stream                                                                                    |
| 5     | Browser benchmark report in `tools/cala-eval/results/`; decide the default                                                                                                                                                                                                                                                                                                           | Decision recorded                                                                                                                                           |

Raw replay stays available behind `?compress=off` at least until phase 5.

### A12. Open for the owner

Decisions of this amendment and of the phase 4a plan that the owner may want to
overrule:

- A8: phase 3 computes the cluster coordinates from the factors, rather than
  rebuilding frames for the replay or leaving the replay off in a factor Refine.
- A8: without a raw replay, missing samples at the border enter the replay as
  window means instead of being skipped.
- A8: the gate of phase 3 runs twice, with the joint flags on and off.
- A9: a live look-back reads the factors, rather than a buffer of the last few
  thousand raw frames kept for it (about 120 MB at 200 px, over 1 GB at
  600 px).
- A9: with the factor source, a look-back frame marks as missing only the
  pixels whose valid share in the window is 0 (read from the factor file); the
  stored motion records are not used. The live frame holds a finite filler at
  samples the motion mask removes once the pixel had a valid sample (corrected
  19 Nov after the review of phase 4a's look-back source).
- A9: a cell born in the newest window waits up to one window for its
  look-back frames.
- Phase 4a: an earlier session of the same sensor is simulated by a later
  stretch of the same recording; the synthetic sets, which never get a flat
  field map, get no seed.
- Phase 4a: Discover's factors are measured on the offset grids, although A7
  keeps the app's live factors on plain tiles until phase 4.
- Phase 4a: runs whose Discover differs (look-back) are compared by pairing
  cells by footprint; a reference cell without a partner counts as lost.
- A11: the order 4a, 3, 4, 5 stays.

## Amendment 3, the owner's decisions after phases 2 to 4a (19 Nov 2026)

**Status: decided by the owner on 19 Nov 2026**, after reading the summaries
of the reports of phases 2, 4a and 3a. Evidence for A13:
`tools/cala-eval/results/2026-11-19-factor-phase4a.md`.

### A13. Gate A1, rule 5: lost cells

Why: rules 1 to 3 are medians and a 5th percentile. A QC-pass cell that the
test run lost counts as the worst case in them, but a median does not move
until about half the cells are lost, and the truth rule, which would react,
does not apply on every recording. Where two runs have their own Discover
(look-back), cells are paired by footprint and some always stay unpaired, in
both directions.

The rule:

5. **Lost cells.** The test run may lose at most as many of the reference's
   QC-pass cells as the null run that lost most. Without null runs the rule
   does not apply.

The limit is measured from the null runs, not set by hand: they are the
reference's own algorithm at half and twice the slow-loop budget (the same
choice as for the null spread), compared with the reference the way the test
run is. The pipeline is deterministic, so a repeat at the same budget would
lose nothing; the limit is what a change of machine speed by a factor of two
loses, not a confidence bound.

- Runs that share the reference's Discover are compared by cell id, against
  `null_lo` and `null_hi` (the other budget in the replays).
- Look-back runs are paired by footprint, against `lb_null_lo` and
  `lb_null_hi` (`lb_raw` with the other budget in its one pass), paired the
  same way.

The report also gives the count in the other direction (cells of a run with
no partner in the reference), for the test run and the null runs; it is not
gated.

Known weaknesses: two null runs give a coarse limit, and with a limit of a few
cells the verdict can turn on one cell. Where both null runs lose nothing, one
lost cell fails the rule. A null run that ended without cells would allow any
loss. The report states the counts of the test run and of each null run beside
the verdict, so each case is visible.

### A14. Missing pixels

The frame engine stays the reference for a cell whose support holds pixels
without data: it leaves such a pixel out of the frame, the factor engine uses
the stored value. A few bad pixels must not decide a run, so such a cell is
flagged by its `min_valid` (the smallest valid share over its support's
pixels) and neither engine is changed for it. The wording of the gate between
the two Extract engines ("to float32 rounding") stays as it is until the cause
of the 1.5 percent trace difference on the two WL24 recordings is known; a
limit on the median difference replaces it then.

### A15. Refine on factors and the WL24 recordings

Refine on factors fails rule 2 on the two WL24 recordings only (phase 3a). The
owner accepts this for now: the phases after 3a go ahead with the failure on
record. For the record, the two WL24 sessions are two of the three real
recordings in the set and come from one mouse and one setup; the third, `v4`,
passes with a margin smaller than its null spread.
