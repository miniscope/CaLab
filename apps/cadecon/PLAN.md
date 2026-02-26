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
  - `upsample_trace(trace: &[f32], factor: usize) -> Vec<f32>` — linear interpolation (not zero-insert)
  - `downsample_binary(s_bin: &[f32], factor: usize) -> Vec<f32>` — bin-sum
  - `compute_upsample_factor(fs: f64, target_fs: f64) -> usize` — round, min 1
  - 6 tests (identity at factor=1, linear interpolation pattern, round-trip sum, factor computation, empty input, bin-sum)

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

- ~~No bandpass preprocessing~~ — bandpass filter wired through in later commit (filterEnabled → worker → WASM → Rust)
- Weight-array computation not implemented — deferred
- Subset informativeness weighting during kernel merge not implemented — uses simple median
- Run provenance (settings snapshot) not stored

### 2.9 TypeScript: Iteration store — ✅ DONE

- [x] `src/lib/iteration-store.ts`
  - `runState: 'idle' | 'running' | 'paused' | 'stopping' | 'complete'`
  - `currentIteration`, `totalSubsetTraceJobs`, `completedSubsetTraceJobs`
  - `convergenceHistory: KernelSnapshot[]` (iteration, tauRise, tauDecay, beta, residual + per-subset snapshots)
  - `currentTauRise`, `currentTauDecay`
  - `perTraceResults: Record<number, { sCounts, alpha, baseline, pve }>` — populated with full-length results during iterations (subset cells) and finalization (all cells)
  - `debugTraceSnapshots: DebugTraceSnapshot[]` — per-iteration snapshot of a single cell (raw trace, spike counts, reconvolved fit)
  - `debugKernelSnapshots` — per-iteration snapshot of free kernel + fitted bi-exponential per subset
  - Derived: `progress`
  - `resetIterationState()`, `addConvergenceSnapshot()`, `updateTraceResult()`, `addDebugTraceSnapshot()`, `addDebugKernelSnapshot()`

**Deviation:** No `result-store.ts` — per-trace results live in `iteration-store.ts` directly (simpler).

### 2.10 Wire up run controls + UI — ✅ DONE

- [x] `src/components/controls/RunControls.tsx` — Start/Pause/Resume/Stop/Reset with state-based enable/disable
- [x] `src/components/controls/ProgressBar.tsx` — iteration count, percentage, visual bar with paused/complete states
- [x] `src/components/charts/KernelConvergence.tsx` — canvas-based dual-line chart (tau_rise + tau_decay vs iteration)
  - Originally planned for Phase 3 as a uPlot chart; implemented early as a lightweight canvas chart
  - Per-subset scatter points behind the median lines
  - Empty state: "Run deconvolution to see kernel convergence."
- [x] `src/lib/algorithm-store.ts` — extracted 8 signals + setters from `AlgorithmSettings.tsx` + added `upsampleFactor` derived memo

### 2.11 Debug visualization charts — ✅ DONE

- [x] `src/components/charts/DebugTraceChart.tsx` — canvas overlay of raw trace + AR2-reconvolved fit + spike counts for a single debug cell, updated per iteration
- [x] `src/components/charts/DebugKernelChart.tsx` — canvas overlay of free-form kernel (h_free) vs fitted bi-exponential per subset per iteration
- [x] `src/lib/iteration-manager.ts` — reconvolveAR2() helper computes peak-normalized AR2 forward model for debug trace overlay

### 2.12 Bandpass filter wiring — ✅ DONE

- [x] Threaded `filterEnabled` from `algorithm-store` → `iteration-manager` → pool → worker → WASM → Rust `indeca::solve_trace`
- [x] Matches CaTune approach: bandpass applied to trace before FISTA

### 2.13 Subset config UX improvements — ✅ DONE

- [x] Replaced auto-size toggle + conditional T_SUB/N_SUB sliders with 3 always-enabled sliders: K (num subsets), Total Coverage (%), Aspect Ratio (log-scale centered at 1.0)
- [x] Coverage defaults to 50%, aspect ratio slider uses log scale for balanced exploration

### 2.14 Warm-start for trace inference and kernel estimation — ✅ DONE

