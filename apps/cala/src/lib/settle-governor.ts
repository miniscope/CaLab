/**
 * The settle governor: the Background settle's dose rule below Max. The dose is counted in live
 * frames, never in wall time, so a run read at the same target gives the same requests whatever
 * the machine's speed (`GOVERNOR`, `SettleGovernor`).
 */
import { CSETTLE } from './settle.ts';

/**
 * The governor's settings. The dose, re-read frames per live frame, climbs with the live frames
 * observed since the first library (`rampFrames`) up to the cap. The clock settings only shape
 * the readout (achieved fps, delivery and busy share); no decision reads them.
 */
export const GOVERNOR = {
  /**
   * Live frames over which the dose climbs by one re-read frame per live frame (from 0 at the
   * first library; at the default cap of 2 it reaches the cap after twice this many).
   */
  rampFrames: 450,
  /** Between readout updates, ms. */
  checkMs: 1000,
  /** The achieved live fps of the readout: over the last this many ms. */
  belowMs: 2000,
  /**
   * With chunks waiting for a free worker, settle look-back workers at least this busy (share of
   * their wall time) make the readout name "look-back" the limit, less busy "slow worker".
   */
  busyShare: 0.8,
} as const;

/**
 * What limits the settle (`SettleGovernor.limit`): `off` (the target is Max), `cap-off` (below
 * Max with the cap Off), `waiting` (no library yet: nothing is owed), `ramping` (the dose is
 * climbing), `cap` (the dose is at the cap), `look-back` or `slow-worker` (more than
 * `CSETTLE.bankChunks` chunks wait to be asked for: the settle workers, or the slow worker taking
 * their answers, fall behind). `backing-off` and `discover` are names of the speed readout and of run records that
 * older dose rules wrote.
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

/** The readout's words for each limit. */
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
  /** The dose as a rate: re-read frames per live frame times the target, re-read frames per second. */
  rate: number;
  limit: GovernorLimit;
  /** The pacer's target live fps (0: unpaced, Max), and whether the run is paused. */
  target: number;
  paused: boolean;
  /** Live fps over the last `GOVERNOR.belowMs` (null: not known yet). */
  achieved: number | null;
  /** The cap as a rate, re-read frames per second (`cap x achieved`). */
  capFps: number;
  /** The cap, re-read frames per live frame. */
  cap: number;
  /** Settle frames delivered per second, and the settle workers' busy share, over the last readout window. */
  deliveredFps: number;
  busy: number;
  /** Re-read frames owed now (not yet taken into a chunk). */
  credit: number;
  /** Halvings of the dose: the frame-counted dose never halves, so 0 (kept in the run record's shape). */
  halvings: number;
  slowHalvings: number;
  /** Re-read frames taken and waiting for a settle worker (`setBacklog`). */
  backlog: number;
}

/** A live batch, as the governor sees it. */
interface LiveSample {
  /** When the fast loop sent it, ms. */
  t: number;
  /** Stream index after its last frame. */
  end: number;
}

/**
 * The settle governor (pure; clocks are passed in for the readout only): how many saved frames
 * are re-read for the settle during Discover, counted per live frame the slow loop observes.
 * Each live frame observed with a library earns the dose, `min(cap, frames since the first
 * library / GOVERNOR.rampFrames)` re-read frames; the driver takes a chunk per whole chunk owed
 * (`ready`, `spend`). Nothing owed is ever dropped here, so the frames taken depend on the live
 * frames only. At Max, or with the cap Off, it is off (`active`) and the climb starts again
 * from 0 when it comes back on.
 *
 * Inputs: the pacer's target (`setTarget`; 0 = Max), the cap (`setCap`, during a run too),
 * the live frames observed (`liveFrames`), and for the readout every live batch (`liveBatch`)
 * and every settle answer (`delivered`), summarised by `update`.
 */
export class SettleGovernor {
  private limitNow: GovernorLimit = 'off';
  private target = 0;
  private paused = false;
  private owedFrames = 0;
  /** Readout only: chunks queued beyond this many name the limit `look-back` or `slow-worker`. */
  private readonly bank: number;
  /** Live frames observed with a library since the settle came on (the climb). */
  private climbed = 0;
  private backlogFrames = 0;
  private lastCheck: number | null = null;
  private samples: LiveSample[] = [];
  private deliveredFrames = 0;
  private busyMs = 0;
  private achievedFps: number | null = null;
  private lastDelivered = 0;
  private lastBusy = 0;

  constructor(
    /** The cap, re-read frames per live frame (`CSETTLE.rates`; 0 = Off). Changes with `setCap`. */
    private capNow: number,
    /** Settle look-back workers (1 when the settle takes turns with need-driven look-back). */
    private workers = 1,
    readonly chunk: number = CSETTLE.chunk,
    bankChunks: number = CSETTLE.bankChunks,
  ) {
    this.bank = chunk * bankChunks;
  }

  /** The settle look-back workers serving now (a failed pool worker leaves fewer; readout only). */
  setWorkers(n: number): void {
    this.workers = Math.max(1, n);
  }

  /** The cap, re-read frames per live frame (0 = Off). */
  get cap(): number {
    return this.capNow;
  }

