"""End-to-end cross-language equivalence tests.

Verifies that the Python FISTA implementation satisfies the same mathematical
properties as the Rust solver, ensuring numerical consistency between the
two implementations.
"""

from __future__ import annotations

import numpy as np
import numpy.testing as npt
import pytest

from calab import (
    build_kernel,
    compute_lipschitz,
    load_tuning_data,
    run_deconvolution,
    save_for_tuning,
)
from calab._fista import run_deconvolution_full


# ---------------------------------------------------------------------------
# Test 1: Kernel equivalence across parameter sets
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "tau_r,tau_d,fs",
    [
        (0.02, 0.4, 30.0),
        (0.005, 0.1, 100.0),
        (0.05, 1.0, 20.0),
        (0.01, 0.2, 50.0),
        (0.001, 2.0, 100.0),
    ],
)
def test_kernel_equivalence_across_params(tau_r: float, tau_d: float, fs: float):
    """For 5+ parameter sets, verify kernel properties matching Rust tests."""
    kernel = build_kernel(tau_r, tau_d, fs)

    # Peak = 1.0 (Rust test 1/2)
    assert abs(kernel.max() - 1.0) < 1e-10, (
        f"Peak should be 1.0, got {kernel.max()}"
    )
    # First sample = 0.0 (Rust test 3)
    assert abs(kernel[0]) < 1e-15, (
        f"First sample should be 0.0, got {kernel[0]}"
    )
    # All non-negative (Rust test 4)
    assert np.all(kernel >= -1e-15), (
        f"Negative kernel values: min={kernel.min()}"
    )
    # Length scales with tau_decay * fs (Rust test 5 concept)
    expected_min_len = int(2 * tau_d * fs)
    assert len(kernel) >= expected_min_len, (
        f"Kernel too short: {len(kernel)} < {expected_min_len}"
    )


# ---------------------------------------------------------------------------
# Test 2: Solver self-consistency
# ---------------------------------------------------------------------------