- [x] **Trace warm-start**: previous iteration's `s_counts` (original rate) carried per-cell across iterations. `upsample_counts_to_binary()` in `upsample.rs` converts to upsampled-rate binary for FISTA warm-start — for each bin with count C, places min(C, factor) ones at the start of the upsampled window. Finalization pass also warm-starts from the last subset iteration where cell data is available.
- [x] **Kernel warm-start**: previous iteration's `h_free` per subset passed as initial guess to `estimate_free_kernel()`. FISTA momentum resets since spike trains change between iterations.
- [x] Full path for both: `iteration-manager.ts` → `cadecon-pool.ts` → `cadecon-types.ts` → `cadecon-worker.ts` → `js_indeca.rs` → Rust solver
- [x] 4 new Rust tests for `upsample_counts_to_binary` (spike conservation, factor cap, factor-1, roundtrip)

**Exit criteria:** ✅ Full InDeCa loop runs on subsets, kernel converges, finalization pass produces per-trace s_counts. UI shows run controls, progress, kernel convergence chart, debug trace/kernel charts. Bandpass filter wired end-to-end. Warm-start active for both trace and kernel FISTA solvers. 71 Rust tests pass, TypeScript checks pass, dev server runs without errors.

---

## Phase 3: Visualization + QC + Drill-Down — ✅ COMPLETE

**Goal:** Rich interactive visualization of the algorithm's progress and results.

### 3.1 Kernel convergence plot — ✅ DONE

- [x] `src/components/charts/KernelConvergence.tsx` — **rewrote** from canvas to SolidUplot
  - Left Y-axis: tau_rise + tau_decay (ms) as line series with dot markers
  - Right Y-axis (secondary): residual on `'res'` scale, dashed gray line
  - Per-subset scatter: custom `draw` hook plugin draws faint circles behind median lines
  - Convergence marker: `convergence-marker-plugin.ts` draws vertical dashed green line at `convergedAtIteration()`
  - Empty state: `<Show when={convergenceHistory().length > 0}>` gate with placeholder text
  - Wheel zoom + cursor sync key `'cadecon-convergence'`

### 3.2 Kernel shape display — ✅ DONE

- [x] **Deleted** `src/components/charts/DebugKernelChart.tsx`
- [x] **Created** `src/components/kernel/KernelDisplay.tsx` — uPlot chart with:
  - Per-subset h_free as faint colored lines (D3 category10 with 0.4 opacity)
  - Merged bi-exponential fit as bold dashed purple line
  - X-axis: time in ms, Y-axis: amplitude
  - DOM overlay stats: tau_r, tau_d, beta values
  - Reads `viewedIteration()` from viz-store (null = latest)
  - Handles dynamic subset count via recreating series config
  - Cursor sync key `'cadecon-kernel'`

### 3.3 Trace viewer card — ✅ DONE

- [x] **Deleted** `src/components/charts/DebugTraceChart.tsx`
- [x] **Created** `src/components/traces/TraceViewer.tsx` — CellCard-inspired trace inspector
  - **Unified mode:** Shows any subset cell during iterations and any cell after finalization, both from `perTraceResults`
  - **Top chart:** raw trace + reconvolved fit + residual via `TracePanel`
    - Series visibility toggled via uPlot `setSeries()` API (not NaN data swapping)
    - `transient-zone-plugin` shades pad zone: `ceil(2 * tauDecay * fs)` frames
    - `downsampleMinMax` for traces > ~4000 points
  - **Bottom chart:** spike counts as stem lines via custom paths callback
  - **Zoom sync:** bidirectional x-scale sync between trace and spike charts via `setScale` hook plugins
  - **Header:** CellSelector + SeriesToggleBar + stats (alpha, PVE, spike count)
  - `makeTimeAxis` from `@calab/compute` for X-axis
  - `reconvolveAR2()` computed on-demand for selected cell
- [x] **Created** `src/components/traces/TracePanel.tsx` — reusable uPlot wrapper (adapted from CaTune)
  - `onCreate` callback for chart ref access (series toggling, zoom sync)
- [x] **Created** `src/components/traces/CellSelector.tsx` — `<select>` dropdown + prev/next arrows
  - During iteration: cells from union of subset rectangles
  - After finalization: `0..numCells-1`
  - Writes to `inspectedCellIndex` in viz-store
