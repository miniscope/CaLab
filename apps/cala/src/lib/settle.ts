/**
 * The end-of-Discover settle of a look-back run (experimental; qc_eval's
 * `--settle-frames N --settle-batch 16`, `LookBack::settle`): with the cell
 * set frozen, the look-back worker re-reads the recording once and every
 * frame goes through the slow loop's ordinary `observe`, as a Refine pass
 * feeds its frames. That renews the held-out test frames each refinement is
 * judged on, which look-back alone never does (tools/cala-eval/results/
 * 2026-11-19-lookback-settle.md). `SlowRunner` drives it; this module holds
 * the frame plan and the "cells still moving" readout, both pure.
 */

/** The settle's settings (see `settle_design.md`, "Design of the end-of-Discover settle"). */
export const SETTLE = {
  /**
   * Frames fed at most: one pass over a recording up to this length; a
   * longer one is sampled in `block`-frame blocks spread evenly over it.
   * About three half-lives of the footprint statistics (6000 frames).
   */
  maxFrames: 18_000,
  /** Frames read in a row (the look-back block; a gap restarts the back half's preprocessor). */
  block: 64,
  /** Frames per request to the look-back worker (each earns its visits after it is observed). */
  batch: 16,
  /** Frames between checkpoints: a published library and the "cells still moving" count. */
  checkEvery: 1200,
  /** A cell is moving when it changed by more than this many times its split-half noise since the last checkpoint. */
  movingK: 2,
  /**
   * Above this share of cells moving at the last checkpoint the run reports
   * "not settled" (a floor, not a stop rule: the settle always feeds its
   * whole budget; 4 % separated settled from unsettled libraries on sims and
   * the workshop recording).
   */
  movingShare: 0.04,
  /** The last round of visits: every tile due, this many slow-loop budgets (without visit workers). */
  finalSteps: 64,
  /** With visit workers: at most this many visits in the last round (besides the work cap). */
  finalVisitsMax: 4096,
} as const;

/** A run of consecutive frames `[start, end)` the settle reads. */
export interface FrameRun {
  start: number;
  end: number;
}

/**
 * The frames the settle feeds for a recording of `total` frames: all of
 * them when `total <= cap`, else about `cap` frames in whole `block`-frame
 * blocks spread evenly over the recording (adjacent blocks merged).
 */
export function settlePlan(
  total: number,
  cap: number = SETTLE.maxFrames,
  block: number = SETTLE.block,
): FrameRun[] {
  if (!(total > 0)) return [];
  if (total <= cap) return [{ start: 0, end: total }];
  const blocks = Math.ceil(total / block);
  const want = Math.max(1, Math.min(blocks, Math.round(cap / block)));
  const runs: FrameRun[] = [];
  for (let j = 0; j < want; j++) {
    const b = Math.floor((j * blocks) / want);
    const start = b * block;
    const end = Math.min(total, start + block);
    const last = runs.at(-1);
    if (last && last.end === start) last.end = end;
    else runs.push({ start, end });
  }
  return runs;
}

/** Frames in a plan. */
export function planFrames(runs: readonly FrameRun[]): number {
  return runs.reduce((n, r) => n + r.end - r.start, 0);
}

/** One frame to request: its index, and the preprocessor block it belongs to. */
export interface SettleFrame {
  frame: number;
  /**
   * Block sequence for the look-back worker: a new value starts a fresh copy
   * of the live back half (only at a gap in the plan, as qc_eval restarts
   * its preprocessor only when a frame does not follow the last one).
   * Negative, so never one of the scheduler's.
   */
  block: number;
}

/** Walks a plan in requests of at most `max` frames. */
export class SettleFeed {
  readonly total: number;
  private run = 0;
  private next: number;
  /** Frames handed out but not served (`putBack`): handed out again first. */
  private back: number[] = [];

  constructor(private readonly runs: readonly FrameRun[]) {
    this.total = planFrames(runs);
    this.next = runs[0]?.start ?? 0;
  }

  /** Frames handed out so far. */
  get taken(): number {
    let n = 0;
    for (let i = 0; i < this.run && i < this.runs.length; i++)
      n += this.runs[i].end - this.runs[i].start;
    if (this.run < this.runs.length) n += this.next - this.runs[this.run].start;
    return n - this.back.length;
  }

  get done(): boolean {
    return this.run >= this.runs.length && this.back.length === 0;
  }

