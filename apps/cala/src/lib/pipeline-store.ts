/**
 * Main-thread state of the live preprocess + motion pipeline.
 *
 * Backpressure: at most `MAX_IN_FLIGHT` step requests are outstanding. The
 * worker runs one step per request, so it never gets more than one batch
 * ahead of the UI, and only the latest previews are kept (a slow renderer
 * drops frames instead of queueing them). Pausing simply stops requesting.
 */
import { createSignal, untrack } from 'solid-js';
import type { PaceStats } from './frame-pacer.ts';
import { MaxFpsEstimator, WorkRater, type WorkRates } from './work-meter.ts';
import type { CellStore } from './cell-store.ts';
import type { CompressStore } from './compress-store.ts';
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
import { PlaybackScheduler, playbackWanted } from './playback.ts';
import { framePreviewImage, type FrameView } from './preview.ts';
import { RunRecord } from './run-record.ts';
import { BoundaryMonitor, severityLabel, type BoundaryFlag } from './boundary-flags.ts';
import type { SessionStart } from './session-boundary.ts';
import type { RunHistory } from './run-history.ts';
import type { LookbackFeed } from './lookback-client.ts';
import { CSETTLE, csettleRate } from './settle.ts';

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

/**
 * Live points kept for measurement scripts (`?debug`): the newest
 * `MAX_LIVE_POINTS` batches, oldest dropped first. The History view does not
 * use them; it reads the bounded `RunHistory` store, which covers the whole run.
 */
