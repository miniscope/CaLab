"""FISTA deconvolution solver -- direct port of wasm/catune-solver/src/fista.rs.

Preserves exact variable names (solution, solution_prev, t_fista, step_size,
threshold, gradient, reconvolution, residual, momentum, t_new, x_prev)
for cross-language auditability.

Uses Beck & Teboulle FISTA with adaptive restart (O'Donoghue & Candes 2015).
"""

from __future__ import annotations

from typing import NamedTuple

import numpy as np

from ._kernel import build_kernel, compute_lipschitz


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


def _fista_single(
    trace: np.ndarray,
    kernel: np.ndarray,
    lipschitz: float,
    lam: float,
    tolerance: float,
    max_iters: int,
) -> tuple[np.ndarray, float, np.ndarray, int, bool]:
    """Run FISTA on a single 1-D trace. Returns (activity, baseline, reconvolution, iters, converged)."""
    n = len(trace)
    klen = len(kernel)

    # Effective lambda scaled by kernel DC gain (matching lib.rs:184-186)
    kernel_dc_gain = float(kernel.sum())
    effective_lambda = lam * kernel_dc_gain

    step_size = 1.0 / lipschitz
    threshold = step_size * effective_lambda

    # FISTA state -- matches Rust variable names
    solution = np.zeros(n)       # x_k
    solution_prev = np.zeros(n)  # y_k (extrapolated point)
    t_fista = 1.0
    prev_objective = np.inf
    baseline = 0.0

    converged = False
    iteration = 0

    for iteration in range(1, max_iters + 1):
        # 1. Forward convolution at y_k: reconvolution = K * y_k
        reconvolution = np.convolve(solution_prev, kernel, "full")[:n]

        # 1b. Compute baseline: b = mean(trace - K*y_k) (matching fista.rs:40-47)
        baseline = float(np.mean(trace - reconvolution))

        # 2. Residual = K * y_k + b - trace (matching fista.rs:49-53)
        residual = reconvolution + baseline - trace

        # 3. Adjoint convolution: gradient = K^T * residual
        #    NOTE: adjoint uses [klen-1:klen-1+n], NOT [:n]
        gradient = np.convolve(residual, kernel[::-1], "full")[
            klen - 1 : klen - 1 + n
        ]

        # 4. Save x_k, then proximal gradient step from y_k
        x_prev = solution.copy()
        solution = np.maximum(
            solution_prev - step_size * gradient - threshold, 0.0
        )

        # 5. Objective at x_{k+1} (reconvolve using solution, NOT solution_prev)
        recon_new = np.convolve(solution, kernel, "full")[:n]

        # 5b. Recompute baseline at x_{k+1} (matching fista.rs:77-84)
        baseline = float(np.mean(trace - recon_new))

        # Objective includes baseline in residual (matching fista.rs:169-182)
        res = recon_new + baseline - trace
        objective = 0.5 * np.dot(res, res) + effective_lambda * solution.sum()

        # 6. Adaptive restart (O'Donoghue & Candes 2015)
        #    Matches fista.rs line 90: fires when objective increased and not first iter
        if objective > prev_objective and iteration > 1:
            t_fista = 1.0

        # 7. FISTA momentum extrapolation
        t_new = (1.0 + np.sqrt(1.0 + 4.0 * t_fista * t_fista)) / 2.0
        momentum = (t_fista - 1.0) / t_new
        # y_{k+1} = x_{k+1} + momentum * (x_{k+1} - x_k), projected non-negative
        solution_prev = np.maximum(
            solution + momentum * (solution - x_prev), 0.0
        )
        t_fista = t_new

        # 8. Convergence check (skip first 5 iterations, matching fista.rs line 109)
        if iteration > 5:
            rel_change = abs(prev_objective - objective) / (
                abs(prev_objective) + 1e-10
            )
            if rel_change < tolerance:
                converged = True
                break
        prev_objective = objective

    # Final reconvolution with baseline for return
    final_recon = np.convolve(solution, kernel, "full")[:n] + baseline

    return solution, baseline, final_recon, iteration, converged