  /** Frames of a request that was not served (its worker failed): the next `take` hands them out first. */
  putBack(frames: readonly number[]): void {
    this.back.push(...frames);
  }

  /** The next up to `max` frames (empty when done). */
  take(max: number): SettleFrame[] {
    const out: SettleFrame[] = [];
    while (out.length < max && this.back.length > 0) {
      const frame = this.back.shift()!;
      const run = this.runs.findIndex((r) => frame >= r.start && frame < r.end);
      out.push({ frame, block: -1 - run });
    }
    while (out.length < max && this.run < this.runs.length) {
      const r = this.runs[this.run];
      out.push({ frame: this.next, block: -1 - this.run });
      this.next++;
      if (this.next >= r.end) {
        this.run++;
        this.next = this.runs[this.run]?.start ?? 0;
      }
    }
    return out;
  }
}

/** What the change readouts need of a library (a `LibraryView`, or the getters of a published one). */
export interface FootprintsLike {
  ids: ArrayLike<number>;
  starts: ArrayLike<number>;
  pixels: ArrayLike<number>;
  values: ArrayLike<number>;
}

/** One cell's footprint, scaled to a unit peak (as qc_eval's settle checkpoints compare them). */
type UnitFootprint = Map<number, number>;

/** Every cell's unit-peak footprint, by id. */
export function unitFootprints(lib: FootprintsLike): Map<number, UnitFootprint> {
  const out = new Map<number, UnitFootprint>();
  for (let s = 0; s < lib.ids.length; s++) {
    let peak = 0;
    for (let k = lib.starts[s]; k < lib.starts[s + 1]; k++) peak = Math.max(peak, lib.values[k]);
    const m: UnitFootprint = new Map();
    for (let k = lib.starts[s]; k < lib.starts[s + 1]; k++)
      m.set(lib.pixels[k], peak > 0 ? lib.values[k] / peak : lib.values[k]);
    out.set(lib.ids[s], m);
  }
  return out;
}

/** `[id, noise, id, noise, ...]` (`SlowLoop.footprintNoise`) as a map; NaN and non-positive entries left out. */
export function noiseMap(flat: ArrayLike<number> | undefined): Map<number, number> {
  const m = new Map<number, number>();
  if (!flat) return m;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const n = flat[i + 1];
    if (Number.isFinite(n) && n > 0) m.set(flat[i], n);
  }
  return m;
}

/** Cells that moved against their own noise. */
export interface MovedAgainstNoise {
  /** Cells in both libraries with a noise estimate. */
  cells: number;
  /** Of those, cells whose change exceeds 1x and `k`x their split-half noise. */
  above1: number;
  aboveK: number;
  /** `aboveK / cells` (null with no cells). */
  shareK: number | null;
}

/**
 * Per cell present in both with a noise estimate: the relative change of its
 * unit-peak footprint, `|a' - a| / |a|` over the union of the supports
 * (qc_eval's `SettleSnap::change_from`), against its split-half noise
 * (`noise`, from the newer library: `SlowLoop.footprintNoise`).
 */
export function movedAgainstNoise(
  before: Map<number, UnitFootprint>,
  after: Map<number, UnitFootprint>,
  noise: Map<number, number>,
  k: number = SETTLE.movingK,
): MovedAgainstNoise {
  let cells = 0;
  let above1 = 0;
  let aboveK = 0;
  for (const c of footprintChanges(before, after, noise)) {
    const r = c.change / c.noise;
    cells++;
    if (r > 1) above1++;
    if (r > k) aboveK++;
  }
  return { cells, above1, aboveK, shareK: cells > 0 ? aboveK / cells : null };
}

/** One cell's relative footprint change between two libraries, and its split-half noise. */
export interface FootprintChange {
  id: number;
  change: number;
  noise: number;
}

/** The cells `movedAgainstNoise` counts, one by one (present in both, with a noise estimate). */
export function footprintChanges(
  before: Map<number, UnitFootprint>,
  after: Map<number, UnitFootprint>,
  noise: Map<number, number>,
): FootprintChange[] {
  const out: FootprintChange[] = [];
  for (const [id, b] of after) {
    const a = before.get(id);
    const n = noise.get(id);
    if (!a || n === undefined) continue;
    let d2 = 0;
    let a2 = 0;
    let b2 = 0;
    for (const [p, v] of b) {
      const u = a.get(p) ?? 0;
      d2 += (v - u) * (v - u);
      b2 += v * v;
    }
    for (const [p, u] of a) {
      a2 += u * u;
      if (!b.has(p)) d2 += u * u;
    }
    if (!(a2 > 0 && b2 > 0)) continue;
    out.push({ id, change: Math.sqrt(d2 / a2), noise: n });
  }
  return out;
}

