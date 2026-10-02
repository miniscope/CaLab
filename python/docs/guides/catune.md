# CaTune Workflow

CaTune is the interactive parameter tuning approach to calcium trace deconvolution. You choose the deconvolution parameters -- rise time constant, decay time constant, and sparsity penalty -- and CaTune helps you see how they perform on your real data. Under the hood it uses FISTA deconvolution with a double-exponential calcium kernel, following established approaches from the literature.

## The workflow

A typical CaTune workflow has four steps:

1. **Load your data** -- from CaImAn, Minian, or raw NumPy arrays (see [Loading Data](loaders.md))
2. **Tune parameters interactively** -- use `calab.tune()` to open CaTune in the browser, adjust parameters, and see the deconvolved result in real time
3. **Export parameters** -- export your chosen parameters from the browser as a JSON file (or receive them directly as a Python dict via the bridge)
4. **Batch deconvolve** -- apply those parameters to all your traces with `calab.run_deconvolution()` or `calab.deconvolve_from_export()`

You can also skip the browser entirely and call `run_deconvolution()` directly with parameters from the literature.

---

## Interactive tuning with `tune()`

`tune()` opens CaTune in your browser so you can explore deconvolution parameters interactively. It starts a local HTTP server on `127.0.0.1`, opens the web app with a `?bridge=` URL parameter pointing to that server, and the browser fetches your traces from the server. When you export parameters from the web app, the browser POSTs them back and `tune()` returns them as a Python dict.

```python
import calab
import numpy as np

traces = np.load("my_traces.npy")  # (n_cells, n_timepoints)

# Opens CaTune in your default browser and blocks until you export params
params = calab.tune(traces, fs=30.0)

if params is not None:
    print(params)
    # {'tau_rise': 0.02, 'tau_decay': 0.4, 'lambda_': 0.5, 'fs': 30.0, 'filter_enabled': False}
```

### Full signature

```python
calab.tune(
    traces: np.ndarray,
    fs: float = 30.0,
    timeout: float | None = None,
    port: int | None = None,
    app_url: str | None = None,
    open_browser: bool = True,
) -> dict | None
```

| Parameter      | Description                                                                       |
| -------------- | --------------------------------------------------------------------------------- |
| `traces`       | Calcium traces. Shape `(n_cells, n_timepoints)` or `(n_timepoints,)`.             |
| `fs`           | Sampling rate in Hz. Default: `30.0`.                                             |
| `timeout`      | Seconds to wait. `None` waits forever (until Ctrl-C or browser close).            |
| `port`         | Port to bind the bridge server to. `None` auto-assigns a free port.               |
| `app_url`      | Override the CaTune URL (useful for local dev). Default: GitHub Pages deployment. |
| `open_browser` | Whether to auto-open the browser. Default: `True`.                                |

### Return value

Returns a `dict` with the parameters you selected, or `None` if the session was cancelled or timed out. Dict keys:

| Key              | Type    | Description                             |
| ---------------- | ------- | --------------------------------------- |
| `tau_rise`       | `float` | Rise time constant (seconds)            |
| `tau_decay`      | `float` | Decay time constant (seconds)           |
| `lambda_`        | `float` | Sparsity regularization weight          |
| `fs`             | `float` | Sampling rate (Hz)                      |
| `filter_enabled` | `bool`  | Whether high-pass filtering was enabled |

Under the hood, `tune()` starts a local HTTP server on `127.0.0.1`, opens the web app with a `?bridge=` URL parameter, and the browser fetches traces from (and posts results back to) that server. The server binds to localhost only and is not network-reachable.

---

## Batch deconvolution with `run_deconvolution()`

Once you have parameters -- from `tune()`, from a CaTune export JSON, or from published values in the literature -- apply them to all your traces with `run_deconvolution()`.

### Quick activity extraction

```python
import numpy as np
import calab

traces = np.load("my_traces.npy")  # (n_cells, n_timepoints)

# Using params from tune()
activity = calab.run_deconvolution(
    traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.5
)
# activity.shape == traces.shape
```

You can also use parameters directly from the literature without opening the browser at all:

```python
# GCaMP6f typical values (no browser needed)
activity = calab.run_deconvolution(
    traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.5
)
```

### Full signature

```python
calab.run_deconvolution(
    traces: np.ndarray,
    fs: float,
    tau_r: float,
    tau_d: float,
    lam: float,
    max_iters: int = 2000,
    conv_mode: str = "fft",
    constraint: str = "nonneg",
) -> np.ndarray
```

| Parameter    | Description                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `traces`     | Calcium traces. Shape `(n_timepoints,)` or `(n_cells, n_timepoints)`.                                                         |
| `fs`         | Sampling rate in Hz.                                                                                                          |
| `tau_r`      | Rise time constant in seconds.                                                                                                |
| `tau_d`      | Decay time constant in seconds.                                                                                               |
| `lam`        | L1 sparsity penalty (regularization strength).                                                                                |
| `max_iters`  | Maximum FISTA iterations. Default: `2000`.                                                                                    |
| `conv_mode`  | Convolution mode: `"fft"` (default) or `"banded"` (O(T) AR2).                                                                 |
| `constraint` | Constraint type: `"nonneg"` (L1 + non-negative) or `"box01"` (clamp to [0,1], same L1 penalty; use `lam=0` for the pure box). |

Returns a `np.ndarray` of non-negative activity estimates, same shape as the input `traces`.

### Full results with diagnostics

`run_deconvolution_full` has the same signature but returns a `DeconvolutionResult` namedtuple with additional diagnostics:

