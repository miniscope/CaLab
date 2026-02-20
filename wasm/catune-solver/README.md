# catune-solver

Rust FISTA deconvolution solver compiled to WebAssembly.

## Overview

This crate implements the FISTA (Fast Iterative Shrinkage-Thresholding Algorithm) solver used by CaTune for calcium trace deconvolution. It is compiled to WebAssembly via `wasm-pack` and runs in Web Workers in the browser. The compiled output in `pkg/` is committed to the repository so that CI and development do not require a Rust toolchain.

## Algorithm

The solver minimizes the following objective with a non-negativity constraint:

```
minimize  (1/2)||y - K·s - b||² + λ·G_dc·||s||₁   subject to  s ≥ 0
```

| Symbol | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| `y`    | Input fluorescence trace                                                                   |
| `K`    | Convolution matrix from double-exponential kernel                                          |
| `s`    | Deconvolved activity (output)                                                              |
| `b`    | Scalar baseline, estimated jointly as `mean(y - K·s)`                                      |
| `λ`    | Sparsity penalty (user-adjustable)                                                         |
| `G_dc` | Kernel DC gain `Σh`, scales λ so the sparsity slider is effective across all kernel shapes |

**Kernel:** `h(t) = exp(-t/τ_decay) - exp(-t/τ_rise)`, normalized to peak = 1.0. Length extends until the decay envelope drops below 1e-6 of peak.

**FISTA iteration:** Standard Beck & Teboulle (2009) with momentum extrapolation. Step size is `1/L` where `L` (Lipschitz constant) = max|H(ω)|² computed via DFT of the kernel.

**Adaptive restart:** O'Donoghue & Candes (2015) gradient-mapping criterion — resets momentum to `t = 1` when the proximal step undoes the momentum direction.

**Convergence:** Primal residual criterion `||x_{k+1} - x_k|| / ||x_k|| < 1e-6` after iteration 5. This avoids an expensive forward convolution + objective evaluation per iteration.

## Modules

| Module      | Description                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `lib.rs`    | `Solver` struct — public wasm-bindgen API, parameter management, state serialization, bandpass filter methods            |
| `kernel.rs` | `build_kernel` (double-exponential), `compute_lipschitz` (spectral bound via DFT)                                        |
| `fista.rs`  | `step_batch` — FISTA iteration loop with FFT convolutions, adaptive restart, convergence check                           |
| `fft.rs`    | `FftConvolver` — self-contained FFT convolution engine with pre-computed kernel spectrum, forward and adjoint operations |
| `filter.rs` | `BandpassFilter` — FFT-based bandpass filter derived from kernel time constants, cosine-tapered transitions              |

## Public API

Methods exposed to JavaScript via `wasm-bindgen`:

| Method                                             | Description                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `new()`                                            | Create solver with default parameters (τ_rise=0.02, τ_decay=0.4, λ=0.01, fs=30) |
| `set_params(tau_rise, tau_decay, lambda, fs)`      | Update parameters and rebuild kernel                                            |
| `set_trace(trace)`                                 | Load a trace, grow buffers if needed, reset iteration state                     |
| `step_batch(n_steps)`                              | Run N FISTA iterations, return true if converged                                |
| `get_solution()`                                   | Get deconvolved activity (owned copy)                                           |
| `get_reconvolution()`                              | Get K·s (lazy-computed, owned copy)                                             |
| `get_reconvolution_with_baseline()`                | Get K·s + b (owned copy)                                                        |
| `get_baseline()`                                   | Get estimated scalar baseline                                                   |
| `get_trace()`                                      | Get current trace (may be filtered)                                             |
| `converged()`                                      | Check convergence flag                                                          |
| `iteration_count()`                                | Get iteration count                                                             |
| `reset_momentum()`                                 | Reset FISTA momentum for warm-start after kernel change                         |
| `export_state()` / `load_state(state)`             | Serialize/restore solver state for warm-start cache                             |
| `set_filter_enabled(enabled)` / `filter_enabled()` | Toggle bandpass filter                                                          |
| `apply_filter()`                                   | Apply bandpass filter to loaded trace                                           |
| `get_power_spectrum()`                             | Get \|FFT\|² of current trace                                                   |
| `get_spectrum_frequencies()`                       | Get frequency axis in Hz                                                        |
| `get_filter_cutoffs()`                             | Get [f_hp, f_lp] cutoff frequencies                                             |

## Build

```bash
cd wasm/catune-solver
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

| Crate                      | Purpose                                    |
| -------------------------- | ------------------------------------------ |
| `wasm-bindgen`             | JavaScript interop                         |
| `console_error_panic_hook` | Readable panic messages in browser console |
| `realfft`                  | Real-valued FFT (wraps rustfft)            |
| `rustfft`                  | FFT computation                            |
