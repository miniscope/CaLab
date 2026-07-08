# CaDecon: Automated Deconvolution

## What is CaDecon?

CaDecon is CaLab's automated deconvolution workflow. Unlike CaTune -- where you manually select kernel time constants and sparsity parameters -- CaDecon uses the **InDeCa** (Iterative Non-parametric Deconvolution for Calcium imaging) algorithm to estimate both the calcium kernel shape and per-cell deconvolution parameters directly from your data. You do not need to know `tau_rise`, `tau_decay`, or `lambda` in advance. This is a new approach developed by the CaLab team and should be evaluated on your own data before adopting it for production analyses.

---

## Quick start

```python
import calab
import numpy as np

traces = np.load("my_traces.npy")  # (n_cells, n_timepoints) or (n_timepoints,)

result = calab.decon(traces, fs=30.0, autorun=True)

if result is not None:
    print(result.activity.shape)   # (n_cells, n_timepoints)
    print(result.fs)               # effective sampling rate
    print(result.pves)             # per-cell proportion of variance explained
    print(result.metadata)         # estimated tau values, convergence info, etc.
```

`decon()` starts a local bridge server, opens the CaDecon web app, and waits for the solver to finish. With `autorun=True` the solver runs immediately after loading -- no manual interaction needed. The estimated kernel parameters and deconvolved activity come back as a `CaDeconResult`.

---

## `decon()` reference

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

### Parameters

| Parameter           | Description                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `traces`            | Calcium traces. Shape `(n_cells, n_timepoints)` or `(n_timepoints,)`.                                                       |
| `fs`                | Sampling rate in Hz. Default: `30.0`.                                                                                       |
| `timeout`           | Seconds to wait for results. `None` waits forever (until Ctrl-C or browser close).                                          |
| `port`              | Port to bind the bridge server to. `None` auto-assigns a free port.                                                         |
| `app_url`           | Override CaDecon URL (useful for local dev). Default: GitHub Pages deployment.                                              |
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

### How it works

`decon()` uses the same bridge mechanism as [`tune()`](catune.md): Python starts a local HTTP server on `127.0.0.1`, opens the CaDecon web app with a `?bridge=` URL parameter, and the browser's WASM solver does the heavy lifting. Results are posted back to the bridge server and returned as a `CaDeconResult`. The server binds to localhost only and is not network-reachable.

### Return value: `CaDeconResult`

Returns a `CaDeconResult` namedtuple, or `None` if the session was cancelled or timed out.

| Attribute     | Type         | Description                                                             |
| ------------- | ------------ | ----------------------------------------------------------------------- |
| `activity`    | `np.ndarray` | Deconvolved activity matrix, shape `(n_cells, n_timepoints)`, float32   |
| `alphas`      | `np.ndarray` | Per-cell scaling factors, shape `(n_cells,)`, float64                   |
| `baselines`   | `np.ndarray` | Per-cell baseline estimates, shape `(n_cells,)`, float64                |
| `pves`        | `np.ndarray` | Per-cell proportion of variance explained, shape `(n_cells,)`, float64  |
| `kernel_slow` | `np.ndarray` | Slow biexponential kernel waveform, float32                             |
| `kernel_fast` | `np.ndarray` | Fast biexponential kernel waveform, float32 (empty if single-component) |
| `fs`          | `float`      | Effective sampling rate in Hz                                           |
| `metadata`    | `dict`       | Estimated tau values, convergence info, version, etc.                   |

The `metadata` dict typically contains:

| Key                      | Description                                |
| ------------------------ | ------------------------------------------ |
| `tau_rise`               | Estimated slow rise time constant (s)      |
| `tau_decay`              | Estimated slow decay time constant (s)     |
| `beta`                   | Slow component amplitude                   |
| `tau_rise_fast`          | Fast rise time constant (s), 0 if unused   |
| `tau_decay_fast`         | Fast decay time constant (s), 0 if unused  |
| `beta_fast`              | Fast component amplitude, 0 if unused      |
| `num_iterations`         | InDeCa iterations completed                |
| `converged`              | Whether the algorithm converged            |
| `converged_at_iteration` | Iteration at which convergence was reached |
| `residual`               | Final fit residual                         |
| `h_free`                 | Free-form kernel estimate (list of floats) |

---

## Headless mode

For scripting, batch processing, or CI pipelines, run CaDecon without a visible browser window using `HeadlessBrowser`. This is typically combined with `autorun=True` so the solver runs without user interaction.

### Installation

