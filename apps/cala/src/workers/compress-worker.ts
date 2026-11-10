/**
 * Compress worker: windowed low-rank compression of the preprocessed frames
 * (`CompressRunner`), in its own thread. Quantized batches arrive from the
 * fast worker over the port the main thread connects; windows and factors
 * are files in the origin private file system; status goes to the main
 * thread.
 */
import { initCalaWasm, TileCompressor } from '../lib/cala-wasm.ts';
import { CompressRunner } from '../lib/compress-runner.ts';
import { opfsStore } from '../lib/window-store.ts';
import type { CompressConnect, CompressToMain, FastToCompress } from './compress-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: CompressToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<CompressConnect>) => void) | null;
};

let port: MessagePort | null = null;
// Port messages are handled one at a time, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();
const store = opfsStore();

workerScope.onmessage = (e) => {
  if (e.data.type !== 'connect') return;
  port?.close();
  port = e.data.port;
  const runner = new CompressRunner({
    store,
    create: (quant) => new TileCompressor(quant),
    toMain: { postMessage: (m, t) => workerScope.postMessage(m, t) },
  });
  port.onmessage = (ev: MessageEvent<FastToCompress>) => {
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
