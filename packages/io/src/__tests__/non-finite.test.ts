import { describe, it, expect } from 'vitest';
import {
  countNonFinitePerCell,
  cellsWithNonFinite,
  isNonFiniteCell,
  withoutNonFinite,
  nonFiniteSkipMessage,
} from '../non-finite.ts';

describe('countNonFinitePerCell', () => {
  it('counts NaN, +Inf and -Inf per cell of a [cells, timepoints] matrix', () => {
    const cell0 = [1, NaN, 3]; // one NaN
    const cell1 = [4, 5, 6]; // clean
    const cell2 = [Infinity, -Infinity, NaN]; // three
    const data = new Float32Array([...cell0, ...cell1, ...cell2]);
    const counts = countNonFinitePerCell({ data, shape: [3, 3] }, false);
    expect(Array.from(counts)).toEqual([1, 0, 3]);
  });

  it('reads a swapped [timepoints, cells] matrix by column', () => {
    // Stored shape [4 timepoints, 2 cells]; cell 1 has two NaNs.
    const data = new Float64Array([0, NaN, 1, 2, 3, NaN, 4, 5]);
    const counts = countNonFinitePerCell({ data, shape: [4, 2] }, true);
    expect(Array.from(counts)).toEqual([0, 2]);
  });

  it('returns zeros for integer arrays, which cannot hold NaN', () => {
    const counts = countNonFinitePerCell({ data: new Int16Array(6), shape: [2, 3] }, false);
    expect(Array.from(counts)).toEqual([0, 0]);
  });

  it('returns an empty array for a non-2D shape', () => {
    expect(countNonFinitePerCell({ data: new Float32Array(3), shape: [3] }, false)).toHaveLength(0);
  });
});

describe('skip helpers', () => {
  const counts = new Uint32Array([0, 2, 0, 1]);

  it('lists the affected cells in ascending order', () => {
    expect(cellsWithNonFinite(counts)).toEqual([1, 3]);
    expect(cellsWithNonFinite(null)).toEqual([]);
  });

  it('flags a cell only when its count is positive', () => {
    expect(isNonFiniteCell(counts, 1)).toBe(true);
    expect(isNonFiniteCell(counts, 0)).toBe(false);
    expect(isNonFiniteCell(counts, 99)).toBe(false);
    expect(isNonFiniteCell(null, 1)).toBe(false);
  });

  it('drops affected cells from a candidate list, keeping order', () => {
    expect(withoutNonFinite([3, 2, 1, 0], counts)).toEqual([2, 0]);
    expect(withoutNonFinite([3, 1], null)).toEqual([3, 1]);
  });

  it('says how many samples are missing', () => {
    expect(nonFiniteSkipMessage(90)).toBe('Skipped: trace contains 90 missing (NaN/Inf) samples');
    expect(nonFiniteSkipMessage(1)).toBe('Skipped: trace contains 1 missing (NaN/Inf) sample');
  });
});
