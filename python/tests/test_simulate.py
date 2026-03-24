"""Tests for the simulation module (calab.simulate)."""

import numpy as np
import pytest
from pydantic import ValidationError

import calab
from calab import (
    KernelConfig,
    MarkovConfig,
    NoiseConfig,
    PhotobleachingConfig,
    PoissonConfig,
    RandomWalkDrift,
    SaturationConfig,
    SimulationConfig,
    SinusoidalDrift,
    simulate,
)


# ── Config validation ────────────────────────────────────────────


def test_invalid_fs_raises():
    with pytest.raises(ValidationError):
        SimulationConfig(fs_hz=-1)


def test_invalid_snr_raises():
    with pytest.raises(ValidationError):
        NoiseConfig(snr=0)


def test_invalid_tau_raises():
    with pytest.raises(ValidationError):
        KernelConfig(tau_rise_s=-0.1)


def test_default_config_valid():
    cfg = SimulationConfig()
    assert cfg.fs_hz == 30.0
    assert cfg.num_cells == 100
    assert cfg.seed == 42


# ── Basic simulation ─────────────────────────────────────────────


def test_output_shape():
    cfg = SimulationConfig(num_cells=5, num_timepoints=200)
    result = simulate(cfg)
    assert result.traces.shape == (5, 200)
    assert len(result.ground_truth) == 5
    for gt in result.ground_truth:
        assert gt.spikes.shape == (200,)
        assert gt.clean_calcium.shape == (200,)


def test_determinism():
    cfg = SimulationConfig(num_cells=3, num_timepoints=300, seed=42)
    r1 = simulate(cfg)
    r2 = simulate(cfg)
    np.testing.assert_array_equal(r1.traces, r2.traces)


def test_different_seeds_differ():
    cfg1 = SimulationConfig(num_cells=1, num_timepoints=300, seed=42)
    cfg2 = SimulationConfig(num_cells=1, num_timepoints=300, seed=99)
    r1 = simulate(cfg1)
    r2 = simulate(cfg2)
    assert not np.array_equal(r1.traces, r2.traces)


def test_ground_truth_fields():
    result = simulate(SimulationConfig(num_cells=2, num_timepoints=300))
    for gt in result.ground_truth:
        assert gt.alpha > 0
        assert gt.snr > 0
        assert gt.tau_rise_s > 0
        assert gt.tau_decay_s > 0


def test_spikes_non_negative():
    result = simulate(SimulationConfig(num_cells=3, num_timepoints=900))
    for gt in result.ground_truth:
        assert (gt.spikes >= 0).all()


def test_clean_calcium_non_negative():
    result = simulate(SimulationConfig(num_cells=3, num_timepoints=900))
    for gt in result.ground_truth:
        assert (gt.clean_calcium >= -1e-6).all()


# ── Kwargs override ──────────────────────────────────────────────


def test_simulate_with_kwargs():
    result = simulate(num_cells=2, num_timepoints=100, seed=7)
    assert result.traces.shape == (2, 100)
    assert result.config.seed == 7


def test_simulate_config_plus_kwargs():
    cfg = SimulationConfig(num_cells=5, seed=10)
    result = simulate(cfg, num_cells=2)
    assert result.traces.shape[0] == 2
    assert result.config.num_cells == 2


# ── Spike models ─────────────────────────────────────────────────


def test_markov_produces_spikes():
    cfg = SimulationConfig(
        num_cells=1, num_timepoints=9000,
        alpha_cv=0.0,
    )
    result = simulate(cfg)
    assert result.ground_truth[0].spikes.sum() > 0


def test_poisson_mean_rate():
    cfg = SimulationConfig(
        num_cells=1, num_timepoints=30000,
        spike_model=PoissonConfig(rate_hz=2.0),
        alpha_cv=0.0,
    )
    result = simulate(cfg)
    duration_s = 30000 / 30.0
    measured_rate = result.ground_truth[0].spikes.sum() / duration_s
    assert 1.0 < measured_rate < 3.0, f"Expected ~2 Hz, got {measured_rate:.2f}"


# ── Per-cell variation ───────────────────────────────────────────


def test_alpha_variation():
    cfg = SimulationConfig(
        num_cells=50, num_timepoints=300,
        alpha_cv=0.3,
    )
    result = simulate(cfg)
    alphas = np.array([gt.alpha for gt in result.ground_truth])
    cv = alphas.std() / alphas.mean()
    assert 0.1 < cv < 0.6, f"Alpha CV should be ~0.3, got {cv:.3f}"


