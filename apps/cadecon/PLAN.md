# CaDecon Development Plan

> Automated calcium deconvolution using InDeCa-inspired binary spike inference with shared kernel learning.
> This document is the persistent reference across context clears.

---

## Decision Log

| Decision                       | Choice                                       | Rationale                                                                            |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Rust crate placement           | Extend `crates/solver/`                      | Related domain; AR(2) banded convolution reused directly                             |
| Convolution mode               | AR(2) banded only                            | No FFT for CaDecon; banded is the newer, preferred approach                          |
| Threshold search + alpha refit | All in Rust/WASM                             | One WASM call per trace returns s_counts + alpha + baseline + QC                     |
| h_free kernel estimation       | FISTA with lambda=0, non-neg constraint      | Reuses existing FISTA machinery; minimal new code                                    |
| Bi-exponential fitting         | Start grid search, upgrade to LM if needed   | Pragmatic; grid search is parallelizable and simple                                  |
| Upsampling                     | Rust handles internally                      | Pass original trace + upsample factor; Rust builds upsampled kernel, solves, returns |
| Iteration orchestrator         | Main thread coordinator                      | Dispatches to worker pool, collects results, updates UI directly                     |
| Worker file                    | New `cadecon-worker.ts`                      | Clean separation from CaTune; reuses `@calab/compute` worker pool                    |
| Raster UI                      | Auto-placed rectangles on TxN activity image | User configures K, T_sub, N_sub; code auto-places; no manual dragging                |
| Community DB schema            | Kernel params + aggregate stats              | tau_r, tau_d, beta + median alpha, PVE, event rate, cell count                       |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        apps/cadecon/                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │  Stores   │  │  Components  │  │  Workers                  │ │
│  │           │  │              │  │                           │ │
│  │ data-     │  │ ImportOverlay│  │ cadecon-worker.ts         │ │
│  │ store     │  │ RasterView   │  │  ├─ TraceJob (per-trace)  │ │
│  │           │  │ KernelConv   │  │  ├─ KernelJob (subset)    │ │
│  │ iteration-│  │ TraceViewer  │  │  └─ FilterJob (optional)  │ │
│  │ store     │  │ DistCards    │  │                           │ │
│  │           │  │ ControlPanel │  │  Reuses: @calab/compute   │ │
│  │ subset-   │  │ ProgressBar  │  │  worker pool manager      │ │
│  │ store     │  │ Community*   │  │                           │ │
│  └──────────┘  └──────────────┘  └───────────────────────────┘ │
└───────────────────────────┬─────────────────────────────────────┘
                            │ WASM calls
