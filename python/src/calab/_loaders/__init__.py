"""Format loaders for CaImAn HDF5 and Minian Zarr outputs.

Lazy imports so ``import calab`` works without h5py/zarr installed.
Install optional deps with: ``pip install calab[loaders]``
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np


def load_caiman(
    path: str,
    trace_key: str = "estimates/C",
    fs_key: str = "params/data/fr",
    fs: float | None = None,
) -> tuple["np.ndarray", dict]:
    """Load traces from a CaImAn HDF5 results file.

    Parameters
    ----------
    path : str
        Path to the CaImAn HDF5 file (e.g., ``caiman_results.hdf5``).
    trace_key : str
        HDF5 key for the traces array. Default: ``"estimates/C"``.
    fs_key : str
        HDF5 key for the sampling rate. Default: ``"params/data/fr"``.
    fs : float, optional
        Override sampling rate. If provided, ``fs_key`` is ignored.

    Returns
    -------
    traces : np.ndarray
        Traces array, shape ``(n_cells, n_timepoints)``, dtype float64.
    metadata : dict
        Metadata dict with keys: ``source``, ``sampling_rate_hz``,
        ``num_cells``, ``num_timepoints``.

    Raises
    ------
    ImportError
        If h5py is not installed.
    FileNotFoundError
        If the HDF5 file does not exist.
    KeyError
        If ``trace_key`` is not found in the file.
    """
    from ._caiman import load_caiman as _load

    return _load(path, trace_key=trace_key, fs_key=fs_key, fs=fs)


def load_minian(
    path: str,
    trace_key: str = "C",
    fs: float | None = None,
) -> tuple["np.ndarray", dict]:
    """Load traces from a Minian Zarr output directory.

    Parameters
    ----------
    path : str
        Path to the Minian Zarr directory (e.g., ``minian_output/``).
    trace_key : str
        Zarr key for the traces array. Default: ``"C"``.
    fs : float, optional
        Sampling rate in Hz. Minian does not store this, so it must
        be provided (or will default to None in metadata).

    Returns
    -------
    traces : np.ndarray
        Traces array, shape ``(n_cells, n_timepoints)``, dtype float64.
    metadata : dict
        Metadata dict with keys: ``source``, ``sampling_rate_hz``,
        ``num_cells``, ``num_timepoints``.

    Raises
    ------
    ImportError
        If zarr is not installed.
    FileNotFoundError
        If the Zarr directory does not exist.
    KeyError
        If ``trace_key`` is not found in the store.
    """
    from ._minian import load_minian as _load

    return _load(path, trace_key=trace_key, fs=fs)