def run_deconvolution(
    traces: np.ndarray,
    fs: float,
    tau_r: float,
    tau_d: float,
    lam: float,
    tolerance: float = 1e-6,
    max_iters: int = 2000,
) -> np.ndarray:
    """Run FISTA deconvolution on one or more calcium traces.

    Produces non-negative activity estimates by solving:
        min_s  (1/2)||K*s + b - y||^2 + lam * G_dc * ||s||_1
        s.t.   s >= 0

    where K is the calcium kernel, y is the observed trace, b is a scalar
    baseline estimated jointly, G_dc = sum(K) is the kernel DC gain, and
    s is the non-negative activity to recover.

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
        L1 penalty (sparsity regularization strength). Internally scaled
        by kernel DC gain so the penalty is effective across kernel shapes.
    tolerance : float, optional
        Relative objective change threshold for convergence, by default 1e-6.
    max_iters : int, optional
        Maximum number of FISTA iterations, by default 2000.

    Returns
    -------
    np.ndarray
        Non-negative activity estimates (deconvolved neural activity, scaled
        by an unknown constant), same shape as input ``traces``.
    """
    single_trace = traces.ndim == 1
    traces = np.atleast_2d(np.asarray(traces, dtype=np.float64))
    kernel = build_kernel(tau_r, tau_d, fs)
    lipschitz = compute_lipschitz(kernel)
    results = np.zeros_like(traces)

    for cell_idx in range(traces.shape[0]):
        activity, _, _, _, _ = _fista_single(
            traces[cell_idx], kernel, lipschitz, lam, tolerance, max_iters,
        )
        results[cell_idx] = activity

    if single_trace:
        return results[0]
    return results


def run_deconvolution_full(
    traces: np.ndarray,
    fs: float,
    tau_r: float,
    tau_d: float,
    lam: float,
    tolerance: float = 1e-6,
    max_iters: int = 2000,
) -> DeconvolutionResult:
    """Run FISTA deconvolution returning full results.

    Same solver as :func:`run_deconvolution` but returns a
    :class:`DeconvolutionResult` namedtuple with baseline, reconvolution,
    iteration count, and convergence flag.

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
        L1 penalty (sparsity regularization strength). Internally scaled
        by kernel DC gain so the penalty is effective across kernel shapes.
    tolerance : float, optional
        Relative objective change threshold for convergence, by default 1e-6.
    max_iters : int, optional
        Maximum number of FISTA iterations, by default 2000.

    Returns
    -------
    DeconvolutionResult
        Namedtuple with fields: ``activity``, ``baseline``, ``reconvolution``,
        ``iterations``, ``converged``.
    """
    single_trace = traces.ndim == 1
    traces = np.atleast_2d(np.asarray(traces, dtype=np.float64))
    kernel = build_kernel(tau_r, tau_d, fs)
    lipschitz = compute_lipschitz(kernel)
    n = traces.shape[1]

    activities = np.zeros_like(traces)
    reconvolutions = np.zeros_like(traces)
    baselines = np.zeros(traces.shape[0])
    iterations = np.zeros(traces.shape[0], dtype=int)
    convergeds = np.zeros(traces.shape[0], dtype=bool)

    for cell_idx in range(traces.shape[0]):
        act, bl, recon, iters, conv = _fista_single(
            traces[cell_idx], kernel, lipschitz, lam, tolerance, max_iters,
        )
        activities[cell_idx] = act
        reconvolutions[cell_idx] = recon
        baselines[cell_idx] = bl
        iterations[cell_idx] = iters
        convergeds[cell_idx] = conv

    if single_trace:
        return DeconvolutionResult(
            activity=activities[0],
            baseline=float(baselines[0]),
            reconvolution=reconvolutions[0],
            iterations=int(iterations[0]),
            converged=bool(convergeds[0]),
        )
    return DeconvolutionResult(
        activity=activities,
        baseline=baselines,
        reconvolution=reconvolutions,
        iterations=iterations,
        converged=convergeds,
    )
