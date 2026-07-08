import { describe, it, expect } from 'vitest';
import { niceTicks } from '../chart/chart-math.ts';

describe('niceTicks', () => {
  it('produces round steps within the range', () => {
    const ticks = niceTicks(0, 300, 6);
    expect(ticks[0]).toBe(0);
    expect(ticks).toEqual([0, 50, 100, 150, 200, 250, 300]);
  });

  it('stays within [min, max]', () => {
    const ticks = niceTicks(0, 37, 5);
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(37);
    // 1/2/5 x 10^k snapping → step of 10 for this range.
    expect(ticks).toEqual([0, 10, 20, 30]);
  });

  it('handles fractional ranges and snaps fp residue to 0', () => {
    const ticks = niceTicks(0, 1, 5);
    expect(ticks).toContain(0);
    // No tiny fp residue like 0.30000000000000004.
    for (const t of ticks) {
      expect(Number(t.toFixed(10))).toBe(t);
    }
  });

  it('degenerates safely on invalid input', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(10, 0)).toEqual([10]);
    expect(niceTicks(NaN, 1)).toEqual([NaN]);
  });
});
