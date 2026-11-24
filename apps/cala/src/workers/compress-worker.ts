/**
 * Compress worker: windowed low-rank compression of the preprocessed frames
 * (`CompressRunner`), in its own thread. Batches of frames arrive from the
 * fast worker over the port the main thread connects; windows and factors
 * are files in the origin private file system; status goes to the main
 * thread. With the history review on, each window's factors also go to the
 * review worker over a second port.
 */
import {
  FactorWindow,
  initCalaWasm,
  factorHeader,
  quantizeTiles,
  tileLayout,
  TileCompressor,
  TraceEngine,
  TraceLibrary,
} from '../lib/cala-wasm.ts';
import { CompressRunner } from '../lib/compress-runner.ts';
import { opfsStore } from '../lib/window-store.ts';
import type { CompressToMain, FastToCompress, MainToCompress } from './compress-types.ts';
import type { CompressToReview } from './review-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: CompressToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToCompress>) => void) | null;
};

let port: MessagePort | null = null;
let reviewPort: MessagePort | null = null;
let runner: CompressRunner | null = null;
// Messages are handled one at a time, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();
const store = opfsStore();

workerScope.onmessage = (e) => {
  const data = e.data;
  if (data.type === 'backfill' || data.type === 'extract' || data.type === 'extract-cancel') {
    const r = runner;
    queue = queue
      .then(() => initCalaWasm())
      .then(() => {
        if (data.type === 'backfill') r?.backfill(data.session, data.version);
        else if (data.type === 'extract')
          r?.extract(data.session, data.job, data.version, data.library);
        else r?.extractCancel(data.session, data.job);
      })
      .catch((err: unknown) => {
        workerScope.postMessage({
          type: 'error',
          session: data.session,
          ...(data.type === 'backfill' ? {} : { job: data.job }),
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return;
  }
  port?.close();
  reviewPort?.close();
  port = data.port;
  reviewPort = data.review?.port ?? null;
  const toReview = reviewPort;
  const r = new CompressRunner({
    store,
    quantize: quantizeTiles,
    layout: tileLayout,
    header: factorHeader,
    create: (quant) => new TileCompressor(quant),
    engine: (bytes, signed) => {
      const lib = TraceLibrary.fromBytes(bytes);
      try {
        // 0, 0: the solver's default tolerance and sweep cap. The engine
        // holds its own reference to the library.
        const engine = new TraceEngine(lib, 0, 0);
        if (signed) engine.setSigned(true);
        const ids = lib.ids();
        return {
          ids: () => ids,
          processFrames: (frames, count) => engine.processFrames(frames, count),
          ...(signed ? { lastSigned: () => engine.lastSigned() } : {}),
          free: () => engine.free(),
        };
      } finally {
        lib.free();
      }
    },
    factors: (bytes) => FactorWindow.fromBytes(bytes),
    toMain: { postMessage: (m, t) => workerScope.postMessage(m, t) },
    ...(toReview && data.review
      ? {
          review: {
            port: { postMessage: (m: CompressToReview, t) => toReview.postMessage(m, t ?? []) },
            every: data.review.every,
          },
        }
      : {}),
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
