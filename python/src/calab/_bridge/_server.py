"""Localhost HTTP bridge server for CaTune <-> Python communication.

Serves traces as .npy binary and receives exported params as JSON.
Binds to 127.0.0.1 only (not network-reachable). CORS enabled for
HTTPS→localhost mixed-content requests.
"""

from __future__ import annotations

import io
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import numpy as np


class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP handler for the bridge server."""

    server: "BridgeServer"

    def log_message(self, format: str, *args: Any) -> None:
        """Suppress default stderr logging."""
        pass

    def _set_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight."""
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/v1/traces":
            self._serve_traces()
        elif self.path == "/api/v1/metadata":
            self._serve_metadata()
        elif self.path == "/api/v1/status":
            self._serve_status()
        elif self.path == "/api/v1/health":
            self._serve_health()
        else:
            self.send_error(404, "Not Found")

    def do_POST(self) -> None:
        if self.path == "/api/v1/params":
            self._receive_params()
        else:
            self.send_error(404, "Not Found")

    def _serve_traces(self) -> None:
        """Serve traces as .npy binary."""
        buf = io.BytesIO()
        np.save(buf, self.server.traces)
        data = buf.getvalue()

        self.send_response(200)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_metadata(self) -> None:
        """Serve metadata as JSON."""
        meta = {
            "sampling_rate_hz": self.server.fs,
            "num_cells": int(self.server.traces.shape[0]),
            "num_timepoints": int(self.server.traces.shape[1]),
        }
        data = json.dumps(meta).encode()

        self.send_response(200)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_status(self) -> None:
        """Serve status."""
        data = json.dumps({"ready": True, "app": "catune"}).encode()

        self.send_response(200)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_health(self) -> None:
        """Liveness check."""
        self.send_response(200)
        self._set_cors_headers()
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def _receive_params(self) -> None:
        """Receive exported params JSON from web app."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            params = json.loads(body)
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        self.server.received_params = params
        self.server.params_event.set()

        self.send_response(200)
        self._set_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok"}).encode())


class BridgeServer(HTTPServer):
    """HTTP server that holds trace data and waits for params."""

    def __init__(
        self,
        traces: np.ndarray,
        fs: float,
        port: int = 0,
    ) -> None:
        self.traces = np.atleast_2d(np.asarray(traces, dtype=np.float64))
        self.fs = fs
        self.received_params: dict | None = None
        self.params_event = threading.Event()

        super().__init__(("127.0.0.1", port), BridgeHandler)

    @property
    def port(self) -> int:
        return self.server_address[1]


def find_free_port() -> int:
    """Find an available port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
