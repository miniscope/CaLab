"""Minian Zarr loader."""

from __future__ import annotations

from pathlib import Path

import numpy as np


def load_minian(
    path: str,
    trace_key: str = "C",
    fs: float | None = None,
) -> tuple[np.ndarray, dict]:
    """Load traces from a Minian Zarr output directory."""
    try:
        import zarr
    except ImportError:
        raise ImportError(
            "zarr is required to load Minian files. "
            "Install it with: pip install calab[loaders]"
        ) from None

    path = str(path)
    if not Path(path).exists():
        raise FileNotFoundError(f"Minian Zarr directory not found: {path}")

    store = zarr.open(path, mode="r")

    if trace_key not in store:
        raise KeyError(
            f"Trace key '{trace_key}' not found in {path}. "
            f"Available keys: {list(store.keys())}"
        )

    traces = np.asarray(store[trace_key], dtype=np.float64)

    # Ensure 2D
    if traces.ndim == 1:
        traces = traces.reshape(1, -1)

    metadata = {
        "source": "minian",
        "sampling_rate_hz": fs,
        "num_cells": int(traces.shape[0]),
        "num_timepoints": int(traces.shape[1]),
    }

    return traces, metadata
