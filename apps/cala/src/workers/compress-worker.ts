/**
 * Compress worker: windowed low-rank compression of the preprocessed frames
 * (`CompressRunner`), in its own thread. Batches of frames arrive from the
 * fast worker over the port the main thread connects; windows and factors
 * are files in the origin private file system; status goes to the main
 * thread. With the history review on, each window's factors also go to the
 * review worker over a second port. With helpers (`compress-helper-worker.ts`),
 * each window's tiles are shared with them over one port each (`TilePool`).
 * A recording's GPU run (the default) compresses its windows on the GPU (`openGpuCompressor`).
 */
/// <reference types="@webgpu/types" />
import {
  FactorExtractor,
  FactorWindow,
  initCalaWasm,
  factorHeader,
  quantizeTiles,
  tileLayout,
  TileCompressor,
  TraceEngine,
  TraceLibrary,
} from '../lib/cala-wasm.ts';
import { TilePool, WindowPool } from '../lib/compress-pool.ts';
import { CompressRunner } from '../lib/compress-runner.ts';
import { openGpuCompressor } from '../lib/gpu-compress.ts';
import { opfsStore } from '../lib/window-store.ts';
import type {
  CompressToMain,
  CoordinatorToHelper,
  FastToCompress,
  HelperToCoordinator,
  MainToCompress,
} from './compress-types.ts';
import type { CompressToReview } from './review-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: CompressToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToCompress>) => void) | null;
};

let port: MessagePort | null = null;
let reviewPort: MessagePort | null = null;
let runner: CompressRunner | null = null;
let pool: TilePool | null = null;
let windowPool: WindowPool | null = null;
let helperPorts: MessagePort[] = [];
// Messages are handled one at a time, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();
const store = opfsStore();

workerScope.onmessage = (e) => {
  const data = e.data;
  if (data.type === 'helper-lost') {
    pool?.lost(data.helper);
    windowPool?.lost(data.helper);
    return;
  }
  if (data.type === 'stop') {
    const r = runner;
    queue = queue.then(() => r?.stop(data.session)).catch(() => {});
    return;
  }
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
  for (const p of helperPorts) p.close();
  port = data.port;
  const fastPort = data.port;
  reviewPort = data.review?.port ?? null;
  helperPorts = data.helpers ?? [];
  const tilePool = new TilePool({
    helpers: helperPorts.map((p) => ({
      postMessage: (m: CoordinatorToHelper, t?: Transferable[]) => p.postMessage(m, t ?? []),
    })),
  });
  const helperSide = helperPorts.map((p) => ({
    postMessage: (m: CoordinatorToHelper, t?: Transferable[]) => p.postMessage(m, t ?? []),
  }));
  const windows = new WindowPool({ helpers: helperSide });
  helperPorts.forEach((p, k) => {
    // A helper that cannot start is lost to both pools.
    p.onmessage = (ev: MessageEvent<HelperToCoordinator>) => {
      const m = ev.data;
      if (m.type === 'window-done' || m.type === 'window-error') windows.onHelper(k, m);
      else if (m.type === 'helper-error') {
        tilePool.onHelper(k, m);
        windows.onHelper(k, m);
      } else tilePool.onHelper(k, m);
    };
  });
  pool = tilePool;
  windowPool = windows;
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
    // The port is two-way: room in the GPU's ring goes back to the feed.
    toFast: { postMessage: (m) => fastPort.postMessage(m) },
    pool: tilePool,
    windows,
    extractor: (bytes, signed) => {
      const x = new FactorExtractor(bytes, 0, 0);
      if (signed) x.setSigned(true);
      return x;
    },
    estimate: () => navigator.storage.estimate(),
    openGpu: (init) =>
      openGpuCompressor({
        width: init.width,
        height: init.height,
        tile: init.tile,
        tiling: init.tiling,
        quant: init.quant,
        gpu: (navigator as Navigator & { gpu?: GPU }).gpu,
        layout: tileLayout,
      }),
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
