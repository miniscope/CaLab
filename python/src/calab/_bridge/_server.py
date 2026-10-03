"""Localhost HTTP bridge server for CaLab <-> Python communication.

Serves traces as .npy binary and receives exported results. One server
runs one app session; the app is looked up in the registry
(:mod:`._registry`), which supplies everything app-specific:

* ``POST /api/v1/results/{app}`` -- JSON results; the completion signal.
  Version-checked by :mod:`._handshake` before it is accepted (409 on an
  incompatible version).
* ``POST /api/v1/results/{app}/{array}`` -- a ``.npy`` array the app
  uploads before its JSON (CaDecon's ``activity``).
* The pre-registry routes the deployed apps still use
  (``/api/v1/params``, ``/api/v1/results``, ``/api/v1/results/activity``)
  are kept as aliases for the matching app's generic routes.

Binds to 127.0.0.1 only (not network-reachable). Every request must
include an ``X-Bridge-Secret`` header matching the server's per-run
secret — prevents other local tabs/processes from reading the served
trace data or spoofing results. CORS + Private Network Access
preflights are handled so an HTTPS page can reach the localhost
server without needing ``--disable-web-security`` on the browser.
"""

from __future__ import annotations

import hmac
import io
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import numpy as np

from ._handshake import (
    BridgeResult,
    BridgeVersionError,
    check_result,
    local_calab_version,
    local_solver_version,
)
from ._registry import APPS, RESERVED_SLUGS, AppSpec, get_app

_RESULTS_PREFIX = "/api/v1/results/"


