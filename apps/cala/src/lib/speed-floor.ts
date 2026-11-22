/**
 * The smart floor of the Speed control (`beta_speed_control_design.md`,
 * section 2): the highest speed at which every user of spare compute (Background settle,
 * need-driven look-back, the slow loop, the visit workers) is fully served.
 * Below it, going slower only adds idle time.
 *
 * Everything here is pure (clocks are passed in), so it is unit-tested:
 * `speedFloor` (the function), `workCapacities` (the inputs, from two
 * `WorkStatus` snapshots), `FloorTracker` (averaging, ladder snapping,
 * hysteresis) and `FloorMeter` (the glue the `?debug` readout uses).
 * It steers nothing yet.
 */

import { LOOKBACK_KINDS, type LookbackWork, type WorkStatus } from './work-meter.ts';

export interface FloorInputs {
  /** Re-read frames per live frame; 0 = Background settle off. */
  cap: number;
  /** Need-driven frames asked per observed frame (`LOOKBACK.rate`), and the share of recent time cells were in need (0..1). */
  needRate: number;
  needActive: number;
  /** Settle look-back workers besides worker 0 (0: one worker takes turns). */
  settleWorkers: number;
  /** Frames per second one look-back worker delivers while busy; null = not measured. */
  needFpsPerWorker: number | null;
  settleFpsPerWorker: number | null;
  /** Slow worker, ms per observed live frame: observing, housekeeping, publishing; visit hand-out and apply. */
  slowLiveMs: number | null;
  slowVisitMs: number | null;
  /** Slow worker, ms per re-read frame it takes in. */
  slowNeedMs: number | null;
  slowSettleMs: number | null;
  /** Visit workers, and their summed busy ms per observed live frame; null = saturated or not measured. */
  visitWorkers: number;
  visitMs: number | null;
  /** Live estimate of Max, fps; null = unknown. */
  maxFps: number | null;
  /** How the capacities were measured: affects `confidence` and the correction. */
  measuredAt: 'none' | 'unpaced' | 'paced';
}

export interface FloorEstimate {
  /** The floor, fps, after the hard minimum and the Max clamp. */
  fps: number;
  /** The rate below which the slow loop sees every live frame (the slow-worker term with the cap at 0), same clamps. */
  seeAllFps: number;
  /** Which user set it. */
  limiting: 'look-back' | 'slow-worker' | 'visits' | 'minimum' | 'max';
  /** Each term's saturation rate, fps (null = not known or dropped), for the tooltip, the record and the tests. */
  terms: {
    lookbackNeed: number | null;
    lookbackSettle: number | null;
    slowWorker: number | null;
    visits: number | null;
  };
  confidence: 'prior' | 'unpaced' | 'paced';
}

export const FLOOR = {
  hardMinFps: 10,
  /** Share of a worker's time it can be busy and still count as keeping up. */
  slowUtil: 0.85,
  lookbackUtil: 0.9,
  visitUtil: 0.9,
  /** The slow worker's costs measured unpaced read low: its term is scaled by this. */
  unpacedFactor: 0.75,
  /** With nothing measured. */
  priorFps: { turnTaking: 20, pool: 30 },
  /** The floor never sits above this share of the live Max estimate. */
  maxShare: 0.9,
  /** Visits are reported but do not set the floor. */
  visitsBind: false,
} as const;

/** Constants of `speedFloor`; `visitsBind` is a plain boolean so tests can switch it. */
export type FloorConstants = Omit<typeof FLOOR, 'visitsBind'> & { visitsBind: boolean };

const pos = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 0;

