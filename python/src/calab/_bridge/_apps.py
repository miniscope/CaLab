"""Bridge orchestrator: tune() function that opens CaTune and returns params."""

from __future__ import annotations

import threading
import time
import webbrowser

import numpy as np

from ._server import BridgeServer

HEARTBEAT_TIMEOUT = 10  # seconds without heartbeat = browser disconnected

# Default CaTune URL (GitHub Pages deployment)
_DEFAULT_APP_URL = "https://miniscope.github.io/CaLab/CaTune/"


def tune(
    traces: np.ndarray,
    fs: float = 30.0,
    timeout: float | None = None,
    port: int | None = None,
    app_url: str | None = None,
    open_browser: bool = True,
) -> dict | None:
    """Open CaTune in the browser for interactive parameter tuning.

    Starts a localhost HTTP server serving the provided traces, opens
    CaTune with a ``?bridge=`` parameter pointing to the server, and
    waits for the user to export parameters from the web app.

    Parameters
    ----------
    traces : np.ndarray
        Calcium traces, shape ``(n_cells, n_timepoints)`` or ``(n_timepoints,)``.
    fs : float
        Sampling rate in Hz. Default: 30.0.
    timeout : float, optional
        Seconds to wait for params. None = wait forever (until Ctrl-C).
    port : int, optional
        Port to bind to. None = auto-assign.
    app_url : str, optional
        Override CaTune URL (for local dev). Default: GitHub Pages.
    open_browser : bool
        Whether to auto-open the browser. Default: True.

    Returns
    -------
    dict or None
        Exported parameters dict if received, None if timeout/cancelled.
        Keys: ``tau_rise``, ``tau_decay``, ``lambda_``, ``fs``, ``filter_enabled``.
    """
    server = BridgeServer(traces, fs, port=port or 0)
    actual_port = server.port

    # Start server in daemon thread
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    url = app_url or _DEFAULT_APP_URL
    bridge_param = f"http://127.0.0.1:{actual_port}"
    full_url = f"{url}?bridge={bridge_param}"

    print(f"Bridge server running on http://127.0.0.1:{actual_port}")
    print(f"Opening CaTune: {full_url}")

    if open_browser:
        webbrowser.open(full_url)

    received = False
    start_time = time.monotonic()
    try:
        while True:
            if server.params_event.wait(timeout=1.0):
                received = True
                break

            # Check user-specified timeout
            if timeout is not None:
                elapsed = time.monotonic() - start_time
                if elapsed >= timeout:
                    break

            # Check heartbeat staleness (only after first heartbeat arrives)
            if server.last_heartbeat is not None:
                since_last = time.monotonic() - server.last_heartbeat
                if since_last > HEARTBEAT_TIMEOUT:
                    print("\nBrowser disconnected (heartbeat timeout).")
                    break
    except KeyboardInterrupt:
        print("\nBridge cancelled by user.")
    finally:
        server.shutdown()

    if received and server.received_params is not None:
        raw = server.received_params
        # Normalize parameter keys from CaTune export format
        params = raw.get("parameters", raw)
        return {
            "tau_rise": params.get("tau_rise_s", params.get("tau_rise")),
            "tau_decay": params.get("tau_decay_s", params.get("tau_decay")),
            "lambda_": params.get("lambda", params.get("lambda_")),
            "fs": params.get("sampling_rate_hz", params.get("fs", fs)),
            "filter_enabled": params.get("filter_enabled", False),
        }

    return None