- [x] **Created** `src/components/traces/SeriesToggleBar.tsx` — row of 5 compact swatch+checkbox toggles (Raw, Reconv, Resid, Spikes, Weight)
  - Reads/writes from viz-store signals

### 3.4 Distribution cards — ✅ DONE

- [x] `src/components/distributions/HistogramCard.tsx` — reusable with:
  - Custom bar-drawing `paths` callback (no uPlot series limitations)
  - Summary stats: Median, IQR, N (mono font)
  - Empty state when `values().length === 0`
  - Live updates: reactive `values()` accessor triggers recomputation
- [x] `AlphaDistribution.tsx` — `values={alphaValues}`, blue
- [x] `PVEDistribution.tsx` — `values={pveValues}`, green
- [x] `EventRateDistribution.tsx` — `values={eventRates}` (spikes/sec computed from `durationSeconds`), orange
- [x] `SubsetVariance.tsx` — grouped bar chart (tau_rise blue, tau_decay red):
  - Horizontal dashed lines at merged median values via custom plugin
  - Reads from `subsetVarianceData` memo in iteration-store
- [x] **Live iteration updates:** `iteration-manager.ts` publishes full-length per-cell results to `perTraceResults` after each iteration's inference phase (not just during finalization). Distributions update progressively as iterations run.

### 3.5 Subset drill-down — ✅ DONE

- [x] `src/components/drilldown/SubsetDrillDown.tsx` — appears when `selectedSubsetIdx() !== null`, replaces distribution card row
  - Header: "Subset K{n} Details" + Close button
  - Contains SubsetKernelFit + SubsetStats + Cell browser (CellSelector + TraceViewer)
- [x] `src/components/drilldown/SubsetKernelFit.tsx` — small uPlot chart with subset's h_free (bold, subset color) + merged bi-exp (dashed purple)
- [x] `src/components/drilldown/SubsetStats.tsx` — stats table: tau_r, tau_d, beta, residual (this subset vs merged), cell range, time range

**Deviations from plan:**

- Per-worker status indicators deferred to Phase 7
- Iteration summary log sidebar deferred to Phase 7

### 3.6 Progress and status — ✅ DONE

- [x] `ProgressBar.tsx` updated with phase indicator below progress bar
  - Maps: `inference` → "Trace inference", `kernel-update` → "Kernel estimation", `merge` → "Merging subsets", `finalization` → "Finalizing all cells"
  - Styled in accent italic
- [x] `RunPhase` type added to iteration-store: `'idle' | 'inference' | 'kernel-update' | 'merge' | 'finalization'`
- [x] `iteration-manager.ts` calls `setRunPhase()` at each stage transition

### 3.7 Center grid layout — ✅ DONE

- [x] `App.tsx` rewritten with 3-row grid:
  - Row 1 (flex: 1 1 0, min-h 200): Raster (60%) | KernelConvergence (40%)
  - Row 2 (flex: 1 1 0, min-h 180): KernelDisplay (280px fixed) | TraceViewer (flex 1)
  - Row 3 (flex: 0 0 auto): 4 distribution cards OR SubsetDrillDown
- [x] Responsive: columns stack at 900px, distribution cards wrap at 50%

### 3.8 Store additions — ✅ DONE

- [x] `src/lib/viz-store.ts` — new file with: `viewedIteration`, `inspectedCellIndex`, series visibility toggles (`showRawTrace`, `showReconvolved`, `showResidual`, `showSpikes`, `showWeight`), `selectedSubsetIdx`
- [x] `iteration-store.ts` extended with: `RunPhase` type, `runPhase`/`convergedAtIteration`/`selectedCellIndex` signals, distribution memos (`alphaValues`, `pveValues`, `eventRateValues`, `subsetVarianceData`)
- [x] `iteration-manager.ts` updated with `setRunPhase` calls and `setConvergedAtIteration` on convergence

### 3.9 Chart infrastructure — ✅ DONE