```bash
pip install calab[headless]
playwright install chromium
```

### Single run

```python
with calab.HeadlessBrowser() as browser:
    result = calab.decon(traces, fs=30.0, headless=browser, autorun=True)
```

### Shorthand

Pass `headless=True` to create a temporary browser for a single call:

```python
result = calab.decon(traces, fs=30.0, headless=True, autorun=True)
```

### Batch processing

Reuse a single browser across multiple datasets to avoid repeated startup costs:

```python
import numpy as np
import calab

datasets = [np.load(f"session_{i}.npy") for i in range(10)]

with calab.HeadlessBrowser() as browser:
    results = []
    for traces in datasets:
        r = calab.decon(traces, fs=30.0, headless=browser, autorun=True)
        if r is not None:
            results.append(r)
            print(f"Cells: {r.activity.shape[0]}, PVE mean: {r.pves.mean():.3f}")
```

### Debugging with a visible window

Use `visible=True` to see the browser while still using the programmatic control flow:

```python
with calab.HeadlessBrowser(visible=True) as browser:
    result = calab.decon(traces, fs=30.0, headless=browser, autorun=True)
```

### `HeadlessBrowser` reference

```python
calab.HeadlessBrowser(*, visible: bool = False)
```

| Parameter | Description                                                       |
| --------- | ----------------------------------------------------------------- |
| `visible` | If `True`, show the browser window instead of running headlessly. |

Methods: `start()`, `navigate(url)`, `close()`. Properties: `page` (Playwright `Page`), `is_alive` (bool). Supports use as a context manager (`with HeadlessBrowser() as hb:`).

---

## InDeCa building blocks

The InDeCa algorithm iterates between estimating spike trains, estimating a free-form kernel, and fitting a parametric (biexponential) model to that kernel. The `decon()` function orchestrates the full pipeline in the browser's WASM solver. Advanced users can call the individual building blocks from Python for custom workflows.

### `solve_trace()`

Run the InDeCa deconvolution step on a single trace, given a kernel shape.

```python
calab.solve_trace(
    trace: np.ndarray,
    tau_rise: float,
    tau_decay: float,
    fs: float,
    *,
    upsample_factor: int = 1,
    max_iters: int = 500,
    tol: float = 1e-4,
    hp_enabled: bool = False,
    lp_enabled: bool = False,
    warm_counts: np.ndarray | None = None,
    lambda_: float = 0.0,
) -> SolveTraceResult
```

| Parameter         | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `trace`           | 1-D calcium trace.                                     |
| `tau_rise`        | Rise time constant in seconds.                         |
| `tau_decay`       | Decay time constant in seconds.                        |
| `fs`              | Sampling rate in Hz.                                   |
| `upsample_factor` | Upsampling multiplier (1 = no upsampling).             |
| `max_iters`       | Maximum FISTA iterations.                              |
| `tol`             | Convergence tolerance.                                 |
| `hp_enabled`      | Enable high-pass filtering.                            |
| `lp_enabled`      | Enable low-pass filtering.                             |
| `warm_counts`     | Spike counts from a previous iteration for warm-start. |
| `lambda_`         | L1 sparsity penalty (0 = auto).                        |

Returns a `SolveTraceResult` namedtuple with fields: `s_counts`, `alpha`, `baseline`, `threshold`, `pve`, `iterations`, `converged`.

Raises `ValueError` if `trace` (or `warm_counts`) contains a non-finite value (`NaN` or `Inf`) — the FFI boundary rejects non-finite input rather than returning garbage.

### `estimate_kernel()`

Estimate a free-form kernel from traces and their corresponding spike trains. This is the "kernel step" of the InDeCa iteration.

```python
calab.estimate_kernel(
    traces_flat: np.ndarray,
    spikes_flat: np.ndarray,
    trace_lengths: np.ndarray,
    alphas: np.ndarray,
    baselines: np.ndarray,
    kernel_length: int,
    *,
    max_iters: int = 200,
    tol: float = 1e-4,
    warm_kernel: np.ndarray | None = None,
    smooth_lambda: float = 0.0,
) -> np.ndarray
```

