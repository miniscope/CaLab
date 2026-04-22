/**
 * Reactivity tests for multi-cell-store.
 *
 * Covers selection-mode branching (top-active / random / manual), the per-cell
 * update helpers that gate on existing rows, and the snapshot/clear lifecycle
 * for pinned multi-cell comparisons.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot } from 'solid-js';
import {
  selectionMode,
  setSelectionMode,
  selectedCells,
  setSelectedCells,
  displayCount,
  setDisplayCount,
  multiCellResults,
  setMultiCellResults,
  multiCellSolving,
  setMultiCellSolving,
  multiCellProgress,
  setMultiCellProgress,
  solvingCells,
  setSolvingCells,
  activelySolvingCell,
  setActivelySolvingCell,
  activityRanking,
  setActivityRanking,
  gridColumns,
  setGridColumns,
  cellSolverStatuses,
  cellIterationCounts,
  pinnedMultiCellResults,
  visibleCellIndices,
  setVisibleCellIndices,
  hoveredCell,
  setHoveredCell,
  updateOneCellStatus,
  updateOneCellIteration,
  updateOneCellTraces,
  updateCellSelection,
  clearMultiCellState,
  pinMultiCellResults,
  unpinMultiCellResults,
} from '../multi-cell-store.ts';
import { setParsedData, resetImport } from '../data-store.ts';

// ── helpers ────────────────────────────────────────────────────────────────

function withRoot<T>(fn: () => T): T {
  return createRoot((dispose) => {
    try {
      return fn();
    } finally {
      dispose();
    }
  });
}

function seedDataset(numCells: number, numTimepoints: number): void {
  const data = new Float64Array(numCells * numTimepoints);
  setParsedData({
    data,
    shape: [numCells, numTimepoints],
    dtype: '<f8',
    fortranOrder: false,
  });
}

function seedCellTraces(cellIndex: number): void {
  setMultiCellResults(cellIndex, {
    cellIndex,
    raw: new Float64Array(10),
    rawStats: { mean: 0, std: 1, zMin: 0, zMax: 0 },
    deconvolved: new Float32Array(10),
    deconvMinMax: [0, 0],
    reconvolution: new Float32Array(10),
  });
}

function resetStoreState(): void {
  clearMultiCellState();
  unpinMultiCellResults();
  setDisplayCount(5);
  setMultiCellSolving(false);
  setMultiCellProgress(null);
  setGridColumns(2);
  setVisibleCellIndices(new Set<number>());
  setHoveredCell(null);
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('multi-cell-store: signals', () => {
  beforeEach(() => {
    resetStoreState();
    resetImport();
  });

  it('selectionMode setter cycles through modes', () => {
    withRoot(() => {
      expect(selectionMode()).toBe('top-active');
      setSelectionMode('random');
      expect(selectionMode()).toBe('random');
      setSelectionMode('manual');
      expect(selectionMode()).toBe('manual');
    });
  });

  it('selectedCells, displayCount, gridColumns are independent writable signals', () => {
    withRoot(() => {
      setSelectedCells([1, 2, 3]);
      setDisplayCount(8);
      setGridColumns(4);
      expect(selectedCells()).toEqual([1, 2, 3]);
      expect(displayCount()).toBe(8);
      expect(gridColumns()).toBe(4);
    });
  });

  it('solving signals track progress state', () => {
    withRoot(() => {
      setMultiCellSolving(true);
      setMultiCellProgress({ current: 3, total: 10 });
      setActivelySolvingCell(7);
      setSolvingCells(new Set([7, 8, 9]));
      expect(multiCellSolving()).toBe(true);
      expect(multiCellProgress()).toEqual({ current: 3, total: 10 });
      expect(activelySolvingCell()).toBe(7);
      expect([...solvingCells()].sort()).toEqual([7, 8, 9]);
    });
  });

  it('visibleCellIndices and hoveredCell track viewport signals', () => {
    withRoot(() => {
      setVisibleCellIndices(new Set([0, 1, 2]));
      setHoveredCell(2);
      expect([...visibleCellIndices()].sort()).toEqual([0, 1, 2]);
      expect(hoveredCell()).toBe(2);
      setHoveredCell(null);
      expect(hoveredCell()).toBeNull();
    });
  });
});

// ── updateCellSelection: mode-dependent branching ──────────────────────────

describe('multi-cell-store: updateCellSelection', () => {
  beforeEach(() => {
    resetStoreState();
    resetImport();
  });

  it('top-active takes first N entries from activityRanking', () => {
    withRoot(() => {
      seedDataset(20, 300);
      setActivityRanking([5, 10, 3, 8, 0, 7, 2]);
      setDisplayCount(3);
      setSelectionMode('top-active');
      updateCellSelection();
      expect(selectedCells()).toEqual([5, 10, 3]);
    });
  });

  it('top-active is a no-op when activityRanking is null', () => {
    withRoot(() => {
      setActivityRanking(null);
      setSelectedCells([42]); // sentinel
      setSelectionMode('top-active');
      updateCellSelection();
      expect(selectedCells()).toEqual([42]);
    });
  });

  it('random mode samples displayCount cells from the loaded shape', () => {
    withRoot(() => {
      seedDataset(8, 300);
      setDisplayCount(4);
      setSelectionMode('random');
      updateCellSelection();
      const picks = selectedCells();
      expect(picks).toHaveLength(4);
      for (const idx of picks) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(8);
      }
      // No duplicates
      expect(new Set(picks).size).toBe(4);
    });
  });

  it('random mode is a no-op when no dataset is loaded', () => {
    withRoot(() => {
      setSelectedCells([99]);
      setSelectionMode('random');
      updateCellSelection();
      expect(selectedCells()).toEqual([99]);
    });
  });

  it('manual mode never touches selectedCells', () => {
    withRoot(() => {
      seedDataset(10, 300);
      setActivityRanking([0, 1, 2, 3, 4]);
      setSelectedCells([9, 8]);
      setSelectionMode('manual');
      updateCellSelection();
      expect(selectedCells()).toEqual([9, 8]);
    });
  });
});

// ── per-cell update helpers ────────────────────────────────────────────────

describe('multi-cell-store: per-cell update helpers', () => {
  beforeEach(() => {
    resetStoreState();
    resetImport();
  });

  it('updateOneCellStatus writes status and zeroes iterations on stale', () => {
    withRoot(() => {
      updateOneCellIteration(0, 50);
      updateOneCellStatus(0, 'solving');
      expect(cellSolverStatuses[0]).toBe('solving');
      expect(cellIterationCounts[0]).toBe(50);

      updateOneCellStatus(0, 'stale');
      expect(cellSolverStatuses[0]).toBe('stale');
      expect(cellIterationCounts[0]).toBe(0);
    });
  });

  it('updateOneCellIteration writes per-cell iteration count', () => {
    withRoot(() => {
      updateOneCellIteration(5, 123);
      expect(cellIterationCounts[5]).toBe(123);
      updateOneCellIteration(5, 200);
      expect(cellIterationCounts[5]).toBe(200);
    });
  });

  it('updateOneCellTraces ignores cells with no existing entry', () => {
    withRoot(() => {
      updateOneCellTraces(99, new Float32Array([1, 2]), new Float32Array([3, 4]));
      expect(multiCellResults[99]).toBeUndefined();
    });
  });

  it('updateOneCellTraces merges deconvolved/reconvolution when the cell exists', () => {
    withRoot(() => {
      seedCellTraces(7);
      const d = new Float32Array([0.1, 0.2, 0.3]);
      const r = new Float32Array([0.01, 0.02, 0.03]);
      const filtered = new Float32Array([0.5, 0.6, 0.7]);
      updateOneCellTraces(7, d, r, 42, filtered);
      expect(multiCellResults[7].deconvolved).toBe(d);
      expect(multiCellResults[7].reconvolution).toBe(r);
      expect(multiCellResults[7].filteredTrace).toBe(filtered);
      expect(multiCellResults[7].windowStartSample).toBe(42);
      // Raw trace preserved
      expect(multiCellResults[7].raw).toBeDefined();
    });
  });
});

// ── pinned snapshots ───────────────────────────────────────────────────────

describe('multi-cell-store: pinned snapshots', () => {
  beforeEach(() => {
    resetStoreState();
    resetImport();
  });

  it('pinMultiCellResults snapshots the current live results by value', () => {
    withRoot(() => {
      seedCellTraces(0);
      seedCellTraces(1);
      // Set known values on the live store
      setMultiCellResults(0, (r) => ({ ...r, deconvolved: new Float32Array([9]) }));
      pinMultiCellResults();
      expect(pinnedMultiCellResults[0]).toBeDefined();
      expect(pinnedMultiCellResults[0].deconvolved[0]).toBe(9);

      // Subsequent live edits should not affect the pinned snapshot
      setMultiCellResults(0, (r) => ({ ...r, deconvolved: new Float32Array([1]) }));
      expect(pinnedMultiCellResults[0].deconvolved[0]).toBe(9);
    });
  });

  it('unpinMultiCellResults clears the snapshot', () => {
    withRoot(() => {
      seedCellTraces(0);
      pinMultiCellResults();
      expect(Object.keys(pinnedMultiCellResults).length).toBeGreaterThan(0);
      unpinMultiCellResults();
      expect(Object.keys(pinnedMultiCellResults)).toEqual([]);
    });
  });
});

// ── clearMultiCellState ────────────────────────────────────────────────────

describe('multi-cell-store: clearMultiCellState', () => {
  it('restores selection-mode, clears results, statuses, iteration counts, and selection', () => {
    withRoot(() => {
      seedCellTraces(0);
      updateOneCellStatus(0, 'solving');
      updateOneCellIteration(0, 50);
      setSelectionMode('random');
      setSelectedCells([5, 6]);
      setSolvingCells(new Set([1, 2]));
      setActivelySolvingCell(1);
      setActivityRanking([0, 1]);

      clearMultiCellState();

      expect(Object.keys(multiCellResults)).toEqual([]);
      expect(Object.keys(cellSolverStatuses)).toEqual([]);
      expect(Object.keys(cellIterationCounts)).toEqual([]);
      expect(selectedCells()).toEqual([]);
      expect([...solvingCells()]).toEqual([]);
      expect(activelySolvingCell()).toBeNull();
      expect(activityRanking()).toBeNull();
      expect(selectionMode()).toBe('top-active');
    });
  });
});