```python
result = calab.run_deconvolution_full(
    traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.5
)

result.activity        # np.ndarray  -- deconvolved activity
result.baseline        # float | np.ndarray  -- estimated baseline(s), in the input's units
result.reconvolution   # np.ndarray  -- model fit in the input's frame (K*activity + baseline,
                       #                including any slow drift removed before solving)
result.iterations      # int | np.ndarray  -- FISTA iterations used
result.converged       # bool | np.ndarray  -- convergence flag(s)
```

For multi-trace input, `baseline`, `iterations`, and `converged` are arrays (one value per cell).

See the [API Reference](../autoapi/index) for the full `DeconvolutionResult` definition.

---

## From a CaTune export

After tuning parameters in the browser, CaTune can export them as a JSON file. Two convenience functions let you load and apply those exact parameters without manually extracting values.

### Loading export parameters

```python
params = calab.load_export_params("catune_export.json")
# Returns dict with keys: tau_rise, tau_decay, lambda_, fs, filter_enabled
```

```python
calab.load_export_params(
    path: str | Path,
) -> dict
```

| Parameter | Description                          |
| --------- | ------------------------------------ |
| `path`    | Path to the CaTune export JSON file. |

Returns a `dict` with keys: `tau_rise`, `tau_decay`, `lambda_`, `fs`, `filter_enabled`.

### Deconvolving from an export

`deconvolve_from_export` loads the export JSON, applies the bandpass filter if it was enabled during tuning, and runs FISTA deconvolution -- all in one call.

```python
# Just the activity array
activity = calab.deconvolve_from_export(traces, "catune_export.json")

# Full diagnostics
result = calab.deconvolve_from_export(
    traces, "catune_export.json", return_full=True
)
```

```python
calab.deconvolve_from_export(
    traces: np.ndarray,
    params_path: str | Path,
    return_full: bool = False,
) -> np.ndarray | DeconvolutionResult
```

| Parameter     | Description                                                           |
| ------------- | --------------------------------------------------------------------- |
| `traces`      | Calcium traces. Shape `(n_timepoints,)` or `(n_cells, n_timepoints)`. |
| `params_path` | Path to the CaTune export JSON file.                                  |
| `return_full` | If `True`, return a `DeconvolutionResult`. Default: `False`.          |

---

## Saving and loading data

If you prefer a file-based workflow instead of the bridge (for example, preparing data on a cluster and tuning in the browser on your laptop), use `save_for_tuning` and `load_tuning_data`.

### Saving traces for CaTune

```python
calab.save_for_tuning(traces, fs=30.0, path="my_recording")
# Creates: my_recording.npy + my_recording_metadata.json
```

The `.npy` file can be loaded directly in CaTune's browser interface via drag-and-drop. The `_metadata.json` sidecar records the sampling rate, dimensions, and schema version.

```python
calab.save_for_tuning(
    traces: np.ndarray,
    fs: float,
    path: str | Path,
    metadata: dict | None = None,
) -> None
```

| Parameter  | Description                                                                            |
| ---------- | -------------------------------------------------------------------------------------- |
| `traces`   | Calcium traces. Shape `(n_timepoints,)` or `(n_cells, n_timepoints)`.                  |
| `fs`       | Sampling rate in Hz.                                                                   |
| `path`     | Output path stem (without extension). Creates `{path}.npy` and `{path}_metadata.json`. |
| `metadata` | Additional metadata to include in the JSON sidecar. Optional.                          |

### Loading saved data

```python
traces, meta = calab.load_tuning_data("my_recording")
# Reads my_recording.npy + my_recording_metadata.json
```

```python
calab.load_tuning_data(
    path: str | Path,
) -> tuple[np.ndarray, dict]
```

| Parameter | Description                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| `path`    | Path stem (without extension), matching what was passed to `save_for_tuning`. |

Returns a tuple of `(traces, metadata)` where `traces` is a float64 array and `metadata` is the JSON sidecar contents.

---

## CLI

CaTune workflows are also available from the command line.

### Interactive tuning

```bash
calab tune my_traces.npy --fs 30.0
```

This opens CaTune in the browser. When you export parameters, they are printed as JSON to stdout.

### Batch deconvolution

```bash
calab deconvolve my_traces.npy --params catune_export.json -o activity.npy
```

Add `--full` to save diagnostics alongside the activity array:

```bash
calab deconvolve my_traces.npy --params catune_export.json -o activity.npy --full
```

See the [CLI Reference](../cli) for all commands and options.

---

## End-to-end example

Putting it all together -- load data, tune interactively, then batch deconvolve:

```python
import calab

# 1. Load traces from CaImAn (requires: pip install calab[loaders])
traces, meta = calab.load_caiman("caiman_results.hdf5")
fs = meta["sampling_rate_hz"]

# 2. Tune parameters in the browser
params = calab.tune(traces, fs=fs)

# 3. Apply to all traces
if params is not None:
    activity = calab.run_deconvolution(
        traces,
        fs=params["fs"],
        tau_r=params["tau_rise"],
        tau_d=params["tau_decay"],
        lam=params["lambda_"],
    )
    np.save("deconvolved_activity.npy", activity)
```

Or, using the file-based workflow:

```python
import calab

# 1. Save traces for CaTune
calab.save_for_tuning(traces, fs=30.0, path="my_recording")
# -> Drag-and-drop my_recording.npy into CaTune in the browser
# -> Export parameters as catune_export.json

# 2. Batch deconvolve from the export
activity = calab.deconvolve_from_export(traces, "catune_export.json")
```