/** How far a library moved between two points (the end settle of a look-back run, as a whole). */
export interface SettleChange extends MovedAgainstNoise {
  /** Cells in the earlier and in the later library. */
  cellsBefore: number;
  cellsAfter: number;
  /** Median relative footprint change, and median change over the cell's own noise (null with no cells). */
  medianChange: number | null;
  medianRatio: number | null;
}

/** `movedAgainstNoise` with the medians (measurement scripts: the `?debug` hook). */
export function settleChange(
  before: Map<number, UnitFootprint>,
  after: Map<number, UnitFootprint>,
  noise: Map<number, number>,
  k: number = SETTLE.movingK,
): SettleChange {
  const ch = footprintChanges(before, after, noise);
  const median = (v: number[]) => {
    if (v.length === 0) return null;
    const s = [...v].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    ...movedAgainstNoise(before, after, noise, k),
    cellsBefore: before.size,
    cellsAfter: after.size,
    medianChange: median(ch.map((c) => c.change)),
    medianRatio: median(ch.map((c) => c.change / c.noise)),
  };
}

// ---- settle during Discover ("Background settle", frames only) ----

/**
 * Settle during Discover ("Background settle"; on whenever a look-back
 * Discover's target is below Max, up to the cap; qc_eval's arm `CS2F`,
 * `--csettle 0.667 --csettle-mode frames`; tools/cala-eval/results/
 * 2026-11-20-concurrent-settle2.md and 2026-11-21-concurrent-settle3.md):
 * while a look-back Discover runs, the look-back worker also re-reads saved
 * frames spread over the history seen so far; each is solved with the
 * current library and updates the footprint statistics, and Discover's
 * ordinary visits do the refining. No settle visits, no quiet rule; held-out
 * frames never reach fitting. The end settle still runs after the last frame.
 */
export const CSETTLE = {
  /** The default cap: re-read frames per live frame the slow loop observes (0 = Off). */
  rate: 2,
  /** The ceilings a user can pick (lower = less work beside the live frames). */
  rates: [2, 1, 0.5],
  /** Frames per request, read in a row (one chunk of the engine's `SettleSched`). */
  chunk: 16,
  /** At most this many chunks owed: what the look-back worker cannot deliver is not saved up. */
  bankChunks: 4,
} as const;

/** A valid ceiling from a setting or URL value: one of `CSETTLE.rates`, else the default. */
export function csettleRate(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return (CSETTLE.rates as readonly unknown[]).includes(n) ? (n as number) : CSETTLE.rate;
}

/**
 * Settle look-back workers besides worker 0 (the settle pool's S; beta speed
 * control, section 1 "Pool size"; PI decision of 22 Nov 2026: one more worker
 * on machines with at least `minCores` logical cores, else none, and one
 * worker takes turns). Started only once a run's target goes below Max.
 */
export const SETTLE_POOL = {
  /** Logical cores (`navigator.hardwareConcurrency`) from which the pool has `workers` workers. */
  minCores: 12,
  workers: 1,
  /** The most a `?debug&lbpool=S` override may ask for. */
  maxWorkers: 4,
} as const;

/**
 * The settle pool's size S for a machine with `cores` logical cores
 * (unknown: none), or the `override` (`?debug&lbpool=S`) when one is given.
 */
export function settlePoolSize(cores: number | undefined, override?: number | null): number {
  if (override !== undefined && override !== null && Number.isFinite(override))
    return Math.max(0, Math.min(SETTLE_POOL.maxWorkers, Math.floor(override)));
  return cores !== undefined && cores >= SETTLE_POOL.minCores ? SETTLE_POOL.workers : 0;
}

// ---- the settle governor (work-slider PR 5; the settle's only dose rule below Max) ----

