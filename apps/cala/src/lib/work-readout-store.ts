/**
 * The work readout on the main thread, for the pipeline store: work shares (`lib/work-meter.ts`)
 * from the slow worker's accounting once a second, the fast loop's live estimate of its top speed,
 * and the smart floor (`lib/speed-floor.ts`). Instrumentation, except the floor and the top
 * speed: the Speed control's mark and the Auto policy read them.
 */
import { createSignal, untrack, type Accessor } from 'solid-js';
import type { PaceStats } from './frame-pacer.ts';
import type { StageTimings } from './pipeline-types.ts';
import type { RunHistory } from './run-history.ts';
import type { WorkSample } from './run-provenance.ts';
import { FloorMeter, NEED_RATE, floorText, type FloorDisplay } from './speed-floor.ts';
import { heldMaxFps } from './visit-rate.ts';
import {
  BirthRate,
  MaxFpsEstimator,
  StageBusyMeter,
  WorkRater,
  type WorkRates,
  type WorkStatus,
} from './work-meter.ts';
import type { SlowStatus } from '../workers/slow-types.ts';

/** Shortest last interval closed at Discover's end, ms: shorter ones are too noisy to show. */
const TAIL_MIN_MS = 200;

/** What the work readout reads from the pipeline store and the Speed control. */
export interface WorkReadoutDeps {
  clock: () => number;
  status: Accessor<string>;
  processed: Accessor<number>;
  runHistory?: RunHistory;
  /** The pace the frame gate is held to now (0: Max). */
  gatePace: () => number;
  /** The frame worker's newest pacing readout. */
  paceStats: Accessor<PaceStats | null>;
  /** The top speed the visits allow while the visit rate holds the run (null: not held). */
  visitMaxFps: () => number | null;
}

/** Work shares, the top-speed estimate and the smart floor of the current run. */
export function createWorkReadout(deps: WorkReadoutDeps) {
  const { clock, status, processed, runHistory, gatePace, paceStats } = deps;
  /** Told about the work and the floor about once a second (the run record's log). */
  const workSampleListeners: ((s: WorkSample) => void)[] = [];
  /** Frames the fast loop did not forward to the slow loop, as of the last batch (this run). */
  let forwardDrops: number | null = null;
  const workRater = new WorkRater();
  const maxFpsEstimator = new MaxFpsEstimator();
  /**
   * The top speed the run can reach, fps (0: not known): the fast loop's estimate, lowered to what
   * the visits allow while the visit rate holds the run (`heldMaxFps`). What the Speed block calls
   * Max, the floor clamps to, curves and Auto plan with and the run record's Max median counts.
   */
  function runMaxFps(): number {
    return heldMaxFps(maxFpsEstimator.estimate(), deps.visitMaxFps());
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
  // The smart floor estimate (`lib/speed-floor.ts`): the Speed control's floor mark and the Auto policy's input (`policyInput`).
  const floorMeter = new FloorMeter();
  const [floorLine, setFloorLine] = createSignal('');
  /** The floor as the Speed control's mark shows it (the prior until a measurement). */
  const [floor, setFloor] = createSignal<FloorDisplay>(floorMeter.display());
  /** Measurement only: the slow worker's newest raw accounting (cumulative; `__cala.pipeline.accounting()`). */
  let lastAccounting: WorkStatus | null = null;
  /** The first reading after Discover's last frame has been written to History (once per run). */
  let tailClosed = false;

  /** A slow-loop status: the accounting, the floor, the work shares and the top speed. */
  function onStatus(st: SlowStatus): void {
    if (!st.accounting) return;
    lastAccounting = st.accounting;
    // The rater's first snapshot opens the first reading's interval (History's work plot starts there).
    if (untrack(status) !== 'done') runHistory?.workOpen();
    // Throttled to about 1 Hz inside the meter: no per-batch work for the floor estimate.
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
    // After Discover's last frame the first reading closes early (at least `TAIL_MIN_MS`), so the
    // work plot reaches the end of the recording; it holds the slow loop's catch-up and the start
    // of the Final settle, each in its own kind.
    const done = untrack(status) === 'done';
    const tail = done && !tailClosed;
    const rates = workRater.push(st.accounting, tail ? TAIL_MIN_MS : undefined);
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
    // Not after Discover's last frame, but for the tail (stream time stands still; see `RunHistory.work`).
    if (!done || tail) {
      tailClosed ||= tail;
      // The history's series is the fast loop's own top speed (`fast_max_fps`).
      runHistory?.work(rates, maxFpsEstimator.estimate());
      runHistory?.target(gatePace());
    }
  }

  /** A slow-loop status: the births per frame for History. */
  function onBirths(st: SlowStatus): void {
    const births = birthRate.push(st.frame, st.counters.adds);
    if (births !== null && untrack(status) !== 'done') runHistory?.births(st.frame, births);
  }

  /** A batch of `count` frames: the top-speed estimate and the stage busy times. */
  function noteBatch(count: number, stageBusyMs: number[] | undefined, t: StageTimings): void {
    setMaxFps(
      maxFpsEstimator.record(
        count,
        stageBusyMs ?? [t.readMs + t.preprocessMs + t.motionMs + t.otherMs + t.traceMs],
      ),
    );
    if (stageBusyMs) stageBusyMeter.record(stageBusyMs);
  }

  /** A run starts or stops: every meter and readout is cleared. */
  function reset(): void {
    forwardDrops = null;
    tailClosed = false;
    lastAccounting = null;
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
  }

  return {
    onStatus,
    onBirths,
    noteBatch,
    reset,
    /** Frames the fast loop did not forward to the slow loop, as of the batch just in. */
    noteForwardDrops(n: number): void {
      forwardDrops = n;
    },
    /** The run's stages begin: the stage busy meter's clock starts now. */
    start(): void {
      stageBusyMeter.start(clock());
    },
    work,
    /** Measurement only: the slow worker's newest raw cumulative accounting. */
    accounting: (): WorkStatus | null => lastAccounting,
    floorLine,
    floor,
    maxFps,
    workMaxFps,
    workFastMaxFps,
    workMaxVisitLimited,
    runMaxFps,
    /** Called about once a second while the slow loop reports. */
    onWorkSample: (cb: (s: WorkSample) => void) => {
      workSampleListeners.push(cb);
    },
  };
}

/** The pipeline store's work readout. */
export type WorkReadout = ReturnType<typeof createWorkReadout>;
