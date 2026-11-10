/**
 * Slow worker: streaming cell discovery (`SlowLoop`), in its own thread so
 * its stalls never hold up the fast loop. Frames arrive from the frame worker
 * over the port the main thread connects; published libraries go back over
 * that port, and status plus drawable footprints go to the main thread.
 * With visit workers (one port each), tile visits run there (see
 * `SlowRunner`).
 */
import { initCalaWasm, SlowLoop } from '../lib/cala-wasm.ts';
import { SlowRunner, type SlowLoopLike } from '../lib/slow-runner.ts';
import type { FastToSlow, SlowConnect, SlowToMain, VisitToOwner } from './slow-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: SlowToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<SlowConnect>) => void) | null;
};

let port: MessagePort | null = null;
let visits: MessagePort[] = [];
let runner: SlowRunner | null = null;
// Port messages (frames and visit results alike) are handled one at a time,
// in arrival order, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();

function report(session: number, err: unknown): void {
  workerScope.postMessage({
    type: 'error',
    session,
    message: err instanceof Error ? err.message : String(err),
  });
}

workerScope.onmessage = (e) => {
  if (e.data.type !== 'connect') return;
  port?.close();
  for (const v of visits) v.close();
  port = e.data.port;
  visits = e.data.visits ?? [];
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
      .then(() => r.handle(ev.data))
      .catch((err: unknown) => report('session' in ev.data ? ev.data.session : -1, err));
  };
  visits.forEach((v, i) => {
    v.onmessage = (ev: MessageEvent<VisitToOwner>) => {
      queue = queue
        .then(() => r.handleVisit(i, ev.data))
        .catch((err: unknown) => report(ev.data.session, err));
    };
  });
};
