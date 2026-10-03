"""Degenerate inputs across the whole ``calab._solver`` (PyO3) surface.

Contract: every function either works on a degenerate-but-legal input
(finite output of the right shape) or raises ``ValueError`` -- never a Rust
panic (``pyo3_runtime.PanicException``), a segfault/abort, or a hang.
Wrong-*type* arguments (e.g. a float64 array where float32 is required) raise
``TypeError`` from PyO3's argument conversion; that is pinned down too.

``test_input_validation.py`` holds the original regression cases; this file
is the systematic per-function sweep. The Rust side has the matching tests in
``crates/solver/tests/solver_degenerate.rs`` and
``crates/solver/src/degenerate_tests/ffi_surface.rs``.

Known gaps are ``xfail(strict=True)``: they fail today, and the strict flag
makes them fail loudly once fixed so the marker gets removed.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
import textwrap

import numpy as np
import pytest

import calab._solver as _solver

NAN = float("nan")
INF = float("inf")
TAU_R, TAU_D, LAM, FS = 0.02, 0.4, 0.01, 30.0
MAX_KERNEL_LEN = 1 << 20
KERNEL_TAIL = -math.log(1e-6)  # kernel length = ceil(KERNEL_TAIL * tau_decay * fs)


def test_surface_inventory_is_covered():
    """A new export must be added to this sweep before it ships."""
    exported = {n for n in dir(_solver) if not n.startswith("_")}
    assert exported == {
        "PySolver",
        "deconvolve_batch",
        "deconvolve_single",
        "py_build_kernel",
        "py_compute_lipschitz",
        "py_indeca_compute_upsample_factor",
        "py_indeca_estimate_kernel",
        "py_indeca_fit_biexponential",
        "py_indeca_solve_trace",
        "py_seed_trace",
        "py_simulate_traces",
        "seed_kernel_estimate",
    }


def spiky(n: int = 200) -> np.ndarray:
    t = np.arange(n) / FS
    trace = np.full(n, 0.2)
    for onset in (n // 5, n // 2, 4 * n // 5):
        dt = t[onset:] - t[onset]
        trace[onset:] += np.exp(-dt / TAU_D) - np.exp(-dt / TAU_R)
    return trace


def finite(*arrays) -> bool:
    return all(np.all(np.isfinite(np.asarray(a, dtype=np.float64))) for a in arrays)


# (tau_rise, tau_decay, lambda, fs) -- each must raise ValueError everywhere.
BAD_PARAMS = [
    pytest.param(0.4, 0.02, LAM, FS, id="reversed-taus"),
    pytest.param(0.4, 0.4, LAM, FS, id="equal-taus"),
    pytest.param(0.0, TAU_D, LAM, FS, id="tau_rise-0"),
    pytest.param(TAU_R, 0.0, LAM, FS, id="tau_decay-0"),
    pytest.param(-0.02, TAU_D, LAM, FS, id="tau_rise-negative"),
    pytest.param(TAU_R, -0.4, LAM, FS, id="tau_decay-negative"),
    pytest.param(-0.4, -0.02, LAM, FS, id="both-negative"),
    pytest.param(NAN, TAU_D, LAM, FS, id="tau_rise-nan"),
    pytest.param(TAU_R, INF, LAM, FS, id="tau_decay-inf"),
    pytest.param(TAU_R, TAU_D, LAM, 0.0, id="fs-0"),
    pytest.param(TAU_R, TAU_D, LAM, -FS, id="fs-negative"),
    pytest.param(TAU_R, TAU_D, LAM, NAN, id="fs-nan"),
    pytest.param(TAU_R, TAU_D, LAM, INF, id="fs-inf"),
    pytest.param(TAU_R, TAU_D, -1e-9, FS, id="lambda-negative"),
    pytest.param(TAU_R, TAU_D, NAN, FS, id="lambda-nan"),
    pytest.param(TAU_R, TAU_D, INF, FS, id="lambda-inf"),
    pytest.param(20.0, 400.0, LAM, 30_000.0, id="kernel-over-cap-ms-units"),
    pytest.param(TAU_R, 1e300, LAM, 1e300, id="kernel-length-overflows"),
]

# Traces with a non-finite sample, and where it is.
NONFINITE_TRACES = [
    pytest.param(np.full(20, NAN), 0, id="all-nan"),
    pytest.param(np.array([NAN]), 0, id="single-nan"),
    pytest.param(np.r_[np.ones(10), NAN, np.ones(5)], 10, id="one-nan-mid"),
    pytest.param(np.r_[np.ones(10), INF], 10, id="inf-last"),
    pytest.param(np.r_[-INF, np.ones(10)], 0, id="neg-inf-first"),
]

# Degenerate traces every trace-taking function must accept.
DEGENERATE_TRACES = [
    pytest.param(np.zeros(0), id="empty"),
    pytest.param(np.ones(1), id="single-sample"),
    pytest.param(np.array([0.0, 1.0]), id="two-samples"),
    pytest.param(np.full(200, 2.5), id="constant"),
    pytest.param(np.zeros(200), id="zeros"),
    pytest.param(np.full(64, 1e30), id="huge-finite"),
]


# ---------------------------------------------------------------------------
# PySolver
# ---------------------------------------------------------------------------


def make_solver(mode: str = "fft") -> _solver.PySolver:
    s = _solver.PySolver()
    s.set_conv_mode(mode)
    s.set_params(TAU_R, TAU_D, LAM, FS)
    return s


def observe(s: _solver.PySolver) -> tuple:
    return (
        s.get_solution().tobytes(),
        s.get_reconvolution().tobytes(),
        s.get_reconvolution_with_baseline().tobytes(),
        s.get_baseline(),
        s.get_trace().tobytes(),
        s.get_kernel().tobytes(),
        s.iteration_count(),
        s.converged(),
    )


@pytest.mark.parametrize("mode", ["fft", "banded"])
@pytest.mark.parametrize("tr, td, lam, fs", BAD_PARAMS)
def test_pysolver_rejects_bad_params_without_changing_state(mode, tr, td, lam, fs):
    s = make_solver(mode)
    s.set_trace(spiky().astype(np.float32))
    s.step_batch(3)
    before = observe(s)
    with pytest.raises(ValueError, match="invalid parameter"):
        s.set_params(tr, td, lam, fs)
    assert observe(s) == before


@pytest.mark.parametrize("trace, idx", NONFINITE_TRACES)
def test_pysolver_rejects_non_finite_trace_without_changing_state(trace, idx):
    s = make_solver()
    s.set_trace(spiky().astype(np.float32))
    before = observe(s)
    with pytest.raises(ValueError, match=f"non-finite.*index {idx}"):
        s.set_trace(trace.astype(np.float32))
    assert observe(s) == before


@pytest.mark.parametrize("mode", ["fft", "banded"])
@pytest.mark.parametrize("trace", DEGENERATE_TRACES)
def test_pysolver_degenerate_traces(mode, trace):
    for filtered in (False, True):
        s = make_solver(mode)
        s.set_filter_enabled(filtered)
        s.set_trace(trace.astype(np.float32))
        if filtered:
            s.apply_filter()
        s.subtract_baseline()
        s.solve(500)
        sol = s.get_solution()
        assert sol.shape == trace.shape
        if np.all(np.abs(trace) < 1e20):
            assert finite(sol, s.get_reconvolution_with_baseline(), s.get_baseline())


def test_pysolver_getters_before_any_trace_or_solve():
    s = _solver.PySolver()
    assert s.get_solution().size == 0
    assert s.get_reconvolution().size == 0
    assert s.get_reconvolution_with_baseline().size == 0
    assert s.get_trace().size == 0
    assert s.get_baseline() == 0.0
    k = s.get_kernel()
    assert k.size > 0 and finite(k)
    assert not s.converged()
    assert s.iteration_count() == 0
    assert s.apply_filter() is False
    s.subtract_baseline()  # no-op, no crash
    assert s.step_batch(5) is True
    assert s.solve(0) == 0


def test_pysolver_getters_after_set_trace_before_solve():
    s = make_solver()
    trace = spiky(120).astype(np.float32)
    s.set_trace(trace)
    np.testing.assert_array_equal(s.get_solution(), np.zeros(120, np.float32))
    np.testing.assert_array_equal(s.get_trace(), trace)
    assert s.get_baseline() == pytest.approx(float(trace.mean()), abs=1e-5)
    assert s.iteration_count() == 0


@pytest.mark.parametrize("mode", ["fft", "banded"])
@pytest.mark.parametrize("constraint", ["nonneg", "box01"])
def test_display_getters_are_idempotent_and_side_effect_free(mode, constraint):
    """Regression for review bug 1.2 (fixed in #187): polling a display getter
    used to write the solver's baseline and change the optimisation."""
    trace = (spiky(300) + 3.0).astype(np.float32)

    def build():
        s = make_solver(mode)
        s.set_constraint(constraint)
        s.set_trace(trace)
        return s

    polled, quiet = build(), build()
    for _ in range(40):
        first = observe(polled)
        assert observe(polled) == first, "second round of getters changed the result"
        a, b = polled.step_batch(5), quiet.step_batch(5)
        assert a == b
        if a:
            break
    # The optimisation state must be bit-identical. (Only the display-only
    # baseline EMA -- get_baseline / get_reconvolution_with_baseline -- may
    # differ: polling folds extra samples into that smoother by design.)
    for getter in ("get_solution", "get_trace", "get_kernel", "iteration_count", "converged"):
        a, b = getattr(polled, getter)(), getattr(quiet, getter)()
        assert np.array_equal(a, b), getter
    np.testing.assert_array_equal(polled.get_reconvolution(), quiet.get_reconvolution())


@pytest.mark.parametrize("mode", ["fft", "banded"])
@pytest.mark.parametrize(
    "new_params",
    [
        (TAU_R, 3.0, LAM, FS),
        (0.01, 0.1, LAM, FS),
        (TAU_R, TAU_D, 0.5, FS),
        (TAU_R, TAU_D, LAM, 100.0),
    ],
    ids=["longer-kernel", "shorter-kernel", "lambda-only", "fs-only"],
)
def test_pysolver_param_change_after_set_trace_matches_fresh(mode, new_params):
    trace = spiky(400).astype(np.float32)
    late = make_solver(mode)
    late.set_trace(trace)
    late.set_params(*new_params)
    late.solve(2000)

    early = make_solver(mode)
    early.set_params(*new_params)
    early.set_trace(trace)
    early.solve(2000)

    np.testing.assert_array_equal(late.get_kernel(), early.get_kernel())
    assert late.iteration_count() == early.iteration_count()
    # FFT mode reuses larger padded buffers when the kernel shrinks, so allow
    # f32 rounding differences (see solver_degenerate.rs).
    np.testing.assert_allclose(late.get_solution(), early.get_solution(), atol=1e-5, rtol=1e-5)


def test_pysolver_bad_strings_and_types():
    s = _solver.PySolver()
    for bad in ["", "FFT", "fourier"]:
        with pytest.raises(ValueError, match="conv_mode"):
            s.set_conv_mode(bad)
    with pytest.raises(ValueError, match="constraint"):
        s.set_constraint("box")
    with pytest.raises(ValueError, match="C-contiguous"):
        s.set_trace(np.ones(20, np.float32)[::2])
    # set_trace takes float32 only; PyO3 refuses other dtypes with TypeError.
    with pytest.raises(TypeError):
        s.set_trace(np.ones(10, np.float64))
    with pytest.raises(TypeError):
        s.set_trace(np.ones((2, 5), np.float32))


# ---------------------------------------------------------------------------
# deconvolve_single / deconvolve_batch
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("tr, td, lam, fs", BAD_PARAMS)
def test_deconvolve_rejects_bad_params(tr, td, lam, fs):
    with pytest.raises(ValueError, match="invalid parameter"):
        _solver.deconvolve_single(np.ones(50), fs, tr, td, lam)
    with pytest.raises(ValueError, match="invalid parameter"):
        _solver.deconvolve_batch(np.ones((2, 50)), fs, tr, td, lam)


@pytest.mark.parametrize("trace, idx", NONFINITE_TRACES)
def test_deconvolve_rejects_non_finite(trace, idx):
    with pytest.raises(ValueError, match=f"non-finite.*index {idx}"):
        _solver.deconvolve_single(trace, FS, TAU_R, TAU_D, LAM)
    batch = np.ones((3, trace.size))
    batch[2] = trace
    with pytest.raises(ValueError, match=f"non-finite.*row 2, index {idx}"):
        _solver.deconvolve_batch(batch, FS, TAU_R, TAU_D, LAM)


@pytest.mark.parametrize("trace", DEGENERATE_TRACES)
@pytest.mark.parametrize("mode", ["fft", "banded"])
def test_deconvolve_single_degenerate_traces(trace, mode):
    for hp, lp in [(False, False), (True, True)]:
        act, baseline, recon, iters, _conv = _solver.deconvolve_single(
            trace, FS, TAU_R, TAU_D, LAM, hp_enabled=hp, lp_enabled=lp, conv_mode=mode
        )
        assert act.shape == trace.shape and recon.shape == trace.shape
        assert iters >= 0
        if np.all(np.abs(trace) < 1e20):
            assert finite(act, recon, baseline)


@pytest.mark.parametrize("shape", [(0, 10), (3, 0), (1, 1), (2, 2)])
def test_deconvolve_batch_degenerate_shapes(shape):
    acts, baselines, recons, iters, convs = _solver.deconvolve_batch(
        np.ones(shape), FS, TAU_R, TAU_D, LAM
    )
    assert len(acts) == len(baselines) == len(recons) == len(iters) == len(convs) == shape[0]
    for a, r in zip(acts, recons, strict=True):
        assert a.shape == (shape[1],) and r.shape == (shape[1],)
        assert finite(a, r)
    assert finite(baselines)


def test_deconvolve_zero_max_iters_and_bad_strings():
    act, _, _, iters, conv = _solver.deconvolve_single(
        np.ones(40), FS, TAU_R, TAU_D, LAM, max_iters=0
    )
    assert iters == 0 and not conv and np.all(act == 0)
    with pytest.raises(ValueError, match="conv_mode"):
        _solver.deconvolve_single(np.ones(40), FS, TAU_R, TAU_D, LAM, conv_mode="x")
    with pytest.raises(ValueError, match="constraint"):
        _solver.deconvolve_batch(np.ones((1, 40)), FS, TAU_R, TAU_D, LAM, constraint="x")
    with pytest.raises(ValueError, match="C-contiguous"):
        _solver.deconvolve_single(np.ones(80)[::2], FS, TAU_R, TAU_D, LAM)


# ---------------------------------------------------------------------------
# py_build_kernel / py_compute_lipschitz
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("tr, td, lam, fs", [p for p in BAD_PARAMS if "lambda" not in str(p.id)])
def test_build_kernel_rejects_bad_params(tr, td, lam, fs):
    with pytest.raises(ValueError, match="invalid parameter"):
        _solver.py_build_kernel(tr, td, fs)


def test_build_kernel_cap_boundary():
    at_cap = (MAX_KERNEL_LEN - 0.5) / KERNEL_TAIL
    over_cap = (MAX_KERNEL_LEN + 0.5) / KERNEL_TAIL
    k = _solver.py_build_kernel(1.0, at_cap, 1.0)
    assert k.size == MAX_KERNEL_LEN and finite(k)
    with pytest.raises(ValueError, match="kernel"):
        _solver.py_build_kernel(1.0, over_cap, 1.0)


def test_compute_lipschitz_finite_kernels():
    k = _solver.py_build_kernel(TAU_R, TAU_D, FS)
    assert _solver.py_compute_lipschitz(k) == pytest.approx(float(k.sum()) ** 2, rel=1e-4)
    assert math.isfinite(_solver.py_compute_lipschitz(np.array([1.0], np.float32)))
    assert math.isfinite(_solver.py_compute_lipschitz(np.array([1.0, -2.0, 0.5], np.float32)))
    with pytest.raises(ValueError, match="C-contiguous"):
        _solver.py_compute_lipschitz(np.ones(8, np.float32)[::2])


@pytest.mark.xfail(
    strict=True,
    raises=pytest.fail.Exception,
    reason="real gap: py_compute_lipschitz does not validate its kernel -- a NaN or empty "
    "kernel silently returns the 1e-10 floor and +inf returns inf. Follow-up: reject "
    "empty / non-finite kernels in py_api.rs.",
)
@pytest.mark.parametrize(
    "kernel",
    [np.zeros(0, np.float32), np.array([NAN, 1.0], np.float32), np.array([INF, 1.0], np.float32)],
    ids=["empty", "nan", "inf"],
)
def test_compute_lipschitz_rejects_degenerate_kernels(kernel):
    try:
        _solver.py_compute_lipschitz(kernel)
    except ValueError:
        return
    pytest.fail("accepted a degenerate kernel")


# ---------------------------------------------------------------------------
# py_seed_trace / seed_kernel_estimate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fs", [0.0, -1.0, NAN, INF])
def test_seed_functions_reject_bad_fs(fs):
    with pytest.raises(ValueError, match="fs"):
        _solver.py_seed_trace(spiky(), fs)
    with pytest.raises(ValueError, match="fs"):
        _solver.seed_kernel_estimate(np.ones((2, 50)), fs)


@pytest.mark.parametrize("trace, idx", NONFINITE_TRACES)
def test_seed_functions_reject_non_finite(trace, idx):
    with pytest.raises(ValueError, match="non-finite"):
        _solver.py_seed_trace(trace, FS)
    with pytest.raises(ValueError, match="non-finite"):
        _solver.seed_kernel_estimate(trace[None, :], FS)


@pytest.mark.parametrize("trace", DEGENERATE_TRACES)
def test_seed_trace_degenerate_traces(trace):
    counts, alpha, baseline = _solver.py_seed_trace(trace, FS)
    assert counts.shape == trace.shape
    assert finite(counts, alpha, baseline)


@pytest.mark.parametrize("shape", [(0, 100), (3, 0), (3, 1), (2, 300)])
def test_seed_kernel_estimate_degenerate_shapes(shape):
    out = _solver.seed_kernel_estimate(np.zeros(shape), FS)
    free_kernel, *scalars, n_spikes, fit_mode = out
    assert finite(free_kernel, *scalars)
    assert n_spikes >= 0
    assert fit_mode in {"TwoComponent", "SlowOnly", "Degenerate", "Empty"}


# ---------------------------------------------------------------------------
# py_indeca_solve_trace
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("tr, td, lam, fs", BAD_PARAMS)
def test_indeca_solve_trace_rejects_bad_params(tr, td, lam, fs):
    with pytest.raises(ValueError, match="invalid parameter"):
        _solver.py_indeca_solve_trace(spiky(), tr, td, fs, lambda_=lam)


@pytest.mark.parametrize(
    "kwargs, needle",
    [
        ({"upsample_factor": 0}, "upsample_factor"),
        ({"tol": -1.0}, "tol"),
        ({"tol": NAN}, "tol"),
        # The kernel is built at fs * upsample, so the cap applies there.
        ({"upsample_factor": 100_000}, "kernel"),
    ],
)
def test_indeca_solve_trace_rejects_bad_options(kwargs, needle):
    with pytest.raises(ValueError, match=needle):
        _solver.py_indeca_solve_trace(spiky(), TAU_R, TAU_D, FS, **kwargs)


@pytest.mark.parametrize("trace, idx", NONFINITE_TRACES)
def test_indeca_solve_trace_rejects_non_finite(trace, idx):
    with pytest.raises(ValueError, match="non-finite"):
        _solver.py_indeca_solve_trace(trace, TAU_R, TAU_D, FS)
    with pytest.raises(ValueError, match="non-finite"):
        _solver.py_indeca_solve_trace(np.ones(trace.size), TAU_R, TAU_D, FS, warm_counts=trace)


@pytest.mark.parametrize("trace", DEGENERATE_TRACES)
@pytest.mark.parametrize(
    "opts",
    [
        {},
        {"upsample_factor": 4},
        {"hp_enabled": True, "lp_enabled": True},
        {"noise_constrained": True},
    ],
    ids=["plain", "upsampled", "filtered", "noise-constrained"],
)
def test_indeca_solve_trace_degenerate_traces(trace, opts):
    counts, alpha, baseline, threshold, pve, iters, _conv = _solver.py_indeca_solve_trace(
        trace, TAU_R, TAU_D, FS, max_iters=50, **opts
    )
    assert counts.shape == trace.shape
    assert finite(counts, alpha, baseline, threshold, pve)
    assert iters >= 0


@pytest.mark.parametrize("warm_len", [0, 3, 100, 1000])
@pytest.mark.parametrize("max_iters", [0, 1, 50])
def test_indeca_solve_trace_mismatched_warm_counts_and_zero_iters(warm_len, max_iters):
    trace = np.sin(np.arange(100) / 3.0)
    warm = np.ones(warm_len) if warm_len else None
    counts, alpha, *_ = _solver.py_indeca_solve_trace(
        trace, TAU_R, TAU_D, FS, max_iters=max_iters, warm_counts=warm
    )
    assert counts.shape == trace.shape and finite(counts, alpha)


# ---------------------------------------------------------------------------
# py_indeca_estimate_kernel
# ---------------------------------------------------------------------------


def estimate(traces, spikes, lengths, alphas, baselines, k=10, **kw):
    return _solver.py_indeca_estimate_kernel(
        np.asarray(traces, np.float64),
        np.asarray(spikes, np.float64),
        np.asarray(lengths, np.int64),
        np.asarray(alphas, np.float64),
        np.asarray(baselines, np.float64),
        k,
        **kw,
    )


T20 = np.full(20, 0.5)


@pytest.mark.parametrize(
    "args, kw, needle",
    [
        ((T20, T20, [10, 9], [1, 1], [0, 0]), {}, "sum\\(trace_lengths\\)"),
        ((T20, T20, [10, 11], [1, 1], [0, 0]), {}, "sum\\(trace_lengths\\)"),
        ((T20, T20[:10], [10, 10], [1, 1], [0, 0]), {}, "spikes_flat"),
        ((T20, T20, [10, 10], [1], [0, 0]), {}, "one entry per trace"),
        ((T20, T20, [10, 10], [1, 1], [0, 0, 0]), {}, "one entry per trace"),
        ((T20, T20, [10, -10], [1, 1], [0, 0]), {}, ">= 0"),
        ((T20, T20, [10, 10], [1, NAN], [0, 0]), {}, "alphas"),
        ((T20, T20, [10, 10], [1, 1], [0, INF]), {}, "baselines"),
        ((T20, T20, [10, 10], [1, 1], [0, 0]), {"k": 0}, "kernel_length"),
        ((T20, T20, [10, 10], [1, 1], [0, 0]), {"k": MAX_KERNEL_LEN + 1}, "kernel_length"),
        ((T20, T20, [10, 10], [1, 1], [0, 0]), {"tol": -1.0}, "tol"),
        ((T20, T20, [10, 10], [1, 1], [0, 0]), {"smooth_lambda": -1.0}, "smooth_lambda"),
        ((T20, T20, [10, 10], [1, 1], [0, 0]), {"smooth_lambda": NAN}, "smooth_lambda"),
        ((np.r_[T20[:19], NAN], T20, [10, 10], [1, 1], [0, 0]), {}, "non-finite"),
        ((T20, np.r_[INF, T20[1:]], [10, 10], [1, 1], [0, 0]), {}, "non-finite"),
        ((T20, T20, [10, 10], [1, 1], [0, 0]), {"warm_kernel": np.array([NAN])}, "non-finite"),
        ((T20, T20, [2**62, 2**62], [1, 1], [0, 0]), {}, "overflow|sum"),
    ],
)
def test_estimate_kernel_rejects_inconsistent_inputs(args, kw, needle):
    with pytest.raises(ValueError, match=needle):
        estimate(*args, **kw)


@pytest.mark.parametrize(
    "args, kw",
    [
        pytest.param(([], [], [], [], []), {}, id="no-traces"),
        pytest.param(([], [], [0], [1], [0]), {}, id="one-empty-trace"),
        pytest.param((np.ones(3), np.ones(3), [3], [1], [0]), {}, id="shorter-than-kernel"),
        pytest.param((np.ones(30), np.zeros(30), [30], [1], [0]), {}, id="no-spikes"),
        pytest.param((np.ones(30), np.ones(30), [30], [0], [0]), {}, id="alpha-0"),
        pytest.param((np.ones(30), np.ones(30), [30], [1], [0]), {"k": 1}, id="kernel-length-1"),
        pytest.param(
            (np.ones(30), np.ones(30), [30], [1], [0]), {"warm_kernel": np.ones(3)}, id="warm-short"
        ),
        pytest.param(
            (np.ones(30), np.ones(30), [30], [1], [0]), {"warm_kernel": np.ones(50)}, id="warm-long"
        ),
        pytest.param((np.ones(30), np.ones(30), [30], [1], [0]), {"max_iters": 0}, id="zero-iters"),
    ],
)
def test_estimate_kernel_accepts_degenerate_inputs(args, kw):
    k = kw.pop("k", 10)
    h = estimate(*args, k=k, **kw)
    assert h.shape == (k,) and finite(h)


def test_estimate_kernel_wrong_dtypes_raise_type_error():
    with pytest.raises(TypeError):  # lengths must be int64
        _solver.py_indeca_estimate_kernel(
            T20, T20, np.array([10, 10], np.int32), np.ones(2), np.zeros(2), 5
        )
    with pytest.raises(TypeError):  # 1-D only
        _solver.py_indeca_estimate_kernel(
            T20, T20, np.array([[20]], np.int64), np.ones(1), np.zeros(1), 5
        )


# ---------------------------------------------------------------------------
# py_indeca_fit_biexponential
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fs", [0.0, -1.0, NAN, INF])
def test_fit_biexponential_rejects_bad_fs(fs):
    with pytest.raises(ValueError, match="fs"):
        _solver.py_indeca_fit_biexponential(np.ones(20), fs)


@pytest.mark.parametrize(
    "field",
    [
        "warm_tau_rise",
        "warm_tau_decay",
        "warm_tau_rise_fast",
        "warm_tau_decay_fast",
        "warm_beta",
        "warm_beta_fast",
    ],
)
@pytest.mark.parametrize("bad", [NAN, INF, -INF])
def test_fit_biexponential_rejects_non_finite_warm_fields(field, bad):
    h = _solver.py_build_kernel(TAU_R, TAU_D, FS).astype(np.float64)
    with pytest.raises(ValueError, match=field):
        _solver.py_indeca_fit_biexponential(h, FS, use_warm=True, **{field: bad})
    # Ignored when use_warm is False.
    _solver.py_indeca_fit_biexponential(h, FS, use_warm=False, **{field: bad})


def test_fit_biexponential_rejects_non_finite_kernel_and_nan_residual():
    with pytest.raises(ValueError, match="non-finite"):
        _solver.py_indeca_fit_biexponential(np.array([0.0, NAN, 1.0]), FS)
    with pytest.raises(ValueError, match="warm_residual"):
        _solver.py_indeca_fit_biexponential(
            np.ones(20),
            FS,
            use_warm=True,
            warm_tau_rise=TAU_R,
            warm_tau_decay=TAU_D,
            warm_residual=NAN,
        )


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="real gap: warm-start taus are only checked for finiteness, so negative warm taus "
    "pass validation and can be returned verbatim as the best fit. Follow-up: require "
    "0 < warm_tau_rise < warm_tau_decay in validate.rs.",
)
def test_fit_biexponential_rejects_or_ignores_non_physical_warm_taus():
    try:
        out = _solver.py_indeca_fit_biexponential(
            -np.ones(50), FS, use_warm=True, warm_tau_rise=-1.0, warm_tau_decay=-2.0, warm_beta=1.0
        )
    except ValueError:
        return
    assert out[0] > 0 and out[1] > out[0], f"returned taus {out[:2]}"


