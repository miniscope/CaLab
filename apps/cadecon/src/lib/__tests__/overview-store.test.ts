/**
 * Overview store: chunking, trace extraction, the worker round trip (mocked
 * pool), caching by dataset identity, and failure reporting.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CaDeconPoolJob } from '../cadecon-pool.ts';
import type { CellOverview } from '@calab/core';

const dispatched: CaDeconPoolJob[] = [];
let failNext = false;
vi.mock('../cadecon-pool.ts', () => ({
  createCaDeconWorkerPool: () => ({
    size: 2,
    dispatch(job: CaDeconPoolJob) {
      dispatched.push(job);
      if (job.kind !== 'overview') return;
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
          isSilent: false,
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
} from '../overview-store.ts';
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
    // swapped: stored frames-major, 3 frames x 2 cells
    const sw = { data: [0, 10, 1, 11, 2, 12], shape: [3, 2] };
    expect(Array.from(extractCells(sw, true, 0, 2, 3))).toEqual([0, 1, 2, 10, 11, 12]);
  });
});

describe('computeOverview', () => {
  beforeEach(() => {
    dispatched.length = 0;
    failNext = false;
  });

  it('runs one overview job per chunk and assembles the dataset overview', async () => {
    seed(5, 40);
    await computeOverview();
    expect(overviewStatus()).toBe('ready');
    const ov = overview()!;
    expect(ov.kind).toBe('dataset-overview');
    expect(ov.nCells).toBe(5);
    expect(ov.cells.map((c) => c.snr)).toEqual([3, 4, 5, 6, 7]);
    expect(dispatched.length).toBe(5);
    const job = dispatched[0];
    expect(job.kind).toBe('overview');
    if (job.kind === 'overview') {
      expect(job.minSeparationSamples).toBe(15);
      expect(job.isDff).toBe(false);
    }
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
  });

  it('is idle without data', async () => {
    setParsedData(null);
    await computeOverview();
    expect(overviewStatus()).toBe('idle');
  });
});
