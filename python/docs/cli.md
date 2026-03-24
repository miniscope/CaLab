# CLI Reference

CaLab provides a command-line interface for common workflows.

## `calab tune`

Open CaTune in the browser for interactive parameter tuning.

```bash
calab tune my_traces.npy --fs 30.0
```

**Arguments:**

- `file` — Path to a `.npy` file (1D or 2D array) or CaLab format (stem without extension)
- `--fs` — Sampling rate in Hz (required for `.npy` files)
- `--port` — Server port (default: auto-assigned)
- `--no-browser` — Start the server without opening a browser

Returns the exported parameters as JSON on stdout.

## `calab cadecon`

Open CaDecon in the browser for automated deconvolution.

```bash
calab cadecon my_traces.npy --fs 30.0
```

**Arguments:**

- `file` — Path to a `.npy` file
- `--fs` — Sampling rate in Hz (required)
- `--port` — Server port (default: auto-assigned)
- `--no-browser` — Start the server without opening a browser

## `calab deconvolve`

Batch deconvolution from the command line using previously exported parameters.

```bash
calab deconvolve my_traces.npy --params catune_params.json -o activity.npy
```

**Arguments:**

- `file` — Path to a `.npy` file
- `--params` — Path to a CaTune export JSON with deconvolution parameters
- `-o, --output` — Output path for the deconvolved activity (`.npy`)

## `calab convert`

Convert CaImAn or Minian outputs to CaLab-compatible `.npy` format.

```bash
calab convert caiman_results.hdf5 --format caiman --fs 30.0 -o my_recording
```

**Arguments:**

- `file` — Path to input file (HDF5 or Zarr directory)
- `--format` — Source format: `caiman` or `minian`
- `--fs` — Sampling rate in Hz (required for Minian; CaImAn reads it from the file)
- `-o, --output` — Output path stem (creates `{output}.npy` and `{output}_metadata.json`)

## `calab info`

Display metadata about a `.npy` or CaTune export `.json` file.

```bash
calab info my_traces.npy
calab info catune_params.json
```

**Arguments:**

- `file` — Path to a `.npy` array or `.json` params file
