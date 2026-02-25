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

### 2.1 Rust: Upsampling infrastructure

- [ ] `src/upsampling.rs` module in `crates/solver/`
  - `upsample_trace(trace: &[f32], factor: u32) -> Vec<f32>` — zero-insert or repeat
  - `downsample_binary(s_bin: &[u8], factor: u32) -> Vec<u32>` — sum bins → integer counts
  - `compute_upsample_factor(fs: f32, target_fs: f32) -> u32` — integer factor, prefer over under
  - Downsampling matrix R is implicit (just bin-sum, no explicit matrix)

### 2.2 Rust: Threshold search + alpha/baseline refit

- [ ] `src/threshold_search.rs` module
  - Input: relaxed s ∈ [0,1] (from FISTA Box01), kernel h, observed y, upsample_factor, pad_start
  - **Efficient strategy:** Sort unique values of s, use ~100 evenly spaced thresholds from sorted values (avoids evaluating empty thresholds)
  - For each threshold i:
    - `s_bin = (s >= threshold[i])` as binary
    - Convolve: `c_candidate = h * s_bin` (using banded AR2 forward)
    - Least-squares refit: `alpha_i, baseline_i = lstsq(c_candidate, y)` excluding pad_start frames
    - Score: `error_i = ||w * (y - alpha_i * c_candidate - baseline_i)||²` (weighted if w provided)
  - Select best candidate (min error after pad exclusion)
  - Downsample winner: `s_counts = R * s_bin_best`
  - Return: `s_counts`, `alpha`, `baseline`, `best_threshold`, `PVE`, `error`
- [ ] **Optimization: early termination** — if error increases for M consecutive thresholds, stop searching
- [ ] **Optimization: coarse-to-fine** — Phase 1: 50 thresholds, Phase 2: refine around best with 50 more

### 2.3 Rust: FISTA configuration for CaDecon

- [ ] Add `InDecaSolver` struct (or extend existing `Solver`) in `lib.rs`:
  - `solve_bounded(trace, kernel_params, upsample_factor, ...) -> BoundedResult`
    - Internally: upsample trace, build kernel at upsampled rate, run FISTA with Box01, return relaxed s
  - `threshold_and_refit(relaxed_s, trace, kernel_params, ...) -> ThresholdResult`
    - Run threshold search, return s_counts + alpha + baseline + QC
  - `solve_trace(trace, kernel_params, upsample_factor, ...) -> TraceResult`
    - Combined: bounded FISTA → threshold → downsample → return final result
- [ ] Warm-start support: accept prior s_counts expanded to upsampled binary as initial guess
- [ ] Padding: exclude first `ceil(2 * tau_d * fs)` frames from objective

### 2.4 Rust: Free kernel estimation (h_free)

- [ ] `src/kernel_estimation.rs` module
  - Given: spike counts s_counts (per trace), observed y, alpha, baseline, kernel_length r
  - Formulate as NNLS: `min_{h>=0} ||y - alpha * (h * s) - baseline||²`
  - Reuse FISTA with lambda=0, non-negativity constraint
  - Convolution here is: h convolved with known s (spike-triggered average, effectively)
  - Input can be single trace or concatenation of multiple traces (shared kernel across subset)
  - Return: `h_free` of length `r_frames`

### 2.5 Rust: Bi-exponential fitting

- [ ] `src/biexp_fit.rs` module
  - Input: `h_free` (non-negative kernel estimate)
  - Target: fit `h(t) = beta * (exp(-t/tau_d) - exp(-t/tau_r))` with constraints `tau_d > tau_r > 0`
  - **Strategy:** Grid search over (tau_r, tau_d) pairs:
    - tau_r range: [0.5/fs, 10/fs] in 20 steps (log-spaced)
    - tau_d range: [tau_r, 50/fs] in 20 steps (log-spaced)
    - For each (tau_r, tau_d): compute template, solve for optimal beta via closed-form LSQ
    - Pick (tau_r, tau_d, beta) with lowest residual
  - **Refinement:** Local Nelder-Mead or golden-section around best grid point
  - Return: `(tau_r, tau_d, beta)` + residual + validity flag
  - Validity: reject if tau_d < tau_r, or if residual too high, or if tau values out of physiological range

### 2.6 Rust: WASM bindings for CaDecon

- [ ] Expose via `#[wasm_bindgen]`:
  - `indeca_solve_trace(trace: &[f32], tau_r: f32, tau_d: f32, fs: f32, upsample_factor: u32, ...) -> JsValue`
    - Returns serialized TraceResult (s_counts, alpha, baseline, PVE, etc.)
  - `indeca_estimate_kernel(traces: &[f32], spikes: &[u32], alphas: &[f32], baselines: &[f32], n_traces: u32, t_len: u32, r_frames: u32, fs: f32) -> JsValue`
    - Returns h_free + bi-exp fit params
  - Or: use a stateful `InDecaSolver` class similar to existing `Solver`

### 2.7 TypeScript: CaDecon worker

- [ ] `src/workers/cadecon-worker.ts`
  - Initialize WASM on startup → post 'ready'
  - Handle message types:
    - `'trace-job'`: call `indeca_solve_trace()`, return s_counts + alpha + baseline + QC
    - `'kernel-job'`: call `indeca_estimate_kernel()`, return h_free + bi-exp params
  - Cooperative cancellation via MessageChannel (same pattern as CaTune)
  - Intermediate progress for trace jobs (report after each FISTA convergence phase)
  - Transfer buffers for results

### 2.8 TypeScript: Iteration manager

