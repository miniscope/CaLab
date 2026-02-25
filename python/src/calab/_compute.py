"""Compute functions wrapping the Rust calab-solver extension.

Provides the same public API as before (run_deconvolution, run_deconvolution_full,
build_kernel, etc.) but delegates to the native Rust solver via calab._solver.
"""

from __future__ import annotations

from typing import NamedTuple

import numpy as np

from ._solver import (
    PySolver,
    deconvolve_batch as _deconvolve_batch,
    deconvolve_single as _deconvolve_single,
    py_build_kernel as _build_kernel,
    py_compute_lipschitz as _compute_lipschitz,
)


class DeconvolutionResult(NamedTuple):
    """Full result from FISTA deconvolution.

    Attributes
    ----------
    activity : np.ndarray
        Non-negative deconvolved activity estimates, same shape as input traces.
    baseline : float | np.ndarray
        Estimated scalar baseline (per-trace if multi-trace input).
    reconvolution : np.ndarray
        K*activity + baseline, the model fit to the trace.
    iterations : int | np.ndarray
        Number of FISTA iterations run (per-trace if multi-trace input).
    converged : bool | np.ndarray
        Whether convergence criterion was met (per-trace if multi-trace input).
    """

    activity: np.ndarray
    baseline: float | np.ndarray
    reconvolution: np.ndarray
    iterations: int | np.ndarray
    converged: bool | np.ndarray


def build_kernel(tau_rise: float, tau_decay: float, fs: float) -> np.ndarray:
    """Build double-exponential calcium kernel. Delegates to Rust."""
    return np.asarray(_build_kernel(tau_rise, tau_decay, fs))


def compute_lipschitz(kernel: np.ndarray) -> float:
    """Compute Lipschitz constant. Delegates to Rust."""
    return _compute_lipschitz(np.ascontiguousarray(kernel, dtype=np.float32))


def tau_to_ar2(
    tau_rise: float, tau_decay: float, fs: float,
) -> tuple[float, float, float, float]:
    """Derive AR(2) coefficients from tau parameters.

    Pure Python (trivial math, no solver needed).

    Returns
    -------
    tuple[float, float, float, float]
        (g1, g2, d, r) where g1 = d + r, g2 = -(d * r),
        d = exp(-dt/tau_decay), r = exp(-dt/tau_rise).
    """
    dt = 1.0 / fs
    d = np.exp(-dt / tau_decay)
    r = np.exp(-dt / tau_rise)
    g1 = d + r
    g2 = -(d * r)
    return float(g1), float(g2), float(d), float(r)


def bandpass_filter(
    trace: np.ndarray,
    tau_rise: float,
    tau_decay: float,
    fs: float,
) -> np.ndarray:
    """Apply FFT bandpass filter derived from kernel time constants. Delegates to Rust."""
    n = len(trace)
    if n < 8:
        return trace.copy()

    solver = PySolver()
    solver.set_params(tau_rise, tau_decay, 0.01, fs)  # lambda irrelevant for filter
    solver.set_filter_enabled(True)
    trace_f32 = np.ascontiguousarray(trace, dtype=np.float32)
    solver.set_trace(trace_f32)
    applied = solver.apply_filter()
    if not applied:
        return trace.copy()
    return np.asarray(solver.get_trace(), dtype=np.float64)


