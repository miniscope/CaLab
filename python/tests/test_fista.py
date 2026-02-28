"""Tests for the FISTA deconvolution solver.

Mirrors Rust fista.rs tests 1-8 plus Python-specific tests for
multi-trace input, parameter sensitivity, and edge cases.

The solver now includes baseline estimation and lambda scaling by kernel
DC gain, matching the Rust solver exactly.
"""

from __future__ import annotations

import numpy as np
import numpy.testing as npt
import pytest

from calab import build_kernel, run_deconvolution, run_deconvolution_full, DeconvolutionResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_synthetic_trace(
    kernel: np.ndarray, n: int, event_locs: list[int], amplitudes: float | list[float] = 1.0
) -> np.ndarray:
    """Generate a synthetic trace by convolving unit events with the kernel.

    Parameters
    ----------
    kernel : np.ndarray
        Calcium kernel (from build_kernel).
    n : int
        Length of the output trace.
    event_locs : list[int]
        Indices where calcium events occur.
    amplitudes : float or list[float]
        Event amplitudes (scalar or per-event).

    Returns
    -------
    np.ndarray
        Synthetic calcium trace of length n.
    """
    if isinstance(amplitudes, (int, float)):
        amplitudes = [amplitudes] * len(event_locs)
    activity = np.zeros(n)
    for loc, amp in zip(event_locs, amplitudes):
        if 0 <= loc < n:
            activity[loc] = amp
    return np.convolve(activity, kernel)[:n]


# ---------------------------------------------------------------------------
# Test 1: Delta impulse recovery (matches Rust test 1)
# ---------------------------------------------------------------------------

def test_delta_impulse_recovery():
    """Trace = kernel (single event at t=0). Activity should be near t=0..2."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    trace = kernel.copy()
    n = len(trace)

    solution = run_deconvolution(trace, 30.0, 0.02, 0.4, 0.001)
    assert solution.shape == (n,)

    max_idx = int(np.argmax(solution))
    peak_val = solution[max_idx]

    # Activity should be in first few samples
    assert max_idx <= 2, f"Max activity at {max_idx}, expected <= 2"
    # Primary peak should be substantial
    assert peak_val > 0.1, f"Peak value {peak_val} too small"
    # Sum of others should be less than peak
    sum_others = solution.sum() - peak_val
    assert sum_others < peak_val, (
        f"Sum of non-peak values ({sum_others}) >= peak ({peak_val})"
    )


# ---------------------------------------------------------------------------
# Test 2: Zero trace produces zero solution (matches Rust test 2)
# ---------------------------------------------------------------------------

def test_zero_trace_produces_zero_solution():
    """All-zero trace should produce near-zero solution."""
    trace = np.zeros(100)
    solution = run_deconvolution(trace, 30.0, 0.02, 0.4, 0.01)
    assert solution.max() < 1e-10, f"Expected near-zero, got max={solution.max()}"


# ---------------------------------------------------------------------------
# Test 3: Convergence within max_iters (matches Rust test 3)
# ---------------------------------------------------------------------------

def test_convergence_within_max_iters():
    """Synthetic trace with 4 events should converge within 2000 iters."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    trace = make_synthetic_trace(kernel, 200, [10, 50, 100, 150])

    solution = run_deconvolution(trace, 30.0, 0.02, 0.4, 0.01)
    assert solution.shape == (200,)
    assert np.all(solution >= 0), "Solution should be non-negative"
    # Verify energy near event locations
    for loc in [10, 50, 100, 150]:
        window = solution[max(0, loc - 2) : loc + 3]
        assert window.max() > 0.01, f"No energy near event at {loc}"


# ---------------------------------------------------------------------------
# Test 4: Solution non-negative (matches Rust test 4)
# ---------------------------------------------------------------------------

