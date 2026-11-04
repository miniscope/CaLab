"""Tests for the real-data SNR metrics and the simulator's measured-SNR convention."""

import numpy as np
import pytest

import calab
from calab import NoiseConfig, SimulationConfig, simulate


def test_mad_diff_recovers_white_noise_sigma():
    rng = np.random.default_rng(0)
    for sigma in (0.05, 1.0, 30.0):
        x = rng.normal(0.0, sigma, 18_000) + 100.0
        assert calab.noise_sigma_mad_diff(x) == pytest.approx(sigma, rel=0.03)


def test_noise_level_nu_definition():
    rng = np.random.default_rng(1)
    fs, sigma = 30.0, 2.0
    x = rng.normal(0.0, sigma, 27_000)
    expected = sigma * 0.6744897501960817 * np.sqrt(2) / np.sqrt(fs)
    assert calab.noise_level_nu(x, fs) == pytest.approx(expected, rel=0.03)


def test_pure_noise_sits_at_the_floor():
    x = np.random.default_rng(2).normal(size=100_000)
    assert calab.measured_snr(x) == pytest.approx(2.665, abs=0.08)


def test_peak_snr_top_fraction():
    x = np.zeros(1000)
    x[:10] = 10.0
    assert calab.peak_snr(x, 1.0, 0.01) == pytest.approx(10.0)
    assert calab.peak_snr(x, 2.0, 0.02) == pytest.approx(2.5)


def test_rejects_2d_input():
    with pytest.raises(ValueError):
        calab.measured_snr(np.zeros((2, 10)))


@pytest.mark.parametrize("target", [5.0, 20.0])
def test_simulated_traces_measure_at_target(target):
    cfg = SimulationConfig(num_cells=3, num_timepoints=9000, noise=NoiseConfig(snr=target), seed=3)
    result = simulate(cfg)
    for trace, gt in zip(result.traces, result.ground_truth, strict=True):
        assert calab.measured_snr(trace) == pytest.approx(target, rel=0.01)
        assert gt.noise_sigma > 0
        assert gt.snr_1ap > 0


def test_legacy_peak_reference():
    cfg = SimulationConfig(num_cells=2, num_timepoints=3000, noise=NoiseConfig(snr=20.0, reference="peak"))
    result = simulate(cfg)
    for gt in result.ground_truth:
        assert gt.noise_sigma == pytest.approx(float(gt.clean_calcium.max()) / 20.0, rel=1e-6)