/**
 * The governor's settings (`work_slider_design.md`, section 2, "The
 * governor"). Its state is one number, the settle rate in re-read frames per
 * second; the smallest of three limits wins: the cap (`cap x achieved live
 * fps`), what the settle look-back workers deliver, and the guard (additive
 * increase, halving on trouble, checked once a second).
 */
export const GOVERNOR = {
  /** The guard's additive increase, re-read frames per second, once a check. */
  stepFps: 8,
  /** Between checks, ms. */
  checkMs: 1000,
  /** Trouble: the achieved live fps over the last `belowMs` below this share of the target. */
  belowShare: 0.97,
  belowMs: 2000,
  /**
   * Trouble: a live batch waited at the slow worker longer than this share of
   * the batch periods the forward pool can hold ahead of the one being
   * observed (`waitShare x (poolSize - 1)` periods; with two buffers, half a
   * period). A deeper pool queues batches by design, so its waits rise with
   * settle activity without any drop.
   */
  waitShare: 0.5,
  /** At rate 0 with Discover below its target, probe with one step this often, ms. */
  probeMs: 5000,
  /** A halving this recent (ms) names the climb back after it ("slow worker" or "backing off"). */
  recentMs: 10_000,
  /**
   * With the bank full, settle look-back workers at least this busy (share of
   * their wall time) make "look-back" the limit; less busy, they wait for the
   * slow worker to take their answers ("slow worker").
   */
  busyShare: 0.8,
  /** A halved rate below this many frames per second is 0. */
  floorFps: 1,
} as const;

/**
 * What limits the settle now (`SettleGovernor.limit`): the six of the design,
 * and two passing states (`waiting`: no library yet, no settle read goes
 * out; `ramping`: climbing by the guard's step with no limit reached and no
 * recent trouble). `off`: the target is Max; `cap-off`: below Max with the cap Off.
 */
export type GovernorLimit =
  | 'off'
  | 'cap-off'
  | 'waiting'
  | 'ramping'
  | 'cap'
  | 'look-back'
  | 'slow-worker'
  | 'backing-off'
  | 'discover';

export const GOVERNOR_LIMIT_TEXT: Record<GovernorLimit, string> = {
  off: 'off (Max)',
  'cap-off': 'cap off',
  waiting: 'no library yet',
  ramping: 'ramping up',
  cap: 'cap',
  'look-back': 'look-back',
  'slow-worker': 'slow worker',
  'backing-off': 'backing off',
  discover: 'Discover is the limit',
};

/** The governor's readout (`CsettleStatus.governor`). */
export interface GovernorStatus {
  /** The settle rate, re-read frames per second. */
  rate: number;
  limit: GovernorLimit;
  /** The pacer's target live fps (0: unpaced, Max), and whether the run is paused. */
  target: number;
  paused: boolean;
  /** Live fps over the last `GOVERNOR.belowMs` (null: not known yet). */
  achieved: number | null;
  /** The cap's limit, re-read frames per second (`cap x achieved`). */
  capFps: number;
  /** The cap, re-read frames per live frame. */
  cap: number;
  /** Settle frames delivered per second, and the settle workers' busy share, over the last check. */
  deliveredFps: number;
  busy: number;
  /** Re-read frames owed now. */
  credit: number;
  /** Halvings so far, and of those, the ones a batch wait or a forward-pool drop caused. */
  halvings: number;
  slowHalvings: number;
}

/** A live batch, as the governor sees it. */
interface LiveSample {
  /** When the fast loop sent it, ms. */
  t: number;
  /** Stream index after its last frame. */
  end: number;
}

/**
 * The settle governor (pure; clocks are passed in): decides how many saved
 * frames per second are re-read for the settle during Discover: a rate in
 * frames per second (it replaced the per-live-frame dose, so a low target no
 * longer leaves the look-back workers idle), backing off when the slow worker
 * falls behind. It is the settle's only dose rule; at Max it is off.
 *
 * Inputs: the pacer's target (`setTarget`; 0 = Max, where the settle is off),
 * the cap (`setCap`, during a run too; 0 = Off),
 * every live batch (`liveBatch`: its send time, end, size, the wait at the
 * slow worker, and whether batches were dropped before it), and every settle
 * answer (`delivered`: frames and the worker's busy ms). `update` runs the
 * check when one is due and earns credit at the rate; a request goes out
 * when a whole chunk is owed (`ready`, `spend`), at most
 * `CSETTLE.bankChunks` chunks are banked.
 */
