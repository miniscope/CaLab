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
import {
  flatFieldKey,
  initialFlatFieldState,
  type DeviceIdentity,
  type FlatFieldApplied,
  type FlatFieldEvent,
  type FlatFieldKey,
  type FlatFieldMap,
  type FlatFieldState,
} from './flat-field.ts';
import {
  mapFromRecord,
  recordFromMap,
  recordFits,
  type FlatFieldCache,
} from './flat-field-cache.ts';
import type { PipelineClient } from './frame-client.ts';
import type {
  BatchPreviews,
  LiveBatchInfo,
  MotionBackend,
  PipelineStepResult,
  StageTimings,
} from './pipeline-engine.ts';
import type { PipelineOptions, PipelinePhase, PipelinePlan } from './pipeline-plan.ts';
import { RunRecord } from './run-record.ts';

/** Step requests kept outstanding: one running, one queued so the worker never idles. */
export const MAX_IN_FLIGHT = 2;

export type PipelineStatus = 'idle' | 'starting' | 'running' | 'paused' | 'done' | 'error';

/** A live source's counters after one batch, against the frames processed and the time. */
export interface LivePoint extends LiveBatchInfo {
  /** Frames processed (the batch's end) and the fast loop's lag behind the stream, frames. */
  frame: number;
  lagFrames: number;
  t: number;
}

/** Live points kept (one per batch: 100k = 800k frames, 11 h at 20 fps). */
const MAX_LIVE_POINTS = 100_000;

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

/** What the pipeline store needs for the per-device flat-field cache. */
export interface FlatFieldStoreOptions {
  cache?: FlatFieldCache;
  /** What the open recording says about its sensor (null before one is open). */
  identity?: () => {
    width: number;
    height: number;
    device?: DeviceIdentity;
    liveName?: string;
    folder: string;
  } | null;
  /** Minimum time between cache writes, ms (default one minute; the run end always writes). */
  writeIntervalMs?: number;
  /** Wall clock, ms (tests). */
  now?: () => number;
}

/** Cache writes at most this often while a run goes on. */
const FLAT_FIELD_WRITE_INTERVAL_MS = 60_000;

/** Pipeline sessions, so late messages of a stopped run are told apart. */
let nextSession = 1;

