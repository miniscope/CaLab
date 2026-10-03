"""The deployed site's app manifest (``apps.json``), fetched once per session.

The web build (``scripts/combine-dist.mjs``) writes ``apps.json`` at the root
of the GitHub Pages site, listing every published app with its slug (``id``)
and URL path segment. Reading it lets an older, pinned ``calab`` follow a
renamed path and see apps added after it was released.

The manifest carries identity and location only. What an app sends back
(result schema, arrays, post-processing) stays in :mod:`._registry`, which is
tested against the TypeScript sources, so a new app listed here but unknown to
the registry can be opened by URL but not used with the bridge until ``calab``
is upgraded.

Fetching is best effort: any failure (offline, timeout, HTTP error, malformed
JSON, unknown ``manifest_version``) is logged at debug level and remembered,
and callers fall back to the built-in registry. Set ``CALAB_APPS_MANIFEST`` to
another URL (e.g. a local ``build:pages`` serve) or to ``off`` to disable.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: Root of the GitHub Pages deployment; each app is served under
#: ``PAGES_BASE_URL + path_segment + "/"``.
PAGES_BASE_URL = "https://miniscope.github.io/CaLab/"

#: Where the deployed site publishes its manifest.
DEFAULT_MANIFEST_URL = urllib.parse.urljoin(PAGES_BASE_URL, "apps.json")

#: Environment variable overriding the manifest URL; ``off``/``0``/``false``/
#: ``none``/empty disables fetching.
MANIFEST_ENV = "CALAB_APPS_MANIFEST"
_DISABLED = frozenset({"", "0", "off", "false", "no", "none"})

#: Seconds to wait for the manifest. Kept short: it only refines defaults.
FETCH_TIMEOUT = 2.0

#: Largest manifest accepted, in bytes.
MAX_BYTES = 1 << 20

#: ``manifest_version`` values this package can read.
SUPPORTED_MANIFEST_VERSIONS = frozenset({1})

_ID_RE = re.compile(r"^[a-z][a-z0-9_-]*$")
# One URL path segment: no slashes, no dot-segments, nothing to escape.
_PATH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class ManifestError(ValueError):
    """The manifest document is not one this package can read."""


@dataclass(frozen=True)
class ManifestApp:
    """One published app, as listed in ``apps.json``."""

    id: str
    display_name: str
    path: str
    description: str = ""
    status: str = ""


@dataclass(frozen=True)
class Manifest:
    """A parsed ``apps.json``.

    ``base_url`` is the site root the app paths are relative to: the directory
    the manifest was fetched from, ending in ``/``.
    """

    base_url: str
    release: str
    generated_at: str
    apps: Mapping[str, ManifestApp]

    def url_for(self, app: ManifestApp) -> str:
        """Absolute URL of *app* on this site."""
        return urllib.parse.urljoin(self.base_url, f"{app.path}/")


def parse_manifest(data: Any, url: str) -> Manifest:
    """Validate a decoded ``apps.json`` document fetched from *url*.

    Malformed entries (bad ``id`` or ``path``, duplicates) are skipped with a
    debug log rather than failing the whole manifest; a malformed document or
    an unsupported ``manifest_version`` raises :class:`ManifestError`.
    """
    if not isinstance(data, dict):
        raise ManifestError("manifest is not a JSON object")
    version = data.get("manifest_version")
    if version not in SUPPORTED_MANIFEST_VERSIONS or isinstance(version, bool):
        raise ManifestError(f"unsupported manifest_version {version!r}")
    entries = data.get("apps")
    if not isinstance(entries, list):
        raise ManifestError("manifest 'apps' is not a list")

    apps: dict[str, ManifestApp] = {}
    for entry in entries:
        app = _parse_entry(entry)
        if app is None:
            logger.debug("calab: skipping malformed apps.json entry %r", entry)
        elif app.id in apps:
            logger.debug("calab: skipping duplicate apps.json entry %r", app.id)
        else:
            apps[app.id] = app
    return Manifest(
        base_url=urllib.parse.urljoin(url, "."),
        release=str(data.get("release") or ""),
        generated_at=str(data.get("generated_at") or ""),
        apps=apps,
    )


def _parse_entry(entry: Any) -> ManifestApp | None:
    if not isinstance(entry, dict):
        return None
    app_id, path = entry.get("id"), entry.get("path")
    if not isinstance(app_id, str) or not _ID_RE.match(app_id):
        return None
    if not isinstance(path, str) or not _PATH_RE.match(path):
        return None
    display_name = entry.get("displayName")
    return ManifestApp(
        id=app_id,
        display_name=display_name if isinstance(display_name, str) and display_name else path,
        path=path,
        description=str(entry.get("description") or ""),
        status=str(entry.get("status") or ""),
    )


def manifest_url() -> str | None:
    """The manifest URL in effect, or ``None`` when fetching is disabled."""
    value = os.environ.get(MANIFEST_ENV)
    if value is None:
        return DEFAULT_MANIFEST_URL
    value = value.strip()
    return None if value.lower() in _DISABLED else value


def _fetch_json(url: str, timeout: float) -> Any:
    """GET *url* and decode it as JSON (module-level so tests can replace it)."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ManifestError(f"manifest larger than {MAX_BYTES} bytes")
    return json.loads(body)


_lock = threading.Lock()
_cache: dict[str, Manifest | None] = {}


def load_manifest() -> Manifest | None:
    """The deployed site's manifest, or ``None`` if unavailable.

    Fetched at most once per URL per process (failures included) with a
    :data:`FETCH_TIMEOUT`-second timeout, then served from memory.
    """
    url = manifest_url()
    if url is None:
        return None
    with _lock:
        if url in _cache:
            return _cache[url]
        manifest: Manifest | None = None
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            logger.debug("calab: ignoring non-http(s) manifest URL %r", url)
        else:
            try:
                manifest = parse_manifest(_fetch_json(url, FETCH_TIMEOUT), url)
            except Exception as exc:  # network, HTTP, JSON, or schema errors alike
                logger.debug("calab: could not load app manifest from %s: %s", url, exc)
        _cache[url] = manifest
        return manifest


def clear_cache() -> None:
    """Forget fetched manifests so the next lookup fetches again."""
    with _lock:
        _cache.clear()
