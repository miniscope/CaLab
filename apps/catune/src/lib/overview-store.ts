// Dataset overview store: the model-free quality pass (shared measured-SNR
// metric, events, baseline, flags) for EVERY cell of the imported dataset.
//
// Runs once per dataset, off the main thread, in a short-lived worker pool, and
// is cached by dataset identity. Display and cell selection only: nothing in it
// feeds the solver. CaDecon runs the same pass (apps/cadecon/src/lib/overview-store.ts).

import { createSignal } from 'solid-js';
import { buildDatasetOverview, OVERVIEW_PARAMS, type CellOverview } from '@calab/core';
import type { DatasetOverview } from '@calab/core';
import { dataIndex } from '@calab/io';
import { createOverviewWorkerPool } from './overview-pool.ts';
import { parsedData, effectiveShape, swapped, samplingRate } from './data-store.ts';

export type OverviewStatus = 'idle' | 'computing' | 'ready' | 'error';

const [overview, setOverview] = createSignal<DatasetOverview | null>(null);
const [overviewStatus, setOverviewStatus] = createSignal<OverviewStatus>('idle');
const [overviewProgress, setOverviewProgress] = createSignal(0);
const [overviewError, setOverviewError] = createSignal<string | null>(null);

/** Cache keyed by the parsed matrix object, then by orientation + sampling rate. */
const cache = new WeakMap<object, Map<string, DatasetOverview>>();
let runToken = 0;

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

/** Run the overview pass for the current dataset (cached by dataset identity). */
export async function computeOverview(): Promise<void> {
  const data = parsedData();
  const shape = effectiveShape();
  const fs = samplingRate();
  const isSwap = swapped();
  if (!data || !shape || !fs) {
    runToken++;
    setOverview(null);
    setOverviewStatus('idle');
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

  const pool = createOverviewWorkerPool();
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
  let perData = cache.get(data);
  if (!perData) cache.set(data, (perData = new Map()));
  perData.set(key, result);
  setOverview(result);
  setOverviewStatus('ready');
}

/** Measured SNR of every cell (indexed by cell id), or null before the overview is ready. */
export function snrByCell(): number[] | null {
  return overview()?.cells.map((c) => c.snr) ?? null;
}

export interface CellSnrInfo {
  snr: number;
  /** Mid-rank of the cell's SNR within the dataset, in [0, 1]. */
  rank: number;
  silent: boolean;
  nCells: number;
}

/** SNR, dataset-relative rank and silent flag of one cell; undefined until the overview is ready. */
export function cellSnrInfo(cellIndex: number): CellSnrInfo | undefined {
  const ov = overview();
  const cell = ov?.cells[cellIndex];
  if (!ov || !cell) return undefined;
  return { snr: cell.snr, rank: ov.snrRank[cellIndex], silent: cell.isSilent, nCells: ov.nCells };
}

export { overview, overviewStatus, overviewProgress, overviewError };
