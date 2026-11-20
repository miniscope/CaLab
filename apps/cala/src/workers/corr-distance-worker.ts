/**
 * Correlation-vs-distance worker: one request, one answer (`lib/corr-distance.ts`).
 * Runs once on demand, away from the main thread and the pipeline.
 */
import { computeCorrDistance, type CorrDistanceResult } from '../lib/corr-distance.ts';

export interface CorrRequest {
  id: number;
  traces: Float32Array;
  cells: number;
  frames: number;
  fps: number;
  centers: Float32Array;
  diameter: number;
}

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
    workerScope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
