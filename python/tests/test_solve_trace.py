"""Tests for InDeCa PyO3 bindings: solve_trace, estimate_kernel, fit_biexponential."""

from __future__ import annotations

import numpy as np
import pytest

from calab import (
    BiexpFitResult,
    SolveTraceResult,
    build_kernel,
    compute_upsample_factor,
    estimate_kernel,
    fit_biexponential,
    solve_trace,
)


def _make_trace(
    tau_r: float,
    tau_d: float,
    fs: float,
    n: int,
    spike_positions: list[int],
    alpha: float = 1.0,
    baseline: float = 0.0,
) -> np.ndarray:
    """Build a synthetic trace: alpha * conv(spikes, kernel) + baseline."""
    kernel = np.asarray(build_kernel(tau_r, tau_d, fs))
    trace = np.full(n, baseline, dtype=np.float64)
    for pos in spike_positions:
        for k, kv in enumerate(kernel):
            if pos + k < n:
                trace[pos + k] += alpha * float(kv)
    return trace


# ---------------------------------------------------------------------------
# solve_trace
# ---------------------------------------------------------------------------


class TestSolveTrace:
    def test_basic_output_shape(self):
        trace = _make_trace(0.02, 0.4, 30.0, 300, [20, 80, 150])
        result = solve_trace(trace, 0.02, 0.4, 30.0)
        assert isinstance(result, SolveTraceResult)
        assert result.s_counts.shape == (300,)
        assert result.alpha > 0
        assert 0 <= result.pve <= 1
        assert result.iterations > 0

    def test_detects_spikes(self):
        trace = _make_trace(0.02, 0.4, 30.0, 300, [30, 100, 200], alpha=10.0, baseline=2.0)
        result = solve_trace(trace, 0.02, 0.4, 30.0)
        # Should detect at least some spikes
        assert result.s_counts.sum() > 0

    def test_zero_trace(self):
        trace = np.zeros(100)
        result = solve_trace(trace, 0.02, 0.4, 30.0)
        assert result.s_counts.sum() < 1e-6

    def test_with_upsample(self):
        trace = _make_trace(0.02, 0.4, 30.0, 100, [20, 50])
        result = solve_trace(trace, 0.02, 0.4, 30.0, upsample_factor=4)
        # Output is downsampled back to original rate
        assert result.s_counts.shape == (100,)

    def test_with_filters(self):
        trace = _make_trace(0.02, 0.4, 30.0, 300, [30, 100, 200], alpha=10.0, baseline=2.0)
        result = solve_trace(trace, 0.02, 0.4, 30.0, hp_enabled=True, lp_enabled=True)
        assert result.s_counts.shape == (300,)

    def test_warm_start(self):
        trace = _make_trace(0.02, 0.4, 30.0, 200, [20, 80, 150])
        cold = solve_trace(trace, 0.02, 0.4, 30.0)
        warm = solve_trace(trace, 0.025, 0.45, 30.0, warm_counts=cold.s_counts)
        assert warm.iterations > 0

    def test_tuple_unpacking(self):
        trace = _make_trace(0.02, 0.4, 30.0, 200, [20, 80])
        s_counts, alpha, baseline, threshold, pve, iterations, converged = solve_trace(
            trace, 0.02, 0.4, 30.0,
        )
        assert s_counts.shape == (200,)
        assert isinstance(alpha, float)
        assert isinstance(converged, bool)


# ---------------------------------------------------------------------------
# estimate_kernel
# ---------------------------------------------------------------------------


class TestEstimateKernel:
    def test_basic_output_shape(self):
        kernel = estimate_kernel(
            traces_flat=np.ones(100, dtype=np.float64),
            spikes_flat=np.zeros(100, dtype=np.float64),
            trace_lengths=np.array([100], dtype=np.int64),
            alphas=np.array([1.0]),
            baselines=np.array([0.0]),
            kernel_length=20,
        )
        assert kernel.shape == (20,)

    def test_recovers_kernel_shape(self):
        """Use known spikes convolved with known kernel, verify correlation."""
        k_len = 30
        fs = 30.0
        true_kernel = np.asarray(build_kernel(0.02, 0.4, fs), dtype=np.float64)[:k_len]

        trace_len = 300
        spikes = np.zeros(trace_len, dtype=np.float64)
        spike_pos = [10, 60, 130, 200]
        for p in spike_pos:
            spikes[p] = 1.0

        alpha = 5.0
        trace = np.zeros(trace_len, dtype=np.float64)
        for p in spike_pos:
            for k in range(min(k_len, trace_len - p)):
                trace[p + k] += alpha * true_kernel[k]

        est = estimate_kernel(
            traces_flat=trace,
            spikes_flat=spikes,
            trace_lengths=np.array([trace_len], dtype=np.int64),
            alphas=np.array([alpha]),
            baselines=np.array([0.0]),
            kernel_length=k_len,
        )
        assert est.shape == (k_len,)
        # Normalize and check correlation
        est_norm = est / max(est.max(), 1e-10)
        true_norm = true_kernel / true_kernel.max()
        corr = float(
            np.dot(est_norm, true_norm)
            / (np.linalg.norm(est_norm) * np.linalg.norm(true_norm) + 1e-20)
        )
        assert corr > 0.7, f"Kernel correlation too low: {corr}"


# ---------------------------------------------------------------------------
# fit_biexponential
# ---------------------------------------------------------------------------


class TestFitBiexponential:
    def test_basic(self):
        fs = 30.0
        k_len = 50
        t = np.arange(k_len) / fs
        h = np.exp(-t / 0.4) - np.exp(-t / 0.02)
        result = fit_biexponential(h, fs)
        assert isinstance(result, BiexpFitResult)
        assert result.tau_rise > 0
        assert result.tau_decay > result.tau_rise
        assert result.beta > 0

    def test_recovers_known_taus(self):
        fs = 30.0
        k_len = 80
        t = np.arange(k_len) / fs
        h = np.exp(-t / 0.5) - np.exp(-t / 0.03)
        result = fit_biexponential(h, fs)
        # Should be in the right ballpark
        assert 0.01 < result.tau_rise < 0.1
        assert 0.2 < result.tau_decay < 1.0

    def test_warm_start(self):
        fs = 30.0
        k_len = 50
        t = np.arange(k_len) / fs
        h = np.exp(-t / 0.4) - np.exp(-t / 0.02)
        cold = fit_biexponential(h, fs)
        warm = fit_biexponential(h, fs, warm=cold)
        # Warm result should be at least as good
        assert warm.residual <= cold.residual * 1.01 + 1e-10

    def test_tuple_unpacking(self):
        fs = 30.0
        t = np.arange(50) / fs
        h = np.exp(-t / 0.4) - np.exp(-t / 0.02)
        tau_r, tau_d, beta, residual, tau_rf, tau_df, beta_f = fit_biexponential(h, fs)
        assert isinstance(tau_r, float)
        assert isinstance(residual, float)


# ---------------------------------------------------------------------------
# compute_upsample_factor
# ---------------------------------------------------------------------------


class TestComputeUpsampleFactor:
    def test_identity(self):
        assert compute_upsample_factor(30.0, 30.0) == 1

    def test_10x(self):
        assert compute_upsample_factor(30.0, 300.0) == 10

    def test_minimum_1(self):
        assert compute_upsample_factor(100.0, 30.0) == 1
