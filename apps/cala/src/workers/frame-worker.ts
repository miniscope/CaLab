/**
 * Frame worker: owns the wasm AVI parser and the `FrameSource` (so file
 * reads and decoding stay off the main thread) and transfers each decoded
 * batch back as a Transferable. Also runs the preprocess + motion pipeline
 * (`PipelineEngine`), one step per request, so the pipeline reads frames
 * without a round trip through the main thread.
 *
 * This is the fast loop: after motion correction each batch is solved for
 * the traces of the current footprint library, and the frames are forwarded
 * to the slow worker (cell discovery) over a `MessagePort`. The fast loop
 * never waits for the slow worker: see `FastLoop` and `ForwardPool`.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { CompressFeed } from '../lib/compress-feed.ts';
import { FastLoop } from '../lib/fast-loop.ts';
import { FLAT_FIELD_MAX_QUEUE } from '../lib/flat-field.ts';
import type { FlatFieldBatch, FlatFieldSink, FlatFieldStart } from '../lib/flat-field-runner.ts';
import { FrameSource } from '../lib/frame-source.ts';
import { LiveSource, type SocketLike } from '../lib/live-source.ts';
import { PipelineEngine, transferablesOf, type FrameReader } from '../lib/pipeline-engine.ts';
import { FrontStage, jobTransferables } from '../lib/pipeline-stages.ts';
import { StagePool } from '../lib/stage-pool.ts';
import { traceBackend as backend } from '../lib/trace-backend.ts';
import type { FastToCompress } from './compress-types.ts';
import type { FrameRequest, FrameResponse } from './frame-types.ts';
import type { FlatFieldDown, FlatFieldUp } from './flat-field-types.ts';
import type { StageFree, StageMsg, StageShifts } from './stage-types.ts';
import type { FastToSlow, SlowToFast } from './slow-types.ts';

let source: FrameSource | null = null;
/** A live source (the socket lives here): frames arrive while steps wait for them. */
let live: LiveSource | null = null;
let liveUrl: string | null = null;
let pipeline: PipelineEngine | null = null;
let slowPort: MessagePort | null = null;
let compressPort: MessagePort | null = null;

// Pipelined run (`link` received): this worker is stage A only (read +
// preprocess front half); the motion and trace workers do the rest.
let down: MessagePort | null = null;
let front: FrontStage | null = null;
let frontPool: StagePool | null = null;
let epoch = 0;
/** Preprocessed-frame buffers between this stage and the motion stage. */
const FRONT_BUFFERS = 3;

// Online flat field: raw batches + shifts go to the flat-field worker over `flatPort`
// (never waited for: see `PortSink`), its maps come back and are applied by stage A.
let flatPort: MessagePort | null = null;
let flatSink: PortSink | null = null;
let flatSession = 0;

/** The flat-field worker as stage A's sink: at most `FLAT_FIELD_MAX_QUEUE` batches unanswered. */
class PortSink implements FlatFieldSink {
  private outstanding = 0;

  constructor(
    private readonly port: MessagePort,
    readonly session: number,
  ) {}

  start(msg: FlatFieldStart): void {
    this.outstanding = 0;
    this.port.postMessage({ type: 'start', ...msg } satisfies FlatFieldDown, [msg.fovMask.buffer]);
  }

  ready(): boolean {
    return this.outstanding < FLAT_FIELD_MAX_QUEUE;
  }

  push(msg: FlatFieldBatch): void {
    this.outstanding++;
    this.port.postMessage({ type: 'batch', ...msg } satisfies FlatFieldDown, [
      msg.raw.buffer as ArrayBuffer,
      msg.dy.buffer as ArrayBuffer,
      msg.dx.buffer as ArrayBuffer,
    ]);
  }

  stop(): void {
    this.port.postMessage({ type: 'stop' } satisfies FlatFieldDown);
  }

  acked(): void {
    if (this.outstanding > 0) this.outstanding--;
  }
}

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

/** The open recording: a folder or a live stream. */
function reader(): FrameReader {
  if (live) return live;
  if (!source) throw new Error('No recording is open.');
  return source;
}

function closeSources(): void {
  source?.dispose();
  source = null;
  live?.dispose();
  live = null;
}

/** Connect to the live source at `url` and wait for its hello. */
function openLive(url: string): Promise<LiveSource> {
  // A WebSocket's handlers take MessageEvents, which carry `data` as the source expects.
  return LiveSource.open(new WebSocket(url) as unknown as SocketLike, url);
}

function stopPipeline(): void {
  pipeline?.dispose();
  pipeline = null;
  if (front) {
    front.dispose();
    front = null;
    frontPool = null;
    flatSink = null;
    down?.postMessage({ type: 'stop', epoch } satisfies StageMsg);
  }
}

