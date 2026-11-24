/**
 * Slow worker: streaming cell discovery (`SlowLoop`), in its own thread so
 * its stalls never hold up the fast loop. Frames arrive from the frame worker
 * over the port the main thread connects; published libraries go back over
 * that port, and status plus drawable footprints go to the main thread.
 * With visit workers (one port each), tile visits run there (see
 * `SlowRunner`). Cells a history review found arrive from the main thread.
 */
import { initCalaWasm, SlowLoop } from '../lib/cala-wasm.ts';
import { buildSlowLoop, SlowRunner, type SlowLoopLike } from '../lib/slow-runner.ts';
import type { LookbackToSlow } from './lookback-types.ts';
import type { FastToSlow, MainToSlow, SlowToMain, VisitToOwner } from './slow-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: SlowToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToSlow>) => void) | null;
};

let port: MessagePort | null = null;
let visits: MessagePort[] = [];
/** The ports to the look-back workers, by index (runs with look-back only; see `SlowRunner`). */
const lookbackPorts: (MessagePort | null)[] = [];
let runner: SlowRunner | null = null;
/** The last pacer target from the main thread (a runner made later starts from it). */
let pace: { fps: number; paused: boolean } | null = null;
/** The settle's cap and the settle pool, as last sent (a runner made later starts with them). */
let cap: number | null = null;
let pool: { session: number; workers: number } | null = null;
// Port messages (frames and visit results alike) are handled one at a time,
// in arrival order, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();

/** Give way to the messages waiting (a macrotask, without setTimeout's clamping). */
const yieldChannel = new MessageChannel();
const yieldWaiters: (() => void)[] = [];
yieldChannel.port1.onmessage = () => yieldWaiters.shift()?.();
function pause(): Promise<void> {
  return new Promise((resolve) => {
    yieldWaiters.push(resolve);
    yieldChannel.port2.postMessage(0);
  });
}

function report(session: number, err: unknown): void {
  workerScope.postMessage({
    type: 'error',
    session,
    message: err instanceof Error ? err.message : String(err),
  });
}

workerScope.onmessage = (e) => {
  const data = e.data;
  if (data.type === 'reviewed') {
    const r = runner;
    queue = queue
      .then(() => r?.handleReviewed(data))
      .catch((err: unknown) => report(data.session, err));
    return;
  }
  if (data.type === 'lookback-port') {
    const i = data.index ?? 0;
    lookbackPorts[i]?.close();
    lookbackPorts[i] = data.port;
    connectLookback(i);
    return;
  }
  // Not queued: a setting the next request reads.
  if (data.type === 'settle-pace') {
    runner?.setPace(data.fps, data.paused);
    pace = { fps: data.fps, paused: data.paused };
    return;
  }
  if (data.type === 'settle-cap') {
    runner?.setCap(data.cap);
    cap = data.cap;
    return;
  }
  if (data.type === 'settle-pool') {
    runner?.setSettlePool(data.session, data.workers);
    pool = { session: data.session, workers: data.workers };
    return;
  }
  // Not queued: settling runs between the queued messages (see `SlowRunner.drainPump`).
  if (data.type === 'stop-settling') {
    runner?.stopSettling(data.session);
    return;
  }
  if (data.type !== 'connect') return;
  port?.close();
  for (const v of visits) v.close();
  port = data.port;
  visits = data.visits ?? [];
  const toFast = port;
  runner = new SlowRunner({
    // `new SlowLoop(..)` unless the run has look-back (`buildSlowLoop`).
    create: (init) => buildSlowLoop(SlowLoop, init) as unknown as SlowLoopLike,
    toFast,
    toMain: { postMessage: (m, t) => workerScope.postMessage(m, t) },
    visits,
    // Giving way inside an answer of the settle during Discover: a macrotask, unclamped.
    defer: (fn) => void pause().then(fn),
  });
  const r = runner;
  if (data.debugTiming) r.setDebugTiming(true);
  if (pace) r.setPace(pace.fps, pace.paused);
  if (cap !== null) r.setCap(cap);
  if (pool) r.setSettlePool(pool.session, pool.workers);
  lookbackPorts.forEach((_, i) => connectLookback(i));
  toFast.onmessage = (ev: MessageEvent<FastToSlow>) => {
    queue = queue
      .then(() => initCalaWasm())
      .then(() => r.handleAsync(ev.data, pause))
      .catch((err: unknown) => report('session' in ev.data ? ev.data.session : -1, err));
  };
  // Visit results do not queue behind batches of frames: a batch gives way
  // between frames while visits are out (`SlowRunner.handleAsync`). A visit
  // is only handed out once the module is ready, so its result needs no wait.
  visits.forEach((v, i) => {
    v.onmessage = (ev: MessageEvent<VisitToOwner>) => {
      try {
        r.handlerSpan('visit', () => r.handleVisit(i, ev.data));
      } catch (err) {
        report(ev.data.session, err);
      }
    };
  });
};

/**
 * Look-back answers go straight to the runner, like visit results (a
 * request is only sent once the module is ready, so no wait is needed).
 */
function connectLookback(i: number): void {
  const r = runner;
  const p = lookbackPorts[i];
  if (!r || !p) return;
  r.connectLookback(p, i);
  p.onmessage = (ev: MessageEvent<LookbackToSlow>) => {
    try {
      r.handlerSpan(`lookback${i}`, () => r.handleLookback(ev.data, i));
    } catch (err) {
      report(ev.data.session, err);
    }
  };
}
