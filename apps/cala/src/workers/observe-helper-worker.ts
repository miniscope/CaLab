/**
 * Strip helper (`?debug&obsstrips=N`; experimental): sums the cell model's footprint statistics of
 * a batch of frames for one band of image rows, over the port the main thread connects to the slow
 * worker (see `strip-types.ts` and `discover/strips.rs`). Stateless between jobs apart from the
 * frame size, the FOV and the recent libraries.
 */
import { initCalaWasm, SettleDeltaBuilder, TraceLibrary } from '../lib/cala-wasm.ts';
import { runStripJob, type StripBuilderLike } from '../lib/strip-plan.ts';
import {
  STRIP_KEEP_VERSIONS,
  type OwnerToStrip,
  type StripConnect,
  type StripToOwner,
} from './strip-types.ts';

const workerScope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<StripConnect>) => void) | null;
};

let port: MessagePort | null = null;
let session = -1;
let builder: SettleDeltaBuilder | null = null;
const libs = new Map<number, TraceLibrary>();
let queue: Promise<void> = Promise.resolve();

function post(msg: StripToOwner, transfer: Transferable[] = []): void {
  port?.postMessage(msg, transfer);
}

function clear(): void {
  builder?.free();
  builder = null;
  for (const l of libs.values()) l.free();
  libs.clear();
}

function handle(msg: OwnerToStrip): void {
  if (msg.type === 'reset' || msg.type === 'init') {
    if (msg.session < session) return;
    clear();
    session = msg.session;
    if (msg.type === 'init') builder = new SettleDeltaBuilder(msg.width, msg.height, msg.fov);
    return;
  }
  if (msg.session !== session || !builder) return;
  if (msg.type === 'library') {
    libs.set(msg.version, TraceLibrary.fromBytes(msg.bytes));
    while (libs.size > STRIP_KEEP_VERSIONS) {
      const oldest = Math.min(...libs.keys());
      libs.get(oldest)?.free();
      libs.delete(oldest);
    }
    return;
  }
  const t0 = performance.now();
  const lib = libs.get(msg.version);
  if (!lib) throw new Error(`strip helper: library ${msg.version} is not held`);
  const bytes = runStripJob(builder as unknown as StripBuilderLike, lib, msg);
  post({ type: 'delta', session, id: msg.id, bytes, ms: performance.now() - t0 }, [
    bytes.buffer as ArrayBuffer,
  ]);
}

workerScope.onmessage = (e) => {
  if (e.data.type !== 'connect') return;
  port?.close();
  port = e.data.port;
  port.onmessage = (ev: MessageEvent<OwnerToStrip>) => {
    const msg = ev.data;
    queue = queue
      .then(() => initCalaWasm())
      .then(() => handle(msg))
      .catch((err: unknown) =>
        post({
          type: 'error',
          session: msg.session,
          id: msg.type === 'job' ? msg.id : -1,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
  };
};
