/**
 * Main-thread state of the live preprocess + motion pipeline.
 *
 * Backpressure: at most `MAX_IN_FLIGHT` step requests are outstanding. The
 * worker runs one step per request, so it never gets more than one batch
 * ahead of the UI, and only the latest previews are kept (a slow renderer
 * drops frames instead of queueing them). Pausing simply stops requesting.
 *
 * Its parts: playback (`playback-controller.ts`), the flat field (`flat-field-store.ts`), the
 * Speed control (`speed-control-store.ts`), Background settle (`bg-settle-store.ts`) and the work
 * readout (`work-readout-store.ts`). This store owns the run's lifecycle and wires them.
 */
import { createSignal, untrack } from 'solid-js';
import type { CellStore } from './cell-store.ts';
import type { CompressStore } from './compress-store.ts';
import { FACTORS_FILE_JOINT, factorRunPlan } from './factor-run.ts';
import { poolForRun, type PoolWidth } from './compress-pool.ts';
import type { FlatFieldMap } from './flat-field.ts';
import { createFlatFieldStore, type FlatFieldStoreOptions } from './flat-field-store.ts';
import type { PipelineClient } from './frame-client.ts';
import { errMsg } from './errors.ts';
import { normalizeRunCells } from './run-cells.ts';
import type {
  LiveBatchInfo,
  MotionBackend,
  PipelineStepResult,
  StageTimings,
} from './pipeline-types.ts';
import type { PipelineOptions, PipelinePhase, PipelinePlan } from './pipeline-plan.ts';
import { createPlaybackController } from './playback-controller.ts';
import { RunRecord } from './run-record.ts';
import { BoundaryMonitor, severityLabel, type BoundaryFlag } from './boundary-flags.ts';
import type { SessionStart } from './session-boundary.ts';
import type { RunHistory } from './run-history.ts';
import type { LookbackFeed } from './lookback-client.ts';
import {
  FINAL_SETTLE_LEVEL_DEFAULT,
  FINAL_SETTLE_LEVELS,
  finalSettleLevel,
  SETTLE,
} from './settle.ts';
import { createBgSettleControl } from './bg-settle-store.ts';
import { createSpeedControl } from './speed-control-store.ts';
import { createWorkReadout } from './work-readout-store.ts';
import { visitRateCap, visitRateMode } from './visit-rate.ts';

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
  /** Look-back: the look-back worker's feed (absent: look-back is not offered). */
  lookbackFeed?: LookbackFeed,
  /**
   * Starts the workers a Discover run needs that were ended once the previous run had no more
   * use for them; resolves when they are wired (absent: they are never ended).
   */
  workersReady?: () => Promise<void>,
) {
  const [status, setStatus] = createSignal<PipelineStatus>('idle');
  const [plan, setPlan] = createSignal<PipelinePlan | null>(null);
  const [setup, setSetup] = createSignal<SetupProgress | null>(null);
  const [processed, setProcessed] = createSignal(0);
  const [fps, setFps] = createSignal(0);
  const playbackCtl = createPlaybackController({
    client,
    clock,
    paused: () => status() === 'paused',
    paceRun: () => speed.paceRun(),
    paceFps: () => speed.paceFps(),
    rate: () => meter.rate(),
  });
  const { previews, offerPreviews, syncFramePreview } = playbackCtl;
  /** Mean wall time per processed frame and stage, ms. */
  const [stageMs, setStageMs] = createSignal<StageTimings>(ZERO_TIMINGS);
  /** Mean busy time per processed frame of each pipeline stage (A, B, C), ms; empty before the first batch. */
  const [stageBusy, setStageBusy] = createSignal<number[]>([]);
  /** Where motion correction runs (`null` before the first batch). */
  const [motionBackend, setMotionBackend] = createSignal<MotionBackend | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** Cell discovery (the slow loop) on or off. */
  const [discover, setDiscoverSignal] = createSignal(true);
  const [residual, setResidualSignal] = createSignal(false);
  /**
   * Look-back (and its Final settle) on for the next Discover start (the setting), and on in the
   * current run. On by default for recordings: it is how footprints converge (there is no Refine
   * stage). A live stream or a source that cannot be re-read has none (`lookbackBlocked`).
   */
  const [lookback, setLookback] = createSignal(true);
  const [lookbackRun, setLookbackRun] = createSignal(false);
  /**
   * Repeatable runs (recordings; `?debug&repeatable=0` turns it off for the next start): at a
   * target speed, the slow worker applies results at batch barriers and the fast loop adopts
   * libraries at stamped frames (`RunCells.repeatable`). A live stream never is.
   */
  const [repeatable, setRepeatable] = createSignal(true);
  /** The current run is repeatable (a recording with `repeatable` on at its start). */
  const [repeatableRun, setRepeatableRun] = createSignal(false);
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
  // `?debug&fextract=0`: Extract on factors on rebuilt frames (measurement).
  let frameExtract = false;
  // `?debug&gpucheck=N`: a GPU run's first N windows are compressed on the CPU too (measurement).
  let gpuCheck = 0;
  let jointOf: () => boolean = () => false;
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
  const flatStore = createFlatFieldStore({
    client,
    enabled: options.flatField !== false,
    flat,
    runHistory,
    record: () => record,
    onFinal: () => noteFinalInputs({ flat: true }),
    onMap: (map: FlatFieldMap) => {
      if (lookbackSession) lookbackFeed?.flatField(lookbackSession, map);
    },
  });
  const { flatEnabled, flushFlatField } = flatStore;

  /** Frames processed this run (the denominator of the per-frame timing means). */
  let framesDone = 0;
  /** Discover's per-frame motion and flicker, kept in full for Extract and the export. */
  let record = new RunRecord();
  let meter = new ThroughputMeter();
  let totals: StageTimings = { ...ZERO_TIMINGS };
  let busyTotals: number[] = [];
  let inFlight = 0;
  let exhausted = false;
  let generation = 0; // bumps on start/stop, so late answers are dropped

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
        if (step.flatField) flatStore.noteApplied(step.flatField);
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
        speed.driveCurve(step.start + step.count);
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
        if (step.cells) workReadout.noteForwardDrops(step.cells.droppedFrames);
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
        workReadout.noteBatch(step.count, step.stageBusyMs, t);
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
        speed.endCurve();
        if (!exhausted) {
          exhausted = true;
          speed.endVisitHold();
          boundaryMonitor?.end();
          refreshBoundaryFlags(true);
          flushFlatField();
          setStatus('done');
        }
        return;
    }
  }

  /**
   * The Final settle's visit rate, visits per settle frame (`SETTLE.visitRate`; 0: none, visits
   * whenever a visit worker is free): `?debug&settlevisits=` sets it (measurement).
   */
  let settleVisits: number = SETTLE.visitRate;
  const bgSettle = createBgSettleControl({
    lookbackFeed,
    lookbackSession: () => lookbackSession,
    status,
    processed,
    runHistory,
    paceRun: () => speed.paceRun(),
    paceFps: () => speed.paceFps(),
    live: () => flat.identity?.()?.live === true,
  });
  const { settleCap, tellSettlePace } = bgSettle;
  const speed = createSpeedControl({
    client,
    clock,
    status,
    processed,
    runHistory,
    identity: () => flat.identity?.(),
    lookbackFeed,
    settleCap,
    tellSettlePace,
    floor: () => workReadout.floor(),
    runMaxFps: () => workReadout.runMaxFps(),
  });
  const workReadout = createWorkReadout({
    clock,
    status,
    processed,
    runHistory,
    gatePace: speed.gatePace,
    paceStats: speed.paceStats,
    visitMaxFps: speed.visitMaxFps,
  });
  // Registration order is evaluation order within one status: the floor and the work readout
  // read the visit hold before the visit governor updates it.
  cells?.onStatus(workReadout.onStatus);
  cells?.onStatus(workReadout.onBirths);
  cells?.onStatus(speed.onVisitStatus);

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
          const message = errMsg(err);
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
    flatStore.reset();
    generation++;
    inFlight = 0;
    exhausted = false;
    framesDone = 0;
    speed.reset();
    if (lookbackSession) lookbackFeed?.reset(lookbackSession);
    lookbackSession = 0;
    setLookbackRun(false);
    setRepeatableRun(false);
    setFactorRun(false);
    setFactorFileRun(false);
    setGpuFactorRun(false);
    record = new RunRecord();
    meter = new ThroughputMeter();
    totals = { ...ZERO_TIMINGS };
    workReadout.reset();
    setPlan(null);
    setSetup(null);
    setProcessed(0);
    playbackCtl.reset();
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
    speed.armCurve(0);
    const session = nextSession++;
    speed.beginRun(session);
    cells?.reset(session);
    compress?.reset(session);
    try {
      if (workersReady) {
        await workersReady();
        if (gen !== generation) return;
      }
      // Flat field: a stored map of this device (if any) is in force from the first processed frame.
      const { useFlat, read } = flatStore.begin(session);
      const rec = read ? await read : null;
      if (gen !== generation) return;
      const seed = flatStore.seed(rec);
      // Look-back (on by default for recordings): from this start on, if the recording allows it.
      const lb = lookback() && discover() && lookbackFeed?.begin(session) === true;
      const live = flat.identity?.()?.live === true;
      const rep = repeatable() && !live;
      setRepeatableRun(rep);
      const runPlan = factorRunPlan({
        live,
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
        const flatLatest = flatStore.flatFieldMap();
        if (flatLatest) lookbackFeed!.flatField(session, flatLatest);
        // The cap and the target before the run's init (the slow worker keeps them across runs).
        lookbackFeed!.cap?.(settleCap());
        tellSettlePace();
      }
      const p = await client.startPipeline(
        { ...options, flatField: useFlat },
        {
          session,
          discover: discover(),
          ...normalizeRunCells({
            lookback: lb,
            // Background settle may run whenever look-back does (below Max, `SlowRunner`).
            csettle: lb,
            csettleYield: bgSettle.csettleYield(),
            csettleNeedFirst: bgSettle.csettleNeedFirst(),
            factorSettle: runPlan.factorSettle,
            factorFile: runPlan.factorFile,
            settleFraction: FINAL_SETTLE_LEVELS[finalSettleLevelSig()].fraction,
            // The Discover visit rate's schedule sets the cap and the target (recordings and live
            // streams alike); `?debug&visitrate=off` sends none.
            ...(discover() && visitRateCap(visitRateMode(untrack(speed.visitRateOff), false)) > 0
              ? { visitSchedule: untrack(speed.visitRateSetting) === 'auto' ? 'auto' : 'fixed' }
              : {}),
            // The Final settle's visit rate (a recording's or a stream's settle; with visit workers).
            ...(discover() ? { settleVisitRate: settleVisits } : {}),
            repeatable: rep,
          }),
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
      workReadout.start();
      setStatus('running');
      syncFramePreview(0);
      speed.startRun(discover(), flat.identity?.()?.live === true);
      pump();
    } catch (err) {
      if (gen !== generation) return;
      setError(errMsg(err));
      setStatus('error');
    }
  }

  function pause(): void {
    if (status() !== 'running') return;
    setStatus('paused');
    playbackCtl.pause();
    speed.pause();
    runHistory?.log({ frame: processed(), kind: 'pause', detail: 'Paused' });
  }

  function resume(): void {
    if (status() !== 'paused') return;
    // Answers to steps sent before the pause still arrive and count.
    setStatus('running');
    speed.resume();
    runHistory?.log({ frame: processed(), kind: 'resume', detail: 'Resumed' });
    pump();
  }

  /** Stop and free the worker-side pipeline (e.g. before opening another folder). */
  function stop(): void {
    const wasActive = status() !== 'idle';
    // The stopped run's pacing readouts stay, and its final one (flushed on stop) still lands.
    const keep = speed.takePaceReadout();
    reset();
    speed.restorePaceReadout(keep);
    setStatus('idle');
    if (wasActive) void client.stopPipeline().catch(() => {});
  }

  /**
   * End Discover at the frames processed so far (the rest of the recording is not
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
      setError(errMsg(err));
      setStatus('error');
      return;
    }
    if (gen !== generation) return;
    if (status() === 'paused') setStatus('running');
    pump();
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
     * Look-back (on by default for recordings): the setting for the next Discover start, why
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
    setPoolAtMax: bgSettle.setPoolAtMax,
    /** `?debug&gpucheck=N`: windows of a GPU run the CPU compresses too (0: none). */
    setGpuCheck(windows: number): void {
      gpuCheck = windows;
    },
    // (Not `??`: `blocked()` returns null when look-back can run.)
    lookbackBlocked: () =>
      lookbackFeed ? lookbackFeed.blocked() : 'Look-back is not available here.',
    lookbackRun,
    repeatable,
    setRepeatable,
    repeatableRun,
    /** How much of the final settle pass is read (Thorough, Standard, Quick); the setting for the next Discover start. */
    finalSettleLevel: finalSettleLevelSig,
    /** The level the current run started with (the selection before any run); what the run record names. */
    runFinalSettleLevel: () => runLevel ?? finalSettleLevelSig(),
    setFinalSettleLevel: (level: unknown) => setFinalSettleLevelSig(finalSettleLevel(level)),
    /** Settle during Discover (only with look-back): the settings for the next Discover start. */
    csettle: bgSettle.csettle,
    /** Background settle on or off (off = cap 0); during a run too. */
    setCsettle: bgSettle.setCsettle,
    csettleCeiling: bgSettle.csettleCeiling,
    /** The cap, re-read frames per live frame (`CSETTLE.rates`); during a run too. */
    setCsettleCeiling: bgSettle.setCsettleCeiling,
    /**
     * The frame worker's pacing readouts (gate wait, lateness dropped, re-anchors) of the newest
     * gate run; null before the first readout of a run (a run that never had a target has none).
     * The stopped run's final readout stays until the next start.
     */
    paceStats: speed.paceStats,
    /** Who is doing what, over the last second or so (the slow, visit and look-back workers); null until a second of data. */
    work: workReadout.work,
    /** Measurement only: the slow worker's newest raw cumulative accounting (`?debug` adds `detail`, `stage`). */
    accounting: workReadout.accounting,
    /** The smart floor's `?debug` lines (value, which consumer sets it, confidence); empty before the first status. */
    floorLine: workReadout.floorLine,
    /** The floor for the Speed control's mark: `published` once measured, else the prior; refreshed about once a second. */
    floor: workReadout.floor,
    /** The fast loop's live estimate of its top speed, frames per second (0 until a batch has busy time). */
    maxFps: workReadout.maxFps,
    /**
     * The run's top speed as of the last `work` reading: the fast loop's, lowered to what the
     * visits allow while the visit rate holds the run. The Speed block's Max.
     */
    workMaxFps: workReadout.workMaxFps,
    /** The fast loop's own top speed as of the last `work` reading (the `?debug` readout). */
    workFastMaxFps: workReadout.workFastMaxFps,
    /** `workMaxFps` is set by the visits (the refinement rate), not by the fast loop. */
    workMaxVisitLimited: workReadout.workMaxVisitLimited,
    /** The run's top speed now, fps (0: not known); `workMaxFps` is its once-a-second copy. */
    runMaxFps: workReadout.runMaxFps,
    /** Read no faster than this many frames a second (0: off); applies to a running recording at once. */
    setPaceFps: speed.setPaceFps,
    /** The speed curve of Curve mode, as set (null: none); a signal. */
    speedCurve: speed.speedCurve,
    /**
     * Choose a speed curve (null: none). The run follows it from its start, or from the frame it is
     * chosen at mid-run; steps too short for the governor's ramp are merged at that point (not for
     * `normalize: false`, a replayed curve, which runs exactly as recorded).
     */
    setSpeedCurve: speed.setSpeedCurve,
    /** The Auto budget of Auto mode (extra time over a Max run, as a share; null: not Auto); a signal. */
    autoBudget: speed.autoBudget,
    /**
     * Choose Auto with a time budget (null: leave Auto). A run follows it from its start, or from
     * the frame it is chosen at mid-run. Replaces a curve.
     */
    setAutoBudget: speed.setAutoBudget,
    /** What this run's Auto decided so far (null: not an Auto run), for the run record. */
    autoNow: speed.autoNow,
    /** Called when Auto arms and after each decision it makes (the run record's copy). */
    onAutoChange: speed.onAutoChange,
    /** The curve the run follows after the minimum-step rule (null: none armed), with the steps merged; a signal. */
    armedCurve: speed.armedCurve,
    /** Install another policy (Auto) in place of the curve; `record` is kept in the run record. */
    armPolicy: speed.armPolicy,
    /** The curve this run is following (null: none), as the run record keeps it. */
    curveNow: speed.curveNow,
    /** Called when a curve takes over the target (at the run's start, or mid-run). */
    onCurveArmed: speed.onCurveArmed,
    /** The target speed now, frames per second (0: Max). */
    paceFps: speed.paceFps,
    /**
     * `?debug&visitrate=off|auto` (measurement): no visit cap and no hold, or the Auto schedule
     * instead of the fixed rate, from the next start.
     */
    setVisitRateSetting: speed.setVisitRateSetting,
    visitRateSetting: speed.visitRateSetting,
    /** `?debug&settlevisits=`: the Final settle's visit rate from the next start (0: none). */
    setSettleVisitRate(rate: number): void {
      settleVisits = Number.isFinite(rate) && rate > 0 ? rate : 0;
    },
    /** The Final settle's visit rate the next run starts with (0: none). */
    settleVisitRate: (): number => settleVisits,
    visitRateOff: speed.visitRateOff,
    /** This run's visit-rate mode (null: not a Discover run), the hold (fps; null: not held) and the newest window's visits per frame read. */
    visitMode: speed.visitMode,
    visitHold: speed.visitHold,
    visitAchieved: speed.visitAchieved,
    /** This run's schedule (`auto`, `fixed`; null: off or not a Discover run). */
    visitSchedule: speed.visitSchedule,
    /** The schedule's target in force, visits per frame (null: not reported yet), and new cells per visit. */
    visitTarget: speed.visitTarget,
    visitYield: speed.visitYield,
    /** The pace the frame gate is held to now (the user's target or the visit hold, whichever is lower; 0: Max). */
    gatePace: speed.gatePaceTracked,
    /** Called with the visit-rate summary as it changes and when Discover ends (the run record). */
    onVisitRate: speed.onVisitRate,
    /** The target speed as a signal (0: Max). */
    paceTarget: speed.paceTarget,
    paceFromUrl: speed.paceFromUrl,
    /** The target speed this run is paced at (0: Max, and always 0 for a live stream, which a target does not pace). */
    targetNow: speed.targetNow,
    /** The settle cap in force for this run (0: Off, and 0 for a live stream, where look-back cannot run). */
    capNow: bgSettle.capNow,
    /** Called with the new settle cap, the frame reached and what set it, whenever it changes (the run record's log). */
    onCapChange: bgSettle.onCapChange,
    /** Called with the new target speed, the frame reached and what set it, whenever `setPaceFps` runs (the run record's log). */
    onPaceChange: speed.onPaceChange,
    /** Called about once a second while the slow loop reports: the governor's limit, the Max estimate and the floor (the run record's log). */
    onWorkSample: workReadout.onWorkSample,
    /** Called once per run when its settle pool starts: the pool workers and the frame reached. */
    /** The Final settle on the recording's factors begins: start the settle pool for it (`startFactorPool`). */
    startFactorPool: bgSettle.startFactorPool,
    /** The final library is out: end a pool started for the Final settle (`endFactorPool`). */
    endFactorPool: bgSettle.endFactorPool,
    onPoolStart: bgSettle.onPoolStart,
    smoothPlayback: playbackCtl.smoothPlayback,
    csettleYield: bgSettle.csettleYield,
    csettleNeedFirst: bgSettle.csettleNeedFirst,
    setCsettleNeedFirst: bgSettle.setCsettleNeedFirst,
    setCsettleYield: bgSettle.setCsettleYield,
    setResidual,
    /**
     * The view the FOV shows (null: none, or one that is not a frame of the batch, like the residual):
     * per-frame previews are asked for this one.
     */
    setPlayView: playbackCtl.setPlayView,
    /** Smooth playback on or off (default on; `?debug&smooth=0` turns it off for comparison). */
    setSmoothPlayback: playbackCtl.setSmoothPlayback,
    /** Frames waiting for display, dropped by skipping ahead, and shown; the view being previewed (measurement). */
    playbackStats: playbackCtl.playbackStats,
    /**
     * The frame on screen while playback lags the processed one (null otherwise: a run without
     * per-frame previews, a finished or paused queue), for views that should end where the video is.
     */
    displayedFrame: playbackCtl.displayedFrame,
    /** Record when each displayed frame changed (measurement; `?debug`). */
    setDisplayLog: playbackCtl.setDisplayLog,
    displayLog: playbackCtl.displayLog,
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
    setFlatEnabled: flatStore.setFlatEnabled,
    flatField: flatStore.flatField,
    flatFieldMap: flatStore.flatFieldMap,
    /** Write the newest map to the per-device cache now (the run end does it too). */
    flushFlatField,
    /** What Discover recorded per frame (motion shifts and flicker) so far. */
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
