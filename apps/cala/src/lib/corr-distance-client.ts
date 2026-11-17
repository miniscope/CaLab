/**
 * Runs the correlation-vs-distance computation in a short-lived worker for the
 * cells of a store: reads each cell's whole trace from the trace history (a
 * one-off copy, cells x frames x 4 bytes), the footprints from the library.
 */
import type { CorrRequest, CorrResponse } from '../workers/corr-distance-worker.ts';
import { somaDiameter, type CorrDistanceResult } from './corr-distance.ts';
import type { CellStore } from './cell-store.ts';

export class CorrDistanceError extends Error {}

/** Gather the request from `cells`; null when there is no library or no trace. */
export function corrRequest(cells: CellStore, fps: number): CorrRequest | null {
  const lib = cells.library();
  const history = cells.history();
  if (!lib || lib.ids.length < 2) return null;
  const n = lib.ids.length;
  let first = Infinity;
  let end = 0;
  for (let i = 0; i < n; i++) {
    const s = history.span(lib.ids[i]);
    if (!s) continue;
    first = Math.min(first, s.first);
    end = Math.max(end, s.end);
  }
  if (!(end > first)) return null;
  const frames = end - first;
  const traces = new Float32Array(n * frames);
  for (let i = 0; i < n; i++) {
    const row = history.range(lib.ids[i], first, end);
    for (let t = 0; t < frames; t++) traces[i * frames + t] = row[t];
  }
  return {
    id: 0,
    traces,
    cells: n,
    frames,
    fps,
    centers: new Float32Array(lib.centers),
    diameter: somaDiameter(lib),
  };
}

export function runCorrDistance(req: CorrRequest): Promise<CorrDistanceResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/corr-distance-worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<CorrResponse>) => {
      worker.terminate();
      if ('error' in e.data) reject(new CorrDistanceError(e.data.error));
      else resolve(e.data.result);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new CorrDistanceError(e.message || 'The correlation worker crashed.'));
    };
    worker.postMessage(req, [req.traces.buffer]);
  });
}
