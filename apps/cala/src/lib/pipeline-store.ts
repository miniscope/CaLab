/**
 * Main-thread state of the live preprocess + motion pipeline.
 *
 * Backpressure: at most `MAX_IN_FLIGHT` step requests are outstanding. The
 * worker runs one step per request, so it never gets more than one batch
 * ahead of the UI, and only the latest previews are kept (a slow renderer
 * drops frames instead of queueing them). Pausing simply stops requesting.
 */
import { createSignal } from 'solid-js';
import type { PipelineClient } from './frame-client.ts';
import type { BatchPreviews, PipelineStepResult, StageTimings } from './pipeline-engine.ts';
import type { PipelineOptions, PipelinePhase, PipelinePlan } from './pipeline-plan.ts';

/** Step requests kept outstanding: one running, one queued so the worker never idles. */
export const MAX_IN_FLIGHT = 2;

export type PipelineStatus = 'idle' | 'starting' | 'running' | 'paused' | 'done' | 'error';

/** Rigid shifts per processed frame, appended batch by batch. */
export class ShiftTrace {
  readonly frame: number[] = [];
  readonly dy: number[] = [];
  readonly dx: number[] = [];

  push(start: number, dy: ArrayLike<number>, dx: ArrayLike<number>): void {
    for (let i = 0; i < dy.length; i++) {
      this.frame.push(start + i);
      this.dy.push(dy[i]);
      this.dx.push(dx[i]);
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

const ZERO_TIMINGS: StageTimings = { readMs: 0, preprocessMs: 0, motionMs: 0, otherMs: 0 };

export function createPipelineStore(
  client: PipelineClient,
  options: PipelineOptions = {},
  clock: () => number = () => performance.now(),
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
  const [error, setError] = createSignal<string | null>(null);

  let trace = new ShiftTrace();
  let meter = new ThroughputMeter();
  let totals: StageTimings = { ...ZERO_TIMINGS };
  let inFlight = 0;
  let exhausted = false;
  let generation = 0; // bumps on start/stop, so late answers are dropped

  function handle(step: PipelineStepResult): void {
    switch (step.kind) {
      case 'setup':
        setSetup({ phase: step.phase, done: step.done, total: step.total });
        return;
      case 'batch': {
        trace.push(step.start, step.dy, step.dx);
        setTraceVersion((v) => v + 1);
        setPreviews(step.previews);
        setProcessed(step.start + step.count);
        setFps(meter.record(clock(), step.count));
        const t = step.timings;
        totals = {
          readMs: totals.readMs + t.readMs,
          preprocessMs: totals.preprocessMs + t.preprocessMs,
          motionMs: totals.motionMs + t.motionMs,
          otherMs: totals.otherMs + t.otherMs,
        };
        const n = trace.length;
        setStageMs({
          readMs: totals.readMs / n,
          preprocessMs: totals.preprocessMs / n,
          motionMs: totals.motionMs / n,
          otherMs: totals.otherMs / n,
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
    while (status() === 'running' && !exhausted && inFlight < MAX_IN_FLIGHT) {
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
    setError(null);
  }

  /** Start (or restart) the pipeline from frame 0. */
  async function start(): Promise<void> {
    reset();
    const gen = generation;
    setStatus('starting');
    try {
      const p = await client.startPipeline(options);
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

  return {
    status,
    plan,
    setup,
    processed,
    previews,
    fps,
    stageMs,
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
