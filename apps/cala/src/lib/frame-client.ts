/**
 * Main-thread handle on the frame worker: promise-based `open` / `readFrame`
 * over the message protocol in `workers/frame-types.ts`.
 */
import type { FrameSourceInfo } from './frame-source.ts';
import type { FrameRequest, FrameRequestBody, FrameResponse } from '../workers/frame-types.ts';

/** What the UI needs from a frame source; the tests substitute a fake. */
export interface FrameClient {
  open(files: File[]): Promise<FrameSourceInfo>;
  readFrame(index: number): Promise<Uint8Array>;
  dispose(): void;
}

type Pending = {
  resolve: (msg: FrameResponse) => void;
  reject: (err: Error) => void;
};

export function createFrameClient(
  makeWorker: () => Worker = () =>
    new Worker(new URL('../workers/frame-worker.ts', import.meta.url), { type: 'module' }),
): FrameClient {
  const worker = makeWorker();
  const pending = new Map<number, Pending>();
  let nextId = 1;

  worker.onmessage = (e: MessageEvent<FrameResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.type === 'error') p.reject(new Error(e.data.message));
    else p.resolve(e.data);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'The frame worker crashed.');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  function call(req: FrameRequestBody): Promise<FrameResponse> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id } as FrameRequest);
    });
  }

  return {
    async open(files) {
      const res = await call({ type: 'open', files });
      if (res.type !== 'opened') throw new Error('Unexpected worker response.');
      return res.info;
    },
    async readFrame(index) {
      const res = await call({ type: 'read', index });
      if (res.type !== 'frame') throw new Error('Unexpected worker response.');
      return res.pixels;
    },
    dispose() {
      // Terminating drops the worker's wasm memory along with its tables.
      worker.terminate();
      const err = new Error('The frame client was disposed.');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    },
  };
}
