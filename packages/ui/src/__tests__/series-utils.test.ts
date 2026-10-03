import { describe, it, expect } from 'vitest';
import {
  solverInputLabel,
  TRACE_COLORS,
  withOpacity,
  subsetColor,
  OKABE_ITO_CYCLE,
} from '../chart/series-utils.ts';

describe('solverInputLabel', () => {
  it('names the working trace by what was done to it', () => {
    // The solver always baseline-subtracts; "Filtered" is only honest when a
    // filter actually ran.
    expect(solverInputLabel(false)).toBe('Baseline-corrected');
    expect(solverInputLabel(true)).toBe('Filtered');
  });

  it('is the only label for the filtered trace colour', () => {
    expect(TRACE_COLORS.filtered).not.toBe(TRACE_COLORS.raw);
  });
});

describe('withOpacity', () => {
  it('expands #rgb and #rrggbb to rgba', () => {
    expect(withOpacity('#000', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
    expect(withOpacity('#0072b2', 0.25)).toBe('rgba(0, 114, 178, 0.25)');
  });

  it('returns non-hex colours unchanged', () => {
    expect(withOpacity('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)');
  });
});

describe('subsetColor', () => {
  it('wraps around the Okabe-Ito cycle', () => {
    expect(subsetColor(0)).toBe(OKABE_ITO_CYCLE[0]);
    expect(subsetColor(OKABE_ITO_CYCLE.length + 2)).toBe(OKABE_ITO_CYCLE[2]);
  });
});
