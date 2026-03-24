"""Synthetic calcium trace simulation with full ground truth.

Generates realistic fluorescence traces for testing deconvolution algorithms.
The simulation runs in Rust for performance; this module provides Pydantic
configuration models and a convenience wrapper.

Example::

    import calab

    # Default GCaMP6f-like simulation
    result = calab.simulate()

    # Using a preset
    result = calab.simulate(calab.presets.jgcamp8f(num_cells=50))

    # With per-cell kernel variation (tests single-kernel assumption)
    from calab import SimulationConfig, KernelConfig
    config = SimulationConfig(
        kernel=KernelConfig(tau_decay_cv=0.15),
    )
    result = calab.simulate(config)
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from ._solver import py_simulate_traces as _simulate_traces


# ── Spike Models ─────────────────────────────────────────────────


class MarkovConfig(BaseModel):
    """Two-state HMM spike generator (silent/active) with bursty firing.

    Attribution: CaLab web simulator Markov spike model.
    """

    model_type: Literal["markov"] = "markov"
    p_silent_to_active: float = Field(
        0.01, ge=0, le=1, description="Silent->active transition probability per frame"
    )
    p_active_to_silent: float = Field(
        0.2, ge=0, le=1, description="Active->silent transition probability per frame"
    )
    p_spike_when_active: float = Field(
        0.7, ge=0, le=1, description="Spike probability in active state (per 300 Hz step)"
    )
    p_spike_when_silent: float = Field(
        0.005, ge=0, le=1, description="Spike probability in silent state (per 300 Hz step)"
    )
    p_silent_to_active_cv: float = Field(
        0.0, ge=0, description="Per-cell log-normal CV on p_silent_to_active (0 = no variation)"
    )


class PoissonConfig(BaseModel):
    """Homogeneous Poisson spike generator.

    Attribution: standard model in OASIS (Friedrich et al., 2017)
    and CaImAn (Giovannucci et al., 2019).
    """

    model_type: Literal["poisson"] = "poisson"
    rate_hz: float = Field(1.0, gt=0, description="Mean firing rate (Hz)")


SpikeModel = Annotated[Union[MarkovConfig, PoissonConfig], Field(discriminator="model_type")]


# ── Kernel ───────────────────────────────────────────────────────


class KernelConfig(BaseModel):
    """Double-exponential kernel: h(t) = exp(-t/tau_decay) - exp(-t/tau_rise).

    Attribution: standard calcium response model (CaImAn, Suite2p, CaLab).
    """

    tau_rise_s: float = Field(0.1, gt=0, description="Rise time constant (seconds)")
    tau_decay_s: float = Field(0.6, gt=0, description="Decay time constant (seconds)")
    tau_rise_cv: float = Field(0.0, ge=0, description="Per-cell log-normal CV on tau_rise (0 = no variation)")
    tau_decay_cv: float = Field(0.0, ge=0, description="Per-cell log-normal CV on tau_decay (0 = no variation)")


# ── Noise ────────────────────────────────────────────────────────


class NoiseConfig(BaseModel):
    """Noise model: Gaussian + optional Poisson (shot) noise.

    Attribution: Gaussian from CaLab web simulator.
    Shot noise from CASCADE (Rupprecht et al., 2021).
    """

    snr: float = Field(8.0, gt=0, description="Signal-to-noise ratio (peak / noise_std)")
    shot_noise_enabled: bool = Field(False, description="Add Poisson shot noise")
    shot_noise_fraction: float = Field(
        0.3, ge=0, le=1, description="Fraction of total noise variance from shot noise"
    )
    snr_spread: float = Field(0.0, ge=0, description="Per-cell additive SNR spread (+/- this value)")


# ── Baseline Drift ───────────────────────────────────────────────


class SinusoidalDrift(BaseModel):
    """Deterministic sinusoidal baseline drift.

    Useful as a simple test signal but not physically motivated.
    """

    model_type: Literal["sinusoidal"] = "sinusoidal"
    amplitude_fraction: float = Field(
        0.1, ge=0, description="Drift amplitude as fraction of peak signal"
    )
    cycles_min: float = Field(2.0, gt=0, description="Minimum drift cycles over trace duration")
    cycles_max: float = Field(4.0, gt=0, description="Maximum drift cycles over trace duration")
    amplitude_cv: float = Field(0.0, ge=0, description="Per-cell log-normal CV on amplitude (0 = no variation)")


class RandomWalkDrift(BaseModel):
    """Mean-reverting Gaussian random walk baseline drift (default).

    Models slow irregular baseline fluctuations from tissue movement, focus
    drift, and neuropil signal changes.
    From MLspike (Deneux et al., 2016, Nature Communications).
    """

    model_type: Literal["random_walk"] = "random_walk"
    step_std_fraction: float = Field(
        0.002, ge=0, description="Step std as fraction of peak signal per frame"
    )
    mean_reversion: float = Field(
        0.001, ge=0, le=1, description="Mean-reversion rate (0=pure walk, 1=reset each frame)"
    )
    step_std_cv: float = Field(0.0, ge=0, description="Per-cell log-normal CV on step_std (0 = no variation)")


DriftModel = Annotated[Union[SinusoidalDrift, RandomWalkDrift], Field(discriminator="model_type")]


# ── Photobleaching ───────────────────────────────────────────────


class PhotobleachingConfig(BaseModel):
    """Exponential photobleaching: F(t) *= 1 - amp * (1 - exp(-t/tau)).

    Attribution: NAOMi (Charles et al., 2019).
    """

    enabled: bool = Field(False, description="Apply photobleaching")
    decay_time_constant_s: float = Field(
        600.0, gt=0, description="Bleaching time constant (seconds)"
    )
    amplitude_fraction: float = Field(
        0.15, ge=0, le=1, description="Max fractional signal loss"
    )
    amplitude_cv: float = Field(0.0, ge=0, description="Per-cell log-normal CV on amplitude (0 = no variation)")


# ── Indicator Saturation ─────────────────────────────────────────


class SaturationConfig(BaseModel):
    """Hill equation indicator saturation: F_sat = F^n / (F^n + Kd^n).

    Attribution: MLspike (Deneux et al., 2016).
    """

    enabled: bool = Field(False, description="Apply indicator saturation")
    hill_coefficient: float = Field(1.0, gt=0, description="Hill coefficient n")
    k_d: float = Field(5.0, gt=0, description="Half-saturation level (signal units)")
    k_d_cv: float = Field(0.0, ge=0, description="Per-cell log-normal CV on k_d (0 = no variation)")


# ── Top-Level Config ─────────────────────────────────────────────


class SimulationConfig(BaseModel):
    """Complete configuration for synthetic calcium trace generation.

    Per-cell variation (_cv fields) live on each config struct alongside
    the nominal value they modify. Alpha is here because it doesn't
    belong to any pipeline step.
    """

    fs_hz: float = Field(30.0, gt=0, description="Sampling rate (Hz)")
    num_timepoints: int = Field(27000, gt=0, description="Number of timepoints")
    num_cells: int = Field(100, gt=0, description="Number of cells")
    kernel: KernelConfig = Field(default_factory=KernelConfig)
    spike_model: SpikeModel = Field(default_factory=MarkovConfig)
    noise: NoiseConfig = Field(default_factory=NoiseConfig)
    drift: DriftModel = Field(default_factory=RandomWalkDrift)
    photobleaching: PhotobleachingConfig = Field(default_factory=PhotobleachingConfig)
    saturation: SaturationConfig = Field(default_factory=SaturationConfig)
    alpha_mean: float = Field(1.0, gt=0, description="Mean per-cell amplitude scaling factor")
    alpha_cv: float = Field(0.3, ge=0, description="Per-cell log-normal CV on alpha (0 = no variation)")
    seed: int = Field(42, ge=0, le=4294967295, description="RNG seed for reproducibility (u32)")
    spike_sim_hz: float = Field(300.0, gt=0, description="Internal spike simulation rate (Hz)")


# ── Result Types ─────────────────────────────────────────────────


class CellGroundTruth(BaseModel):
    """Ground truth for a single simulated cell."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    spikes: np.ndarray  # (num_timepoints,) spike counts at imaging rate
    clean_calcium: np.ndarray  # (num_timepoints,) kernel * spikes, no noise
    alpha: float  # amplitude scaling factor
    snr: float  # actual SNR for this cell
    tau_rise_s: float  # actual rise time constant (seconds)
    tau_decay_s: float  # actual decay time constant (seconds)


