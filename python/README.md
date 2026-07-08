# CaLab Python

Calcium imaging analysis tools -- deconvolution, simulation, and data preparation. Python companion package for the [CaLab](https://github.com/miniscope/CaLab) web tools.

The `calab` package runs the **same Rust FISTA solver** used by the CaLab web apps (compiled to a native Python extension via PyO3), and provides two deconvolution approaches:

- **CaTune** -- interactive parameter tuning in the browser, then batch deconvolution with those parameters. Uses established FISTA deconvolution with a double-exponential kernel.
- **CaDecon** -- automated deconvolution that estimates the calcium kernel and parameters from your data. A new approach developed by the CaLab team.

Plus utilities for loading data from common pipelines, synthetic trace simulation with ground truth, and batch processing from scripts.

> **Full documentation:** [calab.readthedocs.io](https://calab.readthedocs.io)

## Installation

```bash
pip install calab

# Optional: CaImAn HDF5 and Minian Zarr loaders
pip install calab[loaders]

# Optional: headless browser for batch CaDecon runs
pip install calab[headless]
playwright install chromium
```

Requires **Python 3.10+**. Pre-built wheels include the compiled Rust solver for Linux, macOS, and Windows -- no Rust toolchain needed.

## CaTune: Interactive Parameter Tuning

Choose your deconvolution parameters visually in the browser, then apply them in batch.

### 1. Tune in the browser

```python
import numpy as np
import calab

traces = np.load("my_traces.npy")  # (n_cells, n_timepoints)

# Opens CaTune in the browser -- tune parameters, click Export
params = calab.tune(traces, fs=30.0)
# Returns: {'tau_rise': 0.02, 'tau_decay': 0.4, 'lambda_': 0.01, 'fs': 30.0, 'filter_enabled': False}
```

### 2. Batch deconvolution

Apply the parameters you chose (or values from the literature) across all traces:

```python
activity = calab.run_deconvolution(
    traces, fs=30.0,
    tau_r=params["tau_rise"],
    tau_d=params["tau_decay"],
    lam=params["lambda_"],
)

# Full diagnostics: baseline, reconvolution, convergence
result = calab.run_deconvolution_full(traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.01)
```

> **Note:** The deconvolved output represents scaled neural activity, not discrete
> spikes or firing rates. The signal is scaled by an unknown constant (indicator
> expression level, optical path, etc.), so absolute values should not be
> interpreted as spike counts.

### 3. From a CaTune export JSON

```python
params = calab.load_export_params("catune-params.json")
activity = calab.deconvolve_from_export(traces, "catune-params.json")
```

## CaDecon: Automated Deconvolution

CaDecon estimates the calcium kernel and deconvolution parameters from your data -- no manual tuning needed.

### Interactive mode

```python
result = calab.decon(traces, fs=30.0)
```

### Autorun mode

```python
result = calab.decon(traces, fs=30.0, autorun=True)

print(result.activity.shape)    # (n_cells, n_timepoints), float32
print(result.kernel_slow.shape) # estimated slow kernel waveform
print(result.metadata)          # tau values, convergence info, etc.
```

### Headless mode (batch processing)

Run without a browser window. Requires `pip install calab[headless]` and `playwright install chromium`.

```python
# Single run
result = calab.decon(traces, fs=30.0, headless=True, autorun=True)

# Batch processing (reuses one browser across datasets)
from calab import HeadlessBrowser
with HeadlessBrowser() as hb:
    for traces, fs in datasets:
        result = calab.decon(traces, fs, headless=hb, autorun=True)
```

## Loading Data

```python
# CaImAn HDF5 -- reads traces and sampling rate directly
traces, meta = calab.load_caiman("caiman_results.hdf5")

# Minian Zarr -- reads traces, sampling rate must be provided
traces, meta = calab.load_minian("minian_output/", fs=30.0)

# Both return (ndarray, dict) with shape (n_cells, n_timepoints)
```

Requires `pip install calab[loaders]`.

### Saving for CaTune

```python
calab.save_for_tuning(traces, fs=30.0, path="my_recording")
# Creates my_recording.npy + my_recording_metadata.json
```

## Synthetic Data Simulation

Generate synthetic calcium traces with ground truth for testing and benchmarking. The simulation runs in Rust for performance.

```python
result = calab.simulate()

print(result.traces.shape)              # (100, 27000)
print(result.ground_truth[0].spikes)    # spike counts at imaging rate for cell 0
```

Available presets: `gcamp6f`, `gcamp6s`, `gcamp6m`, `jgcamp8f`, `ogb1`, and `clean` (minimal noise, for debugging). These are approximate starting points for generating synthetic data.

Custom configuration with Pydantic models:

```python
from calab import SimulationConfig, KernelConfig, NoiseConfig, PoissonConfig

config = SimulationConfig(
    num_cells=20,
    num_timepoints=9000,
    fs_hz=30.0,
    kernel=KernelConfig(tau_rise_s=0.05, tau_decay_s=0.3),
    spike_model=PoissonConfig(rate_hz=2.0),
    noise=NoiseConfig(snr=5.0),
)
result = calab.simulate(config)
```

## CLI

```bash
# CaTune: interactive tuning
calab tune my_traces.npy --fs 30.0

# CaDecon: automated deconvolution
calab cadecon my_traces.npy --fs 30.0 -o results

# Batch deconvolution with CaTune export params
calab deconvolve my_traces.npy --params catune-params.json -o activity.npy

# Convert from CaImAn/Minian to CaLab format
calab convert caiman_results.hdf5 --format caiman -o my_recording

# Show file info
calab info my_traces.npy

# Print version
calab --version
```

## API Reference

For full API documentation with parameter details, see [calab.readthedocs.io](https://calab.readthedocs.io).

### CaTune

| Function                                                | Description                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `tune(traces, fs, ...)`                                 | Open CaTune in browser for interactive tuning                        |
| `run_deconvolution(traces, fs, tau_r, tau_d, lam)`      | FISTA deconvolution, returns activity array                          |
| `run_deconvolution_full(traces, fs, tau_r, tau_d, lam)` | Full result with baseline, reconvolution                             |
| `load_export_params(path)`                              | Load params from CaTune export JSON                                  |
| `deconvolve_from_export(traces, params_path)`           | Load params + deconvolve in one step                                 |
| `save_for_tuning(traces, fs, path)`                     | Save traces for CaTune browser                                       |
| `load_tuning_data(path)`                                | Load traces saved by save_for_tuning                                 |
| `DeconvolutionResult`                                   | Namedtuple: activity, baseline, reconvolution, iterations, converged |

### CaDecon

| Function / Type                                    | Description                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `decon(traces, fs, ...)`                           | Open CaDecon in browser                                                          |
| `HeadlessBrowser()`                                | Context manager for headless browser sessions                                    |
| `solve_trace(trace, tau_rise, tau_decay, fs, ...)` | Single-trace InDeCa pipeline                                                     |
| `estimate_kernel(traces_flat, spikes_flat, ...)`   | Free-form kernel estimation                                                      |
| `fit_biexponential(h_free, fs, ...)`               | Bi-exponential kernel fit                                                        |
| `compute_upsample_factor(fs, target_fs)`           | Upsample factor for target rate                                                  |
| `CaDeconResult`                                    | Namedtuple: activity, alphas, baselines, pves, kernels, fs, metadata             |
| `SolveTraceResult`                                 | Namedtuple: s_counts, alpha, baseline, threshold, pve, iterations, converged     |
| `BiexpFitResult`                                   | Namedtuple: tau_rise, tau_decay, beta, residual, fast-component fields, fit_mode |

> **Non-finite input:** the deconvolution/fit entry points (`run_deconvolution*`, `solve_trace`, `estimate_kernel`, `fit_biexponential`, and the batch paths) raise `ValueError` if an input trace/array contains `NaN` or `Inf`, rather than returning garbage. `fit_biexponential`'s `fit_mode` reports the outcome (`"TwoComponent"` / `"SlowOnly"` / `"Degenerate"` / `"Empty"`).

### Shared Utilities

| Function                                          | Description                            |
| ------------------------------------------------- | -------------------------------------- |
| `build_kernel(tau_rise, tau_decay, fs)`           | Double-exponential calcium kernel      |
| `bandpass_filter(trace, tau_rise, tau_decay, fs)` | FFT bandpass filter from kernel params |
| `compute_lipschitz(kernel)`                       | Lipschitz constant for FISTA step size |
| `tau_to_ar2(tau_rise, tau_decay, fs)`             | AR(2) coefficients from tau values     |

### Loaders

| Function                 | Description                            |
| ------------------------ | -------------------------------------- |
| `load_caiman(path, ...)` | Load traces from CaImAn HDF5 file      |
| `load_minian(path, ...)` | Load traces from Minian Zarr directory |

### Simulation

| Function / Type         | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| `simulate(config, ...)` | Generate synthetic calcium traces with ground truth                           |
| `presets`               | Built-in indicator presets (gcamp6f, gcamp6s, gcamp6m, jgcamp8f, ogb1, clean) |
| `SimulationConfig`      | Top-level simulation configuration (Pydantic model)                           |
| `SimulationResult`      | Result with traces array and per-cell ground truth                            |
| `CellGroundTruth`       | Per-cell ground truth: spikes, clean_calcium, alpha, snr, tau values          |
| `KernelConfig`          | Double-exponential kernel parameters                                          |
| `MarkovConfig`          | Two-state HMM spike generator (default)                                       |
| `PoissonConfig`         | Homogeneous Poisson spike generator                                           |
| `NoiseConfig`           | Gaussian + optional shot noise                                                |
| `SinusoidalDrift`       | Deterministic sinusoidal baseline drift                                       |
| `RandomWalkDrift`       | Mean-reverting random walk drift (default)                                    |
| `PhotobleachingConfig`  | Exponential photobleaching model                                              |
| `SaturationConfig`      | Hill equation indicator saturation model                                      |
