/**
 * Who is doing what: busy and idle accounting for the cala workers (the
 * slow worker, the visit workers, the look-back worker, the fast loop), with
 * no effect on any decision. The workers report cumulative milliseconds
 * with every slow status (about once per batch; the messages already flow,
 * `SlowStatus.accounting`); the main thread turns two snapshots about a second
 * apart into shares
 * (`workRates`), shows them in the `?debug` readout and keeps them in the run
 * history. See `work_slider_design.md`, section 6.
 *
 * Everything here is pure (clocks are passed in), so it is unit-tested.
 */

/** What the slow worker spends its time on (`SlowRunner`); whatever is left of the wall time is idle. */
export const SLOW_DUTIES = [
  'live',
  'visit',
  'housekeep',
  'need',
  'csettle',
  'end',
  'publish',
  'setup',
] as const;
export type SlowDuty = (typeof SLOW_DUTIES)[number];

/** The kinds of look-back request (`SlowRunner`): need-driven, settle during Discover, the end settle. */
export const LOOKBACK_KINDS = ['need', 'csettle', 'end'] as const;
export type LookbackKind = (typeof LOOKBACK_KINDS)[number];

/**
 * Exclusive busy time by duty. `begin` and `end` nest: time inside an inner
 * span goes to the inner duty only, so the buckets never overlap and their
 * sum never exceeds the wall time. Time outside every span is idle (the
 * reader's wall minus the sum).
 */
export class DutyClock<K extends string> {
  private readonly totals: Record<string, number> = {};
  private stack: K[] = [];
  private mark: number;

  constructor(
    private readonly duties: readonly K[],
    private readonly now: () => number,
  ) {
    for (const d of duties) this.totals[d] = 0;
    this.mark = now();
  }

  private charge(): void {
    const t = this.now();
    const top = this.stack[this.stack.length - 1];
    if (top !== undefined) this.totals[top] += t - this.mark;
    this.mark = t;
  }

  /** Time from now goes to `duty` until the matching `end`. */
  begin(duty: K): void {
    this.charge();
    this.stack.push(duty);
  }

  end(): void {
    this.charge();
    this.stack.pop();
  }

  /** Run `fn` as a span of `duty` (ended even if it throws). */
  span<T>(duty: K, fn: () => T): T {
    this.begin(duty);
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  /** Cumulative ms by duty up to now (a span still open is charged up to now). */
  snapshot(): Record<K, number> {
    this.charge();
    return { ...this.totals } as Record<K, number>;
  }

  /** A new run: zero everything, no open span. */
  reset(): void {
    for (const d of this.duties) this.totals[d] = 0;
    this.stack = [];
    this.mark = this.now();
  }
}

/** The largest value pushed within the last `windowMs`. */
export class WindowMax {
  private samples: { t: number; v: number }[] = [];

  constructor(private readonly windowMs = 1000) {}

  push(t: number, v: number): void {
    this.samples.push({ t, v });
    this.prune(t);
  }

  /** The window's largest value at time `t` (0 when empty; negative values are kept, not clamped). */
  max(t: number): number {
    this.prune(t);
    if (this.samples.length === 0) return 0;
    let m = Number.NEGATIVE_INFINITY;
    for (const s of this.samples) if (s.v > m) m = s.v;
    return m;
  }

  private prune(t: number): void {
    let k = 0;
    while (k < this.samples.length && t - this.samples[k].t > this.windowMs) k++;
    if (k > 0) this.samples.splice(0, k);
  }

