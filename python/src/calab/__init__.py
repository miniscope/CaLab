"""CaLab: calcium imaging analysis tools — deconvolution and data preparation."""

from ._bridge import DeconConfig, HeadlessBrowser, decon, tune
from ._compute import (
    BiexpFitResult,
    CaDeconResult,
    DeconvolutionResult,
    SolveTraceResult,
    bandpass_filter,
    build_kernel,
    compute_lipschitz,
    compute_upsample_factor,
    estimate_kernel,
    fit_biexponential,
    run_deconvolution,
    run_deconvolution_full,
    solve_trace,
    tau_to_ar2,
)
from ._io import deconvolve_from_export, load_export_params, load_tuning_data, save_for_tuning
from ._loaders import load_caiman, load_minian
from ._simulate import (
    CellGroundTruth,
    DriftModel,
    KernelConfig,
    MarkovConfig,
    NoiseConfig,
    PhotobleachingConfig,
    PoissonConfig,
    RandomWalkDrift,
    SaturationConfig,
    SimulationConfig,
    SimulationResult,
    SinusoidalDrift,
    SpikeModel,
    presets,
    simulate,
)

from importlib.metadata import version as _pkg_version

__version__ = _pkg_version("calab")
__all__ = [
    # Bridge
    "DeconConfig",
    "HeadlessBrowser",
    "decon",
    "tune",
    # Compute
    "BiexpFitResult",
    "CaDeconResult",
    "DeconvolutionResult",
    "SolveTraceResult",
    "bandpass_filter",
    "build_kernel",
    "compute_lipschitz",
    "compute_upsample_factor",
    "estimate_kernel",
    "fit_biexponential",
    "run_deconvolution",
    "run_deconvolution_full",
    "solve_trace",
    "tau_to_ar2",
    # I/O
    "deconvolve_from_export",
    "load_export_params",
    "load_tuning_data",
    "save_for_tuning",
    # Loaders
    "load_caiman",
    "load_minian",
    # Simulation
    "CellGroundTruth",
    "DriftModel",
    "KernelConfig",
    "MarkovConfig",
    "NoiseConfig",
    "PhotobleachingConfig",
    "PoissonConfig",
    "RandomWalkDrift",
    "SaturationConfig",
    "SimulationConfig",
    "SimulationResult",
    "SinusoidalDrift",
    "SpikeModel",
    "presets",
    "simulate",
]
