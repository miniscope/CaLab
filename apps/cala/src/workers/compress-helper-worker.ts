/**
 * A compress helper: compresses the tiles the compress worker hands it
 * (`TilePool` in `lib/compress-pool.ts`) and sends back each tile's factor
 * bytes. It holds no store and touches no file: the compress worker reads
 * the tiles and writes the factors.
 */
import { initCalaWasm, TileCompressor } from '../lib/cala-wasm.ts';
import type { CoordinatorToHelper, HelperToCoordinator } from './compress-types.ts';

const workerScope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<{ port: MessagePort }>) => void) | null;
};

let compressor: TileCompressor | null = null;
// Tiles are compressed one at a time, after the WASM module is ready.
let queue: Promise<void> = Promise.resolve();
let failed: string | null = null;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
  const { epoch, window, tile, frames, x0, y0, w, h, seed, raw } = msg;
  try {
    if (!compressor) throw new Error('The compress helper has no compressor (no init).');
    const t0 = performance.now();
    const f = compressor.compress(raw.subarray(0, frames * w * h), frames, x0, y0, w, h, seed);
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
    post({ type: 'tile-error', epoch, window, tile, message: message(err) });
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
          failed ??= `The compress helper could not start: ${message(err)}`;
          handle(port, ev.data);
        },
      );
  };
};
