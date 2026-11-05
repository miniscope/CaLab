import { describe, it, expect } from 'vitest';
import {
  makeScale,
  scaleTicks,
  formatTick,
  formatTicks,
  labeledTicks,
  tickTarget,
  extent,
  binValues,
  idsInRange,
} from '../dataset/chart-scales.ts';

describe('makeScale', () => {
  it('maps linear domains and inverts', () => {
    const s = makeScale([0, 10], 0, 100);
    expect(s(5)).toBe(50);
    expect(s.invert(25)).toBe(2.5);
  });
  it('maps log domains by decade', () => {
    const s = makeScale([1, 100], 0, 100, true);
    expect(s(10)).toBeCloseTo(50);
    expect(s.invert(50)).toBeCloseTo(10);
    expect(Number.isFinite(s(0))).toBe(true);
  });
  it('survives a zero-width domain', () => {
    const s = makeScale([3, 3], 0, 10);
    expect(Number.isFinite(s(3))).toBe(true);
  });
});

describe('ticks', () => {
  it('uses 1/2/5 per decade on short log axes and decades on long ones', () => {
    expect(scaleTicks(makeScale([1, 20], 0, 1, true))).toEqual([1, 2, 5, 10, 20]);
    expect(scaleTicks(makeScale([0.5, 2000], 0, 1, true))).toEqual([1, 10, 100, 1000]);
  });
  it('formats compactly', () => {
    expect(formatTick(0)).toBe('0');
    expect(formatTick(1500)).toBe('1.5k');
    expect(formatTick(12.34)).toBe('12.3');
    expect(formatTick(2)).toBe('2');
    expect(formatTick(1.5)).toBe('1.5');
    expect(formatTick(0.0123)).toBe('0.012');
  });
  it('keeps neighbouring labels distinct with a shared precision', () => {
    expect(formatTicks([0.98, 0.99, 1])).toEqual(['0.98', '0.99', '1.00']);
    expect(formatTicks([0, 5, 10])).toEqual(['0', '5', '10']);
    expect(formatTicks([1, 10], true)).toEqual(['1', '10']);
    expect(formatTicks([0.5])).toEqual(['0.5']);
    const lt = labeledTicks(makeScale([0, 1], 0, 1), 2);
    expect(lt[0]).toEqual({ v: 0, label: '0.0' });
  });
  it('fits the tick count to the width', () => {
    expect(tickTarget(50)).toBe(2);
    expect(tickTarget(240)).toBe(5);
    expect(tickTarget(5000)).toBe(8);
  });
});

describe('extent and binning', () => {
  it('extent skips non-finite (and non-positive for log) values', () => {
    expect(extent([3, NaN, 1, 2])).toEqual([1, 3]);
    expect(extent([0, -1, 4, 8], true)).toEqual([4, 8]);
    expect(extent([])).toBeNull();
    expect(extent([2])).toEqual([1.5, 2.5]);
    expect(extent([2], true)).toEqual([2 / 1.5, 3]);
  });
  it('bins keep ids and clamp out-of-range values to the edges', () => {
    const bins = binValues([0.5, 1.5, 2.5, 99, NaN], [0, 3], 3, false, [10, 11, 12, 13, 14]);
    expect(bins.map((b) => b.ids)).toEqual([[10], [11], [12, 13]]);
    expect(bins[0].x0).toBe(0);
    expect(bins[2].x1).toBe(3);
  });
  it('bins in log space', () => {
    const bins = binValues([1, 10, 100, 0], [1, 100], 2, true);
    expect(bins[0].x1).toBeCloseTo(10);
    expect(bins.map((b) => b.ids)).toEqual([[0], [1, 2]]);
  });
  it('idsInRange is inclusive and order-free', () => {
    expect(idsInRange([1, 2, 3, 4], 3, 2)).toEqual([1, 2]);
    expect(idsInRange([1, 2], 0, 5, [7, 8])).toEqual([7, 8]);
  });
});
