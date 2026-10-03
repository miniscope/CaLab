"""Per-app post-processing hooks: raw bridge payload -> value returned to the caller.

Each hook is referenced from the app's :class:`~._registry.AppSpec`. Apps
without a hook return the raw :class:`~._handshake.BridgeResult`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from .._compute import CaDeconResult
    from ._handshake import BridgeResult

# Kernel waveforms are truncated to this many decay time-constants
# (kernel_length = KERNEL_LENGTH_DECAY_MULTIPLES * tau_decay * fs). Five decay
# constants capture >99% of a bi-exponential's mass.
KERNEL_LENGTH_DECAY_MULTIPLES = 5.0


def catune_params(result: BridgeResult, fs: float) -> dict:
    """Normalize a CaTune export into the ``calab.tune()`` return dict."""
    raw = result.payload
    params = raw.get("parameters", raw)
    return {
        "tau_rise": params.get("tau_rise_s", params.get("tau_rise")),
        "tau_decay": params.get("tau_decay_s", params.get("tau_decay")),
        "lambda_": params.get("lambda", params.get("lambda_")),
        "fs": params.get("sampling_rate_hz", params.get("fs", fs)),
        "filter_enabled": params.get("filter_enabled", False),
    }


def cadecon_result(result: BridgeResult, fs: float) -> CaDeconResult | None:
    """Build the ``calab.decon()`` return value, or None if activity is missing."""
    activity = result.arrays.get("activity")
    if activity is None:
        print("Warning: results received but activity matrix was missing.")
        return None
    return _build_cadecon_result(result.payload, activity, fs)


def _build_cadecon_result(
    results: dict, activity: object, fs: float,
) -> CaDeconResult:
    """Assemble a :class:`CaDeconResult` from the browser's results payload.

    Split out of :func:`cadecon_result` so the null-handling below is reachable
    from tests without standing up a bridge server and a browser.
    """
    # Imported here rather than at module scope: `_compute` imports the
    # compiled extension, and importing it eagerly would make `_bridge` depend
    # on it circularly.
    from .._compute import CaDeconResult, _build_biexp_waveform

    # Build kernel waveforms from biexp params.
    #
    # Schema 2 sends null for these when the run produced no fit at all -- it
    # stopped before completing an iteration, so nothing was ever fitted.
    # Missing keys land in the same place. Either way there is nothing to build
    # a kernel from, and the previous defaults (0.2 / 1.0 / 1.0) manufactured
    # here exactly the fit the browser had declined to claim.
    result_fs = results.get("fs", fs)
    tau_rise = results.get("tau_rise")
    tau_decay = results.get("tau_decay")
    beta = results.get("beta")
    if tau_rise is None or tau_decay is None or beta is None:
        print(
            "Warning: CaDecon reported no bi-exponential fit (the run stopped before "
            "completing an iteration). Kernel waveforms are empty and the tau_*, beta, "
            "and residual metadata is None."
        )
        kernel_slow = np.empty(0, dtype=np.float32)
    else:
        kernel_length = int(KERNEL_LENGTH_DECAY_MULTIPLES * tau_decay * result_fs)
        kernel_slow = _build_biexp_waveform(tau_rise, tau_decay, beta, result_fs, kernel_length)

    tau_rise_fast = results.get("tau_rise_fast")
    tau_decay_fast = results.get("tau_decay_fast")
    beta_fast = results.get("beta_fast")
    # Inline rather than via a `has_fast` flag: mypy narrows Optional through a
    # condition, not through an intermediate bool.
    if (
        tau_rise_fast is not None
        and tau_decay_fast is not None
        and beta_fast is not None
        and tau_decay_fast > 0
        and beta_fast != 0
    ):
        kernel_length_fast = int(KERNEL_LENGTH_DECAY_MULTIPLES * tau_decay_fast * result_fs)
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
    metadata: dict[str, Any] = {
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
        "solver_version", "export_date",
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
