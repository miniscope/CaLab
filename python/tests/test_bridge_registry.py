"""Tests for the bridge app registry, generic results routes, and version handshake."""

from __future__ import annotations

import io
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import numpy.testing as npt
import pytest

import calab
from calab._bridge import _apps, _registry
from calab._bridge._handshake import (
    BridgeResult,
    BridgeVersionError,
    BridgeVersionWarning,
    check_result,
    is_compatible,
    local_solver_version,
    parse_version,
)
from calab._bridge._registry import APPS, AppSpec, ResultSchema, app_url, get_app
from calab._bridge._server import BridgeServer

REPO_ROOT = Path(__file__).resolve().parents[2]

CATUNE_OK = {
    "schema_version": "1.2.0",
    "parameters": {
        "tau_rise_s": 0.02,
        "tau_decay_s": 0.4,
        "lambda": 0.01,
        "sampling_rate_hz": 30.0,
        "filter_enabled": True,
    },
}
CADECON_OK = {
    "schema_version": 2,
    "alphas": [1.0, 2.0],
    "baselines": [0.0, 0.1],
    "pves": [0.5, 0.6],
    "fs": 30.0,
    "tau_rise": 0.05,
    "tau_decay": 0.4,
    "beta": 1.0,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _server(app: str = "catune", **kwargs) -> BridgeServer:
    traces = np.random.default_rng(0).standard_normal((2, 50))
    server = BridgeServer(traces, fs=30.0, app=app, **kwargs)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture
def catune_server():
    server = _server("catune")
    yield server
    server.shutdown()


@pytest.fixture
def cadecon_server():
    server = _server("cadecon")
    yield server
    server.shutdown()


def _request(
    base: str, secret: str, path: str, *, data: bytes | None = None, json_body: object = None,
) -> tuple[int, bytes]:
    if json_body is not None:
        data = json.dumps(json_body).encode()
    req = urllib.request.Request(
        f"{base}{path}", data=data, method="POST" if data is not None else "GET",
    )
    req.add_header("X-Bridge-Secret", secret)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _call(server: BridgeServer, path: str, **kwargs) -> tuple[int, bytes]:
    return _request(f"http://127.0.0.1:{server.port}", server.secret, path, **kwargs)


def _npy(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    np.save(buf, arr)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_registry_keys_are_lowercase_slugs() -> None:
    assert set(APPS) == {"catune", "cadecon", "carank"}
    for key, spec in APPS.items():
        assert key == spec.slug == key.lower()


def test_default_urls_match_current_deployment() -> None:
    # Must stay byte-identical to what GitHub Pages serves today.
    assert app_url("catune") == "https://miniscope.github.io/CaLab/CaTune/"
    assert app_url("cadecon") == "https://miniscope.github.io/CaLab/CaDecon/"
    assert app_url("carank") == "https://miniscope.github.io/CaLab/CaRank/"


def test_get_app_is_case_insensitive_and_rejects_unknown() -> None:
    assert get_app("CaTune") is APPS["catune"]
    with pytest.raises(ValueError, match="unknown CaLab app 'nope'"):
        get_app("nope")


@pytest.mark.parametrize("slug", sorted(APPS))
def test_path_segment_matches_app_package_json(slug: str) -> None:
    """The deploy path is ``calab.displayName`` (scripts/combine-dist.mjs).

    If ``calab.id`` exists it must equal the registry slug, so the two tables
    can be joined (and eventually generated) without a rename.
    """
    pkg = json.loads((REPO_ROOT / "apps" / slug / "package.json").read_text())
    meta = pkg["calab"]
    assert APPS[slug].path_segment == meta["displayName"]
    if "id" in meta:
        assert meta["id"] == slug


def test_schema_versions_match_typescript_sources() -> None:
    """Registry schema versions equal the literals the apps send."""
    catune_src = (REPO_ROOT / "apps" / "catune" / "src" / "lib" / "export.ts").read_text()
    m = re.search(r"schema_version:\s*'([^']+)'", catune_src)
    assert m is not None
    assert APPS["catune"].result_schema is not None
    assert APPS["catune"].result_schema.version == m.group(1)

    cadecon_src = (
        REPO_ROOT / "apps" / "cadecon" / "src" / "lib" / "export-utils.ts"
    ).read_text()
    m = re.search(r"schema_version:\s*(\d+)", cadecon_src)
    assert m is not None
    assert APPS["cadecon"].result_schema is not None
    assert APPS["cadecon"].result_schema.version == int(m.group(1))


@pytest.mark.parametrize(
    ("spec", "match"),
    [
        (AppSpec("Bad", "Bad", "Bad", None), "lowercase"),
        (AppSpec("activity", "A", "A", ResultSchema("a", 1)), "reserved"),
        (AppSpec("x", "X", "X", None, arrays=("a",)), "no result schema"),
    ],
)
def test_registry_validation_rejects_bad_entries(spec: AppSpec, match: str) -> None:
    with pytest.raises(ValueError, match=match):
        _registry._validate({spec.slug: spec})


def test_new_app_is_one_registry_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    """A newly registered app gets the generic routes with no other code."""
    spec = AppSpec("newapp", "NewApp", "NewApp", ResultSchema("newapp-results", "1.0.0"),
                   arrays=("spikes",))
    monkeypatch.setitem(_registry.APPS, "newapp", spec)
    server = _server("newapp")
    try:
        status, _ = _call(server, "/api/v1/results/newapp/spikes", data=_npy(np.ones(3)))
        assert status == 200
        status, _ = _call(server, "/api/v1/results/newapp",
                          json_body={"schema_version": "1.0.0", "x": 1})
        assert status == 200
        result = server.result()
        assert isinstance(result, BridgeResult)
        assert result.app == "newapp"
        assert result.payload["x"] == 1
        npt.assert_array_equal(result.arrays["spikes"], np.ones(3))
    finally:
        server.shutdown()


# ---------------------------------------------------------------------------
# Generic results endpoint
# ---------------------------------------------------------------------------


def test_status_advertises_routes_and_versions(cadecon_server: BridgeServer) -> None:
    status, body = _call(cadecon_server, "/api/v1/status")
    assert status == 200
    data = json.loads(body)
    assert data["app"] == "cadecon"
    assert data["solver_version"] == calab._solver.__version__
    assert data["results"] == {
        "path": "/api/v1/results/cadecon",
        "arrays": {"activity": "/api/v1/results/cadecon/activity"},
        "schema": "cadecon-results",
        "schema_version": 2,
    }


def test_generic_route_catune(catune_server: BridgeServer) -> None:
    status, body = _call(catune_server, "/api/v1/results/catune", json_body=CATUNE_OK)
    assert status == 200
    assert json.loads(body) == {"status": "ok", "warnings": []}
    assert catune_server.result_event.is_set()
    assert catune_server.received_payload == CATUNE_OK


def test_generic_routes_cadecon_two_post(cadecon_server: BridgeServer) -> None:
    activity = np.arange(10, dtype=np.float32).reshape(2, 5)
    status, _ = _call(cadecon_server, "/api/v1/results/cadecon/activity", data=_npy(activity))
    assert status == 200
    assert not cadecon_server.result_event.is_set()
    status, _ = _call(cadecon_server, "/api/v1/results/cadecon", json_body=CADECON_OK)
    assert status == 200
    result = cadecon_server.result()
    assert result is not None
    npt.assert_array_equal(result.arrays["activity"], activity)
    # Legacy attribute names still work.
    npt.assert_array_equal(cadecon_server.received_activity, activity)
    assert cadecon_server.received_results == CADECON_OK


def test_results_for_other_app_is_409(catune_server: BridgeServer) -> None:
    status, body = _call(catune_server, "/api/v1/results/cadecon", json_body=CADECON_OK)
    assert status == 409
    assert b"serving 'catune'" in body
    assert not catune_server.result_event.is_set()


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/results/unknown",
        "/api/v1/results/cadecon/notanarray",
        "/api/v1/results/cadecon/activity/extra",
        "/api/v1/params",  # CaTune's legacy route is not CaDecon's
    ],
)
def test_unroutable_results_paths_are_404(cadecon_server: BridgeServer, path: str) -> None:
    status, _ = _call(cadecon_server, path, json_body=CADECON_OK)
    assert status == 404
    assert not cadecon_server.result_event.is_set()