export function speedFloor(i: FloorInputs, k: FloorConstants = FLOOR): FloorEstimate {
  const n = i.needRate * i.needActive;
  const c = i.cap;
  const S = i.settleWorkers;
  const unpaced = i.measuredAt === 'unpaced' ? k.unpacedFactor : 1;

  // Look-back terms. A term with nothing asking (n = 0 or c = 0 in its denominator) is dropped.
  let lookbackNeed: number | null = null;
  let lookbackSettle: number | null = null;
  const L = i.needFpsPerWorker;
  if (S <= 0) {
    if (pos(L) && n + c > 0) lookbackNeed = (k.lookbackUtil * L) / (n + c);
  } else {
    if (pos(L) && n > 0) lookbackNeed = (k.lookbackUtil * L) / n;
    if (pos(i.settleFpsPerWorker) && c > 0)
      lookbackSettle = (k.lookbackUtil * S * i.settleFpsPerWorker) / c;
  }

  // Slow worker: ms per observed live frame at full service. A needed cost that is
  // unknown makes the term unknown (never silently zero).
  const slowDenom = (cap: number): number | null => {
    if (i.slowLiveMs === null || i.slowVisitMs === null) return null;
    let d = i.slowLiveMs + i.slowVisitMs;
    if (n > 0) {
      if (i.slowNeedMs === null) return null;
      d += n * i.slowNeedMs;
    }
    if (cap > 0) {
      if (i.slowSettleMs === null) return null;
      d += cap * i.slowSettleMs;
    }
    return d;
  };
  const slowRate = (cap: number): number | null => {
    const d = slowDenom(cap);
    return d !== null && d > 0 ? ((k.slowUtil * 1000) / d) * unpaced : null;
  };
  const slowWorker = slowRate(c);
  const seeAllRaw = slowRate(0);

  const visits =
    pos(i.visitMs) && i.visitWorkers > 0 ? (k.visitUtil * i.visitWorkers * 1000) / i.visitMs : null;

  const terms = { lookbackNeed, lookbackSettle, slowWorker, visits };
  const binding: [number, FloorEstimate['limiting']][] = [];
  if (lookbackNeed !== null) binding.push([lookbackNeed, 'look-back']);
  if (lookbackSettle !== null) binding.push([lookbackSettle, 'look-back']);
  if (slowWorker !== null) binding.push([slowWorker, 'slow-worker']);
  if (k.visitsBind && visits !== null) binding.push([visits, 'visits']);

  let raw: number;
  let limiting: FloorEstimate['limiting'];
  let confidence: FloorEstimate['confidence'];
  if (binding.length === 0) {
    raw = S > 0 ? k.priorFps.pool : k.priorFps.turnTaking;
    limiting = 'look-back';
    confidence = 'prior';
  } else {
    [raw, limiting] = binding.reduce((a, b) => (b[0] < a[0] ? b : a));
    confidence = i.measuredAt === 'paced' ? 'paced' : 'unpaced';
  }

  const clamp = (v: number, from: FloorEstimate['limiting']) => {
    let out = v;
    let why = from;
    if (pos(i.maxFps) && k.maxShare * i.maxFps < out) {
      out = k.maxShare * i.maxFps;
      why = 'max';
    }
    if (out < k.hardMinFps) {
      out = k.hardMinFps;
      why = 'minimum';
    }
    return { out, why };
  };
  const main = clamp(raw, limiting);
  // Not known (a cost missing): no better than the floor itself.
  const seeAll = clamp(seeAllRaw ?? raw, limiting).out;
  return {
    fps: main.out,
    seeAllFps: Math.max(seeAll, main.out),
    limiting: main.why,
    terms,
    confidence,
  };
}

// ---- the inputs, from two snapshots ----

/** What `workCapacities` measures; the rest of `FloorInputs` is settings and state. */
export type WorkCapacities = Pick<
  FloorInputs,
  | 'needFpsPerWorker'
  | 'settleFpsPerWorker'
  | 'slowLiveMs'
  | 'slowVisitMs'
  | 'slowNeedMs'
  | 'slowSettleMs'
  | 'visitWorkers'
  | 'visitMs'
  | 'settleWorkers'
> & {
  /** Wall time and observed live frames the snapshot pair spans. */
  spanMs: number;
  observedFrames: number;
};

export const CAPACITY = {
  /** The snapshots must be at least this far apart, ms. */
  minSpanMs: 5000,
  /** Worker 0 must have been busy on need answers at least this share of the span. */
  needMinBusyShare: 0.2,
  /** The settle pool must have been busy at least this long to give a rate, ms. */
  settleMinBusyMs: 250,
  /** Mean visit busy share above this counts as saturated: the cost is not known. */
  visitSaturated: 0.85,
  /** `slowSettleMs` with no settle and no end figure, as a share of `slowLiveMs`. */
  settleFallbackShare: 0.55,
} as const;

const lbBusyMs = (w: LookbackWork) => w.readMs + w.preprocessMs + w.solveMs + w.otherMs;