  clear(): void {
    this.samples = [];
  }
}

/** Look-back answers of one kind, cumulative: what the look-back worker spent, as it reports it. */
export interface LookbackWork {
  answers: number;
  frames: number;
  /** Time in the worker reading raw frames, preprocessing them, and solving them, ms. */
  readMs: number;
  preprocessMs: number;
  solveMs: number;
  /** Time in `serve` that is none of those (a new library's decode, buffers), ms. */
  otherMs: number;
  /** Time the worker waited for the main thread's rows or the back half's state (not busy), ms. */
  waitMs: number;
}

export function emptyLookbackWork(): LookbackWork {
  return { answers: 0, frames: 0, readMs: 0, preprocessMs: 0, solveMs: 0, otherMs: 0, waitMs: 0 };
}

/** What a look-back worker timed for one answer (`LookbackToSlow` `frames`). */
export interface LookbackTiming {
  readMs: number;
  preprocessMs: number;
  solveMs: number;
  /** The rest of the worker's `serve` call: its total, less the waits and the three above. */
  otherMs: number;
  waitMs: number;
}

/** Add one answer's timing to a kind's totals. */
export function addLookbackAnswer(into: LookbackWork, frames: number, t?: LookbackTiming): void {
  into.answers++;
  into.frames += frames;
  if (!t) return;
  into.readMs += t.readMs;
  into.preprocessMs += t.preprocessMs;
  into.solveMs += t.solveMs;
  into.otherMs += t.otherMs;
  into.waitMs += t.waitMs;
}

/** The slow worker's batch wait: how long each live batch sat in its inbox. */
export interface BatchWait {
  batches: number;
  sumMs: number;
  lastMs: number;
  /** The longest wait in the last second, ms. */
  max1sMs: number;
}

/** The work accounting the slow worker reports (cumulative since its run began; `SlowStatus.accounting`). */
export interface WorkStatus {
  /** The slow worker's wall time since the run began, ms. */
  wallMs: number;
  /** Busy ms by duty (exclusive, so their sum is at most `wallMs`). */
  busyMs: Record<SlowDuty, number>;
  batchWait: BatchWait;
  /** Visit workers: the sum of the `ms` of each one's visits, per worker. */
  visitBusyMs: number[];
  /** Look-back answers by kind, as the look-back worker timed them (all zero without look-back). */
  lookback: Record<LookbackKind, LookbackWork>;
  /** Look-back answers that arrived for a request no longer waited for (their worker time still counts as busy). */
  discarded: LookbackWork;
}

export function emptyWork(workers = 0): WorkStatus {
  return {
    wallMs: 0,
    busyMs: { live: 0, visit: 0, housekeep: 0, need: 0, csettle: 0, end: 0, publish: 0, setup: 0 },
    batchWait: { batches: 0, sumMs: 0, lastMs: 0, max1sMs: 0 },
    visitBusyMs: new Array<number>(workers).fill(0),
    lookback: {
      need: emptyLookbackWork(),
      csettle: emptyLookbackWork(),
      end: emptyLookbackWork(),
    },
    discarded: emptyLookbackWork(),
  };
}

/** Shares of wall time (0..1) between two snapshots, and rates. */
export interface WorkRates {
  /** Wall time the two snapshots span, ms. */
  spanMs: number;
  /** The slow worker: share of wall time by duty, and idle (what no duty claims). */
  slow: Record<SlowDuty, number> & { idle: number };
  /** Each visit worker's busy share. */
  visit: number[];
  lookback: {
    /** Busy share of the look-back worker (its `serve` time less waits for Discover's rows), all kinds. */
    busy: number;
    /** By kind: busy share, frames per second of wall time, and ms per answer split. */
    kinds: Record<
      LookbackKind,
      {
        busy: number;
        framesPerS: number;
        answers: number;
        msPerAnswer: { read: number; preprocess: number; solve: number };
      }
    >;
  };
  batchWait: { meanMs: number; lastMs: number; max1sMs: number };
}

const lbBusy = (w: LookbackWork) => w.readMs + w.preprocessMs + w.solveMs + w.otherMs;

/**
 * Shares between two snapshots of the same run (`prev` before `cur`). A
 * snapshot that went backwards (a new run) gives `null`.
 */
export function workRates(prev: WorkStatus, cur: WorkStatus): WorkRates | null {
  const span = cur.wallMs - prev.wallMs;
  if (!(span > 0)) return null;
  const share = (a: number, b: number) => Math.max(0, (b - a) / span);
  const slow = {} as WorkRates['slow'];
  let sum = 0;
  for (const d of SLOW_DUTIES) {
    slow[d] = share(prev.busyMs[d], cur.busyMs[d]);
    sum += slow[d];
  }
  slow.idle = Math.max(0, 1 - sum);
  const visit = cur.visitBusyMs.map((v, i) => share(prev.visitBusyMs[i] ?? 0, v));
  const kinds = {} as WorkRates['lookback']['kinds'];
  let busy = 0;
  for (const k of LOOKBACK_KINDS) {
    const a = prev.lookback[k];
    const b = cur.lookback[k];
    const answers = b.answers - a.answers;
    const per = (x: number, y: number) => (answers > 0 ? (y - x) / answers : 0);
    kinds[k] = {
      busy: share(lbBusy(a), lbBusy(b)),
      framesPerS: ((b.frames - a.frames) * 1000) / span,
      answers,
      msPerAnswer: {
        read: per(a.readMs, b.readMs),
        preprocess: per(a.preprocessMs, b.preprocessMs),
        solve: per(a.solveMs, b.solveMs),
      },
    };
    busy += kinds[k].busy;
  }
  busy += share(lbBusy(prev.discarded), lbBusy(cur.discarded));
  const nb = cur.batchWait.batches - prev.batchWait.batches;
  return {
    spanMs: span,
    slow,
    visit,
    lookback: { busy, kinds },
    batchWait: {
      meanMs: nb > 0 ? (cur.batchWait.sumMs - prev.batchWait.sumMs) / nb : 0,
      lastMs: cur.batchWait.lastMs,
      max1sMs: cur.batchWait.max1sMs,
    },
  };
}

/**
 * Turns the slow worker's status stream into one `WorkRates` about every
 * `everyMs` of its wall time (a snapshot is the reference until it is that
 * old, so a rate never rests on a few milliseconds).
 */
export class WorkRater {
  private ref: WorkStatus | null = null;
  /** Busy time credited at an answer's arrival that a window could not hold (share > 1), carried on. */
  private carry = new Map<string, number>();

