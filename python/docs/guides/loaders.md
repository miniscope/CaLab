# Loading Data

CaLab can load calcium traces from CaImAn and Minian output files. These loaders are optional — install them with:

```bash
pip install calab[loaders]
```

## CaImAn (HDF5)

```python
import calab

traces, meta = calab.load_caiman("caiman_results.hdf5")

print(traces.shape)             # (n_cells, n_timepoints)
print(meta["sampling_rate_hz"]) # read from the HDF5 file
```

By default, traces are read from `estimates/C` and the sampling rate from `params/data/fr`. Override these if your file uses different keys:

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

Minian does not store the sampling rate, so `fs` must be provided. Traces are read from the `C` key by default:

```python
traces, meta = calab.load_minian("minian_output/", trace_key="C", fs=30.0)
```

## Saving for CaTune

After loading, save traces in CaTune-compatible format:

```python
calab.save_for_tuning(traces, fs=meta["sampling_rate_hz"], path="my_recording")
# Creates: my_recording.npy + my_recording_metadata.json
```

These files can be loaded directly in CaTune's browser interface via drag-and-drop.
