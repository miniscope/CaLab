"""Tests for the bridge server."""

from __future__ import annotations

import json
import threading
import time
import urllib.request

import numpy as np
import numpy.testing as npt
import pytest

from calab._bridge._server import BridgeServer


def _make_server(**kwargs) -> BridgeServer:
    """Create a BridgeServer with default test traces."""
    rng = np.random.default_rng(42)
    traces = rng.standard_normal((3, 200))
    return BridgeServer(traces, fs=30.0, **kwargs)


def _start_server(server: BridgeServer) -> None:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()


@pytest.fixture
def bridge_server():
    """Start a bridge server on a random port, yield it, then shut down."""
    server = _make_server()
    _start_server(server)
    yield server
    server.shutdown()


@pytest.fixture
def cadecon_server():
    """Start a bridge server in cadecon mode on a random port."""
    server = _make_server(app="cadecon")
    _start_server(server)
    yield server
    server.shutdown()


def _get(server: BridgeServer, path: str, *, secret: bool = True) -> tuple[int, bytes]:
    """Make a GET request to the bridge server.

    ``secret=False`` omits the X-Bridge-Secret header, for tests that
    assert the server rejects unauthenticated requests.
    """
    url = f"http://127.0.0.1:{server.port}{path}"
    req = urllib.request.Request(url)
    if secret:
        req.add_header("X-Bridge-Secret", server.secret)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _post(
    server: BridgeServer, path: str, data: dict, *, secret: bool = True,
) -> tuple[int, bytes]:
    """Make a POST request to the bridge server."""
    url = f"http://127.0.0.1:{server.port}{path}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if secret:
        req.add_header("X-Bridge-Secret", server.secret)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _post_binary(
    server: BridgeServer, path: str, data: bytes, *, secret: bool = True,
) -> tuple[int, bytes]:
    """Make a POST request with binary data."""
    url = f"http://127.0.0.1:{server.port}{path}"
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/octet-stream")
    if secret:
        req.add_header("X-Bridge-Secret", server.secret)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def test_health_endpoint(bridge_server: BridgeServer) -> None:
    """GET /api/v1/health returns 200 ok."""
    status, body = _get(bridge_server, "/api/v1/health")
    assert status == 200
    assert body == b"ok"


def test_status_endpoint(bridge_server: BridgeServer) -> None:
    """GET /api/v1/status returns ready: true."""
    status, body = _get(bridge_server, "/api/v1/status")
    assert status == 200
    data = json.loads(body)
    assert data["ready"] is True
    assert data["app"] == "catune"


def test_metadata_endpoint(bridge_server: BridgeServer) -> None:
    """GET /api/v1/metadata returns correct metadata."""
    status, body = _get(bridge_server, "/api/v1/metadata")
    assert status == 200
    data = json.loads(body)
    assert data["sampling_rate_hz"] == 30.0
    assert data["num_cells"] == 3
    assert data["num_timepoints"] == 200


def test_traces_endpoint(bridge_server: BridgeServer) -> None:
    """GET /api/v1/traces returns a valid .npy array."""
    status, body = _get(bridge_server, "/api/v1/traces")
    assert status == 200

    # Parse the .npy binary
    import io

    arr = np.load(io.BytesIO(body))
    assert arr.shape == (3, 200)
    assert arr.dtype == np.float64
    npt.assert_allclose(arr, bridge_server.traces)


def test_params_post(bridge_server: BridgeServer) -> None:
    """POST /api/v1/params stores params and triggers event."""
    params = {
        "parameters": {
            "tau_rise_s": 0.02,
            "tau_decay_s": 0.4,
            "lambda": 0.01,
            "sampling_rate_hz": 30.0,
            "filter_enabled": False,
        }
    }

    status, body = _post(bridge_server, "/api/v1/params", params)
    assert status == 200

    # Event should be set
    assert bridge_server.params_event.is_set()
    assert bridge_server.received_params == params


def test_params_event_wait(bridge_server: BridgeServer) -> None:
    """params_event.wait() returns True after POST."""
    params = {"parameters": {"tau_rise_s": 0.05}}

    # Post in background
    def post_later():
        time.sleep(0.1)
        _post(bridge_server, "/api/v1/params", params)

    threading.Thread(target=post_later, daemon=True).start()

    # Wait for params
    received = bridge_server.params_event.wait(timeout=5)
    assert received is True
    assert bridge_server.received_params is not None


