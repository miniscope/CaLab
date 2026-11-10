/**
 * Main-thread state of the live preprocess + motion pipeline.
 *
 * Backpressure: at most `MAX_IN_FLIGHT` step requests are outstanding. The
 * worker runs one step per request, so it never gets more than one batch
 * ahead of the UI, and only the latest previews are kept (a slow renderer
 * drops frames instead of queueing them). Pausing simply stops requesting.
 */
import { createSignal } from 'solid-js';
import type { CellStore } from './cell-store.ts';
import type { CompressStore } from './compress-store.ts';
import type { PipelineClient } from './frame-client.ts';
import type {
  BatchPreviews,
  MotionBackend,
  PipelineStepResult,
  StageTimings,
} from './pipeline-engine.ts';
import type { PipelineOptions, PipelinePhase, PipelinePlan } from './pipeline-plan.ts';

/** Step requests kept outstanding: one running, one queued so the worker never idles. */
export const MAX_IN_FLIGHT = 2;

export type PipelineStatus = 'idle' | 'starting' | 'running' | 'paused' | 'done' | 'error';

/** Maximum full-resolution motion/flicker samples retained for the live charts. */
export const SHIFT_TRACE_CAPACITY = 32768;

/** Recent rigid shifts and global flicker, bounded independently of recording length. */
export class ShiftTrace {
  /** All samples processed, including those no longer retained for display. */
  totalFrames = 0;

  constructor(readonly capacity = SHIFT_TRACE_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError('ShiftTrace capacity must be a positive safe integer.');
  }

  readonly frame: number[] = [];
  readonly dy: number[] = [];
  readonly dx: number[] = [];
  /** Flicker offset `a_t`, grey levels. */
  readonly offset: number[] = [];
  /** Flicker gain `m_t`, percent. */
  readonly gainPct: number[] = [];

  push(
    start: number,
    dy: ArrayLike<number>,
    dx: ArrayLike<number>,
    offset?: ArrayLike<number>,
    gain?: ArrayLike<number>,
  ): void {
    this.totalFrames += dy.length;
    // Trim before appending, including when a single batch exceeds capacity.
    // Both storage and chart copies stay bounded; never subsample away spikes.
    const first = Math.max(0, dy.length - this.capacity);
    const remove = Math.max(0, this.length + dy.length - first - this.capacity);
    for (const values of [this.frame, this.dy, this.dx, this.offset, this.gainPct])
      values.splice(0, remove);
    for (let i = first; i < dy.length; i++) {
      this.frame.push(start + i);
      this.dy.push(dy[i]);
      this.dx.push(dx[i]);
      this.offset.push(offset ? offset[i] : 0);
      this.gainPct.push(gain ? 100 * gain[i] : 0);
    }
  }

  get length(): number {
    return this.frame.length;
  }
}

/** Frames per second over a sliding window of batch arrivals. */
export class ThroughputMeter {
  private readonly events: { t: number; frames: number }[] = [];
  private readonly windowMs: number;

  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
  }

  /** Record `frames` finished at time `t` (ms); returns the current rate. */
  record(t: number, frames: number): number {
    this.events.push({ t, frames });
    while (this.events.length > 2 && t - this.events[0].t > this.windowMs) this.events.shift();
    return this.rate();
  }

  /** Frames after the first event divided by the time they took (0 until two events). */
  rate(): number {
    if (this.events.length < 2) return 0;
    const span = this.events[this.events.length - 1].t - this.events[0].t;
    if (span <= 0) return 0;
    let frames = 0;
    for (let i = 1; i < this.events.length; i++) frames += this.events[i].frames;
    return (frames * 1000) / span;
  }
}

export interface SetupProgress {
  phase: Exclude<PipelinePhase, 'process'>;
  done: number;
  total: number;
}

const ZERO_TIMINGS: StageTimings = {
  readMs: 0,
  preprocessMs: 0,
  motionMs: 0,
  otherMs: 0,
  traceMs: 0,
};

/** Pipeline sessions, so late messages of a stopped run are told apart. */
let nextSession = 1;

