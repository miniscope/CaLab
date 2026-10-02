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


# ---------------------------------------------------------------------------
# Degenerate inputs: parameters, lengths, solver state. These mirror the Rust
# `degenerate_tests` module; both bindings share one validation layer
# (crates/solver/src/validate.rs) so they reject the same inputs.
# ---------------------------------------------------------------------------

import calab._solver as _solver  # noqa: E402


@pytest.mark.parametrize(
    "tau_r, tau_d, lam, fs",
    [
        (0.4, 0.02, 0.01, 30.0),  # reversed taus
        (0.4, 0.4, 0.01, 30.0),  # equal taus
        (0.0, 0.4, 0.01, 30.0),  # zero tau_rise
        (0.02, 0.4, 0.01, 0.0),  # fs = 0
        (0.02, 0.4, 0.01, -30.0),  # fs < 0
        (0.02, 0.4, -0.1, 30.0),  # negative lambda
        (0.02, float("nan"), 0.01, 30.0),
        (0.02, 0.4, 0.01, float("inf")),
        (0.02, 1e12, 0.01, 30.0),  # kernel would abort on allocation
    ],
)
def test_invalid_params_rejected_everywhere(tau_r, tau_d, lam, fs):
    with pytest.raises(ValueError, match="invalid parameter"):
        _solver.PySolver().set_params(tau_r, tau_d, lam, fs)
    with pytest.raises(ValueError, match="invalid parameter"):
        run_deconvolution(np.zeros(100), fs=fs, tau_r=tau_r, tau_d=tau_d, lam=lam)
    if lam >= 0:
        with pytest.raises(ValueError, match="invalid parameter"):
            _solver.py_build_kernel(tau_r, tau_d, fs)


@pytest.mark.parametrize("trace", [np.zeros(0), np.ones(1), np.full(64, 3.0)])
def test_degenerate_traces_do_not_crash(trace):
    out = run_deconvolution(trace, **PARAMS)
    assert out.shape == trace.shape
    assert np.all(np.isfinite(out))


def test_pysolver_longer_kernel_after_set_trace():
    # Used to panic: "slice index starts at 100 but ends at 0".
    solver = _solver.PySolver()
    solver.set_params(0.02, 0.4, 0.01, 30.0)
    solver.set_trace(np.zeros(100, dtype=np.float32))
    solver.set_params(0.02, 4.0, 0.01, 30.0)
    solver.solve(200)
    assert np.all(np.isfinite(solver.get_solution()))


def test_filter_toggle_after_apply_takes_effect():
    rng = np.random.default_rng(0)
    trace = rng.standard_normal(512).astype(np.float32)

    def filtered(hp_then_both: bool) -> np.ndarray:
        s = _solver.PySolver()
        s.set_params(0.02, 0.4, 0.01, 30.0)
        s.set_hp_filter_enabled(True)
        s.set_lp_filter_enabled(not hp_then_both)
        if hp_then_both:
            s.set_trace(trace)
            assert s.apply_filter()
            s.set_lp_filter_enabled(True)
        s.set_trace(trace)
        assert s.apply_filter()
        return s.get_trace()

    np.testing.assert_array_equal(filtered(True), filtered(False))


def test_indeca_solve_trace_rejects_upsample_zero_and_bad_params():
    trace = np.zeros(100)
    with pytest.raises(ValueError, match="upsample_factor"):
        _solver.py_indeca_solve_trace(trace, 0.02, 0.4, 30.0, upsample_factor=0)
    with pytest.raises(ValueError, match="fs"):
        _solver.py_indeca_solve_trace(trace, 0.02, 0.4, 0.0)
    with pytest.raises(ValueError, match="tau_rise"):
        _solver.py_indeca_solve_trace(trace, 0.4, 0.02, 30.0)


def test_compute_upsample_factor_rejects_zero_fs():
    with pytest.raises(ValueError, match="fs"):
        _solver.py_indeca_compute_upsample_factor(0.0, 300.0)
    assert _solver.py_indeca_compute_upsample_factor(30.0, 300.0) == 10


def _kernel_inputs(lengths=(50, 50)):
    total = int(sum(max(v, 0) for v in lengths))
    return dict(
        traces_flat=np.zeros(total),
        spikes_flat=np.zeros(total),
        trace_lengths=np.asarray(lengths, dtype=np.int64),
        alphas=np.ones(len(lengths)),
        baselines=np.zeros(len(lengths)),
        kernel_length=20,
    )


def test_estimate_kernel_rejects_negative_lengths():
    # -1 used to wrap to usize::MAX, pass the sum check, then panic indexing.
    kw = _kernel_inputs()
    kw["trace_lengths"] = np.array([101, -1], dtype=np.int64)
    with pytest.raises(ValueError, match="trace_lengths"):
        _solver.py_indeca_estimate_kernel(**kw)


@pytest.mark.parametrize("field", ["alphas", "baselines"])
def test_estimate_kernel_rejects_nonfinite_alphas_baselines(field):
    kw = _kernel_inputs()
    kw[field] = np.array([1.0, np.nan])
    with pytest.raises(ValueError, match=field):
        _solver.py_indeca_estimate_kernel(**kw)


def test_estimate_kernel_rejects_zero_kernel_length():
    kw = _kernel_inputs()
    kw["kernel_length"] = 0
    with pytest.raises(ValueError, match="kernel_length"):
        _solver.py_indeca_estimate_kernel(**kw)


def test_fit_biexponential_rejects_bad_inputs():
    h = np.linspace(0, 1, 30)
    with pytest.raises(ValueError, match="fs"):
        _solver.py_indeca_fit_biexponential(h, 0.0)
    with pytest.raises(ValueError, match="warm_tau_rise"):
        _solver.py_indeca_fit_biexponential(
            h, 30.0, warm_tau_rise=float("nan"), use_warm=True
        )
