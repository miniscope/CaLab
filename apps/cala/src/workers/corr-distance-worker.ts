/**
 * Correlation-vs-distance worker: one request, one answer (`lib/corr-distance.ts`).
 * Runs once on demand, away from the main thread and the pipeline.
 */
import { computeCorrDistance, type CorrDistanceResult } from '../lib/corr-distance.ts';
import { errMsg } from '../lib/errors.ts';

/** Request: the traces and cell centers to correlate (`computeCorrDistance`). */
export interface CorrRequest {
  id: number;
  traces: Float32Array;
  cells: number;
  frames: number;
  fps: number;
  centers: Float32Array;
  diameter: number;
}

/** Answer to the request with the same `id`: the result, or an error message. */
export type CorrResponse =
  { id: number; result: CorrDistanceResult } | { id: number; error: string };

const workerScope = globalThis as unknown as {
  postMessage(msg: CorrResponse): void;
  onmessage: ((e: MessageEvent<CorrRequest>) => void) | null;
};

workerScope.onmessage = (e) => {
  const { id } = e.data;
  try {
    const t0 = performance.now();
    const result = computeCorrDistance(e.data);
    result.ms = performance.now() - t0;
    result.bytes = e.data.traces.byteLength;
    workerScope.postMessage({ id, result });
  } catch (err) {
    workerScope.postMessage({ id, error: errMsg(err) });
  }
};
