# CLI Reference

The `calab` command-line interface exposes the most common calcium imaging
workflows as shell commands: interactive tuning, CaDecon,
batch deconvolution, format conversion, and file inspection.

Use the CLI when you want to run one-off tasks from a terminal or integrate
CaLab into a shell script or pipeline. For programmatic access inside Python
(e.g., looping over recordings or building custom workflows), use the
Python API directly instead.

```bash
calab --version          # print installed version
calab <command> --help   # help for a specific command
```

---

## `calab tune`

Open CaTune in the browser for interactive parameter tuning.

```bash
calab tune my_traces.npy --fs 30.0
```

**Arguments:**

| Argument       | Required | Default       | Description                                                                                                   |
| -------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `file`         | yes      | —             | Path to a `.npy` file (1D or 2D array) or CaLab format (stem without extension)                               |
| `--fs`         | yes\*    | `None`        | Sampling rate in Hz. \*May be omitted when loading CaLab format that embeds the rate in its metadata sidecar. |
| `--port`       | no       | auto-assigned | Server port                                                                                                   |
| `--no-browser` | no       | `false`       | Start the server without opening a browser                                                                    |

On success, prints the exported parameters as JSON to stdout.
Exits with code 1 if no parameters are received.

---

## `calab cadecon`

Open CaDecon in the browser.

```bash
calab cadecon my_traces.npy
calab cadecon my_traces.npy --fs 20.0 -o results
```

**Arguments:**

| Argument       | Required | Default       | Description                                                                                |
| -------------- | -------- | ------------- | ------------------------------------------------------------------------------------------ |
| `file`         | yes      | —             | Path to a `.npy` file (1D or 2D array)                                                     |
| `--fs`         | no       | `30.0`        | Sampling rate in Hz                                                                        |
| `--port`       | no       | auto-assigned | Server port                                                                                |
| `--no-browser` | no       | `false`       | Start the server without opening a browser                                                 |
| `-o, --output` | no       | `None`        | Output path stem. When provided, saves `{output}_activity.npy` and `{output}_results.json` |

Prints a summary of the deconvolution results (activity shape, sampling rate,
alphas, baselines, PVEs, kernel lengths). Exits with code 1 if no results
are received.

---

## `calab deconvolve`

Batch deconvolution from the command line using previously exported parameters.

```bash
calab deconvolve my_traces.npy -p catune_params.json
calab deconvolve my_traces.npy -p catune_params.json -o output.npy --full
```

**Arguments:**

| Argument       | Required | Default        | Description                                                                                                                                           |
| -------------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`         | yes      | —              | Path to a `.npy` file (1D or 2D array)                                                                                                                |
| `-p, --params` | yes      | —              | Path to a CaTune export JSON with deconvolution parameters                                                                                            |
| `-o, --output` | no       | `activity.npy` | Output `.npy` file path                                                                                                                               |
| `--full`       | no       | `false`        | Save full results: in addition to the activity array, writes a `*_info.json` sidecar with baseline, iteration count, and convergence status per trace |

---

## `calab convert`

Convert CaImAn or Minian outputs to CaLab-compatible `.npy` format.

```bash
calab convert caiman_results.hdf5 -f caiman --fs 30.0 -o my_recording
```

**Arguments:**

| Argument       | Required | Default         | Description                                                                                       |
| -------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `file`         | yes      | —               | Path to input file (HDF5 for CaImAn, Zarr directory for Minian)                                   |
| `-f, --format` | yes      | —               | Source format: `caiman` or `minian`                                                               |
| `--fs`         | no\*     | `None`          | Sampling rate in Hz. \*Required when the source file does not embed it (check with `calab info`). |
| `-o, --output` | no       | input file stem | Output path stem (creates `{output}.npy` and `{output}_metadata.json`)                            |

Requires the loaders extra: `pip install calab[loaders]`.

---

## `calab info`

Display metadata about a `.npy` or CaTune export `.json` file.

```bash
calab info my_traces.npy
calab info catune_params.json
```

**Arguments:**

| Argument | Required | Default | Description                                   |
| -------- | -------- | ------- | --------------------------------------------- |
| `file`   | yes      | —       | Path to a `.npy` array or `.json` params file |

For `.npy` files, shows shape, dtype, size, cell/timepoint counts, and any
metadata sidecar. For `.json` files, shows parameter keys and values.