def test_app_without_bridge_export_has_no_results_route() -> None:
    server = _server("carank")
    try:
        status, _ = _call(server, "/api/v1/results/carank", json_body={"schema_version": 1})
        assert status == 404
    finally:
        server.shutdown()


def test_non_object_json_is_400(catune_server: BridgeServer) -> None:
    status, _ = _call(catune_server, "/api/v1/results/catune", json_body=[1, 2])
    assert status == 400


def test_unknown_app_rejected_at_construction() -> None:
    with pytest.raises(ValueError, match="unknown CaLab app"):
        BridgeServer(np.zeros((1, 10)), fs=30.0, app="nope")


# ---------------------------------------------------------------------------
# Version handshake
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(2, (2, 0, 0)), ("2", (2, 0, 0)), ("1.2", (1, 2, 0)), ("1.2.0", (1, 2, 0)),
     ("v2.8.1", (2, 8, 1)), ("0.1.0-dev", (0, 1, 0))],
)
def test_parse_version(raw: object, expected: tuple[int, int, int]) -> None:
    assert parse_version(raw) == expected


@pytest.mark.parametrize("raw", [None, True, -1, "", "abc", "1.x", 1.5])
def test_parse_version_rejects_garbage(raw: object) -> None:
    with pytest.raises(ValueError):
        parse_version(raw)


