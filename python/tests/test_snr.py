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


def _trace_with_events(at, amp=10.0, n=9000, seed=0, tau=10.0):
    x = np.random.default_rng(seed).normal(size=n)
    k = np.arange(n)
    for t in at:
        x[t:] += amp * np.exp(-(k[t:] - t) / tau)
    return x


def test_detect_events_recovers_known_events():
    at = [500, 1400, 2300, 3100, 4000, 5200, 6100, 7300]
    events = calab.detect_events(_trace_with_events(at), min_separation_samples=12)
    assert len(events) == len(at)
    for e, t in zip(events, at, strict=True):
        assert abs(e.time_index - t) <= 3
        assert 6.0 < e.height < 11.0


def test_detect_events_pure_noise_is_silent_and_snr_is_at_the_floor():
    silent = 0
    for seed in range(20):
        x = np.random.default_rng(100 + seed).normal(size=9000)
        r = calab.measured_snr_report(x, min_separation_samples=12)
        silent += r.is_silent
        assert 2.4 < r.snr < 3.0
    assert silent >= 18


def test_measured_snr_report_active_trace():
    x = _trace_with_events([900, 3000, 5200, 7400], amp=8.0, seed=1)
    r = calab.measured_snr_report(x, min_separation_samples=12)
    assert not r.is_silent and r.n_events == 4
    assert r.snr == pytest.approx(calab.measured_snr(x))
    assert r.sigma == pytest.approx(1.0, rel=0.05)


def test_detect_events_rejects_bad_arguments():
    with pytest.raises(ValueError):
        calab.detect_events(np.zeros((2, 10)), 12)
    with pytest.raises(ValueError):
        calab.detect_events(np.zeros(10), -1)
    assert calab.detect_events(np.zeros(100), 12, sigma=0.0) == []
