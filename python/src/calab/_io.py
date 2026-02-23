"""Data I/O functions for CaLab-compatible file export and import.

Saves calcium traces as .npy files with JSON metadata sidecars,
compatible with CaTune's browser-side .npy parser (src/lib/npy-parser.ts).
Also loads CaTune export JSONs for offline deconvolution.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def save_for_tuning(
    traces: np.ndarray,
    fs: float,
    path: str | Path,
    metadata: dict | None = None,
) -> None:
    """Save calcium traces in CaTune-compatible format.

    Creates two files:
      - ``{path}.npy`` -- Float64 array, shape ``(n_cells, n_timepoints)``,
        C-contiguous, little-endian (``<f8``).
      - ``{path}_metadata.json`` -- JSON sidecar with sampling rate,
        schema version, dimensions, and optional user metadata.

    The ``.npy`` file is loadable by CaTune's browser ``.npy`` parser, which
    expects ``dtype='<f8'`` and ``fortran_order=False``.

    **Converting from CaImAn** (users have h5py)::

        import h5py
        import calab

        with h5py.File("caiman_results.hdf5", "r") as f:
            traces = f["estimates/C"][:]       # shape: (n_cells, n_timepoints)
            fs = float(f["params/data/fr"][()])

        calab.save_for_tuning(traces, fs, "my_recording")
        # -> my_recording.npy + my_recording_metadata.json

    **Converting from Minian** (users have zarr/xarray)::

        import zarr
        import calab

        store = zarr.open("minian_output", mode="r")
        traces = store["C"][:]  # shape: (n_cells, n_frames)
        fs = 30.0  # user must know their frame rate

        calab.save_for_tuning(traces, fs, "my_recording")

    Parameters
    ----------
    traces : np.ndarray
        Calcium traces, shape ``(n_timepoints,)`` for a single trace or
        ``(n_cells, n_timepoints)`` for multiple traces.
    fs : float
        Sampling rate in Hz.
    path : str or Path
        Output path stem (without extension). Will create ``{path}.npy``
        and ``{path}_metadata.json``.
    metadata : dict, optional
        Additional metadata to include in the JSON sidecar. Keys are merged
        into the output; built-in keys take precedence.

    Raises
    ------
    ValueError
        If ``traces`` has more than 2 dimensions.
    """
    path = str(path)

    # Coerce to Float64, C-contiguous
    traces = np.ascontiguousarray(traces, dtype=np.float64)

    # Ensure 2D: (n_cells, n_timepoints)
    if traces.ndim == 1:
        traces = traces.reshape(1, -1)
    elif traces.ndim > 2:
        raise ValueError(
            f"traces must be 1D or 2D, got {traces.ndim}D array"
        )

    # Save .npy (Float64, C-contiguous, little-endian)
    np.save(f"{path}.npy", traces)

    # Build metadata sidecar
    meta = {
        **(metadata or {}),
        "schema_version": "1.0.0",
        "sampling_rate_hz": fs,
        "num_cells": int(traces.shape[0]),
        "num_timepoints": int(traces.shape[1]),
        "dtype": "<f8",
    }

    with open(f"{path}_metadata.json", "w") as f:
        json.dump(meta, f, indent=2)


def load_tuning_data(path: str | Path) -> tuple[np.ndarray, dict]:
    """Load calcium traces and metadata saved by :func:`save_for_tuning`.

    Parameters
    ----------
    path : str or Path
        Path stem (without extension), matching the ``path`` argument used
        in :func:`save_for_tuning`.

    Returns
    -------
    traces : np.ndarray
        Loaded traces array, dtype float64.
    metadata : dict
        Metadata from the JSON sidecar.

    Raises
    ------
    FileNotFoundError
        If either ``{path}.npy`` or ``{path}_metadata.json`` is missing.
    """
    path = str(path)
    npy_path = f"{path}.npy"
    json_path = f"{path}_metadata.json"

    if not Path(npy_path).exists():
        raise FileNotFoundError(
            f"Trace data file not found: {npy_path}. "
            f"Expected .npy file at this location."
        )
    if not Path(json_path).exists():
        raise FileNotFoundError(
            f"Metadata file not found: {json_path}. "
            f"Expected _metadata.json sidecar at this location."
        )

    traces = np.load(npy_path)

    with open(json_path) as f:
        metadata = json.load(f)

    return traces, metadata


def load_export_params(path: str | Path) -> dict:
    """Load deconvolution parameters from a CaTune export JSON.

    Parses the JSON export schema 1.1.0 (defined in src/lib/export.ts)
    and returns the parameters needed for deconvolution.

    Parameters
    ----------
    path : str or Path
        Path to the CaTune export JSON file.

    Returns
    -------
    dict
        Dictionary with keys: ``tau_rise``, ``tau_decay``, ``lambda_``,
        ``fs``, ``filter_enabled``.

    Raises
    ------
    FileNotFoundError
        If the JSON file does not exist.
    KeyError
        If required parameter fields are missing.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Export JSON not found: {path}")

    with open(path) as f:
        data = json.load(f)

    params = data["parameters"]

    return {
        "tau_rise": params["tau_rise_s"],
        "tau_decay": params["tau_decay_s"],
        "lambda_": params["lambda"],
        "fs": params["sampling_rate_hz"],
        "filter_enabled": params.get("filter_enabled", False),
    }


def deconvolve_from_export(
    traces: np.ndarray,
    params_path: str | Path,
    return_full: bool = False,
):
    """Run deconvolution using parameters from a CaTune export JSON.

    Loads parameters via :func:`load_export_params`, optionally applies
    the bandpass filter, and runs FISTA deconvolution.

    Parameters
    ----------
    traces : np.ndarray
        Calcium traces, shape ``(n_timepoints,)`` or ``(n_cells, n_timepoints)``.
    params_path : str or Path
        Path to the CaTune export JSON file.
    return_full : bool, optional
        If True, return a :class:`~calab.DeconvolutionResult` namedtuple.
        Default False returns just the activity array.

    Returns
    -------
    np.ndarray or DeconvolutionResult
        Deconvolved activity (or full result if ``return_full=True``).
    """
    from ._compute import run_deconvolution, run_deconvolution_full
    from ._compute import bandpass_filter

    params = load_export_params(params_path)

    # Optionally apply bandpass filter
    if params["filter_enabled"]:
        traces = np.atleast_2d(np.asarray(traces, dtype=np.float64)).copy()
        for i in range(traces.shape[0]):
            traces[i] = bandpass_filter(
                traces[i], params["tau_rise"], params["tau_decay"], params["fs"],
            )
        if traces.shape[0] == 1:
            traces = traces[0]

    solver = run_deconvolution_full if return_full else run_deconvolution
    return solver(
        traces,
        fs=params["fs"],
        tau_r=params["tau_rise"],
        tau_d=params["tau_decay"],
        lam=params["lambda_"],
    )