- [x] Added `uplot` + `@dschz/solid-uplot` to `apps/cadecon/package.json`
- [x] `src/lib/chart/series-config.ts` — 11 series factories + `withOpacity` helper + D3 category10 palette
- [x] `src/lib/chart/chart-theme.css` — uPlot theme overrides (copied from CaTune)
- [x] `src/lib/chart/wheel-zoom-plugin.ts` — scroll zoom + drag pan (copied from CaTune)
- [x] `src/lib/chart/theme-colors.ts` — CSS custom property reader (adapted for CaDecon accent)
- [x] `src/lib/chart/transient-zone-plugin.ts` — pad zone shading (copied from CaTune)
- [x] `src/lib/chart/convergence-marker-plugin.ts` — convergence vertical dashed line

### 3.10 CSS — ✅ DONE

- [x] `src/styles/layout.css` — `.viz-grid` 3-row flex layout with responsive stacking
- [x] `src/styles/distributions.css` — histogram card styling
- [x] `src/styles/trace-viewer.css` — cell selector, series toggle bar, trace viewer header/stats
- [x] `src/styles/kernel-display.css` — kernel display stats and empty state
- [x] `src/styles/drilldown.css` — subset drill-down header, aggregate, cell browser, stats table
- [x] `src/styles/controls.css` — removed old debug CSS rules, added `.progress-bar__phase`

**Exit criteria:** ✅ All visualization cards populated with live data during runs. KernelConvergence shows per-subset scatter + convergence marker. KernelDisplay shows per-subset h_free + merged fit. TraceViewer supports cell selection with independently toggleable series (via `setSeries`) and bidirectional zoom sync between trace and spike charts. Distribution cards update progressively during each iteration (not just finalization). Subset drill-down replaces distributions on click. ProgressBar shows phase labels. 3-row responsive grid layout. Build passes with 0 errors.

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
│   │   │   └── KernelConvergence.tsx # ✅ Phase 3 (uPlot rewrite with scatter + convergence marker)
│   │   ├── kernel/                   # ✅ Phase 3
│   │   │   └── KernelDisplay.tsx     # uPlot: per-subset h_free + merged bi-exp fit
│   │   ├── traces/                   # ✅ Phase 3
│   │   │   ├── TracePanel.tsx        # Reusable uPlot wrapper (from CaTune)
│   │   │   ├── TraceViewer.tsx       # CellCard-inspired trace inspector
│   │   │   ├── CellSelector.tsx      # Dropdown + prev/next arrows
│   │   │   └── SeriesToggleBar.tsx   # Series visibility toggles
│   │   ├── distributions/            # ✅ Phase 3
│   │   │   ├── HistogramCard.tsx     # Reusable histogram with bar paths
│   │   │   ├── AlphaDistribution.tsx
│   │   │   ├── PVEDistribution.tsx
│   │   │   ├── EventRateDistribution.tsx
│   │   │   └── SubsetVariance.tsx    # Grouped bar chart with median lines
│   │   ├── drilldown/                # ✅ Phase 3
│   │   │   ├── SubsetDrillDown.tsx   # Container with kernel + stats + cell browser
│   │   │   ├── SubsetKernelFit.tsx   # Subset h_free vs merged fit
│   │   │   └── SubsetStats.tsx       # Subset vs merged stats table
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
│   │   ├── data-utils.ts            # ✅ Phase 2 (extractCellTrace helper)
│   │   ├── iteration-manager.ts     # ✅ Phase 2
│   │   ├── cadecon-pool.ts          # ✅ Phase 2
│   │   ├── viz-store.ts             # ✅ Phase 3 (viewedIteration, inspectedCell, toggles)
│   │   ├── community/               # Phase 4
│   │   │   ├── cadecon-service.ts
│   │   │   ├── community-store.ts
│   │   │   └── quality-checks.ts
│   │   └── chart/                   # ✅ Phase 3
│   │       ├── series-config.ts     # 11 series factories + withOpacity + D3 palette
│   │       ├── chart-theme.css      # uPlot theme overrides
│   │       ├── wheel-zoom-plugin.ts # Scroll zoom + drag pan
│   │       ├── theme-colors.ts      # CSS variable reader
│   │       ├── transient-zone-plugin.ts # Pad zone shading
│   │       └── convergence-marker-plugin.ts # Convergence vertical line
│   ├── workers/                     # ✅ Phase 2
│   │   ├── cadecon-worker.ts
│   │   └── cadecon-types.ts
│   └── styles/
│       ├── global.css               # ✅ Phase 1 (teal accent)
│       ├── raster.css               # ✅ Phase 1
│       ├── controls.css             # ✅ Phase 1 (updated Phase 3: removed debug CSS, added phase)
│       ├── layout.css               # ✅ Phase 3 (3-row viz grid)
│       ├── distributions.css        # ✅ Phase 3 (histogram cards)
│       ├── trace-viewer.css         # ✅ Phase 3 (cell selector, toggle bar, stats)
│       ├── kernel-display.css       # ✅ Phase 3 (kernel stats, empty state)
│       └── drilldown.css            # ✅ Phase 3 (drill-down header, aggregate, table)

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

