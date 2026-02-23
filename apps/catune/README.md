# CaTune

Interactive calcium deconvolution parameter tuning

![CaTune screenshot](screenshot.png)

## Overview

CaTune is a browser-based tool for tuning calcium deconvolution parameters. Load fluorescence traces, adjust rise time, decay time, and sparsity parameters with sliders, and see the deconvolution update in real time. The solver is a FISTA algorithm written in Rust, compiled to WebAssembly, and executed in Web Workers for parallel multi-cell processing.

## Getting Started

### Live App

Open **[CaTune](https://miniscope.github.io/CaLab/catune/)** in your browser — no installation required.

### Loading Data

1. **Choose a source** — drag and drop a `.npy` or `.npz` file, or try one of the 6 built-in demo presets
2. **Confirm dimensions** — verify the data shape (cells × timepoints) and swap axes if needed
3. **Set sampling rate** — enter your recording's frame rate in Hz (or select from common presets)
4. **Validate** — CaTune checks for NaN, Inf, and other data issues before proceeding

### Demo Data

CaTune includes 6 synthetic demo presets with known ground truth, useful for understanding how parameters affect the deconvolution output. Ground truth can be revealed after tuning to compare results.

## Features

- **Parameter sliders** — rise time (1–500 ms), decay time (50–3000 ms), sparsity (0–10)
- **Multi-cell dashboard** — view and compare deconvolution across multiple cells simultaneously, with priority-based solving (visible and hovered cells solve first)
- **Trace overlays** — raw, filtered, fit (reconvolution + baseline), deconvolved, residual, and ground truth (demo data)
- **Zoom windows** — windowed computation with overlap-and-discard for efficient zooming into long traces
- **Spectrum panel** — power spectral density with filter cutoff visualization
- **Quality metrics** — peak SNR, R², sparsity ratio
- **Pin/compare snapshots** — pin the current parameters as a dimmed overlay, then adjust to compare before/after
- **Bandpass filter** — FFT-based filter derived from kernel time constants, with cosine-tapered transitions
- **Community sharing** — submit and browse deconvolution parameters shared by other users (optional, Supabase-backed)
- **Tutorials** — 5 interactive tutorials powered by driver.js with localStorage progress persistence
- **JSON export** — export tuned parameters for use with the `calab` Python package

## Solver Overview

CaTune uses a **FISTA** (Fast Iterative Shrinkage-Thresholding Algorithm) solver with the following objective:

```
minimize  (1/2)||y - K*s - b||² + λ·G_dc·||s||₁   subject to  s ≥ 0
```

where `y` is the fluorescence trace, `K` is the convolution matrix from a double-exponential kernel `h(t) = exp(-t/τ_decay) - exp(-t/τ_rise)`, `s` is the deconvolved activity, `b` is a jointly estimated scalar baseline, `λ` is the sparsity penalty, and `G_dc = Σh` scales lambda so the sparsity slider is effective across all kernel configurations.

Key solver features:

- **Adaptive restart** (O'Donoghue & Candes 2015) — resets momentum when it hurts convergence
- **FFT convolution** — O(n log n) forward and adjoint convolutions via `realfft`/`rustfft`
- **Rust → WASM** — compiled with wasm-pack, runs in Web Workers
- **Warm-start caching** — 3-tier cache (lambda-only, kernel-changed, cold-start) reuses prior solver state
- **Windowed computation** — only solves the visible zoom window (plus safety margin) for efficiency

See [`crates/solver/README.md`](../../crates/solver/README.md) for detailed solver documentation.

## Development

### Running Locally

```bash
npm run dev          # Start CaTune dev server (from repo root)
npm run test -w apps/catune  # Run CaTune tests
```

### Architecture

CaTune uses **module-level SolidJS signals** instead of Context providers. State is organized into store modules that export signals and setters directly:

| Store                   | Responsibility                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `data-store.ts`         | Loaded traces, import pipeline, demo data, ground truth                                                                   |
| `viz-store.ts`          | Selected cell, tau/lambda parameters, filter toggle, trace visibility, pinned snapshots                                   |
| `multi-cell-store.ts`   | Multi-cell selection (top-active / random / manual), per-cell solver results and status                                   |
| `cell-solve-manager.ts` | Reactive orchestrator — watches params + cell selection, dispatches jobs through worker pool with debouncing and priority |

Components are organized by feature area under `src/components/`: `cards/`, `community/`, `controls/`, `import/`, `layout/`, `metrics/`, `spectrum/`, `traces/`, `tutorial/`.

### Internal Packages

| Package            | Role in CaTune                                                                         |
| ------------------ | -------------------------------------------------------------------------------------- |
| `@calab/core`      | Shared types, WASM adapter (`initWasm`, `Solver`), metrics, FFT, parameter ranges      |
| `@calab/compute`   | Worker pool, warm-start cache, kernel math, downsampling, demo presets, synthetic data |
| `@calab/io`        | .npy/.npz parsing, trace validation, cell ranking, JSON export                         |
| `@calab/community` | Supabase client, CRUD operations, submission logic, field options                      |
| `@calab/tutorials` | Tutorial types, progress persistence, tutorial engine                                  |
| `@calab/ui`        | DashboardShell, DashboardPanel, VizLayout, CompactHeader, CardGrid                     |
