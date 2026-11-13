/**
 * Main-thread side of the slow worker (cell discovery): starts it and its
 * visit workers, wires a `MessageChannel` between it and the frame worker
 * (so frames go worker to worker) and one to each visit worker, and passes
 * its status and libraries to a listener.
 */
import type { FrameClient } from './frame-client.ts';
import type { SlowConnect, SlowReviewed, SlowToMain, VisitConnect } from '../workers/slow-types.ts';

export interface SlowClient {
  /** Visit workers running the slow loop's tile visits. */
  readonly visitWorkers: number;
  /** Pass what a history review found to the slow loop (the array is transferred). */
  addReviewed(session: number, candidates: Float32Array): void;
  dispose(): void;
}

export type SlowWorkerLike = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;

/** Threads the app keeps busy besides the visit workers: the main thread, the three pipeline stage workers and the slow worker. */
export const RESERVED_THREADS = 5;
/**
 * Forward buffers (batches in flight to the slow worker) with visit workers.
 * The slow worker then only observes and keeps up on average; two buffers
 * still dropped a third of the batches on real data, because a buffer comes
 * back only once the trace worker reads the ack between its own batches and
 * library rebuilds stall the slow worker for a batch or two. Four drop about
 * a tenth. Each is `batchSize` frames on each side (8 x 1.4 MB at 600 x 600).
 */
export const PARALLEL_FORWARD_BUFFERS = 4;
/**
 * Visit workers at most (each holds a copy of one tile's reservoir while it
 * works). Past four the slow worker itself (observing every frame, handing
 * out and applying visits) is the bottleneck: on the GT sims (timed harness,
 * 250 fps) six workers sat 53-55 % busy against 66-67 % for four, and
 * recall at 8 min was no better (0.734-0.746 vs 0.754-0.760).
 */
export const MAX_VISIT_WORKERS = 4;

/**
 * Visit workers for `cores` logical cores (`navigator.hardwareConcurrency`):
 * what is left after the reserved threads, at most `MAX_VISIT_WORKERS`.
 * Fewer than one: the slow worker visits tiles itself.
 */
export function visitWorkerCount(cores: number | undefined): number {
  const n = Math.floor((cores ?? 0) - RESERVED_THREADS);
  return Math.max(0, Math.min(MAX_VISIT_WORKERS, Number.isFinite(n) ? n : 0));
}

export function createSlowClient(
  frames: Pick<FrameClient, 'connectSlow'>,
  onMessage: (msg: SlowToMain) => void,
  makeWorker: () => SlowWorkerLike = () =>
    new Worker(new URL('../workers/slow-worker.ts', import.meta.url), { type: 'module' }),
  visitWorkers = 0,
  makeVisitWorker: () => SlowWorkerLike = () =>
    new Worker(new URL('../workers/visit-worker.ts', import.meta.url), { type: 'module' }),
): SlowClient {
  const worker = makeWorker();
  const channel = new MessageChannel();
  worker.onmessage = (e: MessageEvent<SlowToMain>) => onMessage(e.data);
  worker.onerror = (e) =>
    onMessage({ type: 'error', session: -1, message: e.message || 'The slow worker crashed.' });
  const helpers: SlowWorkerLike[] = [];
  const ports: MessagePort[] = [];
  for (let i = 0; i < visitWorkers; i++) {
    const v = makeVisitWorker();
    const ch = new MessageChannel();
    v.onerror = (e) =>
      onMessage({ type: 'error', session: -1, message: e.message || 'A visit worker crashed.' });
    const c: VisitConnect = { type: 'connect', port: ch.port2 };
    v.postMessage(c, [ch.port2]);
    helpers.push(v);
    ports.push(ch.port1);
  }
  const connect: SlowConnect = { type: 'connect', port: channel.port2, visits: ports };
  worker.postMessage(connect, [channel.port2, ...ports]);
  void frames.connectSlow?.(channel.port1).catch((err: unknown) =>
    onMessage({
      type: 'error',
      session: -1,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  return {
    visitWorkers,
    addReviewed(session, candidates) {
      const msg: SlowReviewed = { type: 'reviewed', session, candidates };
      worker.postMessage(msg, [candidates.buffer as ArrayBuffer]);
    },
    dispose() {
      worker.terminate();
      for (const v of helpers) v.terminate();
      channel.port1.close();
    },
  };
}
