/**
 * Frame worker: owns the wasm AVI parser and the `FrameSource` (so file
 * reads and decoding stay off the main thread) and transfers each decoded
 * batch back as a Transferable.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { FrameSource } from '../lib/frame-source.ts';
import type { FrameRequest, FrameResponse } from './frame-types.ts';

let source: FrameSource | null = null;

const workerScope = globalThis as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FrameRequest>) => void) | null;
};

function post(msg: FrameResponse, transfer: Transferable[] = []): void {
  workerScope.postMessage(msg, transfer);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handle(req: FrameRequest): Promise<void> {
  try {
    switch (req.type) {
      case 'open': {
        await initCalaWasm();
        source?.dispose();
        source = null;
        source = await FrameSource.open(req.entries);
        post({ type: 'opened', id: req.id, info: source.info });
        break;
      }
      case 'read': {
        if (!source) throw new Error('No recording is open.');
        const pixels = await source.readFrames(req.start, req.count);
        post({ type: 'frames', id: req.id, start: req.start, count: req.count, pixels }, [
          pixels.buffer,
        ]);
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: messageOf(err) });
  }
}

// One message at a time, in arrival order: an `open` must never dispose the
// headers while a `read` is awaiting its slice.
let queue: Promise<void> = Promise.resolve();
workerScope.onmessage = (e) => {
  queue = queue.then(() => handle(e.data));
};
