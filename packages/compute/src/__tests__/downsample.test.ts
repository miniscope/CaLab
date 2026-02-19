import { describe, it, expect } from 'vitest';
import { downsampleMinMax } from '@calab/compute';

describe('downsampleMinMax', () => {
  it('returns data as-is when length <= 2 * targetBuckets', () => {
    const x = [0, 1, 2, 3, 4];
    const y = [10, 20, 30, 40, 50];
    const [rx, ry] = downsampleMinMax(x, y, 5); // 5 <= 2*5=10? Yes 5<=10
    expect(rx).toEqual(x);
    expect(ry).toEqual(y);
  });

  it('correctly reduces 1000 points to ~200 (100 buckets * 2 points each)', () => {
    const n = 1000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = Array.from({ length: n }, (_, i) => Math.sin(i * 0.1));
    const [rx, ry] = downsampleMinMax(x, y, 100);

    // Each bucket contributes 2 points (min and max)
    expect(rx.length).toBe(200);
    expect(ry.length).toBe(200);
  });

  it('preserves min and max values from original data', () => {
    const n = 1000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = Array.from({ length: n }, (_, i) => Math.sin(i * 0.1));

    const globalMin = Math.min(...y);
    const globalMax = Math.max(...y);

    const [, ry] = downsampleMinMax(x, y, 100);

    expect(Math.min(...ry)).toBeCloseTo(globalMin, 10);
    expect(Math.max(...ry)).toBeCloseTo(globalMax, 10);
  });

  it('orders min/max by time position within each bucket', () => {
    // Create data where in the first bucket, min comes before max
    // Bucket 0: indices 0..9 with values [0, -5, 1, 2, 3, 4, 5, 6, 7, 8]
    const x = Array.from({ length: 20 }, (_, i) => i);
    const y = [0, -5, 1, 2, 3, 4, 5, 6, 7, 8, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

    const [rx, ry] = downsampleMinMax(x, y, 2);

    // Bucket 0 (indices 0-9): min=-5 at idx 1, max=8 at idx 9 -> min first (1<9)
    expect(rx[0]).toBe(1); // minIdx
    expect(ry[0]).toBe(-5);
    expect(rx[1]).toBe(9); // maxIdx
    expect(ry[1]).toBe(8);

    // Bucket 1 (indices 10-19): min=1 at idx 19, max=10 at idx 10 -> max first (10<19)
    expect(rx[2]).toBe(10); // maxIdx first (10 < 19)
    expect(ry[2]).toBe(10);
    expect(rx[3]).toBe(19); // minIdx
    expect(ry[3]).toBe(1);
  });

  it('handles Float64Array input', () => {
    const x = new Float64Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const y = new Float64Array([5, 3, 8, 1, 9, 2, 7, 4, 6, 0]);

    const [rx, ry] = downsampleMinMax(x, y, 2);

    expect(rx).toBeInstanceOf(Array);
    expect(ry).toBeInstanceOf(Array);
    expect(rx.length).toBe(4); // 2 buckets * 2 points
    expect(ry.length).toBe(4);
  });

  it('handles empty arrays', () => {
    const [rx, ry] = downsampleMinMax([], [], 10);
    expect(rx).toEqual([]);
    expect(ry).toEqual([]);
  });

  it('handles single point', () => {
    const [rx, ry] = downsampleMinMax([0], [5], 10);
    expect(rx).toEqual([0]);
    expect(ry).toEqual([5]);
  });
});