| Signal group                                                                                                                                   | Module                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Import pipeline (parsedData, effectiveShape, samplingRate, importStep…)                                                                        | `lib/data-store.ts`                             |
| Ground truth tau (groundTruthTauRise, groundTruthTauDecay) — demo only                                                                         | `lib/data-store.ts`                             |
| Subset config (numSubsets, effectiveTSub, effectiveNSub, subsetRectangles, seed)                                                               | `lib/subset-store.ts`                           |
| Algorithm params (tauRiseInit, tauDecayInit, autoInitKernel, upsampleTarget, maxIterations, convergenceTol, weightingEnabled, bandpassEnabled) | `lib/algorithm-store.ts` (**moved in Phase 2**) |
| Iteration state (runState, currentIteration, convergenceHistory, perTraceResults, progress)                                                    | `lib/iteration-store.ts` (**Phase 2**)          |

**Note:** Algorithm signals were extracted from `AlgorithmSettings.tsx` into `lib/algorithm-store.ts` during Phase 2, as anticipated. `AlgorithmSettings.tsx` now imports from the store.

### Package-level changes

- `@calab/community`: `AppLabel` type expanded to include `'cadecon'` (in `github-issue-url.ts`) and `initSession` accepts `'cadecon'` (in `analytics.ts`).

### Subset store details

- `subsetRectangles` uses a seeded LCG (`state * 1664525 + 1013904223`, unsigned 32-bit) for deterministic placement. The `seed` signal (default 42) can be randomized via the "Randomize Layout" button.
- `circularShiftEnabled` signal exists but is not yet wired to placement logic.
- Subset sizing uses 3 sliders: K (num subsets), Total Coverage (%, default 50), Aspect Ratio (log-scale centered at 1.0). Replaced the earlier auto-size toggle + conditional T_SUB/N_SUB sliders.
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

Warm-start state is maintained across iterations:

- `prevTraceCounts: Map<number, Float32Array>` — full-length s_counts per cell from the previous iteration. Subset windows are extracted via `subarray()` when dispatching trace jobs.
- `prevKernels: Float32Array[]` — per-subset h_free from the previous iteration, indexed by subset. Skipped subsets (no valid traces) have no entry.
- Finalization also warm-starts from the last iteration's subset results where cells overlap.

### Layout fix for kernel convergence chart

The canvas in `KernelConvergence.tsx` must be `position: absolute` inside a `position: relative` wrapper to prevent ResizeObserver feedback loops. The wrapper has `flex: 1; min-height: 0` to fill remaining space in the fixed-height panel. The panel itself uses `flex: 0 0 180px` via `[data-panel-id='kernel-convergence']` CSS selector (DashboardPanel renders `id` prop as `data-panel-id` attribute, not HTML `id`).

### Algorithmic changes from debugging

- **AR2 impulse peak normalization**: The AR2 forward/adjoint convolutions in `banded.rs` are now divided by the impulse peak so a single spike produces peak=1.0 regardless of sampling rate. This makes alpha consistent across upsampled and original rates. Added `compute_impulse_peak()` and `new_peak_normalized()` to `BandedAR2`.
- **FISTA Lipschitz estimation in kernel_est**: Replaced naive Lipschitz constant (sum of squared spikes) with power iteration on S^T·S. The tighter spectral norm estimate prevents FISTA oscillation on dense spike data.
- **Kernel length**: Uses `5 * tau_decay * fs` (not 2x) to match CaTune convention — e^-5 ≈ 0.7% of peak, capturing the full tail.
- **Linear interpolation upsampling**: `upsample_trace` uses linear interpolation between samples (not zero-insertion), producing smoother upsampled traces.

