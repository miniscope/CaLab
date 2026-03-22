"""Localhost HTTP bridge server for CaLab <-> Python communication.

Serves traces as .npy binary and receives exported params/results.
Binds to 127.0.0.1 only (not network-reachable). CORS enabled for
HTTPS->localhost mixed-content requests.
"""

from __future__ import annotations

import io
import json
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

    def _send_cors_response(
        self, data: bytes, content_type: str = "application/json",
    ) -> None:
        """Send a 200 response with CORS headers and body."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight."""
        self._send_cors_response(b"", content_type="text/plain")

    def do_GET(self) -> None:
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

        super().__init__(("127.0.0.1", port), BridgeHandler)

    @property
    def port(self) -> int:
        return self.server_address[1]
