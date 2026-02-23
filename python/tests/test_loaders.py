"""Tests for format loaders (CaImAn HDF5, Minian Zarr).

Tests create small fixtures in-test and verify round-trip loading.
Marked with skipif when optional dependencies are missing.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import numpy.testing as npt
import pytest

# Check for optional dependencies
h5py = pytest.importorskip("h5py", reason="h5py not installed")
zarr = pytest.importorskip("zarr", reason="zarr not installed")

from calab import load_caiman, load_minian


# ---------------------------------------------------------------------------
# CaImAn HDF5 tests
# ---------------------------------------------------------------------------


def _create_caiman_hdf5(path: Path, traces: np.ndarray, fs: float) -> str:
    """Create a mock CaImAn HDF5 file."""
    filepath = str(path / "caiman_results.hdf5")
    with h5py.File(filepath, "w") as f:
        f.create_dataset("estimates/C", data=traces)
        f.create_dataset("params/data/fr", data=fs)
    return filepath


def test_caiman_load_basic(tmp_path: Path) -> None:
    """Load standard CaImAn file with traces and sampling rate."""
    rng = np.random.default_rng(42)
    traces_gt = rng.standard_normal((5, 200))
    filepath = _create_caiman_hdf5(tmp_path, traces_gt, 30.0)

    traces, meta = load_caiman(filepath)

    npt.assert_allclose(traces, traces_gt)
    assert meta["source"] == "caiman"
    assert meta["sampling_rate_hz"] == 30.0
    assert meta["num_cells"] == 5
    assert meta["num_timepoints"] == 200


def test_caiman_load_custom_keys(tmp_path: Path) -> None:
    """Load with non-default HDF5 keys."""
    rng = np.random.default_rng(0)
    traces_gt = rng.standard_normal((3, 100))
    filepath = str(tmp_path / "custom.hdf5")
    with h5py.File(filepath, "w") as f:
        f.create_dataset("my/traces", data=traces_gt)
        f.create_dataset("my/fs", data=50.0)

    traces, meta = load_caiman(filepath, trace_key="my/traces", fs_key="my/fs")

    npt.assert_allclose(traces, traces_gt)
    assert meta["sampling_rate_hz"] == 50.0


def test_caiman_load_fs_override(tmp_path: Path) -> None:
    """Override sampling rate ignores fs_key."""
    traces_gt = np.zeros((2, 50))
    filepath = _create_caiman_hdf5(tmp_path, traces_gt, 30.0)

    traces, meta = load_caiman(filepath, fs=100.0)

    assert meta["sampling_rate_hz"] == 100.0


def test_caiman_load_1d(tmp_path: Path) -> None:
    """1D traces are reshaped to (1, n)."""
    trace_1d = np.zeros(100)
    filepath = str(tmp_path / "1d.hdf5")
    with h5py.File(filepath, "w") as f:
        f.create_dataset("estimates/C", data=trace_1d)

    traces, meta = load_caiman(filepath)

    assert traces.shape == (1, 100)
    assert meta["num_cells"] == 1


def test_caiman_missing_file(tmp_path: Path) -> None:
    """Missing file raises FileNotFoundError."""
    with pytest.raises(FileNotFoundError):
        load_caiman(str(tmp_path / "nonexistent.hdf5"))


def test_caiman_missing_key(tmp_path: Path) -> None:
    """Missing trace key raises KeyError."""
    filepath = str(tmp_path / "empty.hdf5")
    with h5py.File(filepath, "w") as f:
        f.create_dataset("other/data", data=np.zeros(10))

    with pytest.raises(KeyError, match="estimates/C"):
        load_caiman(filepath)


# ---------------------------------------------------------------------------
# Minian Zarr tests
# ---------------------------------------------------------------------------


def _create_minian_zarr(path: Path, traces: np.ndarray) -> str:
    """Create a mock Minian Zarr directory."""
    dirpath = str(path / "minian_output")
    store = zarr.open(dirpath, mode="w")
    store.create_array("C", data=traces)
    return dirpath


def test_minian_load_basic(tmp_path: Path) -> None:
    """Load standard Minian file."""
    rng = np.random.default_rng(42)
    traces_gt = rng.standard_normal((4, 150))
    dirpath = _create_minian_zarr(tmp_path, traces_gt)

    traces, meta = load_minian(dirpath, fs=30.0)

    npt.assert_allclose(traces, traces_gt)
    assert meta["source"] == "minian"
    assert meta["sampling_rate_hz"] == 30.0
    assert meta["num_cells"] == 4
    assert meta["num_timepoints"] == 150


def test_minian_load_custom_key(tmp_path: Path) -> None:
    """Load with non-default Zarr key."""
    rng = np.random.default_rng(0)
    traces_gt = rng.standard_normal((2, 80))
    dirpath = str(tmp_path / "custom_minian")
    store = zarr.open(dirpath, mode="w")
    store.create_array("traces", data=traces_gt)

    traces, meta = load_minian(dirpath, trace_key="traces", fs=25.0)

    npt.assert_allclose(traces, traces_gt)
    assert meta["sampling_rate_hz"] == 25.0


def test_minian_load_no_fs(tmp_path: Path) -> None:
    """Loading without fs results in None in metadata."""
    traces_gt = np.zeros((2, 50))
    dirpath = _create_minian_zarr(tmp_path, traces_gt)

    traces, meta = load_minian(dirpath)

    assert meta["sampling_rate_hz"] is None


def test_minian_missing_dir(tmp_path: Path) -> None:
    """Missing directory raises FileNotFoundError."""
    with pytest.raises(FileNotFoundError):
        load_minian(str(tmp_path / "nonexistent"))


def test_minian_missing_key(tmp_path: Path) -> None:
    """Missing trace key raises KeyError."""
    dirpath = str(tmp_path / "empty_minian")
    store = zarr.open(dirpath, mode="w")
    store.create_array("other", data=np.zeros(10))

    with pytest.raises(KeyError, match="C"):
        load_minian(dirpath)