class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP handler for the bridge server."""

    server: BridgeServer

    def log_message(self, format: str, *args: Any) -> None:
        """Suppress default stderr logging."""

    def _cors_headers(self) -> dict[str, str]:
        """Headers common to every CORS response."""
        return {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Bridge-Secret",
        }

    def _send_cors_response(
        self, data: bytes, content_type: str = "application/json",
    ) -> None:
        """Send a 200 response with CORS headers and body."""
        self.send_response(200)
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, obj: Any) -> None:
        """Send a JSON-serializable object as a CORS response."""
        self._send_cors_response(json.dumps(obj).encode())

    def _send_error_cors(self, code: int, message: str) -> None:
        """Send an error response with CORS headers."""
        body = json.dumps({"error": message}).encode()
        self.send_response(code)
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_secret(self) -> bool:
        """Constant-time check of the X-Bridge-Secret header.

        Returns True when the header matches the server's secret. On
        mismatch, responds with 401 and returns False — callers should
        short-circuit any further work.
        """
        presented = self.headers.get("X-Bridge-Secret", "")
        if hmac.compare_digest(presented, self.server.secret):
            return True
        self._send_error_cors(401, "invalid or missing bridge secret")
        return False

    def do_OPTIONS(self) -> None:
        """Handle CORS + Private Network Access preflight.

        Preflights carry no request body and no X-Bridge-Secret header
        (the browser issues them automatically before the real request),
        so they must be answered without the secret check. The real
        request that follows is secret-checked like any other.
        """
        headers = self._cors_headers()
        # Private Network Access: browsers (Chrome 124+) send
        # `Access-Control-Request-Private-Network: true` when a
        # public-origin page tries to reach a private network (e.g.
        # HTTPS page → 127.0.0.1). The server must opt in by echoing
        # `Access-Control-Allow-Private-Network: true`, otherwise the
        # request is blocked.
        if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
            headers["Access-Control-Allow-Private-Network"] = "true"

        self.send_response(200)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if not self._check_secret():
            return
        if self.path == "/api/v1/traces":
            self._serve_traces()
        elif self.path == "/api/v1/metadata":
            self._serve_metadata()
        elif self.path == "/api/v1/config":
            self._send_json(self.server.config)
        elif self.path == "/api/v1/status":
            self._send_json(self.server.status())
        elif self.path == "/api/v1/health":
            self._send_cors_response(b"ok", content_type="text/plain")
        else:
            self.send_error(404, "Not Found")

    def do_POST(self) -> None:
        if not self._check_secret():
            return
        if self.path == "/api/v1/heartbeat":
            self.server.last_heartbeat = time.monotonic()
            self._send_json({"status": "ok"})
        elif self.path == "/api/v1/progress":
            self._receive_progress()
        else:
            self._route_results()

    def _route_results(self) -> None:
        """Dispatch a POST to the results JSON or array handler, or 404/409."""
        spec = self.server.app_spec
        path = self.path
        if spec.result_schema is not None:
            if path in spec.legacy_result_paths:
                self._receive_results()
                return
            # Legacy array route: /api/v1/results/activity (reserved names only).
            if path.startswith(_RESULTS_PREFIX):
                name = path[len(_RESULTS_PREFIX):]
                if name in RESERVED_SLUGS and name in spec.arrays:
                    self._receive_array(name)
                    return

        if not path.startswith(_RESULTS_PREFIX):
            self.send_error(404, "Not Found")
            return
        parts = path[len(_RESULTS_PREFIX):].split("/")
        slug = parts[0]
        if slug != spec.slug:
            if slug in APPS:
                self._send_error_cors(
                    409, f"this bridge session is serving {spec.slug!r}, not {slug!r}",
                )
            else:
                self.send_error(404, "Not Found")
            return
        if spec.result_schema is None:
            self._send_error_cors(404, f"{spec.slug!r} has no bridge results endpoint")
        elif len(parts) == 1:
            self._receive_results()
        elif len(parts) == 2 and parts[1] in spec.arrays:
            self._receive_array(parts[1])
        else:
            self.send_error(404, "Not Found")

    def _serve_traces(self) -> None:
        """Serve traces as .npy binary."""
        buf = io.BytesIO()
        np.save(buf, self.server.traces)
        self._send_cors_response(buf.getvalue(), content_type="application/octet-stream")

    def _serve_metadata(self) -> None:
        """Serve metadata as JSON."""
        self._send_json({
            "sampling_rate_hz": self.server.fs,
            "num_cells": int(self.server.traces.shape[0]),
            "num_timepoints": int(self.server.traces.shape[1]),
        })

    def _receive_progress(self) -> None:
        """Receive a progress update from the browser."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            progress = json.loads(body)
        except json.JSONDecodeError:
            self._send_error_cors(400, "Invalid JSON")
            return

        self.server.latest_progress = progress
        self._send_json({"status": "ok"})

    def _receive_array(self, name: str) -> None:
        """Receive a ``.npy`` array the app uploads before its JSON results."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            arr = np.load(io.BytesIO(body))
        except Exception:
            self._send_error_cors(400, "Invalid .npy data")
            return

        self.server.received_arrays[name] = arr
        self._send_json({"status": "ok"})

    def _receive_results(self) -> None:
        """Receive the app's JSON results, run the version handshake, and
        trigger the completion event.

        An incompatible payload is answered with 409 and the error is stored
        on the server so the waiting Python call raises it; the event fires
        either way so the caller stops waiting.
        """
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._send_error_cors(400, "Invalid JSON")
            return
        if not isinstance(payload, dict):
            self._send_error_cors(400, "Results must be a JSON object")
            return

        server = self.server
        try:
            warnings = check_result(
                server.app_spec, payload, solver_version=server.solver_version,
            )
        except BridgeVersionError as exc:
            server.result_error = exc
            server.result_event.set()
            self._send_error_cors(409, str(exc))
            return

        server.received_payload = payload
        server.handshake_warnings = warnings
        server.result_event.set()
        self._send_json({"status": "ok", "warnings": warnings})


class BridgeServer(HTTPServer):
    """HTTP server that holds trace data and waits for one app's results."""

    def __init__(
        self,
        traces: np.ndarray,
        fs: float,
        port: int = 0,
        app: str = "catune",
        config: dict | None = None,
        secret: str | None = None,
    ) -> None:
        self.app_spec: AppSpec = get_app(app)
        self.app = self.app_spec.slug
        self.traces = np.atleast_2d(np.asarray(traces, dtype=np.float64))
        self.fs = fs
        self.config: dict = config if config is not None else {"autorun": False}
        self.latest_progress: dict | None = None
        self.last_heartbeat: float | None = None
        # Results: zero or more .npy arrays, then the JSON payload, which sets
        # the event. A payload that fails the handshake sets `result_error`
        # instead of `received_payload`.
        self.received_arrays: dict[str, np.ndarray] = {}
        self.received_payload: dict | None = None
        self.handshake_warnings: list[str] = []
        self.result_error: BridgeVersionError | None = None
        self.result_event = threading.Event()
        # Local solver version for the handshake, resolved once per session.
        self.solver_version: str | None = local_solver_version()
        # Per-run secret. Each BridgeServer gets a fresh 32-byte token that
        # the opened URL passes to the browser via ?bridge_secret=...; every
        # bridge HTTP request must echo it back in the X-Bridge-Secret
        # header. Prevents other tabs/processes on the same machine from
        # reading the served trace data or spoofing results.
        self.secret: str = secret if secret is not None else secrets.token_hex(32)

        super().__init__(("127.0.0.1", port), BridgeHandler)

    @property
    def port(self) -> int:
        return self.server_address[1]

    def status(self) -> dict[str, Any]:
        """``GET /api/v1/status`` body: the session's app and what it expects."""
        spec = self.app_spec
        body: dict[str, Any] = {
            "ready": True,
            "app": spec.slug,
            "calab_version": local_calab_version(),
            "solver_version": self.solver_version,
        }
        if spec.result_schema is not None:
            body["results"] = {
                "path": spec.result_path,
                "arrays": {name: spec.array_path(name) for name in spec.arrays},
                "schema": spec.result_schema.name,
                "schema_version": spec.result_schema.version,
            }
        return body

    def result(self) -> BridgeResult | None:
        """The received results, or None if none arrived.

        Raises
        ------
        BridgeVersionError
            If the app's results failed the version handshake.
        """
        if self.result_error is not None:
            raise self.result_error
        if self.received_payload is None:
            return None
        return BridgeResult(
            app=self.app,
            payload=self.received_payload,
            arrays=dict(self.received_arrays),
            warnings=list(self.handshake_warnings),
        )

    # -- Pre-registry attribute names, kept for callers of the old API. --

    @property
    def params_event(self) -> threading.Event:
        """Alias of :attr:`result_event` (was CaTune's completion event)."""
        return self.result_event

    @property
    def results_event(self) -> threading.Event:
        """Alias of :attr:`result_event` (was CaDecon's completion event)."""
        return self.result_event

    @property
    def received_params(self) -> dict | None:
        """Alias of :attr:`received_payload` (was CaTune's payload)."""
        return self.received_payload

    @property
    def received_results(self) -> dict | None:
        """Alias of :attr:`received_payload` (was CaDecon's payload)."""
        return self.received_payload

    @property
    def received_activity(self) -> np.ndarray | None:
        """The ``activity`` array, if the app uploaded one."""
        return self.received_arrays.get("activity")
