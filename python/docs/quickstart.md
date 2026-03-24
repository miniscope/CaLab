# Quick Start

## Load and tune traces interactively

```python
import numpy as np
import calab

# Load your calcium traces (n_cells x n_timepoints)
traces = np.load("my_traces.npy")
fs = 30.0  # sampling rate in Hz

# Open CaTune in your browser for interactive parameter tuning
params = calab.tune(traces, fs)
```

This starts a local server, opens CaTune in your browser, and returns the parameters you selected once you click "Export".

## Batch deconvolution

```python
import calab

traces = np.load("my_traces.npy")

# Deconvolve with known parameters
activity = calab.run_deconvolution(
    traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.5
)
```

## Load from CaImAn or Minian

```python
import calab

# CaImAn HDF5
traces, meta = calab.load_caiman("caiman_results.hdf5")

# Minian Zarr
traces, meta = calab.load_minian("minian_output/", fs=30.0)

# Then tune or deconvolve
params = calab.tune(traces, meta["sampling_rate_hz"])
```

## Re-use exported parameters

After tuning in the browser, CaTune exports a JSON file. Apply those parameters in batch:

```python
import calab

traces = np.load("my_traces.npy")
result = calab.deconvolve_from_export(traces, "catune_params.json", return_full=True)

print(result.activity.shape)   # deconvolved activity
print(result.baseline)         # estimated baseline
print(result.converged)        # convergence flag
```

## Generate synthetic data

```python
import calab

# Default GCaMP6f-like simulation
result = calab.simulate()

print(result.traces.shape)        # (10, 9000) — 10 cells, 5 min at 30 Hz
print(result.ground_truth[0].spikes)  # spike times for cell 0

# Use a preset indicator
result = calab.simulate(calab.presets.jgcamp8f(num_cells=50))
```
