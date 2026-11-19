# cala factor pipeline, phase 3: Refine on factors

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Refine that runs on the factor files of a recording without rebuilding a frame for its statistics, iterates until the footprints have settled, is reachable from the harness, and is measured against a raw Refine repeated until settled. This plan is phase 3a (the per-cell statistics route, joint flags off) in full, and phase 3b (the cluster history replay on factors, joint flags on) as a task list with interfaces.

**Architecture:** One iteration reads every factor window twice. Pass A solves the traces with the current library (phase 2's `FactorExtractor`) and, in the same window, fills every cell's footprint statistics from the factors and those traces: the data part `Σ_t c_t ŷ_t(p)` through the temporal factors (`V_kᵀ c`) and the spatial factors, the model, ring-level and basis parts from sums of traces only. Pass B rebuilds, for each slow-loop tile, the patches of a few dozen held-out frames from the factors (a few percent of the recording's pixels), which feed the unchanged refine visit (proposal, split-half gate, support rule, held-out comparison). Accepted refinements are published as the next library, and the iteration repeats until fewer than 2 % of the cells moved by more than a correlation of 0.99. The new code is `crates/cala/src/discover/factor_refine.rs` (a child of `discover`, so it reads the slow loop's private state as `cluster.rs` does) and one method on `BlendLayout`; `qc_eval` gets `--refine-engine factors`, whose pass 2 is a compression replay only.

**Tech Stack:** Rust (crate `calab-cala`), Python 3 with numpy (`tools/cala-eval`).

**Spec:** `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md`: Notation, §5 "Refine on factors", "Checking that results are the same", Amendment 1 (A1, A4, A6, A7) and Amendment 2 (A8, A10, A11, A12). Builds on `docs/superpowers/plans/2026-11-18-cala-factor-phase2.md`.

**Precondition:** phase 2 is on this branch (it is: `FactorExtractor`, `WindowProjector`, `extract_from_factors`, `--extract-engine`) and the owner has accepted its gate; Amendment 2 is approved or its A8 is accepted for this phase. A11 puts phase 4a before phase 3; this plan does not depend on 4a's code.

## Global Constraints

- Gate of this phase (spec A11): footprints of the factor Refine against a settled raw Refine, gate A1, with the joint flags off (3a) and on (3b). The unit-level check "B against C" of this phase: the statistics filled from the factors equal the statistics the existing frame code fills from frames rebuilt from the same factors (with the same traces), to `1e-4 · S + 1e-3` per sum (S defined in Design notes), and one factor iteration accepts the same refinements as one iteration whose statistics come from those rebuilt frames. Both are Rust unit tests that run with `cargo test`.
- Gate A1, on QC-pass cells (as built in phase 1, `factor_closeness.a1_gate`): (1) with usable truth (raw run's median truth correlation at least 0.8 and at least 20 matched cells) the paired change of the truth correlation has a median of at least -0.01 and a 5th percentile of at least -0.05; (2) footprint loss at most 0.02; (3) without usable truth, trace loss (lag-1 correlation) at most 0.08; (4) footprint jump at tile lines at most 0.10 above the raw run's.
- `TraceEngine::process_into` and every existing Refine path stay bit-identical. These existing tests pass unchanged: `signed_traces_leave_the_solve_bit_identical`, `reextraction_reproduces_the_online_pass`, `library_install_from_terms_matches_full_rebuild_at_the_same_frame` (`crates/cala/src/trace/tests.rs`); `visits_run_as_jobs_match_step_exactly`, `split_half_refine_gate_refines_and_matches_jobs`, `refine_scope_travels_with_visit_jobs`, `js_refine_replay_is_refine_only_deterministic_and_matches_qc_eval`, `the_cluster_replay_runs_in_visit_jobs_and_matches_step`, `a_bitten_footprint_is_refilled_from_its_statistics`, `a_refine_only_scope_freezes_the_cell_set` (`crates/cala/src/discover/tests.rs`); `masked_push_without_missing_equals_scalar_push`, `fpstats_push_parity_sums_equal_full_sums` (`crates/cala/src/discover/fpstats.rs`); phase 2's `traces_from_the_factors_equal_traces_from_the_rebuilt_frames` and `extract_from_factors_matches_the_replayed_frames`, and phase 1's `plain_rebuild_equals_the_window_rebuild`. No line of `refine`, `refine_clusters`, `update_fpstats`, `FpStats::push` or `TraceEngine` changes in 3a; a failing one of these tests means a change leaked: fix the change, never the test.
- `?compress` stays opt-in in the app. No app file changes in this phase (the app is phase 4).
- Rust checks, run from `crates/cala`: `cargo fmt --all --check`, `cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings`, `cargo test --no-default-features --features jsbindings`.
- Python: type hints on function signatures; `uvx ruff format` and `uvx ruff check --fix` on every Python file touched; never install into a global environment (tests run with `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`).
- The shell in this worktree refuses long compound commands (`cd ... &&` chains, loops, heredocs). Put anything complex in a script file and run it with one plain command.
- Raw data is read only. Run outputs go to a folder outside the repository. No machine paths or user names in committed files.
- Commits: one sentence, conventional prefix, no body, no co-author trailer and no tool or assistant attribution. Do not push.
- Branch: `feat/cala-factor-extract`, continued.
- No panic reachable from data: a refused input to the library (a window of another frame size, a gap in the windows, a factor file whose tiles do not fit their layout, non-finite traces, an unpublished library, the wrong edit scope) is an error value, and a refused iteration leaves the slow loop's library, frame counter and statistics as they were. The harness (`qc_eval`) may stop with a message, as it does today.
- `std::time::Instant` is not used in library code (it panics on `wasm32-unknown-unknown`); the iteration reports its stages through `FactorSource::stage`, and the harness times them.

## Review Focus

1. **Missing pixels.** A pixel missing in most of a window (valid share below `MIN_VALID_SHARE`, 0.1) must be left out of that window's statistics through the per-pixel moments (as a NaN is in the frame route), and be missing in the rebuilt held-out patches; a pixel missing in part of a window (0.1 to 1) is kept with the window mean and only counted. Pinned in Task 2 (the fixture has one pixel of each kind and the frame route is fed NaN where the factor route excludes) and Task 3 (the patch's `miss` list).
2. **Too few held-out frames for a tile.** A short recording or a small `--test-frames` leaves a tile with fewer than `min_test_frames`: the tile must be skipped and counted, not refined on two frames. Pinned in Task 4 (`test_frames` 4: every tile with cells skipped, nothing accepted, the run settles).
3. **Windows that are not the recording.** A gap, a window of another frame size, tiles that do not fit their layout, or a source that changes between pass A and pass B: errors, and the slow loop unchanged. Pinned in Task 4 (`refused_inputs_leave_the_loop_as_it_was`) and Task 3 (pass B checks that it read as many frames as pass A).
4. **Non-finite factors or traces.** A window whose factors give a non-finite projection (Extract refuses) or a non-finite trace (the sums would be NaN for every pixel of the disk): an error before any statistics are installed. Pinned in Task 4 (a window with NaN temporal factors).
5. **An empty library and a cell with no neighbour.** No division by zero in the settle measure, no index past a neighbour list, an empty pass. Pinned in Task 4 (`an_empty_library_settles_at_once`) and Task 2 (cell 1 has the other cell as its only neighbour; the moment and neighbour sums are compared per cell).

## Design notes

### What an iteration computes

Notation of the spec: window `W` of `T` frames, tiles `k` with blending weights `b_k`, spatial factors `W_k` (`P_k × r_k`, scaled), temporal factors `V_k` (`T × r_k`, rows `v_k(t)`), means `μ_k`. A frame is `ŷ_t(p) = Σ_k b_k(p) [μ_k(p) + W_k(p,:)·v_k(t)]`.

The slow loop's per-cell statistics (`FpStats`, `fpstats.rs` about line 43, filled by `update_fpstats` in `discover/mod.rs` about line 2153) are, on the cell's statistics disk (support radius plus `stats_margin_cells` cell diameters, FOV pixels), with weights `w_t` (1 on fitting frames, 0 on held-out frames by `SlowLoopConfig::is_test` of the slow-loop frame index) and the cell's trace `c_t`:

- `rc(p) = Σ_t w_t c_t r_t(p)`, `r(p) = Σ_t w_t r_t(p)`;
- the same over the alternate 256-frame blocks (`half.0`, `half.1`; block of the cell's push counter `k`);
- class moments `m = [Σw, Σw², Σwc, Σwc², Σwc, Σwc·c]` (both pixel classes get the same, the instrument and regressor are both `c`) and their half;
- per-pixel moments `pm` (`[Σw, Σw², Σwc, Σwc²]` over the frames in which the pixel was valid) once a pixel has been missing;

where `r_t(p) = y_t(p) − m_t(p) − ℓ_t + a(p) c_t`, `m_t = Σ_j a_j c_{j,t} (+ Σ_a g_a β_{a,t} for a basis background)` is the rendered model (`Library::render`), `ℓ_t` the cell's ring level (the solver's ring mean), and `a = column_on(lib, slot, pix)` the cell's filtered column with its moat. The own term cancels the cell's own part of the model, so with `j` over the other cells whose column reaches the disk (`nb`):

```text
rc(p) = Σ_t w c_t ŷ_t(p) − Σ_{j∈nb} a_j(p) Σ_t w c_t c_{j,t} − Σ_a g_a(p) Σ_t w c_t β_{a,t} − Σ_t w c_t ℓ_t
r(p)  = Σ_t w ŷ_t(p)     − Σ_{j∈nb} a_j(p) Σ_t w c_{j,t}     − Σ_a g_a(p) Σ_t w β_{a,t}     − Σ_t w ℓ_t
Σ_t w c_t ŷ_t(p) = Σ_W Σ_k b_k(p) [ W_k(p,:) · (V_kᵀ (w ⊙ c)) + μ_k(p) Σ_t w c_t ]
Σ_t w ŷ_t(p)     = Σ_W Σ_k b_k(p) [ W_k(p,:) · (V_kᵀ w)       + μ_k(p) Σ_t w ]
```

and the same with `w` restricted to the half's frames. Only the first part of each line reads the factors; the rest are sums of traces (`Σ c_i c_j`, `Σ c_i ℓ_i`, `Σ ℓ_i`, `Σ c_i β_a`, `Σ c_j`, `Σ β_a`), because the library is fixed within the iteration. No frame is rebuilt for the statistics.

What is precomputed where:

- **per window and tile** (shared by all cells): `u = V_kᵀ w` and its half (`2 r` numbers from `T r` multiply-adds), then for every pixel of the tile `b_k(p) (W_k(p,:)·u + μ_k(p) Σw)` into a frame-sized map of `Σ_t w ŷ_t(p)` (f64, full and half);
- **per window, tile and cell under the tile**: `V_kᵀ (w ⊙ c)` and its half (`2 T r`), then `2 r` multiply-adds per disk pixel in the tile;
- **per window and cell**: the trace sums over the window's fitting frames (neighbour products, ring and basis sums, moments), added to the totals; kept for the window only when the cell has a pixel left out there (below);
- **per iteration and cell, at the end**: `column_on` of each neighbour on the disk once, and the assembly above.

Missing samples (spec §1, A7, A8): a factor frame has no missing sample; a missing sample was stored as the pixel's mean over the window and a pixel with no valid sample as 0. The blended valid share of pixel `p` in a window is `Σ_k b_k(p) valid_k(p)`.

- Below `MIN_VALID_SHARE` (0.1, the constant `fpstats.rs` already uses) the pixel is left out of that window's statistics: its data part is not added, the window's trace sums are taken back out of its model, level and basis parts, and the cell gets per-pixel moments without that window, exactly what the frame route does with a pixel that is NaN in all of the window's frames. In the held-out patches the pixel is missing (zero weight in the patch solve), as the reservoir stores a NaN.
- From 0.1 to 1 the pixel's window mean enters as data, which pulls its estimate toward 0 by about the missing share (its covariance with the trace is diluted). Cells with such a pixel are counted (`IterationReport::low_valid`, threshold 0.999 for blending rounding) and the report gives the border cells separately, as phase 2 did. They are not corrected.

### Which statistics path

`FpStats` has no forgetting of its own: the forgetting is the slow loop's weight `stats_w`, which `update_fpstats` raises each frame and renormalises with `FpStats::scale`. Its sums are `pub(crate)` fields, so the factor route builds a fresh `FpStats` per cell and iteration (`FpStats::new` on the same disk as `update_fpstats` would create, `col` and `version` set as there) and writes the sums with weight 1, which is what the frame route gives with an infinite half-life (`stats_gamma` 1). Nothing in `FpStats` changes; `add_mom` becomes `pub(super)` so the class moments are added in the same order with the same function (they are then bit-identical to the frame route's).

Every cell takes the statistics path. The refine visit (`refine`, `discover/mod.rs` about line 5412) is called with a `Solved` that has the tile's base problem but no fitting frames, so its reservoir path (for cells younger than `reservoir_refine_frames` whose statistics are below `stats_min_snr`) finds fewer than three active frames and proposes nothing. With every fitting frame of the recording in the sums, such cells are rare.

Refused: `core_test` other than `Off` (the transient-band sums `Fast` are an exponential moving average along the push order; not built here); in 3a, `joint_update` other than `Off` (3b).

Not needed from a frame: the noise map is the slow loop's current one, fixed for the iteration (a raw Refine pass sets it from the preprocessor every 200 frames; the harness sets it once from the preprocessor at the end of the compression replay); the ring levels are the factor solve's ring means (`FrameTraces::background`); the reservoir is not read.

The factor Extract uses the consolidated ring gradient (as phase 2's Extract; the projected solve needs it). A raw Refine pass's fast loop runs the two-walk gradient; `consolidated_ring_gradient_matches_two_walk_solver` pins that they agree to the solver's tolerance.

### The held-out comparison

The gate code is unchanged: the per-tile patch problem (`Problem`, `discover/local.rs`), solved per held-out frame on the whitened patch, its paired χ² gains over the base model, `refine_z`. It reads a frame through `Problem::solve_missing(y, qb, yy, miss)`: the column dot products, the nine bump-background projections `qb` and the patch energy `yy`. Two ways to feed it from the factors:

- **Projections** (what §5 says): each column, each of the nine bump maps and the energy projected through the window's spatial factors. The bump maps are dense over the 112 × 112 patch: `9 × 12 544 px × 2 tiles × r` per patch and window, about 27 G multiply-adds per iteration at 600 px (100 tiles, 40 windows, rank 30), and the energy is quadratic in `v_k(t)` (an `r × r` matrix per pair of tiles). The column rows of each proposal add 40 windows × the column's pixels × 2 × r.
- **Rebuilt patches** (chosen): rebuild the tile's patch for `K` held-out frames per tile from the factors (`BlendLayout::reconstruct_rect`, the same arithmetic as the frame rebuild), whiten it, mark pixels below the valid share missing, and hand the existing `Frames` to the existing `refine`. Cost `100 tiles × K × 12 544 px × 2 × r` = 3.2 G multiply-adds at `K` 43, plus 0.5 G for the bump projections, and the gate's code runs bit for bit.

**Differs from the spec: for the owner's review.** §5 says "fed with projections from the factors on the held-out frames"; this plan rebuilds the patches of `K` held-out frames per tile (at 600 px and `K` 43 about 2 % of the recording's pixel values, held for the gate: 216 MB as f32, where the raw reservoir holds 128 frames per tile as i16, 321 MB). The statistics stay frame-free.

Which held-out frames: the raw reservoir holds per tile about `frames_per_tile / holdout_every` held-out frames (128 / 3 = 43), 70 % chosen as event frames by the residual's excursions in the tile and 30 % uniformly (`random_share`). The factor route has no residual image. It takes, among the iteration's held-out frames, `K − round(random_share K)` frames where the cells whose centre is in the tile's core are most active (`Σ_i max(c_i,0)² / σ_i²`, `σ_i` the library's trace noise) and the rest uniformly by a hash of the frame index, the tile and the seed. `K` is `--test-frames` (0: `frames_per_tile / holdout_every`). **Differs from the spec's raw reference: for the owner's review** (the spec does not say how many held-out frames or which; with `refine_z` 0 the gate is "mean held-out gain above 0", so more frames make it less noisy and slower).