  constructor(private readonly everyMs = 1000) {}

  /** The rates since the reference snapshot, or null while it is too young (or the run changed). */
  push(w: WorkStatus): WorkRates | null {
    const ref = this.ref;
    if (!ref || w.wallMs < ref.wallMs) {
      this.carry.clear();
      this.ref = w;
      return null;
    }
    if (w.wallMs - ref.wallMs < this.everyMs) return null;
    this.ref = w;
    const r = workRates(ref, w);
    if (r) this.settle(r);
    return r;
  }

  /**
   * A visit's or an answer's ms is credited when it arrives, so one window can read above 100 %:
   * clamp each busy share at 1 and carry the excess into the next window.
   */
  private settle(r: WorkRates): void {
    const fit = (key: string, v: number): number => {
      const total = v + (this.carry.get(key) ?? 0);
      const shown = Math.min(1, total);
      this.carry.set(key, total - shown);
      return shown;
    };
    r.visit = r.visit.map((v, i) => fit(`v${i}`, v));
    for (const k of LOOKBACK_KINDS) r.lookback.kinds[k].busy = fit(k, r.lookback.kinds[k].busy);
    r.lookback.busy = fit('lb', r.lookback.busy);
  }

  reset(): void {
    this.ref = null;
    this.carry.clear();
  }
}

/**
 * The fast loop's live estimate of its top speed: frames over the busiest
 * stage's busy time, across the last `window` batches. The stages of the
 * pipelined fast loop work on different batches at once, so the busiest one
 * sets the pace; the pace gate's wait is not busy time, so the estimate holds
 * while a run is paced. One entry (non-pipelined path): the serial sum.
 */
export class MaxFpsEstimator {
  private batches: { frames: number; busy: number[] }[] = [];

  constructor(private readonly window = 16) {}

  /** A batch of `frames` frames with each stage's busy ms; returns the estimate (0 until a batch has busy time). */
  record(frames: number, busyMs: readonly number[]): number {
    this.batches.push({ frames, busy: busyMs.slice() });
    if (this.batches.length > this.window) this.batches.shift();
    return this.estimate();
  }

  estimate(): number {
    let frames = 0;
    const stages: number[] = [];
    for (const b of this.batches) {
      frames += b.frames;
      b.busy.forEach((v, i) => (stages[i] = (stages[i] ?? 0) + v));
    }
    const top = Math.max(0, ...stages);
    return top > 0 ? (frames * 1000) / top : 0;
  }

  reset(): void {
    this.batches = [];
  }
}

const pct = (x: number) => `${Math.round(100 * x)}%`.padStart(4);

/** The `?debug` readout: plain text lines of the per-worker numbers. Ugly on purpose; the display comes later. */
export function workText(r: WorkRates | null, maxFps: number): string {
  if (!r) return `work: waiting for a second of data   fast loop max ${maxFps.toFixed(0)} fps`;
  const s = r.slow;
  const lines = [
    `work over ${(r.spanMs / 1000).toFixed(1)} s   fast loop max ~${maxFps.toFixed(0)} fps`,
    `slow    live ${pct(s.live)} visits ${pct(s.visit)} housekeep ${pct(s.housekeep)} need ${pct(s.need)} csettle ${pct(s.csettle)} end ${pct(s.end)} publish ${pct(s.publish)} setup ${pct(s.setup)} idle ${pct(s.idle)}`,
    `        batch wait mean ${r.batchWait.meanMs.toFixed(1)} ms, last ${r.batchWait.lastMs.toFixed(1)}, longest in 1 s ${r.batchWait.max1sMs.toFixed(1)}`,
    `visits  ${r.visit.length > 0 ? r.visit.map(pct).join(' ') : 'none (the slow worker visits itself)'}`,
    `look-back busy ${pct(r.lookback.busy)}`,
  ];
  for (const k of LOOKBACK_KINDS) {
    const x = r.lookback.kinds[k];
    if (x.answers === 0 && x.busy === 0) continue;
    lines.push(
      `        ${k.padEnd(7)} busy ${pct(x.busy)} ${x.framesPerS.toFixed(0)} frames/s, ${x.answers} answers, ms per answer: read ${x.msPerAnswer.read.toFixed(0)} preprocess ${x.msPerAnswer.preprocess.toFixed(0)} solve ${x.msPerAnswer.solve.toFixed(0)}`,
    );
  }
  return lines.join('\n');
}
