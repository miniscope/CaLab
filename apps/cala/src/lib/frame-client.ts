/**
 * Main-thread handle on the frame worker: promise-based `open` / `readFrame`
 * and the pipeline calls, over the message protocol in
 * `workers/frame-types.ts`.
 */
import type { FolderEntry, FramePixels, FrameSourceInfo } from './frame-source.ts';
import type { PipelineStepResult } from './pipeline-engine.ts';
import type { PipelineOptions, PipelinePlan } from './pipeline-plan.ts';
import type { CellsSettings } from '../workers/frame-types.ts';
import type { FrameRequest, FrameRequestBody, FrameResponse } from '../workers/frame-types.ts';

/** The preprocess + motion pipeline, as the UI drives it. */
export interface PipelineClient {
  /** Set up the pipeline over the open recording (replacing a running one). */
  startPipeline(options?: PipelineOptions, cells?: CellsSettings): Promise<PipelinePlan>;
  /** Run one step in the worker. Calls are answered in order. */
  stepPipeline(): Promise<PipelineStepResult>;
  /** Free the worker-side pipeline. */
  stopPipeline(): Promise<void>;
  /** Turn cell discovery on or off in the running pipeline. */
  setDiscovery?(on: boolean): Promise<void>;
}

/** What the UI needs from a frame source; the tests substitute a fake. */
export interface FrameClient extends PipelineClient {
  open(entries: FolderEntry[]): Promise<FrameSourceInfo>;
  readFrame(index: number): Promise<FramePixels>;
  /** `count` consecutive frames in one buffer of `count * width * height` samples. */
  readFrames(start: number, count: number): Promise<FramePixels>;
  /** Hand the frame worker its port to the slow worker (cell discovery). */
  connectSlow?(port: MessagePort): Promise<void>;
  dispose(): void;
}

type Pending = {
  resolve: (msg: FrameResponse) => void;
  reject: (err: Error) => void;
};

/** The subset of `Worker` the client uses (so tests can pass a fake). */
export type WorkerLike = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;

function expectType<T extends FrameResponse['type']>(
  res: FrameResponse,
  type: T,
): Extract<FrameResponse, { type: T }> {
  if (res.type !== type) throw new Error('Unexpected worker response.');
  return res as Extract<FrameResponse, { type: T }>;
}

export function createFrameClient(
  makeWorker: () => WorkerLike = () =>
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

  function call(req: FrameRequestBody, transfer: Transferable[] = []): Promise<FrameResponse> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id } as FrameRequest, transfer);
    });
  }

  return {
    async open(entries) {
      return expectType(await call({ type: 'open', entries }), 'opened').info;
    },
    async readFrames(start, count) {
      return expectType(await call({ type: 'read', start, count }), 'frames').pixels;
    },
    readFrame(index) {
      return this.readFrames(index, 1);
    },
    async startPipeline(options = {}, cells) {
      return expectType(await call({ type: 'pipeline-start', options, cells }), 'pipeline-ready')
        .plan;
    },
    async setDiscovery(on) {
      expectType(await call({ type: 'set-discovery', on }), 'ok');
    },
    async connectSlow(port) {
      expectType(await call({ type: 'connect-slow', port }, [port]), 'ok');
    },
    async stepPipeline() {
      return expectType(await call({ type: 'pipeline-step' }), 'pipeline-step').step;
    },
    async stopPipeline() {
      expectType(await call({ type: 'pipeline-stop' }), 'pipeline-stopped');
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