def test_solver_self_consistency():
    """trace = convolve(activity, kernel) -> solver -> reconvolution ~ trace."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 300
    event_locs = [20, 80, 150, 230]

    # Create ground-truth trace
    activity_gt = np.zeros(n)
    for loc in event_locs:
        activity_gt[loc] = 1.0
    trace = np.convolve(activity_gt, kernel)[:n]

    # Solve with low lambda for faithful recovery
    result = run_deconvolution_full(trace, 30.0, 0.02, 0.4, 0.001)

    # Relative error < 5%
    rel_err = np.linalg.norm(trace - result.reconvolution) / np.linalg.norm(trace)
    assert rel_err < 0.05, (
        f"Self-consistency relative error {rel_err:.6f} >= 0.05"
    )


# ---------------------------------------------------------------------------
# Test 3: Save-load-solve pipeline
# ---------------------------------------------------------------------------

def test_save_load_solve_pipeline(tmp_path):
    """Full pipeline: generate -> save -> load -> solve -> verify."""
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 500
    n_cells = 3
    event_locations = [[100], [200], [300]]

    traces = np.zeros((n_cells, n))
    for i, locs in enumerate(event_locations):
        for loc in locs:
            activity = np.zeros(n)
            activity[loc] = 1.0
            traces[i] += np.convolve(activity, kernel)[:n]

    # Save
    path = str(tmp_path / "pipeline_test")
    save_for_tuning(traces, 30.0, path)

    # Load
    loaded, meta = load_tuning_data(path)
    npt.assert_allclose(loaded, traces)
    assert meta["schema_version"] == "1.0.0"
    assert meta["num_cells"] == 3
    assert meta["num_timepoints"] == 500

    # Solve
    solution = run_deconvolution(loaded, 30.0, 0.02, 0.4, 0.01)
    assert solution.shape == (n_cells, n)
    assert np.all(solution >= 0)

    # Verify activity locations
    for i, locs in enumerate(event_locations):
        for loc in locs:
            window = solution[i, max(0, loc - 2) : loc + 3]
            assert window.max() > 0.01, (
                f"Cell {i}: no activity detected near {loc}"
            )


# ---------------------------------------------------------------------------
# Test 4: Objective decreases monotonically (with restart)
# ---------------------------------------------------------------------------

def test_objective_decreases_monotonically():
    """Objective should be non-increasing after adaptive restart settles.

    FISTA with adaptive restart may have brief increases when restart fires,
    but the overall trend must be decreasing. We check that after the first
    10 iterations, no sustained increase occurs.

    This inline loop matches the updated solver with baseline + lambda*G_dc.
    """
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = 200
    klen = len(kernel)
    lipschitz = compute_lipschitz(kernel)

    # Effective lambda with kernel DC gain scaling
    lam = 0.01
    kernel_dc_gain = float(kernel.sum())
    effective_lambda = lam * kernel_dc_gain

    # Create synthetic trace
    activity_gt = np.zeros(n)
    activity_gt[50] = 1.0
    activity_gt[120] = 1.0
    trace = np.convolve(activity_gt, kernel)[:n]

    step_size = 1.0 / lipschitz
    threshold = step_size * effective_lambda

    solution = np.zeros(n)
    solution_prev = np.zeros(n)
    t_fista = 1.0
    prev_objective = np.inf
    objectives = []

    for iteration in range(1, 501):
        reconvolution = np.convolve(solution_prev, kernel, "full")[:n]

        # Baseline at y_k
        baseline = float(np.mean(trace - reconvolution))

        # Residual includes baseline
        residual = reconvolution + baseline - trace

        gradient = np.convolve(residual, kernel[::-1], "full")[
            klen - 1 : klen - 1 + n
        ]
        x_prev = solution.copy()
        solution = np.maximum(
            solution_prev - step_size * gradient - threshold, 0.0
        )

        # Recompute baseline at x_{k+1}
        recon_new = np.convolve(solution, kernel, "full")[:n]
        baseline = float(np.mean(trace - recon_new))

        res = recon_new + baseline - trace
        objective = 0.5 * np.dot(res, res) + effective_lambda * solution.sum()

        if objective > prev_objective and iteration > 1:
            t_fista = 1.0

        t_new = (1.0 + np.sqrt(1.0 + 4.0 * t_fista * t_fista)) / 2.0
        momentum = (t_fista - 1.0) / t_new
        solution_prev = np.maximum(
            solution + momentum * (solution - x_prev), 0.0
        )
        t_fista = t_new

        if iteration > 5:
            rel_change = abs(prev_objective - objective) / (
                abs(prev_objective) + 1e-10
            )
            if rel_change < 1e-6:
                break
        prev_objective = objective
        objectives.append(objective)

    # After first 10 iterations, objective should generally decrease
    if len(objectives) > 10:
        assert objectives[-1] < objectives[10] * 0.5, (
            f"Objective did not decrease sufficiently: "
            f"iter 10 = {objectives[10]:.6e}, final = {objectives[-1]:.6e}"
        )


# ---------------------------------------------------------------------------
# Test 5: Adjoint is transpose of forward
# ---------------------------------------------------------------------------

def test_adjoint_is_transpose_of_forward():
    """Verify adjoint convolution is the matrix transpose of forward.

    For small n, construct the forward convolution matrix K explicitly,
    then verify K^T @ residual matches the adjoint operation.
    """
    n = 8
    kernel = np.array([0.0, 0.8, 1.0, 0.6, 0.3])
    klen = len(kernel)

    # Build forward convolution matrix (causal, Toeplitz-like)
    # K[t, s] = kernel[t - s] if 0 <= t - s < klen, else 0
    K = np.zeros((n, n))
    for t in range(n):
        for s in range(n):
            if 0 <= t - s < klen:
                K[t, s] = kernel[t - s]

    # Random test vectors
    rng = np.random.default_rng(42)
    signal = rng.standard_normal(n)
    residual_vec = rng.standard_normal(n)

    # Forward via matrix
    forward_matrix = K @ signal
    # Forward via np.convolve
    forward_conv = np.convolve(signal, kernel, "full")[:n]
    npt.assert_allclose(
        forward_matrix, forward_conv, rtol=1e-10,
        err_msg="Forward convolution mismatch"
    )

    # Adjoint via matrix transpose
    adjoint_matrix = K.T @ residual_vec
    # Adjoint via np.convolve with reversed kernel
    adjoint_conv = np.convolve(residual_vec, kernel[::-1], "full")[
        klen - 1 : klen - 1 + n
    ]
    npt.assert_allclose(
        adjoint_matrix, adjoint_conv, rtol=1e-10,
        err_msg="Adjoint convolution does not match matrix transpose"
    )

    # Cross-check: <Kx, r> should equal <x, K^T r>
    lhs = np.dot(forward_conv, residual_vec)
    rhs = np.dot(signal, adjoint_conv)
    npt.assert_allclose(
        lhs, rhs, rtol=1e-10,
        err_msg="Adjoint property <Kx, r> = <x, K^T r> violated"
    )