def test_kernel_variation():
    cfg = SimulationConfig(
        num_cells=50, num_timepoints=300,
        alpha_cv=0.0, kernel=KernelConfig(tau_decay_cv=0.15),
    )
    result = simulate(cfg)
    taus = np.array([gt.tau_decay_s for gt in result.ground_truth])
    assert taus.max() > taus.mean() * 1.05
    assert taus.min() < taus.mean() * 0.95


# ── Photobleaching ───────────────────────────────────────────────


def test_photobleaching():
    base = SimulationConfig(
        num_cells=1, num_timepoints=9000,
        noise=NoiseConfig(snr=200.0),
        drift=SinusoidalDrift(amplitude_fraction=0.0),
        alpha_cv=0.0,
    )
    r_no = simulate(SimulationConfig(**{**base.model_dump(), "photobleaching": PhotobleachingConfig(enabled=False)}))
    r_yes = simulate(SimulationConfig(**{
        **base.model_dump(),
        "photobleaching": PhotobleachingConfig(
            enabled=True, decay_time_constant_s=30.0, amplitude_fraction=0.3,
        ),
    }))
    # In the last 10%, bleached should be lower
    last = slice(-900, None)
    frac_lower = (r_yes.traces[0, last] < r_no.traces[0, last]).mean()
    assert frac_lower > 0.8


# ── Saturation ───────────────────────────────────────────────────


def test_saturation_compresses():
    base = dict(num_cells=1, num_timepoints=900, alpha_cv=0.0)
    r_lin = simulate(SimulationConfig(saturation=SaturationConfig(enabled=False), **base))
    r_sat = simulate(SimulationConfig(saturation=SaturationConfig(enabled=True, k_d=0.5), **base))
    max_lin = r_lin.ground_truth[0].clean_calcium.max()
    max_sat = r_sat.ground_truth[0].clean_calcium.max()
    assert max_sat < max_lin or max_lin < 1e-6


# ── Presets ──────────────────────────────────────────────────────


@pytest.mark.parametrize("preset_fn", [
    calab.presets.gcamp6f,
    calab.presets.gcamp6s,
    calab.presets.gcamp6m,
    calab.presets.jgcamp8f,
    calab.presets.ogb1,
    calab.presets.clean,
])
def test_preset_returns_valid_config(preset_fn):
    cfg = preset_fn(num_cells=2, num_timepoints=100)
    assert cfg.kernel.tau_rise_s > 0
    assert cfg.kernel.tau_decay_s > 0
    assert cfg.noise.snr > 0
    # Verify it can actually run
    result = simulate(cfg)
    assert result.traces.shape == (2, 100)


# ── JSON round-trip ──────────────────────────────────────────────


def test_config_json_roundtrip():
    cfg = SimulationConfig(
        num_cells=5,
        spike_model=PoissonConfig(rate_hz=3.0),
        drift=RandomWalkDrift(step_std_fraction=0.005),
    )
    json_str = cfg.model_dump_json()
    cfg2 = SimulationConfig.model_validate_json(json_str)
    assert cfg2.num_cells == 5
    assert isinstance(cfg2.spike_model, PoissonConfig)
    assert cfg2.spike_model.rate_hz == 3.0
    assert isinstance(cfg2.drift, RandomWalkDrift)
    assert cfg2.drift.step_std_fraction == 0.005


# ── Edge cases ───────────────────────────────────────────────────


def test_single_cell_single_timepoint():
    result = simulate(SimulationConfig(
        num_cells=1, num_timepoints=1,
        alpha_cv=0.0,
    ))
    assert result.traces.shape == (1, 1)


def test_high_snr_clean():
    result = simulate(SimulationConfig(
        num_cells=1, num_timepoints=900,
        noise=NoiseConfig(snr=1000.0),
        drift=SinusoidalDrift(amplitude_fraction=0.0),
        alpha_cv=0.0,
    ))
    gt = result.ground_truth[0]
    # With very high SNR and no drift, trace should closely match clean signal
    residual = np.abs(result.traces[0] - gt.clean_calcium)
    assert residual.max() < gt.clean_calcium.max() * 0.05 or gt.clean_calcium.max() < 1e-6