@pytest.mark.parametrize(
    "h",
    [np.zeros(0), np.ones(1), np.array([1.0, 0.5]), np.zeros(50), -np.ones(50), np.full(50, 1e30)],
    ids=["empty", "one", "two", "zeros", "negative", "huge"],
)
@pytest.mark.parametrize("skip", [0, 1, 1000])
def test_fit_biexponential_degenerate_kernels(h, skip):
    out = _solver.py_indeca_fit_biexponential(h, FS, skip=skip)
    tau_r, tau_d, beta, residual, tau_rf, tau_df, beta_f, mode = out
    assert finite(tau_r, tau_d, beta, tau_rf, tau_df, beta_f)
    assert tau_r > 0 and tau_d > 0
    assert math.isfinite(residual) or mode == "Empty"


# ---------------------------------------------------------------------------
# py_indeca_compute_upsample_factor
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fs, target",
    [
        (0.0, 300.0),
        (-30.0, 300.0),
        (NAN, 300.0),
        (INF, 300.0),
        (FS, 0.0),
        (FS, -1.0),
        (FS, NAN),
        (FS, INF),
        (1e-300, 1e300),
        (1.0, 1e12),
    ],
)
def test_upsample_factor_rejects_bad_rates(fs, target):
    with pytest.raises(ValueError, match="invalid parameter"):
        _solver.py_indeca_compute_upsample_factor(fs, target)


