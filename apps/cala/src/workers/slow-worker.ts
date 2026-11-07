/**
 * Slow worker: streaming cell discovery (`SlowLoop`), in its own thread so
 * its stalls never hold up the fast loop. Frames arrive from the frame worker
 * over the port the main thread connects; published libraries go back over
 * that port, and status plus drawable footprints go to the main thread.
 */
import { initCalaWasm, SlowLoop } from '../lib/cala-wasm.ts';
import { SlowRunner, type SlowLoopLike } from '../lib/slow-runner.ts';
import type { FastToSlow, SlowConnect, SlowToMain } from './slow-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: SlowToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<SlowConnect>) => void) | null;
};

let port: MessagePort | null = null;
let runner: SlowRunner | null = null;
// Port messages are handled one at a time, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();

workerScope.onmessage = (e) => {
  if (e.data.type !== 'connect') return;
  port?.close();
  port = e.data.port;
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
  });
  const r = runner;
  toFast.onmessage = (ev: MessageEvent<FastToSlow>) => {
    queue = queue
      .then(() => initCalaWasm())
      .then(() => r.handle(ev.data))
      .catch((err: unknown) => {
        workerScope.postMessage({
          type: 'error',
          session: 'session' in ev.data ? ev.data.session : -1,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };
};