The held-out split moves between iterations as between raw Refine passes: an iteration reads frame `t` as slow-loop frame `base + t` (`base` = the loop's frame counter at the start) and advances the counter by the recording's length, so each iteration holds out another third. A tile with fewer than `min_test_frames` held-out frames is skipped and counted (`tiles_skipped`).

### The iteration loop and the settle stop

`SlowLoop::refine_on_factors(src, cfg) -> IterationReport` runs one iteration: pass A (Extract and sums), the choice of held-out frames, pass B (patches), install the statistics, the gate per tile (tile order, accepted edits update the working set at once as in a raw visit), advance the frame counter, publish, and measure the change. It needs `EditScope::Refine`, a published library and no pending edits; it refuses anything else before touching the loop. The installation happens after pass B, so an error in either pass leaves the loop unchanged.

The settle measure, which the spec does not define and the script of the earlier reports (`stability_gate.py`) does not hold in the repository: per cell of both libraries (by id), the Pearson correlation of the unfiltered footprints over the union of the two supports (a pixel outside a support counts 0). `changed_share` is the share of cells below `settle_corr` (or without a correlation), `median_change` the median of `1 − r`. The run has settled when `changed_share < settle_share`. `refine_until_settled` loops to `max_iterations` (default 20); the harness loops itself so it can time and write each iteration, with the same rule. **Definition chosen here: for the owner's review**; Task 6 computes the same measure on the raw arm's passes, so the 1.7 % of the refine-gate report can be compared.

Where: `crates/cala/src/discover/factor_refine.rs` (the spec names `discover/factor_refine.rs`), exported from `discover`: `FactorRefineConfig`, `FactorSource`, `RefineStage`, `IterationReport`, `Settled`, `refine_until_settled`, `footprint_change`.

### Cost per iteration (estimate, measured in Task 7)

600 × 600 px, 1000 cells, rank 30 in every tile, 40 windows of 600 frames (24 000 frames, 16 000 fitting), the offset grids (every pixel in two tiles, 221 tiles), disks of about 600 px, about 30 neighbours per cell, 100 slow-loop tiles, `K` 43:

| part                                                                                                     | per window | per iteration                |
| -------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------- |
| Extract on factors (phase 2: projector rows, projections per frame; plus the coordinate descent, as raw) | 0.2 G      | 9 G + CD                     |
| shared data sums (`V_kᵀ w` and the per-pixel rows, full and half)                                        | 0.05 G     | 2 G                          |
| per-cell data sums (`V_kᵀ c` on about 4 tiles, rows on the disk)                                         | 0.2 G      | 8.6 G                        |
| trace sums (neighbour products, moments)                                                                 | 0.03 G     | 1 G                          |
| assembly (`column_on` of the neighbours, four sums)                                                      |            | 0.3 G                        |
| held-out patches and their bump projections                                                              |            | 3.7 G                        |
| gate (one refine visit per tile on 43 frames)                                                            |            | as one raw visit per tile    |
| **total**                                                                                                |            | **about 25 G multiply-adds** |

A raw Refine pass of the same recording: the fast loop (about 1.4 M multiply-adds per frame: 34 G), `update_fpstats` (1000 × 600 × 3 per fitting frame: 29 G), the slow-loop budget (`--budget 3000000` × 24 000 frames: 72 G), plus decoding, preprocessing and motion of 24 000 frames. So an iteration is about a fifth of a raw pass's arithmetic and reads the factor files twice instead of the raw file once.

Memory held during an iteration: one window's factors (at rank 30 about 100 MB; phase 1 measured 18 to 28 MB per 600-frame window for the offset grids, a mean rank near 8), the window's traces and ring levels (600 × 1000 × 2 × 4 B = 4.8 MB), the shared sums (2 × 360 000 × 8 B = 5.8 MB), the per-cell sums (2 × 600 × 8 B per cell: 9.6 MB), the held-out activity scores (100 tiles × 8 000 frames × 16 B: 13 MB) and the held-out patches (216 MB). The installed `FpStats` are as today.

### The cluster history replay (phase 3b, decision of A8)

A cluster's store keeps, per fitting frame, `v_t = Uᵀ r̃_t` with `r̃ = is ⊙ (ŷ − m − ℓ_owner + Σ_members a_k c_k)` on the cluster's pixels, beside the sums `CY = Σ r̃ cᵀ`, `Σ r̃`, `Σ c`, `Σ c cᵀ`, `Σ w`. In a factor iteration the members' own columns cancel their part of the model, so `r̃ = is ⊙ (ŷ − Σ_{j∉members} a_j c_j − Σ_a g_a β_a − ℓ_owner(p))`, and:

- **pass A** fills `CY`, `Σ r̃` (whitened, per member trace) from the same data and trace sums as the per-cell statistics, on the union of the members' disks; `Σ c`, `Σ c cᵀ`, `Σ w` from traces. After pass A each store's basis is `U = orth(centred CY)` (`ClusterStore::cy_basis`).
- **pass B** computes each fitting frame's coordinates in that basis: `Uᵀ diag(is) ŷ_t` through the window's spatial factors (`K` rows per tile and cluster, A8's formula), minus `M c_t` (`M = Uᵀ diag(is) a_j` for the non-members whose column reaches the cluster, once per library), minus the owners' ring levels and the basis term, and appends them.
- The store is filled directly per iteration: a fresh `ClusterStore` per cluster holding every fitting frame of the iteration (no cap at the half-life, weights 1). `reexpress` is not needed within an iteration: the basis is final before the first coordinate is written, and the replay's `refresh_basis` then finds the same basis. A8: on a change of basis the coordinates are computed again from the factors (next iteration) instead of being re-expressed.
- No frame is skipped (A8): a pixel below the valid share enters as the window mean in the replay, unlike the per-cell statistics, where §1 leaves it out. **Differs between the two routes as A8 and §1 say; for the owner's review.**

### Split into 3a and 3b

3a (Tasks 1 to 7) gives a measurable result first: the per-cell statistics route, the held-out patches, the iteration and the settle stop, the harness arm and the gate run with the joint flags off. If its A1 gate fails, the design of the window passes and the gate is in question, and 3b would be built on it in vain. 3b changes the feed of the cluster stores, which Discover's joint replay and the visit jobs share (`the_cluster_replay_runs_in_visit_jobs_and_matches_step`), needs two small changes outside the new module (the store's capacity with an infinite half-life, the replay's forgetting factor in a factor gate), and its gate is the second half of A11's gate. 3b is written below as a task list with interfaces; its full plan is written after 3a's gate.

## File Structure

| File                                                                                                    | Change          | Responsibility                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `crates/cala/src/compress/blend.rs`                                                                     | modify          | `BlendLayout::reconstruct_rect`                                                                                                    |
| `crates/cala/src/discover/factor_refine.rs`                                                             | create          | the factor pass, the held-out patches, the iteration, the settle stop                                                              |
| `crates/cala/src/discover/mod.rs`                                                                       | modify          | `mod factor_refine;` and its `pub use`                                                                                             |
| `crates/cala/src/discover/fpstats.rs`                                                                   | modify          | `add_mom` becomes `pub(super)`                                                                                                     |
| `crates/cala/src/discover/tests.rs`                                                                     | modify          | the movie helpers become `pub(super)` (visibility only)                                                                            |
| `crates/cala/examples/qc_eval.rs`                                                                       | modify          | `--refine-engine`, `--settle-*`, `--max-iterations`, `--test-frames`; `FactorFiles`; the compression-only pass 2; `iterations.tsv` |
| `tools/cala-eval/factor_closeness.py`, `test_factor_closeness.py`                                       | modify          | `footprint_change`, `changed_share`, `read_truth_footprints`, `truth_fp_median`, `library_steps`, `settle_table`                   |
| `tools/cala-eval/factor_arms.py`, `test_factor_arms.py`                                                 | modify          | arms `f_chosen`, `f_null`; `iteration_table`; the report                                                                           |
| `tools/cala-eval/results/2026-11-19-factor-phase3.md`, `docs/CHANGELOG.md`, `tools/cala-eval/README.md` | create / modify | results and docs                                                                                                                   |

---

### Task 1: Rebuild a rectangle of a blended window

**Files:**

- Modify: `crates/cala/src/compress/blend.rs` (`BlendLayout`, below `reconstruct` at about line 250; tests at about line 273)

**Interfaces:**

- Consumes: `BlendLayout::{grid, weights, reconstruct}`, `WindowFactors`, `TileFactors::{x0, y0, w, h, rank, spatial, temporal, mean}` (phase 1).
- Produces: `BlendLayout::reconstruct_rect(&self, wf: &WindowFactors, t: usize, rect: (usize, usize, usize, usize), out: &mut [f32]) -> bool`. `rect` is `(x0, y0, w, h)`; `out` holds `w * h` values, row-major. Returns `false` and leaves `out` untouched when the factors are not of this layout, `t` is past the window, the rectangle leaves the frame or `out` has the wrong length.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module of `crates/cala/src/compress/blend.rs`:

```rust
    #[test]
    fn a_rectangle_is_rebuilt_as_the_frame_is() {
        let dims = Dims::new(128, 80).unwrap();
        let (frames, px) = (60, dims.pixels());
        let y = movie(dims, frames);
        for tiling in [Tiling::Plain, Tiling::Offset] {
            let cfg = CompressConfig {
                window: frames,
                k0: 8,
                tiling,
                ..CompressConfig::default()
            };
            let mut wc = WindowCompressor::new(dims, cfg);
            let wf = y.chunks_exact(px).find_map(|f| wc.push(f)).unwrap();
            let lay = BlendLayout::new(dims, 64, tiling);
            let mut full = vec![0.0f32; px];
            lay.reconstruct(&wf, 17, &mut full);
            // Inside one tile, across the lines x = 64 and y = 32, at the frame's corner.
            for rect in [(4, 4, 20, 10), (50, 20, 40, 30), (100, 60, 28, 20)] {
                let (x0, y0, w, h) = rect;
                let mut part = vec![f32::NAN; w * h];
                assert!(lay.reconstruct_rect(&wf, 17, rect, &mut part));
                for yy in 0..h {
                    for xx in 0..w {
                        assert_eq!(
                            part[yy * w + xx].to_bits(),
                            full[(y0 + yy) * dims.width + x0 + xx].to_bits(),
                            "{tiling:?} {rect:?} at ({yy}, {xx})"
                        );
                    }
                }
            }
            let mut out = vec![7.0f32; 4];
            assert!(!lay.reconstruct_rect(&wf, 17, (0, 0, 2, 3), &mut out), "length");
            assert!(!lay.reconstruct_rect(&wf, frames, (0, 0, 2, 2), &mut out), "frame");
            assert!(!lay.reconstruct_rect(&wf, 0, (127, 0, 2, 2), &mut out), "outside");
            let other = BlendLayout::new(dims, 32, tiling);
            assert!(!other.reconstruct_rect(&wf, 0, (0, 0, 2, 2), &mut out), "layout");
            assert_eq!(out, vec![7.0f32; 4], "a refused call leaves out alone");
        }
    }
```

- [ ] **Step 2: Run to see it fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::blend`
Expected: does not compile (`reconstruct_rect` is not defined).

- [ ] **Step 3: Implement**

In `impl BlendLayout`, below `reconstruct`:

```rust
    /// The rectangle `rect = (x0, y0, w, h)` of frame `t`, rebuilt into `out`
    /// (`w * h`, row-major) with the arithmetic of [`Self::reconstruct`], so
    /// equal to those pixels of the whole frame bit for bit. `false` (and
    /// `out` untouched) when `wf` is not of this layout, `t` is past the
    /// window, the rectangle leaves the frame or `out` has another length.
    pub fn reconstruct_rect(
        &self,
        wf: &WindowFactors,
        t: usize,
        rect: (usize, usize, usize, usize),
        out: &mut [f32],
    ) -> bool {
        let (rx, ry, rw, rh) = rect;
        let fits = wf.tiles.len() == self.grid.len()
            && self
                .grid
                .iter()
                .zip(&wf.tiles)
                .all(|(g, tf)| *g == (tf.x0, tf.y0, tf.w, tf.h));
        if !fits
            || t >= wf.frames
            || out.len() != rw * rh
            || rx + rw > self.dims.width
            || ry + rh > self.dims.height
        {
            return false;
        }
        out.fill(0.0);
        for (tf, wt) in wf.tiles.iter().zip(&self.weights) {
            let (x0, x1) = (rx.max(tf.x0), (rx + rw).min(tf.x0 + tf.w));
            let (y0, y1) = (ry.max(tf.y0), (ry + rh).min(tf.y0 + tf.h));
            if x0 >= x1 || y0 >= y1 {
                continue;
            }
            let v = &tf.temporal[t * tf.rank..(t + 1) * tf.rank];
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = (y - tf.y0) * tf.w + (x - tf.x0);
                    let wrow = &tf.spatial[p * tf.rank..(p + 1) * tf.rank];
                    let mut s = tf.mean[p];
                    for (a, b) in wrow.iter().zip(v) {
                        s += a * b;
                    }
                    out[(y - ry) * rw + (x - rx)] += wt[p] * s;
                }
            }
        }
        true
    }
```

The tiles are visited in the order of `reconstruct` and every output pixel starts at 0, so the sums are formed in the same order. If the plain tiling's weights are not exactly 1.0 (so that `WindowFactors::reconstruct`'s plain path and this one differ in the last bit), the test compares with `BlendLayout::reconstruct`, which it already does; report it.

- [ ] **Step 4: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings compress::blend`
Expected: all pass, the new test and, unchanged, `plain_rebuild_equals_the_window_rebuild`.

- [ ] **Step 5: Check and commit**

Run `cargo fmt --all` and the clippy command. Then:

```bash
git add crates/cala/src/compress/blend.rs
git commit -m "feat(cala): rebuild one rectangle of a blended factor window"
```

---

### Task 2: Footprint statistics from the factors

**Files:**

- Create: `crates/cala/src/discover/factor_refine.rs`
- Modify: `crates/cala/src/discover/mod.rs` (`mod factor_refine;` beside `mod fastcore;` at about line 222; `pub use` beside `pub use shard::...` at about line 239)
- Modify: `crates/cala/src/discover/fpstats.rs` (`fn add_mom` at about line 869 becomes `pub(super) fn add_mom`)
- Modify: `crates/cala/src/discover/tests.rs` (visibility only: `const N` about line 11, `fn dims` 13, `fn flattener` 17, `struct Lcg` 25 as `pub(super) struct Lcg(pub(super) u64)`, `fn trace` 62, `fn movie` 76, `fn v2_config` 243, `fn blob_w` 406 become `pub(super)`)

**Interfaces:**

- Consumes: `FpStats::{new, pix, cls, col, version, rc, r, half, m, k, pm, half_pm}`, `PixMoments`, `MIN_VALID_SHARE`, `parity_block`, `add_mom` (`fpstats.rs`); `column_on`, `SlowLoop::{fpstats, cfg, dims, fov, frames, tiles, tile_of, library}` (`discover/mod.rs`); `FactorExtractor::{new, engine_mut, solve}`, `WindowProjector::new` (phase 2); `WindowFactors::{dims, start, frames, tiles, layout}`, `BlendLayout::{grid, weights}`; `Library::{support, core_col, lowpass, block_px, background_len, trace_noise, ids, bg}`, `BgTerms`.
- Produces (this task; Tasks 3 and 4 build on them):
  - `pub trait FactorSource { fn windows(&self) -> usize; fn window(&mut self, w: usize) -> Result<WindowFactors, TraceError>; fn stage(&mut self, _stage: RefineStage) {} }`, implemented for `Vec<WindowFactors>`
  - `pub enum RefineStage { Sums, TestFrames, Gate, Publish, Done }`
  - `pub struct FactorRefineConfig { pub settle_corr: f32, pub settle_share: f32, pub max_iterations: usize, pub test_frames: usize, pub solver: SolverConfig }` with `Default` (0.99, 0.02, 20, 0, `SolverConfig::default()`) and `validate(&self) -> Result<(), TraceError>`
  - private: `struct Pass`, `struct CellPass`, `struct WinSums`, `struct Excluded`; `fn valid_map(wf: &WindowFactors, layout: &BlendLayout) -> Vec<f32>`; `fn check_window(wf: &WindowFactors, dims: Dims, start: usize) -> Result<(), TraceError>`; `impl SlowLoop { fn sum_pass(&self, lib: &Arc<Library>, src: &mut dyn FactorSource, cfg: &FactorRefineConfig) -> Result<Pass, TraceError>; fn install(&mut self, lib: &Library, pass: &Pass) }`

- [ ] **Step 1: Make the test helpers and `add_mom` visible**

In `crates/cala/src/discover/tests.rs` change only the visibility of the items listed under Files (`const N`, `dims`, `flattener`, `Lcg` and its field, `trace`, `movie`, `v2_config`, `blob_w`) to `pub(super)`; in `fpstats.rs`, `fn add_mom` to `pub(super) fn add_mom`. Run from `crates/cala`: `cargo test --no-default-features --features jsbindings discover::` Expected: all pass (nothing else changed).

- [ ] **Step 2: Write the failing test**