export class SettleGovernor {
  private rateFps = 0;
  private limitNow: GovernorLimit = 'off';
  private target = 0;
  private paused = false;
  private owedFrames = 0;
  private readonly bank: number;
  private lastCheck: number | null = null;
  private lastEarn: number | null = null;
  private samples: LiveSample[] = [];
  /** Frames in a full live batch (the largest seen; its period is the wait and stall tests' unit). */
  private lastCount = 0;
  /** A probe of one chunk is out (rate at one step, a chunk owed): trouble at the next check ends it. */
  private probing = false;
  /** Since the last check: a long batch wait, a forward-pool drop, the bank full, deliveries. */
  private waitedLong = false;
  private dropped = false;
  private saturated = false;
  private deliveredFrames = 0;
  private busyMs = 0;
  private lastHalve = Number.NEGATIVE_INFINITY;
  private halveCause: 'slow' | 'fps' = 'slow';
  private lastProbe = Number.NEGATIVE_INFINITY;
  /** When the look-back supply last held the rate down, and what held it (the climb back above it keeps the name). */
  private lastSupply = Number.NEGATIVE_INFINITY;
  private supplyLabel: GovernorLimit = 'look-back';
  private achievedFps: number | null = null;
  private lastDelivered = 0;
  private lastBusy = 0;
  private halvings = 0;
  private slowHalvings = 0;

  constructor(
    /** The cap, re-read frames per live frame (`CSETTLE.rates`; 0 = Off). Changes with `setCap`. */
    private capNow: number,
    /** Settle look-back workers (1 when the settle takes turns with need-driven look-back). */
    private workers = 1,
    /** Batches the forward pool holds in flight to the slow worker (`PARALLEL_FORWARD_BUFFERS`). */
    private readonly poolSize = 2,
    readonly chunk: number = CSETTLE.chunk,
    bankChunks: number = CSETTLE.bankChunks,
  ) {
    this.bank = chunk * bankChunks;
  }

  /** The settle look-back workers serving now (a failed pool worker leaves fewer). */
  setWorkers(n: number): void {
    this.workers = Math.max(1, n);
  }

  /** The cap, re-read frames per live frame (0 = Off). */
  get cap(): number {
    return this.capNow;
  }

  /**
   * A new cap during a run (0 = Off: as at Max, no credit and rate 0). A lower
   * cap holds the rate and the banked credit down at once; a higher one is
   * reached by the guard's climb.
   */
  setCap(cap: number): void {
    const c = Number.isFinite(cap) && cap > 0 ? cap : 0;
    if (c === this.capNow) return;
    this.capNow = c;
    if (!this.on) {
      this.rateFps = 0;
      this.owedFrames = 0;
      this.probing = false;
      this.limitNow = this.offLimit;
      return;
    }
    if (this.isOff) this.limitNow = 'waiting';
    const capFps = c * (this.achievedFps ?? this.target);
    if (this.rateFps > capFps) {
      this.rateFps = capFps;
      this.limitNow = 'cap';
    }
    this.owedFrames = Math.min(this.owedFrames, this.chunk);
  }

  /** The settle may run: a target below Max and a cap above 0. */
  private get on(): boolean {
    return this.target > 0 && this.capNow > 0;
  }

  /** Why the settle is off now: the target at Max, else the cap Off. */
  private get offLimit(): GovernorLimit {
    return this.target > 0 ? 'cap-off' : 'off';
  }

  private get isOff(): boolean {
    return this.limitNow === 'off' || this.limitNow === 'cap-off';
  }

  /** The pacer's target live fps (0: Max) and whether the run is paused. A change restarts the fps window. */
  setTarget(fps: number, paused: boolean): void {
    const t = Number.isFinite(fps) && fps > 0 ? fps : 0;
    if (t !== this.target || paused !== this.paused) {
      this.samples = [];
      // Paused: nothing is owed for the time it lasts, and nothing seen before it is trouble after it.
      this.lastEarn = null;
      this.lastCheck = null;
      this.waitedLong = false;
      this.dropped = false;
      this.saturated = false;
      this.deliveredFrames = 0;
      this.busyMs = 0;
      this.probing = false;
    }
    this.target = t;
    this.paused = paused;
    if (!this.on) {
      this.rateFps = 0;
      this.owedFrames = 0;
      this.limitNow = this.offLimit;
    } else if (this.isOff) this.limitNow = 'waiting';
  }

