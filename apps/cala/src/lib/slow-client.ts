/**
 * Main-thread side of the slow worker (cell discovery): starts it and its
 * visit workers, wires a `MessageChannel` between it and the frame worker
 * (so frames go worker to worker) and one to each visit worker, and passes
 * its status and libraries to a listener.
 *
 * `release` ends the slow worker and its visit workers (only ending a worker
 * returns its WASM memory); the next call that needs them starts them again
 * and wires them anew. The look-back workers' ports go with the slow worker,
 * so their client is released with it (`LookbackFeed.release`).
 */
import type { FrameClient } from './frame-client.ts';
import type { FactorSource } from '../workers/lookback-types.ts';
import type {
  SlowConnect,
  SlowLookbackPort,
  SlowReviewed,
  SlowSettleCap,
  SlowSettlePace,
  SlowSettlePool,
  SlowFactors,
  SlowStopSettling,
  SlowToMain,
  VisitConnect,
} from '../workers/slow-types.ts';
import { errMsg } from './errors.ts';

export interface SlowClient {
  /** Visit workers running the slow loop's tile visits. */
  readonly visitWorkers: number;
  /** Pass what a history review found to the slow loop (the array is transferred). */
  addReviewed(session: number, candidates: Float32Array): void;
  /** The port to look-back worker `index` (default 0; transferred; see `lookback-client.ts`). */
  connectLookback(port: MessagePort, index?: number): void;
  /** The pacer's target live fps (0: Max) and pause, for the settle governor. */
  settlePace(fps: number, paused: boolean): void;
  /** The settle's cap, re-read frames per live frame (0 = Off); during a run too. */
  settleCap(cap: number): void;
  /** Look-back workers 1..`workers` were started for `session`'s run (the settle pool). */
  settlePool(session: number, workers: number): void;
  /** Stop a look-back run's settling now: its final library is published with what was refined. */
  stopSettling(session: number): void;
  /** A `?factors` stream's factors are ready (`frames` covered), or not usable (`reason`). */
  factorsReady(session: number, frames: number, source?: FactorSource['factors']): void;
  factorsFailed(session: number, reason: string): void;
  /**
   * End the slow worker and its visit workers. Run messages sent while they are ended
   * (`addReviewed`, `settlePool`, `stopSettling`, `factors*`) are dropped: they belong to a run
   * that is over. The pacer's target and the settle's cap are kept and sent to the next workers.
   */
  release(): void;
  /**
   * The workers are running and the frame worker holds their port: starts them if `release`
   * ended them. Resolves once the frame worker has the port, so a pipeline started after it
   * forwards its frames to them.
   */
  ready(): Promise<void>;
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
  /** The running workers (null: ended by `release`), and the frame worker's connection to them. */
  let live: {
    worker: SlowWorkerLike;
    helpers: SlowWorkerLike[];
    channel: MessageChannel;
    connected: Promise<void>;
  } | null = null;
  /** The last pacer target and settle cap sent: a slow worker started later gets them first. */
  let pace: SlowSettlePace | null = null;
  let cap: SlowSettleCap | null = null;

  function start(): NonNullable<typeof live> {
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
    // Measurement only: `?debug` turns the slow worker's finer timers on (`WorkStatus.detail`).
    const debugTiming =
      typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
    const connect: SlowConnect = {
      type: 'connect',
      port: channel.port2,
      visits: ports,
      ...(debugTiming ? { debugTiming } : {}),
    };
    worker.postMessage(connect, [channel.port2, ...ports]);
    if (pace) worker.postMessage(pace);
    if (cap) worker.postMessage(cap);
    const connected = (frames.connectSlow?.(channel.port1) ?? Promise.resolve()).catch(
      (err: unknown) =>
        onMessage({
          type: 'error',
          session: -1,
          message: errMsg(err),
        }),
    );
    return { worker, helpers, channel, connected };
  }
  function release(): void {
    if (!live) return;
    live.worker.terminate();
    for (const v of live.helpers) v.terminate();
    live.channel.port1.close();
    live = null;
  }
  /** The running slow worker, started if `release` ended it. */
  const running = () => (live ??= start());
  live = start();

  return {
    visitWorkers,
    addReviewed(session, candidates) {
      const msg: SlowReviewed = { type: 'reviewed', session, candidates };
      live?.worker.postMessage(msg, [candidates.buffer as ArrayBuffer]);
    },
    connectLookback(port, index = 0) {
      const msg: SlowLookbackPort = { type: 'lookback-port', port, ...(index ? { index } : {}) };
      running().worker.postMessage(msg, [port]);
    },
    settlePace(fps, paused) {
      pace = { type: 'settle-pace', fps, paused };
      live?.worker.postMessage(pace);
    },
    settleCap(c) {
      cap = { type: 'settle-cap', cap: c };
      live?.worker.postMessage(cap);
    },
    settlePool(session, workers) {
      const msg: SlowSettlePool = { type: 'settle-pool', session, workers };
      live?.worker.postMessage(msg);
    },
    stopSettling(session) {
      const msg: SlowStopSettling = { type: 'stop-settling', session };
      live?.worker.postMessage(msg);
    },
    factorsReady(session, frames, source) {
      const msg: SlowFactors = {
        type: 'factors',
        session,
        ready: true,
        frames,
        ...(source ? { source } : {}),
      };
      live?.worker.postMessage(msg);
    },
    factorsFailed(session, reason) {
      const msg: SlowFactors = { type: 'factors', session, ready: false, reason };
      live?.worker.postMessage(msg);
    },
    release,
    ready() {
      return running().connected;
    },
    dispose: release,
  };
}