Create `crates/cala/src/discover/factor_refine.rs` with the module doc of Step 4, `use` lines, and this test module (the implementation follows in Step 4). Add `mod factor_refine;` to `discover/mod.rs`.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::blend::Tiling;
    use crate::compress::{CompressConfig, WindowCompressor};
    use crate::discover::tests::{blob_w, dims, flattener, movie, trace, v2_config, Lcg, N};
    use crate::discover::SlowLoopConfig;
    use crate::trace::{BackgroundModel, FrameTraces};

    pub(super) const T: usize = 1500;
    pub(super) const WIN: usize = 300;
    /// A pixel of both disks, missing in all but 10 frames of window 1:
    /// left out of that window.
    pub(super) const GONE: usize = 46 * N + 48;
    /// A pixel of the second cell's disk, missing in a third of window 2:
    /// kept with the window's mean, and counted.
    pub(super) const PART: usize = 50 * N + 50;

    pub(super) fn cfg(model: BackgroundModel) -> SlowLoopConfig {
        SlowLoopConfig {
            // The frame route without forgetting (weight 1 on every fitting frame).
            stats_half_life_frames: f32::INFINITY,
            background: model,
            ..v2_config()
        }
    }

    /// The `bitten_refill` set of `discover::tests`: two neighbours, cell 2
    /// seeded without the light under cell 1's centre, so a Refine has
    /// something to refill. The slow loop (Refine scope, library published)
    /// and the movie's factors (offset grids, 300-frame windows).
    pub(super) fn fixture(c: SlowLoopConfig) -> (SlowLoop, Vec<WindowFactors>) {
        let mut rng = Lcg(411);
        let (a, b) = ((46.0, 44.0), (46.0, 47.5));
        let cells = vec![
            (blob_w(0, a.0, a.1, 2.5), trace(&mut rng, T, 0.03, 6.0)),
            (blob_w(1, b.0, b.1, 2.5), trace(&mut rng, T, 0.03, 6.0)),
        ];
        let m = movie(&cells, T, 423);
        let mut bitten = blob_w(2, b.0, b.1, 2.5);
        for y in 0..bitten.height {
            for x in 0..bitten.width {
                let (dy, dx) = ((bitten.y0 + y) as f32 - a.0, (bitten.x0 + x) as f32 - a.1);
                if dy * dy + dx * dx <= 2.5 * 2.5 {
                    bitten.values[y * bitten.width + x] = 0.0;
                }
            }
        }
        let n_px = N * N;
        let mut sl = SlowLoop::new(dims(), vec![1; n_px], vec![1.0; n_px], flattener(), c).unwrap();
        sl.seed(&[blob_w(1, a.0, a.1, 2.5), bitten]).unwrap();
        sl.finalize().unwrap();
        sl.set_edit_scope(EditScope::Refine);
        let ccfg = CompressConfig {
            window: WIN,
            tiling: Tiling::Offset,
            ..CompressConfig::default()
        };
        let mut wc = WindowCompressor::new(dims(), ccfg);
        let mut windows = Vec::new();
        for t in 0..T {
            let mut f = m[t * n_px..(t + 1) * n_px].to_vec();
            if (WIN..2 * WIN - 10).contains(&t) {
                f[GONE] = f32::NAN;
            }
            if (2 * WIN..2 * WIN + WIN / 3).contains(&t) {
                f[PART] = f32::NAN;
            }
            if let Some(wf) = wc.push(&f) {
                windows.push(wf);
            }
        }
        windows.extend(wc.flush());
        (sl, windows)
    }

    /// The frame route: the frames rebuilt from the same factors (a pixel
    /// left out of a window is missing in all its frames), solved by the same
    /// factor engine, fed to the existing `observe_lookback`.
    pub(super) fn frame_route(sl: &mut SlowLoop, windows: &[WindowFactors], solver: SolverConfig) {
        let lib = sl.library().unwrap().clone();
        let mut ex = FactorExtractor::new(lib.clone(), solver).unwrap();
        ex.engine_mut().set_consolidated_ring_gradient(true);
        let base = sl.frames();
        let mut y = vec![0.0f32; dims().pixels()];
        let mut t0 = 0usize;
        for wf in windows {
            let proj = WindowProjector::new(&lib, wf).unwrap();
            let mut trs: Vec<FrameTraces> = Vec::new();
            ex.solve(wf, &proj, 0, wf.frames, |tr| trs.push(tr.clone()))
                .unwrap();
            let vmap = valid_map(wf, &wf.layout());
            for (t, tr) in trs.iter().enumerate() {
                wf.reconstruct(t, &mut y);
                for (v, &s) in y.iter_mut().zip(&vmap) {
                    if s < MIN_VALID_SHARE as f32 {
                        *v = f32::NAN;
                    }
                }
                sl.observe_lookback(&y, &lib, tr, base + (t0 + t) as u64, None)
                    .unwrap();
            }
            t0 += wf.frames;
        }
    }

    /// Per slot and disk pixel, over the fitting frames: the summed size of
    /// the terms the frame route adds in float32, `Σ |c| (|y| + |m| + |ℓ| +
    /// |a c|)` for `rc` and `Σ (|y| + |m| + |ℓ| + |a c|)` for `r` (the
    /// halves are bounded by the same).
    fn term_scale(sl: &SlowLoop, windows: &[WindowFactors], solver: SolverConfig) -> Vec<(Vec<f64>, Vec<f64>)> {
        let lib = sl.library().unwrap().clone();
        let n_px = dims().pixels();
        let mut ex = FactorExtractor::new(lib.clone(), solver).unwrap();
        ex.engine_mut().set_consolidated_ring_gradient(true);
        let ring = matches!(lib.background_model(), BackgroundModel::Ring { .. });
        let basis = matches!(lib.background_model(), BackgroundModel::Basis(_));
        let stats: Vec<&FpStats> = lib.ids().iter().map(|id| &sl.fpstats[id]).collect();
        let mut out: Vec<(Vec<f64>, Vec<f64>)> = stats
            .iter()
            .map(|s| (vec![0.0; s.pix.len()], vec![0.0; s.pix.len()]))
            .collect();
        let (mut y, mut m) = (vec![0.0f32; n_px], vec![0.0f32; n_px]);
        let mut t0 = 0usize;
        for wf in windows {
            let proj = WindowProjector::new(&lib, wf).unwrap();
            let mut trs: Vec<FrameTraces> = Vec::new();
            ex.solve(wf, &proj, 0, wf.frames, |tr| trs.push(tr.clone()))
                .unwrap();
            for (t, tr) in trs.iter().enumerate() {
                if sl.is_test(sl.frames() + (t0 + t) as u64) {
                    continue;
                }
                wf.reconstruct(t, &mut y);
                let bg = basis.then_some(tr.background.as_slice());
                lib.render(&tr.traces, bg, &mut m).unwrap();
                for (slot, st) in stats.iter().enumerate() {
                    let c = f64::from(tr.traces[slot]).abs();
                    let l = if ring { f64::from(tr.background[slot]).abs() } else { 0.0 };
                    for (q, &p) in st.pix.iter().enumerate() {
                        let e = f64::from(y[p as usize]).abs()
                            + f64::from(m[p as usize]).abs()
                            + l
                            + f64::from(st.col[q]).abs() * c;
                        out[slot].0[q] += c * e;
                        out[slot].1[q] += e;
                    }
                }
            }
            t0 += wf.frames;
        }
        out
    }

    fn models() -> Vec<BackgroundModel> {
        vec![
            v2_config().background,
            BackgroundModel::None,
            BackgroundModel::Basis(vec![vec![1.0; N * N]]),
        ]
    }

    #[test]
    fn statistics_from_the_factors_equal_the_frame_route_on_rebuilt_frames() {
        let rc = FactorRefineConfig::default();
        for model in models() {
            let (mut fa, windows) = fixture(cfg(model.clone()));
            let (mut fb, _) = fixture(cfg(model.clone()));
            let lib = fa.library().unwrap().clone();
            let pass = fa.sum_pass(&lib, &mut windows.clone(), &rc).unwrap();
            fa.install(&lib, &pass);
            assert_eq!(pass.frames, T);
            assert_eq!(
                pass.cells.iter().filter(|c| c.min_valid < LOW_VALID).count(),
                2,
                "both disks hold a pixel with a valid share below 1"
            );
            frame_route(&mut fb, &windows, rc.solver);
            let scale = term_scale(&fb, &windows, rc.solver);
            let libb = fb.library().unwrap().clone();
            assert_eq!(lib.ids(), libb.ids());
            for (slot, id) in lib.ids().iter().enumerate() {
                let (a, b) = (&fa.fpstats[id], &fb.fpstats[id]);
                assert_eq!(a.pix, b.pix, "{model:?} cell {id}: disk");
                assert_eq!(a.col, b.col, "{model:?} cell {id}: column");
                assert_eq!(a.m, b.m, "{model:?} cell {id}: class moments, bit for bit");
                assert_eq!(a.half.2, b.half.2, "{model:?} cell {id}: half moments");
                assert_eq!(a.k, b.k, "{model:?} cell {id}: pushes");
                assert!(a.pm.is_some() && b.pm.is_some(), "GONE lies on both disks");
                let (src, sr) = &scale[slot];
                let sums = [
                    ("rc", &a.rc, &b.rc, src),
                    ("r", &a.r, &b.r, sr),
                    ("half rc", &a.half.0, &b.half.0, src),
                    ("half r", &a.half.1, &b.half.1, sr),
                ];
                for (name, x, y, s) in sums {
                    for q in 0..x.len() {
                        let tol = 1e-4 * s[q] + 1e-3;
                        assert!(
                            f64::from((x[q] - y[q]).abs()) <= tol,
                            "{model:?} cell {id} {name} at pixel {}: {} from factors, {} from frames (tol {tol})",
                            a.pix[q],
                            x[q],
                            y[q]
                        );
                    }
                }
                for (pa, pb) in [(&a.pm, &b.pm), (&a.half_pm, &b.half_pm)] {
                    let (pa, pb) = (pa.as_ref().unwrap(), pb.as_ref().unwrap());
                    for (x, y) in [(&pa.n, &pb.n), (&pa.n2, &pb.n2), (&pa.s1, &pb.s1), (&pa.s2, &pb.s2)] {
                        for (u, v) in x.iter().zip(y) {
                            assert!((u - v).abs() <= 1e-9 * u.abs().max(1.0), "{model:?} cell {id}: {u} vs {v}");
                        }
                    }
                }
                let gone = a.pix.binary_search(&(GONE as u32)).unwrap();
                assert!(a.pm.as_ref().unwrap().n[gone] < a.m[0][0], "GONE left out of window 1");
            }
        }
    }
}
```

The tolerance `1e-4 · S + 1e-3`: both routes use the same traces (the factor engine's), so the solve does not enter, and phase 2's 1e-4 trace gap (input rounding amplified by the solve) is not part of it. What remains is the frame route's float32 arithmetic: the rebuilt frame's rounding (relative 2⁻²⁴ per pixel and frame) and the sequential float32 sums over at most 1000 fitting frames, at most `1000 × 2⁻²⁴ ≈ 6e-5` of the summed term sizes `S`; the factor route sums in float64. It is the form of phase 2's projection test (`1e-4 · s + 1e-3`). If a sum misses it, report the pixel, the two values and `S`; do not widen it.

- [ ] **Step 3: Run to see it fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings discover::factor_refine`
Expected: does not compile (`sum_pass`, `install`, `FactorRefineConfig`, `valid_map` are not defined).

- [ ] **Step 4: Implement**

The top of `crates/cala/src/discover/factor_refine.rs`:

````rust
//! Refine on factors (spec §5, phase 3): Refine iterations on the
//! compressed history, with the cell set frozen ([`EditScope::Refine`])
//! and the library fixed within an iteration.
//!
//! An iteration reads the factor windows twice. **Pass A** solves each
//! window's traces with the current library ([`FactorExtractor`]) and fills
//! every cell's footprint statistics ([`FpStats`]) from the factors and
//! those traces, over the iteration's fitting frames, with weight 1 (no
//! forgetting: the library does not change). With `ŷ_t(p) = Σ_k b_k(p)
//! (μ_k(p) + W_k(p, :) · v_k(t))` and the cell's own column cancelling its
//! part of the model,
//!
//! ```text
//! Σ c r(p) = Σ c ŷ(p) − Σ_{j≠i} a_j(p) Σ c c_j − Σ_a g_a(p) Σ c β_a − Σ c ℓ
//! Σ r(p)   = Σ ŷ(p)   − Σ_{j≠i} a_j(p) Σ c_j   − Σ_a g_a(p) Σ β_a   − Σ ℓ
//! Σ c ŷ(p) = Σ_W Σ_k b_k(p) (W_k(p, :) · V_kᵀ c + μ_k(p) Σ c)
//! ```
//!
//! (`a_j` the columns as the fast loop models them, `g_a`, `β_a` a basis
//! background, `ℓ` the cell's ring level), and the same over the split
//! half's frames. Only `Σ c ŷ` and `Σ ŷ` read the factors. A pixel whose
//! valid share in a window is below [`MIN_VALID_SHARE`] is left out of that
//! window, as a missing pixel is in the frame route.
//!
//! **Pass B** rebuilds the patches of a few held-out frames per slow-loop
//! tile from the factors; they feed the unchanged refine visit. Accepted
//! refinements are published, and [`refine_until_settled`] repeats until
//! fewer than `settle_share` of the cells moved by more than `settle_corr`.

// Index loops over cells, tiles and pixels read more clearly here.
#![allow(clippy::needless_range_loop)]

use std::collections::HashMap;
use std::sync::Arc;

use super::fpstats::{add_mom, parity_block, FpStats, Mom, PixMoments, MIN_VALID_SHARE};
use super::local::BgBasis;
use super::reservoir::{mix, take_missing};
use super::{column_on, CoreTest, EditScope, Frames, JointUpdate, SlowLoop, Solved};
use crate::compress::blend::BlendLayout;
use crate::compress::project::{FactorExtractor, WindowProjector};
use crate::compress::WindowFactors;
use crate::preprocess::Dims;
use crate::trace::{BgTerms, Library, SolverConfig, TraceError};

/// A valid share below this (and not below [`MIN_VALID_SHARE`]) marks a
/// pixel whose window mean entered as data (1 up to the blending's rounding).
pub(crate) const LOW_VALID: f32 = 0.999;
````

The public types:

```rust
/// The stages of an iteration, reported to [`FactorSource::stage`] as they start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefineStage {
    /// Pass A: Extract on factors and the statistics.
    Sums,
    /// Pass B: the held-out patches.
    TestFrames,
    /// The refine visit of every tile.
    Gate,
    /// Publish and measure the change.
    Publish,
    /// The iteration is over.
    Done,
}

/// The compressed history a factor Refine reads: the windows of one
/// recording in frame order, from frame 0. Each window is read twice per
/// iteration.
pub trait FactorSource {
    fn windows(&self) -> usize;
    /// Window `w` (`0..windows()`).
    fn window(&mut self, w: usize) -> Result<WindowFactors, TraceError>;
    /// Called as an iteration enters `stage` (for the caller's timing).
    fn stage(&mut self, _stage: RefineStage) {}
}

impl FactorSource for Vec<WindowFactors> {
    fn windows(&self) -> usize {
        self.len()
    }

    fn window(&mut self, w: usize) -> Result<WindowFactors, TraceError> {
        self.get(w)
            .cloned()
            .ok_or_else(|| TraceError::InvalidConfig(format!("no factor window {w}")))
    }
}

/// Settings of Refine on factors (spec §5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FactorRefineConfig {
    /// A cell has settled when its footprint correlates at least this much
    /// with its footprint of the previous iteration.
    pub settle_corr: f32,
    /// The run has settled when fewer than this share of the cells have not.
    pub settle_share: f32,
    /// At most this many iterations.
    pub max_iterations: usize,
    /// Held-out frames per slow-loop tile for the gate; 0: what a tile's
    /// reservoir holds on average (`frames_per_tile / holdout_every`).
    pub test_frames: usize,
    /// The trace solver of the iteration's Extract.
    pub solver: SolverConfig,
}

impl Default for FactorRefineConfig {
    fn default() -> FactorRefineConfig {
        FactorRefineConfig {
            settle_corr: 0.99,
            settle_share: 0.02,
            max_iterations: 20,
            test_frames: 0,
            solver: SolverConfig::default(),
        }
    }
}

impl FactorRefineConfig {
    pub fn validate(&self) -> Result<(), TraceError> {
        let ok = self.settle_corr > 0.0
            && self.settle_corr <= 1.0
            && (0.0..=1.0).contains(&self.settle_share)
            && self.max_iterations >= 1;
        if ok {
            self.solver.validate()
        } else {
            Err(TraceError::InvalidConfig(format!("{self:?}")))
        }
    }
}
```

If `SolverConfig::validate` (`trace/solver.rs` about line 33) is not `pub`, use `TraceEngine::new`'s check instead (it runs in `sum_pass` anyway) and say so in your report.

The pass's state:

```rust
/// Trace sums of one cell over a set of fitting frames, `[full, half]`.
#[derive(Debug, Clone)]
struct WinSums {
    /// `[Σ w, Σ w², Σ c, Σ c²]` (w = 1).
    mom: [[f64; 4]; 2],
    /// `Σ c c_j` for the neighbours `j`.
    g: [Vec<f64>; 2],
    /// `Σ c ℓ` and `Σ ℓ` (the ring level; 0 without a ring).
    lc: [f64; 2],
    l1: [f64; 2],
    /// `Σ c β_a` per basis map.
    bc: [Vec<f64>; 2],
}

impl WinSums {
    fn new(nb: usize, k: usize) -> WinSums {
        WinSums {
            mom: [[0.0; 4]; 2],
            g: [vec![0.0; nb], vec![0.0; nb]],
            lc: [0.0; 2],
            l1: [0.0; 2],
            bc: [vec![0.0; k], vec![0.0; k]],
        }
    }

    fn add(&mut self, o: &WinSums) {
        for h in 0..2 {
            for j in 0..4 {
                self.mom[h][j] += o.mom[h][j];
            }
            for (a, b) in self.g[h].iter_mut().zip(&o.g[h]) {
                *a += b;
            }
            for (a, b) in self.bc[h].iter_mut().zip(&o.bc[h]) {
                *a += b;
            }
            self.lc[h] += o.lc[h];
            self.l1[h] += o.l1[h];
        }
    }
}

/// A window in which some of a cell's disk pixels were left out: those
/// pixels (indices into the disk), the cell's trace sums over the window,
/// and the window's `Σ c_j` (for the neighbours) and `Σ β_a`.
#[derive(Debug, Clone)]
struct Excluded {
    px: Vec<usize>,
    sums: WinSums,
    s: [Vec<f64>; 2],
    b1: [Vec<f64>; 2],
}

/// One cell's part of pass A.
#[derive(Debug, Clone)]
struct CellPass {
    /// Disk, classes, column and version set; the sums are written by `install`.
    st: FpStats,
    /// `[x0, y0, x1, y1)` around the disk.
    bx: [usize; 4],
    /// Slots of the other cells whose column can reach the disk.
    nb: Vec<usize>,
    /// `Σ c ŷ(p)` per disk pixel, `[full, half]`.
    dc: [Vec<f64>; 2],
    /// The class moments as `FpStats::push` adds them, `[full, half]`.
    m: [Mom; 2],
    tot: WinSums,
    excl: Vec<Excluded>,
    /// Smallest valid share of a disk pixel in any window.
    min_valid: f32,
}

/// What pass A gives.
struct Pass {
    cells: Vec<CellPass>,
    /// `Σ ŷ(p)` per frame pixel, `[full, half]`.
    d: [Vec<f64>; 2],
    /// `Σ c_j` per slot and `Σ β_a` per basis map, `[full, half]`.
    s: [Vec<f64>; 2],
    b1: [Vec<f64>; 2],
    /// Per slow-loop tile: its held-out frames, `(activity, frame, slow-loop index)`.
    scores: Vec<Vec<(f32, usize, u64)>>,
    /// Per slow-loop tile: whether a cell's centre lies in its core.
    has_cells: Vec<bool>,
    frames: usize,
    fitting: u64,
}
```