@pytest.mark.parametrize(
    "fs, target, expected", [(FS, FS, 1), (FS, 1e-300, 1), (FS, 300.0, 10), (FS, 44.0, 1)]
)
def test_upsample_factor_is_at_least_one(fs, target, expected):
    assert _solver.py_indeca_compute_upsample_factor(fs, target) == expected


# ---------------------------------------------------------------------------
# py_simulate_traces
# ---------------------------------------------------------------------------


def sim_config(**overrides) -> dict:
    from calab._simulate import SimulationConfig

    base = SimulationConfig.model_validate({"num_cells": 2, "num_timepoints": 100})
    cfg = json.loads(base.model_dump_json())
    for key, value in overrides.items():
        if "." in key:
            outer, inner = key.split(".")
            cfg[outer] = {**cfg[outer], inner: value}
        else:
            cfg[key] = value
    return cfg


@pytest.mark.parametrize("raw", ["", "{", "null", "42", '{"fs_hz": "fast"}', '{"fs_hz": NaN}'])
def test_simulate_rejects_malformed_json(raw):
    with pytest.raises(ValueError, match="Invalid config JSON"):
        _solver.py_simulate_traces(raw)


@pytest.mark.parametrize("cells, timepoints", [(0, 100), (2, 0), (2, 1), (1, 2)])
def test_simulate_zero_and_one_sized(cells, timepoints):
    out = _solver.py_simulate_traces(
        json.dumps(sim_config(num_cells=cells, num_timepoints=timepoints))
    )
    traces, spikes, clean, alphas, snrs, taus_r, taus_d, n_cells, n_tp = out
    assert (n_cells, n_tp) == (cells, timepoints)
    assert traces.size == spikes.size == clean.size == cells * timepoints
    assert alphas.size == snrs.size == taus_r.size == taus_d.size == cells
    assert finite(traces, spikes, clean)


