# Browser Bridge

CaLab connects Python to the CaTune and CaDecon web apps through a local HTTP bridge. This lets you tune parameters interactively in the browser and get results back in Python.

## Interactive tuning with `tune()`

```python
import calab
import numpy as np

traces = np.load("my_traces.npy")

# Opens CaTune in your default browser
params = calab.tune(traces, fs=30.0)

# params is a dict with the parameters you selected, or None if you closed the tab
```

The bridge:

1. Starts an HTTP server on `127.0.0.1`
2. Opens CaTune with a `?bridge=localhost:PORT` URL parameter
3. Serves your trace data to the browser
4. Waits for you to export parameters
5. Returns the parameters and shuts down

## Automated deconvolution with `decon()`

```python
result = calab.decon(traces, fs=30.0)

# result is a CaDeconResult with activity, kernels, metadata
print(result.activity.shape)
print(result.metadata)
```

## Headless mode

For scripting or CI, run the browser without a visible window:

```python
with calab.HeadlessBrowser() as browser:
    result = calab.decon(traces, fs=30.0, headless=browser)
```

Requires the `headless` extra:

```bash
pip install calab[headless]
playwright install chromium
```

## Custom configuration

Pass a `DeconConfig` to control CaDecon behavior:

```python
config = calab.DeconConfig(
    lam=0.5,
    max_iter=500,
)
result = calab.decon(traces, fs=30.0, config=config)
```
