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
measures about 2.7 (2.5-2.9 over 1-30 minute traces, with or without slow drift
such as photobleaching, which is removed before the signal is read), so values near that mean
"indistinguishable from noise"; :func:`measured_snr_report` and
:func:`detect_events` give the explicit answer (``is_silent``).

``calab.simulate`` uses the same definition by default
(``NoiseConfig(reference="measured_snr")``): a trace simulated at SNR X
measures X with :func:`measured_snr`.
"""

from __future__ import annotations

from dataclasses import dataclass

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


def peak_snr(
    trace: ArrayLike,
    sigma: float,
    fs: float,
    top_fraction: float = DEFAULT_TOP_FRACTION,
) -> float:
    """Descriptive peak SNR: ``(mean of the top `top_fraction` of samples - median) / sigma``.

    Depends on firing regime (see the module docstring); compare it only across
    cells with similar burst statistics. ``fs`` is the frame rate in Hz: the
    top slice and median are read after subtracting a slow baseline (a rolling
    20th percentile over 60 s), so photobleaching and other slow drift do not
    inflate the SNR. An invalid ``fs`` (not positive and finite) skips that step.
    """
    return float(_solver.py_snr_peak(_as_f64(trace), float(sigma), float(top_fraction), float(fs)))


def measured_snr(trace: ArrayLike, fs: float) -> float:
    """:func:`peak_snr` with :func:`noise_sigma_mad_diff` and the default top fraction.

    The SNR the simulator's default convention targets. Comparable across cells
    whose burst-size distributions are similar. ``fs`` is the frame rate in Hz
    (it sets the 60 s drift-removal window; see :func:`peak_snr`).
    """
    return float(_solver.py_snr_measured(_as_f64(trace), float(fs)))


@dataclass(frozen=True)
class Event:
    """A calcium event found by :func:`detect_events`."""

    #: Sample index of the event's peak in the lightly smoothed trace.
    time_index: int
    #: Peak height above the local pre-event baseline, in trace units.
    height: float
    #: The local pre-event baseline (the minimum of the smoothed trace over the
    #: preceding separation window, so slightly below the typical baseline).
    baseline: float


@dataclass(frozen=True)
class SnrReport:
    """:func:`measured_snr` with the silent flag."""

    #: Top-slice measured SNR. Pure noise measures ~2.7: values near it mean
    #: "indistinguishable from noise".
    snr: float
    #: Noise std (:func:`noise_sigma_mad_diff`).
    sigma: float
    #: Number of events that clear the noise floor.
    n_events: int
    #: True when no event clears the floor (no activity a pure-noise trace of
    #: this length would not show). The SNR is still reported.
    is_silent: bool


def detect_events(
    trace: ArrayLike, min_separation_samples: int, sigma: float | None = None
) -> list[Event]:
    """Detect calcium events: transients clearly above the noise.

    The trace is lightly smoothed (about a quarter of ``min_separation_samples``
    wide); events are local maxima over +/- ``min_separation_samples``, with
    height measured above the local pre-event baseline, and kept only if the
    height exceeds a floor derived from ``sigma`` so a pure-noise trace of the
    same length gives about 0.1 false events in expectation.

    Args:
        trace: 1-D trace.
        min_separation_samples: Minimum spacing between events; use about the
            indicator's decay time in samples (e.g. ``round(tau_decay * fs)``).
        sigma: Noise std. Defaults to :func:`noise_sigma_mad_diff`.
    """
    x = _as_f64(trace)
    if min_separation_samples < 0:
        raise ValueError("min_separation_samples must be >= 0")
    s = noise_sigma_mad_diff(x) if sigma is None else float(sigma)
    idx, heights, baselines = _solver.py_snr_detect_events(x, s, int(min_separation_samples))
    return [
        Event(int(i), float(h), float(b))
        for i, h, b in zip(idx.tolist(), heights.tolist(), baselines.tolist(), strict=True)
    ]


def measured_snr_report(trace: ArrayLike, fs: float, min_separation_samples: int) -> SnrReport:
    """:func:`measured_snr` plus ``is_silent`` (no event clears the noise floor).

    The SNR stays the top-slice number. A silent trace measures near the
    metric's pure-noise floor (~2.7); use ``is_silent`` rather than a threshold
    on the SNR to decide whether anything is there.
    """
    if min_separation_samples < 0:
        raise ValueError("min_separation_samples must be >= 0")
    snr, sigma, n_events, is_silent = _solver.py_snr_measured_report(
        _as_f64(trace), float(fs), int(min_separation_samples)
    )
    return SnrReport(float(snr), float(sigma), int(n_events), bool(is_silent))
