/**
 * Slow worker: streaming cell discovery (`SlowLoop`), in its own thread so
 * its stalls never hold up the fast loop. Frames arrive from the frame worker
 * over the port the main thread connects; published libraries go back over
 * that port, and status plus drawable footprints go to the main thread.
 * With visit workers (one port each), tile visits run there (see
 * `SlowRunner`). Cells a history review found arrive from the main thread.
 */
import { initCalaWasm, SlowLoop } from '../lib/cala-wasm.ts';
import { factorName } from '../lib/compress-runner.ts';
import { buildSlowLoop, SlowRunner, type SlowLoopLike } from '../lib/slow-runner.ts';
import { openFactorReader } from '../lib/window-store.ts';
import type { LookbackToSlow } from './lookback-types.ts';
import type { FastToSlow, MainToSlow, SlowToMain, VisitToOwner } from './slow-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: SlowToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToSlow>) => void) | null;
};

let port: MessagePort | null = null;
let visits: MessagePort[] = [];
/** The port to the look-back worker (runs with look-back only; see `SlowRunner`). */
let lookbackPort: MessagePort | null = null;
let runner: SlowRunner | null = null;
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
    lookbackPort?.close();
    lookbackPort = data.port;
    connectLookback();
    return;
  }
  // Not queued: settling runs between the queued messages (see `SlowRunner.drainPump`).
  if (data.type === 'stop-settling') {
    runner?.stopSettling(data.session);
    return;
  }
  // Not queued: it gives way between iterations, so a reset from the fast worker gets in.
  if (data.type === 'refine-factors') {
    const r = runner;
    if (r) void r.refineOnFactors(data).catch((err: unknown) => report(data.session, err));
    else
      workerScope.postMessage({
        type: 'factor-end',
        session: data.session,
        iterations: 0,
        stop: 'error',
        message: 'The slow worker is not connected.',
      });
    return;
  }
  if (data.type === 'stop-factors') {
    runner?.stopFactors(data.session);
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
    // The run's factor files, opened without owning their folder.
    openFactors: (folder, windows) =>
      openFactorReader(
        folder,
        Array.from({ length: windows }, (_, i) => factorName(i)),
      ),
  });
  const r = runner;
  connectLookback();
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
        r.handleVisit(i, ev.data);
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
function connectLookback(): void {
  const r = runner;
  const p = lookbackPort;
  if (!r || !p) return;
  r.connectLookback(p);
  p.onmessage = (ev: MessageEvent<LookbackToSlow>) => {
    try {
      r.handleLookback(ev.data);
    } catch (err) {
      report(ev.data.session, err);
    }
  };
}
