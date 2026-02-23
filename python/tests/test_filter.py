"""Tests for the bandpass filter.

Mirrors Rust filter.rs tests for passband preservation, stopband attenuation,
DC removal, short trace handling, and invalid cutoff handling.
"""

from __future__ import annotations

import numpy as np
import pytest

from calab import bandpass_filter


# ---------------------------------------------------------------------------
# Test 1: Passband preservation
# ---------------------------------------------------------------------------

def test_passband_preservation():
    """1 Hz sine at fs=100: >90% AC power retained through filter."""
    n = 1024
    fs = 100.0
    freq = 1.0  # well within passband for standard params

    t = np.arange(n) / fs
    trace = np.sin(2 * np.pi * freq * t)
    orig_mean = trace.mean()
    original_ac_power = float(np.sum((trace - orig_mean) ** 2))

    filtered = bandpass_filter(trace, tau_rise=0.02, tau_decay=0.4, fs=fs)

    filt_mean = filtered.mean()
    filtered_ac_power = float(np.sum((filtered - filt_mean) ** 2))

    ratio = filtered_ac_power / original_ac_power
    assert ratio > 0.9, f"Passband AC power ratio: {ratio:.4f}, expected > 0.9"


# ---------------------------------------------------------------------------
# Test 2: Stopband attenuation
# ---------------------------------------------------------------------------

def test_stopband_attenuation():
    """0.005 Hz sine below HP cutoff: <10% power after filtering."""
    n = 65536  # long trace for frequency resolution at low HP cutoff
    fs = 100.0
    freq = 0.005  # well below HP cutoff ~0.025 Hz

    t = np.arange(n) / fs
    trace = np.sin(2 * np.pi * freq * t)
    original_power = float(np.sum(trace ** 2))

    filtered = bandpass_filter(trace, tau_rise=0.02, tau_decay=0.4, fs=fs)

    filtered_power = float(np.sum(filtered ** 2))
    ratio = filtered_power / original_power
    assert ratio < 0.1, f"Stopband power ratio: {ratio:.4f}, expected < 0.1"


# ---------------------------------------------------------------------------
# Test 3: DC removal
# ---------------------------------------------------------------------------

def test_dc_removal():
    """Constant trace -> near-zero mean after filtering."""
    n = 256
    trace = np.full(n, 5.0)

    filtered = bandpass_filter(trace, tau_rise=0.02, tau_decay=0.4, fs=100.0)

    mean_val = abs(filtered.mean())
    assert mean_val < 0.1, f"DC not removed, mean: {mean_val}"


# ---------------------------------------------------------------------------
# Test 4: Short trace skip
# ---------------------------------------------------------------------------

def test_short_trace_skip():
    """Trace shorter than 8 samples returns input unchanged."""
    trace = np.array([1.0, 2.0, 3.0])
    filtered = bandpass_filter(trace, tau_rise=0.02, tau_decay=0.4, fs=30.0)
    np.testing.assert_array_equal(filtered, trace)


# ---------------------------------------------------------------------------
# Test 5: Invalid cutoffs (f_hp >= f_lp) returns input unchanged
# ---------------------------------------------------------------------------

def test_invalid_cutoffs_returns_unchanged():
    """When tau_rise is very large, f_hp > f_lp -> return input unchanged."""
    trace = np.ones(64)
    # tau_rise=10.0, tau_decay=0.001 -> f_hp ~ 9.95 Hz, f_lp ~ 0.064 Hz -> HP > LP
    filtered = bandpass_filter(trace, tau_rise=10.0, tau_decay=0.001, fs=30.0)
    np.testing.assert_array_equal(filtered, trace)


# ---------------------------------------------------------------------------
# Test 6: Output length matches input
# ---------------------------------------------------------------------------

def test_output_length_matches_input():
    """Filtered trace should have same length as input."""
    n = 500
    rng = np.random.default_rng(42)
    trace = rng.standard_normal(n)

    filtered = bandpass_filter(trace, tau_rise=0.02, tau_decay=0.4, fs=100.0)
    assert len(filtered) == n