  /** A new cap during a run (0 = Off: nothing owed, the climb starts again when it is back). */
  setCap(cap: number): void {
    const c = Number.isFinite(cap) && cap > 0 ? cap : 0;
    if (c === this.capNow) return;
    this.capNow = c;
    if (!this.on) this.switchOff();
    else {
      if (this.isOff) this.limitNow = 'waiting';
      this.owedFrames = Math.min(this.owedFrames, this.chunk);
    }
  }

  /** The settle may run: a target below Max and a cap above 0. */
  private get on(): boolean {
    return this.target > 0 && this.capNow > 0;
  }

  private get isOff(): boolean {
    return this.limitNow === 'off' || this.limitNow === 'cap-off';
  }

  private switchOff(): void {
    this.owedFrames = 0;
    this.climbed = 0;
    this.limitNow = this.target > 0 ? 'cap-off' : 'off';
  }

  /** The pacer's target live fps (0: Max) and whether the run is paused. A change restarts the fps window. */
  setTarget(fps: number, paused: boolean): void {
    const t = Number.isFinite(fps) && fps > 0 ? fps : 0;
    if (t !== this.target || paused !== this.paused) {
      this.samples = [];
      this.lastCheck = null;
      this.deliveredFrames = 0;
      this.busyMs = 0;
    }
    this.target = t;
    this.paused = paused;
    if (!this.on) this.switchOff();
    else if (this.isOff) this.limitNow = 'waiting';
  }

  /** Re-read frames per live frame earned by the next live frame observed with a library. */
  private get dose(): number {
    return Math.min(this.capNow, (this.climbed + 1) / GOVERNOR.rampFrames);
  }

  /** The climb has reached the cap. */
  private get atCap(): boolean {
    return this.climbed >= this.capNow * GOVERNOR.rampFrames;
  }

  /**
   * `observed` live frames went into the slow loop (a batch); `hasLibrary`: a library was
   * published before them. Each earns the dose.
   */
  liveFrames(observed: number, hasLibrary: boolean): void {
    if (!this.on || !hasLibrary) return;
    for (let i = 0; i < observed; i++) {
      this.owedFrames += this.dose;
      this.climbed++;
    }
    if (this.limitNow === 'waiting') this.limitNow = this.atCap ? 'cap' : 'ramping';
  }

  /** Re-read frames taken and not yet asked for (readout). */
  setBacklog(frames: number): void {
    this.backlogFrames = frames;
  }

  /** A live batch reached the slow worker: sent at `t` (ms, the clock of `update`), ending at stream index `end` (readout). */
  liveBatch(t: number, end: number): void {
    if (this.target <= 0 || this.paused) return;
    this.samples.push({ t, end });
    const keep = t - 2 * GOVERNOR.belowMs;
    while (this.samples.length > 2 && this.samples[0].t < keep) this.samples.shift();
  }

  /** A settle answer of `frames` frames came back; its worker was busy `busyMs` on it (readout). */
  delivered(frames: number, busyMs: number): void {
    this.deliveredFrames += frames;
    if (Number.isFinite(busyMs) && busyMs > 0) this.busyMs += busyMs;
  }

  /** Live fps over the last `GOVERNOR.belowMs` (null: under 3/4 of that window measured). */
  private achieved(now: number): number | null {
    const s = this.samples;
    if (s.length < 2) return null;
    const last = s[s.length - 1];
    // Nothing for half a second: the stall counts.
    const tEnd = now - last.t > 500 ? now : last.t;
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

  /** The readout: once a `GOVERNOR.checkMs` window has passed, its achieved fps, delivery and limit. */
  update(now: number, hasLibrary: boolean): void {
    if (this.lastCheck === null) this.lastCheck = now;
    const dt = now - this.lastCheck;
    if (dt < GOVERNOR.checkMs) return;
    this.lastCheck = now;
    this.lastDelivered = (this.deliveredFrames * 1000) / dt;
    this.lastBusy = this.busyMs / (dt * this.workers);
    this.deliveredFrames = 0;
    this.busyMs = 0;
    this.achievedFps = this.achieved(now);
    if (!this.on || this.paused) return;
    if (!hasLibrary) this.limitNow = 'waiting';
    else if (this.backlogFrames > this.bank)
      this.limitNow = this.lastBusy >= GOVERNOR.busyShare ? 'look-back' : 'slow-worker';
    else this.limitNow = this.atCap ? 'cap' : 'ramping';
  }

  /** The settle may run now (a target below Max and a cap above 0): queued chunks may go out. */
  get active(): boolean {
    return this.on;
  }

  /** The dose as a rate at the target, re-read frames per second. */
  get rate(): number {
    return this.on ? Math.min(this.capNow, this.climbed / GOVERNOR.rampFrames) * this.target : 0;
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
      rate: this.rate,
      limit: this.limitNow,
      target: this.target,
      paused: this.paused,
      achieved: this.achievedFps,
      capFps: this.capNow * (this.achievedFps ?? this.target),
      cap: this.capNow,
      deliveredFps: this.lastDelivered,
      busy: this.lastBusy,
      credit: this.owedFrames,
      halvings: 0,
      slowHalvings: 0,
      backlog: this.backlogFrames,
    };
  }
}
