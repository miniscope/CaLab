import { describe, expect, it } from 'vitest';
import {
  bucketRange,
  compareVersions,
  delta,
  fmtDuration,
  fmtNum,
  histogram,
  median,
  quantile,
  shortHash,
} from '../lib/stats.ts';

describe('median / quantile', () => {
  it('handles empty, single, even and NaN/null input', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([NaN, null, undefined, 3, 1])).toBe(2);
    expect(median([NaN, null])).toBeNull();
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6);
  });
});

describe('histogram', () => {
  it('bins finite values and counts every one', () => {
    const h = histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, NaN, null], 5);
    expect(h).toHaveLength(5);
    expect(h.reduce((a, b) => a + b.count, 0)).toBe(10);
  });
  it('returns one bin for identical values and none for empty', () => {
    expect(histogram([4, 4, 4])).toEqual([{ lo: 4, hi: 4, count: 3, label: '4' }]);
    expect(histogram([])).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('sorts numerically, with non-numeric last', () => {
    const v = ['2.18.0', '2.9.1', 'dev', '2.18.1', '10.0.0'].sort(compareVersions);
    expect(v).toEqual(['2.9.1', '2.18.0', '2.18.1', '10.0.0', 'dev']);
  });
});

describe('bucketRange', () => {
  it('lists every day and every Monday-based week, gaps included', () => {
    const a = Date.parse('2026-10-29T10:00:00Z');
    const b = Date.parse('2026-11-02T00:00:00Z');
    expect(bucketRange(a, b, 'day')).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
    expect(bucketRange(a, b, 'week')).toEqual(['2026-10-26']);
    expect(bucketRange(b, a, 'day')).toEqual([]);
  });
});

describe('delta and formatting', () => {
  it('computes deltas, with null for missing and zero baselines', () => {
    expect(delta(12, 10)).toEqual({ abs: 2, pct: 0.2 });
    expect(delta(5, 0)).toEqual({ abs: 5, pct: null });
    expect(delta(null, 3)).toBeNull();
  });
  it('formats', () => {
    expect(fmtNum(1234)).toBe('1,234');
    expect(fmtNum(NaN)).toBe('-');
    expect(fmtNum(12500)).toBe('12.5K');
    expect(fmtDuration(null)).toBe('-');
    expect(fmtDuration(90)).toBe('1.5 min');
  });
  it('shortHash is stable and 6 chars', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'));
    expect(shortHash('abc')).toHaveLength(6);
    expect(shortHash('abc')).not.toBe(shortHash('abd'));
  });
});
