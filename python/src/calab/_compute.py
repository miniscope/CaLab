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
    py_indeca_solve_trace as _indeca_solve_trace,
    py_indeca_estimate_kernel as _indeca_estimate_kernel,
    py_indeca_fit_biexponential as _indeca_fit_biexponential,
    py_indeca_compute_upsample_factor as _indeca_compute_upsample_factor,
)


class CaDeconResult(NamedTuple):
    """Full result from CaDecon (automated deconvolution via InDeCa algorithm).

    Attributes
    ----------
    activity : np.ndarray
        Deconvolved activity matrix, shape ``(n_cells, n_timepoints)``, float32.
    alphas : np.ndarray
        Per-cell scaling factors, shape ``(n_cells,)``, float64.
    baselines : np.ndarray
        Per-cell baseline estimates, shape ``(n_cells,)``, float64.
    pves : np.ndarray
        Per-cell proportion of variance explained, shape ``(n_cells,)``, float64.
    kernel_slow : np.ndarray
        Slow biexponential kernel waveform, float32.
    kernel_fast : np.ndarray
        Fast biexponential kernel waveform, float32 (empty if single-component).
    fs : float
        Sampling rate in Hz.
    metadata : dict
        Extensible dict with biexp params, convergence info, h_free, etc.
    """

    activity: np.ndarray
    alphas: np.ndarray
    baselines: np.ndarray
    pves: np.ndarray
    kernel_slow: np.ndarray
    kernel_fast: np.ndarray
    fs: float
    metadata: dict


def _build_biexp_waveform(
    tau_rise: float, tau_decay: float, beta: float, fs: float, length: int,
) -> np.ndarray:
    """Build a biexponential waveform: beta * (exp(-t/tau_d) - exp(-t/tau_r)).

    Uses the same 5x tau_decay length convention as the browser solver.
    """
    t = np.arange(length) / fs
    waveform = beta * (np.exp(-t / tau_decay) - np.exp(-t / tau_rise))
    return waveform.astype(np.float32)


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


# ---------------------------------------------------------------------------
# InDeCa pipeline wrappers
# ---------------------------------------------------------------------------


class SolveTraceResult(NamedTuple):
    """Result from a single-trace InDeCa solve.

    Attributes
    ----------
    s_counts : np.ndarray
        Spike counts at the original sampling rate, shape ``(n_timepoints,)``, float32.
    alpha : float
        Amplitude scaling factor.
    baseline : float
        Estimated baseline.
    threshold : float
        Spike threshold used.
    pve : float
        Proportion of variance explained (0–1).
    iterations : int
        Number of FISTA iterations run.
    converged : bool
        Whether the solver converged.
    """

    s_counts: np.ndarray
    alpha: float
    baseline: float
    threshold: float
    pve: float
    iterations: int
    converged: bool


class BiexpFitResult(NamedTuple):
    """Result from bi-exponential kernel fitting.

    Attributes
    ----------
    tau_rise : float
        Slow-component rise time constant (seconds).
    tau_decay : float
        Slow-component decay time constant (seconds).
    beta : float
        Slow-component amplitude.
    residual : float
        Fit residual (lower is better).
    tau_rise_fast : float
        Fast-component rise time constant (seconds), 0 if single-component.
    tau_decay_fast : float
        Fast-component decay time constant (seconds), 0 if single-component.
    beta_fast : float
        Fast-component amplitude, 0 if single-component.
    """

    tau_rise: float
    tau_decay: float
    beta: float
    residual: float
    tau_rise_fast: float
    tau_decay_fast: float
    beta_fast: float


def solve_trace(
    trace: np.ndarray,
    tau_rise: float,
    tau_decay: float,
    fs: float,
    *,
    upsample_factor: int = 1,
    max_iters: int = 500,
    tol: float = 1e-4,
    hp_enabled: bool = False,
    lp_enabled: bool = False,
    warm_counts: np.ndarray | None = None,
    lambda_: float = 0.0,
) -> SolveTraceResult:
    """Run the InDeCa pipeline on a single trace. Delegates to Rust.

    Parameters
    ----------
    trace : np.ndarray
        1-D calcium trace.
    tau_rise, tau_decay : float
        Time constants in seconds.
    fs : float
        Sampling rate in Hz.
    upsample_factor : int
        Upsampling multiplier (1 = no upsampling).
    max_iters : int
        Maximum FISTA iterations.
    tol : float
        Convergence tolerance.
    hp_enabled, lp_enabled : bool
        Enable high-pass / low-pass filtering.
    warm_counts : np.ndarray, optional
        Spike counts from a previous iteration (at original rate) for warm-start.
    lambda_ : float
        L1 sparsity penalty.

    Returns
    -------
    SolveTraceResult
    """
    trace_1d = np.ascontiguousarray(np.atleast_1d(trace), dtype=np.float64)
    warm = None
    if warm_counts is not None:
        warm = np.ascontiguousarray(warm_counts, dtype=np.float64)

    s_counts, alpha, baseline, threshold, pve, iterations, converged = _indeca_solve_trace(
        trace_1d, tau_rise, tau_decay, fs,
        upsample_factor, max_iters, tol,
        hp_enabled, lp_enabled, warm, lambda_,
    )
    return SolveTraceResult(
        s_counts=np.asarray(s_counts),
        alpha=float(alpha),
        baseline=float(baseline),
        threshold=float(threshold),
        pve=float(pve),
        iterations=int(iterations),
        converged=bool(converged),
    )


