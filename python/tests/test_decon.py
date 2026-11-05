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


# ── Result assembly: a run that produced no fit ─────────────────────────────


def _results(**overrides: object) -> dict:
    """A minimal CaDecon results payload, overridable per test."""
    payload: dict = {
        "fs": 30.0,
        "tau_rise": 0.05,
        "tau_decay": 0.4,
        "beta": 1.0,
        "tau_rise_fast": 0.0,
        "tau_decay_fast": 0.0,
        "beta_fast": 0.0,
        "residual": 0.02,
        "alphas": [1.0],
        "baselines": [0.0],
        "pves": [0.9],
        "num_iterations": 4,
        "converged": True,
        "schema_version": 2,
    }
    payload.update(overrides)
    return payload


def test_build_cadecon_result_normal_payload() -> None:
    from calab._bridge._apps import _build_cadecon_result

    result = _build_cadecon_result(_results(), np.zeros((1, 60), dtype=np.float32), 30.0)

    assert result.kernel_slow.size > 0
    assert result.metadata["tau_decay"] == 0.4
    assert result.metadata["residual"] == 0.02


def test_build_cadecon_result_passes_a_missing_fit_through_as_none() -> None:
    """A run stopped before completing an iteration reports null, not a number.

    The browser sends null for the kernel-fit fields in that case. Substituting
    a plausible default here would manufacture exactly the fit the browser
    declined to claim -- and `residual` is the dangerous one, because 0 is its
    best possible value and the export documents lower as a better fit.
    """
    from calab._bridge._apps import _build_cadecon_result

    payload = _results(
        tau_rise=None, tau_decay=None, beta=None,
        tau_rise_fast=None, tau_decay_fast=None, beta_fast=None,
        residual=None, num_iterations=0, converged=False,
    )
    result = _build_cadecon_result(payload, np.zeros((1, 60), dtype=np.float32), 30.0)

    assert result.metadata["tau_rise"] is None
    assert result.metadata["tau_decay"] is None
    assert result.metadata["beta"] is None
    assert result.metadata["residual"] is None
    # No kernel can be built from nothing, and none is invented.
    assert result.kernel_slow.size == 0
    assert result.kernel_fast.size == 0
    # The per-cell arrays are still real data and still come through.
    assert result.alphas.tolist() == [1.0]
    assert result.fs == 30.0


def test_build_cadecon_result_treats_absent_keys_like_nulls() -> None:
    """Older or truncated payloads must not be filled in with defaults either.

    This previously substituted tau_rise=0.2 / tau_decay=1.0 / beta=1.0 for any
    payload missing them, producing a kernel out of nothing.
    """
    from calab._bridge._apps import _build_cadecon_result

    payload = _results()
    for key in ("tau_rise", "tau_decay", "beta"):
        del payload[key]

    result = _build_cadecon_result(payload, np.zeros((1, 60), dtype=np.float32), 30.0)

    assert result.kernel_slow.size == 0
    assert result.metadata["tau_decay"] is None


def test_build_cadecon_result_skipped_cells_become_nan() -> None:
    """Cells the browser skipped for NaN/Inf samples arrive as null scalars."""
    from calab._bridge._apps import _build_cadecon_result

    payload = _results(
        alphas=[1.0, None],
        baselines=[0.0, None],
        pves=[0.9, None],
        skipped_reason=[None, "non_finite_samples"],
    )
    activity = np.zeros((2, 60), dtype=np.float32)
    activity[1] = np.nan
    result = _build_cadecon_result(payload, activity, 30.0)

    assert result.alphas[0] == 1.0
    assert np.isnan(result.alphas[1])
    assert np.isnan(result.pves[1])
    assert result.metadata["skipped_reason"] == [None, "non_finite_samples"]


def test_build_biexp_waveform_returns_empty_for_non_positive_taus() -> None:
    """A non-positive time constant yields an empty array, not a NaN kernel.

    Callers derive `length` from `tau_decay`, so `tau_decay <= 0` already gives
    `length == 0` and an empty result on its own. `tau_rise <= 0` with a positive
    `tau_decay` is the gap: it divided by zero and put a NaN in the first sample,
    which then propagated into anything built on the waveform.
    """
    # The case the length coincidence did not cover.
    assert _build_biexp_waveform(0.0, 1.0, 1.0, 20.0, 100).size == 0
    assert _build_biexp_waveform(-0.05, 1.0, 1.0, 20.0, 100).size == 0
    # Already safe, kept so a future length change cannot silently reintroduce it.
    assert _build_biexp_waveform(0.05, 0.0, 1.0, 20.0, 0).size == 0
    assert _build_biexp_waveform(0.05, -1.0, 1.0, 20.0, 100).size == 0
    # A valid pair is unaffected and finite throughout.
    good = _build_biexp_waveform(0.05, 0.4, 1.0, 20.0, 40)
    assert good.size == 40
    assert np.all(np.isfinite(good))


def test_build_cadecon_result_fast_kernel_never_contains_nan() -> None:
    """The fast branch guards tau_decay_fast but not tau_rise_fast.

    A payload with tau_rise_fast = 0 and a positive tau_decay_fast passes that
    guard and reaches the waveform builder, where it used to divide by zero. The
    solver cannot produce that pair, so this covers an older or hand-edited
    results file rather than a live fit.
    """
    from calab._bridge._apps import _build_cadecon_result

    payload = _results(tau_rise_fast=0.0, tau_decay_fast=0.05, beta_fast=1.0)
    result = _build_cadecon_result(payload, np.zeros((1, 60), dtype=np.float32), 30.0)

    assert np.all(np.isfinite(result.kernel_fast))
    assert np.all(np.isfinite(result.kernel_slow))
    # The slow fit is real and unaffected.
    assert result.kernel_slow.size > 0
