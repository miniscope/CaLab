"""Import guard for the compiled Rust extension (``calab._solver``).

Gives an actionable error instead of a bare ``ImportError`` when the
extension module is missing (e.g. a source checkout that was never built).
"""

from __future__ import annotations

import importlib
from typing import Any

try:
    # import_module (rather than `from . import _solver`) keeps the extension
    # typed as Any for mypy, matching the previous `from ._solver import ...`.
    _solver: Any = importlib.import_module("calab._solver")
except ImportError as exc:  # pragma: no cover - exercised only without the build
    raise ImportError(
        "calab's compiled extension module 'calab._solver' could not be imported "
        f"({exc}). Install a prebuilt wheel with `pip install calab`, or, from a "
        "source checkout, build it with `pip install maturin && cd python && "
        "maturin develop --release` (requires a Rust toolchain: https://rustup.rs)."
    ) from exc

__all__ = ["_solver"]
