# CaLab Python

Calcium imaging analysis tools — deconvolution and data preparation. Python companion package for the [CaLab](https://github.com/miniscope/CaLab) tools.

The `calab` package runs the **same Rust FISTA solver** used by the CaLab web apps (compiled to a native Python extension via PyO3), and provides utilities for loading data from common pipelines, interactive parameter tuning in the browser, automated deconvolution via CaDecon, and batch processing from scripts.

## Installation

```bash
pip install calab

# Optional: CaImAn HDF5 and Minian Zarr loaders
pip install calab[loaders]

# Optional: headless browser for batch CaDecon runs
pip install calab[headless]
playwright install chromium
```

> **Note:** Pre-built wheels include the compiled Rust solver for Linux, macOS, and Windows. No Rust toolchain is needed for installation.

## Quick Start

```python
import numpy as np
import calab

# Load your calcium traces (n_cells x n_timepoints)
traces = np.load("my_traces.npy")

# Interactive tuning: opens CaTune in the browser, returns exported params
params = calab.tune(traces, fs=30.0)

# Batch deconvolution with tuned parameters
activity = calab.run_deconvolution(
    traces, fs=30.0,
    tau_r=params["tau_rise"],
    tau_d=params["tau_decay"],
    lam=params["lambda_"],
)
```

## Loading Data

### Direct loaders (CaImAn, Minian)

```python
# CaImAn HDF5 — reads traces and sampling rate directly
traces, meta = calab.load_caiman("caiman_results.hdf5")

# Minian Zarr — reads traces, fs must be provided
traces, meta = calab.load_minian("minian_output/", fs=30.0)

# Both return (ndarray, dict) with shape (n_cells, n_timepoints)
print(meta)
# {'source': 'caiman', 'sampling_rate_hz': 30.0, 'num_cells': 256, 'num_timepoints': 9000}
```

Requires optional dependencies: `pip install calab[loaders]`

### Saving for CaTune

```python
calab.save_for_tuning(traces, fs=30.0, path="my_recording")
# Creates my_recording.npy + my_recording_metadata.json
```

## Interactive Tuning (CaTune Bridge)

`calab.tune()` starts a local HTTP server, opens CaTune in the browser with your data pre-loaded, and waits for you to export parameters:

```python
params = calab.tune(traces, fs=30.0)
# Browser opens → tune parameters → click Export
# Returns: {'tau_rise': 0.02, 'tau_decay': 0.4, 'lambda_': 0.01, 'fs': 30.0, 'filter_enabled': False}
```

The bridge serves traces via `http://127.0.0.1:<port>` and the web app communicates back via the `?bridge=` URL parameter.

## Automated Deconvolution (CaDecon Bridge)

`calab.decon()` opens CaDecon in the browser, which runs the full deconvolution pipeline (including data-driven kernel estimation) and returns the results to Python.

### Interactive mode

Opens CaDecon in your browser where you can configure settings and run manually:

```python
result = calab.decon(traces, fs=30.0)
```

### Autorun mode

Starts the solver automatically after loading — no manual interaction needed:

```python
result = calab.decon(traces, fs=30.0, autorun=True, max_iterations=50)

print(result.activity.shape)    # (n_cells, n_timepoints), float32
print(result.alphas)            # per-cell amplitude scaling factors
print(result.baselines)         # per-cell baseline estimates
print(result.pves)              # per-cell proportion of variance explained
print(result.kernel_slow.shape) # estimated slow kernel waveform
print(result.metadata)          # tau values, convergence info, etc.
```

### Headless mode (batch benchmarking)

Run CaDecon without a visible browser window. Requires `pip install calab[headless]` and `playwright install chromium`.

Single run:

```python
result = calab.decon(traces, fs=30.0, headless=True, autorun=True, max_iterations=50)
```

Batch processing (reuses one browser across datasets):

```python
from calab import HeadlessBrowser

with HeadlessBrowser() as hb:
    for traces, fs in datasets:
        result = calab.decon(traces, fs, headless=hb, autorun=True, max_iterations=50)
        results.append(result)
```

### CaDecon configuration options

All options are keyword-only and optional — unset values use CaDecon's defaults:

```python
result = calab.decon(
    traces, fs=30.0,
    autorun=True,              # start solver automatically
    max_iterations=50,         # solver iterations (1–200)
    convergence_tol=1e-6,      # convergence threshold
    upsample_target=300,       # target sampling rate for upsampling (Hz)
    hp_filter_enabled=True,    # high-pass filter
    lp_filter_enabled=True,    # low-pass filter
    num_subsets=4,             # number of random subsets
    target_coverage=0.8,       # subset coverage fraction (0–1]
    aspect_ratio=2.0,          # subset aspect ratio
    seed=42,                   # random seed for reproducibility
    timeout=120,               # max seconds to wait for results
)
```

## FISTA Deconvolution

Run FISTA deconvolution directly using the Rust solver (no browser needed). This requires known kernel parameters (tau_rise, tau_decay, lambda):

```python
# Basic: returns non-negative activity array
activity = calab.run_deconvolution(traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.01)

# Full: returns activity, baseline, reconvolution, iterations, converged
result = calab.run_deconvolution_full(traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.01)
print(f"Baseline: {result.baseline}, Converged: {result.converged}")
```

> **Note:** The deconvolved output represents scaled neural activity, not discrete
> spikes or firing rates. The signal is scaled by an unknown constant (indicator
> expression level, optical path, etc.), so absolute values should not be
> interpreted as spike counts.

## Solver Primitives

Low-level access to the individual stages of the deconvolution pipeline. These are the same Rust functions used internally by CaDecon:

```python
# Single-trace solve with upsampling and filtering
result = calab.solve_trace(trace, tau_rise=0.02, tau_decay=0.4, fs=30.0,
                           upsample_factor=10, hp_enabled=True)
# Returns: SolveTraceResult(s_counts, alpha, baseline, threshold, pve, iterations, converged)

# Estimate a free-form kernel from traces and spike trains
kernel = calab.estimate_kernel(traces_flat, spikes_flat, trace_lengths,
                               alphas, baselines, kernel_length=60)

# Fit a bi-exponential model to the estimated kernel
fit = calab.fit_biexponential(kernel, fs=30.0)
# Returns: BiexpFitResult(tau_rise, tau_decay, beta, residual, tau_rise_fast, tau_decay_fast, beta_fast)

# Compute upsampling factor for a target rate
factor = calab.compute_upsample_factor(fs=30.0, target_fs=300.0)  # → 10
```

## Bandpass Filter

Apply the same FFT bandpass filter used in the CaLab web apps:

```python
filtered = calab.bandpass_filter(trace, tau_rise=0.02, tau_decay=0.4, fs=100.0)
```

## Using CaTune Export JSON

Load parameters from a CaTune export and run deconvolution:

```python
params = calab.load_export_params("catune-params-2025-01-15.json")
# {'tau_rise': 0.02, 'tau_decay': 0.4, 'lambda_': 0.01, 'fs': 30.0, 'filter_enabled': False}

# One-step pipeline: loads params, optionally filters, deconvolves
activity = calab.deconvolve_from_export(traces, "catune-params-2025-01-15.json")
```

## Kernel Math

```python
kernel = calab.build_kernel(tau_rise=0.02, tau_decay=0.4, fs=30.0)
g1, g2, d, r = calab.tau_to_ar2(tau_rise=0.02, tau_decay=0.4, fs=30.0)
L = calab.compute_lipschitz(kernel)
```

## CLI

The `calab` command-line tool is installed with the package:

```bash
# Interactive tuning
calab tune my_traces.npy --fs 30.0

# Batch deconvolution with exported params
calab deconvolve my_traces.npy --params catune-params.json -o activity.npy

# Convert from CaImAn/Minian to CaLab format
calab convert caiman_results.hdf5 --format caiman -o my_recording

# Show file info
calab info my_traces.npy
```

## API Reference

### Bridge

| Function / Class         | Description                                   |
| ------------------------ | --------------------------------------------- |
| `tune(traces, fs, ...)`  | Open CaTune in browser for interactive tuning |
| `decon(traces, fs, ...)` | Open CaDecon for automated deconvolution      |
| `HeadlessBrowser()`      | Context manager for headless browser sessions |
| `DeconConfig`            | Pydantic model for CaDecon configuration      |

### Compute

| Function                                                | Description                              |
| ------------------------------------------------------- | ---------------------------------------- |
| `run_deconvolution(traces, fs, tau_r, tau_d, lam)`      | FISTA deconvolution, returns activity    |
| `run_deconvolution_full(traces, fs, tau_r, tau_d, lam)` | Full result with baseline, reconvolution |
| `solve_trace(trace, tau_rise, tau_decay, fs, ...)`      | Single-trace solve (InDeCa pipeline)     |
| `estimate_kernel(traces_flat, spikes_flat, ...)`        | Free-form kernel estimation              |
| `fit_biexponential(h_free, fs, ...)`                    | Bi-exponential kernel fit                |
| `compute_upsample_factor(fs, target_fs)`                | Upsample factor for target rate          |
| `build_kernel(tau_rise, tau_decay, fs)`                 | Double-exponential calcium kernel        |
| `tau_to_ar2(tau_rise, tau_decay, fs)`                   | AR(2) coefficients from tau values       |
| `compute_lipschitz(kernel)`                             | Lipschitz constant for FISTA step size   |
| `bandpass_filter(trace, tau_rise, tau_decay, fs)`       | FFT bandpass filter from kernel params   |

### I/O

| Function                                      | Description                             |
| --------------------------------------------- | --------------------------------------- |
| `save_for_tuning(traces, fs, path)`           | Save traces for CaTune browser tool     |
| `load_tuning_data(path)`                      | Load traces saved by save_for_tuning    |
| `load_export_params(path)`                    | Load params from CaTune export JSON     |
| `deconvolve_from_export(traces, params_path)` | Full pipeline: load params + deconvolve |
| `load_caiman(path, ...)`                      | Load traces from CaImAn HDF5 file       |
| `load_minian(path, ...)`                      | Load traces from Minian Zarr directory  |
