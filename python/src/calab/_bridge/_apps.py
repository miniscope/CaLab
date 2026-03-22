"""Bridge orchestrators: tune() and decon() functions for CaTune/CaDecon."""

from __future__ import annotations

import threading
import time
import webbrowser

import numpy as np

from ._server import BridgeServer

HEARTBEAT_TIMEOUT = 10  # seconds without heartbeat = browser disconnected

# Default app URLs (GitHub Pages deployment)
_DEFAULT_CATUNE_URL = "https://miniscope.github.io/CaLab/CaTune/"
_DEFAULT_CADECON_URL = "https://miniscope.github.io/CaLab/CaDecon/"


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

    url = app_url or _DEFAULT_CATUNE_URL
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

            now = time.monotonic()

            if timeout is not None and (now - start_time) >= timeout:
                break

            # Detect browser disconnect (only after first heartbeat arrives)
            if server.last_heartbeat is not None:
                if (now - server.last_heartbeat) > HEARTBEAT_TIMEOUT:
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


def decon(
    traces: np.ndarray,
    fs: float = 30.0,
    timeout: float | None = None,
    port: int | None = None,
    app_url: str | None = None,
    open_browser: bool = True,
):
    """Open CaDecon in the browser for automated deconvolution.

    Starts a localhost HTTP server serving the provided traces, opens
    CaDecon with a ``?bridge=`` parameter pointing to the server, and
    waits for the browser to export deconvolution results back.

    Parameters
    ----------
    traces : np.ndarray
        Calcium traces, shape ``(n_cells, n_timepoints)`` or ``(n_timepoints,)``.
    fs : float
        Sampling rate in Hz. Default: 30.0.
    timeout : float, optional
        Seconds to wait for results. None = wait forever (until Ctrl-C).
    port : int, optional
        Port to bind to. None = auto-assign.
    app_url : str, optional
        Override CaDecon URL (for local dev). Default: GitHub Pages.
    open_browser : bool
        Whether to auto-open the browser. Default: True.

    Returns
    -------
    CaDeconResult or None
        Deconvolution results if received, None if timeout/cancelled.
    """
    from .._compute import CaDeconResult, _build_biexp_waveform

    server = BridgeServer(traces, fs, port=port or 0, app="cadecon")
    actual_port = server.port

    # Start server in daemon thread
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    url = app_url or _DEFAULT_CADECON_URL
    bridge_param = f"http://127.0.0.1:{actual_port}"
    full_url = f"{url}?bridge={bridge_param}"

    print(f"Bridge server running on http://127.0.0.1:{actual_port}")
    print(f"Opening CaDecon: {full_url}")

    if open_browser:
        webbrowser.open(full_url)

    received = False
    start_time = time.monotonic()
    try:
        while True:
            if server.results_event.wait(timeout=1.0):
                received = True
                break

            now = time.monotonic()

            if timeout is not None and (now - start_time) >= timeout:
                break

            if server.last_heartbeat is not None:
                if (now - server.last_heartbeat) > HEARTBEAT_TIMEOUT:
                    print("\nBrowser disconnected (heartbeat timeout).")
                    break
    except KeyboardInterrupt:
        print("\nBridge cancelled by user.")
    finally:
        server.shutdown()

    if not received or server.received_results is None:
        return None

    results = server.received_results
    activity = server.received_activity
    if activity is None:
        print("Warning: results received but activity matrix was missing.")
        return None

    # Build kernel waveforms from biexp params
    result_fs = results.get("fs", fs)
    tau_rise = results.get("tau_rise", 0.2)
    tau_decay = results.get("tau_decay", 1.0)
    beta = results.get("beta", 1.0)
    kernel_length = int(5.0 * tau_decay * result_fs)
    kernel_slow = _build_biexp_waveform(tau_rise, tau_decay, beta, result_fs, kernel_length)

    tau_rise_fast = results.get("tau_rise_fast", 0.0)
    tau_decay_fast = results.get("tau_decay_fast", 0.0)
    beta_fast = results.get("beta_fast", 0.0)
    if tau_decay_fast > 0 and beta_fast != 0:
        kernel_length_fast = int(5.0 * tau_decay_fast * result_fs)
        kernel_fast = _build_biexp_waveform(
            tau_rise_fast, tau_decay_fast, beta_fast, result_fs, kernel_length_fast,
        )
    else:
        kernel_fast = np.empty(0, dtype=np.float32)

    # Assemble per-cell arrays
    alphas = np.array(results.get("alphas", []), dtype=np.float64)
    baselines = np.array(results.get("baselines", []), dtype=np.float64)
    pves = np.array(results.get("pves", []), dtype=np.float64)

    # Build metadata dict
    metadata = {
        "tau_rise": tau_rise,
        "tau_decay": tau_decay,
        "beta": beta,
        "tau_rise_fast": tau_rise_fast,
        "tau_decay_fast": tau_decay_fast,
        "beta_fast": beta_fast,
    }
    for key in (
        "residual", "h_free", "num_iterations", "converged",
        "converged_at_iteration", "schema_version", "calab_version",
        "export_date",
    ):
        if key in results:
            value = results[key]
            if key == "h_free" and not isinstance(value, list):
                value = list(value)
            metadata[key] = value

    return CaDeconResult(
        activity=np.asarray(activity, dtype=np.float32),
        alphas=alphas,
        baselines=baselines,
        pves=pves,
        kernel_slow=kernel_slow,
        kernel_fast=kernel_fast,
        fs=result_fs,
        metadata=metadata,
    )
