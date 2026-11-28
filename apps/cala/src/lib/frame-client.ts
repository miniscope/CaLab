/**
 * Main-thread handle on the pipeline workers: promise-based `open` / `readFrame`
 * and the pipeline calls, over the message protocol in
 * `workers/frame-types.ts`. The per-frame work is split across three workers
 * (frame -> motion -> trace, see `lib/pipeline-stages.ts`), with the flat-field
 * estimator in a fourth.
 */
import type { FolderEntry, FramePixels, FrameSourceInfo, SessionInput } from './frame-source.ts';
import type { PipelineStepResult } from './pipeline-types.ts';
import type { PipelineOptions, PipelinePlan } from './pipeline-plan.ts';
import type { FlatFieldEvent, FlatFieldMap } from './flat-field.ts';
import type { ReplayInput } from './pipeline-stages.ts';
import type { FrameView } from './preview.ts';
import type { PaceStats } from './frame-pacer.ts';
import type { CellsSettings } from '../workers/frame-types.ts';
import type {
  FrameRequest,
  FrameRequestBody,
  FrameResponse,
  SessionProbeResult,
} from '../workers/frame-types.ts';

/** The preprocess + motion pipeline, as the UI drives it. */
export interface PipelineClient {
  /** Set up the pipeline over the open recording (replacing a running one). */
  startPipeline(
    options?: PipelineOptions,
    cells?: CellsSettings,
    /** Extract: replay the recorded flicker and motion over the first `replay.frameCount` frames. */
    replay?: ReplayInput,
    /** Discover flat field: a stored map of this sensor to start from. */
    flat?: { seed?: FlatFieldMap },
  ): Promise<PipelinePlan>;
  /** End the running pipeline's recording at the current position (finish Discover early). */
  truncatePipeline?(): Promise<void>;
  /** Run one step in the worker. Calls are answered in order. */
  stepPipeline(): Promise<PipelineStepResult>;
  /** Free the worker-side pipeline. */
  stopPipeline(): Promise<void>;
  /** Pace the running pipeline (`fps`, 0 = unpaced) or hold and resume its gate (`paused`). */
  setPace?(pace: { fps?: number; paused?: boolean }): Promise<void>;
  /** The pace gate's readouts (wait, lateness, re-anchors), pushed by the frame worker. Returns an unsubscribe. */
  readonly subscribePaceStats?: (listener: (s: PaceStats) => void) => () => void;
  /** Turn cell discovery on or off in the running pipeline. */
  setDiscovery?(on: boolean): Promise<void>;
  /** Return (or stop returning) the residual preview in the running pipeline. */
  setResidual?(on: boolean): Promise<void>;
  /** Preview this view of every frame of the next batches (null: the last frame only); smooth playback. */
  setFramePreview?(view: FrameView | null): Promise<void>;
  /**
   * The flat-field estimator's status events (absent: no estimator worker, so no
   * online flat field). Returns an unsubscribe.
   */
  readonly subscribeFlatField?: (listener: (e: FlatFieldEvent) => void) => () => void;
  /**
   * End the flat-field estimator's worker (its run is over: no map follows), so it holds no
   * memory; the next Discover start with the flat field on starts and links another.
   */
  releaseFlatField?(): void;
  /** Step requests the caller may keep outstanding (default 2; `createFrameClient` sets `PIPELINED_IN_FLIGHT`). */
  readonly maxInFlight?: number;
}