- [ ] `src/lib/iteration-manager.ts` — orchestrates the full InDeCa loop
  - **State signals:**
    - `currentIteration`, `maxIterations`, `converged`, `running`, `paused`
    - `currentKernel: { tau_r, tau_d, beta, h_free, h_sampled }`
    - `convergenceHistory: Array<{ iter, tau_r, tau_d, subsetVariance, PVE }>`
    - `perTraceResults: Map<number, { alpha, baseline, s_counts, PVE, eventRate }>`
  - **Loop (each global iteration):**
    1. **Optional preprocessing** — bandpass filter, weight array from prior spikes
    2. **Per-trace spike inference** (parallel via worker pool):
       - Dispatch TraceJob for each trace in active subsets
       - Collect results: s_counts, alpha, baseline, PVE per trace
    3. **Subset kernel update** (parallel per subset):
       - Dispatch KernelJob for each subset
       - Each returns h_free + bi-exp fit (tau_r, tau_d, beta)
    4. **Merge + convergence** (main thread):
       - Robust aggregation of subset (tau_r, tau_d): median or trimmed mean
       - Weight by subset informativeness (event count \* fit quality)
       - Reject invalid fits (tau_d < tau_r, bad residual)
       - Update global kernel
       - Check convergence: |delta_tau| < tol over M iterations + low subset variance
    5. **Update UI signals** (kernel convergence plot, progress)
  - **Finalization pass:** After convergence, run per-trace inference on ALL traces (not just subsets)
  - **Pause/Resume/Stop:** Cooperative via signals checked between phases

### 2.9 TypeScript: Iteration store

- [ ] `src/lib/iteration-store.ts` — reactive state for the algorithm run
  - Global iteration state (current iter, phase within iter, progress %)
  - Kernel convergence history (for plotting)
  - Per-subset results cache
  - Per-trace results (alpha, baseline, s_counts, PVE) — stored sparsely
  - Run provenance (settings snapshot at start)

### 2.10 Wire up run controls

- [ ] Start button → initialize iteration manager → begin loop
- [ ] Pause → set paused flag, workers finish current job then idle
- [ ] Stop → cancel all workers, store intermediate results
- [ ] Reset → clear all iteration state, keep data loaded

**Exit criteria:** Full InDeCa loop runs on subsets, kernel converges, finalization pass produces per-trace s_counts. Console/minimal UI shows convergence. Demo data recovers known kernel params.

---

## Phase 3: Visualization + QC + Drill-Down

**Goal:** Rich interactive visualization of the algorithm's progress and results.

### 3.1 Kernel convergence plot

- [ ] `src/components/KernelConvergence.tsx` — uPlot time series
  - X-axis: iteration number
  - Y-axis (left): tau_r, tau_d values (lines with per-subset scatter points)
  - Y-axis (right): PVE or subset variance
  - Mark convergence point
  - Live update as iterations complete

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
│   │   ├── kernel/                   # Phase 3
│   │   │   ├── KernelConvergence.tsx
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
│   │   └── progress/                # Phase 2
│   │       └── ProgressBar.tsx
│   ├── lib/
│   │   ├── data-store.ts            # ✅ Phase 1 (+ groundTruthTau signals)
│   │   ├── auth-store.ts            # ✅ Phase 1
│   │   ├── analytics-integration.ts # ✅ Phase 1
│   │   ├── subset-store.ts          # ✅ Phase 1 (LCG placement)
│   │   ├── iteration-store.ts       # Phase 2
│   │   ├── iteration-manager.ts     # Phase 2
│   │   ├── result-store.ts          # Phase 2
│   │   ├── community/               # Phase 4
│   │   │   ├── cadecon-service.ts
│   │   │   ├── community-store.ts
│   │   │   └── quality-checks.ts
│   │   └── chart/                   # Phase 3
│   │       └── series-config.ts
│   ├── workers/                     # Phase 2
│   │   └── cadecon-worker.ts
│   └── styles/
│       ├── global.css               # ✅ Phase 1 (teal accent)
│       ├── raster.css               # ✅ Phase 1
│       ├── controls.css             # ✅ Phase 1
│       ├── layout.css               # Phase 3
│       └── distributions.css        # Phase 3

crates/solver/src/
├── (existing files unchanged)
├── indeca.rs                        # Top-level CaDecon API
├── threshold_search.rs              # Threshold sweep + alpha refit
├── upsampling.rs                    # Upsample/downsample utilities
├── kernel_estimation.rs             # h_free via FISTA NNLS
└── biexp_fit.rs                     # Bi-exponential curve fitting
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
| Algorithm params (tauRiseInit, tauDecayInit, autoInitKernel, upsampleTarget, maxIterations, convergenceTol, weightingEnabled, bandpassEnabled) | `components/controls/AlgorithmSettings.tsx` |

**Important:** Algorithm signals are module-level in `AlgorithmSettings.tsx` (not a separate store file). If the signal count grows in Phase 2, extract to `lib/algorithm-store.ts`.

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

## Progress Tracker

| Phase                                | Status      | Notes |
| ------------------------------------ | ----------- | ----- |
| Phase 1: Scaffold + Data + Subset UI | COMPLETE    |       |
| Phase 2: Core Compute                | NOT STARTED |       |
| Phase 3: Visualization + QC          | NOT STARTED |       |
| Phase 4: Community DB                | NOT STARTED |       |
| Phase 5: Export/Import               | NOT STARTED |       |
| Phase 6: Python Extension            | DEFERRED    |       |
| Phase 7: Tutorials + Polish          | DEFERRED    |       |
