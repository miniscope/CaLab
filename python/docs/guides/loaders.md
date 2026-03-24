# Loading Data

If you already have calcium imaging results from CaImAn or Minian, the CaLab loaders let you import those traces directly -- no manual HDF5/Zarr wrangling needed. Once loaded, you can save traces in CaTune-compatible format for interactive tuning in the browser, or pass them straight to `calab.tune()` or `calab.run_deconvolution()`.

The loaders are optional. Install the required dependencies with:

```bash
pip install calab[loaders]
```

This pulls in `h5py` (for CaImAn HDF5 files) and `zarr` (for Minian Zarr stores). If you only need one loader, you can install the individual dependency (`pip install h5py` or `pip install zarr`).

## CaImAn (HDF5)

```python
import calab

traces, meta = calab.load_caiman("caiman_results.hdf5")

print(traces.shape)             # (n_cells, n_timepoints), dtype float64
print(meta["sampling_rate_hz"]) # read from the HDF5 file
```

**Parameters:**

| Parameter   | Default            | Description                                                                      |
| ----------- | ------------------ | -------------------------------------------------------------------------------- |
| `path`      | _(required)_       | Path to the CaImAn HDF5 file.                                                    |
| `trace_key` | `"estimates/C"`    | HDF5 dataset key for the traces array.                                           |
| `fs_key`    | `"params/data/fr"` | HDF5 dataset key for the sampling rate. Ignored if `fs` is provided.             |
| `fs`        | `None`             | Override sampling rate (Hz). When provided, the value from `fs_key` is not read. |

Override the default keys if your file uses a different layout:

```python
traces, meta = calab.load_caiman(
    "my_file.hdf5",
    trace_key="estimates/C",
    fs_key="params/data/fr",
)
```

Or provide the sampling rate directly:

```python
traces, meta = calab.load_caiman("my_file.hdf5", fs=30.0)
```

## Minian (Zarr)

```python
import calab

traces, meta = calab.load_minian("minian_output/", fs=30.0)
```

Minian does not store the sampling rate in its Zarr output, so you should provide `fs` if you know it. If omitted, `meta["sampling_rate_hz"]` will be `None`.

**Parameters:**

| Parameter   | Default      | Description                        |
| ----------- | ------------ | ---------------------------------- |
| `path`      | _(required)_ | Path to the Minian Zarr directory. |
| `trace_key` | `"C"`        | Zarr key for the traces array.     |
| `fs`        | `None`       | Sampling rate in Hz.               |

Override the trace key if needed:

```python
traces, meta = calab.load_minian("minian_output/", trace_key="C", fs=30.0)
```

## Metadata dict

Both loaders return a metadata dict with the same structure:

```python
{
    "source": "caiman",          # or "minian"
    "sampling_rate_hz": 30.0,    # float, or None if unknown
    "num_cells": 42,             # int
    "num_timepoints": 9000,      # int
}
```

This dict is separate from the `save_for_tuning` JSON sidecar -- it is a lightweight summary of what was loaded and can be passed through to `save_for_tuning` as custom metadata if desired.

## Saving for CaTune

After loading, save traces in CaTune-compatible format:

```python
calab.save_for_tuning(traces, fs=meta["sampling_rate_hz"], path="my_recording")
# Creates: my_recording.npy + my_recording_metadata.json
```

The `.npy` file contains the traces as a float64 array (`dtype='<f8'`, C-contiguous), and the `_metadata.json` sidecar records the sampling rate, dimensions, schema version, and dtype. These files can be loaded directly in CaTune's browser interface via drag-and-drop.

You can attach additional metadata to the JSON sidecar:

```python
calab.save_for_tuning(
    traces,
    fs=meta["sampling_rate_hz"],
    path="my_recording",
    metadata={"subject": "mouse_01", "session": "day3"},
)
```

To reload saved files in Python:

```python
traces, meta = calab.load_tuning_data("my_recording")
# Reads my_recording.npy + my_recording_metadata.json
```

## Error handling

The loaders raise clear errors when something goes wrong:

- **`ImportError`** -- raised if the required dependency is not installed. The message tells you exactly what to install:
  ```
  ImportError: h5py is required to load CaImAn files.
  Install it with: pip install calab[loaders]
  ```
- **`FileNotFoundError`** -- raised if the HDF5 file or Zarr directory does not exist at the given path.
- **`KeyError`** -- raised if the trace key is not found in the file. The message lists available top-level keys so you can find the right one.

## End-to-end example

A typical workflow: load CaImAn results, save for CaTune, then tune interactively:

```python
import calab

# 1. Load from CaImAn
traces, meta = calab.load_caiman("caiman_results.hdf5")

# 2. Save in CaTune format
calab.save_for_tuning(traces, fs=meta["sampling_rate_hz"], path="my_recording")

# 3. Open in the browser for interactive tuning
params = calab.tune(traces, fs=meta["sampling_rate_hz"])

# 4. Or run batch deconvolution directly
activity = calab.run_deconvolution(
    traces, fs=meta["sampling_rate_hz"],
    tau_r=0.02, tau_d=0.4, lam=0.5,
)
```
