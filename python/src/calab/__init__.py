"""CaLab: calcium imaging analysis tools — deconvolution and data preparation."""

from ._bridge import tune
from ._compute import (
    DeconvolutionResult,
    bandpass_filter,
    build_kernel,
    compute_lipschitz,
    run_deconvolution,
    run_deconvolution_full,
    tau_to_ar2,
)
from ._io import deconvolve_from_export, load_export_params, load_tuning_data, save_for_tuning
from ._loaders import load_caiman, load_minian

__version__ = "0.2.0"
__all__ = [
    # Bridge
    "tune",
    # Compute
    "DeconvolutionResult",
    "bandpass_filter",
    "build_kernel",
    "compute_lipschitz",
    "run_deconvolution",
    "run_deconvolution_full",
    "tau_to_ar2",
    # I/O
    "deconvolve_from_export",
    "load_export_params",
    "load_tuning_data",
    "save_for_tuning",
    # Loaders
    "load_caiman",
    "load_minian",
]
