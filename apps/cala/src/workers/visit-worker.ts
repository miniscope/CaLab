/**
 * Visit worker: runs the slow loop's tile visits (`VisitWorker`) handed out
 * by the slow worker, over the port the main thread connects, and sends each
 * result back. Holds no state between visits besides the noise map; the
 * slow worker owns the cells and the reservoir (see `discover/shard.rs`).
 */
import { initCalaWasm, VisitWorker } from '../lib/cala-wasm.ts';
import type { OwnerToVisit, VisitConnect, VisitToOwner } from './slow-types.ts';

const workerScope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<VisitConnect>) => void) | null;
};

let port: MessagePort | null = null;
let worker: VisitWorker | null = null;
let session = -1;
let queue: Promise<void> = Promise.resolve();

function post(msg: VisitToOwner, transfer: Transferable[] = []): void {
  port?.postMessage(msg, transfer);
}

function handle(msg: OwnerToVisit): void {
  if (msg.type === 'reset' || msg.type === 'init') {
    if (msg.session < session) return;
    worker?.free();
    worker = null;
    session = msg.session;
    if (msg.type === 'init') {
      worker = new VisitWorker(
        msg.width,
        msg.height,
        msg.fov,
        msg.noise,
        msg.cellDiameterPx,
        msg.flattenSigmaPx,
      );
    }
    return;
  }
  if (msg.session !== session || !worker) return;
  if (msg.type === 'noise') {
    worker.setNoise(msg.noise);
    return;
  }
  const t0 = performance.now();
  const bytes = worker.run(msg.bytes);
  post({ type: 'result', session, bytes, ms: performance.now() - t0 }, [
    bytes.buffer as ArrayBuffer,
  ]);
}

workerScope.onmessage = (e) => {
  if (e.data.type !== 'connect') return;
  port?.close();
  port = e.data.port;
  port.onmessage = (ev: MessageEvent<OwnerToVisit>) => {
    queue = queue
      .then(() => initCalaWasm())
      .then(() => handle(ev.data))
      .catch((err: unknown) =>
        post({
          type: 'error',
          session: ev.data.session,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
  };
};
