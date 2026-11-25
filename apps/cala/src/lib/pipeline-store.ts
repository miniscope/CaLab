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
import {
  BirthRate,
  MaxFpsEstimator,
  StageBusyMeter,
  WorkRater,
  type WorkRates,
  type WorkStatus,
} from './work-meter.ts';
import type { CellStore } from './cell-store.ts';
import type { CompressStore } from './compress-store.ts';
import { FACTORS_FILE_JOINT, factorRunPlan } from './factor-run.ts';
import { poolForRun, type PoolWidth } from './compress-pool.ts';
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
import type { CurveRecord, WorkSample } from './run-provenance.ts';
import {
  limitPoints,
  normalizeCurve,
  sanitizeCurve,
  SpeedDriver,
  type TargetPolicy,
  SpeedSchedule,
  type PolicyInput,
  type SpeedCurve,
} from './speed-schedule.ts';
import { AutoPolicy, PauseClock, type AutoDecision } from './speed-auto.ts';
import type { LookbackFeed } from './lookback-client.ts';
import type { FactorSource } from '../workers/lookback-types.ts';
import {
  CSETTLE,
  csettleRate,
  FINAL_SETTLE_LEVEL_DEFAULT,
  FINAL_SETTLE_LEVELS,
  finalSettleLevel,
  SETTLE,
} from './settle.ts';
import { FloorMeter, NEED_RATE, floorText, type FloorDisplay } from './speed-floor.ts';
import {
  VISIT_RATE,
  VisitRateGovernor,
  effectivePace,
  heldMaxFps,
  visitRateCap,
  visitRateMode,
  type VisitRateMode,
  type VisitRateSummary,
} from './visit-rate.ts';

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
    /** Frames in the recording (a speed curve is a share of them); absent for a stream. */
    frames?: number;
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
  /** Frames are queued for playback: the displayed frame lags the processed one. */
  const [playing, setPlaying] = createSignal(false);
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
  /**
   * Look-back (and its Final settle) on for the next Discover start (the setting), and on in the
   * current run. On by default for recordings: it is how footprints converge now that there is no
   * Refine stage. A live stream or a source that cannot be re-read has none (`lookbackBlocked`).
   */
  const [lookback, setLookback] = createSignal(true);
  const [lookbackRun, setLookbackRun] = createSignal(false);
  const [factors, setFactors] = createSignal(false);
  const [factorRun, setFactorRun] = createSignal(false);
  const [factorsFile, setFactorsFile] = createSignal(false);
  const [factorFileRun, setFactorFileRun] = createSignal(false);
  const [gpuFactorRun, setGpuFactorRun] = createSignal(false);
  // A recording's factor file run compresses on the GPU (the default, `?factors=gpu`).
  const [factorsGpu, setFactorsGpu] = createSignal(false);
  // A stream is a factor run without a switch (`factorsFromPage`); `?compress` asked on the page
  // (by default: a compress store was given); the current run compresses.
  const [factorsDefault, setFactorsDefault] = createSignal(false);
  const [compressAsked, setCompressAsked] = createSignal(compress !== undefined);
  const [compressRun, setCompressRun] = createSignal(false);
  // The page's compress pool widths (`compressPoolSize`), and the current run's (`poolForRun`).
  const [compressPool, setCompressPool] = createSignal<PoolWidth | null>(null);
  const [runPool, setRunPool] = createSignal<PoolWidth | null>(null);
  // `?debug&cbacklog=GB`: the cap on window files waiting for compression (measurement).
  let backlogCap: number | undefined;
  // `?debug&fextract=0`: Extract on factors on rebuilt frames, as before slice 6 (measurement).
  let frameExtract = false;
  // `?debug&gpucheck=N`: a GPU run's first N windows are compressed on the CPU too (measurement).
  let gpuCheck = 0;
  // `?debug&lbpoolmax`: the settle pool starts at Max too (measurement: the pooled Final settle at Max).
  let poolAtMax = false;
  let jointOf: () => boolean = () => false;
  /**
   * Settle during Discover ("Background settle", under look-back; runs only
   * while the target is below Max, at the settle governor's rate): on (the
   * default) or off, its cap in re-read frames per live frame (both take
   * effect during a run too: the cap is 0 when off), and the frames per piece
   * of an answer (0: whole answers; a URL-only knob, for the next start).
   */
  const [csettle, setCsettleSignal] = createSignal(true);
  const [csettleCeiling, setCsettleCeilingSignal] = createSignal<number>(CSETTLE.rate);
  const [csettleYield, setCsettleYield] = createSignal(0);
  /** One look-back worker: need-driven look-back first (`?debug&needfirst`; measurement only, next start). */
  const [csettleNeedFirst, setCsettleNeedFirst] = createSignal(false);
  /** The settle's cap now (0 = Off). */
  function settleCap(): number {
    return untrack(csettle) ? csettleRate(untrack(csettleCeiling)) : 0;
  }
  /** Final settle level (under look-back; the setting for the next Discover start). */
  const [finalSettleLevelSig, setFinalSettleLevelSig] = createSignal(FINAL_SETTLE_LEVEL_DEFAULT);
  /** The Final settle level the current run started with (null: no run yet), so the run record names what ran. */
  let runLevel: ReturnType<typeof finalSettleLevel> | null = null;
  /** Session of the current run with look-back (0: none). */
  let lookbackSession = 0;
  /**
   * What the end settle waits for (`LookbackFeed.final`): Discover's last
   * back state sent (`back`), and the flat field's last map (`flat`: its
   * estimator finished, failed, or does not run this session).
   */
  let finalInputs = { back: false, flat: false, sent: false };
  function noteFinalInputs(p: Partial<typeof finalInputs>): void {
    finalInputs = { ...finalInputs, ...p };
    if (!lookbackSession || finalInputs.sent || !finalInputs.back || !finalInputs.flat) return;
    finalInputs.sent = true;
    lookbackFeed?.final?.(lookbackSession);
  }
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
      if (e.session === -1 || e.session === flatSessionId) {
        patchFlat({ error: e.message });
        // No map of this run comes any more.
        noteFinalInputs({ flat: true });
      }
      return;
    }
    if (e.session !== flatSessionId) return;
    switch (e.type) {
      case 'finished':
        noteFinalInputs({ flat: true });
        return;
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

  /** A session of a Joint run started: record its re-registration (look-back and Extract replay it) and log it. */
  function noteSessionStart(st: SessionStart): void {
    record.noteSession(st.index, st.transform);
    // Look-back warps the session's frames by it too (before this batch's rows reach it).
    if (lookbackSession) lookbackFeed?.session?.(lookbackSession, st.index, st.transform);
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
        driveCurve(step.start + step.count);
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
        if (step.cells) forwardDrops = step.cells.droppedFrames;
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
        if (step.stageBusyMs) stageBusyMeter.record(step.stageBusyMs);
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
        noteFinalInputs({ back: true });
        curveDriver = null;
        if (!exhausted) {
          exhausted = true;
          endVisitHold();
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
  /** `paceFps` as a signal (the Speed control reads it; 0: Max). */
  const [paceTarget, setPaceTarget] = createSignal(0);
  /** The current target came from the URL (`?debug&pacefps`, source `url`): the Speed control must not override it. */
  const [paceFromUrl, setPaceFromUrl] = createSignal(false);
  /**
   * The Discover visit rate (`lib/visit-rate.ts`): off only with `?debug&visitrate=off` (the
   * behaviour before). The governor of this run (null: none yet, or not a Discover run) and its
   * hold: the speed the frame loop is held to so the visits keep up (null: not held).
   */
  const [visitRateOff, setVisitRateOff] = createSignal(false);
  /**
   * The Final settle's visit rate, visits per settle frame (`SETTLE.visitRate`; 0: none, visits
   * whenever a visit worker is free, as before): `?debug&settlevisits=` sets it (measurement).
   */
  let settleVisits: number = SETTLE.visitRate;
  let visitGov: VisitRateGovernor | null = null;
  const [visitHold, setVisitHold] = createSignal<number | null>(null);
  const [visitAchieved, setVisitAchieved] = createSignal<number | null>(null);
  const [visitMode, setVisitMode] = createSignal<VisitRateMode | null>(null);
  const visitListeners: ((s: VisitRateSummary) => void)[] = [];
  function tellVisitRate(): void {
    if (!visitGov) return;
    const s = visitGov.summary();
    for (const cb of visitListeners) {
      try {
        cb(s);
      } catch {
        // Observers only.
      }
    }
  }
  /** Discover read its last frame (or was ended): the hold ends; the record keeps the summary. */
  function endVisitHold(): void {
    if (!visitGov) return;
    tellVisitRate();
    const before = gatePace();
    visitGov.release();
    setVisitHold(null);
    // The gate goes back to the user's pace (the next run's start resets it anyway).
    if (gatePace() !== before) sendPace({ fps: gatePace() });
  }
  /** The pace the frame gate gets: the user's target and the visit hold, whichever is lower (0: Max). */
  function gatePace(): number {
    return effectivePace(paceRun() ? paceFps : 0, untrack(visitHold));
  }
  const paceListeners: ((fps: number, frame: number, source: string) => void)[] = [];
  const capListeners: ((cap: number, frame: number, source: string) => void)[] = [];
  /** Told about the work and the floor about once a second (the run record's log). */
  const workSampleListeners: ((s: WorkSample) => void)[] = [];
  /** Frames the fast loop did not forward to the slow loop, as of the last batch (this run). */
  let forwardDrops: number | null = null;
  /** Told when a run's settle pool starts (its workers, the frame reached); the run record's log. */
  const poolListeners: ((workers: number, frame: number, forFinal: boolean) => void)[] = [];
  /**
   * The speed curve chosen in the Speed control (Curve mode), as set; `normalize` is false for a
   * replayed record's curve, which must run exactly as recorded.
   */
  const [activeCurve, setActiveCurve] = createSignal<{
    curve: SpeedCurve;
    preset: string;
    normalize: boolean;
  } | null>(null);
  /** The Auto budget chosen in the Speed control (null: Auto is not the mode): extra time over a Max run, as a share. */
  const [activeAuto, setActiveAuto] = createSignal<number | null>(null);
  /** The Auto policy of this run (kept after the run for the record; null: not an Auto run). */
  let autoPolicy: AutoPolicy | null = null;
  /** The run's time without its pauses (the budget's clock). */
  const pauseClock = new PauseClock();
  /** Told when Auto arms and after each decision (the run record keeps its own copy). */
  const autoListeners: ((a: { extraTimeShare: number; decisions: AutoDecision[] }) => void)[] = [];
  const autoSnapshot = () =>
    autoPolicy
      ? { extraTimeShare: autoPolicy.share, decisions: autoPolicy.decisions.map((d) => ({ ...d })) }
      : null;
  function tellAuto(): void {
    const a = autoSnapshot();
    if (!a) return;
    for (const cb of autoListeners) {
      try {
        cb(a);
      } catch {
        // Observers only.
      }
    }
  }
  /** What follows a curve over this run (null: none); stopped when Discover ends. */
  let curveDriver: SpeedDriver | null = null;
  /** The curve this run was armed with, for the run record. */
  let runCurve: CurveRecord | null = null;
  const curveListeners: ((c: CurveRecord) => void)[] = [];
  /** Frames in the recording a curve is a share of (0: none, e.g. a stream). */
  function curveFrames(): number {
    const id = flat.identity?.();
    return id && id.live !== true && id.frames !== undefined && Number.isFinite(id.frames)
      ? id.frames
      : 0;
  }
  function policyInput(frame: number): PolicyInput {
    const f = untrack(floor);
    return {
      frame,
      totalFrames: curveFrames(),
      floorFps: f.fps,
      seeAllFps: f.estimate.seeAllFps,
      maxFps: runMaxFps() || null,
      wallS: pauseClock.now(clock()) / 1000,
    };
  }
  /** The curve the run follows as merged by the minimum-step rule, and how many steps that merged. */
  const [armedCurve, setArmedCurve] = createSignal<{ curve: SpeedCurve; merged: number } | null>(
    null,
  );
  /**
   * Take over the target with a policy from `frame` on. Any `TargetPolicy` fits (a curve now, Auto
   * later); `record` is what the run record keeps of it (null: nothing to record).
   */
  function armPolicy(policy: TargetPolicy, frame: number, record: CurveRecord | null): void {
    curveDriver = new SpeedDriver(policy);
    runCurve = record;
    if (record) {
      for (const cb of curveListeners) {
        try {
          cb(record);
        } catch {
          // Observers only.
        }
      }
    }
    driveCurve(frame);
  }
  /** Take over the target with the curve from `frame` on (at the run's start, or when chosen mid-run). */
  function armCurve(frame: number): void {
    curveDriver = null;
    runCurve = null;
    autoPolicy = null;
    setArmedCurve(null);
    const a = untrack(activeCurve);
    const total = curveFrames();
    const share = untrack(activeAuto);
    if (share !== null) {
      if (lookbackFeed && lookbackFeed.blocked() !== null) return;
      // Without a frame count the policy holds Max (never a stale Fixed target).
      autoPolicy = new AutoPolicy(share);
      tellAuto();
      armPolicy(autoPolicy, frame, null);
      return;
    }
    if (!a || (lookbackFeed && lookbackFeed.blocked() !== null)) return;
    if (total <= 0) {
      // No frame count: a curve cannot be a share of it. Max, not a stale Fixed target.
      if (paceFps > 0 && !untrack(paceFromUrl)) setPace(0, 'curve');
      return;
    }
    const live = policyInput(frame);
    const norm = a.normalize
      ? normalizeCurve(a.curve, {
          totalFrames: total,
          cap: settleCap(),
          floorFps: live.floorFps,
          seeAllFps: live.seeAllFps,
          maxFps: live.maxFps,
        })
      : { curve: a.curve, merged: 0 };
    const eff = norm.curve;
    setArmedCurve({ curve: eff, merged: norm.merged });
    armPolicy(new SpeedSchedule(eff), frame, {
      preset: a.preset,
      points: a.curve.points.map((p) => ({ ...p })),
      effective_points: eff.points.map((p) => ({ ...p })),
      armed_at_frame: frame,
    });
  }
  /** One look at the curve: a step boundary, or a floor that moved, may change the target. */
  function driveCurve(frame: number): void {
    if (!curveDriver) return;
    const before = autoPolicy?.decisions.length ?? 0;
    const change = curveDriver.tick(policyInput(frame));
    if (change) setPace(change.fps, change.source);
    if (autoPolicy && autoPolicy.decisions.length !== before) tellAuto();
  }
  /** The look-back session whose pool start was told (once per run). */
  let poolNoted = 0;
  /** A pace was set at some point: from then on Pause and Resume always tell the gate (so its held state never sticks). */
  let paceEver = false;
  /** Whether this run's gate is paced (a recording's Discover run; never a live stream). */
  function paceRun(): boolean {
    return paceFps > 0 && flat.identity?.()?.live !== true;
  }
  const [paceStats, setPaceStats] = createSignal<PaceStats | null>(null);
  /**
   * The pipeline session whose pacing readouts count (-1: none), and the newest gate run seen for
   * it: a stopped run keeps its last readout (the worker's flush on stop) until the next start.
   */
  let paceSession = -1;
  let paceEpoch = -1;
  client.subscribePaceStats?.((s) => {
    if (s.session !== paceSession || s.epoch < paceEpoch) return;
    paceEpoch = s.epoch;
    setPaceStats(s);
  });
  // Work shares (`lib/work-meter.ts`): the slow worker's accounting once a second, and the fast
  // loop's live estimate of its top speed. Instrumentation only: nothing here steers the run.
  const workRater = new WorkRater();
  const maxFpsEstimator = new MaxFpsEstimator();
  /**
   * The top speed the run can reach, fps (0: not known): the fast loop's estimate, lowered to what
   * the visits allow while the visit rate holds the run (`heldMaxFps`). What the Speed block calls
   * Max, the floor clamps to, curves and Auto plan with and the run record's Max median counts.
   */
  function runMaxFps(): number {
    return heldMaxFps(maxFpsEstimator.estimate(), visitGov?.visitMaxFps ?? null);
  }
  const stageBusyMeter = new StageBusyMeter();
  const birthRate = new BirthRate();
  const [work, setWork] = createSignal<WorkRates | null>(null);
  const [maxFps, setMaxFps] = createSignal(0);
  /**
   * The run's top speed (`runMaxFps`) as of the last `work` reading (the readout rebuilds once a
   * second, not per batch), and the fast loop's own for the debug readout.
   */
  const [workMaxFps, setWorkMaxFps] = createSignal(0);
  const [workFastMaxFps, setWorkFastMaxFps] = createSignal(0);
  /** `workMaxFps` is what the visits allow, below the fast loop's own top speed. */
  const [workMaxVisitLimited, setWorkMaxVisitLimited] = createSignal(false);
  // The smart floor estimate (`lib/speed-floor.ts`): shown in the `?debug` readout only, steers nothing.
  const floorMeter = new FloorMeter();
  const [floorLine, setFloorLine] = createSignal('');
  /** The floor as the Speed control's mark shows it (the prior until a measurement). */
  const [floor, setFloor] = createSignal<FloorDisplay>(floorMeter.display());
  /** Measurement only: the slow worker's newest raw accounting (cumulative; `__cala.pipeline.accounting()`). */
  let lastAccounting: WorkStatus | null = null;
  cells?.onStatus((st) => {
    if (!st.accounting) return;
    lastAccounting = st.accounting;
    // Throttled to about 1 Hz inside the meter: no per-batch work for a debug readout.
    if (floorMeter.due(st.accounting.wallMs)) {
      const lb = st.lookback;
      const gov = lb?.csettle?.governor;
      const floorChanged = floorMeter.push({
        work: st.accounting,
        inNeed: lb?.inNeed ?? 0,
        cap: gov?.cap ?? lb?.csettle?.rate ?? 0,
        needRate: NEED_RATE,
        // What the frame gate is held to (a visit hold paces a Max run too).
        target: gatePace(),
        maxFps: runMaxFps() || null,
        paused: untrack(status) === 'paused',
        governorLimit: gov?.limit,
        haveLibrary: st.version > 0,
        run: st.run,
      });
      const shown = floorMeter.display();
      // Once Discover has read its last frame there is no live rate left to set a floor for: the
      // mark and line keep what Discover ended with (the Final settle's load would move them).
      if (untrack(status) !== 'done') {
        setFloorLine(floorText(floorMeter));
        setFloor(shown);
      }
      // The run record's log: once a second at most, and only for Discover's own run.
      if (workSampleListeners.length > 0 && (st.run ?? 1) === 1) {
        const e = shown.estimate;
        const ps = untrack(paceStats);
        const sample: WorkSample = {
          frame: untrack(processed),
          limit: gov?.limit ?? null,
          maxFps: runMaxFps() || null,
          fastMaxFps: maxFpsEstimator.estimate() || null,
          floor: {
            fps: shown.fps,
            published: shown.published,
            seeAllFps: e.seeAllFps,
            limiting: e.limiting,
            confidence: e.confidence,
            terms: { ...e.terms },
          },
          floorInputs: floorMeter.last,
          floorChanged,
          running: untrack(status) !== 'done',
          counters: {
            processed: untrack(processed),
            observed: st.accounting.observedFrames ?? null,
            settledFrames: st.accounting.lookback.csettle.frames,
            forwardDrops,
            paceLateMs: ps?.lateMs ?? null,
            paceReanchors: ps?.reanchors ?? null,
            halvings: gov?.halvings ?? null,
            slowHalvings: gov?.slowHalvings ?? null,
          },
        };
        for (const cb of workSampleListeners) {
          try {
            cb(sample);
          } catch {
            // Observers only.
          }
        }
      }
    }
    const rates = workRater.push(st.accounting);
    if (!rates) return;
    const stages = stageBusyMeter.take(clock());
    if (stages) rates.fast = { stages };
    setWork(rates);
    // Likewise "max now": the fast loop is idle after the last frame, so the estimate only decays.
    if (untrack(status) !== 'done') {
      const fast = maxFpsEstimator.estimate();
      const max = runMaxFps();
      setWorkMaxFps(max);
      setWorkFastMaxFps(fast);
      setWorkMaxVisitLimited(max > 0 && max < fast);
    }
    // Not after Discover's last frame (stream time stands still; see `RunHistory.work`).
    if (untrack(status) !== 'done') {
      // The history's series is the fast loop's own top speed (`fast_max_fps`).
      runHistory?.work(rates, maxFpsEstimator.estimate());
      runHistory?.target(gatePace());
    }
  });
  cells?.onStatus((st) => {
    const births = birthRate.push(st.frame, st.counters.adds);
    if (births !== null && untrack(status) !== 'done') runHistory?.births(st.frame, births);
  });
  // The Discover visit rate: every status of Discover's own run, until its last frame is read.
  cells?.onStatus((st) => {
    const gov = visitGov;
    const s = untrack(status);
    if (!gov || (st.run ?? 1) !== 1 || (s !== 'running' && s !== 'paused')) return;
    const userFps = paceRun() ? paceFps : 0;
    const change = gov.update({
      now: pauseClock.now(clock()),
      framesRead: st.consumed ?? st.frame,
      observed: st.observed,
      visits: st.counters.visits,
      cappedFrames: st.visitRate?.cappedFrames ?? 0,
      dueTiles: st.visitRate?.dueTiles ?? 0,
      userFps,
    });
    if (gov.achieved !== untrack(visitAchieved)) {
      setVisitAchieved(gov.achieved);
      tellVisitRate();
    }
    if (!change) return;
    const before = gatePace();
    setVisitHold(change.fps);
    if (change.fps !== null) paceEver = true;
    const after = gatePace();
    if (after !== before) {
      sendPace({ fps: after, paused: s === 'paused' });
      const fmt = (f: number) => (f > 0 ? `${Math.round(f)} fps` : 'Max');
      runHistory?.log({
        frame: untrack(processed),
        kind: 'setting',
        key: 'visit_hold',
        from: before,
        to: after,
        detail:
          change.fps === null
            ? `Visit hold released (${change.achieved.toFixed(2)} visits/frame)`
            : `Held at ${fmt(after)} to keep refinement at ${VISIT_RATE.target} visits/frame (was ${fmt(before)}; ${change.achieved.toFixed(2)} visits/frame)`,
      });
    }
    tellVisitRate();
  });
  function setPace(fps: number, source: string): void {
    const before = paceRun() ? paceFps : 0;
    paceFps = Number.isFinite(fps) && fps > 0 ? fps : 0;
    setPaceTarget(paceFps);
    setPaceFromUrl(source === 'url');
    if (paceFps > 0) paceEver = true;
    const st = status();
    const after = paceRun() ? paceFps : 0;
    if (after !== before && (st === 'running' || st === 'paused'))
      runHistory?.speedSetting('target_speed', processed(), before, after, undefined, source);
    // A run paused before a pace existed must start held.
    if (st === 'running' || st === 'paused') sendPace({ fps: gatePace(), paused: st === 'paused' });
    tellSettlePace();
    // Last, and guarded: a listener (the run record's log) must never disturb pacing.
    for (const cb of paceListeners) {
      try {
        cb(paceFps, untrack(processed), source);
      } catch {
        // Observers only.
      }
    }
  }

  function sendPace(pace: { fps?: number; paused?: boolean }): void {
    void client.setPace?.(pace).catch(() => {});
  }
  /** The pacer as the settle governor sees it (the slow worker; 0 = Max): sent whenever it may have changed. */
  function tellSettlePace(): void {
    lookbackFeed?.pace?.(paceRun() ? paceFps : 0, untrack(status) === 'paused');
    startSettlePool();
  }
  /** The cap went from `before` to its value now: a run event while running or paused, and the listeners (the run record). */
  function noteCap(before: number, source: string): void {
    const after = settleCap();
    if (after === before) return;
    const st = untrack(status);
    const text = (c: number) => (c > 0 ? `${c} per live frame` : 'Off');
    if (st === 'running' || st === 'paused')
      runHistory?.speedSetting(
        'settle_cap',
        untrack(processed),
        before,
        after,
        `Settle cap ${text(before)} → ${text(after)}`,
      );
    for (const cb of capListeners) {
      try {
        cb(after, untrack(processed), source);
      } catch {
        // Observers only.
      }
    }
  }
  /** The settle's cap to the slow worker (during a run too), and the pool if it may now be used. */
  function tellSettleCap(): void {
    lookbackFeed?.cap?.(settleCap());
    startSettlePool();
  }
  /**
   * The settle pool starts the first time a look-back run is below Max with
   * the settle on (mid-run too); a run at Max never starts it (unless
   * `?debug&lbpoolmax`, a measurement arm).
   */
  function startSettlePool(): void {
    const st = untrack(status);
    if (st !== 'starting' && st !== 'running' && st !== 'paused') return;
    if (!lookbackSession || !(paceRun() || poolAtMax) || !(settleCap() > 0)) return;
    notePool(lookbackFeed?.startPool?.(lookbackSession) ?? 0, false);
  }
  /** The run record notes the pool's first start only (this runs on every pace or cap change). */
  function notePool(n: number, forFinal: boolean): void {
    if (n <= 0 || poolNoted === lookbackSession) return;
    poolNoted = lookbackSession;
    for (const cb of poolListeners) {
      try {
        cb(n, untrack(processed), forFinal);
      } catch {
        // Observers only.
      }
    }
  }
  /**
   * Discover of look-back run `session` ended and its Final settle reads the recording's factors
   * (`factors`): the settle pool starts now if it is not running (a run at Max, or a paced one
   * whose Background settle was off), so the settle runs on S + 1 look-back workers. S is the
   * pool size from the core count (`settlePoolSize`), never from a measured speed. The pooled
   * settle is order-dependent (footprints within noise, not bit-repeatable); its visits are not
   * (`SETTLE.visitRate`). `?debug&lbpool=0` turns it off.
   */
  function startFactorPool(session: number, factors: FactorSource['factors']): number {
    if (!lookbackSession || session !== lookbackSession) return 0;
    const n = lookbackFeed?.startFactorPool?.(session, factors) ?? 0;
    notePool(n, true);
    return n;
  }

  /** Show one played frame: its view's image, the batch's last-frame images for the other views. */
  function showPlayed(f: PlayedFrame): void {
    const fp = f.batch.frames!;
    setPreviews({
      ...f.batch,
      [fp.view]: framePreviewImage(fp, f.index),
      frame: fp.first + f.index,
      fit: { [fp.view]: f.batch[fp.view] },
    });
    if (displayLogOn) {
      displayLog.push({ t: clock(), frame: fp.first + f.index });
      // Bounded: past 20000 entries the oldest half is cut (a short measurement run never gets there).
      if (displayLog.length > 20000) displayLog = displayLog.slice(-10000);
    }
  }

  function playbackLoop(t: number): void {
    rafId = null;
    const f = playback.tick(t);
    if (f) showPlayed(f);
    if (playback.queued > 0) rafId = requestAnimationFrame(playbackLoop);
    else setPlaying(false);
  }

  function endPlayback(): void {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = null;
    playback.clear();
    setPlaying(false);
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
        // Paced: the pace, unless processing cannot keep up with it (then the measured rate, so the
        // queue does not just fill and skip). Unpaced: a little above the measured rate.
        const measured = rate > 0 ? rate * 1.05 : Infinity;
        playback.setRate(
          paceRun() ? Math.min(paceFps, measured) : Number.isFinite(measured) ? measured : 30,
        );
        playback.push(items);
        setPlaying(true);
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
    forwardDrops = null;
    curveDriver = null;
    runCurve = null;
    if (lookbackSession) lookbackFeed?.reset(lookbackSession);
    lookbackSession = 0;
    setLookbackRun(false);
    setFactorRun(false);
    setFactorFileRun(false);
    setGpuFactorRun(false);
    record = new RunRecord();
    pauseClock.reset();
    meter = new ThroughputMeter();
    totals = { ...ZERO_TIMINGS };
    setPaceStats(null);
    paceSession = -1;
    paceEpoch = -1;
    workRater.reset();
    floorMeter.reset();
    setFloor(floorMeter.display());
    stageBusyMeter.reset();
    birthRate.reset();
    maxFpsEstimator.reset();
    setWork(null);
    setMaxFps(0);
    setWorkMaxFps(0);
    setWorkFastMaxFps(0);
    setWorkMaxVisitLimited(false);
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
    // A curve's first step is the run's first target (the run record's "run start" row).
    armCurve(0);
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
      const runPlan = factorRunPlan({
        live: flat.identity?.()?.live === true,
        factors: factors(),
        factorsFile: factorsFile(),
        factorsGpu: factorsGpu(),
        factorsDefault: factorsDefault() && compress !== undefined,
        compress: compressAsked() && compress !== undefined,
        discover: discover(),
        joint: jointOf(),
      });
      setFactorRun(runPlan.factorSettle);
      setFactorFileRun(runPlan.factorFile);
      setGpuFactorRun(runPlan.gpu === true);
      setCompressRun(runPlan.compress !== null);
      const pool = runPlan.compress
        ? poolForRun(flat.identity?.()?.live === true, compressPool())
        : null;
      setRunPool(pool);
      // Only an explicit `?factors=file`/`gpu`: the default has no factor route on a Joint run.
      if (factors() && factorsFile() && jointOf()) console.warn(FACTORS_FILE_JOINT);
      runLevel = lb || runPlan.factorSettle ? finalSettleLevelSig() : FINAL_SETTLE_LEVEL_DEFAULT;
      if (lb) {
        lookbackSession = session;
        // Without an estimator this session, the flat-field input is final from the start.
        finalInputs = { back: false, flat: !useFlat, sent: false };
        setLookbackRun(true);
        if (flatLatest) lookbackFeed!.flatField(session, flatLatest);
        // The cap and the target before the run's init (the slow worker keeps them across runs).
        lookbackFeed!.cap?.(settleCap());
        tellSettlePace();
      }
      const p = await client.startPipeline(
        { ...options, flatField: useFlat },
        {
          session,
          ...(lb ? { lookback: true } : {}),
          ...(lb && FINAL_SETTLE_LEVELS[finalSettleLevelSig()].fraction < 1
            ? { settleFraction: FINAL_SETTLE_LEVELS[finalSettleLevelSig()].fraction }
            : {}),
          ...(lb
            ? {
                csettle: true,
                ...(csettleYield() > 0 ? { csettleYield: csettleYield() } : {}),
                ...(csettleNeedFirst() ? { csettleNeedFirst: true } : {}),
              }
            : {}),
          discover: discover(),
          // The Discover visit cap (the slow loop's credit; recordings and live streams alike).
          ...(discover() && visitRateCap(visitRateMode(untrack(visitRateOff), false)) > 0
            ? { visitRate: visitRateCap(visitRateMode(untrack(visitRateOff), false)) }
            : {}),
          // The Final settle's visit rate (a recording's or a stream's settle; with visit workers).
          ...(discover() && settleVisits > 0 ? { settleVisitRate: settleVisits } : {}),
          qc,
          residual: residual(),
          ...(forwardBuffers ? { forwardBuffers } : {}),
          ...(runPlan.compress
            ? {
                compress: true,
                ...(runPlan.compress !== 'plain' ? { compressTiling: runPlan.compress } : {}),
                ...(pool ? { compressPool: pool } : {}),
                ...(backlogCap !== undefined ? { compressBacklogCap: backlogCap } : {}),
                ...(frameExtract ? { compressFrameExtract: true } : {}),
                ...(runPlan.gpu ? { compressGpu: true } : {}),
                ...(runPlan.gpu && gpuCheck > 0 ? { compressGpuCheck: gpuCheck } : {}),
              }
            : {}),
          ...(runPlan.factorSettle ? { factorSettle: true } : {}),
          ...(runPlan.factorFile ? { factorFile: true } : {}),
          ...(runPlan.factorSettle && FINAL_SETTLE_LEVELS[finalSettleLevelSig()].fraction < 1
            ? { settleFraction: FINAL_SETTLE_LEVELS[finalSettleLevelSig()].fraction }
            : {}),
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
        // What is started now: 3 fast stages, the slow worker, the look-back worker; the visit
        // workers and a settle pool are added when the first work reading counts them.
        workers: 4 + (lookbackRun() ? 1 : 0),
      });
      stageBusyMeter.start(clock());
      setStatus('running');
      syncFramePreview(0);
      if (paceRun()) sendPace({ fps: paceFps });
      setVisitHold(null);
      setVisitAchieved(null);
      // The visit governor: Discover only; a live stream keeps the cap (in the slow loop) only.
      visitGov = discover()
        ? new VisitRateGovernor(
            visitRateMode(untrack(visitRateOff), flat.identity?.()?.live === true),
          )
        : null;
      setVisitMode(visitGov?.mode ?? null);
      tellVisitRate();
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
    pauseClock.pause(clock());
    // The newest frame at once; the rest of the queue is dropped.
    const newest = playback.flush();
    if (newest) showPlayed(newest);
    setPlaying(false);
    // Requests already in the worker must not be released while paused.
    if (paceEver) sendPace({ paused: true });
    tellSettlePace();
    runHistory?.log({ frame: processed(), kind: 'pause', detail: 'Paused' });
  }

  function resume(): void {
    if (status() !== 'paused') return;
    // Answers to steps sent before the pause still arrive and count.
    setStatus('running');
    pauseClock.resume(clock());
    if (paceEver) sendPace({ paused: false });
    tellSettlePace();
    runHistory?.log({ frame: processed(), kind: 'resume', detail: 'Resumed' });
    pump();
  }

  /** Stop and free the worker-side pipeline (e.g. before opening another folder). */
  function stop(): void {
    const wasActive = status() !== 'idle';
    // The stopped run's pacing readouts stay, and its final one (flushed on stop) still lands.
    const keep = { session: paceSession, epoch: paceEpoch, stats: paceStats() };
    reset();
    paceSession = keep.session;
    paceEpoch = keep.epoch;
    setPaceStats(keep.stats);
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
    setFactors,
    setFactorsFile(on: boolean, joint: () => boolean): void {
      setFactorsFile(on);
      jointOf = joint;
    },
    /** A recording's factor file run compresses on the GPU (the default, `?factors=gpu`). */
    setFactorsGpu,
    setFactorsDefault,
    setCompressAsked,
    factorRun,
    factorFileRun,
    /** The current run compresses on the GPU (`FactorRunPlan.gpu`). */
    gpuFactorRun,
    /** The current run compresses its frames (a factor run or `?compress`). */
    compressRun,
    /** The page's compress pool widths (set once by the app; null: one worker). */
    setCompressPool,
    /** The current run's compress pool widths (null: one worker, or no compression). */
    runPool,
    /** `?debug&cbacklog=GB`: the cap on waiting window files, bytes (undefined: the default). */
    setCompressBacklogCap(bytes: number | undefined): void {
      backlogCap = bytes;
    },
    /** `?debug&fextract=0`: Extract on factors on rebuilt frames (measurement). */
    setFrameExtract(on: boolean): void {
      frameExtract = on;
    },
    /** `?debug&lbpoolmax`: the settle pool starts at Max too (measurement). */
    setPoolAtMax(on: boolean): void {
      poolAtMax = on;
    },
    /** `?debug&gpucheck=N`: windows of a GPU run the CPU compresses too (0: none). */
    setGpuCheck(windows: number): void {
      gpuCheck = windows;
    },
    // (Not `??`: `blocked()` returns null when look-back can run.)
    lookbackBlocked: () =>
      lookbackFeed ? lookbackFeed.blocked() : 'Look-back is not available here.',
    lookbackRun,
    /** How much of the final settle pass is read (Thorough, Standard, Quick); the setting for the next Discover start. */
    finalSettleLevel: finalSettleLevelSig,
    /** The level the current run started with (the selection before any run); what the run record names. */
    runFinalSettleLevel: () => runLevel ?? finalSettleLevelSig(),
    setFinalSettleLevel: (level: unknown) => setFinalSettleLevelSig(finalSettleLevel(level)),
    /** Settle during Discover (experimental; only with look-back): the settings for the next Discover start. */
    csettle,
    /** Background settle on or off (off = cap 0); during a run too. */
    setCsettle: (on: boolean, source = 'setting') => {
      const before = settleCap();
      setCsettleSignal(on);
      noteCap(before, source);
      tellSettleCap();
    },
    csettleCeiling,
    /** The cap, re-read frames per live frame (`CSETTLE.rates`); during a run too. */
    setCsettleCeiling: (rate: number, source = 'setting') => {
      const before = settleCap();
      setCsettleCeilingSignal(csettleRate(rate));
      noteCap(before, source);
      tellSettleCap();
    },
    /**
     * The frame worker's pacing readouts (gate wait, lateness dropped, re-anchors) of the newest
     * gate run; null before the first readout of a run (a run that never had a target has none).
     * The stopped run's final readout stays until the next start.
     */
    paceStats,
    /** Who is doing what, over the last second or so (the slow, visit and look-back workers); null until a second of data. */
    work,
    /** Measurement only: the slow worker's newest raw cumulative accounting (`?debug` adds `detail`, `stage`). */
    accounting: (): WorkStatus | null => lastAccounting,
    /** The smart floor's `?debug` lines (value, which consumer sets it, confidence); empty before the first status. */
    floorLine,
    /** The floor for the Speed control's mark: `published` once measured, else the prior; refreshed about once a second. */
    floor,
    /** The fast loop's live estimate of its top speed, frames per second (0 until a batch has busy time). */
    maxFps,
    /**
     * The run's top speed as of the last `work` reading: the fast loop's, lowered to what the
     * visits allow while the visit rate holds the run. The Speed block's Max.
     */
    workMaxFps,
    /** The fast loop's own top speed as of the last `work` reading (the `?debug` readout). */
    workFastMaxFps,
    /** `workMaxFps` is set by the visits (the refinement rate), not by the fast loop. */
    workMaxVisitLimited,
    /** The run's top speed now, fps (0: not known); `workMaxFps` is its once-a-second copy. */
    runMaxFps,
    /** Read no faster than this many frames a second (0: off); applies to a running recording at once. */
    setPaceFps: (fps: number, source = 'setting') => {
      // Anyone but a curve (or Auto) setting the target takes the pacer back: a curve does not
      // fight a user, the URL, a replay or the pin.
      if (source !== 'curve' && source !== 'auto') {
        curveDriver = null;
        runCurve = null;
        autoPolicy = null;
        setActiveCurve(null);
        setActiveAuto(null);
      }
      setPace(fps, source);
    },
    /** The speed curve of Curve mode, as set (null: none); a signal. */
    speedCurve: () => {
      const a = activeCurve();
      return a ? { curve: a.curve, preset: a.preset, normalize: a.normalize } : null;
    },
    /**
     * Choose a speed curve (null: none). The run follows it from its start, or from the frame it is
     * chosen at mid-run; steps too short for the governor's ramp are merged at that point (not for
     * `normalize: false`, a replayed curve, which runs exactly as recorded).
     */
    setSpeedCurve: (curve: SpeedCurve | null, o: { preset?: string; normalize?: boolean } = {}) => {
      const c = curve ? sanitizeCurve(curve) : null;
      setActiveAuto(null);
      autoPolicy = null;
      if (!c) {
        setActiveCurve(null);
        curveDriver = null;
        runCurve = null;
        setArmedCurve(null);
        return;
      }
      const normalize = o.normalize !== false;
      setActiveCurve({
        curve: normalize ? limitPoints(c) : c,
        preset: o.preset ?? 'custom',
        normalize,
      });
      const st = untrack(status);
      if (st === 'running' || st === 'paused') armCurve(untrack(processed));
    },
    /** The Auto budget of Auto mode (extra time over a Max run, as a share; null: not Auto); a signal. */
    autoBudget: activeAuto,
    /**
     * Choose Auto with a time budget (null: leave Auto). A run follows it from its start, or from
     * the frame it is chosen at mid-run. Replaces a curve.
     */
    setAutoBudget: (share: number | null) => {
      setActiveCurve(null);
      curveDriver = null;
      runCurve = null;
      setArmedCurve(null);
      autoPolicy = null;
      setActiveAuto(share !== null && Number.isFinite(share) && share > 0 ? share : null);
      const st = untrack(status);
      if (untrack(activeAuto) !== null && (st === 'running' || st === 'paused'))
        armCurve(untrack(processed));
    },
    /** What this run's Auto decided so far (null: not an Auto run), for the run record. */
    autoNow: (): { extraTimeShare: number; decisions: AutoDecision[] } | null => autoSnapshot(),
    /** Called when Auto arms and after each decision it makes (the run record's copy). */
    onAutoChange: (cb: (a: { extraTimeShare: number; decisions: AutoDecision[] }) => void) => {
      autoListeners.push(cb);
    },
    /** The curve the run follows after the minimum-step rule (null: none armed), with the steps merged; a signal. */
    armedCurve,
    /** Install another policy (Auto, PR I) in place of the curve; `record` is kept in the run record. */
    armPolicy,
    /** The curve this run is following (null: none), as the run record keeps it. */
    curveNow: (): CurveRecord | null => (runCurve ? { ...runCurve } : null),
    /** Called when a curve takes over the target (at the run's start, or mid-run). */
    onCurveArmed: (cb: (c: CurveRecord) => void) => {
      curveListeners.push(cb);
    },
    /** The target speed now, frames per second (0: Max). */
    paceFps: () => paceFps,
    /** `?debug&visitrate=off`: no visit cap and no hold, from the next start (the behaviour before). */
    setVisitRateOff,
    /** `?debug&settlevisits=`: the Final settle's visit rate from the next start (0: none, as before). */
    setSettleVisitRate(rate: number): void {
      settleVisits = Number.isFinite(rate) && rate > 0 ? rate : 0;
    },
    /** The Final settle's visit rate the next run starts with (0: none). */
    settleVisitRate: (): number => settleVisits,
    visitRateOff,
    /** This run's visit-rate mode (null: not a Discover run), the hold (fps; null: not held) and the newest window's visits per frame read. */
    visitMode,
    visitHold,
    visitAchieved,
    /** The pace the frame gate is held to now (the user's target or the visit hold, whichever is lower; 0: Max). */
    gatePace: () => {
      visitHold();
      paceTarget();
      return gatePace();
    },
    /** Called with the visit-rate summary as it changes and when Discover ends (the run record). */
    onVisitRate: (cb: (s: VisitRateSummary) => void) => {
      visitListeners.push(cb);
    },
    /** The target speed as a signal (0: Max). */
    paceTarget,
    paceFromUrl,
    /** The target speed this run is paced at (0: Max, and always 0 for a live stream, which a target does not pace). */
    targetNow: () => (paceRun() ? paceFps : 0),
    /** The settle cap in force for this run (0: Off, and 0 for a live stream, where look-back cannot run). */
    capNow: () => (flat.identity?.()?.live === true ? 0 : settleCap()),
    /** Called with the new settle cap, the frame reached and what set it, whenever it changes (the run record's log). */
    onCapChange: (cb: (cap: number, frame: number, source: string) => void) => {
      capListeners.push(cb);
    },
    /** Called with the new target speed, the frame reached and what set it, whenever `setPaceFps` runs (the run record's log). */
    onPaceChange: (cb: (fps: number, frame: number, source: string) => void) => {
      paceListeners.push(cb);
    },
    /** Called about once a second while the slow loop reports: the governor's limit, the Max estimate and the floor (the run record's log). */
    onWorkSample: (cb: (s: WorkSample) => void) => {
      workSampleListeners.push(cb);
    },
    /** Called once per run when its settle pool starts: the pool workers and the frame reached. */
    /** The Final settle on the recording's factors begins: start the settle pool for it (`startFactorPool`). */
    startFactorPool,
    onPoolStart: (cb: (workers: number, frame: number, forFinal: boolean) => void) => {
      poolListeners.push(cb);
    },
    smoothPlayback: () => smoothOn,
    csettleYield,
    csettleNeedFirst,
    setCsettleNeedFirst,
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
    /**
     * The frame on screen while playback lags the processed one (null otherwise: a run without
     * per-frame previews, a finished or paused queue), for views that should end where the video is.
     */
    displayedFrame: () => (playing() ? (previews()?.frame ?? null) : null),
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