def estimate_kernel(
    traces_flat: np.ndarray,
    spikes_flat: np.ndarray,
    trace_lengths: np.ndarray,
    alphas: np.ndarray,
    baselines: np.ndarray,
    kernel_length: int,
    *,
    max_iters: int = 200,
    tol: float = 1e-4,
    warm_kernel: np.ndarray | None = None,
    smooth_lambda: float = 0.0,
) -> np.ndarray:
    """Estimate a free-form kernel from traces and spike trains. Delegates to Rust.

    Parameters
    ----------
    traces_flat : np.ndarray
        Concatenated 1-D traces (all cells flattened).
    spikes_flat : np.ndarray
        Concatenated 1-D spike trains (matching traces_flat).
    trace_lengths : np.ndarray
        Length of each individual trace in the flat arrays.
    alphas : np.ndarray
        Per-trace amplitude scaling factors.
    baselines : np.ndarray
        Per-trace baseline estimates.
    kernel_length : int
        Desired output kernel length in samples.
    max_iters : int
        Maximum FISTA iterations for kernel estimation.
    tol : float
        Convergence tolerance.
    warm_kernel : np.ndarray, optional
        Kernel from a previous iteration for warm-start.
    smooth_lambda : float
        Total-variation smoothness penalty weight.

    Returns
    -------
    np.ndarray
        Estimated free-form kernel, shape ``(kernel_length,)``, float32.
    """
    tf = np.ascontiguousarray(traces_flat, dtype=np.float64)
    sf = np.ascontiguousarray(spikes_flat, dtype=np.float64)
    tl = np.ascontiguousarray(trace_lengths, dtype=np.int64)
    al = np.ascontiguousarray(alphas, dtype=np.float64)
    bl = np.ascontiguousarray(baselines, dtype=np.float64)
    wk = None
    if warm_kernel is not None:
        wk = np.ascontiguousarray(warm_kernel, dtype=np.float64)

    result = _indeca_estimate_kernel(
        tf, sf, tl, al, bl, kernel_length,
        max_iters, tol, wk, smooth_lambda,
    )
    return np.asarray(result)


def fit_biexponential(
    h_free: np.ndarray,
    fs: float,
    *,
    refine: bool = True,
    skip: int = 0,
    warm: BiexpFitResult | None = None,
) -> BiexpFitResult:
    """Fit a bi-exponential model to a free-form kernel. Delegates to Rust.

    Parameters
    ----------
    h_free : np.ndarray
        Free-form kernel (1-D).
    fs : float
        Sampling rate in Hz.
    refine : bool
        Whether to refine with a fast (second) component.
    skip : int
        Number of leading samples to skip in the fit.
    warm : BiexpFitResult, optional
        Previous fit result for warm-start.

    Returns
    -------
    BiexpFitResult
    """
    h = np.ascontiguousarray(h_free, dtype=np.float64)
    use_warm = warm is not None
    result = _indeca_fit_biexponential(
        h, fs, refine, skip,
        warm_tau_rise=warm.tau_rise if warm else 0.0,
        warm_tau_decay=warm.tau_decay if warm else 0.0,
        warm_tau_rise_fast=warm.tau_rise_fast if warm else 0.0,
        warm_tau_decay_fast=warm.tau_decay_fast if warm else 0.0,
        warm_beta=warm.beta if warm else 0.0,
        warm_beta_fast=warm.beta_fast if warm else 0.0,
        warm_residual=warm.residual if warm else float("inf"),
        use_warm=use_warm,
    )
    return BiexpFitResult(*result)


def compute_upsample_factor(fs: float, target_fs: float) -> int:
    """Compute the upsample factor for a given sampling rate and target. Delegates to Rust.

    Parameters
    ----------
    fs : float
        Original sampling rate in Hz.
    target_fs : float
        Target sampling rate in Hz.

    Returns
    -------
    int
        Upsampling multiplier (>= 1).
    """
    return int(_indeca_compute_upsample_factor(fs, target_fs))
