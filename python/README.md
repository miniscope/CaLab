# CaLab Python

Calcium imaging analysis tools — deconvolution and data preparation. Python companion package for the [CaLab](https://github.com/miniscope/CaLab) tools.

The `calab` package runs the **same Rust FISTA solver** used by the CaTune web app (compiled to a native Python extension via PyO3), and provides utilities for loading data from common pipelines, interactive parameter tuning in the browser, and batch deconvolution from scripts.

## Installation

```bash
pip install calab

# Optional: CaImAn HDF5 and Minian Zarr loaders
pip install calab[loaders]
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
    tau_r=params["parameters"]["tau_rise_s"],
    tau_d=params["parameters"]["tau_decay_s"],
    lam=params["parameters"]["lambda"],
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

## Interactive Tuning (Bridge)

`calab.tune()` starts a local HTTP server, opens CaTune in the browser with your data pre-loaded, and waits for you to export parameters:

```python
params = calab.tune(traces, fs=30.0)
# Browser opens → tune parameters → click Export
# params contains the CaTune export JSON
```

The bridge serves traces via `http://127.0.0.1:<port>` and the web app communicates back via the `?bridge=` URL parameter.

## Deconvolution

Run FISTA deconvolution using the native Rust solver:

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

## Bandpass Filter

Apply the same FFT bandpass filter used in the CaTune web app:

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

| Function                                                | Description                                   |
| ------------------------------------------------------- | --------------------------------------------- |
| `tune(traces, fs, ...)`                                 | Open CaTune in browser for interactive tuning |
| `load_caiman(path, ...)`                                | Load traces from CaImAn HDF5 file             |
| `load_minian(path, ...)`                                | Load traces from Minian Zarr directory        |
| `build_kernel(tau_rise, tau_decay, fs)`                 | Build double-exponential calcium kernel       |
| `tau_to_ar2(tau_rise, tau_decay, fs)`                   | Derive AR(2) coefficients from tau values     |
| `compute_lipschitz(kernel)`                             | Lipschitz constant for FISTA step size        |
| `run_deconvolution(traces, fs, tau_r, tau_d, lam)`      | FISTA deconvolution, returns activity         |
| `run_deconvolution_full(traces, fs, tau_r, tau_d, lam)` | Full result with baseline, reconvolution      |
| `bandpass_filter(trace, tau_rise, tau_decay, fs)`       | FFT bandpass filter from kernel params        |
| `save_for_tuning(traces, fs, path)`                     | Save traces for CaTune browser tool           |
| `load_tuning_data(path)`                                | Load traces saved by save_for_tuning          |
| `load_export_params(path)`                              | Load params from CaTune export JSON           |
| `deconvolve_from_export(traces, params_path)`           | Full pipeline: load params + deconvolve       |