def test_404_on_unknown_path(bridge_server: BridgeServer) -> None:
    """Unknown path returns 404."""
    status, _ = _get(bridge_server, "/api/v1/nonexistent")
    assert status == 404


def test_cors_headers(bridge_server: BridgeServer) -> None:
    """Responses include CORS headers."""
    url = f"http://127.0.0.1:{bridge_server.port}/api/v1/health"
    req = urllib.request.Request(url)
    req.add_header("X-Bridge-Secret", bridge_server.secret)
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.headers["Access-Control-Allow-Origin"] == "*"


def test_heartbeat_endpoint(bridge_server: BridgeServer) -> None:
    """POST /api/v1/heartbeat returns ok and updates last_heartbeat."""
    assert bridge_server.last_heartbeat is None

    status, body = _post(bridge_server, "/api/v1/heartbeat", {})
    assert status == 200
    data = json.loads(body)
    assert data["status"] == "ok"
    assert bridge_server.last_heartbeat is not None


def test_heartbeat_updates_timestamp(bridge_server: BridgeServer) -> None:
    """Multiple heartbeats update the timestamp."""
    _post(bridge_server, "/api/v1/heartbeat", {})
    first = bridge_server.last_heartbeat

    time.sleep(0.05)
    _post(bridge_server, "/api/v1/heartbeat", {})
    second = bridge_server.last_heartbeat

    assert second is not None
    assert first is not None
    assert second > first


def test_heartbeat_timeout_detection(bridge_server: BridgeServer) -> None:
    """A stale last_heartbeat is detected as exceeding HEARTBEAT_TIMEOUT."""
    from calab._bridge._apps import HEARTBEAT_TIMEOUT

    # Simulate a heartbeat that arrived long ago
    bridge_server.last_heartbeat = time.monotonic() - HEARTBEAT_TIMEOUT - 1

    since_last = time.monotonic() - bridge_server.last_heartbeat
    assert since_last > HEARTBEAT_TIMEOUT


# --- CaDecon bridge tests ---


def test_status_cadecon(cadecon_server: BridgeServer) -> None:
    """GET /api/v1/status returns app: cadecon."""
    status, body = _get(cadecon_server, "/api/v1/status")
    assert status == 200
    data = json.loads(body)
    assert data["ready"] is True
    assert data["app"] == "cadecon"


def test_results_activity_post(cadecon_server: BridgeServer) -> None:
    """POST /api/v1/results/activity stores a .npy array."""
    import io as sysio

    activity = np.random.default_rng(0).standard_normal((3, 100)).astype(np.float32)
    buf = sysio.BytesIO()
    np.save(buf, activity)
    npy_bytes = buf.getvalue()

    status, body = _post_binary(cadecon_server, "/api/v1/results/activity", npy_bytes)
    assert status == 200
    assert cadecon_server.received_activity is not None
    npt.assert_allclose(cadecon_server.received_activity, activity, atol=1e-6)


def test_results_json_post(cadecon_server: BridgeServer) -> None:
    """POST /api/v1/results stores JSON and triggers results_event."""
    results = {"alphas": [1.0, 2.0], "fs": 30.0, "tau_rise": 0.2}

    status, body = _post(cadecon_server, "/api/v1/results", results)
    assert status == 200
    assert cadecon_server.results_event.is_set()
    assert cadecon_server.received_results == results


def test_results_two_post_sequence(cadecon_server: BridgeServer) -> None:
    """Full two-POST flow: activity first, then JSON results."""
    import io as sysio

    # 1. POST activity
    activity = np.ones((2, 50), dtype=np.float32)
    buf = sysio.BytesIO()
    np.save(buf, activity)
    status, _ = _post_binary(cadecon_server, "/api/v1/results/activity", buf.getvalue())
    assert status == 200

    # results_event should NOT be set yet
    assert not cadecon_server.results_event.is_set()

    # 2. POST results JSON
    results = {"alphas": [1.0, 1.0], "fs": 30.0}
    status, _ = _post(cadecon_server, "/api/v1/results", results)
    assert status == 200

    # Now both should be stored
    assert cadecon_server.results_event.is_set()
    assert cadecon_server.received_activity is not None
    assert cadecon_server.received_results == results
    npt.assert_array_equal(cadecon_server.received_activity, activity)


