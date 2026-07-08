"""Input-validation tests for the FFI boundary.

Non-finite (NaN / infinity) trace values must be rejected with a clear error
rather than silently propagating into the solver and returning garbage results.
"""

from __future__ import annotations

import numpy as np
import pytest

from calab import run_deconvolution

PARAMS = dict(fs=30.0, tau_r=0.02, tau_d=0.4, lam=0.01)


def test_run_deconvolution_rejects_nan():
    trace = np.array([0.0, 1.0, np.nan, 2.0], dtype=np.float64)
    with pytest.raises(ValueError, match="non-finite"):
        run_deconvolution(trace, **PARAMS)


def test_run_deconvolution_rejects_inf():
    trace = np.array([0.0, np.inf, 2.0], dtype=np.float64)
    with pytest.raises(ValueError, match="non-finite"):
        run_deconvolution(trace, **PARAMS)


def test_run_deconvolution_rejects_nan_in_batch():
    traces = np.zeros((3, 100), dtype=np.float64)
    traces[1, 40] = np.nan
    with pytest.raises(ValueError, match="non-finite"):
        run_deconvolution(traces, **PARAMS)


def test_run_deconvolution_accepts_finite():
    trace = np.zeros(200, dtype=np.float64)
    trace[50] = 1.0
    out = run_deconvolution(trace, **PARAMS)
    assert out.shape == trace.shape
    assert np.all(np.isfinite(out))


def test_seed_kernel_estimate_rejects_nan():
    # The 2D auto-estimate path builds its flat buffer inline (not via the
    # shared 1D converter), so it needs its own guard.
    import calab._solver as _solver

    traces = np.zeros((2, 100), dtype=np.float64)
    traces[0, 30] = np.inf
    with pytest.raises(ValueError, match="non-finite"):
        _solver.seed_kernel_estimate(traces, 30.0)


def test_pysolver_set_trace_rejects_nan():
    import calab._solver as _solver

    solver = _solver.PySolver()
    trace = np.array([0.0, 1.0, np.nan], dtype=np.float32)
    with pytest.raises(ValueError, match="non-finite"):
        solver.set_trace(trace)