  /**
   * A live batch reached the slow worker: sent at `t` (ms, the clock of
   * `update`), ending at stream index `end`, of `count` frames, after
   * `waitMs` in the slow worker's inbox; `gap`: frames before it were dropped
   * by the forward pool.
   */
  liveBatch(t: number, end: number, count: number, waitMs: number, gap: boolean): void {
    if (this.target <= 0 || this.paused) return;
    this.samples.push({ t, end });
    // A short batch (the end of a run) is not the unit: the largest seen is the nominal size.
    this.lastCount = Math.max(this.lastCount, count);
    const keep = t - 2 * GOVERNOR.belowMs;
    while (this.samples.length > 2 && this.samples[0].t < keep) this.samples.shift();
    const allowed = GOVERNOR.waitShare * Math.max(1, this.poolSize - 1);
    if (waitMs > (allowed * this.lastCount * 1000) / this.target) this.waitedLong = true;
    if (gap) this.dropped = true;
  }

  /** A settle answer of `frames` frames came back; its worker was busy `busyMs` on it. */
  delivered(frames: number, busyMs: number): void {
    this.deliveredFrames += frames;
    if (Number.isFinite(busyMs) && busyMs > 0) this.busyMs += busyMs;
  }

  /** Live fps over the last `GOVERNOR.belowMs` (null: under 3/4 of that window measured). */
  private achieved(now: number): number | null {
    const s = this.samples;
    if (s.length < 2) return null;
    const last = s[s.length - 1];
    const period = (this.lastCount * 1000) / this.target;
    // Nothing for two batch periods (at least half a second): the stall counts.
    const stalled = now - last.t > Math.max(500, 2 * period);
    const tEnd = stalled ? now : last.t;
    let first = s[0];
    for (const x of s) {
      if (x.t >= tEnd - GOVERNOR.belowMs) {
        first = x;
        break;
      }
    }
    const span = tEnd - first.t;
    if (span < 0.75 * GOVERNOR.belowMs) return null;
    return ((last.end - first.end) * 1000) / span;
  }

  /** Run the check if one is due, then earn credit at the rate up to `now`. */
  update(now: number, hasLibrary: boolean): void {
    if (this.lastCheck === null) this.lastCheck = now;
    if (now - this.lastCheck >= GOVERNOR.checkMs) {
      this.check(now, now - this.lastCheck, hasLibrary);
      this.lastCheck = now;
    }
    this.earn(now, hasLibrary);
  }

  private earn(now: number, hasLibrary: boolean): void {
    const last = this.lastEarn;
    this.lastEarn = now;
    if (last === null || !this.on || this.paused || !hasLibrary) return;
    const dt = Math.max(0, now - last);
    this.owedFrames = Math.min(this.bank, this.owedFrames + (this.rateFps * dt) / 1000);
    if (this.owedFrames >= this.bank) this.saturated = true;
  }

