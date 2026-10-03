"""Tests for loading the deployed site's apps.json into the bridge registry."""

from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from calab._bridge import _apps, _manifest, _registry
from calab._bridge._manifest import ManifestError, load_manifest, parse_manifest
from calab._bridge._registry import APPS, app_url, bridge_app, get_app, resolve_app

REPO_ROOT = Path(__file__).resolve().parents[2]
SITE = "https://example.test/CaLab/"
MANIFEST_URL = SITE + "apps.json"


def _entry(app_id: str, path: str, **extra: Any) -> dict[str, Any]:
    return {"id": app_id, "displayName": path, "path": path, "description": "",
            "status": "stable", **extra}


def _doc(*entries: dict[str, Any], release: str = "v9.1.0") -> dict[str, Any]:
    return {
        "manifest_version": 1,
        "release": release,
        "commit": "0123abcd",
        "generated_at": "2026-10-02T00:00:00.000Z",
        "apps": list(entries),
    }


CURRENT = _doc(_entry("cadecon", "CaDecon"), _entry("catune", "CaTune"),
               _entry("carank", "CaRank", status="coming-soon"))


class StubSite:
    """Stands in for the deployed site: serves ``doc`` (or raises it)."""

    def __init__(self) -> None:
        self.doc: Any = CURRENT
        self.fetched: list[str] = []

    def fetch(self, url: str, timeout: float) -> Any:
        self.fetched.append(url)
        if isinstance(self.doc, BaseException):
            raise self.doc
        return self.doc


@pytest.fixture
def site(monkeypatch: pytest.MonkeyPatch) -> StubSite:
    """Point the bridge at MANIFEST_URL, answered by a StubSite."""
    stub = StubSite()
    monkeypatch.setenv(_manifest.MANIFEST_ENV, MANIFEST_URL)
    monkeypatch.setattr(_manifest, "_fetch_json", stub.fetch)
    return stub


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def test_parse_manifest_reads_identity_and_site_root() -> None:
    manifest = parse_manifest(CURRENT, MANIFEST_URL)
    assert manifest.base_url == SITE
    assert manifest.release == "v9.1.0"
    assert manifest.generated_at.startswith("2026-10-02")
    assert list(manifest.apps) == ["cadecon", "catune", "carank"]
    carank = manifest.apps["carank"]
    assert (carank.display_name, carank.path, carank.status) == ("CaRank", "CaRank", "coming-soon")
    assert manifest.url_for(carank) == SITE + "CaRank/"


@pytest.mark.parametrize(
    "bad",
    [
        {"id": "Upper", "path": "X"},
        {"id": "x", "path": "../escape"},
        {"id": "x", "path": "a/b"},
        {"id": "x"},
        {"path": "X"},
        "not-an-object",
    ],
)
def test_parse_manifest_skips_malformed_entries(bad: Any) -> None:
    manifest = parse_manifest(_doc(bad, _entry("catune", "CaTune")), MANIFEST_URL)
    assert list(manifest.apps) == ["catune"]


def test_parse_manifest_keeps_first_duplicate() -> None:
    manifest = parse_manifest(_doc(_entry("catune", "A"), _entry("catune", "B")), MANIFEST_URL)
    assert manifest.apps["catune"].path == "A"


@pytest.mark.parametrize(
    "doc",
    [[], {"apps": []}, {"manifest_version": 2, "apps": []},
     {"manifest_version": True, "apps": []}, {"manifest_version": 1, "apps": {}}],
)
def test_parse_manifest_rejects_unreadable_documents(doc: Any) -> None:
    with pytest.raises(ManifestError):
        parse_manifest(doc, MANIFEST_URL)


def test_manifest_version_matches_build_script() -> None:
    """scripts/lib/apps.mjs writes a manifest_version this package can read."""
    src = (REPO_ROOT / "scripts" / "lib" / "apps.mjs").read_text()
    m = re.search(r"MANIFEST_VERSION\s*=\s*(\d+)", src)
    assert m is not None
    assert int(m.group(1)) in _manifest.SUPPORTED_MANIFEST_VERSIONS
    assert re.search(r"MANIFEST_FILE\s*=\s*'apps\.json'", src)
    assert _manifest.DEFAULT_MANIFEST_URL == "https://miniscope.github.io/CaLab/apps.json"


