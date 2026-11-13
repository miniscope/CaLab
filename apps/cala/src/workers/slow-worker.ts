/**
 * Slow worker: streaming cell discovery (`SlowLoop`), in its own thread so
 * its stalls never hold up the fast loop. Frames arrive from the frame worker
 * over the port the main thread connects; published libraries go back over
 * that port, and status plus drawable footprints go to the main thread.
 * With visit workers (one port each), tile visits run there (see
 * `SlowRunner`). Cells a history review found arrive from the main thread.
 */
import { initCalaWasm, SlowLoop } from '../lib/cala-wasm.ts';
import { SlowRunner, type SlowLoopLike } from '../lib/slow-runner.ts';
import type { FastToSlow, MainToSlow, SlowToMain, VisitToOwner } from './slow-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: SlowToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToSlow>) => void) | null;
};

let port: MessagePort | null = null;
let visits: MessagePort[] = [];
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
  if (data.type !== 'connect') return;
  port?.close();
  for (const v of visits) v.close();
  port = data.port;
  visits = data.visits ?? [];
  const toFast = port;
  runner = new SlowRunner({
    create: (init) =>
      new SlowLoop(
        init.width,
        init.height,
        init.fov,
        init.noise,
        init.cellDiameterPx,
        init.flattenSigmaPx,
      ) as unknown as SlowLoopLike,
    toFast,
    toMain: { postMessage: (m, t) => workerScope.postMessage(m, t) },
    visits,
  });
  const r = runner;
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
