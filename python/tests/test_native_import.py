"""The extension import guard gives an actionable message when the build is missing."""

from __future__ import annotations

import importlib
import sys

import pytest


def test_missing_extension_raises_actionable_import_error(monkeypatch):
    import calab
    import calab._native as native

    # A None entry in sys.modules makes `from . import _solver` raise ImportError,
    # which is what a source checkout without `maturin develop` looks like.
    # (The package attribute must go too, or the import is satisfied from it.)
    monkeypatch.setitem(sys.modules, "calab._solver", None)
    monkeypatch.delattr(calab, "_solver")
    with pytest.raises(ImportError, match="maturin develop") as excinfo:
        importlib.reload(native)
    assert "pip install calab" in str(excinfo.value)

    monkeypatch.undo()
    importlib.reload(native)  # restore the real module for other tests
    assert native._solver.PySolver is not None
