/**
 * Frame worker: owns the wasm AVI parser and the `FrameSource` (so file
 * reads and decoding stay off the main thread) and answers random reads with
 * Transferables. During a run it is stage A of `pipeline-stages.ts` (read,
 * preprocess front half, flat-field apply), one job per `pipeline-step`
 * request, sent down to the motion worker over the `link` port; the trace
 * worker answers the request.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { FLAT_FIELD_MAX_QUEUE } from '../lib/flat-field.ts';
import type { FlatFieldBatch, FlatFieldSink, FlatFieldStart } from '../lib/flat-field-runner.ts';
import { PaceGate, PacedQueue } from '../lib/frame-pacer.ts';
import { FrameSource } from '../lib/frame-source.ts';
import { LiveSource, type SocketLike } from '../lib/live-source.ts';
import type { FrameReader } from '../lib/pipeline-types.ts';
import { FrontStage, jobTransferables } from '../lib/pipeline-stages.ts';
import { FramePreviewSetting } from '../lib/frame-preview-setting.ts';
import { StagePool } from '../lib/stage-pool.ts';
import type { FrameRequest, FrameResponse, SessionProbeResult } from './frame-types.ts';
import type { FlatFieldDown, FlatFieldUp } from './flat-field-types.ts';
import type { StageFree, StageMsg, StageShifts } from './stage-types.ts';

let source: FrameSource | null = null;
/** A live source (the socket lives here): frames arrive while steps wait for them. */
let live: LiveSource | null = null;
let liveUrl: string | null = null;
/** Smooth pacing of a recording's Discover run, at the entry of the first stage (unpaced by default). */
const gate = new PaceGate();

/** The port to the motion worker (stage B), from `link`. */
let down: MessagePort | null = null;
let front: FrontStage | null = null;
/** The view previewed for every frame (smooth playback); cleared at every run start. */
const framePreview = new FramePreviewSetting();
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

  /** The recording ended: no batch follows (the worker then says its last map is out). */
  finish(): void {
    this.port.postMessage({ type: 'finish', session: this.session } satisfies FlatFieldDown);
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
  if (front) {
    front.dispose();
    front = null;
    frontPool = null;
    flatSink = null;
  }
  down?.postMessage({ type: 'stop', epoch } satisfies StageMsg);
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
      case 'open-sessions': {
        await initCalaWasm();
        stopPipeline();
        closeSources();
        liveUrl = null;
        source = await FrameSource.openSessions(req.sessions);
        post({ type: 'opened', id: req.id, info: source.info });
        break;
      }
      case 'probe': {
        await initCalaWasm();
        const results: SessionProbeResult[] = [];
        for (const s of req.sessions) {
          try {
            const probed = await FrameSource.open(s.entries);
            results.push({ info: probed.info });
            probed.dispose();
          } catch (err) {
            results.push({ error: err instanceof Error ? err.message : String(err) });
          }
        }
        post({ type: 'probed', id: req.id, results });
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
        gate.begin(req.cells?.session ?? 0);
        stopPipeline();
        // A live stream cannot be rewound: a restart (or a run after the stream
        // ended) connects again, and the source streams from where it is now.
        if (live && liveUrl && (live.used || live.stats().ended)) {
          live.dispose();
          live = null;
          live = await openLive(liveUrl);
        }
        // Per-frame previews belong to Discover's display: not for replays, and a restart waits for
        // the store's `set-frame-preview` after its start.
        framePreview.startRun(Boolean(req.replay));
        const src = reader();
        if (live && req.replay)
          throw new Error(
            'Extract needs the recording on disk (save the stream and open it as a recording).',
          );
        if (!down) throw new Error('The frame worker is not linked to the motion worker.');
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
        stage.framePreview = framePreview.current;
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
      case 'pipeline-step': {
        // A paced step has already waited at the gate (`PacedQueue`), outside the serial queue
        // and before any stage's timing starts, so the wait is not busy time. The answer comes
        // from the trace worker, with this request's id.
        if (!front || !down) throw new Error('The pipeline is not running.');
        const job = await front.next();
        if (!job) {
          flushPaceStats();
          // The flat-field estimator gets no more batches: it says when its last map is out.
          flatSink?.finish();
          down.postMessage({ type: 'end', epoch, id: req.id } satisfies StageMsg);
        } else {
          down.postMessage(
            { type: 'job', epoch, id: req.id, job } satisfies StageMsg,
            jobTransferables(job),
          );
        }
        break;
      }
      case 'pipeline-truncate': {
        // Handled before queueing (see below); answered here, in order.
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'pipeline-stop': {
        flushPaceStats();
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
          else front?.onShifts(e.data.start, e.data.dy, e.data.dx, e.data.session);
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
  live?.stop();
}

/** Messages that act at once, ahead of the queue (a step may be waiting at the gate). */
function actNow(req: FrameRequest): boolean {
  switch (req.type) {
    case 'pace':
      // A live stream is never paced.
      if (req.fps !== undefined && !live) {
        gate.setTarget(req.fps);
        flushPaceStats();
      }
      if (req.paused === true) gate.pause();
      else if (req.paused === false) gate.resume();
      post({ type: 'ok', id: req.id });
      return true;
    case 'set-frame-preview':
      framePreview.set(req.view);
      if (front) front.framePreview = framePreview.current;
      post({ type: 'ok', id: req.id });
      return true;
    case 'pipeline-truncate':
      gate.openUp();
      truncateNow();
      return false;
    case 'pipeline-stop':
      pacedQueue.cancelWaiting();
      truncateNow();
      return false;
    // A restart or a new source: steps still waiting at the gate belong to the old run.
    case 'pipeline-start':
    case 'open':
    case 'open-sessions':
    case 'open-live':
      pacedQueue.cancelWaiting();
      return false;
    default:
      return false;
  }
}

// One message at a time, in arrival order: an `open` must never dispose the
// headers while a `read` is awaiting its slice, nor a `pipeline-stop` free the
// pipeline while a step is running.
let lastPaceStats = Number.NEGATIVE_INFINITY;
/**
 * The gate's readouts to the main thread now (a run ended or stopped, or its target changed, back to
 * Max included), whatever the once-a-second rhythm says. Only for a run that has had a target.
 */
function flushPaceStats(): void {
  if (!gate.reports) return;
  lastPaceStats = performance.now();
  post({ type: 'pace-stats', id: -1, stats: gate.stats() });
}
const pacedQueue = new PacedQueue<FrameRequest>({
  gate,
  isStep: (req) => req.type === 'pipeline-step',
  run: handle,
  cancelled: (req) => post({ type: 'error', id: req.id, message: 'The run was stopped.' }),
  released: () => {
    // Pacing readouts for the main thread, about once a second.
    if (performance.now() - lastPaceStats < 1000) return;
    flushPaceStats();
  },
});
workerScope.onmessage = (e) => {
  const req = e.data;
  if (actNow(req)) return;
  pacedQueue.push(req);
};