  private check(now: number, dt: number, hasLibrary: boolean): void {
    const waitedLong = this.waitedLong;
    const dropped = this.dropped;
    const saturated = this.saturated;
    this.lastDelivered = (this.deliveredFrames * 1000) / dt;
    this.lastBusy = this.busyMs / (dt * this.workers);
    this.waitedLong = false;
    this.dropped = false;
    this.saturated = false;
    this.deliveredFrames = 0;
    this.busyMs = 0;
    if (!this.on) {
      this.rateFps = 0;
      this.owedFrames = 0;
      this.limitNow = this.offLimit;
      return;
    }
    // Paused: hold everything (a pause must not read as trouble).
    if (this.paused) return;
    if (!hasLibrary) {
      this.rateFps = 0;
      this.owedFrames = 0;
      this.limitNow = 'waiting';
      return;
    }
    const achieved = this.achieved(now);
    this.achievedFps = achieved;
    const below = achieved !== null && achieved < GOVERNOR.belowShare * this.target;
    const trouble = waitedLong || dropped || below;
    if (this.probing) {
      this.probing = false;
      if (trouble) {
        // The probe failed: straight back to 0, the label as it was, no halving counted.
        this.rateFps = 0;
        this.owedFrames = 0;
        return;
      }
    }
    if (trouble) {
      if (this.rateFps > 0) {
        this.rateFps /= 2;
        if (this.rateFps < GOVERNOR.floorFps) this.rateFps = 0;
        this.owedFrames = Math.min(this.owedFrames, this.chunk);
        this.halvings++;
        this.lastHalve = now;
        this.halveCause = waitedLong || dropped ? 'slow' : 'fps';
        if (this.halveCause === 'slow') this.slowHalvings++;
        if (this.rateFps === 0) this.lastProbe = now;
        this.limitNow = 'backing-off';
        return;
      }
      if (!below) {
        // At 0 already, and the slow worker still falls behind: the live load alone does it.
        this.limitNow = 'slow-worker';
        return;
      }
      // At 0 and still below the target: Discover is the limit; probe now and then.
      this.limitNow = 'discover';
      if (now - this.lastProbe >= GOVERNOR.probeMs) {
        // One whole chunk, so the probe sends a request (and so loads Discover).
        this.lastProbe = now;
        this.rateFps = GOVERNOR.stepFps;
        this.owedFrames = this.chunk;
        this.probing = true;
      }
      return;
    }
    const capFps = this.capNow * (achieved ?? this.target);
    let lim = capFps;
    let label: GovernorLimit = 'cap';
    if (saturated) {
      // The bank filled: the settle workers did not take what the rate owed.
      const supply = Math.max(GOVERNOR.stepFps, this.lastDelivered);
      if (supply < lim) {
        lim = supply;
        label = this.lastBusy >= GOVERNOR.busyShare ? 'look-back' : 'slow-worker';
        this.lastSupply = now;
        this.supplyLabel = label;
      }
    }
    const next = this.rateFps + GOVERNOR.stepFps;
    if (next >= lim) {
      this.rateFps = lim;
      this.limitNow = label;
    } else {
      this.rateFps = next;
      // Climbing: named by the last thing that held it down, if recent.
      const recent = (t: number) => now - t <= GOVERNOR.recentMs;
      if (recent(this.lastHalve) && this.lastHalve >= this.lastSupply)
        this.limitNow = this.halveCause === 'slow' ? 'slow-worker' : 'backing-off';
      else if (recent(this.lastSupply)) this.limitNow = this.supplyLabel;
      else this.limitNow = 'ramping';
    }
  }

  /** The settle rate now, re-read frames per second. */
  get rate(): number {
    return this.rateFps;
  }

  get limit(): GovernorLimit {
    return this.limitNow;
  }

  /** Re-read frames owed now. */
  get owed(): number {
    return this.owedFrames;
  }

  /** A whole chunk is owed. */
  get ready(): boolean {
    return this.owedFrames >= this.chunk;
  }

  /** `frames` were asked for. */
  spend(frames: number): void {
    this.owedFrames = Math.max(0, this.owedFrames - frames);
  }

  status(): GovernorStatus {
    return {
      rate: this.rateFps,
      limit: this.limitNow,
      target: this.target,
      paused: this.paused,
      achieved: this.achievedFps,
      capFps: this.capNow * (this.achievedFps ?? this.target),
      cap: this.capNow,
      deliveredFps: this.lastDelivered,
      busy: this.lastBusy,
      credit: this.owedFrames,
      halvings: this.halvings,
      slowHalvings: this.slowHalvings,
    };
  }
}

// ---- Final-settle levels (a stop point of the settle pass) ----

/**
 * How much of the final settle pass is read (tools/cala-eval/results/
 * 2026-11-22-settledness.md, answer 5): fixed in-order stop points, because no
 * adaptive rule beat them. Thorough is the whole pass and the default.
 */
export const FINAL_SETTLE_LEVELS = {
  thorough: { label: 'Thorough', fraction: 1, help: 'The full pass (default).' },
  standard: {
    label: 'Standard',
    fraction: 0.87,
    help: 'Stops after 87 % of the pass: about an eighth of the final settle saved, nearly the same footprints.',
  },
  quick: {
    label: 'Quick',
    fraction: 0.6,
    help: 'Stops after 60 % of the pass: about 40 % faster Final settle; slightly rougher edges, late-born cells and a few unfilled bites.',
  },
} as const;

export type FinalSettleLevel = keyof typeof FINAL_SETTLE_LEVELS;

export const FINAL_SETTLE_LEVEL_DEFAULT: FinalSettleLevel = 'thorough';