# ---------------------------------------------------------------------------
# Loading policy
# ---------------------------------------------------------------------------


def test_manifest_is_fetched_once_per_session(site: StubSite) -> None:
    assert app_url("catune") == SITE + "CaTune/"
    assert app_url("cadecon") == SITE + "CaDecon/"
    resolve_app("carank")
    assert site.fetched == [MANIFEST_URL]


@pytest.mark.parametrize(
    "failure",
    [OSError("network unreachable"), TimeoutError("timed out"), ValueError("bad json"),
     ManifestError("too big")],
)
def test_fetch_failure_falls_back_to_builtin_registry(
    site: StubSite, failure: BaseException,
) -> None:
    site.doc = failure
    assert load_manifest() is None
    assert app_url("catune") == "https://miniscope.github.io/CaLab/CaTune/"
    assert resolve_app("cadecon") is APPS["cadecon"]
    assert site.fetched == [MANIFEST_URL]  # the failure is remembered, not retried


def test_unreadable_manifest_falls_back(site: StubSite) -> None:
    site.doc = {"manifest_version": 99, "apps": []}
    assert resolve_app("catune") is APPS["catune"]


def test_manifest_can_be_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(url: str, timeout: float) -> Any:
        raise AssertionError("fetched while disabled")

    monkeypatch.setattr(_manifest, "_fetch_json", boom)
    for value in ("off", "0", "", "none"):
        monkeypatch.setenv(_manifest.MANIFEST_ENV, value)
        assert load_manifest() is None
    assert app_url("catune") == "https://miniscope.github.io/CaLab/CaTune/"


def test_default_manifest_url_when_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(_manifest.MANIFEST_ENV, raising=False)
    assert _manifest.manifest_url() == "https://miniscope.github.io/CaLab/apps.json"


def test_non_http_manifest_url_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(_manifest.MANIFEST_ENV, "file:///etc/passwd")
    assert load_manifest() is None


# ---------------------------------------------------------------------------
# Merging with the registry
# ---------------------------------------------------------------------------


def test_manifest_path_overrides_builtin_segment(site: StubSite) -> None:
    site.doc = _doc(_entry("catune", "CaTune2", displayName="CaTune Pro"))
    spec = resolve_app("CaTune")
    assert spec.default_url == SITE + "CaTune2/"
    assert spec.display_name == "CaTune Pro"
    # Everything the bridge needs to read results still comes from the registry.
    assert spec.result_schema == APPS["catune"].result_schema
    assert spec.postprocess is APPS["catune"].postprocess
    assert spec.legacy_result_paths == APPS["catune"].legacy_result_paths
    assert spec.registered
    # get_app stays the offline, built-in view.
    assert get_app("catune").default_url == "https://miniscope.github.io/CaLab/CaTune/"


def test_new_app_in_manifest_resolves_to_url_only(site: StubSite) -> None:
    site.doc = _doc(*CURRENT["apps"], _entry("caflow", "CaFlow"), release="v9.2.0")
    spec = resolve_app("caflow")
    assert spec.slug == "caflow"
    assert spec.default_url == SITE + "CaFlow/"
    assert not spec.registered
    assert spec.result_schema is None
    assert app_url("caflow") == SITE + "CaFlow/"
    with pytest.raises(ValueError, match=r"CaLab release v9\.2\.0.*pip install --upgrade calab"):
        bridge_app("caflow")
    with pytest.raises(ValueError, match="pip install --upgrade calab"):
        _apps.launch("caflow", np.zeros((1, 10)), timeout=1)


def test_unknown_everywhere_still_raises(site: StubSite) -> None:
    with pytest.raises(ValueError, match="unknown CaLab app 'nope'.*upgrade calab"):
        resolve_app("nope")


def test_stale_manifest_missing_known_app_uses_builtin(site: StubSite) -> None:
    site.doc = _doc(_entry("catune", "CaTune"))
    assert resolve_app("cadecon") is APPS["cadecon"]
    assert app_url("cadecon") == "https://miniscope.github.io/CaLab/CaDecon/"
    assert bridge_app("cadecon") is APPS["cadecon"]