@pytest.mark.parametrize(
    ("have", "want", "ok"),
    [((1, 3, 0), (1, 2, 0), True), ((2, 0, 0), (1, 9, 9), False),
     ((0, 1, 5), (0, 1, 0), True), ((0, 2, 0), (0, 1, 0), False)],
)
def test_is_compatible_uses_caret_rule(
    have: tuple[int, int, int], want: tuple[int, int, int], ok: bool,
) -> None:
    assert is_compatible(have, want) is ok


def test_local_solver_version_comes_from_extension() -> None:
    assert local_solver_version() == calab._solver.__version__
    assert calab._solver.protocol_version() == calab._solver.__version__


def test_handshake_accepts_exact_match() -> None:
    assert check_result(APPS["catune"], CATUNE_OK, solver_version="0.1.0") == []
    assert check_result(APPS["cadecon"], CADECON_OK, solver_version="0.1.0") == []


def test_handshake_warns_on_minor_schema_drift() -> None:
    newer = {**CATUNE_OK, "schema_version": "1.3.0"}
    (warning,) = check_result(APPS["catune"], newer, check_solver=False)
    assert "schema 1.3.0" in warning
    assert "pip install --upgrade calab" in warning
    older = {**CATUNE_OK, "schema_version": "1.1.0"}
    (warning,) = check_result(APPS["catune"], older, check_solver=False)
    assert "older" in warning


@pytest.mark.parametrize("version", ["2.0.0", "0.9.0"])
def test_handshake_rejects_catune_major_mismatch(version: str) -> None:
    payload = {**CATUNE_OK, "schema_version": version}
    with pytest.raises(BridgeVersionError, match="Incompatible CaTune results"):
        check_result(APPS["catune"], payload, check_solver=False)


def test_handshake_rejection_says_what_to_upgrade() -> None:
    with pytest.raises(BridgeVersionError, match=r"pip install --upgrade calab"):
        check_result(APPS["cadecon"], {**CADECON_OK, "schema_version": 3}, check_solver=False)
    with pytest.raises(BridgeVersionError, match=r"app_url="):
        check_result(APPS["cadecon"], {**CADECON_OK, "schema_version": 1}, check_solver=False)


@pytest.mark.parametrize("payload", [{"alphas": []}, {"schema_version": "two"}])
def test_handshake_rejects_missing_or_unreadable_schema(payload: dict) -> None:
    with pytest.raises(BridgeVersionError, match="schema_version"):
        check_result(APPS["cadecon"], payload, check_solver=False)


def test_handshake_solver_version_absent_is_not_checked() -> None:
    assert check_result(APPS["cadecon"], CADECON_OK, solver_version="9.9.9") == []


def test_handshake_solver_compatible_drift_warns() -> None:
    payload = {**CADECON_OK, "solver_version": "1.4.0"}
    (warning,) = check_result(APPS["cadecon"], payload, solver_version="1.2.0")
    assert "solver 1.4.0" in warning and "solver 1.2.0" in warning


