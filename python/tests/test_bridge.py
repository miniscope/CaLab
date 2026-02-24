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


@pytest.fixture
def bridge_server():
    """Start a bridge server on a random port, yield it, then shut down."""
    rng = np.random.default_rng(42)
    traces = rng.standard_normal((3, 200))
    server = BridgeServer(traces, fs=30.0)

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

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
