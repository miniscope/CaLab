/**
 * CaTune overview store: chunking, trace extraction, the worker round trip
 * (mocked pool), caching by dataset identity, failure reporting, and the
 * per-cell accessors the badge and the "By SNR" selector read.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OverviewPoolJob } from '../overview-pool.ts';
import type { CellOverview } from '@calab/core';

const dispatched: OverviewPoolJob[] = [];
let failNext = false;
vi.mock('../overview-pool.ts', () => ({
  createOverviewWorkerPool: () => ({
    size: 2,
    dispatch(job: OverviewPoolJob) {
      dispatched.push(job);
      queueMicrotask(() => {
        if (failNext) {
          job.onError('boom');
          return;
        }
        const cells: CellOverview[] = Array.from({ length: job.nCells }, (_, k) => ({
          snr: 3 + job.tracesFlat[k * job.nTimepoints],
          sigma: 1,
          nu: null,
          nEvents: 5,
          isSilent: job.tracesFlat[k * job.nTimepoints] === 0,
          eventRateHz: 0.1,
          medianEventHeight: 2,
          heightQuantiles: [],
          baselineBins: [1, 1],
          baselineStart: 1,
          baselineEnd: 1,
          nAtMax: 1,
          clipFraction: 0,
          nanCount: 0,
          longestGapFrames: 0,
        }));
        job.onComplete(cells);
      });
    },
    cancel() {},
    cancelAll() {},
    dispose() {},
  }),
}));

import {
  computeOverview,
  overview,
  overviewStatus,
  overviewError,
  overviewChunkSize,
  extractCells,
  snrByCell,
  cellSnrInfo,
} from '../overview-store.ts';
import {
  selectionMode,
  setSelectionMode,
  selectedCells,
  setDisplayCount,
  updateCellSelection,
} from '../multi-cell-store.ts';
import {
  setParsedData,
  setDimensionsConfirmed,
  setSamplingRate,
  setSwapped,
} from '../data-store.ts';

function seed(nCells: number, nT: number) {
  const data = new Float64Array(nCells * nT);
  for (let c = 0; c < nCells; c++) for (let t = 0; t < nT; t++) data[c * nT + t] = c;
  setParsedData({ data, shape: [nCells, nT], dtype: '<f8', fortranOrder: false });
  setDimensionsConfirmed(true);
  setSwapped(false);
  setSamplingRate(30);
}

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

describe('computeOverview', () => {
  beforeEach(() => {
    dispatched.length = 0;
    failNext = false;
  });

  it('computes SNR for every cell (not only solved ones) via the worker pool', async () => {
    seed(5, 40);
    expect(snrByCell()).toBeNull();
    await computeOverview();
    expect(overviewStatus()).toBe('ready');
    const ov = overview()!;
    expect(ov.kind).toBe('dataset-overview');
    expect(ov.nCells).toBe(5);
    expect(snrByCell()).toEqual([3, 4, 5, 6, 7]);
    expect(dispatched.length).toBe(5);
    expect(dispatched[0].minSeparationSamples).toBe(15);
    expect(dispatched[0].isDff).toBe(false);
  });

  it('exposes SNR, dataset rank, silent flag and cell count per cell', async () => {
    seed(5, 40);
    await computeOverview();
    expect(cellSnrInfo(0)).toMatchObject({ snr: 3, silent: true, nCells: 5, rank: 0 });
    expect(cellSnrInfo(4)).toMatchObject({ snr: 7, silent: false, rank: 1 });
    expect(cellSnrInfo(99)).toBeUndefined();
  });

  it('serves a repeat for the same dataset from the cache', async () => {
    seed(3, 20);
    await computeOverview();
    const first = overview();
    const n = dispatched.length;
    await computeOverview();
    expect(dispatched.length).toBe(n);
    expect(overview()).toBe(first);
  });

  it('reports a worker failure', async () => {
    seed(2, 20);
    failNext = true;
    await computeOverview();
    expect(overviewStatus()).toBe('error');
    expect(overviewError()).toBe('boom');
    expect(overview()).toBeNull();
    expect(cellSnrInfo(0)).toBeUndefined();
  });

  it('is idle without data', async () => {
    setParsedData(null);
    await computeOverview();
    expect(overviewStatus()).toBe('idle');
  });
});

describe('"By SNR" selection', () => {
  it('spreads the displayed cells across the SNR quantiles, strongest first', async () => {
    seed(50, 20);
    await computeOverview();
    setSelectionMode('by-snr');
    setDisplayCount(5);
    updateCellSelection();
    expect(selectionMode()).toBe('by-snr');
    const ids = selectedCells();
    expect(ids).toHaveLength(5);
    expect(ids).toEqual([...ids].sort((a, b) => b - a)); // SNR rises with cell id in the mock
    expect(ids[0]).toBeGreaterThan(40);
    expect(ids[4]).toBeLessThan(10);
    setSelectionMode('top-active');
  });
});
