"""CaImAn HDF5 loader."""

from __future__ import annotations

from pathlib import Path

import numpy as np


def load_caiman(
    path: str,
    trace_key: str = "estimates/C",
    fs_key: str = "params/data/fr",
    fs: float | None = None,
) -> tuple[np.ndarray, dict]:
    """Load traces from a CaImAn HDF5 results file."""
    try:
        import h5py
    except ImportError:
        raise ImportError(
            "h5py is required to load CaImAn files. "
            "Install it with: pip install calab[loaders]"
        ) from None

    path = str(path)
    if not Path(path).exists():
        raise FileNotFoundError(f"CaImAn HDF5 file not found: {path}")

    with h5py.File(path, "r") as f:
        if trace_key not in f:
            raise KeyError(
                f"Trace key '{trace_key}' not found in {path}. "
                f"Available keys: {list(f.keys())}"
            )
        traces = np.asarray(f[trace_key], dtype=np.float64)

        # Read sampling rate from file if not provided
        if fs is None and fs_key in f:
            fs = float(np.asarray(f[fs_key]))

    # Ensure 2D
    if traces.ndim == 1:
        traces = traces.reshape(1, -1)

    metadata = {
        "source": "caiman",
        "sampling_rate_hz": fs,
        "num_cells": int(traces.shape[0]),
        "num_timepoints": int(traces.shape[1]),
    }

    return traces, metadata