Helpers:

```rust
/// Per frame pixel: the blended share of the window's frames in which it
/// was not missing, `Σ_k b_k(p) valid_k(p)`.
fn valid_map(wf: &WindowFactors, layout: &BlendLayout) -> Vec<f32> {
    let width = wf.dims.width;
    let mut v = vec![0.0f32; wf.dims.pixels()];
    for (tf, wt) in wf.tiles.iter().zip(layout.weights()) {
        for y in 0..tf.h {
            for x in 0..tf.w {
                let p = y * tf.w + x;
                v[(tf.y0 + y) * width + tf.x0 + x] += wt[p] * tf.valid[p];
            }
        }
    }
    v
}

/// The window `wf` is the next one of a recording of frame size `dims`, at
/// frame `start`, and its tiles are those of its layout with arrays of the
/// right lengths.
fn check_window(wf: &WindowFactors, dims: Dims, start: usize) -> Result<(), TraceError> {
    if wf.dims != dims {
        return Err(TraceError::Incompatible(format!(
            "factors of {:?}, slow loop of {:?}",
            wf.dims, dims
        )));
    }
    if wf.frames == 0 || wf.start != start as u64 {
        return Err(TraceError::InvalidConfig(format!(
            "a window of {} frames at frame {}, expected one at {start}",
            wf.frames, wf.start
        )));
    }
    let layout = wf.layout();
    let fits = layout.grid().len() == wf.tiles.len()
        && layout.grid().iter().zip(&wf.tiles).all(|(g, t)| {
            let px = t.w * t.h;
            *g == (t.x0, t.y0, t.w, t.h)
                && t.spatial.len() == px * t.rank
                && t.temporal.len() == wf.frames * t.rank
                && t.mean.len() == px
                && t.valid.len() == px
        });
    if !fits {
        return Err(TraceError::InvalidConfig(
            "the tiles of the factors do not fit their layout".into(),
        ));
    }
    Ok(())
}

/// `[x0, y0, x1, y1)` around pixels `pix` (no pixel: a box that meets nothing).
fn pixel_box(pix: &[u32], width: usize) -> [usize; 4] {
    let mut b = [usize::MAX, usize::MAX, 0, 0];
    for &q in pix {
        let (y, x) = (q as usize / width, q as usize % width);
        b = [b[0].min(x), b[1].min(y), b[2].max(x + 1), b[3].max(y + 1)];
    }
    b
}

/// The box of cell `j`'s column as the fast loop models it: its support and
/// its moat's blocks.
fn column_box(lib: &Library, j: usize, width: usize, height: usize) -> [usize; 4] {
    let mut b = pixel_box(lib.core_col(j).0, width);
    let bs = lib.block_px();
    if bs > 0 {
        let gw = width.div_ceil(bs);
        for &blk in lib.lowpass(j).0 {
            let (by, bx) = (blk as usize / gw, blk as usize % gw);
            b = [
                b[0].min(bx * bs),
                b[1].min(by * bs),
                b[2].max(((bx + 1) * bs).min(width)),
                b[3].max(((by + 1) * bs).min(height)),
            ];
        }
    }
    b
}

fn boxes_meet(a: &[usize; 4], b: &[usize; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

/// Whether box `a` meets the tile `g = (x0, y0, w, h)`.
fn meets(a: &[usize; 4], g: (usize, usize, usize, usize)) -> bool {
    a[0] < g.0 + g.2 && g.0 < a[2] && a[1] < g.1 + g.3 && g.1 < a[3]
}
```

Pass A and the installation, in `impl SlowLoop` in the same file:

```rust
impl SlowLoop {
    /// Pass A of an iteration (see the module docs): Extract on factors with
    /// `lib`, and every cell's statistics sums. Reads the loop, changes nothing.
    fn sum_pass(
        &self,
        lib: &Arc<Library>,
        src: &mut dyn FactorSource,
        cfg: &FactorRefineConfig,
    ) -> Result<Pass, TraceError> {
        let dims = self.dims;
        if lib.dims() != dims {
            return Err(TraceError::Incompatible("library of another frame size".into()));
        }
        let (width, height, n_px) = (dims.width, dims.height, dims.pixels());
        let n = lib.len();
        let margin = self.cfg.stats_margin_cells * self.cfg.cell_diameter_px;
        let blk = parity_block(self.cfg.cell_diameter_px);
        let k_bg = match &lib.bg {
            BgTerms::Basis { k, .. } => *k,
            _ => 0,
        };
        let ring = matches!(lib.bg, BgTerms::Ring { .. });
        let nbg = lib.background_len();
        let noise = lib.trace_noise();

        // Every cell's disk, as `update_fpstats` creates it for this library.
        let col_box: Vec<[usize; 4]> = (0..n).map(|j| column_box(lib, j, width, height)).collect();
        let mut cells: Vec<CellPass> = (0..n)
            .map(|i| {
                let (center, radius) = lib.support(i);
                let mut st = FpStats::new(center, radius + margin, width, height, &self.fov, false, blk);
                st.col = column_on(lib, i, &st.pix);
                st.version = lib.version();
                let bx = pixel_box(&st.pix, width);
                let len = st.pix.len();
                CellPass {
                    st,
                    bx,
                    nb: Vec::new(),
                    dc: [vec![0.0; len], vec![0.0; len]],
                    m: [[0.0; 6]; 2],
                    tot: WinSums::new(0, k_bg),
                    excl: Vec::new(),
                    min_valid: 1.0,
                }
            })
            .collect();
        for i in 0..n {
            let nb: Vec<usize> = (0..n)
                .filter(|&j| j != i && boxes_meet(&col_box[j], &cells[i].bx))
                .collect();
            cells[i].tot = WinSums::new(nb.len(), k_bg);
            cells[i].nb = nb;
        }
        // The cells each slow-loop tile refines (centre in its core).
        let mut core_cells: Vec<Vec<usize>> = vec![Vec::new(); self.tiles.len()];
        for i in 0..n {
            let (c, _) = lib.support(i);
            if let Some(ti) = self.tile_of(c.0, c.1) {
                core_cells[ti].push(i);
            }
        }

        let mut ex = FactorExtractor::new(lib.clone(), cfg.solver)?;
        ex.engine_mut().set_consolidated_ring_gradient(true);
        let base = self.frames;
        let mut pass = Pass {
            cells: Vec::new(),
            d: [vec![0.0; n_px], vec![0.0; n_px]],
            s: [vec![0.0; n], vec![0.0; n]],
            b1: [vec![0.0; k_bg], vec![0.0; k_bg]],
            scores: vec![Vec::new(); self.tiles.len()],
            has_cells: core_cells.iter().map(|c| !c.is_empty()).collect(),
            frames: 0,
            fitting: 0,
        };
        let (mut cw, mut bw): (Vec<f32>, Vec<f32>) = (Vec::new(), Vec::new());
        for w in 0..src.windows() {
            let wf = src.window(w)?;
            check_window(&wf, dims, pass.frames)?;
            let proj = WindowProjector::new(lib, &wf)?;
            cw.clear();
            bw.clear();
            ex.solve(&wf, &proj, 0, wf.frames, |tr| {
                cw.extend_from_slice(&tr.traces);
                bw.extend_from_slice(&tr.background);
            })?;
            let frames = wf.frames;
            if cw.len() != frames * n || bw.len() != frames * nbg {
                return Err(TraceError::InvalidConfig(format!("window {w}: the solve skipped frames")));
            }
            if let Some(v) = cw.iter().chain(&bw).find(|v| !v.is_finite()) {
                return Err(TraceError::InvalidConfig(format!("window {w}: a non-finite trace ({v})")));
            }

            // The held-out split (the slow loop's hash of its frame index) and
            // the split half (alternate 256-frame blocks of the fitting frames).
            let (mut fit, mut half) = (vec![false; frames], vec![false; frames]);
            for t in 0..frames {
                let slow = base + (pass.frames + t) as u64;
                if self.cfg.is_test(slow) {
                    for (ti, cs) in core_cells.iter().enumerate() {
                        if cs.is_empty() {
                            continue;
                        }
                        let a: f32 = cs
                            .iter()
                            .map(|&i| {
                                let z = cw[t * n + i].max(0.0) / noise[i].max(1e-12);
                                z * z
                            })
                            .sum();
                        pass.scores[ti].push((a, pass.frames + t, slow));
                    }
                } else {
                    fit[t] = true;
                    half[t] = (pass.fitting / 256).is_multiple_of(2);
                    pass.fitting += 1;
                }
            }
            let layout = wf.layout();
            let vmap = valid_map(&wf, &layout);

            // Trace sums of the window.
            let mut win: Vec<WinSums> = cells.iter().map(|c| WinSums::new(c.nb.len(), k_bg)).collect();
            let mut ws = [vec![0.0f64; n], vec![0.0f64; n]];
            let mut wb = [vec![0.0f64; k_bg], vec![0.0f64; k_bg]];
            for t in 0..frames {
                if !fit[t] {
                    continue;
                }
                let c = &cw[t * n..(t + 1) * n];
                let bg = &bw[t * nbg..(t + 1) * nbg];
                let hs = 1 + usize::from(half[t]);
                for h in 0..hs {
                    for (o, &x) in ws[h].iter_mut().zip(c) {
                        *o += f64::from(x);
                    }
                    if k_bg > 0 {
                        for (o, &x) in wb[h].iter_mut().zip(bg) {
                            *o += f64::from(x);
                        }
                    }
                }
                for (i, cp) in cells.iter_mut().enumerate() {
                    let ci = f64::from(c[i]);
                    // As `FpStats::push` adds them (w = 1, z = x = c).
                    add_mom(&mut cp.m[0], 1.0, ci, ci);
                    if half[t] {
                        add_mom(&mut cp.m[1], 1.0, ci, ci);
                    }
                    let lv = if ring { f64::from(bg[i]) } else { 0.0 };
                    let s = &mut win[i];
                    for h in 0..hs {
                        s.mom[h][0] += 1.0;
                        s.mom[h][1] += 1.0;
                        s.mom[h][2] += ci;
                        s.mom[h][3] += ci * ci;
                        s.lc[h] += ci * lv;
                        s.l1[h] += lv;
                        if ci != 0.0 {
                            for (o, &j) in s.g[h].iter_mut().zip(&cp.nb) {
                                *o += ci * f64::from(c[j]);
                            }
                            if k_bg > 0 {
                                for (o, &x) in s.bc[h].iter_mut().zip(bg) {
                                    *o += ci * f64::from(x);
                                }
                            }
                        }
                    }
                }
            }

            // Data sums: per tile the time sums of its temporal factors,
            // then one row per pixel (shared), and per cell under the tile.
            for (tf, wt) in wf.tiles.iter().zip(layout.weights()) {
                let r = tf.rank;
                let g = (tf.x0, tf.y0, tf.w, tf.h);
                let mut u = [vec![0.0f64; r], vec![0.0f64; r]];
                let mut cnt = [0.0f64; 2];
                for t in 0..frames {
                    if !fit[t] {
                        continue;
                    }
                    let v = &tf.temporal[t * r..(t + 1) * r];
                    for h in 0..1 + usize::from(half[t]) {
                        cnt[h] += 1.0;
                        for (o, &x) in u[h].iter_mut().zip(v) {
                            *o += f64::from(x);
                        }
                    }
                }
                for y in 0..tf.h {
                    for x in 0..tf.w {
                        let q = (tf.y0 + y) * width + tf.x0 + x;
                        if vmap[q] < MIN_VALID_SHARE as f32 {
                            continue;
                        }
                        let p = y * tf.w + x;
                        let row = &tf.spatial[p * r..(p + 1) * r];
                        let (b, mu) = (f64::from(wt[p]), f64::from(tf.mean[p]));
                        for h in 0..2 {
                            let s: f64 = row.iter().zip(&u[h]).map(|(&a, &c)| f64::from(a) * c).sum();
                            pass.d[h][q] += b * (s + mu * cnt[h]);
                        }
                    }
                }
                for (slot, cp) in cells.iter_mut().enumerate() {
                    if !meets(&cp.bx, g) {
                        continue;
                    }
                    let mut uc = [vec![0.0f64; r], vec![0.0f64; r]];
                    let mut sc = [0.0f64; 2];
                    for t in 0..frames {
                        let c = f64::from(cw[t * n + slot]);
                        if !fit[t] || c == 0.0 {
                            continue;
                        }
                        let v = &tf.temporal[t * r..(t + 1) * r];
                        for h in 0..1 + usize::from(half[t]) {
                            sc[h] += c;
                            for (o, &x) in uc[h].iter_mut().zip(v) {
                                *o += c * f64::from(x);
                            }
                        }
                    }
                    for (i, &pg) in cp.st.pix.iter().enumerate() {
                        let (py, px) = (pg as usize / width, pg as usize % width);
                        let inside = px >= g.0 && px < g.0 + g.2 && py >= g.1 && py < g.1 + g.3;
                        if !inside || vmap[pg as usize] < MIN_VALID_SHARE as f32 {
                            continue;
                        }
                        let p = (py - g.1) * g.2 + (px - g.0);
                        let row = &tf.spatial[p * r..(p + 1) * r];
                        let (b, mu) = (f64::from(wt[p]), f64::from(tf.mean[p]));
                        for h in 0..2 {
                            let s: f64 = row.iter().zip(&uc[h]).map(|(&a, &c)| f64::from(a) * c).sum();
                            cp.dc[h][i] += b * (s + mu * sc[h]);
                        }
                    }
                }
            }

            // Pixels left out of this window, and the totals.
            for (i, cp) in cells.iter_mut().enumerate() {
                let mut px = Vec::new();
                for (q, &p) in cp.st.pix.iter().enumerate() {
                    let v = vmap[p as usize];
                    cp.min_valid = cp.min_valid.min(v);
                    if v < MIN_VALID_SHARE as f32 {
                        px.push(q);
                    }
                }
                cp.tot.add(&win[i]);
                if !px.is_empty() {
                    let s = [0, 1].map(|h| cp.nb.iter().map(|&j| ws[h][j]).collect::<Vec<f64>>());
                    cp.excl.push(Excluded {
                        px,
                        sums: win[i].clone(),
                        s,
                        b1: wb.clone(),
                    });
                }
            }
            for h in 0..2 {
                for (o, x) in pass.s[h].iter_mut().zip(&ws[h]) {
                    *o += x;
                }
                for (o, x) in pass.b1[h].iter_mut().zip(&wb[h]) {
                    *o += x;
                }
            }
            pass.frames += frames;
        }
        pass.cells = cells;
        Ok(pass)
    }

    /// The statistics of pass A as every cell's [`FpStats`] (replacing the
    /// loop's), as the frame route would leave them after the same frames
    /// with an infinite half-life.
    fn install(&mut self, lib: &Library, pass: &Pass) {
        let n_px = self.dims.pixels();
        let (k_bg, maps): (usize, &[f32]) = match &lib.bg {
            BgTerms::Basis { k, maps, .. } => (*k, maps.as_slice()),
            _ => (0, &[]),
        };
        let mut out: HashMap<u64, FpStats> = HashMap::with_capacity(pass.cells.len());
        for (slot, cp) in pass.cells.iter().enumerate() {
            let pix = &cp.st.pix;
            let len = pix.len();
            let cols: Vec<Vec<f32>> = cp.nb.iter().map(|&j| column_on(lib, j, pix)).collect();
            let map = |a: usize, q: usize| f64::from(maps[a * n_px + pix[q] as usize]);
            let mut rc = [vec![0.0f64; len], vec![0.0f64; len]];
            let mut r = [vec![0.0f64; len], vec![0.0f64; len]];
            for h in 0..2 {
                for q in 0..len {
                    let mut a = cp.dc[h][q] - cp.tot.lc[h];
                    let mut b = pass.d[h][pix[q] as usize] - cp.tot.l1[h];
                    for (jj, &j) in cp.nb.iter().enumerate() {
                        let v = f64::from(cols[jj][q]);
                        if v != 0.0 {
                            a -= v * cp.tot.g[h][jj];
                            b -= v * pass.s[h][j];
                        }
                    }
                    for ai in 0..k_bg {
                        let g = map(ai, q);
                        a -= g * cp.tot.bc[h][ai];
                        b -= g * pass.b1[h][ai];
                    }
                    rc[h][q] = a;
                    r[h][q] = b;
                }
                // A pixel left out of a window: its data part was never
                // added, so take that window's trace terms back out.
                for e in &cp.excl {
                    for &q in &e.px {
                        let mut a = e.sums.lc[h];
                        let mut b = e.sums.l1[h];
                        for jj in 0..cp.nb.len() {
                            let v = f64::from(cols[jj][q]);
                            a += v * e.sums.g[h][jj];
                            b += v * e.s[h][jj];
                        }
                        for ai in 0..k_bg {
                            let g = map(ai, q);
                            a += g * e.sums.bc[h][ai];
                            b += g * e.b1[h][ai];
                        }
                        rc[h][q] += a;
                        r[h][q] += b;
                    }
                }
            }
            let to32 = |v: &[f64]| v.iter().map(|&x| x as f32).collect::<Vec<f32>>();
            let mut st = cp.st.clone();
            st.rc = to32(&rc[0]);
            st.r = to32(&r[0]);
            st.half = (to32(&rc[1]), to32(&r[1]), [cp.m[1]; 2]);
            st.m = [cp.m[0]; 2];
            st.k = pass.fitting;
            if !cp.excl.is_empty() {
                let pm = |h: usize| {
                    let m = cp.m[h];
                    let mut p = PixMoments {
                        n: vec![m[0]; len],
                        n2: vec![m[1]; len],
                        s1: vec![m[2]; len],
                        s2: vec![m[3]; len],
                    };
                    for e in &cp.excl {
                        for &q in &e.px {
                            p.n[q] -= e.sums.mom[h][0];
                            p.n2[q] -= e.sums.mom[h][1];
                            p.s1[q] -= e.sums.mom[h][2];
                            p.s2[q] -= e.sums.mom[h][3];
                        }
                    }
                    p
                };
                st.pm = Some(pm(0));
                st.half_pm = Some(pm(1));
            }
            out.insert(lib.ids()[slot], st);
        }
        self.fpstats = out;
    }
}
```

