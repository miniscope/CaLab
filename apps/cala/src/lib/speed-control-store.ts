/**
 * The Speed control on the main thread, for the pipeline store: the target speed and what the
 * frame gate is told, the Discover visit rate and its hold, the speed curve and Auto, and the
 * frame worker's pacing readouts.
 */
import { createSignal, untrack, type Accessor } from 'solid-js';
import type { PaceStats } from './frame-pacer.ts';
import type { PipelineClient } from './frame-client.ts';
import type { LookbackFeed } from './lookback-client.ts';
import type { RunHistory } from './run-history.ts';
import type { CurveRecord } from './run-provenance.ts';
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
import type { FloorDisplay } from './speed-floor.ts';
import {
  VISIT_RATE,
  VisitRateGovernor,
  effectivePace,
  fmtVisitRate,
  visitRateMode,
  type VisitRateMode,
  type VisitRateSetting,
  type VisitRateSummary,
  type VisitSchedule,
} from './visit-rate.ts';
import type { SlowStatus } from '../workers/slow-types.ts';

/** A run's pacing readout and the session and gate run it belongs to. */
interface PaceReadout {
  session: number;
  epoch: number;
  stats: PaceStats | null;
}

/** What the Speed control reads from the pipeline store and its other parts. */
export interface SpeedControlDeps {
  client: Pick<PipelineClient, 'setPace' | 'subscribePaceStats'>;
  clock: () => number;
  status: Accessor<string>;
  processed: Accessor<number>;
  runHistory?: RunHistory;
  /** Frames in the open recording and whether it is a live stream (null: none open). */
  identity: () => { live?: boolean; frames?: number } | null | undefined;
  /** The look-back worker's feed (absent: look-back is not offered). */
  lookbackFeed?: LookbackFeed;
  /** Background settle's cap now (0 = Off). */
  settleCap: () => number;
  /** Tell the settle governor the pace (and start the settle pool if it may now run). */
  tellSettlePace: () => void;
  /** The smart floor as the Speed control's mark shows it. */
  floor: Accessor<FloorDisplay>;
  /** The run's top speed now, fps (0: not known). */
  runMaxFps: () => number;
}

