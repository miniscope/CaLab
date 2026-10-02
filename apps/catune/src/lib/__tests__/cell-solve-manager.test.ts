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
  onCancelled(): void;
}

const fake = vi.hoisted(() => ({
  dispatched: [] as FakeJob[],
  cancelled: [] as number[],
}));

vi.mock('@calab/compute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@calab/compute')>();
  return {
    ...actual,
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

import { initCellSolveManager } from '../cell-solve-manager.ts';
import { setParsedData, setSamplingRate, resetImport } from '../data-store.ts';
import { setSelectedCells, clearMultiCellState } from '../multi-cell-store.ts';
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

describe('cell-solve-manager: job dispatch and cancellation', () => {
  let disposeRoot: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
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
