// Dataset overview store: the model-free quality pass (shared measured-SNR
// metric, events, baseline, flags) for EVERY cell of the imported dataset.
//
// Runs once per dataset, off the main thread, in a short-lived worker pool the
// app supplies, and is cached by dataset identity. Display and cell selection
// only: nothing in it feeds a solver. CaTune and CaDecon each create one store.

import { createSignal, type Accessor } from 'solid-js';
import {
  buildDatasetOverview,
  OVERVIEW_PARAMS,
  type CellOverview,
  type DatasetOverview,
} from '@calab/core';
import type { BaseJob } from '@calab/compute';
import { dataIndex, type ImportStore } from '@calab/io';

export type OverviewStatus = 'idle' | 'computing' | 'ready' | 'error';

/** One chunk of cells for the overview worker. */
export interface OverviewJob extends BaseJob {
  tracesFlat: Float32Array;
  nCells: number;
  nTimepoints: number;
  fs: number;
  minSeparationSamples: number;
  isDff: boolean;
  baselineBins: number;
  onComplete(cells: CellOverview[]): void;
}

/** The slice of a worker pool the overview pass needs. */
export interface OverviewPool {
  readonly size: number;
  dispatch(job: OverviewJob): void;
  dispose(): void;
}

export interface OverviewStoreOptions {
  /** The app's import store (only the dataset signals are read). */
  importStore: Pick<ImportStore, 'parsedData' | 'effectiveShape' | 'swapped' | 'samplingRate'>;
  /** Create a short-lived pool for one overview run; disposed when the run ends. */
  createPool(): OverviewPool;
  /** When set, log the run time to the console under this app label. */
  logLabel?: string;
}

export interface OverviewStore {
  overview: Accessor<DatasetOverview | null>;
  overviewStatus: Accessor<OverviewStatus>;
  overviewProgress: Accessor<number>;
  overviewError: Accessor<string | null>;
  /** Run the overview pass for the current dataset (cached by dataset identity). */
  computeOverview(): Promise<void>;
  /** Drop the current overview and ignore any run still in flight. */
  resetOverview(): void;
}

/** Cells per worker job: enough jobs to balance the pool, few enough to amortise messaging. */
export function overviewChunkSize(nCells: number, poolSize: number): number {
  return Math.max(1, Math.min(64, Math.ceil(nCells / Math.max(1, poolSize * 4))));
}

/** Copy cells [c0, c1) into one cell-major Float32Array. */
export function extractCells(
  data: { data: ArrayLike<number>; shape: number[] },
  isSwapped: boolean,
  c0: number,
  c1: number,
  nT: number,
): Float32Array {
  const rawCols = data.shape[1];
  const out = new Float32Array((c1 - c0) * nT);
  for (let c = c0; c < c1; c++) {
    const base = (c - c0) * nT;
    for (let t = 0; t < nT; t++)
      out[base + t] = Number(data.data[dataIndex(c, t, rawCols, isSwapped)]);
  }
  return out;
}

/** Create an overview store. Call once per app, at module scope. */
export function createOverviewStore(options: OverviewStoreOptions): OverviewStore {
  const { parsedData, effectiveShape, swapped, samplingRate } = options.importStore;

  const [overview, setOverview] = createSignal<DatasetOverview | null>(null);
  const [overviewStatus, setOverviewStatus] = createSignal<OverviewStatus>('idle');
  const [overviewProgress, setOverviewProgress] = createSignal(0);
  const [overviewError, setOverviewError] = createSignal<string | null>(null);

  /** Cache keyed by the parsed matrix object, then by orientation + sampling rate. */
  const cache = new WeakMap<object, Map<string, DatasetOverview>>();
  let runToken = 0;

  function resetOverview(): void {
    runToken++;
    setOverview(null);
    setOverviewStatus('idle');
  }

  async function computeOverview(): Promise<void> {
    const data = parsedData();
    const shape = effectiveShape();
    const fs = samplingRate();
    const isSwap = swapped();
    if (!data || !shape || !fs) {
      resetOverview();
      return;
    }
    const key = `${isSwap}:${fs}`;
    const hit = cache.get(data)?.get(key);
    if (hit) {
      runToken++;
      setOverview(hit);
      setOverviewStatus('ready');
      return;
    }

    const token = ++runToken;
    const [nCells, nT] = shape;
    setOverview(null);
    setOverviewStatus('computing');
    setOverviewProgress(0);
    setOverviewError(null);
    const t0 = performance.now();

    const pool = options.createPool();
    const chunk = overviewChunkSize(nCells, pool.size);
    const cells: CellOverview[] = new Array(nCells);
    const minSep = Math.max(1, Math.round(OVERVIEW_PARAMS.eventSeparationS * fs));
    let done = 0;
    let firstError: string | null = null;

    try {
      await new Promise<void>((resolve) => {
        const nJobs = Math.ceil(nCells / chunk);
        let settled = 0;
        const settle = () => {
          if (++settled === nJobs) resolve();
        };
        for (let j = 0; j < nJobs; j++) {
          const c0 = j * chunk;
          const c1 = Math.min(nCells, c0 + chunk);
          pool.dispatch({
            jobId: j,
            tracesFlat: extractCells(data, isSwap, c0, c1, nT),
            nCells: c1 - c0,
            nTimepoints: nT,
            fs,
            minSeparationSamples: minSep,
            // No ΔF/F declaration exists at import, so ν is never computed.
            isDff: false,
            baselineBins: OVERVIEW_PARAMS.baselineBins,
            onComplete(result) {
              result.forEach((c, k) => {
                cells[c0 + k] = c;
              });
              done += c1 - c0;
              if (token === runToken) setOverviewProgress(done / nCells);
              settle();
            },
            onCancelled: settle,
            onError(msg) {
              firstError ??= msg;
              settle();
            },
          });
        }
      });
    } finally {
      pool.dispose();
    }
    if (token !== runToken) return;
    if (firstError || done < nCells) {
      setOverviewStatus('error');
      setOverviewError(firstError ?? 'overview pass was cancelled');
      return;
    }
    const result = buildDatasetOverview(cells, fs, nT);
    if (options.logLabel) {
      const elapsed = performance.now() - t0;
      console.info(
        `[${options.logLabel}] dataset overview: ${nCells} cells × ${nT} frames in ${elapsed.toFixed(0)} ms`,
      );
    }
    let perData = cache.get(data);
    if (!perData) cache.set(data, (perData = new Map()));
    perData.set(key, result);
    setOverview(result);
    setOverviewStatus('ready');
  }

  return {
    overview,
    overviewStatus,
    overviewProgress,
    overviewError,
    computeOverview,
    resetOverview,
  };
}
