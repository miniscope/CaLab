"""Version handshake between the Python bridge and a live web app.

The web apps are served from GitHub Pages and always run their latest build,
while ``calab`` is whatever the user pinned with pip. This module decides
whether a result payload from the browser can be consumed by *this* package.

Two checks, each comparing semver with Cargo's caret rule (same major, or same
minor while the major is ``0``):

1. **Result schema** -- the payload's ``schema_version`` (field name from the
   app's :class:`~._registry.ResultSchema`) against the version this package
   was written for. Required: a payload without one is rejected.
2. **Solver version** -- the payload's ``solver_version``, the WASM build's
   ``solver_version()``, against ``calab._solver.protocol_version()``. Both
   come from ``version`` in ``crates/solver/Cargo.toml``. Optional: deployed
   apps do not send it yet, and a payload without it skips this check.

An incompatible version raises :class:`BridgeVersionError` whose message says
which side to upgrade; a compatible but different version produces a
:class:`BridgeVersionWarning`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from ._registry import AppSpec

#: Payload field carrying the WASM solver version (``solver_version()``).
SOLVER_VERSION_FIELD = "solver_version"

_UPGRADE_PYTHON = "Upgrade the Python package: pip install --upgrade calab"

_VERSION_RE = re.compile(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$")


class BridgeVersionError(RuntimeError):
    """The web app sent results this version of ``calab`` cannot read safely."""


class BridgeVersionWarning(UserWarning):
    """The web app and ``calab`` differ by a compatible (minor/patch) version."""


@dataclass
class BridgeResult:
    """Raw results received from a web app over the bridge.

    Attributes
    ----------
    app
        Registry slug of the app that sent the results.
    payload
        The JSON results document as sent by the app.
    arrays
        ``.npy`` arrays the app uploaded alongside the JSON, by name.
    warnings
        Compatible-drift messages from the version handshake.
    """

    app: str
    payload: dict[str, Any]
    arrays: dict[str, np.ndarray] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def parse_version(value: object) -> tuple[int, int, int]:
    """Parse ``2``, ``"2"``, ``"1.2"``, ``"1.2.0"`` or ``"v1.2.0"`` to a triple.

    Raises
    ------
    ValueError
        If *value* is not a version number.
    """
    if isinstance(value, bool):
        raise ValueError(f"not a version: {value!r}")
    if isinstance(value, int):
        if value < 0:
            raise ValueError(f"not a version: {value!r}")
        return (value, 0, 0)
    if isinstance(value, str):
        m = _VERSION_RE.match(value.strip())
        if m:
            major, minor, patch = (int(g) if g is not None else 0 for g in m.groups())
            return (major, minor, patch)
    raise ValueError(f"not a version: {value!r}")


def is_compatible(have: tuple[int, int, int], want: tuple[int, int, int]) -> bool:
    """Cargo caret compatibility: same major, and same minor while major is 0."""
    if have[0] != want[0]:
        return False
    return have[0] != 0 or have[1] == want[1]


def _fmt(v: tuple[int, int, int]) -> str:
    return ".".join(str(p) for p in v)


def local_solver_version() -> str | None:
    """Version of the bundled native solver, or ``None`` if it is not importable."""
    try:
        from .. import _solver  # type: ignore[attr-defined]
    except ImportError:
        return None
    getter = getattr(_solver, "protocol_version", None)
    if callable(getter):
        return str(getter())
    version = getattr(_solver, "__version__", None)
    return str(version) if version is not None else None


def local_calab_version() -> str | None:
    """Installed ``calab`` distribution version, or ``None`` if not installed."""
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("calab")
    except PackageNotFoundError:
        return None


def _check_schema(spec: AppSpec, payload: dict[str, Any]) -> list[str]:
    schema = spec.result_schema
    if schema is None:
        raise BridgeVersionError(f"{spec.display_name} has no bridge result schema registered.")
    want = parse_version(schema.version)
    calab_v = local_calab_version() or "unknown"

    if schema.version_field not in payload:
        raise BridgeVersionError(
            f"{spec.display_name} sent results without a '{schema.version_field}' field, so "
            f"they cannot be checked against the {schema.name} schema "
            f"{_fmt(want)} that calab {calab_v} reads. The app build is too old or not a "
            f"CaLab build; open the current app (drop app_url=) or rebuild it."
        )
    raw = payload[schema.version_field]
    try:
        have = parse_version(raw)
    except ValueError:
        raise BridgeVersionError(
            f"{spec.display_name} sent an unreadable {schema.version_field} {raw!r}."
        ) from None

    if not is_compatible(have, want):
        if have > want:
            fix = _UPGRADE_PYTHON + f" (calab {calab_v} predates this app version)."
        else:
            fix = (
                "The app is older than this calab expects. If you passed app_url=, update "
                "or rebuild that app; otherwise install a calab release matching the "
                f"deployed app (calab {calab_v} is newer)."
            )
        raise BridgeVersionError(
            f"Incompatible {spec.display_name} results: the app sent {schema.name} schema "
            f"{_fmt(have)}, but calab {calab_v} reads schema {_fmt(want)}. {fix}"
        )
    if have != want:
        hint = _UPGRADE_PYTHON if have > want else "The app is older than this calab."
        return [
            f"{spec.display_name} sent {schema.name} schema {_fmt(have)}; calab {calab_v} was "
            f"written for {_fmt(want)}. Compatible, but fields may differ. {hint}"
        ]
    return []


def _check_solver(spec: AppSpec, payload: dict[str, Any], local: str | None) -> list[str]:
    raw = payload.get(SOLVER_VERSION_FIELD)
    if raw is None or local is None:
        # Deployed apps do not report a solver version yet, and a source tree
        # without the compiled extension has nothing to compare against.
        return []
    try:
        have = parse_version(raw)
        want = parse_version(local)
    except ValueError as exc:
        raise BridgeVersionError(
            f"{spec.display_name} solver version check failed: {exc}"
        ) from None

    if not is_compatible(have, want):
        if have > want:
            fix = _UPGRADE_PYTHON + "."
        else:
            fix = (
                "The app's solver is older than calab's. If you passed app_url=, rebuild that "
                "app; otherwise install a calab release matching the deployed app."
            )
        raise BridgeVersionError(
            f"Incompatible solver: {spec.display_name} computed these results with solver "
            f"{_fmt(have)}, but this calab bundles solver {_fmt(want)}. {fix}"
        )
    if have != want:
        hint = _UPGRADE_PYTHON if have > want else "The app's solver is older."
        return [
            f"{spec.display_name} used solver {_fmt(have)}; this calab bundles solver "
            f"{_fmt(want)}. Compatible, but numerical results may differ slightly. {hint}"
        ]
    return []


def check_result(
    spec: AppSpec,
    payload: dict[str, Any],
    *,
    solver_version: str | None = None,
    check_solver: bool = True,
) -> list[str]:
    """Run the handshake on a results *payload* from the app *spec*.

    Parameters
    ----------
    spec
        The registered app the payload came from.
    payload
        The decoded JSON results.
    solver_version
        Local solver version to compare against. Defaults to the bundled
        native extension's (see :func:`local_solver_version`).
    check_solver
        Set False to skip the solver comparison (tests).

    Returns
    -------
    list of str
        Compatible-drift warnings (empty when versions match exactly).

    Raises
    ------
    BridgeVersionError
        On an incompatible schema or solver version, or a missing schema
        version.
    """
    warnings = _check_schema(spec, payload)
    if check_solver:
        local = solver_version if solver_version is not None else local_solver_version()
        warnings += _check_solver(spec, payload, local)
    return warnings