def test_invalid_npy_returns_400(cadecon_server: BridgeServer) -> None:
    """Garbage bytes to /api/v1/results/activity returns 400."""
    status, body = _post_binary(
        cadecon_server, "/api/v1/results/activity", b"not-a-npy-file",
    )
    assert status == 400


# --- Config endpoint tests ---


@pytest.fixture
def config_server():
    """Start a bridge server with config on a random port."""
    config = {"autorun": True, "max_iterations": 10}
    server = _make_server(app="cadecon", config=config)
    _start_server(server)
    yield server
    server.shutdown()


def test_config_endpoint_empty(cadecon_server: BridgeServer) -> None:
    """GET /api/v1/config with no config returns default autorun=false."""
    status, body = _get(cadecon_server, "/api/v1/config")
    assert status == 200
    data = json.loads(body)
    assert data == {"autorun": False}


def test_config_endpoint_with_params(config_server: BridgeServer) -> None:
    """GET /api/v1/config returns the exact config dict."""
    status, body = _get(config_server, "/api/v1/config")
    assert status == 200
    data = json.loads(body)
    assert data == {"autorun": True, "max_iterations": 10}


def test_progress_endpoint(cadecon_server: BridgeServer) -> None:
    """POST /api/v1/progress stores to latest_progress."""
    progress = {
        "iteration": 3,
        "max_iterations": 20,
        "phase": "inference",
        "phase_progress": 0.75,
        "tau_rise": 0.045,
        "tau_decay": 0.38,
        "status": "running",
    }
    status, body = _post(cadecon_server, "/api/v1/progress", progress)
    assert status == 200
    data = json.loads(body)
    assert data["status"] == "ok"
    assert cadecon_server.latest_progress == progress