/**
 * The measured capacities between two snapshots of the same run (`prev` before
 * `cur`, at least `minSpanMs` apart). `null` when the pair is too close, went
 * backwards (a new run), lacks `observedFrames`, or saw no observed frame.
 * `priorSettleFps`: the Final settle's `end` rate from an earlier run, used
 * when no settle answer was measured here.
 */
export function workCapacities(
  prev: WorkStatus,
  cur: WorkStatus,
  opts: { minSpanMs?: number; priorSettleFps?: number | null } = {},
): WorkCapacities | null {
  const spanMs = cur.wallMs - prev.wallMs;
  if (!(spanMs >= (opts.minSpanMs ?? CAPACITY.minSpanMs))) return null;
  if (cur.observedFrames === undefined || prev.observedFrames === undefined) return null;
  const obs = cur.observedFrames - prev.observedFrames;
  if (!(obs > 0)) return null;
  const busy = (d: keyof WorkStatus['busyMs']) => Math.max(0, cur.busyMs[d] - prev.busyMs[d]);
  const lb = (kind: (typeof LOOKBACK_KINDS)[number]) => {
    const a = prev.lookback[kind];
    const b = cur.lookback[kind];
    return {
      frames: Math.max(0, b.frames - a.frames),
      busyMs: Math.max(0, lbBusyMs(b) - lbBusyMs(a)),
    };
  };
  const need = lb('need');
  const csettle = lb('csettle');
  const end = lb('end');

  const needFps =
    need.frames > 0 && need.busyMs >= CAPACITY.needMinBusyShare * spanMs
      ? (need.frames * 1000) / need.busyMs
      : null;
  const settleMeasured =
    csettle.frames > 0 && csettle.busyMs >= CAPACITY.settleMinBusyMs
      ? (csettle.frames * 1000) / csettle.busyMs
      : null;
  const settleFps = settleMeasured ?? opts.priorSettleFps ?? needFps;

  const slowLiveMs = (busy('live') + busy('housekeep') + busy('publish')) / obs;
  // Per frame of that kind the slow worker took in.
  const perFrame = (ms: number, frames: number) => (frames > 0 ? ms / frames : null);
  const slowSettleMs =
    perFrame(busy('csettle'), csettle.frames) ??
    perFrame(busy('end'), end.frames) ??
    CAPACITY.settleFallbackShare * slowLiveMs;

  const visitWorkers = cur.visitBusyMs.length;
  let visitMs: number | null = null;
  if (visitWorkers > 0) {
    const sum = cur.visitBusyMs.reduce(
      (s, v, i) => s + Math.max(0, v - (prev.visitBusyMs[i] ?? 0)),
      0,
    );
    visitMs = sum / (spanMs * visitWorkers) > CAPACITY.visitSaturated ? null : sum / obs;
  }

  return {
    needFpsPerWorker: needFps,
    settleFpsPerWorker: settleFps,
    slowLiveMs,
    slowVisitMs: busy('visit') / obs,
    slowNeedMs: perFrame(busy('need'), need.frames),
    slowSettleMs,
    visitWorkers,
    visitMs,
    settleWorkers: cur.settleWorkers ?? Math.max(0, (cur.lookbackWorkerBusyMs?.length ?? 1) - 1),
    spanMs,
    observedFrames: obs,
  };
}

// ---- the tracker ----

/** The published ladder: the floor snaps down to one of these. */
export const FLOOR_LADDER = [
  10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300,
] as const;

/** The largest ladder step at or below `fps` (the smallest one when below all). */
export function snapToLadder(fps: number): number {
  let out: number = FLOOR_LADDER[0];
  for (const s of FLOOR_LADDER) if (s <= fps) out = s;
  return out;
}

export const TRACKER = {
  /** Inputs are averaged over this long, ms. */
  averageMs: 30_000,
  /** The function is evaluated this often, ms. */
  evalEveryMs: 5000,
  /** Evaluations in a row past the next step before the published floor moves. */
  confirm: 3,
} as const;

const NUMERIC_NULLABLE = [
  'needFpsPerWorker',
  'settleFpsPerWorker',
  'slowLiveMs',
  'slowVisitMs',
  'slowNeedMs',
  'slowSettleMs',
  'visitMs',
  'maxFps',
  'needActive',
] as const satisfies readonly (keyof FloorInputs)[];

/**
 * Averages the inputs over 30 s, evaluates `speedFloor` every 5 s, and
 * publishes a ladder step that moves only after three evaluations in a row
 * past the next step (a step up needs the raw floor at the next step; a step
 * down needs it below the step beneath). Frozen (keeps its value, takes no
 * samples) while `frozen`.
 */
