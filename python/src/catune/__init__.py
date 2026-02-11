"""CaTune companion: calcium imaging deconvolution and data preparation."""

from ._kernel import build_kernel, compute_lipschitz, tau_to_ar2

__version__ = "0.1.0"
__all__ = ["build_kernel", "tau_to_ar2", "compute_lipschitz"]
