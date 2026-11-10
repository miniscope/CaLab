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
import { FastLoop } from '../lib/fast-loop.ts';
import { FrameSource } from '../lib/frame-source.ts';
import { LiveSource, type SocketLike } from '../lib/live-source.ts';
import { PipelineEngine, transferablesOf, type FrameReader } from '../lib/pipeline-engine.ts';
import { FrontStage, jobTransferables } from '../lib/pipeline-stages.ts';
import { StagePool } from '../lib/stage-pool.ts';
import { traceBackend as backend } from '../lib/trace-backend.ts';
import type { FrameRequest, FrameResponse } from './frame-types.ts';
import type { StageFree, StageMsg } from './stage-types.ts';
import type { FastToSlow, SlowToFast } from './slow-types.ts';

let source: FrameSource | null = null;
/** A live source (the socket lives here): frames arrive while steps wait for them. */
let live: LiveSource | null = null;
let liveUrl: string | null = null;
let pipeline: PipelineEngine | null = null;
let slowPort: MessagePort | null = null;

// Pipelined run (`link` received): this worker is stage A only (read +
// preprocess front half); the motion and trace workers do the rest.
let down: MessagePort | null = null;
let front: FrontStage | null = null;
let frontPool: StagePool | null = null;
let epoch = 0;
/** Preprocessed-frame buffers between this stage and the motion stage. */
const FRONT_BUFFERS = 3;

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
          const stage = new FrontStage(
            src,
            req.options,
            () => frontPool!.acquire(),
            undefined,
            req.replay,
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
              ...(cells?.forwardBuffers ? { poolSize: cells.forwardBuffers } : {}),
            },
            port as { postMessage(m: FastToSlow, t?: Transferable[]): void } | null,
            backend,
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
        down.onmessage = (e: MessageEvent<StageFree>) => {
          if (e.data.epoch === epoch) frontPool?.release(e.data.buffer);
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
      case 'set-discovery': {
        pipeline?.fastLoop?.setDiscovery(req.on && slowPort !== null);
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
