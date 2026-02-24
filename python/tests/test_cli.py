"""Tests for the CLI entry point."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest


def run_cli(*args: str, cwd: str | None = None) -> subprocess.CompletedProcess:
    """Run the calab CLI and return the result."""
    return subprocess.run(
        [sys.executable, "-m", "calab._cli", *args],
        capture_output=True,
        text=True,
        cwd=cwd,
    )


def test_version() -> None:
    """--version prints version."""
    result = run_cli("--version")
    assert result.returncode == 0
    from calab import __version__

    assert __version__ in result.stdout


def test_info_npy(tmp_path: Path) -> None:
    """info subcommand shows .npy file details."""
    data = np.random.default_rng(42).standard_normal((5, 200))
    npy_path = str(tmp_path / "traces.npy")
    np.save(npy_path, data)

    result = run_cli("info", npy_path)

    assert result.returncode == 0
    assert "Shape: (5, 200)" in result.stdout
    assert "Cells: 5" in result.stdout
    assert "Timepoints: 200" in result.stdout


def test_info_json(tmp_path: Path) -> None:
    """info subcommand shows export JSON details."""
    export = {
        "schema_version": "1.1.0",
        "parameters": {
            "tau_rise_s": 0.02,
            "tau_decay_s": 0.4,
            "lambda": 0.01,
            "sampling_rate_hz": 30.0,
        },
    }
    json_path = str(tmp_path / "export.json")
    with open(json_path, "w") as f:
        json.dump(export, f)

    result = run_cli("info", json_path)

    assert result.returncode == 0
    assert "CaTune export" in result.stdout
    assert "tau_rise_s" in result.stdout


def test_deconvolve(tmp_path: Path) -> None:
    """deconvolve subcommand produces output .npy."""
    # Create synthetic data
    from calab import build_kernel

    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 200
    spikes = np.zeros(n)
    spikes[50] = 1.0
    spikes[120] = 1.0
    trace = np.convolve(spikes, kernel)[:n]
    traces = trace.reshape(1, -1)

    npy_path = str(tmp_path / "traces.npy")
    np.save(npy_path, traces)

    # Create export JSON
    export = {
        "schema_version": "1.1.0",
        "catune_version": "test",
        "export_date": "2025-01-01",
        "parameters": {
            "tau_rise_s": 0.02,
            "tau_decay_s": 0.4,
            "lambda": 0.01,
            "sampling_rate_hz": 30.0,
            "filter_enabled": False,
        },
        "ar2_coefficients": {},
        "formulation": {},
        "metadata": {},
    }
    json_path = str(tmp_path / "export.json")
    with open(json_path, "w") as f:
        json.dump(export, f)

    output_path = str(tmp_path / "activity.npy")
    result = run_cli("deconvolve", npy_path, "--params", json_path, "-o", output_path)

    assert result.returncode == 0
    assert Path(output_path).exists()

    activity = np.load(output_path)
    assert activity.shape == (1, n)
    assert np.all(activity >= 0)


def test_info_with_metadata(tmp_path: Path) -> None:
    """info shows metadata sidecar info when present."""
    traces = np.zeros((2, 100))
    stem = str(tmp_path / "test_data")

    np.save(f"{stem}.npy", traces)
    with open(f"{stem}_metadata.json", "w") as f:
        json.dump({"schema_version": "1.0.0", "sampling_rate_hz": 30.0}, f)

    result = run_cli("info", f"{stem}.npy")

    assert result.returncode == 0
    assert "Sampling rate: 30.0 Hz" in result.stdout
