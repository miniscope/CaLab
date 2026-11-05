import { describe, it, expect } from 'vitest';
import { overviewChunkSize, extractCells } from '../dataset/overview-store.ts';

describe('overview helpers', () => {
  it('chunks to about four jobs per worker, capped at 64 cells', () => {
    expect(overviewChunkSize(1000, 8)).toBe(32);
    expect(overviewChunkSize(10, 8)).toBe(1);
    expect(overviewChunkSize(100000, 8)).toBe(64);
    expect(overviewChunkSize(5, 0)).toBe(5);
  });

  it('extracts cell-major traces in either orientation', () => {
    const data = { data: [0, 1, 2, 10, 11, 12], shape: [2, 3] };
    expect(Array.from(extractCells(data, false, 1, 2, 3))).toEqual([10, 11, 12]);
    const sw = { data: [0, 10, 1, 11, 2, 12], shape: [3, 2] };
    expect(Array.from(extractCells(sw, true, 0, 2, 3))).toEqual([0, 1, 2, 10, 11, 12]);
  });
});
