"""Bandpass filter -- port of wasm/catune-solver/src/filter.rs.

Pure numpy FFT-based bandpass filter derived from kernel time constants.
Uses cosine-tapered gain curve matching Rust's implementation exactly.
"""

from __future__ import annotations

import numpy as np

# Margin factors for deriving bandpass cutoffs from kernel time constants.
# HP cutoff = 1/(2*pi*tau_decay*M_HP), LP cutoff = M_LP/(2*pi*tau_rise).
# HP uses 16x to preserve the slow calcium decay tail.
# LP uses 4x for tighter noise rejection above the kernel's rise band.
_MARGIN_FACTOR_HP = 16.0
_MARGIN_FACTOR_LP = 4.0


def bandpass_filter(
    trace: np.ndarray,
    tau_rise: float,
    tau_decay: float,
    fs: float,
) -> np.ndarray:
    """Apply FFT bandpass filter derived from kernel time constants.

    Cutoffs are computed from time constants (matching filter.rs:62-90):
      - f_hp = 1 / (2*pi * tau_decay * 16)
      - f_lp = min(4 / (2*pi * tau_rise), fs/2)

    The gain curve uses cosine tapers at transitions (matching filter.rs:130-162).

    Parameters
    ----------
    trace : np.ndarray
        1-D calcium trace to filter.
    tau_rise : float
        Rise time constant in seconds.
    tau_decay : float
        Decay time constant in seconds.
    fs : float
        Sampling rate in Hz.

    Returns
    -------
    np.ndarray
        Filtered trace. Returns input unchanged if filter would be invalid
        (f_hp >= f_lp) or trace is too short (< 8 samples).
    """
    n = len(trace)
    if n < 8:
        return trace.copy()

    nyquist = fs / 2.0

    # Compute cutoffs (matching filter.rs:62-90)
    f_hp = 1.0 / (2.0 * np.pi * tau_decay * _MARGIN_FACTOR_HP)
    f_lp = _MARGIN_FACTOR_LP / (2.0 * np.pi * tau_rise)

    # Clamp LP to Nyquist
    if f_lp > nyquist:
        f_lp = nyquist

    # Invalid if HP >= LP
    if f_hp >= f_lp:
        return trace.copy()

    # Build cosine-tapered gain curve (matching filter.rs:130-162)
    spectrum_len = n // 2 + 1
    df = fs / n
    freqs = np.arange(spectrum_len) * df

    # Taper widths: 50% of respective cutoff frequency
    w_hp = f_hp * 0.5
    w_lp = f_lp * 0.5

    gain = np.zeros(spectrum_len)
    for i in range(spectrum_len):
        f = freqs[i]
        if f < f_hp - w_hp:
            # Stopband (below high-pass)
            gain[i] = 0.0
        elif f < f_hp + w_hp:
            # HP transition (cosine taper 0 -> 1)
            t = (f - (f_hp - w_hp)) / (2.0 * w_hp)
            gain[i] = 0.5 * (1.0 - np.cos(np.pi * t))
        elif f < f_lp - w_lp:
            # Passband
            gain[i] = 1.0
        elif f < f_lp + w_lp:
            # LP transition (cosine taper 1 -> 0)
            t = (f - (f_lp - w_lp)) / (2.0 * w_lp)
            gain[i] = 0.5 * (1.0 + np.cos(np.pi * t))
        else:
            # Stopband (above low-pass)
            gain[i] = 0.0

    # Apply via rfft -> multiply -> irfft
    spectrum = np.fft.rfft(trace)
    spectrum *= gain
    filtered = np.fft.irfft(spectrum, n=n)

    return filtered
