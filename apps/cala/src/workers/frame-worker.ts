/**
 * Frame worker: owns the wasm AVI parser and the `FrameSource` (so file
 * reads and decoding stay off the main thread) and transfers each decoded
 * frame back as a Transferable.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { FrameSource } from '../lib/frame-source.ts';
import type { FrameRequest, FrameResponse } from './frame-types.ts';

let source: FrameSource | null = null;

const workerScope = globalThis as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

function post(msg: FrameResponse, transfer: Transferable[] = []): void {
  workerScope.postMessage(msg, transfer);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

self.onmessage = async (e: MessageEvent<FrameRequest>) => {
  const req = e.data;
  try {
    switch (req.type) {
      case 'open': {
        await initCalaWasm();
        source?.dispose();
        source = null;
        source = await FrameSource.open(req.files);
        post({ type: 'opened', id: req.id, info: source.info });
        break;
      }
      case 'read': {
        if (!source) throw new Error('No recording is open.');
        const pixels = await source.readFrame(req.index);
        post({ type: 'frame', id: req.id, index: req.index, pixels }, [pixels.buffer]);
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: messageOf(err) });
  }
};
