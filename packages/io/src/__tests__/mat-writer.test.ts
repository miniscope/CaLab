import { describe, it, expect } from 'vitest';
import { writeMat } from '../mat-writer.ts';
import { parseMat } from '../mat-parser.ts';
import { processNpyResult } from '../array-utils.ts';

describe('writeMat', () => {
  it('round-trips a 2D matrix through parseMat (C order preserved)', () => {
    // Row-major [[1,2,3],[4,5,6]] (2 cells x 3 timepoints).
    const data = new Float32Array([1, 2, 3, 4, 5, 6]);
    const buf = writeMat('activity', data, [2, 3]);

    const parsed = parseMat(buf);
    expect(parsed.arrayNames).toEqual(['activity']);
    expect(parsed.arrays['activity'].shape).toEqual([2, 3]);
    // MATLAB is column-major, so the writer stores Fortran order.
    expect(parsed.arrays['activity'].fortranOrder).toBe(true);

    const c = processNpyResult(parsed.arrays['activity']);
    expect(c.shape).toEqual([2, 3]);
    expect(Array.from(c.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('writes column-major storage (raw order is Fortran)', () => {
    const data = new Float32Array([1, 2, 3, 4, 5, 6]); // [[1,2,3],[4,5,6]]
    const parsed = parseMat(writeMat('x', data, [2, 3]));
    // Column-major of [[1,2,3],[4,5,6]] is [1,4,2,5,3,6].
    expect(Array.from(parsed.arrays['x'].data)).toEqual([1, 4, 2, 5, 3, 6]);
  });

  it('preserves the variable name', () => {
    const parsed = parseMat(writeMat('traces_out', new Float32Array([1, 2, 3, 4]), [2, 2]));
    expect(parsed.arrayNames).toEqual(['traces_out']);
  });

  it('throws when data length does not match shape', () => {
    expect(() => writeMat('x', new Float32Array([1, 2, 3]), [2, 2])).toThrow(
      'does not match shape',
    );
  });
});
