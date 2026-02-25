import { describe, it, expect, vi, afterEach } from 'vitest';
import { getDefaultWorkerCount, getWorkersOverride, resolveWorkerCount } from '@calab/compute';

describe('getDefaultWorkerCount', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cores-1 for typical hardware', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    expect(getDefaultWorkerCount()).toBe(7);
  });

  it('floors at 2 for low-core machines', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    expect(getDefaultWorkerCount()).toBe(2);
  });

  it('caps at 8 for high-core machines', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 20 });
    expect(getDefaultWorkerCount()).toBe(8);
  });

  it('returns 3 when hardwareConcurrency is undefined', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: undefined });
    expect(getDefaultWorkerCount()).toBe(3);
  });
});

describe('getWorkersOverride', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no workers param', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    expect(getWorkersOverride()).toBe(null);
  });

  it('parses a valid integer', () => {
    vi.stubGlobal('window', { location: { search: '?workers=6' } });
    expect(getWorkersOverride()).toBe(6);
  });

  it('returns null for zero', () => {
    vi.stubGlobal('window', { location: { search: '?workers=0' } });
    expect(getWorkersOverride()).toBe(null);
  });

  it('clamps to 16 for large values', () => {
    vi.stubGlobal('window', { location: { search: '?workers=20' } });
    expect(getWorkersOverride()).toBe(16);
  });

  it('returns null for non-numeric values', () => {
    vi.stubGlobal('window', { location: { search: '?workers=abc' } });
    expect(getWorkersOverride()).toBe(null);
  });

  it('returns null for negative values', () => {
    vi.stubGlobal('window', { location: { search: '?workers=-2' } });
    expect(getWorkersOverride()).toBe(null);
  });

  it('returns null for floating-point values', () => {
    vi.stubGlobal('window', { location: { search: '?workers=3.5' } });
    expect(getWorkersOverride()).toBe(null);
  });
});

describe('resolveWorkerCount', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses URL override when present', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    vi.stubGlobal('window', { location: { search: '?workers=3' } });
    expect(resolveWorkerCount()).toBe(3);
  });

  it('falls back to hardware default when no override', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    vi.stubGlobal('window', { location: { search: '' } });
    expect(resolveWorkerCount()).toBe(7);
  });
});
