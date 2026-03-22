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


def _get(server: BridgeServer, path: str) -> tuple[int, bytes]:
    """Make a GET request to the bridge server."""
    url = f"http://127.0.0.1:{server.port}{path}"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _post(server: BridgeServer, path: str, data: dict) -> tuple[int, bytes]:
    """Make a POST request to the bridge server."""
    url = f"http://127.0.0.1:{server.port}{path}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _post_binary(server: BridgeServer, path: str, data: bytes) -> tuple[int, bytes]:
    """Make a POST request with binary data."""
    url = f"http://127.0.0.1:{server.port}{path}"
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/octet-stream")
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
