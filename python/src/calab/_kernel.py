"""Kernel math functions -- direct port of wasm/catune-solver/src/kernel.rs.

Preserves exact variable names (dt, kernel_len, t, val, peak, d, r, g1, g2)
for cross-language auditability.
"""

from __future__ import annotations

import numpy as np


def build_kernel(tau_rise: float, tau_decay: float, fs: float) -> np.ndarray:
    """Build a double-exponential calcium kernel normalized to peak = 1.0.

    h(t) = exp(-t/tau_decay) - exp(-t/tau_rise), normalized so max(h) = 1.0.
    Kernel length extends until the decay envelope drops below 1e-6 of peak.

    Parameters
    ----------
    tau_rise : float
        Rise time constant in seconds.
    tau_decay : float
        Decay time constant in seconds.
    fs : float
        Sampling rate in Hz.

    Returns
    -------
    np.ndarray
        Normalized kernel array (peak = 1.0), dtype float64.
    """
    dt = 1.0 / fs

    # Kernel length: until decay drops below 1e-6 of peak
    # -ln(1e-6) = 6*ln(10) ~ 13.8155
    kernel_len = max(2, int(np.ceil(-np.log(1e-6) * tau_decay / dt)))

    t = np.arange(kernel_len) * dt
    kernel = np.exp(-t / tau_decay) - np.exp(-t / tau_rise)

    peak = kernel.max()
    if peak > 0.0:
        kernel /= peak

    return kernel


def tau_to_ar2(
    tau_rise: float, tau_decay: float, fs: float
) -> tuple[float, float, float, float]:
    """Derive AR(2) coefficients from tau parameters.

    The AR(2) process c[t] = g1*c[t-1] + g2*c[t-2] + s[t] has characteristic
    roots d = exp(-dt/tau_decay) and r = exp(-dt/tau_rise).
    g1 = d + r (sum of roots), g2 = -(d * r) (negative product of roots).

    Parameters
    ----------
    tau_rise : float
        Rise time constant in seconds.
    tau_decay : float
        Decay time constant in seconds.
    fs : float
        Sampling rate in Hz.

    Returns
    -------
    tuple[float, float, float, float]
        (g1, g2, d, r) where g1 = d + r, g2 = -(d * r),
        d = exp(-dt/tau_decay), r = exp(-dt/tau_rise).
    """
    dt = 1.0 / fs
    d = np.exp(-dt / tau_decay)  # decay eigenvalue
    r = np.exp(-dt / tau_rise)  # rise eigenvalue

    g1 = d + r
    g2 = -(d * r)

    return float(g1), float(g2), float(d), float(r)


def compute_lipschitz(kernel: np.ndarray) -> float:
    """Compute the Lipschitz constant of the gradient of (1/2)||y - K*s||^2.

    L = max_w |H(w)|^2, where H(w) is the DFT of the kernel. This equals the
    largest eigenvalue of K^T K for a circulant convolution matrix.

    Uses same zero-padding as Rust: next_power_of_two(2 * kernel_len).

    Parameters
    ----------
    kernel : np.ndarray
        Kernel array (e.g., from build_kernel).

    Returns
    -------
    float
        Lipschitz constant (>= 1e-10).
    """
    n = len(kernel)
    if n == 0:
        return 1e-10

    # Match Rust: next_power_of_two(2 * n)
    fft_len = 1
    target = 2 * n
    while fft_len < target:
        fft_len *= 2

    H = np.fft.fft(kernel, n=fft_len)
    max_power = float(np.max(np.abs(H) ** 2))

    return max(max_power, 1e-10)
