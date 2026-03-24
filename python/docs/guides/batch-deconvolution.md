# Batch Deconvolution

For processing traces programmatically without the browser UI.

## Basic deconvolution

```python
import numpy as np
import calab

traces = np.load("my_traces.npy")  # (n_cells, n_timepoints)

# Returns just the deconvolved activity
activity = calab.run_deconvolution(
    traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.5
)
```

## Full results

```python
result = calab.run_deconvolution_full(
    traces, fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.5
)

result.activity        # deconvolved activity
result.baseline        # estimated baseline(s)
result.reconvolution   # reconvolved fit
result.iterations      # iterations used
result.converged       # convergence flag
```

## From CaTune export

After tuning parameters in the browser, apply them in batch:

```python
# Load exported parameters
params = calab.load_export_params("catune_params.json")

# Apply to traces
result = calab.deconvolve_from_export(
    traces, "catune_params.json", return_full=True
)
```

## Solver primitives

For fine-grained control, use the lower-level functions:

```python
# Build the convolution kernel
kernel = calab.build_kernel(tau_rise=0.02, tau_decay=0.4, fs=30.0)

# Compute Lipschitz constant (for FISTA step size)
L = calab.compute_lipschitz(kernel)

# Bandpass filter a trace
filtered = calab.bandpass_filter(trace, tau_rise=0.02, tau_decay=0.4, fs=30.0)

# Fit biexponential to a free kernel estimate
fit = calab.fit_biexponential(h_free, fs=30.0)
print(fit.tau_rise, fit.tau_decay, fit.beta)
```
