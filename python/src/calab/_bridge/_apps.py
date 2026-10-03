"""Bridge orchestrator: :func:`launch` runs any registered app; ``tune()`` and
``decon()`` are thin wrappers for CaTune and CaDecon."""

from __future__ import annotations

import contextlib
import sys
import threading
import time
import warnings
import webbrowser
from typing import TYPE_CHECKING, Any

import numpy as np

from ._handshake import BridgeVersionWarning
from ._headless import HeadlessBrowser
from ._models import DeconConfig
from ._postprocess import (  # noqa: F401  (re-exported for existing importers)
    KERNEL_LENGTH_DECAY_MULTIPLES,
    _build_cadecon_result,
)
from ._registry import get_app
from ._server import BridgeServer

if TYPE_CHECKING:
    from .._compute import CaDeconResult

HEARTBEAT_TIMEOUT = 10  # seconds without heartbeat = browser disconnected


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


def launch(
    app: str,
    traces: np.ndarray,
    fs: float = 30.0,
    *,
    timeout: float | None = None,
    port: int | None = None,
    app_url: str | None = None,
    open_browser: bool = True,
    headless: HeadlessBrowser | bool | None = None,
    config: dict | None = None,
    show_progress: bool = False,
    raw: bool = False,
) -> Any:
    """Open a registered CaLab web app on *traces* and wait for its results.

    Generic orchestrator behind :func:`tune` and :func:`decon`; any app in the
    registry (:mod:`calab._bridge._registry`) can be launched by slug.

    Parameters
    ----------
    app : str
        Registry slug, e.g. ``"catune"`` or ``"cadecon"`` (case-insensitive).
    traces : np.ndarray
        Calcium traces, shape ``(n_cells, n_timepoints)`` or ``(n_timepoints,)``.
    fs : float
        Sampling rate in Hz. Default: 30.0.
    timeout : float, optional
        Seconds to wait for results. None = wait forever (until Ctrl-C).
    port : int, optional
        Port to bind to. None = auto-assign.
    app_url : str, optional
        Override the app URL (for local dev). Default: the registered
        GitHub Pages URL.
    open_browser : bool
        Whether to auto-open the browser. Default: True.
    headless : HeadlessBrowser or bool or None
        See :func:`decon`.
    config : dict, optional
        Served to the app at ``GET /api/v1/config``.
    show_progress : bool
        Print progress updates the app posts to ``/api/v1/progress``.
    raw : bool
        Return the :class:`BridgeResult` instead of applying the app's
        post-processing hook.

    Returns
    -------
    Any
        The app's post-processed result (see the registry entry), the raw
        :class:`BridgeResult` when the app has no hook or ``raw=True``, or
        None on timeout/cancel.

    Raises
    ------
    ValueError
        If *app* is not registered or has no bridge export.
    BridgeVersionError
        If the app's results fail the version handshake.
    """
    spec = get_app(app)
    if spec.result_schema is None:
        raise ValueError(f"{spec.display_name} does not support the Python bridge yet")

    server = BridgeServer(traces, fs, port=port or 0, app=spec.slug, config=config)
    with _managed_headless(headless) as headless_browser:
        received = _run_bridge(
            server, server.result_event, spec.display_name,
            app_url or spec.default_url, open_browser, timeout,
            show_progress=show_progress,
            headless=headless_browser,
        )

    if not received:
        return None
    result = server.result()  # raises BridgeVersionError on a failed handshake
    if result is None:
        return None
    for message in result.warnings:
        warnings.warn(message, BridgeVersionWarning, stacklevel=2)
    if raw or spec.postprocess is None:
        return result
    return spec.postprocess(result, fs)


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

    Raises
    ------
    BridgeVersionError
        If the app's export is incompatible with this version of calab.
    """
    result: dict | None = launch(
        "catune", traces, fs,
        timeout=timeout, port=port, app_url=app_url, open_browser=open_browser,
    )
    return result


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

    Raises
    ------
    BridgeVersionError
        If the app's results are incompatible with this version of calab.
    """
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
    result: CaDeconResult | None = launch(
        "cadecon", traces, fs,
        timeout=timeout, port=port, app_url=app_url, open_browser=open_browser,
        headless=headless,
        config=config.model_dump(exclude_none=True),
        show_progress=autorun,
    )
    return result