`Mom` is `pub(crate)` in `fpstats.rs`; if `PixMoments`'s fields or `Mom` are not reachable from this module, make them `pub(crate)` (visibility only) and say so. `SlowLoop::tile_of` (`discover/mod.rs` about line 2504) is private to `discover` and so visible here.

- [ ] **Step 5: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings discover::factor_refine`
Expected: the test passes for all three background models. A model that fails alone points at its term (the ring level, the basis sums); a failure only at `GONE` points at the exclusion; report the numbers.

- [ ] **Step 6: Check and commit**

Run `cargo fmt --all`, the clippy command and the whole test suite (the bit-identity tests of Global Constraints among them). Then:

```bash
git add crates/cala/src/discover
git commit -m "feat(cala): footprint statistics of a Refine iteration from the factors, equal to the frame route on rebuilt frames"
```

---

### Task 3: Held-out frames from the factors

**Files:**

- Modify: `crates/cala/src/discover/factor_refine.rs`

**Interfaces:**

- Consumes: `Pass::{scores, frames}` (Task 2); `BlendLayout::reconstruct_rect` (Task 1); `Frames`, `BgBasis::{new, project}`, `take_missing`, `mix`, `SlowLoop::{tiles, bgs, inv_sigma, plan, cfg}`.
- Produces (private): `fn test_count(&self, cfg: &FactorRefineConfig) -> usize`; `fn pick_tests(&self, scores: &[Vec<(f32, usize, u64)>], k: usize) -> Vec<Vec<(usize, u64)>>` (per tile, `(frame, slow-loop index)` sorted by frame); `fn test_frames(&mut self, src: &mut dyn FactorSource, pick: &[Vec<(usize, u64)>], t_len: usize) -> Result<Vec<Frames>, TraceError>` (one `Frames` per tile, the patches whitened, pixels below the valid share in `miss`).

- [ ] **Step 1: Write the failing tests**

Add to the test module of `factor_refine.rs`:

```rust
    #[test]
    fn held_out_patches_are_the_whitened_rebuilt_frames() {
        let (mut sl, windows) = fixture(cfg(v2_config().background));
        let rc = FactorRefineConfig::default();
        let lib = sl.library().unwrap().clone();
        let mut src = windows.clone();
        let pass = sl.sum_pass(&lib, &mut src, &rc).unwrap();
        let k = sl.test_count(&rc);
        assert_eq!(k, (sl.plan.frames_per_tile as f64 / 3.0).round() as usize);
        let pick = sl.pick_tests(&pass.scores, k);
        assert_eq!(pick, sl.pick_tests(&pass.scores, k), "deterministic");
        for (ti, p) in pick.iter().enumerate() {
            assert!(p.len() <= k);
            assert!(p.windows(2).all(|w| w[0].0 < w[1].0), "sorted, no repeat");
            assert!(p.iter().all(|&(t, slow)| sl.is_test(slow) && slow == sl.frames() + t as u64));
            if pass.scores[ti].len() >= k {
                assert_eq!(p.len(), k);
                // The event part holds the most active frame of the tile.
                let top = pass.scores[ti].iter().max_by(|a, b| a.0.total_cmp(&b.0).then(b.1.cmp(&a.1))).unwrap();
                assert!(p.iter().any(|&(t, _)| t == top.1));
            }
        }
        let frames = sl.test_frames(&mut src, &pick, pass.frames).unwrap();
        assert_eq!(frames.len(), sl.tiles.len());
        let mut full = vec![0.0f32; dims().pixels()];
        for (ti, fr) in frames.iter().enumerate() {
            assert_eq!(fr.len(), pick[ti].len());
            let rect = sl.tiles[ti].rect;
            for (j, &(t, slow)) in pick[ti].iter().enumerate() {
                assert_eq!(fr.idx[j], slow);
                let (w, tw) = (t / WIN, t % WIN);
                windows[w].layout().reconstruct(&windows[w], tw, &mut full);
                let vmap = valid_map(&windows[w], &windows[w].layout());
                for yy in 0..rect.h {
                    for xx in 0..rect.w {
                        let g = (rect.y0 + yy) * N + rect.x0 + xx;
                        let l = yy * rect.w + xx;
                        let gone = vmap[g] < MIN_VALID_SHARE as f32;
                        assert_eq!(fr.miss[j].binary_search(&(l as u32)).is_ok(), gone, "tile {ti} frame {t} pixel {g}");
                        let want = if gone { 0.0 } else { full[g] * sl.inv_sigma[g] };
                        assert_eq!(fr.y[j][l].to_bits(), want.to_bits(), "tile {ti} frame {t} pixel {g}");
                    }
                }
                assert_eq!(fr.proj[j], sl.bgs[ti].as_ref().unwrap().project(&fr.y[j]));
            }
        }
        // A source that lost a window between the passes is refused.
        let mut short = windows[..windows.len() - 1].to_vec();
        assert!(sl.test_frames(&mut short, &pick, pass.frames).is_err());
    }
```

- [ ] **Step 2: Run to see it fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings discover::factor_refine`
Expected: does not compile (`test_count`, `pick_tests`, `test_frames`).

- [ ] **Step 3: Implement**

In `impl SlowLoop` of `factor_refine.rs`:

```rust
    /// Held-out frames per tile for the gate: `cfg.test_frames`, or what a
    /// tile's reservoir holds on average.
    fn test_count(&self, cfg: &FactorRefineConfig) -> usize {
        if cfg.test_frames > 0 {
            cfg.test_frames
        } else {
            let k = self.plan.frames_per_tile as f64 / f64::from(self.cfg.holdout_every);
            (k.round() as usize).max(1)
        }
    }

    /// Per tile, `k` of its held-out frames: the share `1 − random_share`
    /// where its cells are most active, the rest uniformly (a hash of the
    /// frame, the tile and the seed); `(frame, slow-loop index)` by frame.
    fn pick_tests(&self, scores: &[Vec<(f32, usize, u64)>], k: usize) -> Vec<Vec<(usize, u64)>> {
        let k_r = ((k as f32 * self.cfg.random_share).round() as usize).min(k);
        let k_e = k - k_r;
        scores
            .iter()
            .enumerate()
            .map(|(ti, s)| {
                let mut ev: Vec<&(f32, usize, u64)> = s.iter().collect();
                ev.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
                let mut out: Vec<(usize, u64)> = ev.iter().take(k_e).map(|e| (e.1, e.2)).collect();
                let key = |slow: u64| mix(slow ^ ((ti as u64) << 40) ^ self.cfg.seed);
                let mut rest: Vec<&(f32, usize, u64)> = ev.into_iter().skip(k_e).collect();
                rest.sort_by_key(|e| (key(e.2), e.1));
                out.extend(rest.iter().take(k_r).map(|e| (e.1, e.2)));
                out.sort_unstable();
                out
            })
            .collect()
    }

    /// Pass B: the chosen held-out frames of every tile, its patch rebuilt
    /// from the factors and whitened as the reservoir stores a frame
    /// (`y · σ⁻¹`; a pixel below the valid share missing). `t_len`: the
    /// frames pass A read.
    fn test_frames(
        &mut self,
        src: &mut dyn FactorSource,
        pick: &[Vec<(usize, u64)>],
        t_len: usize,
    ) -> Result<Vec<Frames>, TraceError> {
        let dims = self.dims;
        let width = dims.width;
        for ti in 0..self.tiles.len() {
            if self.bgs[ti].is_none() {
                self.bgs[ti] = Some(BgBasis::new(self.tiles[ti].rect));
            }
        }
        let mut out: Vec<Frames> = (0..self.tiles.len())
            .map(|_| Frames {
                y: Vec::new(),
                proj: Vec::new(),
                idx: Vec::new(),
                miss: Vec::new(),
            })
            .collect();
        let mut t0 = 0usize;
        for w in 0..src.windows() {
            let wf = src.window(w)?;
            check_window(&wf, dims, t0)?;
            let layout = wf.layout();
            let vmap = valid_map(&wf, &layout);
            for (ti, chosen) in pick.iter().enumerate() {
                let rect = self.tiles[ti].rect;
                let bg = self.bgs[ti].as_ref().expect("set above");
                for &(t, slow) in chosen.iter().filter(|c| c.0 >= t0 && c.0 < t0 + wf.frames) {
                    let mut v = vec![0.0f32; rect.len()];
                    if !layout.reconstruct_rect(&wf, t - t0, (rect.x0, rect.y0, rect.w, rect.h), &mut v) {
                        return Err(TraceError::InvalidConfig(format!("window {w}: patch of tile {ti}")));
                    }
                    for yy in 0..rect.h {
                        for xx in 0..rect.w {
                            let g = (rect.y0 + yy) * width + rect.x0 + xx;
                            let l = yy * rect.w + xx;
                            v[l] = if vmap[g] < MIN_VALID_SHARE as f32 {
                                f32::NAN
                            } else {
                                v[l] * self.inv_sigma[g]
                            };
                        }
                    }
                    let miss = take_missing(&mut v);
                    out[ti].proj.push(bg.project(&v));
                    out[ti].idx.push(slow);
                    out[ti].miss.push(miss);
                    out[ti].y.push(v);
                }
            }
            t0 += wf.frames;
        }
        if t0 != t_len {
            return Err(TraceError::InvalidConfig(format!(
                "the factors held {t_len} frames in pass A and {t0} in pass B"
            )));
        }
        Ok(out)
    }
```

`Rect` fields (`x0`, `y0`, `w`, `h`) and `Rect::len` are in `discover/local.rs` (about line 21); `Frames` (about line 1184 of `discover/mod.rs`) has private fields that this child module may set. If the reservoir stores a patch in another way than `y · σ⁻¹` (look at `whiten`, about line 1207, and `Tile::offer` in `reservoir.rs`), follow it and say so.

- [ ] **Step 4: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings discover::factor_refine`
Expected: both tests pass.

- [ ] **Step 5: Check and commit**

`cargo fmt --all`, the clippy command. Then:

```bash
git add crates/cala/src/discover/factor_refine.rs
git commit -m "feat(cala): held-out patches of a factor Refine rebuilt from the factors"
```

---

### Task 4: The iteration and the settle stop

**Files:**

- Modify: `crates/cala/src/discover/factor_refine.rs`
- Modify: `crates/cala/src/discover/mod.rs` (the `pub use` of the public names)

**Interfaces:**

- Consumes: Tasks 2 and 3; `SlowLoop::{refine, columns, problem, publish, scope, pending, published, stats, frames}`, `Solved` (`discover/mod.rs`).
- Produces:
  - `pub struct IterationReport { pub library_version: u64, pub cells: usize, pub frames: usize, pub fitting_frames: u64, pub accepted: u64, pub changed_share: f64, pub median_change: f64, pub low_valid: usize, pub tiles_skipped: usize }` and `IterationReport::settled(&self, cfg: &FactorRefineConfig) -> bool`
  - `pub struct Settled { pub library: Arc<Library>, pub iterations: usize, pub settled: bool }`
  - `SlowLoop::refine_on_factors(&mut self, src: &mut dyn FactorSource, cfg: &FactorRefineConfig) -> Result<IterationReport, TraceError>`
  - `pub fn refine_until_settled(sl: &mut SlowLoop, src: &mut dyn FactorSource, cfg: &FactorRefineConfig, on_iteration: impl FnMut(usize, &IterationReport)) -> Result<Settled, TraceError>`
  - `pub fn footprint_change(prev: &Library, next: &Library) -> Vec<(u64, f64)>`
  - `calab_cala::discover::{FactorRefineConfig, FactorSource, RefineStage, IterationReport, Settled, refine_until_settled, footprint_change}`
  - private: `fn gate(&mut self, frames: &[Frames], has_cells: &[bool]) -> usize` (tiles skipped)

- [ ] **Step 1: Write the failing tests**

Add to the test module:

```rust
    #[test]
    fn one_iteration_accepts_what_the_frame_route_accepts() {
        let c = cfg(v2_config().background);
        let (mut fa, windows) = fixture(c.clone());
        let (mut fb, _) = fixture(c);
        let rc = FactorRefineConfig::default();
        let rep = fa.refine_on_factors(&mut windows.clone(), &rc).unwrap();
        assert!(rep.accepted >= 1, "the fixture must give the gate a refinement: {rep:?}");
        assert_eq!((rep.frames, fa.frames()), (T, T as u64));
        // The frame route's statistics, the same held-out patches, the same gate.
        let libb = fb.library().unwrap().clone();
        let mut src = windows.clone();
        let pass = fb.sum_pass(&libb, &mut src, &rc).unwrap();
        let pick = fb.pick_tests(&pass.scores, fb.test_count(&rc));
        let frames = fb.test_frames(&mut src, &pick, pass.frames).unwrap();
        frame_route(&mut fb, &windows, rc.solver);
        fb.frames += pass.frames as u64;
        fb.gate(&frames, &pass.has_cells);
        let (na, nb) = (fa.library().unwrap().clone(), fb.finalize().unwrap());
        assert_eq!(fa.stats().refines, fb.stats().refines);
        assert_eq!(na.ids(), nb.ids());
        for s in 0..na.len() {
            let ((pa, va), (pb, vb)) = (na.unfiltered(s), nb.unfiltered(s));
            assert_eq!(pa, pb, "cell {}: support", na.ids()[s]);
            let top = va.iter().fold(0.0f32, |m, v| m.max(v.abs()));
            for (x, y) in va.iter().zip(vb) {
                assert!((x - y).abs() <= 1e-4 * top, "cell {}: {x} vs {y}", na.ids()[s]);
            }
        }
    }

    #[test]
    fn refine_until_settled_stops_on_the_settle_rule_or_the_cap() {
        let (mut sl, windows) = fixture(cfg(v2_config().background));
        let mut reps: Vec<IterationReport> = Vec::new();
        let rc = FactorRefineConfig::default();
        let out = refine_until_settled(&mut sl, &mut windows.clone(), &rc, |it, r| {
            assert_eq!(it, reps.len() + 1);
            reps.push(r.clone());
        })
        .unwrap();
        assert!(out.settled, "{reps:?}");
        assert_eq!(out.iterations, reps.len());
        assert!(reps.last().unwrap().settled(&rc));
        assert!(reps[..reps.len() - 1].iter().all(|r| !r.settled(&rc)));
        assert_eq!(out.library.version(), sl.library().unwrap().version());
        assert_eq!(sl.frames(), (T * reps.len()) as u64, "each iteration holds out another third");

        let (mut sl, _) = fixture(cfg(v2_config().background));
        let capped = FactorRefineConfig {
            max_iterations: 1,
            settle_share: 0.0,
            ..FactorRefineConfig::default()
        };
        let out = refine_until_settled(&mut sl, &mut windows.clone(), &capped, |_, _| {}).unwrap();
        assert_eq!((out.iterations, out.settled), (1, false));
    }

    #[test]
    fn too_few_held_out_frames_skip_the_tile() {
        let (mut sl, windows) = fixture(cfg(v2_config().background));
        let rc = FactorRefineConfig {
            test_frames: 4,
            ..FactorRefineConfig::default()
        };
        assert!(4 < sl.config().min_test_frames);
        let v0 = sl.library().unwrap().version();
        let rep = sl.refine_on_factors(&mut windows.clone(), &rc).unwrap();
        assert!(rep.tiles_skipped >= 1);
        assert_eq!((rep.accepted, rep.changed_share), (0, 0.0));
        assert!(rep.settled(&rc));
        assert_eq!(sl.library().unwrap().version(), v0, "nothing to publish");
    }

    #[test]
    fn an_empty_library_settles_at_once() {
        let n_px = N * N;
        let mut sl = SlowLoop::new(dims(), vec![1; n_px], vec![1.0; n_px], flattener(), cfg(v2_config().background)).unwrap();
        sl.finalize().unwrap();
        sl.set_edit_scope(EditScope::Refine);
        let (_, windows) = fixture(cfg(v2_config().background));
        let out = refine_until_settled(&mut sl, &mut windows.clone(), &FactorRefineConfig::default(), |_, r| {
            assert_eq!((r.cells, r.accepted, r.tiles_skipped), (0, 0, 0));
        })
        .unwrap();
        assert_eq!((out.iterations, out.settled), (1, true));
    }

    #[test]
    fn refused_inputs_leave_the_loop_as_it_was() {
        let rc = FactorRefineConfig::default();
        let (mut sl, windows) = fixture(cfg(v2_config().background));
        let state = |s: &SlowLoop| (s.frames(), s.library().unwrap().version(), s.fpstats.len());
        let before = state(&sl);
        let other = {
            let d = crate::preprocess::Dims::new(64, 56).unwrap();
            let mut wc = WindowCompressor::new(d, CompressConfig { window: 20, ..CompressConfig::default() });
            (0..20).find_map(|_| wc.push(&vec![1.0f32; 64 * 56])).unwrap()
        };
        let mut nan = windows.clone();
        nan[2].tiles[0].temporal.fill(f32::NAN);
        let bad: Vec<(&str, Vec<WindowFactors>, FactorRefineConfig)> = vec![
            ("no window", Vec::new(), rc),
            ("a gap", windows[1..].to_vec(), rc),
            ("another frame size", vec![other], rc),
            ("non-finite factors", nan, rc),
            ("settle_corr", windows.clone(), FactorRefineConfig { settle_corr: 1.5, ..rc }),
            ("max_iterations", windows.clone(), FactorRefineConfig { max_iterations: 0, ..rc }),
        ];
        for (what, mut src, c) in bad {
            assert!(sl.refine_on_factors(&mut src, &c).is_err(), "{what}");
            assert_eq!(state(&sl), before, "{what}");
        }
        sl.set_edit_scope(EditScope::All);
        assert!(sl.refine_on_factors(&mut windows.clone(), &rc).is_err(), "edit scope");
        sl.set_edit_scope(EditScope::Refine);
        sl.seed(&[blob_w(9, 20.0, 20.0, 2.5)]).unwrap();
        assert!(sl.refine_on_factors(&mut windows.clone(), &rc).is_err(), "unpublished edits");
        assert_eq!(state(&sl), before);
        for c in [
            SlowLoopConfig { joint_update: JointUpdate::All, ..cfg(v2_config().background) },
            SlowLoopConfig {
                core_test: CoreTest::Report,
                support_rule: super::super::SupportRule::Rings,
                ..cfg(v2_config().background)
            },
        ] {
            let (mut s, w) = fixture(c);
            assert!(s.refine_on_factors(&mut w.clone(), &rc).is_err(), "joint update or core test");
        }
    }

    #[test]
    fn footprint_change_is_a_correlation_over_both_supports() {
        let (sl, _) = fixture(cfg(v2_config().background));
        let lib = sl.library().unwrap().clone();
        let same = footprint_change(&lib, &lib);
        assert_eq!(same.len(), lib.len());
        assert!(same.iter().all(|&(_, r)| (r - 1.0).abs() < 1e-12));
    }
