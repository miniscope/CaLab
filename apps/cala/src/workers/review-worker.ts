/**
 * Review worker: the history review (`ReviewRunner`), in its own thread. A
 * review takes seconds to minutes; here it delays nothing else. Factors and
 * review requests arrive from the compress worker over the port the main
 * thread connects; candidates and status go to the main thread.
 */
import { calaWasmHeapBytes, HistoryReview, initCalaWasm } from '../lib/cala-wasm.ts';
import { ReviewRunner } from '../lib/review-runner.ts';
import type { CompressToReview, ReviewConnect, ReviewToMain } from './review-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: ReviewToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ReviewConnect>) => void) | null;
};

let port: MessagePort | null = null;
// Messages are handled in arrival order, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();

workerScope.onmessage = (e) => {
  if (e.data.type !== 'connect') return;
  port?.close();
  port = e.data.port;
  const runner = new ReviewRunner({
    create: (width, height) => new HistoryReview(width, height),
    toMain: { postMessage: (m, t) => workerScope.postMessage(m, t) },
    heapBytes: calaWasmHeapBytes,
  });
  port.onmessage = (ev: MessageEvent<CompressToReview>) => {
    queue = queue
      .then(() => initCalaWasm())
      .then(() => runner.handle(ev.data))
      .catch((err: unknown) => {
        workerScope.postMessage({
          type: 'error',
          session: ev.data.session,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };
};