┌───────────────────────────▼─────────────────────────────────────┐
│                   crates/solver/ (extended)                      │
│                                                                  │
│  Existing (reused):          New modules:                        │
│  ├─ fista.rs (FISTA core)    ├─ indeca.rs (top-level API)       │
│  ├─ banded.rs (AR2 conv)     ├─ threshold_search.rs             │
│  ├─ kernel.rs (kernel math)  ├─ upsampling.rs                   │
│  ├─ filter.rs (bandpass)     ├─ kernel_estimation.rs (h_free)   │
│  └─ lib.rs (Solver struct)   └─ biexp_fit.rs (curve fitting)    │
│                                                                  │
│  Existing Solver: Box01 constraint already implemented           │
└──────────────────────────────────────────────────────────────────┘
```

**Shared packages reused directly:**

- `@calab/ui` — DashboardShell, VizLayout, Card, design tokens
- `@calab/io` — NPY/NPZ parsing, bridge API, validation
- `@calab/compute` — Worker pool, kernel math, downsampleMinMax, makeTimeAxis
- `@calab/community` — Auth, submission service factory, analytics, field options
- `@calab/tutorials` — Tutorial engine (Phase 5+)
- `@calab/core` — Types, WASM adapter, AR2 computation, validation schemas

---

## Phase 1: App Scaffold + Data Loading + Subset UI

**Goal:** Functional CaDecon app shell that loads data, displays the TxN raster, and auto-generates subset rectangles.

### 1.1 App scaffold

- [ ] Create `apps/cadecon/` from `apps/_template/` pattern
- [ ] `package.json` with `.calab` metadata (displayName: "CaDecon", description, etc.)
- [ ] `vite.config.ts` with all `@calab/*` aliases + wasm plugin
- [ ] `tsconfig.json` extending base with path aliases
- [ ] `src/index.tsx` entry point (init tutorials, analytics)
- [ ] `src/App.tsx` with auth callback check + import flow + dashboard shell
- [ ] `src/styles/global.css` with CaDecon-specific design token overrides (accent color)
- [ ] Verify `npm run dev -w apps/cadecon` works

### 1.2 Data loading (reuse CaTune patterns)

- [ ] `src/lib/data-store.ts` — signals: rawFile, parsedData, samplingRate, importStep, effectiveShape
- [ ] Import overlay: FileDropZone → DimensionConfirmation → SamplingRateInput → Validation → Ready
- [ ] Support NPY, NPZ, bridge mode (reuse `@calab/io` entirely)
- [ ] Demo data: synthetic traces with known ground truth spikes + known kernel

### 1.3 Subset configuration store

- [ ] `src/lib/subset-store.ts` — signals for subset config:
  - `numSubsets` (K, default 4)
  - `subsetTimeFrames` (T_sub)
  - `subsetCellCount` (N_sub)
  - `overlapAllowed` (default true)
  - `circularShiftEnabled` (default false)
  - `autoMode` (default true — auto-size based on dataset)
- [ ] Auto-generation logic: given (T, N, K, T_sub, N_sub), compute rectangle placements
  - Random placement with optional overlap
  - Coverage stats: % cells covered, % time covered
- [ ] Expose `subsetRectangles: Array<{tStart, tEnd, cellStart, cellEnd}>`

### 1.4 Raster overview component

- [ ] `src/components/RasterOverview.tsx` — canvas-based TxN activity heatmap
  - Render input data as image (cell index on y-axis, time on x-axis)
  - Color by amplitude (e.g., percentile-scaled viridis or grayscale)
  - Downsample for large datasets (bin pixels)
- [ ] Overlay auto-placed subset rectangles with distinct colors/borders
- [ ] Click rectangle → update `selectedSubsetIdx` signal for drill-down (used in Phase 3)
- [ ] Coverage stats display below raster

### 1.5 Control panel (left sidebar)

- [ ] `src/components/controls/` — CaDecon parameter controls:
  - **Dataset settings**: fps display, indicator label input
  - **Subset settings**: K, T_sub, N_sub sliders + auto button
  - **Algorithm settings** (placeholders for Phase 2):
    - Initial kernel: tau_r, tau_d inputs + "auto-init" checkbox
    - Upsample target rate (default 300 Hz) + derived integer u display
    - Weighting on/off
    - Bandpass on/off
    - Max iterations + convergence thresholds
  - **Run controls**: Start / Pause / Stop / Reset buttons (wired in Phase 2)

### 1.6 Layout assembly

- [ ] DashboardShell with CaDecon header (CompactHeader)
- [ ] VizLayout: left sidebar (controls) + center grid (raster + placeholder cards)
- [ ] Right sidebar placeholder (collapsible, for logs/details in Phase 3)

### 1.7 Build integration

- [ ] Add to `scripts/build-apps.mjs` app discovery
- [ ] Add to `scripts/combine-dist.mjs` landing page
- [ ] Verify `npm run build:pages` includes CaDecon

**Exit criteria:** App loads, imports data, shows raster with auto-placed subset rectangles, all control inputs wired to signals.

---

## Phase 2: Core Compute — Rust Solver Extensions + Iteration Loop

**Goal:** Full InDeCa-inspired algorithm running in browser via WASM workers. Kernel converges on subsets, then full per-trace inference runs.

### 2.1 Rust: Upsampling infrastructure — ✅ DONE

- [x] `src/upsample.rs` module in `crates/solver/`
  - `upsample_trace(trace: &[f32], factor: usize) -> Vec<f32>` — zero-insert
  - `downsample_binary(s_bin: &[f32], factor: usize) -> Vec<f32>` — bin-sum
  - `compute_upsample_factor(fs: f64, target_fs: f64) -> usize` — round, min 1
  - 6 tests (identity at factor=1, zero-insertion pattern, round-trip sum, factor computation, empty input, bin-sum)

### 2.2 Rust: Threshold search + alpha/baseline refit — ✅ DONE

- [x] `src/threshold.rs` module (named `threshold.rs`, not `threshold_search.rs`)
  - Coarse-to-fine: 50 coarse thresholds from sorted unique values → 50 fine around best
  - Early termination: 10 consecutive error increases
  - Per threshold: binarize → AR2 forward convolve → lstsq (alpha, baseline via 2x2 normal equations) → weighted error
  - `ThresholdResult { s_binary, alpha, baseline, threshold, pve, error }`
  - Boundary padding: `ceil(2 * tau_d * fs_up)` excluded from error and PVE computation
  - 5 tests (perfect binary recovery, alpha/baseline recovery, PVE > 0.95 on clean data, early termination, empty spikes, boundary padding values)

### 2.3 Rust: InDeCa pipeline — ✅ DONE

- [x] `src/indeca.rs` module (used existing `Solver` struct, no separate `InDecaSolver`)
  - `solve_bounded(trace, tau_r, tau_d, fs, upsample_factor, max_iters, tol, warm_start) -> (Vec<f32>, u32, bool)` — upsample → FISTA with Box01 + BandedAR2 + lambda=0
  - `solve_trace(trace, tau_r, tau_d, fs, upsample_factor, max_iters, tol, warm_start) -> InDecaResult` — full pipeline: solve_bounded → threshold_search → downsample
  - `InDecaResult { s_counts, alpha, baseline, threshold, pve, iterations, converged }`
  - Warm-start: accepts prior solution as initial guess
  - 5 tests (outputs in range, known spike detection, warm-start, upsampled output length, zero trace)

### 2.4 Rust: Free kernel estimation (h_free) — ✅ DONE

- [x] `src/kernel_est.rs` module (named `kernel_est.rs`, not `kernel_estimation.rs`)
  - `estimate_free_kernel(traces, spike_trains, alphas, baselines, kernel_length, fs, max_iters, tol) -> Vec<f32>`
  - FISTA with lambda=0, non-negativity constraint
  - Concatenates multiple traces for shared kernel estimate
  - 4 tests (recovers exponential kernel, non-negativity enforced, multi-trace runs, empty input)

### 2.5 Rust: Bi-exponential fitting — ✅ DONE

- [x] `src/biexp_fit.rs` module
  - 20×20 log-spaced grid search over (tau_r, tau_d)
  - Closed-form beta per grid point
  - Golden-section refinement (not Nelder-Mead)
  - `BiexpResult { tau_rise, tau_decay, beta, residual }`
  - tau_d > tau_r enforced, validity checks
  - 6 tests (recovers known taus, tau_d > tau_r enforced, refinement improves fit, positive beta, empty kernel, various parameter ranges)

### 2.6 Rust: WASM bindings for CaDecon — ✅ DONE

- [x] `src/js_indeca.rs` (gated by `#[cfg(feature = "jsbindings")]`)
  - `indeca_solve_trace(trace, tau_r, tau_d, fs, upsample_factor, max_iters, tol) -> JsValue` (via serde-wasm-bindgen)
  - `indeca_estimate_kernel(traces_flat, spikes_flat, trace_lengths, alphas, baselines, kernel_length, fs, max_iters, tol) -> Vec<f32>`
  - `indeca_fit_biexponential(h_free, fs, refine) -> JsValue`
  - `indeca_compute_upsample_factor(fs, target_fs) -> usize`
  - Added `serde` + `serde-wasm-bindgen` optional deps to Cargo.toml
  - `InDecaResult` and `BiexpResult` derive `Serialize` when `jsbindings` feature is active

### 2.7 TypeScript: CaDecon worker — ✅ DONE

- [x] `src/workers/cadecon-worker.ts`
  - Init WASM on startup → post `ready`
  - `trace-job`: calls `indeca_solve_trace`, posts `trace-complete` with buffer transfers
  - `kernel-job`: calls `indeca_estimate_kernel` + `indeca_fit_biexponential`, posts `kernel-complete`
  - Cooperative cancellation via MessageChannel (same pattern as CaTune)
- [x] `src/workers/cadecon-types.ts` — message type definitions
- [x] `src/lib/cadecon-pool.ts` — `CaDeconPoolJob` + `MessageRouter` implementation + `createCaDeconWorkerPool()`
- [x] **Also refactored**: `packages/compute/src/worker-pool.ts` made generic with `BaseJob`/`MessageRouter<TJob, TOut>` interfaces; CaTune-specific logic extracted to `packages/compute/src/catune-pool.ts`

**Deviation from plan:** Intermediate FISTA progress reporting within trace jobs was not implemented — the worker reports only job completion. This can be added later if needed for large-trace feedback.

### 2.8 TypeScript: Iteration manager — ✅ DONE

- [x] `src/lib/iteration-manager.ts` — orchestrates the full InDeCa loop
  - **startRun():** creates pool, snapshots algorithm params, enters loop:
    1. Per-trace inference on subset cells (parallel trace-jobs via pool)
    2. Per-subset kernel estimation (parallel kernel-jobs via pool)
    3. Merge: median tauRise/tauDecay across subsets
    4. Record in convergenceHistory, update currentTauRise/currentTauDecay
    5. Convergence check: `max(|Δτ_r|/τ_r, |Δτ_d|/τ_d) < convergenceTol`
    6. Finalization pass: re-run trace inference on ALL cells with converged kernel
  - **pauseRun():** sets `runState('paused')`, blocks loop via Promise resolver
  - **resumeRun():** resolves pause Promise, sets `runState('running')`
  - **stopRun():** `pool.cancelAll()`, resolves pause, stores intermediate results
  - **resetRun():** disposes pool + `resetIterationState()`
  - Reads from: `algorithm-store`, `data-store`, `subset-store`

**Deviations from plan:**
- No bandpass preprocessing or weight-array computation implemented (2.8 item 1) — deferred
- Subset informativeness weighting during kernel merge not implemented — uses simple median
- Run provenance (settings snapshot) not stored

### 2.9 TypeScript: Iteration store — ✅ DONE

- [x] `src/lib/iteration-store.ts`
  - `runState: 'idle' | 'running' | 'paused' | 'stopping' | 'complete'`
  - `currentIteration`, `totalSubsetTraceJobs`, `completedSubsetTraceJobs`
  - `convergenceHistory: KernelSnapshot[]` (iteration, tauRise, tauDecay, beta, residual)
  - `currentTauRise`, `currentTauDecay`
  - `perTraceResults: Record<number, { sCounts, alpha, baseline, pve }>`
  - Derived: `isRunning`, `isPaused`, `progress`
  - `resetIterationState()`, `addConvergenceSnapshot()`, `updateTraceResult()`

**Deviation:** No `result-store.ts` — per-trace results live in `iteration-store.ts` directly (simpler).

### 2.10 Wire up run controls + UI — ✅ DONE

- [x] `src/components/controls/RunControls.tsx` — Start/Pause/Resume/Stop/Reset with state-based enable/disable
- [x] `src/components/controls/ProgressBar.tsx` — iteration count, percentage, visual bar with paused/complete states
- [x] `src/components/charts/KernelConvergence.tsx` — canvas-based dual-line chart (tau_rise + tau_decay vs iteration)
  - Originally planned for Phase 3 as a uPlot chart; implemented early as a lightweight canvas chart
  - Empty state: "Run deconvolution to see kernel convergence."
- [x] `src/lib/algorithm-store.ts` — extracted 8 signals + setters from `AlgorithmSettings.tsx` + added `upsampleFactor` derived memo

**Exit criteria:** ✅ Full InDeCa loop runs on subsets, kernel converges, finalization pass produces per-trace s_counts. Minimal UI shows run controls, progress, and kernel convergence chart. 64 Rust tests pass, TypeScript checks pass, dev server runs without errors.

---

## Phase 3: Visualization + QC + Drill-Down

**Goal:** Rich interactive visualization of the algorithm's progress and results.

### 3.1 Kernel convergence plot — PARTIALLY DONE (Phase 2)

- [x] `src/components/charts/KernelConvergence.tsx` — canvas-based line chart (implemented in Phase 2)
  - X-axis: iteration number, Y-axis: tau_rise + tau_decay in ms
  - Live update as iterations complete
- [ ] Upgrade to uPlot for richer interaction (zoom, hover tooltips)
- [ ] Add per-subset scatter points behind the median lines
- [ ] Add secondary Y-axis for PVE or subset variance
- [ ] Mark convergence point

### 3.2 Kernel shape display

- [ ] `src/components/KernelDisplay.tsx` — uPlot chart
  - Show h_free (raw estimate) vs fitted bi-exponential overlay
  - Display tau_r, tau_d, beta values
  - Update per iteration
  - Show per-subset h_free as faint lines, merged kernel as bold

### 3.3 Trace viewer card

- [ ] `src/components/TraceViewer.tsx` — per-trace inspection (similar to CaTune CellCard)
  - Raw trace (y)
  - Reconstructed fit (alpha _ h _ s_counts + baseline)
  - Residual (y - fit)
  - Spike raster (s_counts as vertical ticks, height = count)
  - Pad zone shading (first 2*tau_d*fs frames)
  - uPlot with zoom/pan, downsampleMinMax for large traces

### 3.4 Distribution cards

- [ ] `src/components/distributions/`
  - **AlphaDistribution** — histogram of alpha values across all traces
  - **PVEDistribution** — histogram of PVE across traces
  - **EventRateDistribution** — histogram of spikes/second per trace
  - **SubsetVariance** — bar chart of subset-to-subset kernel estimate spread
  - Each card: uPlot histogram, summary stats (median, IQR), optional "your run" marker

### 3.5 Raster drill-down

- [ ] Click subset rectangle in RasterOverview → update selectedSubsetIdx
- [ ] Show selected subset's traces in TraceViewer cards (grid of N_sub cells)
- [ ] Show subset-specific kernel fit quality

### 3.6 Progress and status

- [ ] Progress bar component: phase indicator (preprocessing | inference | kernel update | merge)
- [ ] Per-worker status indicators (idle/busy count)
- [ ] Iteration summary log (collapsible right sidebar)

### 3.7 Center grid layout

- [ ] Assemble center grid as card grid:
  - Row 1: RasterOverview (wide) + KernelConvergence (wide)
  - Row 2: KernelDisplay + TraceViewer (selected trace)
  - Row 3: Distribution cards (alpha, PVE, event rate, subset variance)
  - Responsive: stack on narrow screens

**Exit criteria:** All visualization cards populated with live data during runs. Click-to-inspect works. Distribution plots update after finalization.

---

## Phase 4: Community DB Integration

**Goal:** Parity with CaTune community features — upload, browse, compare kernel params + QC.

### 4.1 Supabase table + service

- [ ] Create `cadecon_submissions` table (extends BaseSubmission):
  ```
  tau_rise FLOAT, tau_decay FLOAT, beta FLOAT,
  ar2_g1 FLOAT, ar2_g2 FLOAT,
  upsample_factor INT, sampling_rate FLOAT,
  median_alpha FLOAT, median_pve FLOAT,
  mean_event_rate FLOAT, num_cells INT,
  num_iterations INT, converged BOOLEAN,
  weighting_enabled BOOLEAN, bandpass_enabled BOOLEAN,
  + all BaseSubmission fields (indicator, species, brain_region, etc.)
  ```
- [ ] `src/lib/community/cadecon-service.ts` using `createSubmissionService<CaDeconSubmission>()`
- [ ] RLS policies (same pattern as CaTune)

### 4.2 Submission flow

- [ ] `src/components/community/SubmitPanel.tsx`
  - Gate on: kernel converged + finalization complete
  - Collect metadata (indicator, species, brain region, etc.)
  - Compute dataset hash, AR2 coefficients
  - Package kernel params + aggregate stats
  - Submit to Supabase
- [ ] Quality validation (parameter range checks)

### 4.3 Community browser

- [ ] `src/components/community/CommunityBrowser.tsx`
  - Scatter plot: tau_r vs tau_d (same axes as CaTune for cross-app comparison)
  - Filter bar: indicator, species, brain region, fps range
  - "Compare my run" overlay
  - Distribution views: community tau_r, tau_d, event rate distributions

### 4.4 Sidebar integration

- [ ] Community tab in SidebarTabs (same pattern as CaTune)
- [ ] Lazy-load community components

**Exit criteria:** Users can upload results, browse community distributions, compare their kernel to others.

---

## Phase 5: Export/Import + Reproducibility

**Goal:** Full run artifact export and reload capability.

### 5.1 Export schema

- [ ] `@calab/core` addition: `CaDeconExportSchema` (valibot)
  - Kernel: tau_r, tau_d, beta, h_free, h_sampled
  - Per-trace: alpha_i, baseline_i, s_counts_i (sparse or dense)
  - Run config: subset layout, upsample factor, convergence thresholds, weighting/filter settings
  - Convergence history: per-iteration tau_r, tau_d, PVE, subset variance
  - Metadata: fps, num_cells, num_timepoints, app_version

### 5.2 Export action

- [ ] JSON export (primary): `downloadExport()` pattern from `@calab/io`
- [ ] Binary export (optional): sparse s_counts as compressed binary for large datasets
- [ ] Bridge export: `postResultsToBridge()` for Python integration

### 5.3 Import/reload

- [ ] Load export JSON → restore all settings, kernel, subset layout
- [ ] Regenerate all plots from stored data (no re-run needed)
- [ ] Optional: "Re-run finalization" button with loaded kernel on new/same data

**Exit criteria:** Round-trip export → import restores full state and plots.

---

## Phase 6 (Deferred): Python Package Extension

**Goal:** `calab.deconvolve()` or `calab.cadecon` module in the Python package.

### 6.1 Export → Python workflow

- [ ] Load CaDecon JSON export in Python
- [ ] Apply learned kernel to new data
- [ ] Access s_counts, alpha, baseline per trace

### 6.2 Native Python solver (optional)

- [ ] PyO3 bindings for InDeCa Rust functions
- [ ] `calab.deconvolve(traces, fs=30)` → returns kernel + per-trace results
- [ ] Matches browser algorithm exactly (same Rust code)

**Exit criteria:** Python users can consume CaDecon results; optionally run the solver natively.

---

## Phase 7 (Deferred): Tutorials + Polish

### 7.1 Tutorial content

- [ ] Beginner tutorial: "Your first automated deconvolution"
- [ ] Theory tutorial: "Understanding InDeCa's approach"
- [ ] Advanced tutorial: "Tuning subset strategy for your data"

### 7.2 Performance optimization

- [ ] Multi-resolution schedule (coarser u early, finer u late)
- [ ] Weighting window optimization (skip zero-weight regions)
- [ ] Memory profiling and optimization for large datasets

### 7.3 UX polish

- [ ] Keyboard shortcuts
- [ ] Responsive layout refinements
- [ ] Loading states and error boundaries

---

## Key Technical Notes

### AR(2) Banded Convolution for CaDecon

CaDecon uses banded AR(2) convolution exclusively (no FFT). The existing `BandedAR2` struct in `banded.rs` supports:

- `convolve_forward(s, c)`: given spikes s, produce calcium c
- `convolve_adjoint(r, g)`: transpose operation for FISTA gradient
- AR(2) coefficients computed from bi-exponential (tau_r, tau_d) at the upsampled sampling rate

### Threshold Search Strategy (Designed)

Instead of brute-force N=1000 uniform thresholds:

1. Collect unique values from relaxed s (typically << T for sparse solutions)
2. Select ~100 evenly spaced quantiles from unique values
3. For each threshold: binarize, AR(2) reconvolve, least-squares alpha/baseline, score
4. Coarse-to-fine: pick top-5, refine with 20 thresholds around each, pick global best
5. Early termination: if error rises for 10 consecutive thresholds, stop
   Total: ~150-200 candidate evaluations instead of 1000

### Padding Rule

Exclude first `pad_start = ceil(2 * tau_d * fs_upsampled)` bins from:

- FISTA objective (set weight to 0 for those bins)
- Threshold search error computation
- Reported PVE and fit metrics
  This prevents convolution boundary artifacts from biasing results.

### Warm-Start for Per-Trace Inference

Between iterations:

- Expand prior `s_counts` into upsampled binary bins as initial guess for FISTA
- Carry forward alpha, baseline from prior iteration
- Reset FISTA momentum (kernel changed between iterations)

### Error Weighting (iter > 0)

Weight vector w: set w_t = 1 for frames within `r_frames` after any spike, 0 elsewhere.

- First iteration: w = 1 everywhere (no prior spikes)
- Applied only during alpha update phase, not final solve
- PVE computed using weighted errors for fair comparison across iterations

### Memory Strategy

- Never store full upsampled arrays for all traces
- Store only: s_counts (integer, original rate), alpha, baseline per trace
- For inspected traces: store upsampled solution temporarily for visualization
- Worker returns only s_counts (downsampled) to main thread

---

## File Structure

```
apps/cadecon/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── PLAN.md                          ← this file
├── src/
│   ├── index.tsx                    # Entry point
│   ├── App.tsx                      # Import gating + dashboard layout
│   ├── vite-env.d.ts
│   ├── components/
│   │   ├── layout/
│   │   │   ├── CaDeconHeader.tsx    # ✅ Phase 1
│   │   │   ├── ImportOverlay.tsx    # ✅ Phase 1
│   │   │   ├── AuthMenuWrapper.tsx  # ✅ Phase 1
│   │   │   └── SidebarTabs.tsx      # Phase 4
│   │   ├── import/                  # ✅ Phase 1 (all 6 files)
│   │   │   ├── FileDropZone.tsx
│   │   │   ├── NpzArraySelector.tsx
│   │   │   ├── DimensionConfirmation.tsx
│   │   │   ├── SamplingRateInput.tsx
│   │   │   ├── DataValidationReport.tsx
│   │   │   └── TracePreview.tsx
│   │   ├── controls/
│   │   │   ├── ParameterSlider.tsx   # ✅ Phase 1 (reusable)
│   │   │   ├── AlgorithmSettings.tsx # ✅ Phase 1 (signals + UI)
│   │   │   ├── SubsetConfig.tsx      # ✅ Phase 1
│   │   │   └── RunControls.tsx       # ✅ Phase 1 (disabled stubs)
│   │   ├── raster/
│   │   │   └── RasterOverview.tsx    # ✅ Phase 1
│   │   ├── charts/
│   │   │   └── KernelConvergence.tsx # ✅ Phase 2 (canvas, upgrade to uPlot in Phase 3)
│   │   ├── kernel/                   # Phase 3
│   │   │   └── KernelDisplay.tsx
│   │   ├── traces/                   # Phase 3
│   │   │   └── TraceViewer.tsx
│   │   ├── distributions/            # Phase 3
│   │   │   ├── AlphaDistribution.tsx
│   │   │   ├── PVEDistribution.tsx
│   │   │   ├── EventRateDistribution.tsx
│   │   │   └── SubsetVariance.tsx
│   │   ├── community/               # Phase 4
│   │   │   ├── SubmitPanel.tsx
│   │   │   ├── CommunityBrowser.tsx
│   │   │   └── ScatterPlot.tsx
│   │   └── progress/
│   │       └── ProgressBar.tsx       # ✅ Phase 2
│   ├── lib/
│   │   ├── data-store.ts            # ✅ Phase 1 (+ groundTruthTau signals)
│   │   ├── auth-store.ts            # ✅ Phase 1
│   │   ├── analytics-integration.ts # ✅ Phase 1
│   │   ├── algorithm-store.ts       # ✅ Phase 2 (extracted from AlgorithmSettings)
│   │   ├── subset-store.ts          # ✅ Phase 1 (LCG placement)
│   │   ├── iteration-store.ts       # ✅ Phase 2
│   │   ├── iteration-manager.ts     # ✅ Phase 2
│   │   ├── cadecon-pool.ts          # ✅ Phase 2
│   │   ├── community/               # Phase 4
│   │   │   ├── cadecon-service.ts
│   │   │   ├── community-store.ts
│   │   │   └── quality-checks.ts
│   │   └── chart/                   # Phase 3
│   │       └── series-config.ts
│   ├── workers/                     # ✅ Phase 2
│   │   ├── cadecon-worker.ts
│   │   └── cadecon-types.ts
│   └── styles/
│       ├── global.css               # ✅ Phase 1 (teal accent)
│       ├── raster.css               # ✅ Phase 1
│       ├── controls.css             # ✅ Phase 1
│       ├── layout.css               # Phase 3
│       └── distributions.css        # Phase 3

crates/solver/src/
├── (existing files unchanged)
├── indeca.rs                        # ✅ Phase 2 — Top-level CaDecon pipeline API
├── threshold.rs                     # ✅ Phase 2 — Threshold sweep + alpha refit
├── upsample.rs                      # ✅ Phase 2 — Upsample/downsample utilities
├── kernel_est.rs                    # ✅ Phase 2 — h_free via FISTA NNLS
├── biexp_fit.rs                     # ✅ Phase 2 — Bi-exponential curve fitting
└── js_indeca.rs                     # ✅ Phase 2 — WASM bindings (jsbindings feature)
```

---

## Phase 1 Implementation Notes

> Details future phases need about how Phase 1 was actually built.

### File structure deviations from plan

- Import sub-components live at `components/import/{FileDropZone,NpzArraySelector,DimensionConfirmation,SamplingRateInput,DataValidationReport,TracePreview}.tsx` — each is a verbatim copy from CaTune with store imports adjusted to `../../lib/data-store.ts`.
- `ImportOverlay.tsx` is at `components/layout/ImportOverlay.tsx` (not `components/import/`).
- There is no `ParameterPanel.tsx` — algorithm controls are in `AlgorithmSettings.tsx` and subset controls in `SubsetConfig.tsx`, both under `components/controls/`.
- `AuthMenuWrapper.tsx` + `auth-store.ts` were added (same pattern as CaRank) to wire Supabase auth.

### Signal locations Phase 2 must import from

| Signal group                                                                                                                                   | Module                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Import pipeline (parsedData, effectiveShape, samplingRate, importStep…)                                                                        | `lib/data-store.ts`                         |
| Ground truth tau (groundTruthTauRise, groundTruthTauDecay) — demo only                                                                         | `lib/data-store.ts`                         |
| Subset config (numSubsets, effectiveTSub, effectiveNSub, subsetRectangles, seed)                                                               | `lib/subset-store.ts`                       |
| Algorithm params (tauRiseInit, tauDecayInit, autoInitKernel, upsampleTarget, maxIterations, convergenceTol, weightingEnabled, bandpassEnabled) | `lib/algorithm-store.ts` (**moved in Phase 2**) |
| Iteration state (runState, currentIteration, convergenceHistory, perTraceResults, progress) | `lib/iteration-store.ts` (**Phase 2**) |

**Note:** Algorithm signals were extracted from `AlgorithmSettings.tsx` into `lib/algorithm-store.ts` during Phase 2, as anticipated. `AlgorithmSettings.tsx` now imports from the store.

### Package-level changes

- `@calab/community`: `AppLabel` type expanded to include `'cadecon'` (in `github-issue-url.ts`) and `initSession` accepts `'cadecon'` (in `analytics.ts`).

### Subset store details

- `subsetRectangles` uses a seeded LCG (`state * 1664525 + 1013904223`, unsigned 32-bit) for deterministic placement. The `seed` signal (default 42) can be randomized via the "Randomize Layout" button.
- `circularShiftEnabled` signal exists but is not yet wired to placement logic — Phase 2 can implement circular shift if needed.
- Coverage stats (`coverageStats` memo) gives `{ cellPct, timePct }` — time coverage is approximate for overlapping subsets.

### Raster rendering

- `RasterOverview.tsx` uses a viridis LUT (11-stop linear interpolation, 256 entries) with 1st–99th percentile scaling.
- Canvas renders at `devicePixelRatio` for HiDPI. Height is `min(max(200, N*3), 500)` pixels.
- Click detection uses pixel-to-data coordinate mapping against `subsetRectangles`.

### Accent color

CSS custom property overrides in `global.css`:

```css
:root {
  --accent: #1a7a5e;
  --accent-muted: rgba(26, 122, 94, 0.12);
  --accent-strong: #146b51;
}
```

---

## Phase 2 Implementation Notes

> Details future phases need about how Phase 2 was actually built.

### Rust module naming deviations

Plan names → actual names:
- `upsampling.rs` → `upsample.rs`
- `threshold_search.rs` → `threshold.rs`
- `kernel_estimation.rs` → `kernel_est.rs`
- `indeca.rs` — same
- `biexp_fit.rs` — same

All modules are `pub(crate)` (not `pub`) to avoid `private_interfaces` warnings, since they use internal types like `BandedAR2`. The WASM bindings in `js_indeca.rs` are the public API boundary.

### Worker pool refactoring

`packages/compute/src/worker-pool.ts` was refactored to be generic:
- `BaseJob` and `MessageRouter<TJob, TOut>` interfaces define the contract
- `createWorkerPool<TJob, TOut>(createWorker, router, poolSize?)` is the generic factory
- CaTune-specific logic extracted to `packages/compute/src/catune-pool.ts` (`createCaTuneWorkerPool`)
- CaDecon uses its own `CaDeconPoolJob` and router in `src/lib/cadecon-pool.ts`

### WASM serialization

Complex return types (`InDecaResult`, `BiexpResult`) use `serde-wasm-bindgen` for serialization to `JsValue`. Simple return types (arrays, scalars) use standard `wasm-bindgen` types. The `serde` and `serde-wasm-bindgen` crates are optional deps gated by the `jsbindings` feature.

### Iteration manager architecture

The iteration loop runs on the main thread and dispatches jobs to the worker pool:
1. **Per-trace inference**: dispatches `TraceJob` for each cell in each subset rectangle
2. **Kernel estimation**: dispatches `KernelJob` per subset with concatenated traces/spikes
3. **Merge**: median of subset tau estimates (no informativeness weighting yet)
4. **Convergence**: `max(|Δτ_r|/τ_r, |Δτ_d|/τ_d) < convergenceTol`
5. **Finalization**: re-runs all cells with converged kernel

Pause/resume uses a Promise-based mechanism — the loop `await`s a resolver that only fires on resume.

### Layout fix for kernel convergence chart

The canvas in `KernelConvergence.tsx` must be `position: absolute` inside a `position: relative` wrapper to prevent ResizeObserver feedback loops. The wrapper has `flex: 1; min-height: 0` to fill remaining space in the fixed-height panel. The panel itself uses `flex: 0 0 180px` via `[data-panel-id='kernel-convergence']` CSS selector (DashboardPanel renders `id` prop as `data-panel-id` attribute, not HTML `id`).

### Features NOT yet implemented (deferred)

- Bandpass preprocessing before deconvolution (algorithm setting exists but not wired)
- Error weighting by spike proximity (weight vector w)
- Subset informativeness weighting during kernel merge
- Run provenance (settings snapshot at start)
- Intermediate FISTA progress reporting from worker
- `result-store.ts` — per-trace results live in `iteration-store.ts` directly

---

## Progress Tracker

| Phase                                | Status      | Notes                                                             |
| ------------------------------------ | ----------- | ----------------------------------------------------------------- |
| Phase 1: Scaffold + Data + Subset UI | COMPLETE    |                                                                   |
| Phase 2: Core Compute                | COMPLETE    | PR #86 — 6 Rust modules, 64 tests, WASM bindings, worker, UI     |
| Phase 3: Visualization + QC          | NOT STARTED | KernelConvergence chart pulled forward into Phase 2 (canvas-based)|
| Phase 4: Community DB                | NOT STARTED |                                                                   |
| Phase 5: Export/Import               | NOT STARTED |                                                                   |
| Phase 6: Python Extension            | DEFERRED    |                                                                   |
| Phase 7: Tutorials + Polish          | DEFERRED    |                                                                   |
