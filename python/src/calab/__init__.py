"""CaLab: calcium imaging analysis tools — deconvolution and data preparation."""

from ._kernel import build_kernel, compute_lipschitz, tau_to_ar2
from ._fista import run_deconvolution, run_deconvolution_full, DeconvolutionResult
from ._filter import bandpass_filter
from ._io import load_tuning_data, save_for_tuning, load_export_params, deconvolve_from_export

__version__ = "0.2.0"
__all__ = [
    "build_kernel",
    "tau_to_ar2",
    "compute_lipschitz",
    "run_deconvolution",
    "run_deconvolution_full",
    "DeconvolutionResult",
    "bandpass_filter",
    "save_for_tuning",
    "load_tuning_data",
    "load_export_params",
    "deconvolve_from_export",
]
