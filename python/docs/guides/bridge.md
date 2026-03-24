# Browser Bridge

## Why a bridge?

CaLab's deconvolution solver and interactive visualizations run in the browser as WebAssembly. The bridge lets you send trace data from a Python session (NumPy arrays, Jupyter notebooks, analysis pipelines) to the web app, interact with the results there, and get structured outputs back in Python -- all without saving intermediate files.

Under the hood, CaLab starts a local HTTP server on `127.0.0.1`, opens the web app with a `?bridge=http://127.0.0.1:PORT` URL parameter, and the browser fetches traces from (and posts results back to) that server. The server binds to localhost only and is not network-reachable.

## Interactive tuning with `tune()`

`tune()` opens CaTune in your browser so you can explore deconvolution parameters interactively. When you export parameters from the web app, they are returned as a Python dict.

```python
import calab
import numpy as np

traces = np.load("my_traces.npy")  # (n_cells, n_timepoints) or (n_timepoints,)

# Opens CaTune in your default browser and blocks until you export params
params = calab.tune(traces, fs=30.0)

if params is not None:
    print(params["tau_rise"])
    print(params["tau_decay"])
    print(params["lambda_"])
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

## CaDecon with `decon()`

`decon()` opens CaDecon in the browser, optionally auto-runs the solver, and returns structured results.

```python
result = calab.decon(traces, fs=30.0, autorun=True)

if result is not None:
    print(result.activity.shape)   # (n_cells, n_timepoints)
    print(result.fs)               # effective sampling rate
    print(result.metadata)         # tau values, convergence info, etc.
```

### Full signature

```python
calab.decon(
    traces: np.ndarray,
    fs: float = 30.0,
    timeout: float | None = None,
    port: int | None = None,
    app_url: str | None = None,
    open_browser: bool = True,
    headless: HeadlessBrowser | bool | None = None,
    *,
    autorun: bool = False,
    upsample_target: int | None = None,
    hp_filter_enabled: bool | None = None,
    lp_filter_enabled: bool | None = None,
    max_iterations: int | None = None,
    convergence_tol: float | None = None,
    num_subsets: int | None = None,
    target_coverage: float | None = None,
    aspect_ratio: float | None = None,
    seed: int | None = None,
) -> CaDeconResult | None
```

| Parameter           | Description                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `traces`            | Calcium traces. Shape `(n_cells, n_timepoints)` or `(n_timepoints,)`.                                                       |
| `fs`                | Sampling rate in Hz. Default: `30.0`.                                                                                       |
| `timeout`           | Seconds to wait. `None` waits forever.                                                                                      |
| `port`              | Port to bind. `None` auto-assigns.                                                                                          |
| `app_url`           | Override CaDecon URL. Default: GitHub Pages deployment.                                                                     |
| `open_browser`      | Auto-open the browser. Default: `True`.                                                                                     |
| `headless`          | `None`/`False`: normal browser. `True`: create a temporary headless browser. `HeadlessBrowser`: reuse an existing instance. |
| `autorun`           | Start the solver automatically after traces load. Default: `False`.                                                         |
| `upsample_target`   | Target sampling rate (Hz) for upsampling. Must be > 0.                                                                      |
| `hp_filter_enabled` | Enable high-pass filter before deconvolution.                                                                               |
| `lp_filter_enabled` | Enable low-pass filter before deconvolution.                                                                                |
| `max_iterations`    | Maximum solver iterations (1--200).                                                                                         |
| `convergence_tol`   | Convergence tolerance (0--1, exclusive).                                                                                    |
| `num_subsets`       | Number of random subsets for optimization. Must be > 0.                                                                     |
| `target_coverage`   | Fraction of data covered by subsets (0--1].                                                                                 |
| `aspect_ratio`      | Subset aspect ratio (> 0). Greater than 1 = wider, less than 1 = taller.                                                    |
| `seed`              | Random seed for reproducible subset placement.                                                                              |

Parameters after `headless` are keyword-only. Any parameter set to `None` falls through to the browser's default value.

### Return value

Returns a `CaDeconResult` with the following attributes, or `None` if the session was cancelled or timed out:

| Attribute     | Type         | Description                                      |
| ------------- | ------------ | ------------------------------------------------ |
| `activity`    | `np.ndarray` | Deconvolved activity matrix (float32)            |
| `alphas`      | `np.ndarray` | Per-cell scaling factors                         |
| `baselines`   | `np.ndarray` | Per-cell baseline values                         |
| `pves`        | `np.ndarray` | Per-cell percent variance explained              |
| `kernel_slow` | `np.ndarray` | Slow component kernel waveform                   |
| `kernel_fast` | `np.ndarray` | Fast component kernel waveform (empty if unused) |
| `fs`          | `float`      | Effective sampling rate                          |
| `metadata`    | `dict`       | Tau values, convergence info, version, etc.      |

## Headless mode

For scripting, batch processing, or CI, run the browser without a visible window using a `HeadlessBrowser`. This is typically combined with `autorun=True` so the solver runs without user interaction.

```python
# Single run
with calab.HeadlessBrowser() as browser:
    result = calab.decon(traces, fs=30.0, headless=browser, autorun=True)

# Batch processing (reuses the same browser across datasets)
with calab.HeadlessBrowser() as browser:
    results = []
    for t in all_traces:
        r = calab.decon(t, fs=30.0, headless=browser, autorun=True)
        results.append(r)
```

You can also pass `headless=True` as a shorthand to create a temporary browser for a single call:

```python
result = calab.decon(traces, fs=30.0, headless=True, autorun=True)
```

`HeadlessBrowser` accepts a `visible` keyword argument for debugging -- set `visible=True` to see the browser window while still using the programmatic control flow:

```python
with calab.HeadlessBrowser(visible=True) as browser:
    result = calab.decon(traces, fs=30.0, headless=browser, autorun=True)
```

Headless mode requires the `headless` extra:

```bash
pip install calab[headless]
playwright install chromium
```

## How the bridge works

1. Python starts an HTTP server on `127.0.0.1` (localhost only, not network-reachable)
2. Opens the web app with `?bridge=http://127.0.0.1:PORT`
3. The browser fetches trace data from `GET /api/v1/traces` (binary .npy format)
4. The browser fetches metadata from `GET /api/v1/metadata` (sampling rate, dimensions)
5. For `decon()`, the browser also fetches config from `GET /api/v1/config`
6. The browser sends periodic heartbeats via `POST /api/v1/heartbeat`
7. When the user exports (or the solver finishes), the browser POSTs results back
8. Python receives the results, shuts down the server, and returns