| Parameter       | Description                                               |
| --------------- | --------------------------------------------------------- |
| `traces_flat`   | Concatenated 1-D traces (all cells flattened end-to-end). |
| `spikes_flat`   | Concatenated 1-D spike trains (matching `traces_flat`).   |
| `trace_lengths` | Length of each individual trace in the flat arrays.       |
| `alphas`        | Per-trace amplitude scaling factors.                      |
| `baselines`     | Per-trace baseline estimates.                             |
| `kernel_length` | Desired output kernel length in samples.                  |
| `max_iters`     | Maximum FISTA iterations for kernel estimation.           |
| `tol`           | Convergence tolerance.                                    |
| `warm_kernel`   | Kernel from a previous iteration for warm-start.          |
| `smooth_lambda` | Total-variation smoothness penalty weight.                |

Returns a float32 array of shape `(kernel_length,)` -- the estimated free-form kernel.

Raises `ValueError` if any input array contains a non-finite value (`NaN` or `Inf`).

### `fit_biexponential()`

Fit a parametric biexponential model to a free-form kernel. Optionally refines with a two-component (slow + fast) model.

```python
calab.fit_biexponential(
    h_free: np.ndarray,
    fs: float,
    *,
    refine: bool = True,
    skip: int = 0,
    warm: BiexpFitResult | None = None,
) -> BiexpFitResult
```

| Parameter | Description                                       |
| --------- | ------------------------------------------------- |
| `h_free`  | Free-form kernel (1-D).                           |
| `fs`      | Sampling rate in Hz.                              |
| `refine`  | Whether to refine with a fast (second) component. |
| `skip`    | Number of leading samples to skip in the fit.     |
| `warm`    | Previous `BiexpFitResult` for warm-start.         |

Returns a `BiexpFitResult` namedtuple with fields: `tau_rise`, `tau_decay`, `beta`, `residual`, `tau_rise_fast`, `tau_decay_fast`, `beta_fast`, `fit_mode`. Fast-component fields are 0 if a single-component fit was used. `fit_mode` is a string reporting the fit outcome — one of `"TwoComponent"`, `"SlowOnly"`, `"Degenerate"` (no positive slow amplitude — untrustworthy), or `"Empty"` (no fit produced).

Raises `ValueError` if `h_free` contains a non-finite value (`NaN` or `Inf`).

### `compute_upsample_factor()`

Compute an integer upsampling multiplier for a given source and target sampling rate.

```python
calab.compute_upsample_factor(fs: float, target_fs: float) -> int
```

| Parameter   | Description                   |
| ----------- | ----------------------------- |
| `fs`        | Original sampling rate in Hz. |
| `target_fs` | Target sampling rate in Hz.   |

Returns an integer >= 1.

### Custom workflow example

```python
import numpy as np
import calab

traces = np.load("my_traces.npy")  # (n_cells, n_timepoints)
fs = 30.0

# Step 1: Start with an initial guess for the kernel
tau_r, tau_d = 0.1, 0.5

# Step 2: Solve each trace with the current kernel
results = [calab.solve_trace(traces[i], tau_r, tau_d, fs) for i in range(len(traces))]

# Step 3: Estimate a free-form kernel from the spike trains
traces_flat = traces.ravel()
spikes_flat = np.concatenate([r.s_counts for r in results])
trace_lengths = np.array([traces.shape[1]] * len(results))
alphas = np.array([r.alpha for r in results])
baselines = np.array([r.baseline for r in results])

h_free = calab.estimate_kernel(
    traces_flat, spikes_flat, trace_lengths,
    alphas, baselines, kernel_length=int(5 * tau_d * fs),
)

# Step 4: Fit a parametric model to the kernel
fit = calab.fit_biexponential(h_free, fs)
print(f"Estimated: tau_rise={fit.tau_rise:.4f}, tau_decay={fit.tau_decay:.4f}")

# Could iterate steps 2-4 for refinement (this is what InDeCa does internally)
```

For full details on all parameters, return types, and edge cases, see the [API Reference](../autoapi/index).

---

## CLI

CaDecon is also available from the command line via `calab cadecon`:

```bash
calab cadecon traces.npy --fs 30.0 --output results/session1
```

This opens CaDecon in the browser, waits for results, and saves:

- `results/session1_activity.npy` -- deconvolved activity matrix
- `results/session1_results.json` -- alphas, baselines, PVEs, kernel info, and metadata

| Flag             | Description                                        |
| ---------------- | -------------------------------------------------- |
| `file`           | Input `.npy` file (positional argument).           |
| `--fs`           | Sampling rate in Hz. Default: `30.0`.              |
| `--port`         | Server port. Default: auto-assign.                 |
| `--no-browser`   | Don't auto-open the browser.                       |
| `--output`, `-o` | Output path stem. Omit to print results to stdout. |

For additional CLI commands, see the [CLI Reference](../cli.md).
