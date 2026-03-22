"""Tests for CaDeconResult and _build_biexp_waveform."""

from __future__ import annotations

import numpy as np
import numpy.testing as npt

from calab._compute import CaDeconResult, _build_biexp_waveform


def test_cadecon_result_construction() -> None:
    """CaDeconResult can be constructed and fields accessed by name."""
    activity = np.zeros((3, 100), dtype=np.float32)
    alphas = np.array([1.0, 1.5, 2.0])
    baselines = np.array([0.1, 0.2, 0.3])
    pves = np.array([0.9, 0.85, 0.92])
    kernel_slow = np.ones(50, dtype=np.float32)
    kernel_fast = np.empty(0, dtype=np.float32)

    result = CaDeconResult(
        activity=activity,
        alphas=alphas,
        baselines=baselines,
        pves=pves,
        kernel_slow=kernel_slow,
        kernel_fast=kernel_fast,
        fs=30.0,
        metadata={"tau_rise": 0.2, "tau_decay": 1.0},
    )

    assert result.activity.shape == (3, 100)
    assert result.alphas.shape == (3,)
    assert result.baselines.shape == (3,)
    assert result.pves.shape == (3,)
    assert result.kernel_slow.shape == (50,)
    assert result.kernel_fast.shape == (0,)
    assert result.fs == 30.0
    assert result.metadata["tau_rise"] == 0.2


def test_cadecon_result_is_namedtuple() -> None:
    """CaDeconResult supports tuple unpacking."""
    result = CaDeconResult(
        activity=np.zeros((1, 10), dtype=np.float32),
        alphas=np.array([1.0]),
        baselines=np.array([0.0]),
        pves=np.array([0.9]),
        kernel_slow=np.ones(5, dtype=np.float32),
        kernel_fast=np.empty(0, dtype=np.float32),
        fs=30.0,
        metadata={},
    )
    activity, alphas, baselines, pves, ks, kf, fs, meta = result
    assert fs == 30.0
    assert len(alphas) == 1


def test_build_biexp_waveform_shape() -> None:
    """_build_biexp_waveform returns correct length and dtype."""
    waveform = _build_biexp_waveform(
        tau_rise=0.02, tau_decay=0.4, beta=1.0, fs=30.0, length=100,
    )
    assert waveform.shape == (100,)
    assert waveform.dtype == np.float32


def test_build_biexp_waveform_starts_near_zero() -> None:
    """Waveform starts at 0 (at t=0, exp(0)-exp(0) = 0)."""
    waveform = _build_biexp_waveform(
        tau_rise=0.02, tau_decay=0.4, beta=1.0, fs=1000.0, length=500,
    )
    assert abs(waveform[0]) < 1e-6


def test_build_biexp_waveform_peak_positive() -> None:
    """Waveform peaks at a positive value when beta > 0."""
    waveform = _build_biexp_waveform(
        tau_rise=0.02, tau_decay=0.4, beta=1.0, fs=1000.0, length=500,
    )
    assert waveform.max() > 0


def test_build_biexp_waveform_decays() -> None:
    """Waveform value at end is less than peak (it decays)."""
    waveform = _build_biexp_waveform(
        tau_rise=0.02, tau_decay=0.4, beta=1.0, fs=1000.0, length=2000,
    )
    assert waveform[-1] < waveform.max()


def test_build_biexp_waveform_beta_scaling() -> None:
    """Doubling beta doubles the waveform amplitude."""
    w1 = _build_biexp_waveform(tau_rise=0.02, tau_decay=0.4, beta=1.0, fs=100.0, length=50)
    w2 = _build_biexp_waveform(tau_rise=0.02, tau_decay=0.4, beta=2.0, fs=100.0, length=50)
    npt.assert_allclose(w2, 2.0 * w1, atol=1e-6)