def test_progress_invalid_json(cadecon_server: BridgeServer) -> None:
    """POST /api/v1/progress with invalid JSON returns 400."""
    url = f"http://127.0.0.1:{cadecon_server.port}/api/v1/progress"
    req = urllib.request.Request(url, data=b"not json", method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Bridge-Secret", cadecon_server.secret)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
    assert status == 400


# --- DeconConfig model tests ---


def test_decon_config_validation() -> None:
    """Pydantic rejects invalid values."""
    from calab._bridge._models import DeconConfig

    with pytest.raises(Exception):  # noqa: B017
        DeconConfig(max_iterations=0)

    with pytest.raises(Exception):  # noqa: B017
        DeconConfig(max_iterations=201)

    with pytest.raises(Exception):  # noqa: B017
        DeconConfig(convergence_tol=0)

    with pytest.raises(Exception):  # noqa: B017
        DeconConfig(convergence_tol=1.0)

    with pytest.raises(Exception):  # noqa: B017
        DeconConfig(target_coverage=0)


def test_decon_config_serialization() -> None:
    """model_dump(exclude_none=True) omits unset optional fields."""
    from calab._bridge._models import DeconConfig

    config = DeconConfig(autorun=True, max_iterations=10)
    dumped = config.model_dump(exclude_none=True)
    assert dumped == {"autorun": True, "max_iterations": 10}
    assert "upsample_target" not in dumped
    assert "seed" not in dumped


# --- Auth (X-Bridge-Secret) and PNA preflight tests ---


def test_secret_is_generated_and_not_trivial() -> None:
    """Every BridgeServer gets a fresh, non-guessable secret."""
    s1 = _make_server()
    s2 = _make_server()
    try:
        assert s1.secret != s2.secret
        assert len(s1.secret) >= 32  # hex-encoded, at least 16 random bytes
        assert set(s1.secret).issubset(set("0123456789abcdef"))
    finally:
        s1.server_close()
        s2.server_close()


def test_get_without_secret_returns_401(bridge_server: BridgeServer) -> None:
    """Requests lacking X-Bridge-Secret are rejected with 401."""
    status, body = _get(bridge_server, "/api/v1/health", secret=False)
    assert status == 401
    assert b"invalid or missing bridge secret" in body


def test_get_with_wrong_secret_returns_401(bridge_server: BridgeServer) -> None:
    """Requests with the wrong X-Bridge-Secret are rejected with 401."""
    url = f"http://127.0.0.1:{bridge_server.port}/api/v1/health"
    req = urllib.request.Request(url)
    req.add_header("X-Bridge-Secret", "deadbeef" * 8)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            status = resp.status
            body = resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read()
    assert status == 401
    assert b"invalid or missing bridge secret" in body


def test_post_without_secret_returns_401(bridge_server: BridgeServer) -> None:
    """POST endpoints also enforce the secret."""
    status, _ = _post(bridge_server, "/api/v1/params", {"foo": "bar"}, secret=False)
    assert status == 401
    # Payload must NOT have been recorded on a rejected request.
    assert bridge_server.received_params is None


def test_traces_without_secret_returns_401(bridge_server: BridgeServer) -> None:
    """Sensitive trace data is guarded by the secret too."""
    status, _ = _get(bridge_server, "/api/v1/traces", secret=False)
    assert status == 401


def test_options_preflight_exempt_from_secret(bridge_server: BridgeServer) -> None:
    """CORS preflights have no way to carry custom headers and must be allowed."""
    url = f"http://127.0.0.1:{bridge_server.port}/api/v1/traces"
    req = urllib.request.Request(url, method="OPTIONS")
    req.add_header("Origin", "https://miniscope.github.io")
    req.add_header("Access-Control-Request-Method", "GET")
    req.add_header("Access-Control-Request-Headers", "x-bridge-secret")
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200
        allow_headers = resp.headers.get("Access-Control-Allow-Headers", "")
        assert "X-Bridge-Secret" in allow_headers


def test_options_preflight_echoes_private_network_when_requested(
    bridge_server: BridgeServer,
) -> None:
    """PNA preflights (Chrome 124+) must be answered affirmatively.

    Without this, an HTTPS-hosted page cannot reach the localhost
    bridge server — the SEC-1 workaround of launching headless Chromium
    with --disable-web-security would still be required. This test
    pins the PNA behavior so the flag can stay off.
    """
    url = f"http://127.0.0.1:{bridge_server.port}/api/v1/traces"
    req = urllib.request.Request(url, method="OPTIONS")
    req.add_header("Origin", "https://miniscope.github.io")
    req.add_header("Access-Control-Request-Method", "GET")
    req.add_header("Access-Control-Request-Private-Network", "true")
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.headers.get("Access-Control-Allow-Private-Network") == "true"


def test_options_without_pna_request_omits_pna_header(bridge_server: BridgeServer) -> None:
    """Don't opt into PNA when the client isn't asking for it."""
    url = f"http://127.0.0.1:{bridge_server.port}/api/v1/traces"
    req = urllib.request.Request(url, method="OPTIONS")
    req.add_header("Origin", "https://miniscope.github.io")
    req.add_header("Access-Control-Request-Method", "GET")
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.headers.get("Access-Control-Allow-Private-Network") is None


# --- Cross-language schema consistency tests ---


def test_config_schema_matches_fixture() -> None:
    """DeconConfig round-trips through the shared fixture."""
    import pathlib

    from calab._bridge._models import DeconConfig

    fixture_path = (
        pathlib.Path(__file__).resolve().parents[2]
        / "packages" / "io" / "src" / "__fixtures__" / "decon-config-full.json"
    )
    fixture = json.loads(fixture_path.read_text())
    config = DeconConfig(**fixture)
    assert config.model_dump() == fixture


def test_config_field_names_match_fixture() -> None:
    """DeconConfig field names exactly match the fixture keys."""
    import pathlib

    from calab._bridge._models import DeconConfig

    fixture_path = (
        pathlib.Path(__file__).resolve().parents[2]
        / "packages" / "io" / "src" / "__fixtures__" / "decon-config-full.json"
    )
    fixture = json.loads(fixture_path.read_text())
    assert set(DeconConfig.model_fields.keys()) == set(fixture.keys())
