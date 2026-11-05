/**
 * Dispatch/cancel sequencing tests for cell-solve-manager.
 *
 * The worker pool is replaced with a fake that records dispatched jobs and
 * cancel calls; jobs never complete on their own, which models a pool that is
 * still busy solving when the user moves a slider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'solid-js';

interface FakeJob {
  jobId: number;
  cellIndex: number;
  onCancelled(): void;
}

const fake = vi.hoisted(() => ({
  dispatched: [] as FakeJob[],
  cancelled: [] as number[],
  /** Backend the next initCellSolveManager() sees as requested. */
  requested: 'wasm' as 'wasm' | 'gpu',
}));

// Only the requested backend matters here: the pool is always the fake one.
vi.mock('../solver-backend.ts', () => ({
  createSolverPool: (make: () => unknown) => make(),
  backendStatus: () => ({ requested: fake.requested }),
}));

vi.mock('../catune-pool.ts', () => {
  return {
    createCaTuneWorkerPool: () => ({
      size: 2,
      dispatch(job: FakeJob) {
        fake.dispatched.push(job);
      },
      cancel(jobId: number) {
        fake.cancelled.push(jobId);
      },
      cancelAll() {},
      dispose() {},
    }),
  };
});

import { initCellSolveManager, reportCellZoom } from '../cell-solve-manager.ts';
import { setParsedData, setSamplingRate, resetImport } from '../data-store.ts';
import { setSelectedCells, clearMultiCellState, cellSolverStatuses } from '../multi-cell-store.ts';
import { setLambda } from '../viz-store.ts';

const NUM_CELLS = 3;
const NUM_TIMEPOINTS = 3000;

function seedDataset(): void {
  setParsedData({
    data: new Float64Array(NUM_CELLS * NUM_TIMEPOINTS).map((_, i) => Math.sin(i / 10)),
    shape: [NUM_CELLS, NUM_TIMEPOINTS],
    dtype: '<f8',
    fortranOrder: false,
  });
  setSamplingRate(30);
}

// cell-solve-manager.ts debounce (DEBOUNCE_MS).
const DEBOUNCE_MS = 30;

describe('cell-solve-manager: job dispatch and cancellation', () => {
  let disposeRoot: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.requested = 'wasm';
    fake.dispatched.length = 0;
    fake.cancelled.length = 0;
    resetImport();
    clearMultiCellState();
    setLambda(0);
    seedDataset();
    setSelectedCells([0, 1, 2]);
    createRoot((dispose) => {
      disposeRoot = dispose;
      initCellSolveManager();
    });
  });

  afterEach(() => {
    disposeRoot?.();
    disposeRoot = null;
    setSelectedCells([]);
    vi.useRealTimers();
  });

  it('dispatches each cell exactly once on initial load', () => {
    expect(fake.dispatched).toHaveLength(NUM_CELLS);
    // Let any debounced dispatch fire; the param effect must not re-solve on mount.
    vi.advanceTimersByTime(500);
    expect(fake.dispatched).toHaveLength(NUM_CELLS);
    expect(fake.cancelled).toEqual([]);
  });

  it('cancels the previous job of every active cell on param change', () => {
    const initialIds = fake.dispatched.map((j) => j.jobId);
    expect(initialIds).toHaveLength(NUM_CELLS);

    setLambda(0.5);
    expect([...fake.cancelled].sort()).toEqual([...initialIds].sort());

    // Debounced re-dispatch: one fresh job per cell, nothing left to cancel.
    vi.advanceTimersByTime(500);
    expect(fake.dispatched).toHaveLength(2 * NUM_CELLS);
    expect(fake.cancelled).toHaveLength(NUM_CELLS);
  });

  it('debounces each cell on its own timer on the default (WASM) backend', () => {
    // Cache misses (no padded result yet) on two cells, half a debounce apart.
    reportCellZoom(0, 0, 10);
    vi.advanceTimersByTime(DEBOUNCE_MS / 2);
    reportCellZoom(1, 0, 10);
    expect(vi.getTimerCount()).toBe(2);

    // Cell 0 fires on its own schedule; cell 1's reschedule did not delay it.
    vi.advanceTimersByTime(DEBOUNCE_MS / 2);
    expect(fake.dispatched.slice(NUM_CELLS).map((j) => j.cellIndex)).toEqual([0]);

    // Re-scheduling cell 0 does not cancel cell 1's pending dispatch.
    reportCellZoom(0, 0, 10);
    vi.advanceTimersByTime(DEBOUNCE_MS / 2);
    expect(fake.dispatched.slice(NUM_CELLS).map((j) => j.cellIndex)).toEqual([0, 1]);
    vi.advanceTimersByTime(DEBOUNCE_MS / 2);
    expect(fake.dispatched.slice(NUM_CELLS).map((j) => j.cellIndex)).toEqual([0, 1, 0]);
  });

  it('uses one timer per cell after a param change on the WASM backend', () => {
    setLambda(0.5);
    expect(vi.getTimerCount()).toBe(NUM_CELLS);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(fake.dispatched).toHaveLength(2 * NUM_CELLS);
  });

  it('cancels once per cell across a multi-tick slider drag', () => {
    setLambda(0.1);
    setLambda(0.2);
    setLambda(0.3);
    expect(fake.cancelled).toHaveLength(NUM_CELLS);

    vi.advanceTimersByTime(500);
    expect(fake.dispatched).toHaveLength(2 * NUM_CELLS);
    const freshIds = fake.dispatched.slice(NUM_CELLS).map((j) => j.jobId);

    // The next param change cancels the fresh jobs, not stale ones.
    setLambda(0.4);
    expect(fake.cancelled.slice(NUM_CELLS).sort()).toEqual([...freshIds].sort());
  });
});

