"""Bridge between Python and CaTune web app.

``calab.tune(traces, fs)`` starts a localhost HTTP server, opens CaTune
in the browser with ``?bridge=localhost:PORT``, and returns the exported
parameters when the user finishes tuning.
"""

from __future__ import annotations

from ._apps import tune

__all__ = ["tune"]