/** What the UI needs from a frame source; the tests substitute a fake. */
export interface FrameClient extends PipelineClient {
  open(entries: FolderEntry[]): Promise<FrameSourceInfo>;
  /** Open sessions as one recording, in order (a Joint run). */
  openSessions?(sessions: SessionInput[]): Promise<FrameSourceInfo>;
  /** Each session's info (or error) for the session list; nothing stays open. */
  probe?(sessions: SessionInput[]): Promise<SessionProbeResult[]>;
  /** Connect to a live source at a WebSocket URL (the worker owns the socket). */
  openLive?(url: string): Promise<FrameSourceInfo>;
  readFrame(index: number): Promise<FramePixels>;
  /** `count` consecutive frames in one buffer of `count * width * height` samples. */
  readFrames(start: number, count: number): Promise<FramePixels>;
  /** Hand the trace worker its port to the slow worker (cell discovery). */
  connectSlow?(port: MessagePort): Promise<void>;
  /** Hand the trace worker its port to the compress worker. */
  connectCompress?(port: MessagePort): Promise<void>;
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

/** Step requests outstanding on the client: one per stage plus one in transit. */
export const PIPELINED_IN_FLIGHT = 4;

/** Worker factories (tests pass fakes) and the motion backend. */
export interface FrameClientOptions {
  /** WebGPU motion correction (default true; falls back to WASM when unavailable). */
  gpu?: boolean;
  makeMotionWorker?: () => WorkerLike;
  makeTraceWorker?: () => WorkerLike;
  /** The flat-field estimator's worker (`false`: none, so no online flat field). */
  makeFlatFieldWorker?: (() => WorkerLike) | false;
}

/** Create the pipeline workers, wire their stage and flat-field links, and return the client. */
export function createFrameClient(
  makeWorker: () => WorkerLike = () =>
    new Worker(new URL('../workers/frame-worker.ts', import.meta.url), { type: 'module' }),
  options: FrameClientOptions = {},
): FrameClient {
  const worker = makeWorker();
  const stageWorkers: WorkerLike[] = [
    (
      options.makeMotionWorker ??
      (() =>
        new Worker(new URL('../workers/motion-worker.ts', import.meta.url), { type: 'module' }))
    )(),
    (
      options.makeTraceWorker ??
      (() => new Worker(new URL('../workers/trace-worker.ts', import.meta.url), { type: 'module' }))
    )(),
  ];
  const makeFlatWorker: (() => WorkerLike) | null =
    options.makeFlatFieldWorker !== false
      ? (options.makeFlatFieldWorker ??
        (() =>
          new Worker(new URL('../workers/flat-field-worker.ts', import.meta.url), {
            type: 'module',
          })))
      : null;
  /** The flat-field worker (null: none on this page, or ended by `releaseFlatField`). */
  let flatWorker: WorkerLike | null = null;
  const flatListeners = new Set<(e: FlatFieldEvent) => void>();
  /** The worker that owns the slow-worker port and the discovery switch. */
  const traceTarget = stageWorkers[1];
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let terminalError: Error | null = null;
  /** The running pipeline compresses on the GPU (`cells.compressGpu`): its Discover may wait for the GPU. */
  let gpuRun = false;
  /**
   * The run is stopped or replaced: a batch of a GPU run waiting for the GPU
   * compressor's ring (trace worker, answered at once) must not hold it up.
   */
  function releaseGpuWait(): void {
    if (gpuRun) void call({ type: 'release-compress' }, [], traceTarget).catch(() => {});
    gpuRun = false;
  }

  function fail(err: Error): void {
    terminalError ??= err;
    for (const p of pending.values()) p.reject(terminalError);
    pending.clear();
  }

  const paceListeners = new Set<(s: PaceStats) => void>();
  const onmessage = (e: MessageEvent<FrameResponse>) => {
    if (e.data.type === 'pace-stats') {
      for (const l of paceListeners) l(e.data.stats);
      return;
    }
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
  /** Start the flat-field worker and link it to the frame worker. */
  function startFlatWorker(make: () => WorkerLike): void {
    const w = make();
    flatWorker = w;
    w.onmessage = (e: MessageEvent<FlatFieldEvent>) => {
      for (const l of flatListeners) l(e.data);
    };
    // The estimator failing must never stop the pipeline: it is reported, not fatal.
    w.onerror = (e: ErrorEvent) => {
      for (const l of flatListeners)
        l({ type: 'error', session: -1, message: e.message || 'The flat-field worker crashed.' });
    };
    // frame (A) <-> flat-field worker: raw batches with shifts go out, maps and acks come back.
    const af = new MessageChannel();
    w.postMessage({ type: 'flat-link', port: af.port2 }, [af.port2]);
    // The frame worker handles `link-flat` at once, so a request sent after it sees the link.
    void call({ type: 'link-flat', port: af.port1 }, [af.port1]).catch(() => {});
  }
  // frame (A) -> motion (B) -> trace (C): jobs go down, freed buffers come back up.
  const ab = new MessageChannel();
  const bc = new MessageChannel();
  stageWorkers[0].postMessage(
    { type: 'stage-link', up: ab.port2, down: bc.port1, gpu: options.gpu },
    [ab.port2, bc.port1],
  );
  stageWorkers[1].postMessage({ type: 'stage-link', up: bc.port2 }, [bc.port2]);
  void call({ type: 'link', down: ab.port1 }, [ab.port1]).catch(() => {});
  if (makeFlatWorker) startFlatWorker(makeFlatWorker);

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
    maxInFlight: PIPELINED_IN_FLIGHT,
    subscribePaceStats(listener: (s: PaceStats) => void) {
      paceListeners.add(listener);
      return () => void paceListeners.delete(listener);
    },
    ...(makeFlatWorker
      ? {
          subscribeFlatField(listener: (e: FlatFieldEvent) => void) {
            flatListeners.add(listener);
            return () => void flatListeners.delete(listener);
          },
          releaseFlatField() {
            flatWorker?.terminate();
            flatWorker = null;
          },
        }
      : {}),
    async open(entries) {
      releaseGpuWait();
      return expectType(await call({ type: 'open', entries }), 'opened').info;
    },
    async openSessions(sessions) {
      releaseGpuWait();
      return expectType(await call({ type: 'open-sessions', sessions }), 'opened').info;
    },
    async probe(sessions) {
      return expectType(await call({ type: 'probe', sessions }), 'probed').results;
    },
    async openLive(url) {
      releaseGpuWait();
      return expectType(await call({ type: 'open-live', url }), 'opened').info;
    },
    async readFrames(start, count) {
      return expectType(await call({ type: 'read', start, count }), 'frames').pixels;
    },
    readFrame(index) {
      return this.readFrames(index, 1);
    },
    async startPipeline(options = {}, cells, replay, flat) {
      releaseGpuWait();
      // A Discover run with the flat field on needs its estimator: started again if it was ended.
      if (makeFlatWorker && !flatWorker && !replay && options.flatField !== false)
        startFlatWorker(makeFlatWorker);
      gpuRun = cells?.compressGpu === true;
      return expectType(
        await call({
          type: 'pipeline-start',
          options,
          cells,
          ...(replay ? { replay } : {}),
          ...(flat ? { flat } : {}),
        }),
        'pipeline-ready',
      ).plan;
    },
    async truncatePipeline() {
      expectType(await call({ type: 'pipeline-truncate' }), 'ok');
    },
    async setPace(pace) {
      expectType(await call({ type: 'pace', ...pace }), 'ok');
    },
    async setDiscovery(on) {
      expectType(await call({ type: 'set-discovery', on }, [], traceTarget), 'ok');
    },
    async setResidual(on) {
      expectType(await call({ type: 'set-residual', on }, [], traceTarget), 'ok');
    },
    async setFramePreview(view) {
      expectType(await call({ type: 'set-frame-preview', view }), 'ok');
    },
    async connectSlow(port) {
      expectType(await call({ type: 'connect-slow', port }, [port], traceTarget), 'ok');
    },
    async connectCompress(port) {
      expectType(await call({ type: 'connect-compress', port }, [port], traceTarget), 'ok');
    },
    async stepPipeline() {
      return expectType(await call({ type: 'pipeline-step' }), 'pipeline-step').step;
    },
    async stopPipeline() {
      releaseGpuWait();
      expectType(await call({ type: 'pipeline-stop' }), 'pipeline-stopped');
    },
    dispose() {
      // Terminating drops the worker's wasm memory along with its tables.
      worker.terminate();
      for (const w of stageWorkers) w.terminate();
      flatWorker?.terminate();
      fail(new Error('The frame client was disposed.'));
    },
  };
}
