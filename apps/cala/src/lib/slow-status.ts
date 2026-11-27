/**
 * The slow loop's status views: pure functions from the `SlowRunner`'s state
 * (passed in) to the `SlowStatus` parts the main thread reads. None reads a
 * clock or posts anything; the runner gathers their inputs.
 */
import type {
  CsettleStatus,
  LookbackStatus,
  SettleStatus,
  SettleVisits,
} from '../workers/lookback-types.ts';
import type { CellStatusView, SlowCounters } from '../workers/slow-types.ts';
import type { SettleGovernor } from './settle.ts';
import type { SlowLoopLike } from './slow-runner.ts';
import type {
  DetailTimer,
  DutyClock,
  LookbackKind,
  LookbackWork,
  SlowDuty,
  WindowMax,
  WorkStatus,
} from './work-meter.ts';
import { LOOKBACK_KINDS } from './work-meter.ts';

/** `SlowLoop.stats()` as named counters. */
export function counters(s: ArrayLike<number>): SlowCounters {
  return {
    visits: s[0] ?? 0,
    proposals: s[1] ?? 0,
    adds: s[2] ?? 0,
    rejects: s[3] ?? 0,
    merges: s[4] ?? 0,
    mergeTests: s[5] ?? 0,
    refines: s[6] ?? 0,
    commits: s[7] ?? 0,
    deletes: s[8] ?? 0,
    splits: s[9] ?? 0,
    absorbs: s[10] ?? 0,
    newAdds: s[11] ?? 0,
    reAdds: s[12] ?? 0,
    churned: s[13] ?? 0,
    establishedRemovals: s[15] ?? 0,
    reviewAdds: s[16] ?? 0,
  };
}

/** `SlowLoop.cellStatus()` (`(id, established, transients)` triples) as ids and flags. */
export function cellStatusView(flat: ArrayLike<number>): CellStatusView {
  const n = Math.floor(flat.length / 3);
  const ids = new Uint32Array(n);
  const established = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    ids[i] = flat[3 * i];
    established[i] = flat[3 * i + 1] > 0 ? 1 : 0;
  }
  return { ids, established };
}

/** What `settleView` reads of a Final settle in progress. */
export interface SettleProgress {
  readonly fed: number;
  readonly feed: { readonly total: number };
  readonly recording: number;
  readonly moving: { cells: number; above: number } | null;
  readonly stop: boolean;
  readonly served: ReadonlySet<number>;
  readonly v: SettleVisits;
}

/** The Final settle's status; `parallel`: visit workers (the settle's visits are reported). */
export function settleView(
  d: SettleProgress,
  done: boolean,
  run: { parallel: boolean; factorLive: boolean; fileReason: string | undefined },
): SettleStatus {
  return {
    fed: d.fed,
    total: d.feed.total,
    recording: d.recording,
    moving: d.moving,
    stopped: d.stop,
    done,
    workers: d.served.size,
    ...(run.parallel ? { visits: { ...d.v } } : {}),
    ...(run.factorLive
      ? { source: 'factors' as const }
      : run.fileReason !== undefined
        ? { source: 'file' as const, fileReason: run.fileReason }
        : {}),
  };
}

/**
 * The Final settle's status while it waits for the factors (`recording`: the
 * frames Discover consumed; `file`: a recording's `?factors=file` ask).
 */
export function waitView(recording: number, file: boolean): SettleStatus {
  return {
    fed: 0,
    total: 0,
    recording,
    moving: null,
    stopped: false,
    done: false,
    ...(file ? {} : { source: 'factors' as const }),
    waiting: true,
  };
}

/** Look-back's status from `SlowLoop.lookbackStats()` and the settles' views. */
export function lookbackStatus(
  s: ArrayLike<number>,
  parts: {
    settling: boolean;
    settle: SettleStatus | undefined;
    csettle: CsettleStatus | undefined;
    error: string | undefined;
  },
): LookbackStatus {
  return {
    requested: s[0] ?? 0,
    pushed: s[1] ?? 0,
    heldOut: s[2] ?? 0,
    dropped: s[3] ?? 0,
    births: s[4] ?? 0,
    inNeed: s[5] ?? 0,
    recordBytes: s[6] ?? 0,
    settling: parts.settling,
    drainSteps: 0,
    capped: false,
    ...(parts.settle ? { settle: parts.settle } : {}),
    ...(parts.csettle ? { csettle: parts.csettle } : {}),
    ...(parts.error !== undefined ? { error: parts.error } : {}),
  };
}

/** What `bgSettleStatus` reads of a Background settle that is armed. */
export interface BgSettleProgress {
  readonly gov: Pick<SettleGovernor, 'cap' | 'status'>;
  readonly requested: number;
  readonly dropped: number;
  readonly live: number;
  readonly answers: number;
  readonly answerMs: number;
  readonly maxBlockMs: number;
  readonly yieldFrames: number;
}

/**
 * The Background settle's status from `SlowLoop.settleStats()` (`s`), the
 * runner's counts and the settle pool's size (`settleWorkers`).
 */
export function bgSettleStatus(
  s: ArrayLike<number>,
  bgs: BgSettleProgress,
  settleWorkers: number,
): CsettleStatus {
  return {
    rate: bgs.gov.cap,
    requested: bgs.requested,
    fit: s[1] ?? 0,
    heldOut: s[2] ?? 0,
    dropped: (s[3] ?? 0) + bgs.dropped,
    live: bgs.live,
    answers: bgs.answers,
    answerMs: bgs.answerMs,
    maxBlockMs: bgs.maxBlockMs,
    yieldFrames: bgs.yieldFrames,
    settleWorkers,
    governor: bgs.gov.status(),
  };
}

/** What `workStatus` reads: the runner's work accounting at time `t` (ms, its clock). */
export interface WorkSource {
  t: number;
  workT0: number;
  clock: DutyClock<SlowDuty>;
  waitN: number;
  waitSum: number;
  waitLast: number;
  waitMax: WindowMax;
  visitBusy: number[];
  lbWork: Record<LookbackKind, LookbackWork>;
  lbDiscarded: LookbackWork;
  /** Ports to the look-back workers (null or a hole: not connected). */
  lbPorts: readonly unknown[];
  lbPortBusy: number[];
  settleWorkers: number;
  observed: number;
  /** Debug timing (`?debug`); with it, the loop's WASM stage timers are read too. */
  dt: DetailTimer | null;
  loop: Pick<SlowLoopLike, 'stageTiming'> | null;
}

/** The work accounting so far (`SlowStatus.accounting`): the clock's buckets, the visit workers' sums, the look-back answers. */
export function workStatus(w: WorkSource): WorkStatus {
  const t = w.t;
  return {
    wallMs: t - w.workT0,
    busyMs: w.clock.snapshot(),
    batchWait: {
      batches: w.waitN,
      sumMs: w.waitSum,
      lastMs: w.waitLast,
      max1sMs: w.waitMax.max(t),
    },
    visitBusyMs: w.visitBusy.slice(),
    lookback: Object.fromEntries(LOOKBACK_KINDS.map((k) => [k, { ...w.lbWork[k] }])) as Record<
      LookbackKind,
      LookbackWork
    >,
    discarded: { ...w.lbDiscarded },
    lookbackWorkerBusyMs: w.lbPorts.map((p, i) => (p ? (w.lbPortBusy[i] ?? 0) : 0)),
    settleWorkers: w.settleWorkers,
    observedFrames: w.observed,
    ...(w.dt
      ? {
          detail: { ...w.dt.sums },
          ...(w.loop ? { stage: Array.from(w.loop.stageTiming()) } : {}),
        }
      : {}),
  };
}
