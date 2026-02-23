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

    tau_rise=0.02s, tau_decay=0.4s, fs=30Hz -- typical GCaMP6f at
    standard 2-photon imaging rates.
    """
    return {"tau_rise": 0.02, "tau_decay": 0.4, "fs": 30.0}


@pytest.fixture
def fast_params() -> dict:
    """Fast kinetics parameters.

    tau_rise=0.005s, tau_decay=0.1s, fs=100Hz -- fast indicator at
    high frame rate (e.g., jGCaMP8f with resonant scanning).
    """
    return {"tau_rise": 0.005, "tau_decay": 0.1, "fs": 100.0}


@pytest.fixture
def slow_params() -> dict:
    """Slow kinetics parameters.

    tau_rise=0.05s, tau_decay=1.0s, fs=20Hz -- slow indicator at
    low frame rate (e.g., GCaMP6s with widefield imaging).
    """
    return {"tau_rise": 0.05, "tau_decay": 1.0, "fs": 20.0}


@pytest.fixture
def standard_kernel(standard_params: dict) -> np.ndarray:
    """Pre-built kernel with standard parameters."""
    return build_kernel(**standard_params)
