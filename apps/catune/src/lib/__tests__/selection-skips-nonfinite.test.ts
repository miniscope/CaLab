/**
 * The automatic selection modes never pick a cell with NaN/Inf samples: the
 * solver rejects such traces, so tuning on one would only show it as skipped.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoot } from 'solid-js';

const snr = vi.hoisted(() => ({ values: null as number[] | null }));

vi.mock('../overview-store.ts', () => ({ snrByCell: () => snr.values }));

import {
  selectedCells,
  setDisplayCount,
  setSelectionMode,
  setActivityRanking,
  updateCellSelection,
  clearMultiCellState,
  computeRawStats,
} from '../multi-cell-store.ts';
import { setParsedData, resetImport } from '../data-store.ts';

const NUM_CELLS = 6;
const NUM_TIMEPOINTS = 50;
/** Cells 1 and 4 have a dropped frame. */
const BAD = [1, 4];

function withRoot(fn: () => void): void {
  createRoot((dispose) => {
    try {
      fn();
    } finally {
      dispose();
    }
  });
}

beforeEach(() => {
  resetImport();
  clearMultiCellState();
  const data = new Float64Array(NUM_CELLS * NUM_TIMEPOINTS).map((_, i) => Math.sin(i / 7));
  for (const c of BAD) data[c * NUM_TIMEPOINTS + 3] = NaN;
  setParsedData({ data, shape: [NUM_CELLS, NUM_TIMEPOINTS], dtype: '<f8', fortranOrder: false });
  snr.values = [5, 50, 10, 20, 40, 30];
});

describe('automatic cell selection skips cells with NaN/Inf samples', () => {
  it('top-active', () => {
    withRoot(() => {
      setActivityRanking([4, 1, 0, 2, 3, 5]);
      setDisplayCount(3);
      setSelectionMode('top-active');
      updateCellSelection();
      expect(selectedCells()).toEqual([0, 2, 3]);
    });
  });

  it('by SNR', () => {
    withRoot(() => {
      setDisplayCount(NUM_CELLS);
      setSelectionMode('by-snr');
      updateCellSelection();
      // Every eligible cell, strongest first; the high-SNR bad cells never appear.
      expect(selectedCells()).toEqual([5, 3, 2, 0]);
    });
  });

  it('random', () => {
    withRoot(() => {
      setDisplayCount(NUM_CELLS);
      setSelectionMode('random');
      for (let k = 0; k < 10; k++) {
        updateCellSelection();
        expect([...selectedCells()].sort()).toEqual([0, 2, 3, 5]);
      }
    });
  });
});

describe('computeRawStats on a skipped cell', () => {
  it('ignores NaN/Inf so the raw trace still draws', () => {
    const stats = computeRawStats(new Float64Array([1, NaN, 3, Infinity]));
    expect(stats.mean).toBe(2);
    expect(stats.std).toBe(1);
    expect(stats.zMin).toBe(-1);
    expect(stats.zMax).toBe(1);
  });
});