/** A valid level from a setting or a run record; anything else is the default. */
export function finalSettleLevel(v: unknown): FinalSettleLevel {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FINAL_SETTLE_LEVELS, v)
    ? (v as FinalSettleLevel)
    : FINAL_SETTLE_LEVEL_DEFAULT;
}

/**
 * The first `fraction` of a plan's frames, in plan order (the last run cut
 * short). A fraction of 1 or more (or not a number) returns the plan itself.
 */
export function truncatePlan(runs: readonly FrameRun[], fraction: number): readonly FrameRun[] {
  if (!(fraction < 1)) return runs;
  const want = Math.round(planFrames(runs) * Math.max(0, fraction));
  const out: FrameRun[] = [];
  let left = want;
  for (const r of runs) {
    if (left <= 0) break;
    const n = Math.min(left, r.end - r.start);
    out.push({ start: r.start, end: r.start + n });
    left -= n;
  }
  return out;
}

// ---- Per-footprint "still moving" hint (information only) ----

/** The hint's fixed display scale, in multiples of the cell's split-half noise (clipped; never auto-scaled). */
export const STILL_MOVING_SCALE = { lo: 0, hi: 3 } as const;

/** Tooltip of the column and the colour-by option. */
export const STILL_MOVING_HELP =
  'How much this footprint changed over the last 1,200 settle frames, relative to its noise (centre and edge, whichever is larger). About 1 or below: changes are at noise level. Higher: still settling. Edges count.';

/**
 * Split-half noise of cell `id`'s footprint estimate on `pixels`, relative to
 * the norm of the estimate there (`SlowLoop.footprintNoiseOn`); NaN or
 * non-positive when there is no estimate.
 */
export type RegionNoise = (id: number, pixels: Uint32Array) => number;

/**
 * Per cell present in both libraries: how much its footprint changed over
 * one step against its own split-half noise, as the larger of the core's and
 * the edge's change over that region's noise (so a busy core cannot drown the
 * edge; the study's "edge-ring step", settledness.md answer 6). Each region
 * is measured in the same units as its noise: the L2 change of the unit-peak
 * footprints over the larger of their norms in the region, against
 * `regionNoise` (half the split-half difference over the norm of the mean,
 * on the same pixels). Core = pixels at or above half the peak in either
 * footprint; edge = the union support minus the core. A region with no
 * noise estimate is left out; a cell with neither region, or with no earlier
 * footprint, is left out. Returns `[id, ratio, ...]`.
 */
export function stillMovingRatios(
  before: Map<number, UnitFootprint>,
  after: Map<number, UnitFootprint>,
  regionNoise: RegionNoise,
): Float64Array {
  const out: number[] = [];
  for (const [id, b] of after) {
    const a = before.get(id);
    if (!a) continue;
    const core: number[] = [];
    const edge: number[] = [];
    const seen = new Set<number>();
    for (const m of [a, b])
      for (const p of m.keys()) {
        if (seen.has(p)) continue;
        seen.add(p);
        ((a.get(p) ?? 0) >= 0.5 || (b.get(p) ?? 0) >= 0.5 ? core : edge).push(p);
      }
    let best = Number.NaN;
    for (const region of [core, edge]) {
      if (region.length === 0) continue;
      const pixels = Uint32Array.from(region);
      const n = regionNoise(id, pixels);
      if (!(n > 0 && Number.isFinite(n))) continue;
      let d2 = 0;
      let a2 = 0;
      let b2 = 0;
      for (const p of pixels) {
        const u = a.get(p) ?? 0;
        const v = b.get(p) ?? 0;
        d2 += (v - u) * (v - u);
        a2 += u * u;
        b2 += v * v;
      }
      const norm = Math.sqrt(Math.max(a2, b2));
      const r = norm > 0 ? Math.sqrt(d2) / norm / n : 0;
      if (!(r <= best)) best = r;
    }
    if (!Number.isNaN(best)) out.push(id, best);
  }
  return Float64Array.from(out);
}

/** `[id, ratio, ...]` as a map (non-finite ratios kept as `Infinity` only if positive; NaN left out). */
export function stillMovingMap(flat: ArrayLike<number> | undefined): Map<number, number> {
  const m = new Map<number, number>();
  if (!flat) return m;
  for (let i = 0; i + 1 < flat.length; i += 2)
    if (!Number.isNaN(flat[i + 1])) m.set(flat[i], flat[i + 1]);
  return m;
}