### Features NOT yet implemented (deferred)

- ~~Bandpass preprocessing~~ — now wired end-to-end
- Error weighting by spike proximity (weight vector w)
- Subset informativeness weighting during kernel merge
- Run provenance (settings snapshot at start)
- Intermediate FISTA progress reporting from worker
- `result-store.ts` — per-trace results live in `iteration-store.ts` directly

---

## Phase 3 Implementation Notes

> Details future phases need about how Phase 3 was actually built.

### Chart infrastructure

All chart files live in `src/lib/chart/`. Four files were copied from CaTune (`chart-theme.css`, `wheel-zoom-plugin.ts`, `theme-colors.ts`, `transient-zone-plugin.ts`) with minor adjustments (accent color default in theme-colors). Two new files were created: `series-config.ts` (CaDecon-specific series factories with D3 category10 palette) and `convergence-marker-plugin.ts`.

`TracePanel.tsx` was also copied from CaTune into `src/components/traces/` with import path adjustments.

### uPlot integration pattern

All charts use `@dschz/solid-uplot` (`SolidUplot` component) with `autoResize={true}`. Axis colors are hardcoded hex values (not CSS variables) because uPlot canvas rendering can fail with CSS variable resolution during `setData` redraws.

Custom bar/stem drawing uses the `paths` callback pattern returning `{ stroke: Path2D, fill: Path2D, clip: undefined, flags: 0 }`.

### Store architecture

`viz-store.ts` is purely UI state (which iteration to view, which cell to inspect, series visibility). Distribution-derived memos (`alphaValues`, `pveValues`, `eventRateValues`, `subsetVarianceData`) live in `iteration-store.ts` since they derive from `perTraceResults` and `convergenceHistory` signals.

`RunPhase` signals are set by `iteration-manager.ts` at each stage transition. The phase resets to `'idle'` on completion and on stop.

### TraceViewer dual-mode

During a run, `TraceViewer` shows the debug cell from `debugTraceSnapshots` (last entry). After finalization (`runState() === 'complete'`), it extracts any cell's raw trace from the full data matrix via `dataIndex()`. Reconvolution is computed on-demand using the same `reconvolveAR2()` helper as `iteration-manager.ts`.

### Drill-down flow

`selectedSubsetIdx` in `viz-store.ts` controls whether the distribution card row or the drill-down panel is shown (via `<Show when={selectedSubsetIdx() != null}>`). The raster click handler in `RasterOverview.tsx` (Phase 1) already sets this signal. The drill-down close button sets it back to `null`.

### Layout

The 3-row grid uses CSS flexbox (not CSS Grid) for compatibility with the existing `VizLayout` structure. Row 1 and Row 2 use `flex: 1 1 0` with min-heights. Row 3 uses `flex: 0 0 auto`. Columns within rows are sized with flex-grow ratios (6:4 for raster:convergence, fixed 280px for kernel display).

### Files changed summary

- **Created:** 24 files (6 chart lib, 1 viz-store, 4 traces, 1 kernel, 5 distributions, 3 drilldown, 5 CSS)
- **Modified:** 6 files (package.json, iteration-store, iteration-manager, App.tsx, ProgressBar, controls.css)
- **Deleted:** 2 files (DebugTraceChart.tsx, DebugKernelChart.tsx)

---

## Progress Tracker

| Phase                                | Status      | Notes                                                                                                    |
| ------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------- |
| Phase 1: Scaffold + Data + Subset UI | COMPLETE    |                                                                                                          |
| Phase 2: Core Compute                | COMPLETE    | 6 Rust modules, 71 tests, WASM bindings, worker, debug charts, warm-start, bandpass                      |
| Phase 3: Visualization + QC          | COMPLETE    | uPlot charts, TraceViewer, distributions, drill-down, 3-row grid, phase indicator, 24 new files          |
| Phase 4: Community DB                | COMPLETE    | Shared components promoted to @calab/ui + @calab/community, CaDecon submit/browser/scatter, DB migration |
| Phase 5: Export/Import               | NOT STARTED |                                                                                                          |
| Phase 6: Python Extension            | DEFERRED    |                                                                                                          |
| Phase 7: Tutorials + Polish          | DEFERRED    | Includes: per-worker indicators, iteration log sidebar                                                   |