@pytest.mark.parametrize(("app_side", "local"), [("0.2.0", "0.1.0"), ("2.0.0", "1.5.0"),
                                                 ("1.0.0", "2.0.0")])
def test_handshake_solver_incompatible_rejects(app_side: str, local: str) -> None:
    payload = {**CADECON_OK, "solver_version": app_side}
    with pytest.raises(BridgeVersionError, match="Incompatible solver"):
        check_result(APPS["cadecon"], payload, solver_version=local)


def test_server_answers_409_and_stores_error(cadecon_server: BridgeServer) -> None:
    status, body = _call(cadecon_server, "/api/v1/results/cadecon",
                         json_body={**CADECON_OK, "schema_version": 3})
    assert status == 409
    assert b"pip install --upgrade calab" in body
    assert cadecon_server.result_event.is_set()  # the waiting caller wakes up...
    assert cadecon_server.received_payload is None  # ...but nothing was accepted
    with pytest.raises(BridgeVersionError):
        cadecon_server.result()


def test_server_reports_warnings_in_response(catune_server: BridgeServer) -> None:
    status, body = _call(catune_server, "/api/v1/results/catune",
                         json_body={**CATUNE_OK, "schema_version": "1.4.0"})
    assert status == 200
    assert len(json.loads(body)["warnings"]) == 1
    result = catune_server.result()
    assert result is not None and len(result.warnings) == 1


# ---------------------------------------------------------------------------
# End to end through tune() / decon() / launch()
# ---------------------------------------------------------------------------


def _fake_browser(monkeypatch: pytest.MonkeyPatch, posts: list[tuple[str, object]]) -> None:
    """Replace webbrowser.open with a 'browser' that POSTs *posts* to the bridge.

    Each entry is ``(path, body)``: bytes are sent raw, anything else as JSON.
    """

    def open_url(url: str) -> bool:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        base, secret = query["bridge"][0], query["bridge_secret"][0]

        def run() -> None:
            for path, body in posts:
                if isinstance(body, bytes):
                    _request(base, secret, path, data=body)
                else:
                    _request(base, secret, path, json_body=body)

        threading.Thread(target=run, daemon=True).start()
        return True

    monkeypatch.setattr(_apps.webbrowser, "open", open_url)


def test_tune_wrapper_uses_legacy_route(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_browser(monkeypatch, [("/api/v1/params", CATUNE_OK)])
    params = calab.tune(np.zeros((1, 20)), fs=30.0, timeout=5)
    assert params == {
        "tau_rise": 0.02, "tau_decay": 0.4, "lambda_": 0.01, "fs": 30.0,
        "filter_enabled": True,
    }


def test_decon_wrapper_uses_generic_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    activity = np.ones((2, 20), dtype=np.float32)
    _fake_browser(monkeypatch, [
        ("/api/v1/results/cadecon/activity", _npy(activity)),
        ("/api/v1/results/cadecon", CADECON_OK),
    ])
    result = calab.decon(np.zeros((2, 20)), fs=30.0, timeout=5)
    assert result is not None
    npt.assert_array_equal(result.activity, activity)
    assert result.metadata["schema_version"] == 2


def test_tune_raises_on_incompatible_app(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_browser(monkeypatch, [("/api/v1/results/catune",
                                 {**CATUNE_OK, "schema_version": "2.0.0"})])
    with pytest.raises(calab.BridgeVersionError, match="pip install --upgrade calab"):
        calab.tune(np.zeros((1, 20)), timeout=5)


def test_launch_warns_on_drift_and_can_return_raw(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_browser(monkeypatch, [("/api/v1/results/catune",
                                 {**CATUNE_OK, "schema_version": "1.9.0"})])
    with pytest.warns(calab.BridgeVersionWarning, match="schema 1.9.0"):
        result = _apps.launch("CaTune", np.zeros((1, 20)), timeout=5, raw=True)
    assert isinstance(result, BridgeResult)
    assert result.payload["schema_version"] == "1.9.0"


def test_launch_rejects_app_without_bridge_export() -> None:
    with pytest.raises(ValueError, match="does not support the Python bridge"):
        _apps.launch("carank", np.zeros((1, 20)), timeout=1)


def test_bridge_version_warning_is_user_warning() -> None:
    assert issubclass(BridgeVersionWarning, UserWarning)