export class FloorTracker {
  private samples: { t: number; i: FloorInputs }[] = [];
  private lastEval = Number.NEGATIVE_INFINITY;
  private published_: number | null = null;
  private estimate_: FloorEstimate | null = null;
  private streak = 0;
  private dir: -1 | 0 | 1 = 0;

  constructor(
    private readonly k: FloorConstants = FLOOR,
    private readonly cfg: { averageMs: number; evalEveryMs: number; confirm: number } = TRACKER,
  ) {}

  /** The published (snapped) floor, fps; null before the first evaluation. */
  get published(): number | null {
    return this.published_;
  }

  /** The last raw evaluation of the averaged inputs. */
  get estimate(): FloorEstimate | null {
    return this.estimate_;
  }

  /** Start from a floor known from an earlier run on the same recording. */
  seed(fps: number): void {
    this.published_ = snapToLadder(fps);
  }

  /**
   * Take a sample at time `t` (ms, any clock that only goes forward). Returns
   * true when the published floor changed.
   */
  update(t: number, inputs: FloorInputs, frozen = false): boolean {
    if (frozen) {
      this.streak = 0;
      this.dir = 0;
      return false;
    }
    this.samples.push({ t, i: inputs });
    while (this.samples.length > 0 && t - this.samples[0].t > this.cfg.averageMs)
      this.samples.shift();
    if (t - this.lastEval < this.cfg.evalEveryMs) return false;
    this.lastEval = t;
    const est = speedFloor(this.average(), this.k);
    this.estimate_ = est;
    return this.publish(est.fps);
  }

  private publish(raw: number): boolean {
    const p = this.published_;
    if (p === null) {
      this.published_ = snapToLadder(raw);
      return true;
    }
    const idx = FLOOR_LADDER.indexOf(p as (typeof FLOOR_LADDER)[number]);
    const next = FLOOR_LADDER[Math.min(FLOOR_LADDER.length - 1, idx + 1)];
    const below = FLOOR_LADDER[Math.max(0, idx - 1)];
    const dir: -1 | 0 | 1 = raw >= next && next > p ? 1 : raw < below && below < p ? -1 : 0;
    if (dir === 0 || dir !== this.dir) this.streak = 0;
    this.dir = dir;
    if (dir === 0) return false;
    this.streak++;
    if (this.streak < this.cfg.confirm) return false;
    this.streak = 0;
    this.dir = 0;
    this.published_ = snapToLadder(raw);
    return true;
  }

  private average(): FloorInputs {
    const last = this.samples[this.samples.length - 1].i;
    const out: FloorInputs = { ...last };
    for (const key of NUMERIC_NULLABLE) {
      let sum = 0;
      let n = 0;
      for (const s of this.samples) {
        const v = s.i[key];
        if (v !== null) {
          sum += v;
          n++;
        }
      }
      (out as unknown as Record<string, number | null>)[key] = n > 0 ? sum / n : null;
    }
    return out;
  }

  reset(): void {
    this.samples = [];
    this.lastEval = Number.NEGATIVE_INFINITY;
    this.published_ = null;
    this.estimate_ = null;
    this.streak = 0;
    this.dir = 0;
  }
}

// ---- the glue for the `?debug` readout ----

/** Need-driven frames asked per observed frame: mirrors `LOOKBACK.rate` in `slow-runner.ts` (a test keeps them equal). */
export const NEED_RATE = 2;

/** What a slow status gives the meter besides its accounting. */
export interface FloorFeed {
  work: WorkStatus;
  /** Cells that still need look-back frames (`LookbackStatus.inNeed`). */
  inNeed: number;
  /** The settle cap, re-read frames per live frame (0: Background settle off). */
  cap: number;
  /** The look-back request rate, frames per observed frame (`LOOKBACK.rate`). */
  needRate: number;
  /** Pacer target in fps (0: Max). */
  target: number;
  maxFps: number | null;
  paused: boolean;
  /** The governor's limit; `discover` and `backing-off` freeze the floor. */
  governorLimit?: string;
  /** A library has been published. */
  haveLibrary: boolean;
}

/**
 * Keeps the snapshot history and the "cells in need" history, builds the
 * inputs and feeds the tracker. Pure: the clock is the slow worker's wall time.
 */