/** The target speed, the visit rate's hold, the speed curve and Auto. */
export function createSpeedControl(deps: SpeedControlDeps) {
  const { client, clock, status, processed, runHistory, lookbackFeed, settleCap } = deps;
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
   * The Discover visit rate (`lib/visit-rate.ts`): the fixed rate by default, `?debug&visitrate=auto`
   * the Auto schedule (opt-in), `?debug&visitrate=off` none (the behaviour before). The governor of this run (null:
   * none yet, or not a Discover run) and its hold: the speed the frame loop is held to so the
   * visits keep up (null: not held); the target in force (the engine's schedule) and its yield.
   */
  const [visitRateSetting, setVisitRateSetting] = createSignal<VisitRateSetting>('fixed');
  const visitRateOff = () => visitRateSetting() === 'off';
  const [visitTarget, setVisitTarget] = createSignal<number | null>(null);
  const [visitYield, setVisitYield] = createSignal<number | null>(null);
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
    const id = deps.identity();
    return id && id.live !== true && id.frames !== undefined && Number.isFinite(id.frames)
      ? id.frames
      : 0;
  }
  function policyInput(frame: number): PolicyInput {
    const f = untrack(deps.floor);
    return {
      frame,
      totalFrames: curveFrames(),
      floorFps: f.fps,
      seeAllFps: f.estimate.seeAllFps,
      maxFps: deps.runMaxFps() || null,
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
  /** A pace was set at some point: from then on Pause and Resume always tell the gate (so its held state never sticks). */
  let paceEver = false;
  /** Whether this run's gate is paced (a recording's Discover run; never a live stream). */
  function paceRun(): boolean {
    return paceFps > 0 && deps.identity()?.live !== true;
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

  /** The Discover visit rate: every status of Discover's own run, until its last frame is read. */
  function onVisitStatus(st: SlowStatus): void {
    const gov = visitGov;
    const s = untrack(status);
    if (!gov || (st.run ?? 1) !== 1 || (s !== 'running' && s !== 'paused')) return;
    const userFps = paceRun() ? paceFps : 0;
    const vr = st.visitRate;
    const change = gov.update({
      now: pauseClock.now(clock()),
      framesRead: st.consumed ?? st.frame,
      observed: st.observed,
      visits: st.counters.visits,
      cappedFrames: vr?.cappedFrames ?? 0,
      dueTiles: vr?.dueTiles ?? 0,
      userFps,
      // The engine's schedule (`discover/visitrate.rs`): the target in force and its bounds.
      ...(vr?.target !== undefined && vr.target > 0
        ? {
            target: vr.target,
            holdFloor: vr.holdFloor,
            cap: vr.rate,
            earned: vr.earned,
            yieldSlow: vr.yieldSlow,
            yieldFast: vr.yieldFast,
            newCells: vr.fedNew,
            scheduleParams: vr.schedule,
          }
        : {}),
    });
    if (gov.achieved !== untrack(visitAchieved)) {
      setVisitAchieved(gov.achieved);
      tellVisitRate();
    }
    if (gov.target !== untrack(visitTarget)) {
      if (untrack(visitTarget) !== null)
        runHistory?.log({
          frame: untrack(processed),
          kind: 'setting',
          key: 'visit_target',
          from: untrack(visitTarget) ?? 0,
          to: gov.target,
          detail: `Discover visit rate ${fmtVisitRate(gov.target)} visits/frame (${gov.schedule ?? 'fixed'}; ${gov.yieldSlow !== null ? `${fmtVisitRate(gov.yieldSlow * 100)} new cells per 100 visits` : 'no yield yet'})`,
        });
      setVisitTarget(gov.target);
      tellVisitRate();
    }
    setVisitYield(gov.yieldSlow);
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
            : `Held at ${fmt(after)} to keep refinement at ${fmtVisitRate(gov.target)} visits/frame (was ${fmt(before)}; ${change.achieved.toFixed(2)} visits/frame)`,
      });
    }
    tellVisitRate();
  }
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
    deps.tellSettlePace();
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

  /** A run starts or stops: no curve, a fresh pause clock, no pacing readout. */
  function reset(): void {
    curveDriver = null;
    runCurve = null;
    pauseClock.reset();
    setPaceStats(null);
    paceSession = -1;
    paceEpoch = -1;
  }

  /** Pipeline session `session` starts: its pacing readouts are the ones that count. */
  function beginRun(session: number): void {
    paceSession = session;
  }

  /**
   * The run is running: the gate gets the target, and a Discover run gets this run's visit
   * governor (a live stream keeps the cap in the slow loop only).
   */
  function startRun(discover: boolean, live: boolean): void {
    if (paceRun()) sendPace({ fps: paceFps });
    setVisitHold(null);
    setVisitAchieved(null);
    setVisitTarget(null);
    setVisitYield(null);
    // The visit governor: Discover only; a live stream keeps the cap (in the slow loop) only.
    const vs = untrack(visitRateSetting);
    visitGov = discover
      ? new VisitRateGovernor(
          visitRateMode(vs === 'off', live),
          VISIT_RATE,
          vs === 'off' ? null : vs,
        )
      : null;
    setVisitMode(visitGov?.mode ?? null);
    tellVisitRate();
  }

  /** The run paused: the pause clock stops and the gate and the settle governor are told. */
  function pause(): void {
    pauseClock.pause(clock());
    // Requests already in the worker must not be released while paused.
    if (paceEver) sendPace({ paused: true });
    deps.tellSettlePace();
  }

  /** The run resumed: the pause clock runs and the gate and the settle governor are told. */
  function resume(): void {
    pauseClock.resume(clock());
    if (paceEver) sendPace({ paused: false });
    deps.tellSettlePace();
  }

  /**
   * Around a stop's reset: the stopped run's pacing readouts stay, and its final one (flushed on
   * stop) still lands. Take the readout before the reset and give it back after it.
   */
  function takePaceReadout(): PaceReadout {
    return { session: paceSession, epoch: paceEpoch, stats: paceStats() };
  }
  function restorePaceReadout(keep: PaceReadout): void {
    paceSession = keep.session;
    paceEpoch = keep.epoch;
    setPaceStats(keep.stats);
  }

  return {
    reset,
    beginRun,
    startRun,
    pause,
    resume,
    takePaceReadout,
    restorePaceReadout,
    armCurve,
    driveCurve,
    /** Discover ended: no curve steers the target any more. */
    endCurve(): void {
      curveDriver = null;
    },
    endVisitHold,
    gatePace,
    paceRun,
    /** The top speed the visits allow while the visit rate holds the run (null: not held). */
    visitMaxFps: (): number | null => visitGov?.visitMaxFps ?? null,
    onVisitStatus,
    paceStats,
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
    /** Choose a speed curve (null: none), from the run's start or mid-run. */
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
    /** The Auto budget of Auto mode (null: not Auto); a signal. */
    autoBudget: activeAuto,
    /** Choose Auto with a time budget (null: leave Auto), from the run's start or mid-run. */
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
    /** What this run's Auto decided so far (null: not an Auto run). */
    autoNow: (): { extraTimeShare: number; decisions: AutoDecision[] } | null => autoSnapshot(),
    /** Called when Auto arms and after each decision it makes. */
    onAutoChange: (cb: (a: { extraTimeShare: number; decisions: AutoDecision[] }) => void) => {
      autoListeners.push(cb);
    },
    armedCurve,
    armPolicy,
    /** The curve this run is following (null: none), as the run record keeps it. */
    curveNow: (): CurveRecord | null => (runCurve ? { ...runCurve } : null),
    /** Called when a curve takes over the target. */
    onCurveArmed: (cb: (c: CurveRecord) => void) => {
      curveListeners.push(cb);
    },
    /** The target speed now, frames per second (0: Max). */
    paceFps: () => paceFps,
    setVisitRateSetting,
    visitRateSetting,
    visitRateOff,
    visitMode,
    visitHold,
    visitAchieved,
    /** This run's schedule (`auto`, `fixed`; null: off or not a Discover run). */
    visitSchedule: (): VisitSchedule | null => {
      visitMode();
      return visitGov?.schedule ?? null;
    },
    visitTarget,
    visitYield,
    /** `gatePace` as a tracked read (the visit hold and the target are signals). */
    gatePaceTracked: () => {
      visitHold();
      paceTarget();
      return gatePace();
    },
    /** Called with the visit-rate summary as it changes and when Discover ends. */
    onVisitRate: (cb: (s: VisitRateSummary) => void) => {
      visitListeners.push(cb);
    },
    paceTarget,
    paceFromUrl,
    /** The target speed this run is paced at (0: Max, and always 0 for a live stream). */
    targetNow: () => (paceRun() ? paceFps : 0),
    /** Called with the new target speed, the frame reached and what set it, whenever it is set. */
    onPaceChange: (cb: (fps: number, frame: number, source: string) => void) => {
      paceListeners.push(cb);
    },
  };
}

/** The pipeline store's Speed control. */
export type SpeedControl = ReturnType<typeof createSpeedControl>;