```

- [ ] **Step 2: Run to see them fail**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings discover::factor_refine`
Expected: does not compile (`refine_on_factors`, `refine_until_settled`, `footprint_change`, `gate`, `IterationReport`).

- [ ] **Step 3: Implement**

Append to `factor_refine.rs` (above the test module):

```rust
/// What one iteration did.
#[derive(Debug, Clone, PartialEq)]
pub struct IterationReport {
    /// The library after the iteration, and its cells.
    pub library_version: u64,
    pub cells: usize,
    /// Frames read, and the fitting frames among them.
    pub frames: usize,
    pub fitting_frames: u64,
    /// Refinements accepted.
    pub accepted: u64,
    /// Share of cells whose footprint correlates below `settle_corr` with
    /// their footprint before the iteration ([`footprint_change`]), and the
    /// median of `1 − r`.
    pub changed_share: f64,
    pub median_change: f64,
    /// Cells whose statistics disk held a pixel with a valid share below 1
    /// in some window (its window mean entered as data; below
    /// `MIN_VALID_SHARE` the pixel was left out of that window).
    pub low_valid: usize,
    /// Tiles with cells whose gate had fewer than `min_test_frames`
    /// held-out frames (not refined).
    pub tiles_skipped: usize,
}

impl IterationReport {
    /// The settle stop: fewer than `settle_share` of the cells still changing.
    pub fn settled(&self, cfg: &FactorRefineConfig) -> bool {
        self.changed_share < f64::from(cfg.settle_share)
    }
}

/// The end of [`refine_until_settled`].
#[derive(Debug, Clone)]
pub struct Settled {
    pub library: Arc<Library>,
    pub iterations: usize,
    /// `false`: stopped by `max_iterations`.
    pub settled: bool,
}

fn pearson(xs: &[(f64, f64)]) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let n = xs.len() as f64;
    let (sa, sb) = xs.iter().fold((0.0, 0.0), |s, x| (s.0 + x.0, s.1 + x.1));
    let (ma, mb) = (sa / n, sb / n);
    let (mut ab, mut aa, mut bb) = (0.0f64, 0.0f64, 0.0f64);
    for &(a, b) in xs {
        ab += (a - ma) * (b - mb);
        aa += (a - ma) * (a - ma);
        bb += (b - mb) * (b - mb);
    }
    if aa > 0.0 && bb > 0.0 {
        ab / (aa * bb).sqrt()
    } else {
        f64::NAN
    }
}

/// Per cell of both libraries (by id, in `next`'s slot order): the Pearson
/// correlation of its unfiltered footprints over the union of the two
/// supports (a pixel outside a support counts 0); NaN when either is
/// constant there. The settle measure of Refine on factors.
pub fn footprint_change(prev: &Library, next: &Library) -> Vec<(u64, f64)> {
    let mut out = Vec::with_capacity(next.len());
    for (slot, &id) in next.ids().iter().enumerate() {
        let Some(ps) = prev.slot(id) else {
            continue;
        };
        let ((pa, va), (pb, vb)) = (prev.unfiltered(ps), next.unfiltered(slot));
        let (mut i, mut j) = (0usize, 0usize);
        let mut xs: Vec<(f64, f64)> = Vec::with_capacity(pa.len().max(pb.len()));
        while i < pa.len() || j < pb.len() {
            if j >= pb.len() || (i < pa.len() && pa[i] < pb[j]) {
                xs.push((f64::from(va[i]), 0.0));
                i += 1;
            } else if i >= pa.len() || pb[j] < pa[i] {
                xs.push((0.0, f64::from(vb[j])));
                j += 1;
            } else {
                xs.push((f64::from(va[i]), f64::from(vb[j])));
                i += 1;
                j += 1;
            }
        }
        out.push((id, pearson(&xs)));
    }
    out
}

/// `(changed share, median 1 − r)` of [`footprint_change`] at `corr` (a
/// cell without a correlation counts as changed).
fn settle_measure(prev: &Library, next: &Library, corr: f32) -> (f64, f64) {
    let ch = footprint_change(prev, next);
    if ch.is_empty() {
        return (0.0, 0.0);
    }
    let thr = f64::from(corr);
    let below = ch.iter().filter(|c| !(c.1 >= thr)).count();
    let mut d: Vec<f64> = ch.iter().filter(|c| c.1.is_finite()).map(|c| 1.0 - c.1).collect();
    let med = if d.is_empty() {
        f64::NAN
    } else {
        let m = d.len() / 2;
        *d.select_nth_unstable_by(m, f64::total_cmp).1
    };
    (below as f64 / ch.len() as f64, med)
}

impl SlowLoop {
    /// The refine visit of every tile on its held-out patches: the tile's
    /// base problem and the existing `refine`, with no fitting frames (so
    /// only the statistics path proposes). Returns the tiles with cells
    /// skipped for too few held-out frames.
    fn gate(&mut self, frames: &[Frames], has_cells: &[bool]) -> usize {
        let mut skipped = 0;
        for ti in 0..self.tiles.len() {
            let fr = &frames[ti];
            if fr.len() < self.cfg.min_test_frames {
                skipped += usize::from(has_cells[ti]);
                continue;
            }
            if self.bgs[ti].is_none() {
                self.bgs[ti] = Some(BgBasis::new(self.tiles[ti].rect));
            }
            let rect = self.tiles[ti].rect;
            let cols = self.columns(rect, &[], &[]);
            let base = self.problem(ti, cols);
            let solved = Solved {
                base,
                fits: Vec::new(),
                resid: Vec::new(),
            };
            self.refine(ti, &solved, fr);
        }
        skipped
    }

    /// One Refine iteration on the factors of `src` (see the module docs).
    /// Needs [`EditScope::Refine`], a published library and no pending
    /// edits, `core_test` off and, until phase 3b, `joint_update` off. A
    /// refused or failed pass leaves the loop as it was.
    pub fn refine_on_factors(
        &mut self,
        src: &mut dyn FactorSource,
        cfg: &FactorRefineConfig,
    ) -> Result<IterationReport, TraceError> {
        cfg.validate()?;
        let refuse = |m: &str| Err(TraceError::InvalidConfig(m.into()));
        if self.scope != EditScope::Refine {
            return refuse("Refine on factors runs with the cell set frozen (EditScope::Refine)");
        }
        if self.cfg.core_test != CoreTest::Off {
            return refuse("Refine on factors needs core_test off");
        }
        if self.cfg.joint_update != JointUpdate::Off {
            return refuse("the cluster replay on factors is phase 3b: joint_update must be off");
        }
        if self.pending {
            return refuse("unpublished edits: finalize before Refine on factors");
        }
        let Some(lib) = self.published.clone() else {
            return refuse("no published library");
        };
        if src.windows() == 0 {
            return refuse("no factor windows");
        }
        let k = self.test_count(cfg);
        let refines0 = self.stats.refines;
        src.stage(RefineStage::Sums);
        let pass = self.sum_pass(&lib, src, cfg)?;
        src.stage(RefineStage::TestFrames);
        let pick = self.pick_tests(&pass.scores, k);
        let frames = self.test_frames(src, &pick, pass.frames)?;
        self.install(&lib, &pass);
        src.stage(RefineStage::Gate);
        let tiles_skipped = self.gate(&frames, &pass.has_cells);
        src.stage(RefineStage::Publish);
        self.frames += pass.frames as u64;
        let next = if self.pending { self.publish()? } else { lib.clone() };
        let (changed_share, median_change) = settle_measure(&lib, &next, cfg.settle_corr);
        src.stage(RefineStage::Done);
        Ok(IterationReport {
            library_version: next.version(),
            cells: next.len(),
            frames: pass.frames,
            fitting_frames: pass.fitting,
            accepted: self.stats.refines - refines0,
            changed_share,
            median_change,
            low_valid: pass.cells.iter().filter(|c| c.min_valid < LOW_VALID).count(),
            tiles_skipped,
        })
    }
}

/// Refine on factors until the footprints have settled (spec §5): after
/// `finalize`, iterations until one reports [`IterationReport::settled`] or
/// `max_iterations` have run; `on_iteration` gets each (counted from 1).
pub fn refine_until_settled(
    sl: &mut SlowLoop,
    src: &mut dyn FactorSource,
    cfg: &FactorRefineConfig,
    mut on_iteration: impl FnMut(usize, &IterationReport),
) -> Result<Settled, TraceError> {
    cfg.validate()?;
    sl.finalize()?;
    for it in 1..=cfg.max_iterations {
        let rep = sl.refine_on_factors(src, cfg)?;
        on_iteration(it, &rep);
        if rep.settled(cfg) {
            return Ok(Settled {
                library: sl.finalize()?,
                iterations: it,
                settled: true,
            });
        }
    }
    Ok(Settled {
        library: sl.finalize()?,
        iterations: cfg.max_iterations,
        settled: false,
    })
}
```

In `discover/mod.rs`, beside `pub use shard::{...}`:

```rust
pub use factor_refine::{
    footprint_change, refine_until_settled, FactorRefineConfig, FactorSource, IterationReport,
    RefineStage, Settled,
};
```

Notes for the implementer:

- `refine` (about line 5412) reads `Solved::fits` and `resid` only on its reservoir path; with both empty it finds no active frame there. Check it before relying on it; if it reads them elsewhere, stop and report.
- `SlowStats::refines` counts accepted refinements of both paths; with no fitting frames only the statistics path can accept.
- The test `refused_inputs_leave_the_loop_as_it_was` seeds a cell after a refusal; `seed` sets `pending`, which the next call refuses. Keep that order.

- [ ] **Step 4: Run the tests**

Run from `crates/cala`: `cargo test --no-default-features --features jsbindings discover::factor_refine`
Expected: all eight tests of the module pass. If `one_iteration_accepts_what_the_frame_route_accepts` finds no refinement (`accepted` 0), raise `T` to 3000 (the `bitten_refill` test uses 4000) and say so. If the two routes accept different refinements, print for each differing cell its split-half excess (`split_half_excess`) and paired z from both loops: a decision within rounding of its threshold is a finding for the report, a large difference is a bug; do not loosen the test.

- [ ] **Step 5: Check and commit**

`cargo fmt --all`, the clippy command, the whole test suite. Then:

```bash
git add crates/cala/src/discover
git commit -m "feat(cala): Refine on factors iterates until the footprints settle"
```

---

### Task 5: Refine on factors in the harness

**Files:**

- Modify: `crates/cala/examples/qc_eval.rs` (flag docs after `--extract-engine` at about line 147; parsing after `later_scope` at about line 3903; the frame loop after the `fd.push(&y)` block at about line 4790; after `passes.tsv` is written at about line 5231; imports at about line 371; the `tests` module at about line 5716)

**Interfaces:**

- Consumes: `refine_on_factors`, `FactorRefineConfig`, `FactorSource`, `RefineStage`, `IterationReport` (Task 4); `FactorDump`, `factor_config`, `write_library`, `FACTOR_WINDOW` (phases 0 to 2).
- Produces:
  - `qc_eval --refine-engine raw|factors` (default `raw`). With `factors`: pass 2 is a compression replay only (preprocessing, the replayed motion and `--factors-out`; no fast or slow loop); then Refine on factors until settled; needs `--passes 2`, `--later-passes refine`, `--factors-out DIR`, `--factors-pass 2`, not `--offered-fps`.
  - `--settle-corr C` (0.99), `--settle-share S` (0.02), `--max-iterations N` (20), `--test-frames K` (0).
  - Outputs: `iterations.tsv` (`iteration version cells accepted changed_share median_change low_valid tiles_skipped read_s sums_s test_s gate_s publish_s wall_s settled`), `footprints_iter{k}.bin` and `final_iter{k}.tsv` per iteration, a `refine_it{k}` row per iteration in `stage_times.tsv` (`read_s`: factor files; `solve_s`: pass A; `slow_s`: patches, gate and publish; `wall_s`).
  - `struct FactorFiles` (`open(dir, t_len)`, `begin()`, `times() -> (f64, f64, f64, f64, f64)`), implementing `FactorSource`.

- [ ] **Step 1: Write the failing tests**

In the `tests` module of `qc_eval.rs`:

```rust
    #[test]
    fn factor_files_serve_the_dumped_windows_in_order() {
        let dims = Dims::new(96, 70).unwrap();
        let frames = slow_stream(dims, FACTOR_WINDOW + 50);
        let dir = std::env::temp_dir().join(format!("qc_eval_files_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut fd = FactorDump::new(&dir, dims, Tiling::Offset, factor_config(&[]));
        for f in &frames {
            fd.push(f);
        }
        fd.finish();
        let mut src = FactorFiles::open(&dir, frames.len());
        assert_eq!(src.windows(), 2);
        src.begin();
        src.stage(RefineStage::Sums);
        let (a, b) = (src.window(0).unwrap(), src.window(1).unwrap());
        assert_eq!((a.start, a.frames), (0, FACTOR_WINDOW));
        assert_eq!((b.start, b.frames), (FACTOR_WINDOW as u64, 50));
        assert!(src.window(2).is_err());
        for s in [RefineStage::TestFrames, RefineStage::Gate, RefineStage::Publish, RefineStage::Done] {
            src.stage(s);
        }
        let (read_s, sums_s, test_s, gate_s, publish_s) = src.times();
        assert!([read_s, sums_s, test_s, gate_s, publish_s].iter().all(|&v| v >= 0.0));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[should_panic(expected = "end at frame")]
    fn factor_files_refuse_a_recording_longer_than_the_factors() {
        let dims = Dims::new(64, 40).unwrap();
        let frames = slow_stream(dims, 30);
        let dir = std::env::temp_dir().join(format!("qc_eval_files_short_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut fd = FactorDump::new(&dir, dims, Tiling::Plain, factor_config(&[]));
        for f in &frames {
            fd.push(f);
        }
        fd.finish();
        let _ = FactorFiles::open(&dir, 31);
    }
```

