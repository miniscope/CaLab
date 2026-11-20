import { describe, it, expect } from 'vitest';
import { rectifiedCells, RECTIFIED_ZERO_FRACTION } from '../rectified.ts';

describe('rectifiedCells', () => {
  const clipped = [0, 0, 0, 1.5, 0, 2, 0.1, 0, 3, 0]; // 6/10 exact zeros, none negative
  const signed = [-0.2, 0.1, 0, 1.5, -0.4, 2, 0.1, 0, 3, -0.1]; // has negatives
  const positive = [5, 6, 5, 7, 6, 5, 8, 6, 5, 6]; // raw fluorescence, no zeros
  const fewZeros = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // 1/10 zeros: below the fraction

  it('flags only non-negative traces with at least the zero fraction of exact zeros', () => {
    const data = new Float32Array([...clipped, ...signed, ...positive, ...fewZeros]);
    expect(rectifiedCells({ data, shape: [4, 10] }, false)).toEqual([0]);
  });

  it('applies the threshold at exactly the zero fraction', () => {
    const n = 10;
    const atFraction = Array.from({ length: n }, (_, i) =>
      i < RECTIFIED_ZERO_FRACTION * n ? 0 : 1,
    );
    const data = new Float64Array(atFraction);
    expect(rectifiedCells({ data, shape: [1, n] }, false)).toEqual([0]);
  });

  it('reads cells from columns when swapped', () => {
    // [timepoints, cells] = [10, 2]: column 0 clipped, column 1 positive
    const data = new Float32Array(clipped.flatMap((v, t) => [v, positive[t]]));
    expect(rectifiedCells({ data, shape: [10, 2] }, true)).toEqual([0]);
  });

  it('ignores non-finite samples', () => {
    const data = new Float32Array([NaN, 0, 0, 1, Infinity, 2]);
    expect(rectifiedCells({ data, shape: [1, 6] }, false)).toEqual([0]);
  });

  it('returns nothing for all-NaN cells or 1-D data', () => {
    expect(rectifiedCells({ data: new Float32Array([NaN, NaN]), shape: [1, 2] }, false)).toEqual(
      [],
    );
    expect(rectifiedCells({ data: new Float32Array([0, 0]), shape: [2] }, false)).toEqual([]);
  });
});