export function createPipelineStore(
  client: PipelineClient,
  options: PipelineOptions = {},
  clock: () => number = () => performance.now(),
  cells?: CellStore,
  /** Online quality control in the fast loop (default on; off to measure its cost). */
  qc = true,
  /** Feed the compress worker; its store is reset with each run. */
  compress?: Pick<CompressStore, 'reset'>,
) {
  const [status, setStatus] = createSignal<PipelineStatus>('idle');
  const [plan, setPlan] = createSignal<PipelinePlan | null>(null);
  const [setup, setSetup] = createSignal<SetupProgress | null>(null);
  const [processed, setProcessed] = createSignal(0);
  const [previews, setPreviews] = createSignal<BatchPreviews | null>(null);
  const [traceVersion, setTraceVersion] = createSignal(0);
  const [fps, setFps] = createSignal(0);
  /** Mean wall time per processed frame and stage, ms. */
  const [stageMs, setStageMs] = createSignal<StageTimings>(ZERO_TIMINGS);
  /** Mean busy time per processed frame of each pipeline stage (A, B, C), ms; empty unless pipelined. */
  const [stageBusy, setStageBusy] = createSignal<number[]>([]);
  /** Where motion correction runs (`null` before the first batch or on the single-worker path). */
  const [motionBackend, setMotionBackend] = createSignal<MotionBackend | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** Cell discovery (the slow loop) on or off. */
  const [discover, setDiscoverSignal] = createSignal(true);

  let trace = new ShiftTrace();
  let meter = new ThroughputMeter();
  let totals: StageTimings = { ...ZERO_TIMINGS };
  let busyTotals: number[] = [];
  let inFlight = 0;
  let exhausted = false;
  let generation = 0; // bumps on start/stop, so late answers are dropped

  function handle(step: PipelineStepResult): void {
    switch (step.kind) {
      case 'setup':
        setSetup({ phase: step.phase, done: step.done, total: step.total });
        return;
      case 'batch': {
        trace.push(step.start, step.dy, step.dx, step.flickerOffset, step.flickerGain);
        setTraceVersion((v) => v + 1);
        setPreviews(step.previews);
        setProcessed(step.start + step.count);
        setFps(meter.record(clock(), step.count));
        const t = step.timings;
        if (step.cells && cells) cells.onBatch(step.start, step.count, step.cells, t);
        totals = {
          readMs: totals.readMs + t.readMs,
          preprocessMs: totals.preprocessMs + t.preprocessMs,
          motionMs: totals.motionMs + t.motionMs,
          otherMs: totals.otherMs + t.otherMs,
          traceMs: totals.traceMs + t.traceMs,
        };
        const n = trace.totalFrames;
        setMotionBackend(step.motionBackend ?? null);
        if (step.stageBusyMs) {
          busyTotals = step.stageBusyMs.map((v, i) => (busyTotals[i] ?? 0) + v);
          setStageBusy(busyTotals.map((v) => v / n));
        }
        setStageMs({
          readMs: totals.readMs / n,
          preprocessMs: totals.preprocessMs / n,
          motionMs: totals.motionMs / n,
          otherMs: totals.otherMs / n,
          traceMs: totals.traceMs / n,
        });
        return;
      }
      case 'done':
        if (!exhausted) {
          exhausted = true;
          setStatus('done');
        }
        return;
    }
  }

  function pump(): void {
    while (
      status() === 'running' &&
      !exhausted &&
      inFlight < (client.maxInFlight ?? MAX_IN_FLIGHT)
    ) {
      const gen = generation;
      inFlight++;
      client
        .stepPipeline()
        .then((step) => {
          if (gen === generation) handle(step);
        })
        .catch((err: unknown) => {
          if (gen !== generation) return;
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        })
        .finally(() => {
          if (gen !== generation) return;
          inFlight--;
          pump();
        });
    }
  }

  function reset(): void {
    generation++;
    inFlight = 0;
    exhausted = false;
    trace = new ShiftTrace();
    meter = new ThroughputMeter();
    totals = { ...ZERO_TIMINGS };
    setPlan(null);
    setSetup(null);
    setProcessed(0);
    setPreviews(null);
    setTraceVersion((v) => v + 1);
    setFps(0);
    setStageMs(ZERO_TIMINGS);
    busyTotals = [];
    setStageBusy([]);
    setMotionBackend(null);
    setError(null);
    cells?.reset(-1);
  }

  /** Start (or restart) the pipeline from frame 0. */
  async function start(): Promise<void> {
    reset();
    const gen = generation;
    setStatus('starting');
    const session = nextSession++;
    cells?.reset(session);
    compress?.reset(session);
    try {
      const p = await client.startPipeline(options, {
        session,
        discover: discover(),
        qc,
        ...(compress ? { compress: true } : {}),
      });
      if (gen !== generation) return;
      setPlan(p);
      setStatus('running');
      pump();
    } catch (err) {
      if (gen !== generation) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  function pause(): void {
    if (status() === 'running') setStatus('paused');
  }

  function resume(): void {
    if (status() !== 'paused') return;
    // Answers to steps sent before the pause still arrive and count.
    setStatus('running');
    pump();
  }

  /** Stop and free the worker-side pipeline (e.g. before opening another folder). */
  function stop(): void {
    const wasActive = status() !== 'idle';
    reset();
    setStatus('idle');
    if (wasActive) void client.stopPipeline().catch(() => {});
  }

  /** Turn cell discovery on or off (applies to the running pipeline at once). */
  function setDiscover(on: boolean): void {
    setDiscoverSignal(on);
    void client.setDiscovery?.(on).catch(() => {});
  }

  return {
    status,
    discover,
    setDiscover,
    plan,
    setup,
    processed,
    previews,
    fps,
    stageMs,
    stageBusy,
    motionBackend,
    error,
    /** Changes whenever `trace()` gained frames. */
    traceVersion,
    trace: () => trace,
    /** Steps currently requested from the worker (for tests). */
    inFlight: () => inFlight,
    start,
    pause,
    resume,
    togglePause: () => (status() === 'running' ? pause() : resume()),
    stop,
  };
}

export type PipelineStore = ReturnType<typeof createPipelineStore>;
