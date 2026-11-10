/**
 * Compress worker: windowed low-rank compression of the preprocessed frames
 * (`CompressRunner`), in its own thread. Quantized batches arrive from the
 * fast worker over the port the main thread connects; windows and factors
 * are files in the origin private file system; status goes to the main
 * thread.
 */
import {
  FactorWindow,
  initCalaWasm,
  TileCompressor,
  TraceEngine,
  TraceLibrary,
} from '../lib/cala-wasm.ts';
import { CompressRunner } from '../lib/compress-runner.ts';
import { opfsStore } from '../lib/window-store.ts';
import type { CompressToMain, FastToCompress, MainToCompress } from './compress-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: CompressToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToCompress>) => void) | null;
};

let port: MessagePort | null = null;
let runner: CompressRunner | null = null;
// Messages are handled one at a time, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();
const store = opfsStore();

workerScope.onmessage = (e) => {
  const data = e.data;
  if (data.type === 'backfill') {
    const r = runner;
    queue = queue
      .then(() => initCalaWasm())
      .then(() => r?.backfill(data.session, data.version))
      .catch((err: unknown) => {
        workerScope.postMessage({
          type: 'error',
          session: data.session,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return;
  }
  port?.close();
  port = data.port;
  const r = new CompressRunner({
    store,
    create: (quant) => new TileCompressor(quant),
    engine: (bytes) => {
      const lib = TraceLibrary.fromBytes(bytes);
      try {
        // 0, 0: the solver's default tolerance and sweep cap. The engine
        // holds its own reference to the library.
        const engine = new TraceEngine(lib, 0, 0);
        const ids = lib.ids();
        return {
          ids: () => ids,
          processFrames: (frames, count) => engine.processFrames(frames, count),
          free: () => engine.free(),
        };
      } finally {
        lib.free();
      }
    },
    factors: (bytes) => FactorWindow.fromBytes(bytes),
    toMain: { postMessage: (m, t) => workerScope.postMessage(m, t) },
  });
  runner = r;
  port.onmessage = (ev: MessageEvent<FastToCompress>) => {
    queue = queue
      .then(() => initCalaWasm())
      .then(() => r.handle(ev.data))
      .catch((err: unknown) => {
        workerScope.postMessage({
          type: 'error',
          session: ev.data.session,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };
};
