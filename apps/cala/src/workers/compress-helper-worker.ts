/**
 * A compress helper: compresses the tiles the compress worker hands it
 * (`TilePool` in `lib/compress-pool.ts`) and sends back each tile's factor
 * bytes; and solves the windows of an Extract job on factors (`WindowPool`,
 * `solveWindow`) and sends back their traces. It holds no store and touches
 * no file: the compress worker reads the tiles and factor files and writes.
 */
import { paramsHandle } from '../lib/params-handle.ts';
import { FactorExtractor, FactorWindow, initCalaWasm, TileCompressor } from '../lib/cala-wasm.ts';
import { solveWindow } from '../lib/factor-solve.ts';
import type { CoordinatorToHelper, HelperToCoordinator } from './compress-types.ts';
import { errMsg } from '../lib/errors.ts';

const workerScope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<{ port: MessagePort }>) => void) | null;
};

let compressor: TileCompressor | null = null;
/** The Extract job's extractor, started cold for every window. */
let extract: { job: number; x: FactorExtractor; signed: boolean; px: number } | null = null;
/** Why the job's extractor could not be built (its windows answer with it). */
let extractError: { job: number; message: string } | null = null;
// Tiles are compressed one at a time, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();
let failed: string | null = null;

function handle(port: MessagePort, msg: CoordinatorToHelper): void {
  const post = (m: HelperToCoordinator, transfer: Transferable[] = []): void =>
    port.postMessage(m, transfer);
  if (failed !== null) {
    post({ type: 'helper-error', message: failed });
    return;
  }
  if (msg.type === 'init') {
    compressor?.free();
    compressor = new TileCompressor(msg.quant);
    return;
  }
  if (msg.type === 'extract-begin') {
    extract?.x.free();
    extract = null;
    extractError = null;
    try {
      const x = new FactorExtractor(msg.library, paramsHandle(msg.params));
      if (msg.signed) x.setSigned(true);
      extract = { job: msg.job, x, signed: msg.signed, px: msg.px };
    } catch (err) {
      extractError = { job: msg.job, message: errMsg(err) };
    }
    return;
  }
  if (msg.type === 'extract-end') {
    if (extract?.job === msg.job) {
      extract.x.free();
      extract = null;
    }
    return;
  }
  if (msg.type === 'extract-window') {
    const { job, index, bytes } = msg;
    try {
      if (!extract || extract.job !== job)
        throw new Error(
          extractError?.job === job
            ? extractError.message
            : 'The compress helper has no extractor for this Extract job.',
        );
      const r = solveWindow(
        extract.x,
        bytes,
        (b) => FactorWindow.fromBytes(b),
        extract.px,
        extract.signed,
      );
      const transfer: Transferable[] = [r.traces.buffer as ArrayBuffer];
      if (r.signed) transfer.push(r.signed.buffer as ArrayBuffer);
      post({ type: 'window-done', job, index, ...r }, transfer);
    } catch (err) {
      post({ type: 'window-error', job, index, message: errMsg(err) });
    }
    return;
  }
  const { epoch, window, tile, frames, x0, y0, w, h, seed, prevRank, raw } = msg;
  try {
    if (!compressor) throw new Error('The compress helper has no compressor (no init).');
    const t0 = performance.now();
    const f = compressor.compress(
      raw.subarray(0, frames * w * h),
      frames,
      x0,
      y0,
      w,
      h,
      seed,
      prevRank,
    );
    try {
      const ms = performance.now() - t0;
      const bytes = f.toBytes();
      post({ type: 'tile-done', epoch, window, tile, rank: f.rank, ms, bytes, raw }, [
        bytes.buffer as ArrayBuffer,
        raw.buffer as ArrayBuffer,
      ]);
    } finally {
      f.free();
    }
  } catch (err) {
    post({ type: 'tile-error', epoch, window, tile, message: errMsg(err) });
  }
}

// The main thread hands over the port to the compress worker once.
workerScope.onmessage = (e) => {
  const port = e.data.port;
  port.onmessage = (ev: MessageEvent<CoordinatorToHelper>) => {
    queue = queue
      .then(() => initCalaWasm())
      .then(
        () => handle(port, ev.data),
        (err: unknown) => {
          failed ??= `The compress helper could not start: ${errMsg(err)}`;
          handle(port, ev.data);
        },
      );
  };
};