export function createPipelineStore(
  client: PipelineClient,
  options: PipelineOptions = {},
  clock: () => number = () => performance.now(),
  cells?: CellStore,
  /** Online quality control in the fast loop (default on; off to measure its cost). */
  qc = true,
  /** Batches in flight to the slow worker (default: the fast loop's). */
  forwardBuffers?: number,
  /** The per-device flat-field cache and the recording's identity (optional). */
  flat: FlatFieldStoreOptions = {},
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
  /** The live source's counters after the newest batch (null on a file source). */
  const [live, setLive] = createSignal<LivePoint | null>(null);
  let livePoints: LivePoint[] = [];
  // Online sensor flat field: the setting, the estimator's status, the maps.
  const [flatEnabled, setFlatEnabledSignal] = createSignal(options.flatField !== false);
  const [flatField, setFlatField] = createSignal<FlatFieldState>({
    ...initialFlatFieldState(),
    supported: client.subscribeFlatField !== undefined,
  });
  const patchFlat = (p: Partial<FlatFieldState>): void => {
    setFlatField((s) => ({ ...s, ...p }));
  };
  /** The session whose estimator events count (0: none yet). */
  let flatSessionId = 0;
  let flatKey: FlatFieldKey | null = null;
  let flatDims = { width: 0, height: 0 };
  let flatLatest: FlatFieldMap | null = null;
  let flatDirty = false;
  let flatLastWrite = -Infinity;
  let flatTimer: ReturnType<typeof setTimeout> | null = null;
  const wallNow = flat.now ?? (() => Date.now());
  const writeInterval = flat.writeIntervalMs ?? FLAT_FIELD_WRITE_INTERVAL_MS;

  /** Write the newest map to the cache (never throws: the cache is an optimisation). */
  function flushFlatField(): void {
    if (flatTimer !== null) clearTimeout(flatTimer);
    flatTimer = null;
    if (!flatDirty || !flatLatest || !flatKey || !flat.cache) return;
    flatDirty = false;
    flatLastWrite = wallNow();
    void flat.cache
      .put(recordFromMap(flatKey, flatDims.width, flatDims.height, flatLatest, flatLastWrite))
      .catch(() => {});
  }

  function scheduleFlatWrite(): void {
    flatDirty = true;
    const wait = flatLastWrite + writeInterval - wallNow();
    if (wait <= 0) flushFlatField();
    else flatTimer ??= setTimeout(flushFlatField, wait);
  }

  function onFlatEvent(e: FlatFieldEvent): void {
    if (e.type === 'error') {
      // A crashed estimator (session -1) or this run's: reported, the run goes on uncorrected.
      if (e.session === -1 || e.session === flatSessionId) patchFlat({ error: e.message });
      return;
    }
    if (e.session !== flatSessionId) return;
    switch (e.type) {
      case 'progress':
        patchFlat({ frames: e.frames, fps: e.fps });
        return;
      case 'skipped':
        patchFlat({ skipped: e.message });
        return;
      case 'map':
        flatLatest = e.map;
        setFlatField((s) => ({
          ...s,
          map: e.map,
          updates: s.updates + 1,
          lastChange: e.change,
          skipped: null,
        }));
        scheduleFlatWrite();
        return;
    }
  }
  client.subscribeFlatField?.(onFlatEvent);

  let trace = new ShiftTrace();
  /** Pass 1's per-frame motion and flicker, kept in full for pass 2 and the export. */
  let record = new RunRecord();
  let meter = new ThroughputMeter();
  let totals: StageTimings = { ...ZERO_TIMINGS };
  let busyTotals: number[] = [];
  let inFlight = 0;
  let exhausted = false;
  let generation = 0; // bumps on start/stop, so late answers are dropped

  /** A flat-field map took effect at a batch boundary: keep the frame in the run record. */
  function noteFlatFieldApplied(applied: FlatFieldApplied): void {
    record.noteFlatField(applied);
    if (applied.first) patchFlat({ firstFrame: applied.frame });
  }

  function handle(step: PipelineStepResult): void {
    switch (step.kind) {
      case 'setup':
        setSetup({ phase: step.phase, done: step.done, total: step.total });
        return;
      case 'batch': {
        if (step.flatField) noteFlatFieldApplied(step.flatField);
        trace.push(step.start, step.dy, step.dx, step.flickerOffset, step.flickerGain);
        record.push(step.start, step.dy, step.dx, step.flags, step.flickerOffset, step.flickerGain);
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
        if (step.live) {
          const end = step.start + step.count;
          const point: LivePoint = {
            ...step.live,
            frame: end,
            lagFrames: Math.max(0, step.live.received - step.live.dropped - end),
            t: clock(),
          };
          if (livePoints.length < MAX_LIVE_POINTS) livePoints.push(point);
          setLive(point);
        }
        return;
      }
      case 'done':
        if (!exhausted) {
          exhausted = true;
          flushFlatField();
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
    flushFlatField();
    flatSessionId = 0;
    flatLatest = null;
    flatDirty = false;
    setFlatField((s) => ({
      ...initialFlatFieldState(),
      supported: s.supported,
      enabled: flatEnabled(),
    }));
    generation++;
    inFlight = 0;
    exhausted = false;
    trace = new ShiftTrace();
    record = new RunRecord();
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
    livePoints = [];
    setLive(null);
    cells?.reset(-1);
  }

  /** Start (or restart) the pipeline from frame 0. */
  async function start(): Promise<void> {
    reset();
    const gen = generation;
    setStatus('starting');
    const session = nextSession++;
    cells?.reset(session);
    try {
      // Flat field: a stored map of this device (if any) is in force from the first processed frame.
      const useFlat = flatEnabled() && client.subscribeFlatField !== undefined;
      flatSessionId = session;
      flatKey = null;
      let seed: FlatFieldMap | undefined;
      const id = useFlat ? (flat.identity?.() ?? null) : null;
      if (id) {
        flatKey = flatFieldKey(id);
        flatDims = { width: id.width, height: id.height };
        const rec = flat.cache ? await flat.cache.get(flatKey.key, id.width, id.height) : null;
        if (gen !== generation) return;
        if (recordFits(rec, id.width, id.height) && rec) seed = mapFromRecord(rec);
      }
      flatLatest = seed ?? null;
      patchFlat({
        enabled: flatEnabled(),
        key: flatKey,
        reused: seed !== undefined,
        map: seed ?? null,
      });
      const p = await client.startPipeline(
        { ...options, flatField: useFlat },
        {
          session,
          discover: discover(),
          qc,
          ...(forwardBuffers ? { forwardBuffers } : {}),
        },
        undefined,
        seed ? { seed } : undefined,
      );
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

  /**
   * End pass 1 at the frames processed so far (the rest of the recording is not
   * read): the slow loop publishes its final library and the run reports done.
   */
  async function finishEarly(): Promise<void> {
    const st = status();
    if (st !== 'running' && st !== 'paused') return;
    const gen = generation;
    try {
      await client.truncatePipeline?.();
    } catch (err) {
      if (gen !== generation) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
      return;
    }
    if (gen !== generation) return;
    if (status() === 'paused') setStatus('running');
    pump();
  }

  /** Turn the online flat field on or off (takes effect at the next start of pass 1). */
  function setFlatEnabled(on: boolean): void {
    setFlatEnabledSignal(on);
    // Not mid-run: the run keeps what it started with. The panel says so.
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
    /** The live source's counters after the newest batch, and all of them this run. */
    live,
    livePoints: () => livePoints,
    /** Changes whenever `trace()` gained frames. */
    traceVersion,
    trace: () => trace,
    /** The online sensor flat field: the setting (applies at the next start), status, and newest map. */
    flatEnabled,
    setFlatEnabled,
    flatField,
    flatFieldMap: () => flatLatest,
    /** Write the newest map to the per-device cache now (the run end does it too). */
    flushFlatField,
    /** What pass 1 recorded per frame (motion shifts and flicker) so far. */
    record: () => record,
    finishEarly,
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