async function handle(req: FrameRequest): Promise<void> {
  try {
    switch (req.type) {
      case 'open': {
        await initCalaWasm();
        stopPipeline();
        closeSources();
        liveUrl = null;
        source = await FrameSource.open(req.entries);
        post({ type: 'opened', id: req.id, info: source.info });
        break;
      }
      case 'open-live': {
        await initCalaWasm();
        stopPipeline();
        closeSources();
        liveUrl = req.url;
        live = await openLive(req.url);
        post({ type: 'opened', id: req.id, info: live.info });
        break;
      }
      case 'read': {
        if (!source)
          throw new Error(
            live ? 'A live source cannot be read at random.' : 'No recording is open.',
          );
        const pixels = await source.readFrames(req.start, req.count);
        post({ type: 'frames', id: req.id, start: req.start, count: req.count, pixels }, [
          pixels.buffer,
        ]);
        break;
      }
      case 'pipeline-start': {
        stopPipeline();
        // A live stream cannot be rewound: a restart (or a run after the stream
        // ended) connects again, and the source streams from where it is now.
        if (live && liveUrl && (live.used || live.stats().ended)) {
          live.dispose();
          live = null;
          live = await openLive(liveUrl);
        }
        const src = reader();
        if (live && req.replay) throw new Error('Pass 2 needs the recording on disk.');
        if (down) {
          epoch++;
          // The stage asks for buffers only from its first `next()`, after the pool exists.
          // Pass 1 estimates the flat field in the flat-field worker; pass 2 replays pass 1's map.
          flatSession = req.cells?.session ?? 0;
          flatSink =
            flatPort && !req.replay && req.options.flatField !== false
              ? new PortSink(flatPort, flatSession)
              : null;
          const stage = new FrontStage(
            src,
            req.options,
            () => frontPool!.acquire(),
            undefined,
            req.replay,
            {
              session: flatSession,
              ...(flatSink ? { sink: flatSink } : {}),
              ...(req.flat?.seed ? { initial: req.flat.seed } : {}),
            },
          );
          live?.setRetainFrames(
            Math.max(stage.plan.calibrationFrames, stage.plan.motionWarmupFrames),
          );
          frontPool = new StagePool(
            FRONT_BUFFERS,
            stage.plan.batchSize * src.info.width * src.info.height,
          );
          front = stage;
          down.postMessage({
            type: 'start',
            epoch,
            id: req.id,
            setup: stage.setup,
            fast: stage.fastSetup,
            cells: req.cells,
          } satisfies StageMsg);
          post({ type: 'pipeline-ready', id: req.id, plan: stage.plan });
          break;
        }
        if (req.replay) throw new Error('Pass 2 needs the pipelined workers.');
        const cells = req.cells;
        const port = slowPort;
        pipeline = new PipelineEngine(src, req.options, undefined, (setup) => {
          return new FastLoop(
            {
              ...setup,
              session: cells?.session ?? 0,
              discover: (cells?.discover ?? true) && port !== null,
              qc: cells?.qc ?? true,
              residual: cells?.residual ?? false,
              ...(cells?.forwardBuffers ? { poolSize: cells.forwardBuffers } : {}),
            },
            port as { postMessage(m: FastToSlow, t?: Transferable[]): void } | null,
            backend,
            cells?.compress && compressPort
              ? new CompressFeed(
                  { width: setup.width, height: setup.height, session: cells.session },
                  compressPort as { postMessage(m: FastToCompress, t?: Transferable[]): void },
                )
              : null,
          );
        });
        live?.setRetainFrames(
          Math.max(pipeline.plan.calibrationFrames, pipeline.plan.motionWarmupFrames),
        );
        post({ type: 'pipeline-ready', id: req.id, plan: pipeline.plan });
        break;
      }
      case 'pipeline-step': {
        if (down) {
          // The answer comes from the trace worker, with this request's id.
          if (!front) throw new Error('The pipeline is not running.');
          const job = await front.next();
          if (!job) {
            down.postMessage({ type: 'end', epoch, id: req.id } satisfies StageMsg);
          } else {
            down.postMessage(
              { type: 'job', epoch, id: req.id, job } satisfies StageMsg,
              jobTransferables(job),
            );
          }
          break;
        }
        if (!pipeline) throw new Error('The pipeline is not running.');
        const step = await pipeline.step();
        post({ type: 'pipeline-step', id: req.id, step }, transferablesOf(step));
        break;
      }
      case 'pipeline-truncate': {
        // Handled before queueing (see below); answered here, in order.
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'pipeline-stop': {
        stopPipeline();
        post({ type: 'pipeline-stopped', id: req.id });
        break;
      }
      case 'link': {
        down?.close();
        down = req.down;
        down.onmessage = (e: MessageEvent<StageFree | StageShifts>) => {
          if (e.data.epoch !== epoch) return;
          if (e.data.type === 'free') frontPool?.release(e.data.buffer);
          else front?.onShifts(e.data.start, e.data.dy, e.data.dx);
        };
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'link-flat': {
        flatPort?.close();
        flatPort = req.port;
        flatPort.onmessage = (e: MessageEvent<FlatFieldUp>) => {
          const m = e.data;
          if (m.session !== flatSession) return;
          if (m.type === 'ack') flatSink?.acked();
          else front?.offerFlatField(m.seq, m.map);
        };
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'connect-slow': {
        slowPort?.close();
        slowPort = req.port;
        // Slow-worker answers only record state; they are applied between batches.
        slowPort.onmessage = (e: MessageEvent<SlowToFast>) =>
          pipeline?.fastLoop?.handleSlow(e.data);
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'connect-compress': {
        compressPort?.close();
        compressPort = req.port;
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'set-discovery': {
        pipeline?.fastLoop?.setDiscovery(req.on && slowPort !== null);
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'set-residual': {
        pipeline?.fastLoop?.setResidual(req.on);
        post({ type: 'ok', id: req.id });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: messageOf(err) });
  }
}

/**
 * Stop reading here. Done as soon as the message arrives, not in its turn:
 * a step on a live source may be waiting for frames that never come (the
 * stream paused, or the user wants to stop), and the queued requests sit
 * behind it. Both are flag flips, so running them out of order is safe.
 */
function truncateNow(): void {
  front?.truncate();
  pipeline?.truncate();
  live?.stop();
}

// One message at a time, in arrival order: an `open` must never dispose the
// headers while a `read` is awaiting its slice, nor a `pipeline-stop` free the
// pipeline while a step is running.
let queue: Promise<void> = Promise.resolve();
workerScope.onmessage = (e) => {
  const req = e.data;
  if (req.type === 'pipeline-truncate' || req.type === 'pipeline-stop') truncateNow();
  queue = queue.then(() => handle(req));
};
