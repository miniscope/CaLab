# Quick Start

## Load and tune traces interactively

The `tune()` function bridges your Python data to CaTune's browser UI, so you can visually explore deconvolution parameters before committing to a batch run.

```python
import numpy as np
import calab

# Load your calcium traces (n_cells x n_timepoints)
traces = np.load("my_traces.npy")
fs = 30.0  # sampling rate in Hz

# Open CaTune in your browser for interactive parameter tuning
params = calab.tune(traces, fs)
```

This starts a local server, opens CaTune in your browser, and blocks until you click "Export". Returns a dict with keys `tau_rise`, `tau_decay`, `lambda_`, `fs`, and `filter_enabled`, or `None` if you cancel.

## Batch deconvolution

Once you know your deconvolution parameters (from tuning or from the literature), apply them to all your traces in one call.

```python
import numpy as np
import calab

traces = np.load("my_traces.npy")

# Deconvolve with known parameters
activity = calab.run_deconvolution(
    traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.5
)
```

For full diagnostics (baseline, reconvolution, convergence), use `run_deconvolution_full()` instead -- it returns a `DeconvolutionResult` namedtuple.

## Load from CaImAn or Minian

These loaders save you from manually navigating HDF5/Zarr key hierarchies. Install `calab[loaders]` first (see [Installation](installation.md)).

```python
import calab

# CaImAn HDF5
traces, meta = calab.load_caiman("caiman_results.hdf5")

# Minian Zarr (Minian does not store the sampling rate, so you must provide it)
traces, meta = calab.load_minian("minian_output/", fs=30.0)

# Then tune or deconvolve
params = calab.tune(traces, meta["sampling_rate_hz"])
```

## Re-use exported parameters

After tuning in the browser, CaTune exports a JSON file. Use `deconvolve_from_export()` to apply those exact parameters in batch without re-specifying them manually.

```python
import numpy as np
import calab

traces = np.load("my_traces.npy")
result = calab.deconvolve_from_export(traces, "catune_params.json", return_full=True)

print(result.activity.shape)   # deconvolved activity
print(result.baseline)         # estimated baseline
print(result.converged)        # convergence flag
```

## Generate synthetic data

Simulated traces with known ground truth are useful for benchmarking deconvolution accuracy and testing pipelines before working with real data.

```python
import calab

# Default GCaMP6f-like simulation
result = calab.simulate()

print(result.traces.shape)             # (100, 27000) — 100 cells, 15 min at 30 Hz
print(result.ground_truth[0].spikes)   # spike counts at imaging rate for cell 0

# Use a preset indicator
result = calab.simulate(calab.presets.jgcamp8f(num_cells=50))
```

Available presets: `gcamp6f`, `gcamp6s`, `gcamp6m`, `jgcamp8f`, `ogb1`, and `clean` (minimal noise, for debugging).