SIM_PROBE = textwrap.dedent(
    """
    import json, sys
    import numpy as np
    import calab._solver as s
    try:
        out = s.py_simulate_traces(sys.argv[1])
    except ValueError:
        print("VALUE_ERROR"); sys.exit(0)
    except BaseException as e:  # PanicException derives from BaseException
        print("RAISED", type(e).__name__, e); sys.exit(3)
    traces, clean = out[0], out[2]
    ok = bool(np.all(np.isfinite(traces)) and np.all(clean >= 0))
    print("OK" if ok else "GARBAGE"); sys.exit(0 if ok else 4)
    """
)


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="real gap: py_simulate_traces / simulate_traces run no input validation. fs_hz=0 "
    "and oversized num_cells*num_timepoints panic (PanicException), tau_decay_s=1e12 aborts "
    "the interpreter on allocation, tau_rise_s=0 returns NaN traces and reversed taus "
    "negative calcium. Follow-up: a shared validate_simulation_config in validate.rs.",
)
@pytest.mark.parametrize(
    "overrides",
    [
        {"fs_hz": 0.0},
        {"num_cells": 2**40, "num_timepoints": 2**40},
        {"kernel.tau_decay_s": 1e12},
        {"kernel.tau_rise_s": 0.0},
        {"kernel.tau_rise_s": 1.0, "kernel.tau_decay_s": 0.1},
    ],
    ids=["fs-0", "size-overflow", "huge-tau-decay-aborts", "tau-rise-0", "reversed-taus"],
)
def test_simulate_rejects_degenerate_configs(overrides):
    # Isolated in a subprocess: some of these currently abort the interpreter.
    proc = subprocess.run(
        [sys.executable, "-c", SIM_PROBE, json.dumps(sim_config(**overrides))],
        capture_output=True,
        text=True,
        timeout=120,
    )
    last = (proc.stdout.strip().splitlines() or [f"<no output, rc={proc.returncode}>"])[-1]
    assert last == "VALUE_ERROR", f"rc={proc.returncode}: {last} {proc.stderr[-300:]}"
