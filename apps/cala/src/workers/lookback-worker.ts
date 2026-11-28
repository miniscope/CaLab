/**
 * Look-back worker (created only for Discover runs with
 * look-back on): re-reads the past frames the slow loop's scheduler asks
 * for from the recording, with a `FrameSource` of its own opened from the
 * same `File`s (Discover's sequential reader is never touched), and
 * preprocesses and solves them (`LookbackReader`), or rebuilds them from a
 * run's factors (`FactorReader`). Requests and libraries come from the slow
 * worker over the port the main thread connects; what Discover recorded
 * (motion, flicker, the back half's state, the flat field) comes from the
 * main thread. The message handling is `LookbackService`.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { FrameSource } from '../lib/frame-source.ts';
import { FactorReader } from '../lib/factor-reader.ts';
import { FactorWindow, TraceEngine, TraceLibrary } from '../lib/cala-wasm.ts';
import { LookbackReader } from '../lib/lookback-reader.ts';
import { LookbackService } from '../lib/lookback-service.ts';
import { paramsHandle } from '../lib/params-handle.ts';
import { LOOKBACK } from '../lib/slow-runner.ts';
import { StagePool } from '../lib/stage-pool.ts';
import { factorFiles } from '../lib/window-store.ts';
import type {
  FactorSource,
  LookbackToMain,
  LookbackToSlow,
  MainToLookback,
  SlowToLookback,
} from './lookback-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: LookbackToMain): void;
  onmessage: ((e: MessageEvent<MainToLookback>) => void) | null;
};

/**
 * Frame buffers per worker: the answer the slow worker holds, the request
 * being served, and (worker 0, the end settle) the next one prepared ahead.
 * A repeatable run holds up to `APPLY_LAG_BATCHES - 1` answers while the next
 * is served (each is given back before the next request goes out), so two do.
 */
const BUFFERS = { pool: 2, worker0: 3 };

let slow: MessagePort | null = null;
/** The run's resolved params (`MainToLookback` `params`); the factor servers' solvers use them. */
let runParams: string | null = null;

/** A frame server on a run's factors (it reads only the windows the compress status listed). */
function factorServer(f: FactorSource['factors']): FactorReader {
  return new FactorReader(factorFiles(f.folder), f.windows, f.width * f.height, {
    open: (bytes) => FactorWindow.fromBytes(bytes),
    solver: (bytes) => {
      const lib = TraceLibrary.fromBytes(bytes);
      try {
        if (runParams === null) throw new Error('look-back: the run\'s params have not arrived.');
        const engine = new TraceEngine(lib, paramsHandle(runParams));
        return {
          cells: lib.ids().length,
          processFrames: (y, n) => engine.processFrames(y, n),
          lastBackground: () => engine.lastBackground(),
          free: () => engine.free(),
        };
      } finally {
        lib.free();
      }
    },
  });
}

const service = new LookbackService({
  async open(msg) {
    await initCalaWasm();
    // Pool workers prune their sessions; worker 0 keeps a third buffer for the end settle.
    const buffers = msg.prune ? BUFFERS.pool : BUFFERS.worker0;
    if ('factors' in msg.source) {
      const f = msg.source.factors;
      return {
        server: factorServer(f),
        reader: null,
        pool: new StagePool(buffers, LOOKBACK.takeMax * f.width * f.height),
      };
    }
    const src =
      'entries' in msg.source
        ? await FrameSource.open(msg.source.entries)
        : await FrameSource.openSessions(msg.source.sessions);
    const reader = new LookbackReader(src, msg.prune ? { keepSessions: 2 } : {});
    const pool = new StagePool(buffers, LOOKBACK.takeMax * src.info.width * src.info.height);
    return { server: reader, reader, pool, dispose: () => src.dispose() };
  },
  factorServer,
  params(p) {
    runParams = p;
  },
  postSlow(msg: LookbackToSlow, transfer: Transferable[]) {
    // When the answer left (epoch ms): the slow worker's `?debug` relay timing reads it.
    if (msg.type === 'frames') msg.postedAt = performance.timeOrigin + performance.now();
    slow?.postMessage(msg, transfer);
  },
  postMain: (msg) => workerScope.postMessage(msg),
});

workerScope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'connect') {
    slow?.close();
    slow = msg.port;
    slow.onmessage = (ev: MessageEvent<SlowToLookback>) => service.handleSlow(ev.data);
    return;
  }
  service.handleMain(msg);
};
