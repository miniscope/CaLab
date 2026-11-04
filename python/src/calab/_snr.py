"""Robust noise and SNR metrics for real calcium-imaging traces.

Thin wrappers over the Rust ``snr`` module (shared with the web apps). The
noise estimator and SNR definition follow Krisha Aghi's derivation
("Signal-to-Noise Ratio Derivation for Calcium Imaging Data", Aharoni lab,
2026), building on the noise level of Rupprecht et al. (2021, CASCADE).

The measured SNR is burst-based: its signal is the mean of the top 1 % of
samples minus the median, because on real data a single action potential
usually sits inside the noise. It therefore compares cells that share a
burst-size distribution (cells of one type in one dataset). It shifts when
firing statistics differ: at the same per-spike noise, a burstier cell measures
higher and a sparser cell lower. It is not a per-spike SNR. Pure noise
measures about 2.7 (about 3 on a 5-minute trace), so values near 3 mean no
detectable activity.

``calab.simulate`` uses the same definition by default
(``NoiseConfig(reference="measured_snr")``): a trace simulated at SNR X
measures X with :func:`measured_snr`.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import ArrayLike

from ._native import _solver

#: Default top slice of :func:`peak_snr` / :func:`measured_snr` (top 1 % of samples).
DEFAULT_TOP_FRACTION: float = float(_solver.SNR_DEFAULT_TOP_FRACTION)


def _as_f64(trace: ArrayLike) -> np.ndarray:
    arr = np.ascontiguousarray(trace, dtype=np.float64)
    if arr.ndim != 1:
        raise ValueError(f"expected a 1-D trace, got shape {arr.shape}")
    return arr


def noise_sigma_mad_diff(trace: ArrayLike) -> float:
    """Noise std from the MAD of first differences: ``median|diff| / (0.6745 * sqrt(2))``.

    Unbiased for white Gaussian noise; overestimates sigma on very clean, very
    active traces whose own frame-to-frame changes are larger than the noise.
    """
    return float(_solver.py_snr_noise_sigma_mad_diff(_as_f64(trace)))


def noise_level_nu(trace_dff: ArrayLike, fs: float) -> float:
    """CASCADE noise level ``median|diff(dF/F)| / sqrt(fs)`` (Rupprecht et al. 2021).

    Pass dF/F in percent to get nu in %/sqrt(Hz): ~1 very good, ~2-4 typical,
    ~8 large-scale population imaging.
    """
    return float(_solver.py_snr_noise_level_nu(_as_f64(trace_dff), float(fs)))


def peak_snr(trace: ArrayLike, sigma: float, top_fraction: float = DEFAULT_TOP_FRACTION) -> float:
    """Descriptive peak SNR: ``(mean of the top `top_fraction` of samples - median) / sigma``.

    Depends on firing regime (see the module docstring); compare it only across
    cells with similar burst statistics.
    """
    return float(_solver.py_snr_peak(_as_f64(trace), float(sigma), float(top_fraction)))


def measured_snr(trace: ArrayLike) -> float:
    """:func:`peak_snr` with :func:`noise_sigma_mad_diff` and the default top fraction.

    The SNR the simulator's default convention targets. Comparable across cells
    whose burst-size distributions are similar.
    """
    return float(_solver.py_snr_measured(_as_f64(trace)))
