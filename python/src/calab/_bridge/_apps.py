"""Bridge orchestrators: tune() and decon() functions for CaTune/CaDecon."""

from __future__ import annotations

import contextlib
import sys
import threading
import time
import webbrowser
from typing import TYPE_CHECKING

import numpy as np

from ._headless import HeadlessBrowser
from ._models import DeconConfig
from ._server import BridgeServer

if TYPE_CHECKING:
    from .._compute import CaDeconResult

HEARTBEAT_TIMEOUT = 10  # seconds without heartbeat = browser disconnected

# Default app URLs (GitHub Pages deployment)
_DEFAULT_CATUNE_URL = "https://miniscope.github.io/CaLab/CaTune/"
_DEFAULT_CADECON_URL = "https://miniscope.github.io/CaLab/CaDecon/"


def _format_progress(progress: dict) -> str:
    """Format a progress dict into a compact terminal status line."""
    iteration = progress.get("iteration", "?")
    max_iter = progress.get("max_iterations", "?")
    phase = progress.get("phase", "")
    phase_pct = progress.get("phase_progress", 0)
    status = progress.get("status", "running")
    tau_rise = progress.get("tau_rise")
    tau_decay = progress.get("tau_decay")

    parts = [f"iter {iteration}/{max_iter}"]
    if phase:
        parts.append(f"{phase} {phase_pct:.0%}")
    if tau_rise is not None and tau_decay is not None:
        parts.append(f"τr={tau_rise:.4f} τd={tau_decay:.4f}")
    if status != "running":
        parts.append(f"[{status}]")
    return "  ".join(parts)


@contextlib.contextmanager
def _managed_headless(headless: HeadlessBrowser | bool | None):
    """Resolve *headless* into a browser instance with automatic cleanup.

    Yields ``HeadlessBrowser | None``.  When ``headless is True``, a
    temporary browser is created and closed on exit.  When an existing
    ``HeadlessBrowser`` is passed, it is yielded as-is (caller owns it).
    """
    if headless is True:
        hb = HeadlessBrowser()
        hb.start()
        try:
            yield hb
        finally:
            hb.close()
    elif isinstance(headless, HeadlessBrowser):
        yield headless
    else:
        yield None


def _run_bridge(
    server: BridgeServer,
    event: threading.Event,
    app_name: str,
    app_url: str,
    open_browser: bool,
    timeout: float | None,
    show_progress: bool = False,
    headless: HeadlessBrowser | None = None,
) -> bool:
    """Start server, open browser, and wait for the bridge event.

    Returns True if the event fired (data received), False otherwise.
    """
    actual_port = server.port
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    bridge_param = f"http://127.0.0.1:{actual_port}"
    full_url = f"{app_url}?bridge={bridge_param}&bridge_secret={server.secret}"

    print(f"Bridge server running on http://127.0.0.1:{actual_port}")
    print(f"Opening {app_name}: {full_url}")

    if headless is not None:
        headless.navigate(full_url)
    elif open_browser:
        webbrowser.open(full_url)

    received = False
    start_time = time.monotonic()
    last_progress_id: object = None
    try:
        while True:
            if event.wait(timeout=1.0):
                received = True
                break

            now = time.monotonic()

            # Display progress updates in terminal
            if show_progress and server.latest_progress is not None:
                prog = server.latest_progress
                prog_id = (prog.get("iteration"), prog.get("phase_progress"), prog.get("status"))
                if prog_id != last_progress_id:
                    last_progress_id = prog_id
                    line = _format_progress(prog)
                    sys.stdout.write(f"\r\033[K{line}")
                    sys.stdout.flush()

            if timeout is not None and (now - start_time) >= timeout:
                break

            if server.last_heartbeat is not None:
                if (now - server.last_heartbeat) > HEARTBEAT_TIMEOUT:
                    print("\nBrowser disconnected (heartbeat timeout).")
                    break
    except KeyboardInterrupt:
        print("\nBridge cancelled by user.")
    finally:
        if show_progress and last_progress_id is not None:
            sys.stdout.write("\n")
            sys.stdout.flush()
        server.shutdown()

    return received


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
    received = _run_bridge(
        server, server.params_event, "CaTune",
        app_url or _DEFAULT_CATUNE_URL, open_browser, timeout,
    )

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
    headless: HeadlessBrowser | bool | None = None,
    *,
    autorun: bool = False,
    upsample_target: int | None = None,
    hp_filter_enabled: bool | None = None,
    lp_filter_enabled: bool | None = None,
    max_iterations: int | None = None,
    convergence_tol: float | None = None,
    num_subsets: int | None = None,
    target_coverage: float | None = None,
    aspect_ratio: float | None = None,
    seed: int | None = None,
) -> CaDeconResult | None:
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
    headless : HeadlessBrowser or bool or None
        ``None``/``False``: default (use ``webbrowser.open``).
        ``True``: create a temporary headless browser for this call.
        ``HeadlessBrowser``: reuse an existing browser instance (for batch).
    autorun : bool
        If True, the solver starts automatically after loading. Default: False.
    upsample_target : int, optional
        Target sampling rate for upsampling. Must be > 0.
    hp_filter_enabled : bool, optional
        Enable high-pass filter.
    lp_filter_enabled : bool, optional
        Enable low-pass filter.
    max_iterations : int, optional
        Maximum solver iterations (1–200).
    convergence_tol : float, optional
        Convergence tolerance (0–1 exclusive).
    num_subsets : int, optional
        Number of random subsets. Must be > 0.
    target_coverage : float, optional
        Target coverage fraction (0–1].
    aspect_ratio : float, optional
        Subset aspect ratio. Must be > 0.
    seed : int, optional
        Random seed for subset placement.

    Returns
    -------
    CaDeconResult or None
        Deconvolution results if received, None if timeout/cancelled.
    """
    from .._compute import CaDeconResult, _build_biexp_waveform

    # Build and validate config via pydantic
    config = DeconConfig(
        autorun=autorun,
        upsample_target=upsample_target,
        hp_filter_enabled=hp_filter_enabled,
        lp_filter_enabled=lp_filter_enabled,
        max_iterations=max_iterations,
        convergence_tol=convergence_tol,
        num_subsets=num_subsets,
        target_coverage=target_coverage,
        aspect_ratio=aspect_ratio,
        seed=seed,
    )
    config_dict = config.model_dump(exclude_none=True)

    server = BridgeServer(traces, fs, port=port or 0, app="cadecon", config=config_dict)
    with _managed_headless(headless) as headless_browser:
        received = _run_bridge(
            server, server.results_event, "CaDecon",
            app_url or _DEFAULT_CADECON_URL, open_browser, timeout,
            show_progress=autorun,
            headless=headless_browser,
        )

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