const MAX_LIVE_POINTS = 8192;

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
    /** A live stream (its maps are neither read from nor written to the cache). */
    live?: boolean;
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
  /** The run's history over stream time (the History view, the export). */
  runHistory?: RunHistory,
  /** Feed the compress worker; its store is reset with each run. */
  compress?: Pick<CompressStore, 'reset'>,
  /** Look-back (experimental): the look-back worker's feed (absent: look-back is not offered). */
  lookbackFeed?: LookbackFeed,
) {
  const [status, setStatus] = createSignal<PipelineStatus>('idle');
  const [plan, setPlan] = createSignal<PipelinePlan | null>(null);
  const [setup, setSetup] = createSignal<SetupProgress | null>(null);
  const [processed, setProcessed] = createSignal(0);
  const [previews, setPreviews] = createSignal<BatchPreviews | null>(null);
  const [fps, setFps] = createSignal(0);
  // ---- Smooth playback (`lib/playback.ts`) ----
  // With a preview of every frame of a batch (asked from the worker only for the view being shown,
  // and only at modest processing rates), the displayed frame advances evenly instead of in batch
  // jumps. `previews()`, and so the FOV's frame readout, follow the DISPLAYED frame; the cell
  // overlay and the trace cursor follow the processed one (`cells.frame()`), about a batch ahead.
  interface PlayedFrame {
    batch: BatchPreviews;
    index: number;
  }
  const playback = new PlaybackScheduler<PlayedFrame>();
  let smoothOn = true;
  /** The view the FOV shows, if it can be played (raw, preprocessed, corrected or output). */
  let playView: FrameView | null = null;
  /** The view the worker was last asked to preview for every frame. */
  let framesAsked: FrameView | null = null;
  let rafId: number | null = null;
  let displayLogOn = false;
  let displayLog: { t: number; frame: number }[] = [];
  const hasRaf = typeof requestAnimationFrame === 'function';
  /** Mean wall time per processed frame and stage, ms. */
  const [stageMs, setStageMs] = createSignal<StageTimings>(ZERO_TIMINGS);
  /** Mean busy time per processed frame of each pipeline stage (A, B, C), ms; empty unless pipelined. */
  const [stageBusy, setStageBusy] = createSignal<number[]>([]);
  /** Where motion correction runs (`null` before the first batch or on the single-worker path). */
  const [motionBackend, setMotionBackend] = createSignal<MotionBackend | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** Cell discovery (the slow loop) on or off. */
  const [discover, setDiscoverSignal] = createSignal(true);
  const [residual, setResidualSignal] = createSignal(false);
  /** Look-back on for the next Discover start (the setting), and on in the current run. */
  const [lookback, setLookback] = createSignal(false);
  const [lookbackRun, setLookbackRun] = createSignal(false);
  /**
   * Settle during Discover (experimental, under look-back; the setting for
   * the next Discover start): on or off, its ceiling in re-read frames per
   * live frame, and the frames per piece of an answer (0: whole answers; a
   * URL-only knob).
   */
  const [csettle, setCsettle] = createSignal(false);
  const [csettleCeiling, setCsettleCeiling] = createSignal<number>(CSETTLE.rate);
  const [csettleYield, setCsettleYield] = createSignal(0);
  /** Session of the current run with look-back (0: none). */
  let lookbackSession = 0;
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
        if (lookbackSession) lookbackFeed?.flatField(lookbackSession, e.map);
        if (e.change) runHistory?.flatMap(e.change.median);
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

  /** Frames processed this run (the denominator of the per-frame timing means). */
  let framesDone = 0;
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
    runHistory?.log({
      frame: applied.frame,
      kind: 'flatfield',
      detail: applied.first ? 'Flat field on' : `Flat-field map ${applied.seq}`,
      // The switch from uncorrected frames is what a replay must know.
      replay: applied.first,
      data: { seq: applied.seq, source: applied.source, first: applied.first },
    });
    if (applied.first) patchFlat({ firstFrame: applied.frame });
  }

  /** Discover of a Joint run: the session-boundary health flags (`boundary-flags.ts`). */
  let boundaryMonitor: BoundaryMonitor | null = null;
  const [boundaryFlags, setBoundaryFlags] = createSignal<BoundaryFlag[]>([]);
  /** What History was last told about each boundary (severity, pending), by session index. */
  let boundaryLogged = new Map<number, string>();
  cells?.onStatus((st) => {
    if (!boundaryMonitor) return;
    boundaryMonitor.onAdds(st.frame, st.counters.adds);
    refreshBoundaryFlags();
  });

  /**
   * Re-judge the boundaries when something they wait for arrived (a session
   * start, a window that finished playing, the end of Discover), publish the
   * flags and log each change of verdict in History.
   */
  function refreshBoundaryFlags(force = false): void {
    const m = boundaryMonitor;
    if (!m || (!force && !m.changed())) return;
    const flags = m.flags();
    setBoundaryFlags(flags);
    for (const f of flags) {
      const key = `${f.severity}/${f.pending}`;
      if (boundaryLogged.get(f.index) === key) continue;
      boundaryLogged.set(f.index, key);
      runHistory?.log({
        frame: f.frame,
        kind: f.severity === 'ok' ? 'setting' : 'warning',
        key: 'boundary check',
        to: f.severity,
        detail: `Session ${f.index + 1} boundary: ${severityLabel(f.severity, f.pending).replace(/^Boundary /, '')}. ${f.reason}${f.suggestion ? ` ${f.suggestion}` : ''}`,
        replay: false,
        data: { session: f.index, severity: f.severity, pending: f.pending },
      });
    }
  }

  /** A session of a Joint run started: record its re-registration (Refine and Extract replay it) and log it. */
  function noteSessionStart(st: SessionStart): void {
    record.noteSession(st.index, st.transform);
    const [rot, dy, dx] = st.transform;
    const moved =
      rot === 0 && dy === 0 && dx === 0
        ? 'no re-registration'
        : `re-registered ${rot.toFixed(2)}°, (${dy.toFixed(1)}, ${dx.toFixed(1)}) px`;
    // App.tsx logs the boundary itself (a 'session' event); this is what the stages did there.
    runHistory?.log({
      frame: st.frame,
      kind: 'setting',
      key: 'session boundary',
      to: st.index,
      detail: `Session ${st.index + 1} start: ${moved}; background floor ×${st.floorGain.toFixed(3)}, noise ×${st.noiseRatio.toFixed(3)}`,
      data: {
        rotation: rot,
        dy,
        dx,
        floorGain: st.floorGain,
        floorOffset: st.floorOffset,
        noiseRatio: st.noiseRatio,
      },
    });
  }

  function handle(step: PipelineStepResult): void {
    switch (step.kind) {
      case 'setup':
        setSetup({ phase: step.phase, done: step.done, total: step.total });
        return;
      case 'batch': {
        if (step.flatField) noteFlatFieldApplied(step.flatField);
        if (step.session) noteSessionStart(step.session);
        if (boundaryMonitor) {
          const m = boundaryMonitor;
          if (step.session) m.onSessionStart(step.session);
          if (step.boundaryNull !== undefined) m.onNull(step.start + step.count, step.boundaryNull);
          if (step.imaging)
            m.onImaging(step.imaging.frame, step.imaging.noiseSigma, step.imaging.background);
          if (step.cells) m.onTraces(step.start, step.count, step.cells.ids, step.cells.traces);
          refreshBoundaryFlags();
        }
        const wasComplete = record.complete;
        record.push(step.start, step.dy, step.dx, step.flags, step.flickerOffset, step.flickerGain);
        if (lookbackSession) {
          lookbackFeed?.rows(
            lookbackSession,
            step.start,
            step.dy,
            step.dx,
            step.flags,
            step.flickerOffset,
            step.flickerGain,
          );
          if (step.backState) lookbackFeed?.backState(lookbackSession, step.backState);
        }
        if (wasComplete && !record.complete)
          runHistory?.log({
            frame: step.start,
            kind: 'gap',
            detail: 'A batch arrived out of order: the run record is incomplete',
          });
        setProcessed(step.start + step.count);
        const rate = meter.record(clock(), step.count);
        offerPreviews(step.previews, rate);
        setFps(rate);
        const t = step.timings;
        framesDone += step.count;
        if (runHistory) {
          const end = step.start + step.count;
          const lag =
            step.cells && step.cells.discovering ? Math.max(0, end - step.cells.slowFrame) : null;
          const perFrame =
            (t.readMs + t.preprocessMs + t.motionMs + t.otherMs + t.traceMs) / step.count;
          runHistory.batch(step, rate, perFrame, lag);
        }
        if (step.cells && cells) cells.onBatch(step.start, step.count, step.cells, t);
        totals = {
          readMs: totals.readMs + t.readMs,
          preprocessMs: totals.preprocessMs + t.preprocessMs,
          motionMs: totals.motionMs + t.motionMs,
          otherMs: totals.otherMs + t.otherMs,
          traceMs: totals.traceMs + t.traceMs,
        };
        const n = framesDone;
        setMotionBackend(step.motionBackend ?? null);
        setMaxFps(
          maxFpsEstimator.record(
            step.count,
            step.stageBusyMs ?? [t.readMs + t.preprocessMs + t.motionMs + t.otherMs + t.traceMs],
          ),
        );
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
          livePoints.push(point);
          if (livePoints.length >= 2 * MAX_LIVE_POINTS)
            livePoints.splice(0, livePoints.length - MAX_LIVE_POINTS);
          runHistory?.liveCounters(point);
          setLive(point);
        }
        return;
      }
      case 'done':
        if (lookbackSession && step.backState)
          lookbackFeed?.backState(lookbackSession, step.backState);
        if (!exhausted) {
          exhausted = true;
          boundaryMonitor?.end();
          refreshBoundaryFlags(true);
          flushFlatField();
          setStatus('done');
        }
        return;
    }
  }

  /**
   * Smooth pacing (`?debug&pacefps=N` until a slider exists): read a recording
   * no faster than `N` frames a second, one batch per period, as a stream
   * would arrive (0: as fast as it goes). The gate itself runs in the frame
   * worker (`lib/frame-pacer.ts`); this only tells it the target and when we pause.
   */
  let paceFps = 0;
  /** A pace was set at some point: from then on Pause and Resume always tell the gate (so its held state never sticks). */
  let paceEver = false;
  /** Whether this run's gate is paced (a recording's Discover run; never a live stream). */
  function paceRun(): boolean {
    return paceFps > 0 && flat.identity?.()?.live !== true;
  }
  const [paceStats, setPaceStats] = createSignal<PaceStats | null>(null);
  /** The pipeline session whose pacing readouts count (-1: none); a stopped run's late ones are dropped. */
  let paceSession = -1;
  client.subscribePaceStats?.((s) => {
    if (s.session === paceSession) setPaceStats(s);
  });
  // Work shares (`lib/work-meter.ts`): the slow worker's accounting once a second, and the fast
  // loop's live estimate of its top speed. Instrumentation only: nothing here steers the run.
  const workRater = new WorkRater();
  const maxFpsEstimator = new MaxFpsEstimator();
  const [work, setWork] = createSignal<WorkRates | null>(null);
  const [maxFps, setMaxFps] = createSignal(0);
  /** The max estimate as of the last `work` reading (the readout rebuilds once a second, not per batch). */
  const [workMaxFps, setWorkMaxFps] = createSignal(0);
  cells?.onStatus((st) => {
    if (!st.accounting) return;
    const rates = workRater.push(st.accounting);
    if (!rates) return;
    const max = maxFpsEstimator.estimate();
    setWork(rates);
    setWorkMaxFps(max);
    // Not after Discover's last frame (stream time stands still; see `RunHistory.work`).
    if (untrack(status) !== 'done') runHistory?.work(rates, max);
  });
  function sendPace(pace: { fps?: number; paused?: boolean }): void {
    void client.setPace?.(pace).catch(() => {});
  }

  /** Show one played frame: its view's image, the batch's last-frame images for the other views. */
  function showPlayed(f: PlayedFrame): void {
    const fp = f.batch.frames!;
    setPreviews({
      ...f.batch,
      [fp.view]: framePreviewImage(fp, f.index),
      frame: fp.first + f.index,
    });
    if (displayLogOn) {
      displayLog.push({ t: clock(), frame: fp.first + f.index });
      if (displayLog.length > 20000) displayLog = displayLog.slice(-10000);
    }
  }

  function playbackLoop(t: number): void {
    rafId = null;
    const f = playback.tick(t);
    if (f) showPlayed(f);
    if (playback.queued > 0) rafId = requestAnimationFrame(playbackLoop);
  }

  function endPlayback(): void {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = null;
    playback.clear();
  }

  /** Ask the worker for per-frame previews of the shown view, or stop asking, by the processing rate. */
  function syncFramePreview(rate: number): void {
    const want =
      smoothOn &&
      hasRaf &&
      client.setFramePreview &&
      playView &&
      playbackWanted(rate, framesAsked !== null)
        ? playView
        : null;
    if (want === framesAsked) return;
    framesAsked = want;
    void client.setFramePreview?.(want).catch(() => {});
  }

  /** A batch's previews arrived: queue its frames for playback, or show its last frame at once. */
  function offerPreviews(p: BatchPreviews, rate: number): void {
    const fp = p.frames;
    if (fp && hasRaf && smoothOn && fp.view === playView) {
      const items = Array.from({ length: fp.count }, (_, index) => ({ batch: p, index }));
      if (status() === 'paused') {
        // Answers to steps sent before the pause: the newest frame, shown at once.
        playback.clear();
        showPlayed(items[items.length - 1]);
      } else {
        playback.setRate(paceRun() ? paceFps : rate > 0 ? rate * 1.05 : 30);
        playback.push(items);
        if (rafId === null) rafId = requestAnimationFrame(playbackLoop);
      }
    } else {
      endPlayback();
      setPreviews(p);
      if (displayLogOn) displayLog.push({ t: clock(), frame: p.frame });
    }
    syncFramePreview(rate);
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
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setStatus('error');
          runHistory?.log({ frame: processed(), kind: 'error', detail: message });
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
    framesDone = 0;
    if (lookbackSession) lookbackFeed?.reset(lookbackSession);
    lookbackSession = 0;
    setLookbackRun(false);
    record = new RunRecord();
    meter = new ThroughputMeter();
    totals = { ...ZERO_TIMINGS };
    setPaceStats(null);
    paceSession = -1;
    workRater.reset();
    maxFpsEstimator.reset();
    setWork(null);
    setMaxFps(0);
    setWorkMaxFps(0);
    setPlan(null);
    setSetup(null);
    setProcessed(0);
    endPlayback();
    framesAsked = null;
    displayLog = [];
    setPreviews(null);
    setFps(0);
    setStageMs(ZERO_TIMINGS);
    busyTotals = [];
    setStageBusy([]);
    setMotionBackend(null);
    setError(null);
    livePoints = [];
    setLive(null);
    boundaryMonitor = null;
    boundaryLogged = new Map();
    setBoundaryFlags([]);
    cells?.reset(-1);
  }

  /** Start (or restart) the pipeline from frame 0. */
  async function start(): Promise<void> {
    reset();
    const gen = generation;
    setStatus('starting');
    const session = nextSession++;
    paceSession = session;
    cells?.reset(session);
    compress?.reset(session);
    try {
      // Flat field: a stored map of this device (if any) is in force from the first processed frame.
      const useFlat = flatEnabled() && client.subscribeFlatField !== undefined;
      flatSessionId = session;
      flatKey = null;
      let seed: FlatFieldMap | undefined;
      const id = useFlat ? (flat.identity?.() ?? null) : null;
      // A live stream (including an auto-connected `?live=` one) neither reads nor writes
      // the cache: a stored map is never applied silently to a stream, and a stream
      // cannot overwrite a map cached for a file or device. It estimates fresh.
      if (id && !id.live) {
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
      // Look-back (experimental): from this start on, if the recording allows it.
      const lb = lookback() && discover() && lookbackFeed?.begin(session) === true;
      if (lb) {
        lookbackSession = session;
        setLookbackRun(true);
        if (flatLatest) lookbackFeed!.flatField(session, flatLatest);
      }
      const p = await client.startPipeline(
        { ...options, flatField: useFlat },
        {
          session,
          ...(lb ? { lookback: true } : {}),
          ...(lb && csettle()
            ? {
                csettle: csettleRate(csettleCeiling()),
                ...(csettleYield() > 0 ? { csettleYield: csettleYield() } : {}),
              }
            : {}),
          discover: discover(),
          qc,
          residual: residual(),
          ...(forwardBuffers ? { forwardBuffers } : {}),
          ...(compress ? { compress: true } : {}),
        },
        undefined,
        seed ? { seed } : undefined,
      );
      if (gen !== generation) return;
      setPlan(p);
      // Joint run with the session fix: judge each boundary (observers only).
      if (p.sessionFix && p.boundaries.length > 0)
        boundaryMonitor = new BoundaryMonitor({
          boundaries: p.boundaries,
          frames: p.frameCount,
          fps: cells?.fps() ?? 0,
        });
      runHistory?.reset({
        fps: cells?.fps() ?? 0,
        live: flat.identity?.()?.live === true,
        frameCount: p.frameCount,
      });
      setStatus('running');
      syncFramePreview(0);
      if (paceRun()) sendPace({ fps: paceFps });
      pump();
    } catch (err) {
      if (gen !== generation) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  function pause(): void {
    if (status() !== 'running') return;
    setStatus('paused');
    // The newest frame at once; the rest of the queue is dropped.
    const newest = playback.flush();
    if (newest) showPlayed(newest);
    // Requests already in the worker must not be released while paused.
    if (paceEver) sendPace({ paused: true });
    runHistory?.log({ frame: processed(), kind: 'pause', detail: 'Paused' });
  }

  function resume(): void {
    if (status() !== 'paused') return;
    // Answers to steps sent before the pause still arrive and count.
    setStatus('running');
    if (paceEver) sendPace({ paused: false });
    runHistory?.log({ frame: processed(), kind: 'resume', detail: 'Resumed' });
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

  /** Ask for the residual preview or stop (applies to the running pipeline at once). */
  function setResidual(on: boolean): void {
    if (on === residual()) return;
    setResidualSignal(on);
    void client.setResidual?.(on).catch(() => {});
  }

  /** Turn cell discovery on or off (applies to the running pipeline at once). */
  function setDiscover(on: boolean): void {
    if (on !== discover() && (status() === 'running' || status() === 'paused'))
      runHistory?.log({
        frame: processed(),
        kind: 'setting',
        key: 'discover',
        from: discover() ? 'on' : 'off',
        to: on ? 'on' : 'off',
        detail: `Discovery ${on ? 'on' : 'off'}`,
        replay: false,
      });
    setDiscoverSignal(on);
    void client.setDiscovery?.(on).catch(() => {});
  }

  return {
    status,
    discover,
    setDiscover,
    /** The residual preview is being produced (the residual view is shown). */
    residual,
    /**
     * Look-back (experimental): the setting for the next Discover start, why
     * the open recording cannot have it (null: it can), and whether the
     * current run has it.
     */
    lookback,
    setLookback,
    // (Not `??`: `blocked()` returns null when look-back can run.)
    lookbackBlocked: () =>
      lookbackFeed ? lookbackFeed.blocked() : 'Look-back is not available here.',
    lookbackRun,
    /** Settle during Discover (experimental; only with look-back): the settings for the next Discover start. */
    csettle,
    setCsettle,
    csettleCeiling,
    setCsettleCeiling: (rate: number) => setCsettleCeiling(csettleRate(rate)),
    /** The frame worker's pacing readouts (gate wait, lateness dropped, re-anchors); null when unpaced. */
    paceStats,
    /** Who is doing what, over the last second or so (the slow, visit and look-back workers); null until a second of data. */
    work,
    /** The fast loop's live estimate of its top speed, frames per second (0 until a batch has busy time). */
    maxFps,
    /** `maxFps` as of the last `work` reading, for the readout. */
    workMaxFps,
    /** Read no faster than this many frames a second (0: off); applies to a running recording at once. */
    setPaceFps: (fps: number) => {
      paceFps = Number.isFinite(fps) && fps > 0 ? fps : 0;
      if (paceFps > 0) paceEver = true;
      const st = status();
      // A run paused before a pace existed must start held.
      if (st === 'running' || st === 'paused') sendPace({ fps: paceFps, paused: st === 'paused' });
    },
    csettleYield,
    setCsettleYield: (frames: number) =>
      setCsettleYield(Number.isFinite(frames) && frames > 0 ? Math.floor(frames) : 0),
    setResidual,
    /**
     * The view the FOV shows (null: none, or one that is not a frame of the batch, like the residual):
     * per-frame previews are asked for this one.
     */
    setPlayView: (view: FrameView | null) => {
      playView = view;
      if (view === null || view !== framesAsked) endPlayback();
      syncFramePreview(meter.rate());
    },
    /** Smooth playback on or off (default on; `?debug&smooth=0` turns it off for comparison). */
    setSmoothPlayback: (on: boolean) => {
      smoothOn = on;
      if (!on) endPlayback();
      syncFramePreview(meter.rate());
    },
    /** Frames waiting for display, dropped by skipping ahead, and shown; the view being previewed (measurement). */
    playbackStats: () => ({
      queued: playback.queued,
      dropped: playback.dropped,
      shown: playback.shown,
      view: framesAsked,
    }),
    /** Record when each displayed frame changed (measurement; `?debug`). */
    setDisplayLog: (on: boolean) => {
      displayLogOn = on;
    },
    displayLog: () => displayLog,
    plan,
    setup,
    processed,
    previews,
    fps,
    stageMs,
    stageBusy,
    motionBackend,
    error,
    /** The live source's counters after the newest batch, and the newest batches' (measurement scripts). */
    live,
    livePoints: () => livePoints,
    /** The run's history over stream time (absent in tests that do not pass one). */
    runHistory: () => runHistory ?? null,
    /** The online sensor flat field: the setting (applies at the next start), status, and newest map. */
    flatEnabled,
    setFlatEnabled,
    flatField,
    flatFieldMap: () => flatLatest,
    /** Write the newest map to the per-device cache now (the run end does it too). */
    flushFlatField,
    /** What pass 1 recorded per frame (motion shifts and flicker) so far. */
    record: () => record,
    /** Joint: Discover's session-boundary health flags, one per boundary reached (`boundary-flags.ts`). */
    boundaryFlags,
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
