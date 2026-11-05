import { describe, it, expect } from 'vitest';
import { pickSnrSpread } from '../cell-ranking.ts';

describe('pickSnrSpread', () => {
  // SNR increases with cell id: 1..100
  const snr = Array.from({ length: 100 }, (_, i) => i + 1);

  it('takes the 10th/30th/50th/70th/90th percentile cells, strongest first', () => {
    const ids = pickSnrSpread(snr, 5);
    expect(ids).toHaveLength(5);
    // strongest first, evenly spread over the SNR order
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids[0]).toBeGreaterThan(85);
    expect(ids[4]).toBeLessThan(15);
    expect(Math.abs(ids[2] - 50)).toBeLessThanOrEqual(2);
  });

  it('works on an unsorted SNR array (ids follow SNR order, not index order)', () => {
    const shuffled = [9, 1, 5, 3, 7]; // ids 0..4
    expect(pickSnrSpread(shuffled, 5)).toEqual([0, 4, 2, 3, 1]);
  });

  it('ignores non-finite SNRs and returns everything when asked for more than exists', () => {
    expect(pickSnrSpread([NaN, 2, Infinity, 1], 10)).toEqual([1, 3]);
  });

  it('never repeats a cell', () => {
    const ids = pickSnrSpread(snr, 19);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('restricts to a candidate set (a brush)', () => {
    const among = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const ids = pickSnrSpread(snr, 3, among);
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(among).toContain(id);
  });

  it('handles empty input and count 0', () => {
    expect(pickSnrSpread([], 5)).toEqual([]);
    expect(pickSnrSpread(snr, 0)).toEqual([]);
  });
});