class SimulationResult(BaseModel):
    """Complete simulation result with observed traces and per-cell ground truth."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    traces: np.ndarray  # (num_cells, num_timepoints) observed fluorescence
    ground_truth: list[CellGroundTruth]
    config: SimulationConfig


# ── Public API ───────────────────────────────────────────────────


def simulate(config: SimulationConfig | None = None, **kwargs: object) -> SimulationResult:
    """Generate synthetic calcium imaging traces with full ground truth.

    Parameters
    ----------
    config : SimulationConfig, optional
        Full configuration. If None, a default config is created.
    **kwargs
        Override fields on the default/provided config (e.g., num_cells=50, seed=123).

    Returns
    -------
    SimulationResult
        Contains traces array and per-cell ground truth.
    """
    if config is None:
        config = SimulationConfig(**kwargs)
    elif kwargs:
        config = config.model_copy(update=kwargs)

    config_json = config.model_dump_json()
    (
        traces_flat,
        spikes_flat,
        clean_flat,
        alphas,
        snrs,
        tau_rises,
        tau_decays,
        n_cells,
        n_tp,
    ) = _simulate_traces(config_json)

    # Reshape flat arrays
    traces_2d = np.asarray(traces_flat, dtype=np.float32).reshape(n_cells, n_tp)
    spikes_2d = np.asarray(spikes_flat, dtype=np.float32).reshape(n_cells, n_tp)
    clean_2d = np.asarray(clean_flat, dtype=np.float32).reshape(n_cells, n_tp)

    ground_truth = [
        CellGroundTruth(
            spikes=spikes_2d[i],
            clean_calcium=clean_2d[i],
            alpha=float(alphas[i]),
            snr=float(snrs[i]),
            tau_rise_s=float(tau_rises[i]),
            tau_decay_s=float(tau_decays[i]),
        )
        for i in range(n_cells)
    ]

    return SimulationResult(
        traces=traces_2d,
        ground_truth=ground_truth,
        config=config,
    )


# ── Presets ──────────────────────────────────────────────────────


class presets:
    """Built-in indicator presets. Each method returns a SimulationConfig."""

    @staticmethod
    def gcamp6f(**overrides: object) -> SimulationConfig:
        """GCaMP6f. Time constants from Chen et al., 2013, Nature."""
        return SimulationConfig(
            kernel=KernelConfig(tau_rise_s=0.1, tau_decay_s=0.6),
            noise=NoiseConfig(snr=20.0),
            **overrides,
        )

    @staticmethod
    def gcamp6s(**overrides: object) -> SimulationConfig:
        """GCaMP6s. Slow kinetics, high SNR. Chen et al., 2013."""
        return SimulationConfig(
            kernel=KernelConfig(tau_rise_s=0.4, tau_decay_s=1.8),
            noise=NoiseConfig(snr=25.0),
            **overrides,
        )

    @staticmethod
    def gcamp6m(**overrides: object) -> SimulationConfig:
        """GCaMP6m. Moderate kinetics. Chen et al., 2013."""
        return SimulationConfig(
            kernel=KernelConfig(tau_rise_s=0.15, tau_decay_s=0.9),
            noise=NoiseConfig(snr=22.0),
            **overrides,
        )

    @staticmethod
    def jgcamp8f(**overrides: object) -> SimulationConfig:
        """jGCaMP8f. Fast indicator, noisier. Zhang et al., 2023."""
        return SimulationConfig(
            kernel=KernelConfig(tau_rise_s=0.05, tau_decay_s=0.3),
            noise=NoiseConfig(snr=12.0),
            **overrides,
        )

    @staticmethod
    def ogb1(**overrides: object) -> SimulationConfig:
        """OGB-1 synthetic dye. Stosiek et al., 2003."""
        return SimulationConfig(
            kernel=KernelConfig(tau_rise_s=0.05, tau_decay_s=1.5),
            noise=NoiseConfig(snr=15.0),
            **overrides,
        )

    @staticmethod
    def clean(**overrides: object) -> SimulationConfig:
        """Near-ideal traces: minimal noise, no drift. For algorithm debugging."""
        return SimulationConfig(
            kernel=KernelConfig(tau_rise_s=0.1, tau_decay_s=0.6),
            noise=NoiseConfig(snr=200.0),
            drift=RandomWalkDrift(step_std_fraction=0.0),
            alpha_cv=0.0,
            **overrides,
        )
