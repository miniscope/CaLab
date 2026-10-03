"""Bridge between Python and the CaLab web apps.

``calab.tune(traces, fs)`` opens CaTune for interactive parameter tuning.
``calab.decon(traces, fs)`` opens CaDecon for automated deconvolution.
Both are thin wrappers over :func:`launch`, which runs any app in the
registry (:mod:`._registry`) and version-checks its results
(:mod:`._handshake`).
"""

from __future__ import annotations

from ._apps import decon, launch, tune
from ._handshake import BridgeResult, BridgeVersionError, BridgeVersionWarning
from ._headless import HeadlessBrowser
from ._models import DeconConfig
from ._registry import APPS, AppSpec, ResultSchema, app_url, get_app, resolve_app

__all__ = [
    "APPS",
    "AppSpec",
    "BridgeResult",
    "BridgeVersionError",
    "BridgeVersionWarning",
    "DeconConfig",
    "HeadlessBrowser",
    "ResultSchema",
    "app_url",
    "decon",
    "get_app",
    "launch",
    "resolve_app",
    "tune",
]
