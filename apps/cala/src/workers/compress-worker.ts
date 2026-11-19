/**
 * Compress worker: windowed low-rank compression of the preprocessed frames
 * (`CompressRunner`), in its own thread. Batches of frames arrive from the
 * fast worker over the port the main thread connects; windows and factors
 * are files in the origin private file system; status goes to the main
 * thread. With the history review on, each window's factors also go to the
 * review worker over a second port.
 */
import {
  FactorExtractor,
  initCalaWasm,
  factorHeader,
  quantizeTiles,
  tileLayout,
  TileCompressor,
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
  if (data.type === 'backfill' || data.type === 'extract') {
    const r = runner;
    queue = queue
      .then(() => initCalaWasm())
      .then(() => {
        if (data.type === 'backfill') r?.backfill(data.session, data.version);
        else if (r) r.extract(data.session, data.job, data.library);
        else
          workerScope.postMessage({
            type: 'error',
            session: data.session,
            job: data.job,
            message: 'Extract on factors: the compress worker is not connected.',
          });
      })
      .catch((err: unknown) => {
        workerScope.postMessage({
          type: 'error',
          session: data.session,
          ...(data.type === 'extract' ? { job: data.job } : {}),
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
    extract: (bytes) => new FactorExtractor(bytes, 0, 0),
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