- [ ] **Step 2: Run to see them fail**

From `crates/cala`: `cargo test --no-default-features --features jsbindings --example qc_eval factor_files`
Expected: does not compile (`FactorFiles`, `RefineStage`).

- [ ] **Step 3: Implement**

Imports: add `FactorRefineConfig, FactorSource, RefineStage` to the `use calab_cala::discover::{...}` list.

Flag docs, after the `--extract-engine` lines:

```rust
//!   --refine-engine E  raw (default: the passes after Discover replay the
//!                      recording) | factors (Refine on factors: pass 2 is a
//!                      compression replay only, no fast or slow loop runs
//!                      in it, then Refine runs on its factors until the
//!                      footprints settle; needs --passes 2, --later-passes
//!                      refine, --factors-out and --factors-pass 2). Writes
//!                      `iterations.tsv`, `footprints_iter{k}.bin` /
//!                      `final_iter{k}.tsv` and a `refine_it{k}` row per
//!                      iteration in `stage_times.tsv` (read_s: factor files;
//!                      solve_s: Extract and the statistics; slow_s: held-out
//!                      patches, gate and publish)
//!   --settle-corr C, --settle-share S, --max-iterations N
//!                      the settle stop of --refine-engine factors (0.99,
//!                      0.02, 20)
//!   --test-frames K    held-out frames per tile of its gate (0: the
//!                      reservoir's average, frames_per_tile / holdout_every)
```

Parsing, after `later_scope`:

```rust
    let refine_factors = match arg_value(&args, "--refine-engine").as_deref() {
        None | Some("raw") => false,
        Some("factors") => true,
        Some(o) => panic!("--refine-engine: raw or factors, not {o:?}"),
    };
    let fcfg = FactorRefineConfig {
        settle_corr: arg_value(&args, "--settle-corr").map_or(0.99, |s| s.parse().unwrap()),
        settle_share: arg_value(&args, "--settle-share").map_or(0.02, |s| s.parse().unwrap()),
        max_iterations: arg_value(&args, "--max-iterations").map_or(20, |s| s.parse().unwrap()),
        test_frames: arg_value(&args, "--test-frames").map_or(0, |s| s.parse().unwrap()),
        solver: SolverConfig::default(),
    };
    if refine_factors {
        assert!(
            passes == 2
                && later_scope == EditScope::Refine
                && factors_pass == 2
                && arg_value(&args, "--factors-out").is_some()
                && arg_value(&args, "--offered-fps").is_none(),
            "--refine-engine factors needs --passes 2, --later-passes refine, --factors-out DIR and --factors-pass 2 (not --offered-fps)"
        );
        fcfg.validate()
            .unwrap_or_else(|e| panic!("--refine-engine factors: {e}"));
    }
```

In the frame loop, directly after the block `if let (Some(fd), true) = (factors.as_mut(), pass + 1 == factors_pass) { fd.push(&y); }`:

```rust
                // `--refine-engine factors`: pass 2 is the compression replay
                // before Refine (A4, A7); the fast and the slow loop do not run.
                if refine_factors && pass + 1 == factors_pass {
                    continue;
                }
```

Below `FactorReplay`:

```rust
/// `--refine-engine factors`: the factor files of `--factors-out` as the
/// windows of Refine on factors (frame order), with the seconds spent
/// reading them and in each stage of the current iteration.
struct FactorFiles {
    dir: PathBuf,
    /// First frame of each window.
    starts: Vec<usize>,
    read_s: f64,
    marks: Vec<(RefineStage, Instant)>,
}

impl FactorFiles {
    /// The windows `w0000000.fac`, ... of `dir`, which must cover frames
    /// `0..t_len` without a gap.
    fn open(dir: &Path, t_len: usize) -> FactorFiles {
        let mut starts = Vec::new();
        let mut start = 0usize;
        while start < t_len {
            let path = dir.join(format!("w{start:07}.fac"));
            let Ok(bytes) = std::fs::read(&path) else {
                break;
            };
            let wf = WindowFactors::from_bytes(&bytes)
                .unwrap_or_else(|| panic!("{path:?}: not a factor file"));
            assert!(
                wf.frames > 0 && wf.start as usize == start,
                "{path:?}: a window of {} frames at frame {}, expected one at {start}",
                wf.frames,
                wf.start
            );
            starts.push(start);
            start += wf.frames;
        }
        assert!(
            start == t_len,
            "the factor files in {dir:?} end at frame {start}, not {t_len}"
        );
        FactorFiles {
            dir: dir.to_path_buf(),
            starts,
            read_s: 0.0,
            marks: Vec::new(),
        }
    }

    /// Start timing a new iteration.
    fn begin(&mut self) {
        self.read_s = 0.0;
        self.marks.clear();
    }

    /// Seconds of the last iteration: reading the files, pass A, the
    /// held-out patches, the gate, publishing.
    fn times(&self) -> (f64, f64, f64, f64, f64) {
        let at = |s: RefineStage| self.marks.iter().find(|m| m.0 == s).map(|m| m.1);
        let span = |a: RefineStage, b: RefineStage| match (at(a), at(b)) {
            (Some(x), Some(y)) => y.duration_since(x).as_secs_f64(),
            _ => 0.0,
        };
        (
            self.read_s,
            span(RefineStage::Sums, RefineStage::TestFrames),
            span(RefineStage::TestFrames, RefineStage::Gate),
            span(RefineStage::Gate, RefineStage::Publish),
            span(RefineStage::Publish, RefineStage::Done),
        )
    }
}

impl FactorSource for FactorFiles {
    fn windows(&self) -> usize {
        self.starts.len()
    }

    fn window(&mut self, w: usize) -> Result<WindowFactors, TraceError> {
        let start = *self
            .starts
            .get(w)
            .ok_or_else(|| TraceError::InvalidConfig(format!("no factor window {w}")))?;
        let path = self.dir.join(format!("w{start:07}.fac"));
        let t0 = Instant::now();
        let bytes = std::fs::read(&path)
            .map_err(|e| TraceError::InvalidConfig(format!("{path:?}: {e}")))?;
        let wf = WindowFactors::from_bytes(&bytes)
            .ok_or_else(|| TraceError::InvalidConfig(format!("{path:?}: not a factor file")))?;
        self.read_s += t0.elapsed().as_secs_f64();
        Ok(wf)
    }

    fn stage(&mut self, stage: RefineStage) {
        self.marks.push((stage, Instant::now()));
    }
}
```

(Import `TraceError` from `calab_cala::trace` if it is not imported.) After `std::fs::write(out_dir.join("passes.tsv"), &passes_out).unwrap();`:

```rust
    // `--refine-engine factors`: Refine on the factors of pass 2 until the
    // footprints settle; the iterations' libraries and times are written.
    if refine_factors {
        let sl = slow
            .as_mut()
            .expect("--refine-engine factors needs the slow loop (not --library, not oracle)");
        sl.set_noise(pipe.pre.noise().sigma()).unwrap();
        let mut src = FactorFiles::open(factors_out.as_deref().unwrap(), t_len);
        let mut log = String::from(
            "iteration\tversion\tcells\taccepted\tchanged_share\tmedian_change\tlow_valid\ttiles_skipped\tread_s\tsums_s\ttest_s\tgate_s\tpublish_s\twall_s\tsettled\n",
        );
        for it in 1..=fcfg.max_iterations {
            src.begin();
            let t0 = Instant::now();
            let rep = sl
                .refine_on_factors(&mut src, &fcfg)
                .unwrap_or_else(|e| panic!("Refine on factors, iteration {it}: {e}"));
            let wall = t0.elapsed().as_secs_f64();
            let (read_s, sums_s, test_s, gate_s, publish_s) = src.times();
            let settled = rep.settled(&fcfg);
            let _ = writeln!(
                log,
                "{it}\t{}\t{}\t{}\t{:.5}\t{:.6}\t{}\t{}\t{read_s:.2}\t{sums_s:.2}\t{test_s:.2}\t{gate_s:.2}\t{publish_s:.2}\t{wall:.2}\t{}",
                rep.library_version,
                rep.cells,
                rep.accepted,
                rep.changed_share,
                rep.median_change,
                rep.low_valid,
                rep.tiles_skipped,
                u8::from(settled)
            );
            let _ = writeln!(
                stage_times,
                "refine_it{it}\t{read_s:.2}\t0.00\t0.00\t{sums_s:.2}\t{:.2}\t{wall:.2}",
                test_s + gate_s + publish_s
            );
            let lib = sl.library().cloned().expect("a published library");
            write_library(&out_dir, &format!("_iter{it}"), &lib, dims, gt.as_ref(), ho.as_ref(), None);
            println!(
                "Refine on factors, iteration {it}: {} refinements, {:.4} of {} cells changed (median {:.5}), {} cells with low valid share, {wall:.1} s",
                rep.accepted, rep.changed_share, rep.cells, rep.median_change, rep.low_valid
            );
            if settled {
                break;
            }
        }
        std::fs::write(out_dir.join("iterations.tsv"), log).unwrap();
        engine.set_library(sl.finalize().unwrap()).unwrap();
    }
```

If `factors_out`, `pipe`, `gt`, `ho` or `stage_times` have other names or are moved before this point, adapt the names and say so; do not change what the raw path writes.

- [ ] **Step 4: Run the tests**

From `crates/cala`: `cargo test --no-default-features --features jsbindings --example qc_eval`. Expected: all pass, the two new ones and, unchanged, `extract_from_factors_matches_the_replayed_frames`.

- [ ] **Step 5: Check and commit**

`cargo fmt --all`, the clippy command.

```bash
git add crates/cala/examples/qc_eval.rs
git commit -m "feat(cala-eval): qc_eval runs Refine on factors after a compression replay"
```

---

### Task 6: The arm and the settle tables in the tools

**Files:**

- Modify: `tools/cala-eval/factor_closeness.py`, `tools/cala-eval/test_factor_closeness.py`
- Modify: `tools/cala-eval/factor_arms.py`, `tools/cala-eval/test_factor_arms.py`

**Interfaces:**

- Consumes: `qc_eval --refine-engine factors` (Task 5): `iterations.tsv`, `footprints_iter{k}.bin`, `footprints_pass{k}.bin`; `read_footprints`, `read_tsv`, `pearson`, `fp_cosine`, `truth_offset`, `read_truth`, `read_traces`, `read_centroids`, `TRUTH_PX` (phases 0 to 2).
- Produces:
  - `factor_closeness.footprint_change(a: Cell, b: Cell) -> float`
  - `factor_closeness.changed_share(fa: dict[int, Cell], fb: dict[int, Cell], corr: float = 0.99) -> tuple[float, float, int]`
  - `factor_closeness.read_truth_footprints(path: Path) -> list[Cell]`
  - `factor_closeness.centroid(c: Cell, w: int) -> tuple[float, float]`
  - `factor_closeness.truth_fp_median(cells: dict[int, Cell], dims: tuple[int, int], truth: list[Cell], offset: tuple[float, float] = (0.0, 0.0)) -> float`
  - `factor_closeness.library_steps(run: Path) -> list[tuple[str, Path]]`
  - `factor_closeness.settle_table(run: Path, truth_path: Path | None = None, corr: float = 0.99) -> list[str]`
  - `factor_arms.arms(...)["f_chosen"]`, `["f_null"]`; `factor_arms.iteration_table(run: Path) -> list[str]`

- [ ] **Step 1: Write the failing tests**

In `tools/cala-eval/test_factor_closeness.py`:

```python
def write_fp(path: Path, cells: dict[int, tuple[list[int], list[float]]]) -> None:
    h, w = DIMS
    with open(path, "wb") as f:
        f.write(b"CALAFP01" + struct.pack("<III", h, w, len(cells)))
        for cid, (pix, val) in cells.items():
            f.write(struct.pack("<II", cid, len(pix)))
            f.write(np.asarray(pix, "<u4").tobytes())
            f.write(np.asarray(val, "<f4").tobytes())
            f.write(np.asarray(val, "<f4").tobytes())


class Settle(unittest.TestCase):
    def test_footprint_change_is_a_correlation_over_both_supports(self) -> None:
        a = (np.array([1, 2, 3]), np.array([1.0, 3.0, 1.0]))
        self.assertAlmostEqual(F.footprint_change(a, a), 1.0)
        self.assertAlmostEqual(F.footprint_change(a, (a[0], 2 * a[1])), 1.0)
        moved = (np.array([3, 4, 5]), np.array([1.0, 3.0, 1.0]))
        self.assertLess(F.footprint_change(a, moved), 0.99)

    def test_changed_share_counts_cells_below_the_threshold(self) -> None:
        a = (np.array([1, 2, 3]), np.array([1.0, 3.0, 1.0]))
        moved = (np.array([3, 4, 5]), np.array([1.0, 3.0, 1.0]))
        share, med, n = F.changed_share({1: a, 2: a, 3: a}, {1: a, 2: moved, 4: a})
        self.assertEqual(n, 2)
        self.assertAlmostEqual(share, 0.5)
        self.assertGreater(med, 0.0)
        share0, med0, n0 = F.changed_share({}, {})
        self.assertEqual((share0, n0), (0.0, 0))
        self.assertTrue(math.isnan(med0))

    def test_settle_table_lists_passes_then_iterations(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "f_chosen"
            run.mkdir()
            cell = ([10, 11, 12], [1.0, 3.0, 1.0])
            write_fp(run / "footprints_pass1.bin", {1: cell})
            write_fp(run / "footprints_pass2.bin", {1: cell})
            write_fp(run / "footprints_iter2.bin", {1: ([11, 12, 13], [1.0, 3.0, 1.0])})
            write_fp(run / "footprints_iter1.bin", {1: cell})
            self.assertEqual(
                [s for s, _ in F.library_steps(run)],
                ["pass 1", "pass 2", "iteration 1", "iteration 2"],
            )
            rows = [r for r in F.settle_table(run) if r.startswith("| ") and "---" not in r][1:]
            self.assertEqual(len(rows), 4)
            self.assertIn("| iteration 2 | 1 | 1.0000 |", rows[3])
            self.assertIn("| iteration 1 | 1 | 0.0000 |", rows[2])
```

In `tools/cala-eval/test_factor_arms.py`, class `Arms` (add `"f_chosen"`, not `"f_null"`, to the expected list of `test_arm_names`: `f_null` runs only when named):

```python
    def test_the_factor_refine_arm(self) -> None:
        a = A.arms(5, 1000)
        f = a["f_chosen"]
        for flag in (
            ["--passes", "2"],
            ["--later-passes", "refine"],
            ["--factors-pass", "2"],
            ["--refine-engine", "factors"],
            ["--extract-engine", "factors"],
            ["--tiling", "offset"],
        ):
            i = f.index(flag[0])
            self.assertEqual(f[i : i + 2], flag)
        self.assertIn("--extract-pass", f)
        self.assertEqual(A.line_step(f), 32)
        self.assertEqual(a["f_null"], f + ["--later-budget", "2000"])

    def test_iteration_table_reads_iterations_tsv(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "f_chosen"
            run.mkdir()
            (run / "iterations.tsv").write_text(
                "iteration\tversion\tcells\taccepted\tchanged_share\tmedian_change\tlow_valid\ttiles_skipped\tread_s\tsums_s\ttest_s\tgate_s\tpublish_s\twall_s\tsettled\n"
                "1\t9\t100\t40\t0.21000\t0.004000\t3\t0\t1.00\t5.00\t1.00\t2.00\t0.10\t9.10\t0\n"
                "2\t10\t100\t12\t0.01000\t0.000500\t3\t0\t1.00\t5.00\t1.00\t2.00\t0.10\t9.10\t1\n"
            )
            t = A.iteration_table(run)
            self.assertIn("| 2 | 100 | 12 | 0.01000 | 0.000500 | 3 | 0 | 9.10 | 1 |", t)
            self.assertEqual(A.iteration_table(Path(d) / "missing"), [])
```

- [ ] **Step 2: Run to see them fail**

From the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`
Expected: errors (`footprint_change`, `library_steps`, `iteration_table`, the arms `f_chosen`, `f_null`).

- [ ] **Step 3: Implement**

`tools/cala-eval/factor_closeness.py` (add `import re` to the imports), below `engine_report`:

```python
def footprint_change(a: Cell, b: Cell) -> float:
    """Pearson correlation of two footprints over the union of their pixels (a pixel outside
    a footprint counts 0); NaN when either is constant there. The settle measure of Refine
    on factors (`calab_cala::discover::footprint_change`)."""
    pix = np.union1d(a[0], b[0])
    va = np.zeros(len(pix))
    vb = np.zeros(len(pix))
    va[np.searchsorted(pix, a[0])] = a[1]
    vb[np.searchsorted(pix, b[0])] = b[1]
    return pearson(va, vb)


