"""Kernel function tests -- mirrors Rust kernel.rs tests 1-8 plus extras.

Uses numpy.testing.assert_allclose(rtol=1e-10) for floating-point comparisons.
All tests verify numerical equivalence with the Rust solver implementation.
"""

from __future__ import annotations

import numpy as np
from numpy.testing import assert_allclose

from calab import build_kernel, tau_to_ar2, compute_lipschitz


# --- build_kernel tests ---


def test_kernel_peak_is_one(standard_params: dict) -> None:
    """Rust test 1: Kernel peak is 1.0 for typical params."""
    kernel = build_kernel(**standard_params)
    assert_allclose(kernel.max(), 1.0, rtol=1e-10)


def test_kernel_peak_extreme_params() -> None:
    """Rust test 2: Kernel peak is 1.0 for extreme params."""
    kernel = build_kernel(tau_rise=0.001, tau_decay=2.0, fs=100.0)
    assert_allclose(kernel.max(), 1.0, rtol=1e-10)


def test_kernel_first_sample_zero(standard_params: dict) -> None:
    """Rust test 3: h(0) = exp(0) - exp(0) = 0."""
    kernel = build_kernel(**standard_params)
    assert abs(kernel[0]) < 1e-15


def test_kernel_values_non_negative(standard_params: dict) -> None:
    """Rust test 4: All kernel values >= 0 (within float precision)."""
    kernel = build_kernel(**standard_params)
    assert np.all(kernel >= -1e-15), (
        f"Negative kernel values found: min={kernel.min()}"
    )


def test_kernel_length_scales_with_tau_decay() -> None:
    """Rust test 5a: Doubling tau_decay increases kernel length."""
    k1 = build_kernel(0.02, 0.4, 30.0)
    k2 = build_kernel(0.02, 0.8, 30.0)
    assert len(k2) > len(k1), (
        f"Longer tau_decay should produce longer kernel: {len(k2)} vs {len(k1)}"
    )


def test_kernel_length_scales_with_fs() -> None:
    """Rust test 5b: Doubling fs increases kernel length."""
    k1 = build_kernel(0.02, 0.4, 30.0)
    k3 = build_kernel(0.02, 0.4, 60.0)
    assert len(k3) > len(k1), (
        f"Higher fs should produce longer kernel: {len(k3)} vs {len(k1)}"
    )


# --- tau_to_ar2 tests ---


def test_ar2_coefficients_match_known(standard_params: dict) -> None:
    """Rust test 6: g1 = d+r, g2 = -(d*r), computed independently."""
    g1, g2, d, r = tau_to_ar2(**standard_params)

    dt = 1.0 / standard_params["fs"]
    d_expected = np.exp(-dt / standard_params["tau_decay"])
    r_expected = np.exp(-dt / standard_params["tau_rise"])

    assert_allclose(d, d_expected, rtol=1e-15)
    assert_allclose(r, r_expected, rtol=1e-15)
    assert_allclose(g1, d_expected + r_expected, rtol=1e-15)
    assert_allclose(g2, -(d_expected * r_expected), rtol=1e-15)


def test_ar2_roots_in_unit_interval(standard_params: dict) -> None:
    """Rust test 7: Both characteristic roots d, r are in (0, 1)."""
    _g1, _g2, d, r = tau_to_ar2(**standard_params)
    assert 0.0 < d < 1.0, f"Decay root d={d} not in (0,1)"
    assert 0.0 < r < 1.0, f"Rise root r={r} not in (0,1)"


# --- compute_lipschitz tests ---


def test_lipschitz_positive_and_bounded(standard_params: dict) -> None:
    """Rust test 8: L > 0, L >= sum_of_squares, L <= l1_norm^2."""
    kernel = build_kernel(**standard_params)
    lipschitz = compute_lipschitz(kernel)

    assert lipschitz > 0.0, "Lipschitz constant should be positive"

    # By Parseval: max power >= average power = sum of squares / fft_len * fft_len
    # More directly: max|H(w)|^2 >= sum(h^2) (Parseval average <= max)
    sum_squares = float(np.sum(kernel ** 2))
    assert lipschitz >= sum_squares * 0.99, (
        f"Lipschitz should be >= sum of squares: {lipschitz} vs {sum_squares}"
    )

    # Upper bound: |H(w)|^2 <= (sum |h|)^2 = L1 norm squared
    l1_norm = float(np.sum(np.abs(kernel)))
    assert lipschitz <= l1_norm * l1_norm * 1.01, (
        f"Lipschitz should be <= L1 norm squared: {lipschitz} vs {l1_norm**2}"
    )


def test_lipschitz_matches_reference() -> None:
    """Lipschitz via compute_lipschitz matches explicit DFT loop (Rust algorithm).

    Computes the Lipschitz constant using an explicit loop matching the
    Rust implementation's direct DFT, then compares with compute_lipschitz
    which uses np.fft.fft. They should match within rtol=1e-10.
    """
    kernel = build_kernel(0.02, 0.4, 30.0)
    n = len(kernel)

    # Explicit DFT loop matching Rust code (lines 67-82 of kernel.rs)
    fft_len = 1
    target = 2 * n
    while fft_len < target:
        fft_len *= 2

    max_power_ref = 0.0
    for w in range(fft_len):
        freq = 2.0 * np.pi * w / fft_len
        re = 0.0
        im = 0.0
        for k in range(n):
            angle = freq * k
            re += kernel[k] * np.cos(angle)
            im -= kernel[k] * np.sin(angle)
        power = re * re + im * im
        if power > max_power_ref:
            max_power_ref = power

    lipschitz = compute_lipschitz(kernel)
    assert_allclose(lipschitz, max_power_ref, rtol=1e-10)


# --- Additional tests ---


def test_kernel_deterministic(standard_params: dict) -> None:
    """Two calls with same parameters produce identical arrays."""
    k1 = build_kernel(**standard_params)
    k2 = build_kernel(**standard_params)
    assert_allclose(k1, k2, rtol=0)


def test_ar2_multiple_param_sets(
    standard_params: dict, fast_params: dict, slow_params: dict
) -> None:
    """All three param sets produce valid AR(2) coefficients."""
    for params in [standard_params, fast_params, slow_params]:
        g1, g2, d, r = tau_to_ar2(**params)

        # d, r must be in (0, 1)
        assert 0.0 < d < 1.0, f"d={d} out of range for {params}"
        assert 0.0 < r < 1.0, f"r={r} out of range for {params}"

        # g1 = d + r, g2 = -(d * r)
        assert_allclose(g1, d + r, rtol=1e-15)
        assert_allclose(g2, -(d * r), rtol=1e-15)

        # Discriminant must be non-negative for real roots
        discriminant = g1 * g1 + 4.0 * g2
        assert discriminant >= 0.0, f"Negative discriminant for {params}"


def test_lipschitz_empty_kernel() -> None:
    """Empty kernel returns floor value 1e-10."""
    result = compute_lipschitz(np.array([]))
    assert result == 1e-10


def test_lipschitz_single_element() -> None:
    """Single-element kernel: L = h[0]^2."""
    kernel = np.array([3.0])
    result = compute_lipschitz(kernel)
    assert_allclose(result, 9.0, rtol=1e-10)
