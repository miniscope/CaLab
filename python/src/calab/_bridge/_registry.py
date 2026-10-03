"""Registry of the CaLab web apps the Python bridge can launch.

Every per-app fact the bridge needs lives in one :class:`AppSpec` entry here:
where the app is deployed, which result schema it sends back, which binary
arrays (if any) it uploads alongside that JSON, and how to turn the raw payload
into the value the Python caller gets. The HTTP server
(:mod:`._server`) and the orchestrator (:func:`._apps.launch`) are generic and
read everything from the entry, so wiring up a new app is one entry in
:data:`APPS` -- no new endpoint, event, or orchestrator.

Keys are lowercase app slugs (``catune``, ``cadecon``, ``carank``), meant to be
the same slugs as ``calab.id`` in ``apps/*/package.json``. The GitHub Pages path
segment is kept as separate data because the build (``scripts/combine-dist.mjs``)
currently derives it from ``calab.displayName``; joining the two lets a later
build step generate this table instead of hand-maintaining it.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ._handshake import BridgeResult

#: Root of the GitHub Pages deployment; each app is served under
#: ``PAGES_BASE_URL + path_segment + "/"``.
PAGES_BASE_URL = "https://miniscope.github.io/CaLab/"

#: Path segments of the results routes that are not app slugs. ``activity`` is
#: the legacy CaDecon array route (``POST /api/v1/results/activity``), so no app
#: may use it as a slug.
RESERVED_SLUGS = frozenset({"activity"})

_SLUG_RE = re.compile(r"^[a-z][a-z0-9-]*$")


@dataclass(frozen=True)
class ResultSchema:
    """The result payload an app POSTs back, and the version this package reads.

    ``version`` is the schema version this Python package was written against,
    in whatever form the app sends it (CaTune sends ``"1.2.0"``, CaDecon sends
    the integer ``2``). The handshake compares majors: a different major is
    rejected, a different minor/patch is accepted with a warning.
    """

    name: str
    version: str | int
    version_field: str = "schema_version"


#: Signature of a per-app post-processing hook: ``(result, fs) -> value``,
#: where ``fs`` is the sampling rate the caller passed in.
PostProcess = Callable[["BridgeResult", float], Any]


@dataclass(frozen=True)
class AppSpec:
    """Everything the bridge needs to know about one web app.

    Attributes
    ----------
    slug
        Lowercase registry key; also the ``{app}`` in
        ``POST /api/v1/results/{app}``.
    display_name
        Human-readable name used in terminal messages.
    path_segment
        GitHub Pages path segment (case-sensitive, as deployed).
    result_schema
        The result payload the app sends back, or ``None`` if the app cannot
        export to the bridge yet (it can still be resolved to a URL).
    arrays
        Names of ``.npy`` arrays the app POSTs to
        ``/api/v1/results/{app}/{name}`` *before* its JSON results. The JSON
        POST is the completion signal.
    legacy_result_paths
        Pre-registry routes this app's deployed builds still POST their JSON
        results to. Kept so the live apps keep working unchanged; new apps
        should use only the generic route.
    postprocess
        Hook turning the raw :class:`BridgeResult` into the value returned to
        the caller. ``None`` returns the :class:`BridgeResult` itself.
    """

    slug: str
    display_name: str
    path_segment: str
    result_schema: ResultSchema | None
    arrays: tuple[str, ...] = ()
    legacy_result_paths: tuple[str, ...] = ()
    postprocess: PostProcess | None = field(default=None, compare=False)

    @property
    def default_url(self) -> str:
        """The app's GitHub Pages URL."""
        return f"{PAGES_BASE_URL}{self.path_segment}/"

    @property
    def result_path(self) -> str:
        """Generic route the app POSTs its JSON results to."""
        return f"/api/v1/results/{self.slug}"

    def array_path(self, name: str) -> str:
        """Generic route the app POSTs the ``.npy`` array *name* to."""
        return f"{self.result_path}/{name}"


def _validate(apps: Mapping[str, AppSpec]) -> None:
    for key, spec in apps.items():
        if key != spec.slug:
            raise ValueError(f"registry key {key!r} does not match slug {spec.slug!r}")
        if not _SLUG_RE.match(spec.slug):
            raise ValueError(f"app slug {spec.slug!r} must be lowercase [a-z0-9-]")
        if spec.slug in RESERVED_SLUGS:
            raise ValueError(f"app slug {spec.slug!r} is reserved")
        if spec.result_schema is None and (spec.arrays or spec.legacy_result_paths):
            raise ValueError(f"app {spec.slug!r} declares bridge routes but no result schema")


def _postprocess_catune(result: BridgeResult, fs: float) -> dict:
    from ._postprocess import catune_params

    return catune_params(result, fs)


def _postprocess_cadecon(result: BridgeResult, fs: float) -> Any:
    from ._postprocess import cadecon_result

    return cadecon_result(result, fs)


APPS: dict[str, AppSpec] = {
    spec.slug: spec
    for spec in (
        AppSpec(
            slug="catune",
            display_name="CaTune",
            path_segment="CaTune",
            # packages/io/src/export.ts `buildExportData`
            result_schema=ResultSchema(name="catune-export", version="1.2.0"),
            legacy_result_paths=("/api/v1/params",),
            postprocess=_postprocess_catune,
        ),
        AppSpec(
            slug="cadecon",
            display_name="CaDecon",
            path_segment="CaDecon",
            # apps/cadecon/src/lib/export-utils.ts `buildCaDeconResultsPayload`
            result_schema=ResultSchema(name="cadecon-results", version=2),
            arrays=("activity",),
            legacy_result_paths=("/api/v1/results",),
            postprocess=_postprocess_cadecon,
        ),
        AppSpec(
            slug="carank",
            display_name="CaRank",
            path_segment="CaRank",
            # CaRank has no bridge export yet.
            result_schema=None,
        ),
    )
}
_validate(APPS)

def get_app(slug: str) -> AppSpec:
    """Look up an app by slug (case-insensitive).

    Raises
    ------
    ValueError
        If *slug* is not a registered app.
    """
    spec = APPS.get(slug.lower())
    if spec is None:
        known = ", ".join(sorted(APPS))
        raise ValueError(f"unknown CaLab app {slug!r}; known apps: {known}")
    return spec


def app_url(slug: str) -> str:
    """Default (GitHub Pages) URL of the app registered as *slug*."""
    return get_app(slug).default_url