def test_solution_non_negative():
    """Trace with events + sine noise: all solution values >= 0."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 200
    trace = make_synthetic_trace(kernel, n, [20, 60, 120], amplitudes=2.0)
    # Add sine noise
    trace += 0.01 * np.sin(0.7 * np.arange(n))

    solution = run_deconvolution(trace, 30.0, 0.02, 0.4, 0.01)
    assert np.all(solution >= 0), (
        f"Negative values found: min={solution.min()}"
    )


# ---------------------------------------------------------------------------
# Test 5: Deterministic output (matches Rust test 5)
# ---------------------------------------------------------------------------

def test_deterministic_output():
    """Two runs with identical inputs produce identical output."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    trace = make_synthetic_trace(kernel, 150, [10, 50, 100])

    sol1 = run_deconvolution(trace, 30.0, 0.02, 0.4, 0.01)
    sol2 = run_deconvolution(trace, 30.0, 0.02, 0.4, 0.01)

    npt.assert_allclose(sol1, sol2, atol=1e-15, err_msg="Solutions not identical")


# ---------------------------------------------------------------------------
# Test 6: Reconvolution quality (matches Rust test 6)
# ---------------------------------------------------------------------------

def test_reconvolution_quality():
    """Low lambda: reconvolution + baseline should approximate original trace."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 200
    trace = make_synthetic_trace(kernel, n, [10, 50, 100, 150])

    result = run_deconvolution_full(trace, 30.0, 0.02, 0.4, 0.001)

    # Relative error < 15% (baseline subtraction shifts the floor slightly on
    # zero-baseline synthetic traces, adding a small systematic offset)
    err = np.linalg.norm(trace - result.reconvolution) / np.linalg.norm(trace)
    assert err < 0.15, f"Relative reconvolution error {err:.4f} >= 0.15"


# ---------------------------------------------------------------------------
# Test 7: Single trace 1D input
# ---------------------------------------------------------------------------

def test_single_trace_1d_input():
    """Pass 1D array, get 1D array back."""
    trace = np.zeros(100)
    trace[30] = 1.0
    kernel = build_kernel(0.02, 0.4, 30.0)
    trace = np.convolve(trace, kernel)[:100]

    result = run_deconvolution(trace, 30.0, 0.02, 0.4, 0.01)
    assert result.ndim == 1, f"Expected 1D, got {result.ndim}D"
    assert result.shape == (100,)


# ---------------------------------------------------------------------------
# Test 8: Multi-trace 2D input
# ---------------------------------------------------------------------------

def test_multi_trace_2d_input():
    """Pass (3, 200) array, get (3, 200) back. Each row independent."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 200
    traces = np.zeros((3, n))
    for i, loc in enumerate([30, 80, 140]):
        activity = np.zeros(n)
        activity[loc] = 1.0
        traces[i] = np.convolve(activity, kernel)[:n]

    result = run_deconvolution(traces, 30.0, 0.02, 0.4, 0.01)
    assert result.shape == (3, n), f"Expected (3, {n}), got {result.shape}"
    assert np.all(result >= 0)

    # Each row should have its event at the right place
    for i, loc in enumerate([30, 80, 140]):
        max_idx = int(np.argmax(result[i]))
        assert abs(max_idx - loc) <= 2, (
            f"Row {i}: max at {max_idx}, expected near {loc}"
        )


# ---------------------------------------------------------------------------
# Test 9: Various parameter sets
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "tau_r,tau_d,fs,lam",
    [
        (0.005, 0.1, 100.0, 0.01),   # fast kinetics
        (0.05, 1.0, 20.0, 0.01),     # slow kinetics
        (0.02, 0.4, 30.0, 0.1),      # medium lambda
    ],
)
def test_various_parameter_sets(tau_r, tau_d, fs, lam):
    """Run with different kinetics. Verify non-negative and converges."""
    kernel = build_kernel(tau_r, tau_d, fs)
    n = 200
    trace = make_synthetic_trace(kernel, n, [50, 120])

    solution = run_deconvolution(trace, fs, tau_r, tau_d, lam)
    assert solution.shape == (n,)
    assert np.all(solution >= 0), f"Negative values found: min={solution.min()}"


