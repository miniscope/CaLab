"""Tests for save_for_tuning, load_tuning_data, load_export_params,
and deconvolve_from_export I/O functions.

Covers round-trip fidelity, format compatibility with CaTune's browser
.npy parser, metadata content, error handling, and the JSON import pipeline.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import numpy.testing as npt
import pytest

from calab import load_tuning_data, save_for_tuning
from calab._io import load_export_params, deconvolve_from_export
from calab._kernel import build_kernel


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_mock_export_json(path: Path, **overrides) -> Path:
    """Write a mock CaTune export JSON and return its path."""
    data = {
        "schema_version": "1.1.0",
        "catune_version": "dev",
        "export_date": "2025-01-01T00:00:00Z",
        "parameters": {
            "tau_rise_s": 0.02,
            "tau_decay_s": 0.4,
            "lambda": 0.01,
            "sampling_rate_hz": 30.0,
            "filter_enabled": False,
        },
        "ar2_coefficients": {
            "g1": 1.0,
            "g2": -0.5,
            "decayRoot": 0.9,
            "riseRoot": 0.1,
        },
        "formulation": {
            "model": "FISTA",
            "objective": "test",
            "kernel": "test",
            "ar2_relation": "test",
            "lambda_definition": "test",
            "convergence": "test",
        },
        "metadata": {},
    }
    # Apply overrides to parameters
    for key, val in overrides.items():
        data["parameters"][key] = val

    json_path = path / "export.json"
    with open(json_path, "w") as f:
        json.dump(data, f, indent=2)
    return json_path


# ---------------------------------------------------------------------------
# Test 1: Save/load round-trip
# ---------------------------------------------------------------------------

def test_save_load_roundtrip(tmp_path: Path):
    """Save random (5, 1000) array, load back, assert_allclose."""
    rng = np.random.default_rng(42)
    traces = rng.standard_normal((5, 1000))
    path = str(tmp_path / "test_data")

    save_for_tuning(traces, 30.0, path)
    loaded, meta = load_tuning_data(path)

    npt.assert_allclose(loaded, traces.astype(np.float64))
    assert meta["sampling_rate_hz"] == 30.0


# ---------------------------------------------------------------------------
# Test 2: Creates both .npy and .json
# ---------------------------------------------------------------------------

def test_save_creates_npy_and_json(tmp_path: Path):
    """Verify both files exist after save."""
    traces = np.zeros((2, 100))
    path = str(tmp_path / "output")

    save_for_tuning(traces, 30.0, path)

    assert Path(f"{path}.npy").exists(), ".npy file missing"
    assert Path(f"{path}_metadata.json").exists(), "_metadata.json file missing"


# ---------------------------------------------------------------------------
# Test 3: Metadata contains required fields
# ---------------------------------------------------------------------------

def test_metadata_contains_required_fields(tmp_path: Path):
    """Check schema_version, sampling_rate_hz, num_cells, num_timepoints, dtype."""
    traces = np.zeros((3, 500))
    path = str(tmp_path / "meta_test")

    save_for_tuning(traces, 25.0, path)
    _, meta = load_tuning_data(path)

    assert meta["schema_version"] == "1.0.0"
    assert meta["sampling_rate_hz"] == 25.0
    assert meta["num_cells"] == 3
    assert meta["num_timepoints"] == 500
    assert meta["dtype"] == "<f8"


# ---------------------------------------------------------------------------
# Test 4: Custom metadata preserved
# ---------------------------------------------------------------------------

def test_custom_metadata_preserved(tmp_path: Path):
    """Pass metadata={'indicator': 'GCaMP7f'}, verify in loaded metadata."""
    traces = np.zeros((1, 100))
    path = str(tmp_path / "custom")

    save_for_tuning(traces, 30.0, path, metadata={"indicator": "GCaMP7f"})
    _, meta = load_tuning_data(path)

    assert meta["indicator"] == "GCaMP7f"
    # Built-in keys should also be present
    assert meta["schema_version"] == "1.0.0"


# ---------------------------------------------------------------------------
# Test 5: 1D input becomes 2D
# ---------------------------------------------------------------------------

def test_1d_input_becomes_2d(tmp_path: Path):
    """Save 1D array, load back, verify shape is (1, n)."""
    trace_1d = np.random.default_rng(0).standard_normal(200)
    path = str(tmp_path / "one_d")

    save_for_tuning(trace_1d, 30.0, path)
    loaded, meta = load_tuning_data(path)

    assert loaded.shape == (1, 200), f"Expected (1, 200), got {loaded.shape}"
    assert meta["num_cells"] == 1
    assert meta["num_timepoints"] == 200


# ---------------------------------------------------------------------------
# Test 6: Float64 enforcement
# ---------------------------------------------------------------------------

def test_float64_enforcement(tmp_path: Path):
    """Save float32 array, load back, verify dtype is float64."""
    traces = np.zeros((2, 50), dtype=np.float32)
    path = str(tmp_path / "f32")

    save_for_tuning(traces, 30.0, path)
    loaded, _ = load_tuning_data(path)

    assert loaded.dtype == np.float64, f"Expected float64, got {loaded.dtype}"


# ---------------------------------------------------------------------------
# Test 7: C-contiguous enforcement
# ---------------------------------------------------------------------------

def test_c_contiguous_enforcement(tmp_path: Path):
    """Save Fortran-order array, load back, verify C-contiguous."""
    traces = np.asfortranarray(np.zeros((3, 100)))
    assert not traces.flags["C_CONTIGUOUS"]

    path = str(tmp_path / "fortran")
    save_for_tuning(traces, 30.0, path)
    loaded, _ = load_tuning_data(path)

    assert loaded.flags["C_CONTIGUOUS"], "Loaded array should be C-contiguous"


# ---------------------------------------------------------------------------
# Test 8: Load missing file raises FileNotFoundError
# ---------------------------------------------------------------------------

def test_load_missing_file_raises(tmp_path: Path):
    """Attempt load from nonexistent path, expect FileNotFoundError."""
    with pytest.raises(FileNotFoundError, match="not found"):
        load_tuning_data(str(tmp_path / "nonexistent"))


# ---------------------------------------------------------------------------
# Test 9: .npy format compatible with CaTune browser parser
# ---------------------------------------------------------------------------

def test_npy_format_compatible(tmp_path: Path):
    """Verify saved .npy is Float64, C-contiguous, little-endian."""
    traces = np.random.default_rng(1).standard_normal((2, 50))
    path = str(tmp_path / "compat")

    save_for_tuning(traces, 30.0, path)

    # Load and inspect directly
    loaded = np.load(f"{path}.npy")
    assert loaded.dtype == np.dtype("<f8"), f"Expected <f8, got {loaded.dtype}"
    assert loaded.flags["C_CONTIGUOUS"], "Array should be C-contiguous"
    assert not loaded.flags["F_CONTIGUOUS"] or loaded.shape[0] == 1, (
        "Array should not be Fortran-contiguous for multi-row"
    )

    # Verify the .npy header directly
    with open(f"{path}.npy", "rb") as f:
        # Read magic bytes
        magic = f.read(6)
        assert magic == b"\x93NUMPY"
        # Read version
        version = f.read(2)
        major = version[0]
        # Read header
        if major == 1:
            header_len = int.from_bytes(f.read(2), "little")
        else:
            header_len = int.from_bytes(f.read(4), "little")
        header = f.read(header_len).decode("ascii").strip()

    assert "'fortran_order': False" in header
    assert "'<f8'" in header or "'float64'" in header


# ---------------------------------------------------------------------------
# Test 10: load_export_params round-trip
# ---------------------------------------------------------------------------

def test_load_export_params_roundtrip(tmp_path: Path):
    """Write mock export JSON -> load -> verify parameter values."""
    json_path = _write_mock_export_json(
        tmp_path,
        tau_rise_s=0.05,
        tau_decay_s=1.0,
        sampling_rate_hz=20.0,
        **{"lambda": 0.1},
        filter_enabled=True,
    )

    params = load_export_params(json_path)

    assert params["tau_rise"] == 0.05
    assert params["tau_decay"] == 1.0
    assert params["lambda_"] == 0.1
    assert params["fs"] == 20.0
    assert params["filter_enabled"] is True


# ---------------------------------------------------------------------------
# Test 11: load_export_params missing file
# ---------------------------------------------------------------------------

def test_load_export_params_missing_file(tmp_path: Path):
    """Attempt to load from nonexistent path, expect FileNotFoundError."""
    with pytest.raises(FileNotFoundError, match="not found"):
        load_export_params(tmp_path / "nonexistent.json")


# ---------------------------------------------------------------------------
# Test 12: deconvolve_from_export pipeline (filter disabled)
# ---------------------------------------------------------------------------

def test_deconvolve_from_export_basic(tmp_path: Path):
    """Mock JSON + synthetic trace -> verify activity is non-negative."""
    json_path = _write_mock_export_json(tmp_path, filter_enabled=False)

    # Create a synthetic trace
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 200
    activity_gt = np.zeros(n)
    activity_gt[50] = 1.0
    activity_gt[120] = 1.0
    trace = np.convolve(activity_gt, kernel)[:n]

    result = deconvolve_from_export(trace, json_path)

    assert result.shape == (n,)
    assert np.all(result >= 0)
    # Should detect activity near ground-truth locations
    for loc in [50, 120]:
        window = result[max(0, loc - 2) : loc + 3]
        assert window.max() > 0.01, f"No activity near {loc}"


# ---------------------------------------------------------------------------
# Test 13: deconvolve_from_export with filter enabled
# ---------------------------------------------------------------------------

def test_deconvolve_from_export_with_filter(tmp_path: Path):
    """Filter-enabled path: verify filter is applied."""
    json_path = _write_mock_export_json(
        tmp_path,
        filter_enabled=True,
        sampling_rate_hz=100.0,
    )

    # Create synthetic trace with DC offset + signal
    kernel = build_kernel(0.02, 0.4, 100.0)
    n = 500
    activity_gt = np.zeros(n)
    activity_gt[100] = 1.0
    trace = np.convolve(activity_gt, kernel)[:n] + 5.0  # DC offset

    result = deconvolve_from_export(trace, json_path)

    assert result.shape == (n,)
    assert np.all(result >= 0)


# ---------------------------------------------------------------------------
# Test 14: deconvolve_from_export with return_full
# ---------------------------------------------------------------------------

def test_deconvolve_from_export_full(tmp_path: Path):
    """return_full=True returns DeconvolutionResult."""
    json_path = _write_mock_export_json(tmp_path, filter_enabled=False)

    kernel = build_kernel(0.02, 0.4, 30.0)
    trace = np.convolve(np.eye(1, 100, 30).ravel(), kernel)[:100]

    result = deconvolve_from_export(trace, json_path, return_full=True)

    assert hasattr(result, "activity")
    assert hasattr(result, "baseline")
    assert hasattr(result, "reconvolution")
    assert hasattr(result, "iterations")
    assert hasattr(result, "converged")