export class FloorMeter {
  readonly tracker: FloorTracker;
  private snaps: WorkStatus[] = [];
  private needSeen: { t: number; inNeed: boolean }[] = [];
  /** When the target went below Max (null: at Max); the span is `paced` only if it began after this. */
  private pacedSince: number | null = null;
  /** Latest inputs (for the readout). */
  last: FloorInputs | null = null;

  constructor(
    k: FloorConstants = FLOOR,
    private readonly opts: { needWindowMs: number; priorSettleFps?: number | null } = {
      needWindowMs: 60_000,
    },
  ) {
    this.tracker = new FloorTracker(k);
  }

  /** Feed one slow status. Returns true when the published floor changed. */
  push(f: FloorFeed): boolean {
    const w = f.work;
    const t = w.wallMs;
    const prevSnap = this.snaps[this.snaps.length - 1];
    if (prevSnap && t < prevSnap.wallMs) this.restart();
    this.snaps.push(w);
    // Keep about 10 s of snapshots: the reference is the newest one at least the minimum span old.
    while (this.snaps.length > 2 && t - this.snaps[1].wallMs >= 2 * CAPACITY.minSpanMs)
      this.snaps.shift();

    if (f.target > 0) {
      this.pacedSince ??= t;
    } else {
      this.pacedSince = null;
    }
    this.needSeen.push({ t, inNeed: f.inNeed > 0 });
    while (this.needSeen.length > 0 && t - this.needSeen[0].t > this.opts.needWindowMs)
      this.needSeen.shift();

    const frozen =
      f.paused ||
      !f.haveLibrary ||
      f.governorLimit === 'discover' ||
      f.governorLimit === 'backing-off';

    let ref: WorkStatus | undefined;
    for (const s of this.snaps) if (t - s.wallMs >= CAPACITY.minSpanMs) ref = s;
    const cap = ref ? workCapacities(ref, w, { priorSettleFps: this.opts.priorSettleFps }) : null;
    if (!cap) return false;
    const spanStart = t - cap.spanMs;
    const wholeSpan = f.target > 0 ? (this.pacedSince ?? t) <= spanStart : false;
    const needActive =
      this.needSeen.length > 0
        ? this.needSeen.filter((s) => s.inNeed).length / this.needSeen.length
        : 0;
    const inputs: FloorInputs = {
      cap: f.cap,
      needRate: f.needRate,
      needActive,
      settleWorkers: cap.settleWorkers,
      needFpsPerWorker: cap.needFpsPerWorker,
      settleFpsPerWorker: cap.settleFpsPerWorker,
      slowLiveMs: cap.slowLiveMs,
      slowVisitMs: cap.slowVisitMs,
      slowNeedMs: cap.slowNeedMs,
      slowSettleMs: cap.slowSettleMs,
      visitWorkers: cap.visitWorkers,
      visitMs: cap.visitMs,
      maxFps: f.maxFps !== null && f.maxFps > 0 ? f.maxFps : null,
      measuredAt: wholeSpan ? 'paced' : 'unpaced',
    };
    this.last = inputs;
    return this.tracker.update(t, inputs, frozen);
  }

  private restart(): void {
    this.snaps = [];
    this.needSeen = [];
    this.pacedSince = null;
    this.last = null;
  }

  reset(): void {
    this.restart();
    this.tracker.reset();
  }
}

const rate = (x: number | null) => (x === null ? '-' : x.toFixed(0));

/** The floor's lines of the `?debug` readout: value, who sets it, how sure, and each term. */
export function floorText(m: FloorMeter | null): string {
  const e = m?.tracker.estimate;
  if (!m || !e) return 'floor: not measured yet (needs 5 s of data and a library)';
  const p = m.tracker.published;
  const conf =
    e.confidence === 'prior'
      ? 'prior, not measured'
      : e.confidence === 'unpaced'
        ? 'measured at Max'
        : 'measured paced';
  const t = e.terms;
  return (
    `floor ${p ?? '-'} fps (raw ${e.fps.toFixed(1)}) · set by ${e.limiting} · ${conf} · sees every frame below ${e.seeAllFps.toFixed(0)}\n` +
    `        terms: look-back need ${rate(t.lookbackNeed)} settle ${rate(t.lookbackSettle)} · slow worker ${rate(t.slowWorker)} · visits ${rate(t.visits)} (reported only)`
  );
}