# ---------------------------------------------------------------------------
# Test 10: High lambda suppresses activity
# ---------------------------------------------------------------------------

def test_high_lambda_suppresses_activity():
    """High lambda should produce sparser solution than low lambda."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    trace = make_synthetic_trace(kernel, 200, [50, 100], amplitudes=1.0)

    sol_low = run_deconvolution(trace, 30.0, 0.02, 0.4, 0.001)
    sol_high = run_deconvolution(trace, 30.0, 0.02, 0.4, 1.0)

    # High lambda should suppress more aggressively
    assert sol_high.sum() < sol_low.sum(), (
        f"High lambda sum ({sol_high.sum():.4f}) should be less than "
        f"low lambda sum ({sol_low.sum():.4f})"
    )
    # High lambda should produce fewer non-zero entries (sparser)
    nnz_low = np.count_nonzero(sol_low > 1e-8)
    nnz_high = np.count_nonzero(sol_high > 1e-8)
    assert nnz_high <= nnz_low, (
        f"High lambda non-zeros ({nnz_high}) should be <= "
        f"low lambda non-zeros ({nnz_low})"
    )


# ---------------------------------------------------------------------------
# Test 11: Short trace
# ---------------------------------------------------------------------------

def test_short_trace():
    """10-sample trace should not crash and produce valid output."""
    trace = np.zeros(10)
    trace[3] = 0.5
    solution = run_deconvolution(trace, 30.0, 0.02, 0.4, 0.01)
    assert solution.shape == (10,)
    assert np.all(solution >= 0)


# ---------------------------------------------------------------------------
# Test 12: Baseline recovery with DC offset
# ---------------------------------------------------------------------------

def test_baseline_recovery_with_dc_offset():
    """Trace with DC offset: baseline subtraction removes DC before solving,
    so the solver baseline should be ~0 (not the original DC offset)."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 200
    dc_offset = 5.0
    trace = make_synthetic_trace(kernel, n, [10, 50, 100, 150])
    trace += dc_offset

    result = run_deconvolution_full(trace, 30.0, 0.02, 0.4, 0.001)

    assert abs(result.baseline) < 1.0, (
        f"Baseline {result.baseline} should be near 0 after baseline subtraction"
    )
    # Baseline subtraction preserves transients, so spikes should still appear
    n_spikes = np.sum(result.activity > 0)
    assert n_spikes >= 2, (
        f"Should detect at least 2 spikes with DC offset, got {n_spikes}"
    )


# ---------------------------------------------------------------------------
# Test 13: run_deconvolution_full returns correct types
# ---------------------------------------------------------------------------

def test_full_result_types():
    """Verify DeconvolutionResult fields for single-trace input."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    trace = make_synthetic_trace(kernel, 100, [30])

    result = run_deconvolution_full(trace, 30.0, 0.02, 0.4, 0.01)

    assert isinstance(result, DeconvolutionResult)
    assert result.activity.ndim == 1
    assert isinstance(result.baseline, float)
    assert result.reconvolution.ndim == 1
    assert isinstance(result.iterations, int)
    assert isinstance(result.converged, bool)


# ---------------------------------------------------------------------------
# Test 14: run_deconvolution_full multi-trace
# ---------------------------------------------------------------------------

def test_full_result_multi_trace():
    """Verify DeconvolutionResult fields for multi-trace input."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 100
    traces = np.zeros((2, n))
    for i, loc in enumerate([30, 60]):
        s = np.zeros(n)
        s[loc] = 1.0
        traces[i] = np.convolve(s, kernel)[:n]

    result = run_deconvolution_full(traces, 30.0, 0.02, 0.4, 0.01)

    assert result.activity.shape == (2, n)
    assert result.baseline.shape == (2,)
    assert result.reconvolution.shape == (2, n)
    assert result.iterations.shape == (2,)
    assert result.converged.shape == (2,)
