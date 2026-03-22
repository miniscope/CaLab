"""Bridge between Python and CaLab web apps (CaTune + CaDecon).

``calab.tune(traces, fs)`` opens CaTune for interactive parameter tuning.
``calab.decon(traces, fs)`` opens CaDecon for automated deconvolution.
"""

from __future__ import annotations

from ._apps import decon, tune

__all__ = ["decon", "tune"]
