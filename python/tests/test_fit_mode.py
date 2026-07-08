"""The bi-exponential fit reports an explicit outcome (fit_mode) so a degenerate
or fallback fit is surfaced rather than silently inferred from beta_fast == 0."""

from __future__ import annotations

import numpy as np

from calab import fit_biexponential


def _biexp(tau_r: float, tau_d: float, fs: float, n: int) -> np.ndarray:
    t = np.arange(n) / fs
    h = np.exp(-t / tau_d) - np.exp(-t / tau_r)
    return h / np.max(h)


def test_fit_mode_usable_for_clean_kernel():
    h = _biexp(0.02, 0.4, 30.0, 200)
    result = fit_biexponential(h, 30.0)
    assert result.fit_mode in ("SlowOnly", "TwoComponent")
    assert result.beta > 0.0


def test_fit_mode_degenerate_on_flat_kernel():
    result = fit_biexponential(np.zeros(100), 30.0)
    assert result.fit_mode == "Degenerate"


def test_fit_mode_empty_on_empty_input():
    result = fit_biexponential(np.array([]), 30.0)
    assert result.fit_mode == "Empty"
