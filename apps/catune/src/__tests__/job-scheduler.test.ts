import { describe, it, expect } from 'vitest';
import {
  computePaddedWindow,
  shouldWarmStart,
  WarmStartCache,
  type WarmStartEntry,
} from '@calab/compute';
import type { SolverParams } from '@calab/core';

// ---------- computePaddedWindow ----------

describe('computePaddedWindow', () => {
  it('uses adaptive padding: max(visibleSamples, tauPadding)', () => {
    // visibleSamples = 1000, tauPadding = ceil(5*0.4*30) = 60
    // padding = min(max(1000, 60), 9000) = 1000
    const result = computePaddedWindow(1000, 2000, 10000, 0.4, 30);
    expect(result.paddedStart).toBe(0); // max(0, 1000-1000)
    expect(result.paddedEnd).toBe(3000); // min(10000, 2000+1000)
    expect(result.resultOffset).toBe(1000);
    expect(result.resultLength).toBe(1000);
  });

  it('clamps paddedStart to 0 when near trace start', () => {
    // visibleSamples = 480, tauPadding = 60, padding = max(480, 60) = 480
    const result = computePaddedWindow(20, 500, 10000, 0.4, 30);
    expect(result.paddedStart).toBe(0); // max(0, 20-480)
    expect(result.paddedEnd).toBe(980); // min(10000, 500+480)
    expect(result.resultOffset).toBe(20); // visibleStart - paddedStart = 20 - 0
    expect(result.resultLength).toBe(480);
  });

  it('clamps paddedEnd to traceLength when near trace end', () => {
    // visibleSamples = 200, tauPadding = 60, padding = max(200, 60) = 200
    const result = computePaddedWindow(9800, 10000, 10000, 0.4, 30);
    expect(result.paddedEnd).toBe(10000); // min(10000, 10200)
    expect(result.paddedStart).toBe(9600); // max(0, 9800-200)
    expect(result.resultOffset).toBe(200);
    expect(result.resultLength).toBe(200);
  });

  it('produces larger padding for larger tauDecay', () => {
    // paddingSamples = ceil(5 * 2.0 * 100) = 1000
    const result = computePaddedWindow(5000, 6000, 20000, 2.0, 100);
    expect(result.paddedStart).toBe(4000);
    expect(result.paddedEnd).toBe(7000);
    expect(result.resultOffset).toBe(1000);
    expect(result.resultLength).toBe(1000);
  });

  it('handles full-trace window (no padding extends beyond bounds)', () => {
    const result = computePaddedWindow(0, 10000, 10000, 0.4, 30);
    expect(result.paddedStart).toBe(0);
    expect(result.paddedEnd).toBe(10000);
    expect(result.resultOffset).toBe(0);
    expect(result.resultLength).toBe(10000);
  });
});

// ---------- shouldWarmStart ----------

describe('shouldWarmStart', () => {
  const baseParams: SolverParams = {
    tauRise: 0.02,
    tauDecay: 0.4,
    lambda: 0.01,
    fs: 30,
    filterEnabled: false,
  };

  function makeEntry(params: SolverParams, paddedStart = 940, paddedEnd = 2060): WarmStartEntry {
    return {
      state: new Uint8Array([1, 2, 3]),
      params,
      paddedStart,
      paddedEnd,
    };
  }

  it('returns cold when no cached entry', () => {
    expect(shouldWarmStart(null, baseParams, 940, 2060)).toBe('cold');
  });

  it('returns warm when only lambda changed', () => {
    const cached = makeEntry(baseParams);
    const newParams = { ...baseParams, lambda: 0.05 };
    expect(shouldWarmStart(cached, newParams, 940, 2060)).toBe('warm');
  });

  it('returns warm-no-momentum when tauDecay changes by < 20%', () => {
    const cached = makeEntry(baseParams);
    // 10% change: 0.4 -> 0.44
    const newParams = { ...baseParams, tauDecay: 0.44 };
    expect(shouldWarmStart(cached, newParams, 940, 2060)).toBe('warm-no-momentum');
  });

  it('returns cold when tauDecay doubles (> 20% change)', () => {
    const cached = makeEntry(baseParams);
    const newParams = { ...baseParams, tauDecay: 0.8 };
    expect(shouldWarmStart(cached, newParams, 940, 2060)).toBe('cold');
  });

  it('returns cold when window shifts', () => {
    const cached = makeEntry(baseParams, 940, 2060);
    // Same params but different window
    expect(shouldWarmStart(cached, baseParams, 1000, 2120)).toBe('cold');
  });

  it('returns warm when params and window are identical', () => {
    const cached = makeEntry(baseParams);
    expect(shouldWarmStart(cached, { ...baseParams }, 940, 2060)).toBe('warm');
  });

  it('returns warm-no-momentum when tauRise changes by < 20%', () => {
    const cached = makeEntry(baseParams);
    // 15% change: 0.02 -> 0.023
    const newParams = { ...baseParams, tauRise: 0.023 };
    expect(shouldWarmStart(cached, newParams, 940, 2060)).toBe('warm-no-momentum');
  });

  it('returns cold when fs changes', () => {
    const cached = makeEntry(baseParams);
    const newParams = { ...baseParams, fs: 60 };
    expect(shouldWarmStart(cached, newParams, 940, 2060)).toBe('cold');
  });
});

// ---------- WarmStartCache ----------

describe('WarmStartCache', () => {
  const params: SolverParams = {
    tauRise: 0.02,
    tauDecay: 0.4,
    lambda: 0.01,
    fs: 30,
    filterEnabled: false,
  };

  it('is initially empty', () => {
    const cache = new WarmStartCache();
    expect(cache.get()).toBeNull();
    const { strategy, state } = cache.getStrategy(params, 940, 2060);
    expect(strategy).toBe('cold');
    expect(state).toBeNull();
  });

  it('stores and retrieves warm-start state', () => {
    const cache = new WarmStartCache();
    const mockState = new Uint8Array([10, 20, 30]);
    cache.store(mockState, params, 940, 2060);

    expect(cache.get()).not.toBeNull();
    const { strategy, state } = cache.getStrategy(params, 940, 2060);
    expect(strategy).toBe('warm');
    expect(state).toBe(mockState);
  });

  it('clears the cache', () => {
    const cache = new WarmStartCache();
    cache.store(new Uint8Array([1]), params, 940, 2060);
    cache.clear();
    expect(cache.get()).toBeNull();
  });
});
