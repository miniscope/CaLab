/**
 * Main-thread handle on the frame worker: promise-based `open` / `readFrame`
 * and the pipeline calls, over the message protocol in
 * `workers/frame-types.ts`.
 */
import type { FolderEntry, FramePixels, FrameSourceInfo } from './frame-source.ts';
import type { PipelineStepResult } from './pipeline-engine.ts';
import type { PipelineOptions, PipelinePlan } from './pipeline-plan.ts';
import type { ReplayInput } from './pipeline-stages.ts';
import type { CellsSettings } from '../workers/frame-types.ts';
import type { FrameRequest, FrameRequestBody, FrameResponse } from '../workers/frame-types.ts';

/** The preprocess + motion pipeline, as the UI drives it. */
export interface PipelineClient {
  /** Set up the pipeline over the open recording (replacing a running one). */
  startPipeline(
    options?: PipelineOptions,
    cells?: CellsSettings,
    /** Pass 2: replay the recorded flicker and motion over the first `replay.frameCount` frames. */
    replay?: ReplayInput,
  ): Promise<PipelinePlan>;
  /** End the running pipeline's recording at the current position (finish pass 1 early). */
  truncatePipeline?(): Promise<void>;
  /** Run one step in the worker. Calls are answered in order. */
  stepPipeline(): Promise<PipelineStepResult>;
  /** Free the worker-side pipeline. */
  stopPipeline(): Promise<void>;
  /** Turn cell discovery on or off in the running pipeline. */
  setDiscovery?(on: boolean): Promise<void>;
  /** Step requests the caller may keep outstanding (default 2; a pipelined client needs more to keep every stage busy). */
  readonly maxInFlight?: number;
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

/** Step requests outstanding on a pipelined client: one per stage plus one in transit. */
export const PIPELINED_IN_FLIGHT = 4;

export interface FrameClientOptions {
  /**
   * Split the per-frame work across three workers (frame -> motion -> trace,
   * see `lib/pipeline-stages.ts`). Off: the frame worker runs it all, as before.
   */
  pipelined?: boolean;
  /** WebGPU motion correction (default true; falls back to WASM when unavailable). */
  gpu?: boolean;
  makeMotionWorker?: () => WorkerLike;
  makeTraceWorker?: () => WorkerLike;
}

export function createFrameClient(
  makeWorker: () => WorkerLike = () =>
    new Worker(new URL('../workers/frame-worker.ts', import.meta.url), { type: 'module' }),
  options: FrameClientOptions = {},
): FrameClient {
  const worker = makeWorker();
  const pipelined = options.pipelined === true;
  const stageWorkers: WorkerLike[] = pipelined
    ? [
        (
          options.makeMotionWorker ??
          (() =>
            new Worker(new URL('../workers/motion-worker.ts', import.meta.url), { type: 'module' }))
        )(),
        (
          options.makeTraceWorker ??
          (() =>
            new Worker(new URL('../workers/trace-worker.ts', import.meta.url), { type: 'module' }))
        )(),
      ]
    : [];
  /** The worker that owns the slow-worker port and the discovery switch. */
  const traceTarget = pipelined ? stageWorkers[1] : worker;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let terminalError: Error | null = null;

  function fail(err: Error): void {
    terminalError ??= err;
    for (const p of pending.values()) p.reject(terminalError);
    pending.clear();
  }

  const onmessage = (e: MessageEvent<FrameResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.type === 'error') p.reject(new Error(e.data.message));
    else p.resolve(e.data);
  };
  const onerror = (e: ErrorEvent) => {
    fail(new Error(e.message || 'A pipeline worker crashed.'));
  };
  for (const w of [worker, ...stageWorkers]) {
    w.onmessage = onmessage;
    w.onerror = onerror;
  }
  if (pipelined) {
    // frame (A) -> motion (B) -> trace (C): jobs go down, freed buffers come back up.
    const ab = new MessageChannel();
    const bc = new MessageChannel();
    stageWorkers[0].postMessage(
      { type: 'stage-link', up: ab.port2, down: bc.port1, gpu: options.gpu },
      [ab.port2, bc.port1],
    );
    stageWorkers[1].postMessage({ type: 'stage-link', up: bc.port2 }, [bc.port2]);
    void call({ type: 'link', down: ab.port1 }, [ab.port1]).catch(() => {});
  }

  function call(
    req: FrameRequestBody,
    transfer: Transferable[] = [],
    target: WorkerLike = worker,
  ): Promise<FrameResponse> {
    if (terminalError) return Promise.reject(terminalError);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        target.postMessage({ ...req, id } as FrameRequest, transfer);
      } catch (err) {
        // A cloning/transfer failure belongs to this request; the worker can
        // still handle later calls. Do not retain this rejected request.
        pending.delete(id);
        reject(err);
      }
    });
  }

  return {
    ...(pipelined ? { maxInFlight: PIPELINED_IN_FLIGHT } : {}),
    async open(entries) {
      return expectType(await call({ type: 'open', entries }), 'opened').info;
    },
    async readFrames(start, count) {
      return expectType(await call({ type: 'read', start, count }), 'frames').pixels;
    },
    readFrame(index) {
      return this.readFrames(index, 1);
    },
    async startPipeline(options = {}, cells, replay) {
      return expectType(
        await call({ type: 'pipeline-start', options, cells, ...(replay ? { replay } : {}) }),
        'pipeline-ready',
      ).plan;
    },
    async truncatePipeline() {
      expectType(await call({ type: 'pipeline-truncate' }), 'ok');
    },
    async setDiscovery(on) {
      expectType(await call({ type: 'set-discovery', on }, [], traceTarget), 'ok');
    },
    async connectSlow(port) {
      expectType(await call({ type: 'connect-slow', port }, [port], traceTarget), 'ok');
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
      for (const w of stageWorkers) w.terminate();
      fail(new Error('The frame client was disposed.'));
    },
  };
}
