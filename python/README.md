# CaLab Python Companion

Calcium imaging deconvolution and data preparation -- Python companion package for the [CaLab](https://github.com/miniscope/CaLab) tools.

## Installation

```bash
pip install catune
```

## Quick Start

```python
import catune

# Build a calcium kernel
kernel = catune.build_kernel(tau_rise=0.02, tau_decay=0.4, fs=30.0)

# Get AR(2) coefficients
g1, g2, d, r = catune.tau_to_ar2(tau_rise=0.02, tau_decay=0.4, fs=30.0)

# Compute Lipschitz constant for FISTA step size
L = catune.compute_lipschitz(kernel)
```

## Deconvolution

Run FISTA deconvolution matching the CaTune web app's Rust solver exactly
(baseline estimation + lambda scaling by kernel DC gain):

```python
import numpy as np
import catune

# Load your calcium traces (n_cells x n_timepoints)
traces = np.load("my_traces.npy")

# Basic: returns non-negative activity array
activity = catune.run_deconvolution(traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.01)

# Full: returns activity, baseline, reconvolution, iterations, converged
result = catune.run_deconvolution_full(traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.01)
print(f"Baseline: {result.baseline}, Converged: {result.converged}")
```

> **Note:** The deconvolved output represents scaled neural activity, not discrete
> spikes or firing rates. The signal is scaled by an unknown constant (indicator
> expression level, optical path, etc.), so absolute values should not be
> interpreted as spike counts.

## Bandpass Filter

Apply the same FFT bandpass filter used in the CaTune web app:

```python
filtered = catune.bandpass_filter(trace, tau_rise=0.02, tau_decay=0.4, fs=100.0)
```

## Using CaTune Export JSON

Load parameters from a CaTune export JSON and run deconvolution:

```python
import catune

# Load export params
params = catune.load_export_params("catune-params-2025-01-15.json")
# -> {'tau_rise': 0.02, 'tau_decay': 0.4, 'lambda_': 0.01, 'fs': 30.0, 'filter_enabled': False}

# One-step pipeline: loads params, optionally filters, and deconvolves
activity = catune.deconvolve_from_export(traces, "catune-params-2025-01-15.json")
```

## Saving Data for CaTune

```python
import catune

catune.save_for_tuning(traces, fs=30.0, path="my_recording")
# Creates my_recording.npy + my_recording_metadata.json
# Load into CaTune browser tool via the .npy file
```

## Converting from CaImAn / Minian

CaTune works with raw calcium traces extracted by any pipeline. Use
`save_for_tuning()` to convert extracted traces into CaTune-compatible
format. No additional dependencies are required -- users extract arrays
with their existing pipeline tools.

### CaImAn

```python
import h5py
import catune

with h5py.File("caiman_results.hdf5", "r") as f:
    traces = f["estimates/C"][:]       # shape: (n_cells, n_timepoints)
    fs = float(f["params/data/fr"][()])

catune.save_for_tuning(traces, fs, "my_recording")
# -> my_recording.npy + my_recording_metadata.json, ready for CaTune
```

### Minian

```python
import zarr
import catune

store = zarr.open("minian_output", mode="r")
traces = store["C"][:]  # shape: (n_cells, n_frames)
fs = 30.0  # user must know their frame rate

catune.save_for_tuning(traces, fs, "my_recording")
```

### Then deconvolve

After tuning parameters in CaTune's browser interface, export your settings
and apply them in Python:

```python
import numpy as np
import catune

traces = np.load("my_recording.npy")
activity = catune.deconvolve_from_export(traces, "catune-params.json")
# activity is non-negative deconvolved neural activity (scaled by unknown constant)
```

## API Reference

| Function                                                | Description                               |
| ------------------------------------------------------- | ----------------------------------------- |
| `build_kernel(tau_rise, tau_decay, fs)`                 | Build double-exponential calcium kernel   |
| `tau_to_ar2(tau_rise, tau_decay, fs)`                   | Derive AR(2) coefficients from tau values |
| `compute_lipschitz(kernel)`                             | Lipschitz constant for FISTA step size    |
| `run_deconvolution(traces, fs, tau_r, tau_d, lam)`      | FISTA deconvolution, returns activity     |
| `run_deconvolution_full(traces, fs, tau_r, tau_d, lam)` | Full result with baseline, reconvolution  |
| `bandpass_filter(trace, tau_rise, tau_decay, fs)`       | FFT bandpass filter from kernel params    |
| `save_for_tuning(traces, fs, path)`                     | Save traces for CaTune browser tool       |
| `load_tuning_data(path)`                                | Load traces saved by save_for_tuning      |
| `load_export_params(path)`                              | Load params from CaTune export JSON       |
| `deconvolve_from_export(traces, params_path)`           | Full pipeline: load params + deconvolve   |
