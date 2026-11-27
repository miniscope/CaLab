/**
 * The settle governor: the Background settle's only dose rule below Max. Its state is one
 * number, the settle rate in re-read frames per second (`GOVERNOR`, `SettleGovernor`).
 */
import { CSETTLE } from './settle.ts';

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