def test_reserved_slug_in_manifest_is_ignored(site: StubSite) -> None:
    site.doc = _doc(_entry("activity", "Activity"))
    with pytest.raises(ValueError, match="unknown CaLab app"):
        resolve_app("activity")


def test_app_without_bridge_export_is_still_rejected(site: StubSite) -> None:
    with pytest.raises(ValueError, match="does not support the Python bridge"):
        bridge_app("carank")


# ---------------------------------------------------------------------------
# app_url= wins
# ---------------------------------------------------------------------------


@pytest.fixture
def opened(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Capture the URL launch() would open, without serving or waiting."""
    urls: list[str] = []

    def fake_run_bridge(server, event, app_name, url, *args, **kwargs) -> bool:
        server.server_close()  # never started serving, so no shutdown()
        urls.append(url)
        return False

    monkeypatch.setattr(_apps, "_run_bridge", fake_run_bridge)
    return urls


def test_launch_uses_manifest_url_by_default(site: StubSite, opened: list[str]) -> None:
    site.doc = _doc(_entry("catune", "CaTuneNext"))
    assert _apps.launch("catune", np.zeros((1, 10)), timeout=1) is None
    assert opened == [SITE + "CaTuneNext/"]


def test_explicit_app_url_wins_and_skips_the_fetch(
    site: StubSite, opened: list[str],
) -> None:
    site.doc = _doc(_entry("catune", "CaTuneNext"))
    local = "http://localhost:5173/"
    assert _apps.launch("catune", np.zeros((1, 10)), timeout=1, app_url=local) is None
    assert opened == [local]
    assert site.fetched == []  # the manifest was never fetched


def test_explicit_app_url_still_needs_a_registered_app(site: StubSite) -> None:
    site.doc = _doc(_entry("caflow", "CaFlow"))
    with pytest.raises(ValueError, match="unknown CaLab app 'caflow'"):
        bridge_app("caflow", app_url="http://localhost:5173/")


# ---------------------------------------------------------------------------
# Real HTTP: urllib path, content, and timeout
# ---------------------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    body: bytes = b""
    status: int = 200
    delay: float = 0.0

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        time.sleep(self.delay)
        try:
            self.send_response(self.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(self.body)))
            self.end_headers()
            self.wfile.write(self.body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client gave up (timeout test)

    def log_message(self, *args: Any) -> None:
        pass


def _http_server(monkeypatch: pytest.MonkeyPatch, **attrs: Any) -> ThreadingHTTPServer:
    handler = type("Handler", (_Handler,), attrs)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv(
        _manifest.MANIFEST_ENV, f"http://127.0.0.1:{server.server_port}/CaLab/apps.json",
    )
    return server


def test_http_fetch_serves_manifest_and_site_root(monkeypatch: pytest.MonkeyPatch) -> None:
    server = _http_server(monkeypatch, body=json.dumps(CURRENT).encode())
    try:
        assert app_url("cadecon") == f"http://127.0.0.1:{server.server_port}/CaLab/CaDecon/"
    finally:
        server.shutdown()


def test_http_error_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    server = _http_server(monkeypatch, status=404, body=b"not found")
    try:
        assert app_url("catune") == "https://miniscope.github.io/CaLab/CaTune/"
    finally:
        server.shutdown()


def test_http_timeout_falls_back_quickly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_manifest, "FETCH_TIMEOUT", 0.2)
    server = _http_server(monkeypatch, body=json.dumps(CURRENT).encode(), delay=2.0)
    try:
        start = time.monotonic()
        assert app_url("catune") == "https://miniscope.github.io/CaLab/CaTune/"
        assert time.monotonic() - start < 1.5
        # Remembered: a second lookup does not wait again.
        start = time.monotonic()
        assert app_url("cadecon") == "https://miniscope.github.io/CaLab/CaDecon/"
        assert time.monotonic() - start < 0.1
    finally:
        server.shutdown()


def test_oversized_manifest_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_manifest, "MAX_BYTES", 64)
    server = _http_server(monkeypatch, body=json.dumps(CURRENT).encode())
    try:
        assert load_manifest() is None
    finally:
        server.shutdown()


def test_registry_module_reexports_pages_base() -> None:
    assert _registry.PAGES_BASE_URL == _manifest.PAGES_BASE_URL
