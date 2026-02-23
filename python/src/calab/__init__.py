"""CaLab: calcium imaging analysis tools — deconvolution and data preparation."""

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
from ._bridge import tune

__version__ = "0.2.0"
__all__ = [
    # Compute
    "build_kernel",
    "tau_to_ar2",
    "compute_lipschitz",
    "run_deconvolution",
    "run_deconvolution_full",
    "DeconvolutionResult",
    "bandpass_filter",
    # I/O
    "save_for_tuning",
    "load_tuning_data",
    "load_export_params",
    "deconvolve_from_export",
    # Loaders
    "load_caiman",
    "load_minian",
    # Bridge
    "tune",
]