describe('cell-solve-manager: GPU backend debounce', () => {
  let disposeRoot: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.requested = 'gpu';
    fake.dispatched.length = 0;
    fake.cancelled.length = 0;
    resetImport();
    clearMultiCellState();
    setLambda(0);
    seedDataset();
    setSelectedCells([0, 1, 2]);
    createRoot((dispose) => {
      disposeRoot = dispose;
      initCellSolveManager();
    });
  });

  afterEach(() => {
    disposeRoot?.();
    disposeRoot = null;
    setSelectedCells([]);
    fake.requested = 'wasm';
    vi.useRealTimers();
  });

  it('re-dispatches every cell from one timer callback after a param change', () => {
    setLambda(0.5);
    expect(vi.getTimerCount()).toBe(1); // one shared debounce, not one per cell
    vi.advanceTimersToNextTimer();
    // All cells reached the pool in the same task, so a batch consumer sees them together.
    expect(fake.dispatched).toHaveLength(2 * NUM_CELLS);
  });
});

describe('cell-solve-manager: a cell with NaN/Inf samples', () => {
  let disposeRoot: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.requested = 'wasm';
    fake.dispatched.length = 0;
    fake.cancelled.length = 0;
    resetImport();
    clearMultiCellState();
    setLambda(0);
    seedDataset();
  });

  afterEach(() => {
    disposeRoot?.();
    disposeRoot = null;
    setSelectedCells([]);
    vi.useRealTimers();
  });

  it('is never dispatched and shows as skipped, not as an error', () => {
    const data = new Float64Array(NUM_CELLS * NUM_TIMEPOINTS).map((_, i) => Math.sin(i / 10));
    data[1 * NUM_TIMEPOINTS + 5] = NaN;
    setParsedData({
      data,
      shape: [NUM_CELLS, NUM_TIMEPOINTS],
      dtype: '<f8',
      fortranOrder: false,
    });
    setSelectedCells([0, 1, 2]);
    createRoot((dispose) => {
      disposeRoot = dispose;
      initCellSolveManager();
    });

    expect(fake.dispatched.map((j) => j.cellIndex).sort()).toEqual([0, 2]);
    expect(cellSolverStatuses[1]).toBe('skipped');

    // A parameter change re-solves the others and still skips it.
    setLambda(0.5);
    vi.advanceTimersByTime(500);
    expect(fake.dispatched.filter((j) => j.cellIndex === 1)).toHaveLength(0);
    expect(cellSolverStatuses[1]).toBe('skipped');
  });
});
