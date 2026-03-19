"""Shared pytest fixtures for CaLab Python tests.

Provides standard parameter sets and pre-built kernels for reuse
across test modules.
"""

from __future__ import annotations

import pytest
import numpy as np
from calab import build_kernel


@pytest.fixture
def standard_params() -> dict:
    """Standard calcium imaging parameters.

    tau_rise=0.04s, tau_decay=0.4s, fs=30Hz -- typical GCaMP6f at
    standard 2-photon imaging rates. Rise time spans ~1.2 samples.
    """
    return {"tau_rise": 0.04, "tau_decay": 0.4, "fs": 30.0}


@pytest.fixture
def fast_params() -> dict:
    """Fast kinetics parameters.

    tau_rise=0.015s, tau_decay=0.15s, fs=100Hz -- fast indicator at
    high frame rate (e.g., jGCaMP8f with resonant scanning).
    Rise time spans ~1.5 samples.
    """
    return {"tau_rise": 0.015, "tau_decay": 0.15, "fs": 100.0}


@pytest.fixture
def slow_params() -> dict:
    """Slow kinetics parameters.

    tau_rise=0.05s, tau_decay=1.0s, fs=20Hz -- slow indicator at
    low frame rate (e.g., GCaMP6s with widefield imaging).
    Rise time spans 1.0 samples (at the resolvability floor).
    """
    return {"tau_rise": 0.05, "tau_decay": 1.0, "fs": 20.0}


@pytest.fixture
def standard_kernel(standard_params: dict) -> np.ndarray:
    """Pre-built kernel with standard parameters."""
    return build_kernel(**standard_params)