def run_deconvolution(
    traces: np.ndarray,
    fs: float,
    tau_r: float,
    tau_d: float,
    lam: float,
    max_iters: int = 2000,
    conv_mode: str = "fft",
    constraint: str = "nonneg",
) -> np.ndarray:
    """Run FISTA deconvolution on one or more calcium traces.

    Delegates to the Rust solver via calab._solver.

    Parameters
    ----------
    traces : np.ndarray
        Input traces, shape ``(n_timepoints,)`` for a single trace or
        ``(n_cells, n_timepoints)`` for multiple traces.
    fs : float
        Sampling rate in Hz.
    tau_r : float
        Rise time constant in seconds.
    tau_d : float
        Decay time constant in seconds.
    lam : float
        L1 penalty (sparsity regularization strength).
    max_iters : int, optional
        Maximum number of FISTA iterations, by default 2000.
    conv_mode : str, optional
        Convolution mode: ``'fft'`` (default) or ``'banded'`` (O(T) AR2).
    constraint : str, optional
        Constraint type: ``'nonneg'`` (default, L1 + non-negative) or
        ``'box01'`` (box constraint [0, 1], no L1 penalty).

    Returns
    -------
    np.ndarray
        Non-negative activity estimates, same shape as input ``traces``.
    """
    single_trace = traces.ndim == 1
    traces_2d = np.atleast_2d(np.asarray(traces, dtype=np.float64))

    if traces_2d.shape[0] == 1:
        activity, _, _, _, _ = _deconvolve_single(
            traces_2d[0], fs, tau_r, tau_d, lam, max_iters=max_iters,
            conv_mode=conv_mode, constraint=constraint,
        )
        result = np.asarray(activity, dtype=np.float64)
        return result if single_trace else result.reshape(1, -1)

    activities, _, _, _, _ = _deconvolve_batch(
        traces_2d, fs, tau_r, tau_d, lam, max_iters=max_iters,
        conv_mode=conv_mode, constraint=constraint,
    )
    return np.stack([np.asarray(a, dtype=np.float64) for a in activities])


def run_deconvolution_full(
    traces: np.ndarray,
    fs: float,
    tau_r: float,
    tau_d: float,
    lam: float,
    max_iters: int = 2000,
    conv_mode: str = "fft",
    constraint: str = "nonneg",
) -> DeconvolutionResult:
    """Run FISTA deconvolution returning full results.

    Parameters
    ----------
    traces : np.ndarray
        Input traces, shape ``(n_timepoints,)`` for a single trace or
        ``(n_cells, n_timepoints)`` for multiple traces.
    fs : float
        Sampling rate in Hz.
    tau_r : float
        Rise time constant in seconds.
    tau_d : float
        Decay time constant in seconds.
    lam : float
        L1 penalty (sparsity regularization strength).
    max_iters : int, optional
        Maximum number of FISTA iterations, by default 2000.
    conv_mode : str, optional
        Convolution mode: ``'fft'`` (default) or ``'banded'`` (O(T) AR2).
    constraint : str, optional
        Constraint type: ``'nonneg'`` (default, L1 + non-negative) or
        ``'box01'`` (box constraint [0, 1], no L1 penalty).

    Returns
    -------
    DeconvolutionResult
        Namedtuple with fields: ``activity``, ``baseline``, ``reconvolution``,
        ``iterations``, ``converged``.
    """
    single_trace = traces.ndim == 1
    traces_2d = np.atleast_2d(np.asarray(traces, dtype=np.float64))

    if single_trace:
        activity, baseline, reconvolution, iterations, converged = _deconvolve_single(
            traces_2d[0], fs, tau_r, tau_d, lam, max_iters=max_iters,
            conv_mode=conv_mode, constraint=constraint,
        )
        return DeconvolutionResult(
            activity=np.asarray(activity, dtype=np.float64),
            baseline=baseline,
            reconvolution=np.asarray(reconvolution, dtype=np.float64),
            iterations=int(iterations),
            converged=bool(converged),
        )

    activities, baselines, reconvolutions, iterations, convergeds = _deconvolve_batch(
        traces_2d, fs, tau_r, tau_d, lam, max_iters=max_iters,
        conv_mode=conv_mode, constraint=constraint,
    )

    return DeconvolutionResult(
        activity=np.stack([np.asarray(a, dtype=np.float64) for a in activities]),
        baseline=np.array(baselines),
        reconvolution=np.stack([np.asarray(r, dtype=np.float64) for r in reconvolutions]),
        iterations=np.array(iterations, dtype=int),
        converged=np.array(convergeds, dtype=bool),
    )
