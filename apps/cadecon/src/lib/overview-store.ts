// Dataset overview store: the model-free, display-only quality pass that runs
// once per imported dataset, off the main thread, in a short-lived worker pool.
//
// Nothing here feeds the solver: the overview lives in its own store and its
// own type (`DatasetOverview`, branded `kind: 'dataset-overview'`), separate
// from the solver results in iteration-store.ts.

import { createSignal, createRoot, createEffect, on } from 'solid-js';
import { buildDatasetOverview, OVERVIEW_PARAMS, type CellOverview } from '@calab/core';
import type { DatasetOverview } from '@calab/core';
import { dataIndex } from '@calab/io';
import { createCaDeconWorkerPool } from './cadecon-pool.ts';
import { parsedData, effectiveShape, swapped, samplingRate, importStep } from './data-store.ts';

export type OverviewStatus = 'idle' | 'computing' | 'ready' | 'error';

const [overview, setOverview] = createSignal<DatasetOverview | null>(null);
const [overviewStatus, setOverviewStatus] = createSignal<OverviewStatus>('idle');
const [overviewProgress, setOverviewProgress] = createSignal(0);
const [overviewError, setOverviewError] = createSignal<string | null>(null);
/** Wall time of the last overview pass (ms), for the perf readout. */
const [overviewElapsedMs, setOverviewElapsedMs] = createSignal<number | null>(null);

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
    setOverview(null);
    setOverviewStatus('idle');
    return;
  }
  const key = `${isSwap}:${fs}`;
  const hit = cache.get(data)?.get(key);
  if (hit) {
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

  const pool = createCaDeconWorkerPool();
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
          kind: 'overview',
          jobId: j,
          tracesFlat: extractCells(data, isSwap, c0, c1, nT),
          nCells: c1 - c0,
          nTimepoints: nT,
          fs,
          minSeparationSamples: minSep,
          // No ΔF/F declaration exists at import yet, so ν is never computed.
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
  const elapsed = performance.now() - t0;
  setOverviewElapsedMs(elapsed);
  console.info(
    `[CaDecon] dataset overview: ${nCells} cells × ${nT} frames in ${elapsed.toFixed(0)} ms`,
  );
  let perData = cache.get(data);
  if (!perData) cache.set(data, (perData = new Map()));
  perData.set(key, result);
  setOverview(result);
  setOverviewStatus('ready');
}

/** Recompute whenever the dataset (or its orientation / rate) changes. Call once at app start. */
export function setupOverviewEffects(): void {
  createRoot(() => {
    createEffect(
      on([importStep, parsedData, effectiveShape, swapped, samplingRate], () => {
        // Only once the import is confirmed: earlier steps still change shape/rate.
        if (importStep() === 'ready') void computeOverview();
        else {
          runToken++;
          setOverview(null);
          setOverviewStatus('idle');
        }
      }),
    );
  });
}

export { overview, overviewStatus, overviewProgress, overviewError, overviewElapsedMs };
