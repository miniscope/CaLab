# calab-solver

Rust FISTA deconvolution solver with dual WASM/PyO3 targets.

## Overview

This crate implements calcium trace deconvolution: a FISTA (Fast Iterative Shrinkage-Thresholding Algorithm) core plus the higher-level InDeCa pipeline (rolling-baseline estimation, free-form kernel estimation, bi-exponential kernel fitting, peak-seeded bootstrap, and up/down-sampling) used by CaTune and CaDecon.

It builds two ways, gated by Cargo features:

- **`jsbindings`** (default) — compiled to WebAssembly via `wasm-pack` and run in Web Workers in the browser. The compiled output in `pkg/` is committed to the repository so that CI and development do not require a Rust toolchain.
- **`pybindings`** — compiled as a native PyO3 extension module for the `calab` Python package (see `python/`).

`cargo test` uses the default (`jsbindings`); the PyO3 surface is checked separately with `--no-default-features --features pybindings`.

## Algorithm

The solver minimizes the following objective with a non-negativity constraint:

```
minimize  (1/2)||y - K·s - b||² + λ·G_dc·||s||₁   subject to  s ≥ 0
```

| Symbol | Meaning                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `y`    | Input fluorescence trace                                                                                                                                                                                                                                                                           |
| `K`    | Convolution matrix from double-exponential kernel                                                                                                                                                                                                                                                  |
| `s`    | Deconvolved activity (output)                                                                                                                                                                                                                                                                      |
| `b`    | Scalar baseline. Estimated per-iteration as `mean(y - K·s)`, then EMA-smoothed for a stable display value (`BASELINE_EMA_WEIGHT`). The InDeCa driver instead removes a rolling-quantile floor up front (`baseline::DEFAULT_BASELINE_QUANTILE`) so the baseline is ~0 and this term can be skipped. |
| `λ`    | Sparsity penalty (user-adjustable)                                                                                                                                                                                                                                                                 |
| `G_dc` | Kernel DC gain `Σh`, scales λ so the sparsity slider is effective across all kernel shapes                                                                                                                                                                                                         |

**Kernel:** `h(t) = exp(-t/τ_decay) - exp(-t/τ_rise)`, normalized to peak = 1.0. Length extends until the decay envelope drops below 1e-6 of peak.

**FISTA iteration:** Standard Beck & Teboulle (2009) with momentum extrapolation. Step size is `1/L` where `L` (Lipschitz constant) = max|H(ω)|² computed via DFT of the kernel.

**Adaptive restart:** O'Donoghue & Candes (2015) gradient-mapping criterion — resets momentum to `t = 1` when the proximal step undoes the momentum direction.

