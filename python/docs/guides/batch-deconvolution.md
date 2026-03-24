# Batch Deconvolution

When you have tuned deconvolution parameters on a few representative traces
in the CaTune browser UI, the next step is applying those parameters across
an entire recording session -- hundreds or thousands of cells. Batch
deconvolution via the Python API gives you:

- **Reproducibility** -- parameters are saved as JSON; the same call always
  produces the same output.
- **Pipeline integration** -- slot deconvolution into a larger analysis
  workflow (segmentation, deconvolution, downstream analysis) without manual
  intervention.
- **Performance** -- the Rust FISTA solver processes traces in parallel and
  is significantly faster than pure-Python alternatives.

---

## High-level: `run_deconvolution` / `run_deconvolution_full`

These are the primary entry points. Both accept one trace or a batch of
traces and run FISTA deconvolution with the given parameters.

### Quick activity extraction

```python
import numpy as np
import calab

traces = np.load("my_traces.npy")  # (n_cells, n_timepoints)

activity = calab.run_deconvolution(
    traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.5
)
# activity.shape == traces.shape
```

### Full signature

```python
calab.run_deconvolution(
    traces,          # (n_timepoints,) or (n_cells, n_timepoints)
    fs,              # sampling rate in Hz
    tau_r,           # rise time constant (seconds)
    tau_d,           # decay time constant (seconds)
    lam,             # L1 sparsity penalty
    max_iters=2000,  # maximum FISTA iterations
    conv_mode="fft", # "fft" (default) or "banded" (O(T) AR2)
    constraint="nonneg",  # "nonneg" (L1 + non-negative) or "box01" ([0,1] box)
) -> np.ndarray
```

### Full results with diagnostics

`run_deconvolution_full` has the same signature but returns a
`DeconvolutionResult` namedtuple instead of a bare array:

```python
result = calab.run_deconvolution_full(
    traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.5
)

result.activity        # np.ndarray  -- deconvolved activity
result.baseline        # float | np.ndarray  -- estimated baseline(s)
result.reconvolution   # np.ndarray  -- model fit (K*activity + baseline)
result.iterations      # int | np.ndarray  -- FISTA iterations used
result.converged       # bool | np.ndarray  -- convergence flag(s)
```

For multi-trace input, `baseline`, `iterations`, and `converged` are arrays
(one value per cell).

---

## From a CaTune export

After tuning parameters in the browser, CaTune exports a JSON file. Use it
to reproduce the exact same deconvolution offline:

```python
# Inspect exported parameters
params = calab.load_export_params("catune_params.json")
# Returns dict with keys:
#   tau_rise, tau_decay, lambda_, fs, filter_enabled

# Apply to traces (handles bandpass filter if it was enabled)
activity = calab.deconvolve_from_export(traces, "catune_params.json")

# Or get full diagnostics
result = calab.deconvolve_from_export(
    traces, "catune_params.json", return_full=True
)
```

`deconvolve_from_export` signature:

```python
calab.deconvolve_from_export(
    traces,                 # (n_timepoints,) or (n_cells, n_timepoints)
    params_path,            # path to CaTune export JSON
    return_full=False,      # if True, return DeconvolutionResult
) -> np.ndarray | DeconvolutionResult
```

---

## Mid-level: `solve_trace`

`solve_trace` processes a single trace with optional upsampling, filtering,
warm-starting, and richer diagnostics on top of the core solver.

```python
result = calab.solve_trace(
    trace,              # 1-D calcium trace
    tau_rise=0.02,
    tau_decay=0.4,
    fs=30.0,
    upsample_factor=2,  # temporal super-resolution (1 = none)
    max_iters=500,
    tol=1e-4,
    hp_enabled=False,    # high-pass filter
    lp_enabled=False,    # low-pass filter
    warm_counts=None,    # previous spike counts for warm-start
    lambda_=0.0,         # L1 penalty (0 = auto)
)
```

Returns a `SolveTraceResult` namedtuple:

```python
result.s_counts     # np.ndarray  -- spike counts at original rate
result.alpha        # float       -- amplitude scaling
result.baseline     # float       -- estimated baseline
result.threshold    # float       -- spike threshold used
result.pve          # float       -- proportion of variance explained (0-1)
result.iterations   # int         -- FISTA iterations run
result.converged    # bool        -- whether solver converged
```

---

## Low-level utilities

These functions provide direct access to individual steps of the
deconvolution pipeline. Most users won't need them -- they are available
for custom workflows and integration with other tools. See the
[API Reference](../autoapi/index) for full signatures.

```python
# Build the calcium kernel from time constants
kernel = calab.build_kernel(tau_rise=0.02, tau_decay=0.4, fs=30.0)

# Apply bandpass filter derived from kernel time constants
filtered = calab.bandpass_filter(trace, tau_rise=0.02, tau_decay=0.4, fs=30.0)

# Compute upsampling factor for a target rate
factor = calab.compute_upsample_factor(fs=30.0, target_fs=100.0)
```

Additional primitives available: `estimate_kernel`, `fit_biexponential`,
`compute_lipschitz`, `tau_to_ar2`.
