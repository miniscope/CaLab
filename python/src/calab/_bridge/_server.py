"""Localhost HTTP bridge server for CaLab <-> Python communication.

Serves traces as .npy binary and receives exported params/results.
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


class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP handler for the bridge server."""

    server: "BridgeServer"

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
            self._send_json({"ready": True, "app": self.server.app})
        elif self.path == "/api/v1/health":
            self._send_cors_response(b"ok", content_type="text/plain")
        else:
            self.send_error(404, "Not Found")

    def do_POST(self) -> None:
        if not self._check_secret():
            return
        if self.path == "/api/v1/params":
            self._receive_params()
        elif self.path == "/api/v1/heartbeat":
            self.server.last_heartbeat = time.monotonic()
            self._send_json({"status": "ok"})
        elif self.path == "/api/v1/progress":
            self._receive_progress()
        elif self.path == "/api/v1/results/activity":
            self._receive_results_activity()
        elif self.path == "/api/v1/results":
            self._receive_results()
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

    def _receive_params(self) -> None:
        """Receive exported params JSON from web app."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            params = json.loads(body)
        except json.JSONDecodeError:
            self._send_error_cors(400, "Invalid JSON")
            return

        self.server.received_params = params
        self.server.params_event.set()
        self._send_json({"status": "ok"})

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

    def _receive_results_activity(self) -> None:
        """Receive activity matrix as .npy binary from CaDecon."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            arr = np.load(io.BytesIO(body))
        except Exception:
            self._send_error_cors(400, "Invalid .npy data")
            return

        self.server.received_activity = arr
        self._send_json({"status": "ok"})

    def _receive_results(self) -> None:
        """Receive CaDecon results JSON (scalars + metadata). Triggers completion event."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            results = json.loads(body)
        except json.JSONDecodeError:
            self._send_error_cors(400, "Invalid JSON")
            return

        self.server.received_results = results
        self.server.results_event.set()
        self._send_json({"status": "ok"})


class BridgeServer(HTTPServer):
    """HTTP server that holds trace data and waits for params/results."""

    def __init__(
        self,
        traces: np.ndarray,
        fs: float,
        port: int = 0,
        app: str = "catune",
        config: dict | None = None,
        secret: str | None = None,
    ) -> None:
        self.traces = np.atleast_2d(np.asarray(traces, dtype=np.float64))
        self.fs = fs
        self.app = app
        self.config: dict = config if config is not None else {"autorun": False}
        self.latest_progress: dict | None = None
        self.received_params: dict | None = None
        self.params_event = threading.Event()
        self.last_heartbeat: float | None = None
        # CaDecon results (two-POST pattern)
        self.received_activity: np.ndarray | None = None
        self.received_results: dict | None = None
        self.results_event = threading.Event()
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