def changed_share(
    fa: dict[int, Cell], fb: dict[int, Cell], corr: float = 0.99
) -> tuple[float, float, int]:
    """Over the cells of both: the share whose footprints correlate below `corr` (or not at
    all), the median of 1 - correlation, and the number of cells."""
    rs = [footprint_change(fa[c], fb[c]) for c in sorted(set(fa) & set(fb))]
    if not rs:
        return 0.0, NAN, 0
    below = sum(1 for r in rs if not r >= corr)
    fin = [1.0 - r for r in rs if math.isfinite(r)]
    return below / len(rs), float(np.median(fin)) if fin else NAN, len(rs)


def read_truth_footprints(path: Path) -> list[Cell]:
    """The truth units' footprints `(pixels, values)` of a `truth.npz` (rows of its `A`)."""
    z = np.load(path)
    ptr = z["A_indptr"]
    idx = z["A_indices"].astype(np.int64)
    val = z["A_data"].astype(np.float64)
    return [(idx[ptr[k] : ptr[k + 1]], val[ptr[k] : ptr[k + 1]]) for k in range(len(ptr) - 1)]


def centroid(c: Cell, w: int) -> tuple[float, float]:
    s = float(c[1].sum())
    if s <= 0:
        return NAN, NAN
    return float((c[0] // w * c[1]).sum() / s), float((c[0] % w * c[1]).sum() / s)


def truth_fp_median(
    cells: dict[int, Cell],
    dims: tuple[int, int],
    truth: list[Cell],
    offset: tuple[float, float] = (0.0, 0.0),
) -> float:
    """Median over `cells` of the best footprint cosine with a truth unit within `TRUTH_PX`
    of the cell's centroid. The truth is first moved onto the run's frame by the rounded
    `offset` (truth minus run, as `truth_offset` gives it). NaN without a match."""
    h, w = dims
    dy, dx = round(offset[0]), round(offset[1])
    moved: list[Cell] = []
    for pix, val in truth:
        y, x = pix // w - dy, pix % w - dx
        keep = (y >= 0) & (y < h) & (x >= 0) & (x < w)
        moved.append((y[keep] * w + x[keep], val[keep]))
    cen = np.asarray([centroid(c, w) for c in moved], dtype=np.float64).reshape(-1, 2)
    best: list[float] = []
    for c in cells.values():
        cy, cx = centroid(c, w)
        if math.isnan(cy) or not len(cen):
            continue
        near = np.flatnonzero(np.hypot(cen[:, 0] - cy, cen[:, 1] - cx) <= TRUTH_PX)
        cs = [v for v in (fp_cosine(c, moved[k]) for k in near) if not math.isnan(v)]
        if cs:
            best.append(max(cs))
    return float(np.median(best)) if best else NAN


def library_steps(run: Path) -> list[tuple[str, Path]]:
    """The libraries a run wrote after each pass and each Refine-on-factors iteration, in order."""

    def num(p: Path) -> int:
        m = re.search(r"(\d+)\.bin$", p.name)
        return int(m.group(1)) if m else -1

    passes = sorted(run.glob("footprints_pass*.bin"), key=num)
    iters = sorted(run.glob("footprints_iter*.bin"), key=num)
    return [(f"pass {num(p)}", p) for p in passes] + [
        (f"iteration {num(p)}", p) for p in iters
    ]


def settle_table(run: Path, truth_path: Path | None = None, corr: float = 0.99) -> list[str]:
    """Markdown: per library of the run, the share of cells whose footprint changed (below
    `corr`) since the step before, the median change, and with a truth the median footprint
    cosine with it."""
    steps = library_steps(run)
    if not steps:
        return []
    truth: list[Cell] | None = None
    offset = (0.0, 0.0)
    if truth_path is not None:
        dims, _ = read_footprints(steps[0][1])
        truth = read_truth_footprints(truth_path)
        if (run / "extract_ids.tsv").exists() and (run / "final.tsv").exists():
            dy, dx, _ = truth_offset(
                read_traces(run), read_centroids(run), read_truth(truth_path, dims)
            )
            offset = (dy, dx)
    out = [
        f"Footprint change per step, `{run.name}` (cells below a correlation of {corr:g} with the step before):",
        "",
        "| step | cells | changed share | median change | truth footprint cos median |",
        "| --- | --- | --- | --- | --- |",
    ]
    prev: dict[int, Cell] | None = None
    for name, path in steps:
        dims, cells = read_footprints(path)
        if prev is None:
            share, med, n = NAN, NAN, len(cells)
        else:
            share, med, n = changed_share(prev, cells, corr)
        tc = truth_fp_median(cells, dims, truth, offset) if truth is not None else NAN
        out.append(f"| {name} | {n} | {share:.4f} | {med:.5f} | {tc:.4f} |")
        prev = cells
    return out + [""]
```

`tools/cala-eval/factor_arms.py`: in `arms`, after `out["c_chosen"]`:

```python
    out["f_chosen"] = [
        "--passes",
        "2",
        "--later-passes",
        "refine",
        "--extract-pass",
        "--replay-source",
        "factors",
        "--tiling",
        "offset",
        "--factors-pass",
        "2",
        "--extract-engine",
        "factors",
        "--refine-engine",
        "factors",
    ]
    # The same with another slow-loop budget after Discover: Refine on factors has no
    # budget, so its footprints must be byte-identical (spec §5: "does not depend on the
    # machine's speed").
    out["f_null"] = out["f_chosen"] + ["--later-budget", str(budget * 2)]
```

Below `extract_row`:

```python
def iteration_table(run: Path) -> list[str]:
    """Markdown rows of a Refine-on-factors run's `iterations.tsv`."""
    path = run / "iterations.tsv"
    if not path.exists():
        return []
    out = [
        f"Refine on factors, `{run.name}`:",
        "",
        "| iteration | cells | accepted | changed share | median change | low valid | tiles skipped | wall s | settled |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in factor_closeness.read_tsv(path):
        out.append(
            f"| {r['iteration']} | {r['cells']} | {r['accepted']} | {r['changed_share']} | "
            f"{r['median_change']} | {r['low_valid']} | {r['tiles_skipped']} | {r['wall_s']} | {r['settled']} |"
        )
    return out + [""]
```

In `report`: the stage tables for `("raw", "plain", "f_chosen")`; `"f_chosen"` joins `("plain_recal", "chosen", "c_chosen")` in the comparison with `raw` (gate A1); and after the Extract table:

```python
    for n in ("raw", "f_chosen"):
        if n in have:
            text += factor_closeness.settle_table(out_dir / n, truth)
    if "f_chosen" in have:
        text += iteration_table(out_dir / "f_chosen")
    if "f_chosen" in have and "f_null" in have:
        same = (out_dir / "f_chosen" / "footprints.bin").read_bytes() == (
            out_dir / "f_null" / "footprints.bin"
        ).read_bytes()
        text += [
            f"`f_null` (another slow-loop budget after Discover) has the footprints of `f_chosen`: {'yes' if same else 'no'}.",
            "",
        ]
```

`f_null` is not in the default set: in `default_arms`, return `[n for n in table if n not in REMEDIES and n != "f_null"]`. Docstring: "- `f_chosen`: Discover, a compression replay (pass 2: offset grids, recalibrated), Refine on factors until settled, the Extract pass on the factor engine (phase 3). `f_null`: the same with twice the slow-loop budget after Discover (run when named)."

- [ ] **Step 4: Run the tests**

From the repository root: `uv run --no-project --with numpy python -m unittest discover tools/cala-eval`. Expected: all pass.

- [ ] **Step 5: Format, check and commit**

`uvx ruff format` and `uvx ruff check --fix` on the four Python files.

```bash
git add tools/cala-eval
git commit -m "feat(cala-eval): Refine-on-factors arm with its settle and iteration tables"
```

---

### Task 7: Measure Refine on factors and write the report (3a)

The controller starts the runs (they need the recordings and take hours); a subagent writes the report from their outputs.

**Files:**

- Create: `tools/cala-eval/results/2026-11-19-factor-phase3.md`
- Modify: `docs/CHANGELOG.md`, `tools/cala-eval/README.md`

**Interfaces:**

- Consumes: the arms `raw`, `null_lo`, `null_hi`, `f_chosen`, `f_null` and their `report.md` (Task 6).
- Produces: the report with gate 3a's results. The decision to start 3b is the owner's.

- [ ] **Step 1: Run the native arms**

Build from `crates/cala`: `cargo build --release --example qc_eval` (only when no other gate run is using the release binary). Recordings and scale as in phase 1's and phase 2's gate runs (phase 1's report, "How it was measured"): `wl200`, `wl24_01`, `wl24_04`, `plain`, `v4`, `motion`; the first 12000 frames with `--refine 5` at 200 px, the first 6000 frames with `--refine 2` at 600 px; `--budget 3000000`; `--truth` where the recording has one (`wl200`, `plain`, `motion`); a new output folder outside the repository. Arms: `raw,null_lo,null_hi,f_chosen` at 200 px, `raw,null_lo,f_chosen` at 600 px, and `f_null` on `plain`. No joint flags (3a). Check that every arm ended with return code 0, that every `f_chosen/iterations.tsv` ends with `settled` 1 or at 20 iterations (say which), and that `f_null`'s footprints equal `f_chosen`'s.

- [ ] **Step 2: Write the report**

`tools/cala-eval/results/2026-11-19-factor-phase3.md`, every number produced by a throwaway script from the run folder (kept outside the repository), sections in this order:

1. **Gate (3a, joint flags off)**: (a) the unit tests `statistics_from_the_factors_equal_the_frame_route_on_rebuilt_frames` and `one_iteration_accepts_what_the_frame_route_accepts` pass (give the commit); (b) gate A1 per recording for `f_chosen` against `raw`, each rule's value and result, from the A1 table of each `report.md`. State plainly that at 600 px the raw reference is 2 Refine passes, not a settled Refine, and give its own changed share per pass from `settle_table`. Then "Decision: open, for the owner (3b next)."
2. **Settling**: per recording the iterations to settle, the changed share and median change per iteration (`iteration_table`), beside the raw arm's per-pass changed share with the same measure (`settle_table`); on `wl200`, `plain`, `motion` the truth footprint cosine per iteration and per raw pass. Whether accuracy still rises after the stop decides whether `settle_corr` 0.99 and `settle_share` 0.02 are tight enough (spec §5); say what the numbers show, nothing more.
3. **Speed, native**: per recording the seconds of the raw Refine passes (`stage_times.tsv` rows `pass2` to `pass6`) against the compression replay (`pass2` of `f_chosen`) plus the iterations (`refine_it*`), split into reading, pass A, patches, gate and publish; frames per second of one iteration; one sentence on what limits it.
4. **Missing pixels**: per recording the `low_valid` count and the border cells' footprint cosine against raw (the border group of `factor_closeness.report`), against the other cells.
5. **Machine speed**: `f_null` against `f_chosen` on `plain` (byte-identical footprints or not).
6. **How it was measured**: commit, machine, scale, budget, arms, flags.
7. **What was not measured**: at least the joint flags (3b), the browser, live streams, 600 px against a settled raw Refine, full-length recordings, `--test-frames` other than the default.

Writing rules as in the earlier reports.

- [ ] **Step 3: Docs**

- `docs/CHANGELOG.md`, `## [Unreleased]`: one entry: Refine on factors (`SlowLoop::refine_on_factors`, `refine_until_settled`: footprint statistics from the factors, held-out patches rebuilt from them, the settle stop); `qc_eval --refine-engine factors`.
- `tools/cala-eval/README.md`: lines for the arms `f_chosen`, `f_null` and the settle and iteration tables of the arms' report.

`npx prettier --write` on the two files and the report.

- [ ] **Step 4: Final check and commit**

All checks of Global Constraints.

```bash
git add tools/cala-eval/results docs/CHANGELOG.md tools/cala-eval/README.md
git commit -m "docs(cala-eval): phase 3a results: Refine on factors against a settled raw Refine"
```

---

## Phase 3b: the cluster history replay on factors (task list)

Written in full after 3a's gate and the owner's word on Amendment 2. Each task keeps the bit-identity tests of Global Constraints, `the_cluster_replay_runs_in_visit_jobs_and_matches_step` first among them.

**3b-1. The store's capacity and forgetting in a factor iteration.**

- Find: `new_store` (`cluster.rs` about line 842) sizes the ring as `stats_half_life_frames.ceil() as usize`; with an infinite half-life (the frame route of the equality tests) that asks for `usize::MAX` frames. Change it to `min(half-life, 1 << 20)` frames (bit-identical for every half-life below 2²⁰). `refine_clusters` (about line 1046) weights stored frames by `self.stats_gamma`; a factor gate must use 1.
- Produces: `ClusterStore::new(..., cap)` unchanged in signature; `SlowLoop::gate` sets `stats_gamma` to 1.0 around `refine` and restores it.

**3b-2. Cluster sums from the factors in pass A.**

- Consumes: `greedy_clusters`, `overlap_edges`, `store_geometry`'s pixel rule (union of the members' disks, positive whitening), `owner_cover`, `CellPass` (Task 2).
- Produces: `fn cluster_pass(&self, lib: &Library, cells: &[CellPass], ...) -> Vec<ClusterSums>` filled in pass A from the same window loop: per member `k`, `cy_k(p) = is(p) [Σ c_k ŷ(p) − Σ_{j∉M} a_j(p) Σ c_k c_j − Σ_a g_a(p) Σ c_k β_a − Σ c_k ℓ_owner(p)]` on the cluster's pixels, `sr(p)` likewise with weight 1, `sc`, `scc`, `sw` from traces. A pixel below the valid share is not left out (A8: the replay takes window means; it skips no frame).
- Produces: `ClusterStore::from_sums(ids, disks, pix, is, width, version, cols, cy, sr, sc, scc, sw, cap) -> ClusterStore` with the basis `cy_basis()`.

**3b-3. Each fitting frame's coordinates from the factors in pass B.**

- Consumes: the window's tiles and weights; the store's basis `u` (`pix × rank`).
- Produces: `struct ClusterRows` per window and cluster (`rank` rows per tile: `Σ_p U(p,:) is(p) b_k(p) W_k(p,:)`, and the constant), `M = Uᵀ diag(is) a_j` for the non-members whose column reaches the cluster, the owners' level matrix and the basis matrix (once per iteration); `v_t = rows · v_k(t) + const − M c_t − L ℓ_t − B β_t` appended per fitting frame with its push index and half (`RingHistory::append` through a `pub(super)` method on the store).

**3b-4. Equality with the frame route.**

- Test: the fixture of Task 2 with `joint_update: JointUpdate::All`, the frame route (`observe_lookback` on rebuilt frames, with the valid-share NaNs of Task 2 removed, A8) against `cluster_pass` and the coordinates: `cy`, `sr`, `sc`, `scc`, `sw` to `1e-4 · S + 1e-3`, the basis up to sign, each stored coordinate to rounding, and `ClusterStore::replay` giving the same `Replay` to `1e-4`; then one iteration accepting the same refinements with the joint flags on.
- Lifts the 3a refusal of `joint_update` in `refine_on_factors`.

**3b-5. Harness and gate runs with the joint flags on.**

- `factor_arms.py --extra '--joint-update all --joint-sign all'` into separate output folders, arms `raw,null_lo,f_chosen` as in Task 7; the report's section "Gate, joint flags on" beside 3a's; per recording the replay's counters (`ReplayStats`) of the last raw pass against the last iteration; the cost of the cluster rows per window.

---

## Not in this phase

- The app (phase 4): stages, the Run panel, the compress worker's role in Refine, WASM bindings of `refine_on_factors`.
- A frame-free held-out comparison (projections of the bump background and the patch energy), unless the owner prefers it to the rebuilt patches.
- Look-back on factors (A9, phase 4a's harness flag), and a live stream's factors.
- The transient-band core test (`core_test` other than `Off`) on factors.

## Self-review notes

- Spec coverage: §5 step 1 is pass A's Extract (Task 2); step 2 the sums (Task 2), with §1's `MIN_VALID_SHARE` rule; step 3 the unchanged proposals and gate fed with held-out patches from the factors (Tasks 3, 4; the difference from "projections" is in Design notes); step 4 publish (Task 4); the settle stop with `settle_corr`, `settle_share`, `max_iterations` (Task 4); "the result does not depend on the machine's speed" is the arm `f_null`; the comparison target is the raw arm with 5 Refine passes at 200 px (2 at 600 px, said so). A4/A7's compression replay before Refine is pass 2 of `--refine-engine factors` (Task 5). A8 is phase 3b. A11's gate: Task 7 (joint off) and 3b-5 (joint on).
- Names used across tasks: `BlendLayout::reconstruct_rect`; `FactorSource::{windows, window, stage}`, `RefineStage`, `FactorRefineConfig::{settle_corr, settle_share, max_iterations, test_frames, solver, validate}`, `IterationReport::{.., settled}`, `Settled`, `SlowLoop::{refine_on_factors, sum_pass, install, test_count, pick_tests, test_frames, gate}`, `refine_until_settled`, `footprint_change`, `valid_map`, `check_window`, `LOW_VALID`; `FactorFiles::{open, begin, times}`; `--refine-engine`, `--settle-corr`, `--settle-share`, `--max-iterations`, `--test-frames`; `iterations.tsv`, `footprints_iter{k}.bin`; `footprint_change`, `changed_share`, `read_truth_footprints`, `truth_fp_median`, `library_steps`, `settle_table`, `iteration_table`; arms `f_chosen`, `f_null`.