**Convergence (inner FISTA loop):** Primal residual criterion `||x_{k+1} - x_k|| / ||x_k|| < tol` after iteration 5, where `tol` defaults to `1e-4` and is configurable. This avoids an expensive forward convolution + objective evaluation per iteration. (The _outer_ InDeCa iteration — alternating spike solve and kernel re-estimation — instead converges in kernel shape space: it stops when the kernel's peak time and FWHM both reach an asymptote. Those controls live in `@calab/core` `CONVERGENCE_RANGES`.)

**Forward model:** two interchangeable convolution engines selected via `set_conv_mode` — `ConvMode::Fft` (O(n log n) DFT) and `ConvMode::BandedAR2` (O(n) banded AR(2) recursion). The banded engine applies a one-sample source delay so its output stays aligned with the double-exponential `build_kernel` reference (mirrored in `apps/cadecon/src/lib/reconvolve.ts`).

## Modules

### Core FISTA

| Module         | Description                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `lib.rs`       | `Solver` struct — parameter management, state serialization, bandpass/baseline methods, `first_nonfinite` FFI guard      |
| `kernel.rs`    | `build_kernel` (double-exponential), `compute_lipschitz` (spectral bound via DFT)                                        |
| `fista.rs`     | `step_batch` — FISTA iteration loop with adaptive restart and convergence check                                          |
| `fft.rs`       | `FftConvolver` — self-contained FFT convolution engine with pre-computed kernel spectrum, forward and adjoint operations |
| `banded.rs`    | `BandedAR2` — O(n) banded AR(2) forward/adjoint convolution engine (one-sample source-delay aligned)                     |
| `filter.rs`    | `BandpassFilter` — FFT-based bandpass filter derived from kernel time constants, cosine-tapered transitions              |
| `baseline.rs`  | Rolling-quantile baseline estimation/subtraction; `DEFAULT_BASELINE_QUANTILE`                                            |
| `threshold.rs` | Threshold/proximal helpers                                                                                               |

### InDeCa pipeline

| Module          | Description                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `indeca.rs`     | InDeCa driver — alternating single-trace spike solve and kernel re-estimation                          |
| `kernel_est.rs` | `estimate_free_kernel` — free-form kernel estimation from traces + spike trains (TV-L1 smoothing)      |
| `biexp_fit.rs`  | `fit_biexponential` — two-component bi-exponential fit to a free-form kernel; `BiexpResult`, `FitMode` |
| `peak_seed.rs`  | Peak-seeded bootstrap — `SeedConfig`, `find_seed_spikes`, `seed_trace`, `seed_kernel_estimate`         |
| `upsample.rs`   | Up/down-sampling and `compute_upsample_factor`                                                         |
| `simulate.rs`   | Synthetic trace simulation (Markov/Poisson spiking, kernel, noise, photobleaching, saturation)         |

### FFI bindings

| Module           | Feature      | Description                                                           |
| ---------------- | ------------ | --------------------------------------------------------------------- |
| `js_indeca.rs`   | `jsbindings` | wasm-bindgen free functions for the InDeCa/seed/biexp pipeline        |
| `js_simulate.rs` | `jsbindings` | wasm-bindgen simulation entry points                                  |
| `py_api.rs`      | `pybindings` | PyO3 `Solver` class + module functions for the `calab` Python package |

## Public API

### `Solver` methods (wasm-bindgen)

| Method                                                    | Description                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `new()`                                                   | Create solver with default parameters (τ_rise=0.02, τ_decay=0.4, λ=0.01, fs=30) |
| `set_params(tau_rise, tau_decay, lambda, fs)`             | Update parameters and rebuild kernel                                            |
| `set_trace(trace)`                                        | Load a trace, grow buffers if needed, reset iteration state                     |
| `set_conv_mode(mode)`                                     | Select the forward-model engine (`Fft` or `BandedAR2`)                          |
| `set_constraint(c)`                                       | Select the proximal constraint (`NonNegative` L1 or `Box01`)                    |
| `get_kernel()`                                            | Get the current double-exponential kernel                                       |
| `set_hp_filter_enabled(on)` / `set_lp_filter_enabled(on)` | Toggle the high-/low-pass halves of the bandpass filter individually            |
| `step_batch(n_steps)`                                     | Run N FISTA iterations, return true if converged                                |
| `get_solution()`                                          | Get deconvolved activity (owned copy)                                           |
| `get_reconvolution()`                                     | Get K·s (lazy-computed, owned copy)                                             |
| `get_reconvolution_with_baseline()`                       | Get K·s + b (owned copy)                                                        |
| `get_baseline()`                                          | Get estimated scalar baseline                                                   |
| `get_trace()`                                             | Get current trace (may be filtered)                                             |
| `converged()`                                             | Check convergence flag                                                          |
| `iteration_count()`                                       | Get iteration count                                                             |
| `reset_momentum()`                                        | Reset FISTA momentum for warm-start after kernel change                         |
| `export_state()` / `load_state(state)`                    | Serialize/restore solver state for warm-start cache                             |
| `set_filter_enabled(enabled)` / `filter_enabled()`        | Toggle bandpass filter                                                          |
| `apply_filter()`                                          | Apply bandpass filter to loaded trace                                           |
| `get_power_spectrum()`                                    | Get \|FFT\|² of current trace                                                   |
| `get_spectrum_frequencies()`                              | Get frequency axis in Hz                                                        |
| `get_filter_cutoffs()`                                    | Get [f_hp, f_lp] cutoff frequencies                                             |

### InDeCa pipeline functions (wasm-bindgen)

Free functions in `js_indeca.rs`, exposed alongside `Solver`:

| Function                                        | Description                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `indeca_solve_trace(...)`                       | Solve a single trace (spikes + alpha + baseline + PVE + convergence)     |
| `indeca_estimate_kernel(...)`                   | Estimate a free-form kernel from traces and their spike trains           |
| `indeca_fit_biexponential(...)`                 | Fit a two-component bi-exponential to a free-form kernel → `BiexpResult` |
| `indeca_compute_upsample_factor(fs, target_fs)` | Integer up-sampling factor                                               |
| `seed_trace(trace, fs)`                         | Peak-seeded bootstrap for a single trace                                 |

**Non-finite input guard:** the FFI entry points (both wasm-bindgen and PyO3) reject input traces containing `NaN`/`±Inf` — WASM throws a JS error, PyO3 raises `ValueError` — rather than letting a non-finite value propagate into garbage results.

**Bi-exponential fit outcome:** `BiexpResult` carries a `FitMode` — `TwoComponent`, `SlowOnly`, `Degenerate` (no positive slow amplitude), or `Empty` (no fit) — so callers can detect an untrustworthy fit instead of inferring it. Over PyO3, `fit_biexponential` returns an 8-tuple whose trailing element is the `fit_mode` string.

### Python API (PyO3)

Built with the `pybindings` feature and consumed by the `calab` package. Exposes a `Solver` `#[pyclass]` plus module functions (`deconvolve_single`, `deconvolve_batch`, `build_kernel`, `compute_lipschitz`, `solve_trace`, `estimate_kernel`, `fit_biexponential`, `seed_trace`, `seed_kernel_estimate`, `compute_upsample_factor`). See `python/docs/` for the Python-facing reference.

## Build

```bash
cd crates/solver
wasm-pack build --target web --release
```

Output goes to `pkg/` which is committed to the repository. You only need to rebuild when modifying the solver Rust source.

From the repo root:

```bash
npm run build:wasm
```

## Performance

- **Pre-allocated buffers** — grow but never shrink to prevent WASM memory fragmentation
- **f32 precision** — halves memory per worker compared to f64 (Lipschitz constant computed in f64 for step-size accuracy)
- **FFT convolution** — O(n log n) via `realfft`/`rustfft` for both forward and adjoint operations
- **Release profile** — `opt-level = 3`, LTO, single codegen unit, wasm-opt with bulk-memory

## Dependencies

| Crate                      | Purpose                                               |
| -------------------------- | ----------------------------------------------------- |
| `wasm-bindgen`             | JavaScript interop                                    |
| `console_error_panic_hook` | Readable panic messages in browser console            |
| `realfft`                  | Real-valued FFT (wraps rustfft)                       |
| `rustfft`                  | FFT computation                                       |
| `pyo3` / `numpy`           | PyO3 extension + NumPy interop (`pybindings` feature) |
| `serde` / `serde_json`     | Result serialization for the FFI layers               |
