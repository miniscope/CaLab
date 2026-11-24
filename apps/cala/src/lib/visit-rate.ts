/**
 * The Discover visit rate: tile visits per Discover frame, held between a
 * floor and a cap so that cala's results stop depending on machine speed and
 * the Speed setting.
 *
 * Visits per Discover frame set how many cells Discover finds and, at high
 * rates, how many false cells it adds; footprint and trace quality do not
 * move (`tools/cala-eval/results/2026-11-24-visit-budget-sweep.md`). Before
 * this, the rate was whatever time was spare: about 0.2 visits per frame at
 * Max (the slow worker saturated) and about 4.7 paced at 30 fps.
 *
 * - **Cap** (in the engine, `crates/cala/src/discover/visitrate.rs`): ordinary
 *   visits are handed out against a credit that grows by `cap` per observed
 *   Discover frame, so a paced or slow run stops over-visiting. Settle visits,
 *   the Final settle and Refine-scope visits are not held. Recordings and live
 *   streams alike.
 * - **Floor and target** (here, `VisitRateGovernor`): when the visits fall
 *   behind the target because the slow worker and the visit workers cannot keep
 *   up, the frame loop is held to a lower speed, the speed at which the
 *   measured visit throughput meets the target; below the floor it is cut
 *   harder. The Speed setting still applies: the effective target is the lower
 *   of the two (`effectivePace`). Recordings only: a live stream cannot slow
 *   down.
 *
 * The floor and target count visits per frame **read** (the stream frames
 * Discover went through, dropped batches included), the cap per frame
 * observed. A run at Max drops batches for the slow loop (about 25 % of the
 * frames on the 3k sim); counted per observed frame, dropping frames would
 * itself meet the rate, and a run that drops more would visit less over the
 * same recording, which is the speed dependence this removes. Per frame read,
 * a recording gets the same number of visits however fast it was read, and
 * holding the speed also ends most of the drops. The cap is per observed
 * frame because the engine only sees those; it never binds below the target.
 *
 * `?debug&visitrate=off` restores the behaviour before (no cap, no hold).
 * Pure: the clock is passed in; unit-tested in `visit-rate.test.ts`.
 */

/** The constants in one place (provisional: being confirmed on full-length motion sims and real data). */
export const VISIT_RATE = {
  /** Visits per Discover frame read: the least the governor accepts. */
  floor: 0.2,
  /** Visits per Discover frame read: what the governor holds the speed for. */
  target: 0.4,
  /** Visits per observed Discover frame at most (the engine's credit). */
  cap: 1.0,
  /** Measurement window, ms of run time. */
  windowMs: 1000,
  /** Frames read before the governor acts (the first library and the first visits). */
  warmupFrames: 100,
  /** A window with fewer frames read does not count (paused, stalled). */
  minWindowFrames: 16,
  /** The hold never goes below this, fps. */
  minHoldFps: 2,
  /** The most the hold rises per window. */
  raise: 1.25,
  /** The achieved rate must beat the target by this factor before the hold is raised. */
  raiseMargin: 1.1,
  /** Below the floor, the hold is cut this much further (catching up). */
  floorCut: 0.75,
  /** The cap held visits back on at least this share of a window's observed frames: the cap binds. */
  capBoundShare: 0.25,
  /** The visits used at least this share of the credit the observed frames earned: the cap binds. */
  capBoundCredit: 0.9,
  /** Tiles were due on at least this share of a window's samples: visits had demand. */
  demandShare: 0.5,
  /** The hold is released once it is this far above the frames actually read (not binding any more). */
  releaseMargin: 1.25,
} as const;

export type VisitRateConstants = { readonly [K in keyof typeof VISIT_RATE]: number };

/** What the visit rate does in a run. */
export type VisitRateMode =
  /** Cap and floor/target (a recording's Discover). */
  | 'on'
  /** Cap only (a live stream: it cannot slow down). */
  | 'cap-only'
  /** Neither (`?debug&visitrate=off`: the behaviour before). */
  | 'off';

/** The mode of a run: `off` from the URL wins, a live stream gets the cap only. */
export function visitRateMode(urlOff: boolean, live: boolean): VisitRateMode {
  if (urlOff) return 'off';
  return live ? 'cap-only' : 'on';
}

/** The cap the slow loop is started with (0: none). */
export function visitRateCap(mode: VisitRateMode, k: VisitRateConstants = VISIT_RATE): number {
  return mode === 'off' ? 0 : k.cap;
}

/** The pace sent to the frame gate: the user's target (0 = Max) and the hold (null = none), whichever is lower. */
export function effectivePace(user: number, hold: number | null): number {
  if (hold === null || !(hold > 0)) return user > 0 ? user : 0;
  return user > 0 ? Math.min(user, hold) : hold;
}

/** One reading of the slow worker's status during Discover. */
export interface VisitRateSample {
  /** Run time without pauses, ms. */
  now: number;
  /** Stream frames Discover went through (`SlowStatus.consumed`), and frames the slow loop observed. */
  framesRead: number;
  observed: number;
  /** Ordinary visits so far (`SlowCounters.visits`). */
  visits: number;
  /** Frames on which the cap held a due visit back (`VisitRateCounters.cappedFrames`; 0 without a cap). */
  cappedFrames: number;
  /** Tiles due for a visit now. */
  dueTiles: number;
  /** The user's target, fps (0 = Max). */
  userFps: number;
}

/** A change of the hold, for the run record's log. */
export interface VisitHoldChange {
  frame: number;
  /** The new hold, fps (null: released). */
  fps: number | null;
  /** The window's visits per frame read, and why the hold moved. */
  achieved: number;
  reason: 'below-target' | 'below-floor' | 'raised' | 'released';
}

/** What the run record keeps (`RunRecordData.visit_rate`). */
export interface VisitRateSummary {
  mode: VisitRateMode;
  floor: number;
  target: number;
  cap: number;
  /** Visits per Discover frame read and per observed frame, over Discover (null: no frames). */
  achieved_visits_per_frame: number | null;
  achieved_visits_per_observed_frame: number | null;
  visits: number;
  frames_read: number;
  frames_observed: number;
  /** Frames on which the cap held a visit back. */
  capped_frames: number;
  /** Run time the hold slowed the run, s, and the lowest hold, fps (null: never held). */
  held_s: number;
  min_hold_fps: number | null;
  /** Run time the windowed rate sat below the floor, s. */
  below_floor_s: number;
  /** The hold's changes (at most `HOLD_LOG_MAX`; the rest are counted). */
  hold_changes: VisitHoldChange[];
  hold_changes_dropped: number;
}

export const HOLD_LOG_MAX = 200;

/**
 * Holds the frame loop's speed so that Discover's visits keep up with the
 * target rate. Feed it every slow-worker status of a Discover run (`update`);
 * it acts once per window and returns the new hold when it changes.
 */
export class VisitRateGovernor {
  private hold: number | null = null;
  private w: {
    t: number;
    read: number;
    observed: number;
    visits: number;
    capped: number;
    samples: number;
    due: number;
  } | null = null;
  private first: VisitRateSample | null = null;
  private last: VisitRateSample | null = null;
  private heldMs = 0;
  private belowFloorMs = 0;
  private minHold: number | null = null;
  private changes: VisitHoldChange[] = [];
  private dropped = 0;

  constructor(
    readonly mode: VisitRateMode,
    private readonly k: VisitRateConstants = VISIT_RATE,
  ) {}

  /** The hold now, fps (null: none). */
  get fps(): number | null {
    return this.hold;
  }

  /** The newest window's visits per frame read (null before the first window). */
  achieved: number | null = null;

  /** A status reading; returns the change when the hold moved. */
  update(s: VisitRateSample): VisitHoldChange | null {
    const k = this.k;
    if (this.first === null) this.first = s;
    const prev = this.last;
    this.last = s;
    // Time held: the hold slowed the run (below the user's target, or any hold at Max).
    if (prev && this.hold !== null && (s.userFps <= 0 || this.hold < s.userFps))
      this.heldMs += Math.max(0, s.now - prev.now);
    if (prev && this.achieved !== null && this.achieved < k.floor)
      this.belowFloorMs += Math.max(0, s.now - prev.now);
    if (s.framesRead < k.warmupFrames) {
      this.w = null;
      return null;
    }
    if (!this.w) {
      this.w = {
        t: s.now,
        read: s.framesRead,
        observed: s.observed,
        visits: s.visits,
        capped: s.cappedFrames,
        samples: 0,
        due: 0,
      };
      return null;
    }
    const w = this.w;
    w.samples++;
    if (s.dueTiles > 0) w.due++;
    const dt = s.now - w.t;
    if (dt < k.windowMs) return null;
    const dRead = s.framesRead - w.read;
    const dObs = s.observed - w.observed;
    const dVisits = s.visits - w.visits;
    const dCapped = s.cappedFrames - w.capped;
    const demand = w.samples > 0 ? w.due / w.samples : 0;
    this.w = {
      t: s.now,
      read: s.framesRead,
      observed: s.observed,
      visits: s.visits,
      capped: s.cappedFrames,
      samples: 0,
      due: 0,
    };
    if (dRead < k.minWindowFrames) return null;
    const achieved = dVisits / dRead;
    this.achieved = achieved;
    const readFps = (dRead / dt) * 1000;
    const throughput = (dVisits / dt) * 1000;
    // The cap binds when the visits used (nearly) all the credit the observed frames earned, or the
    // engine reported a held-back visit on a good share of them. (The engine counts at most one
    // capped frame per hand-out, i.e. per batch with visit workers, so the count alone reads low.)
    const capBound =
      dObs > 0 && (dVisits >= k.capBoundCredit * k.cap * dObs || dCapped >= k.capBoundShare * dObs);
    // Measured in every mode (the record); only `on` holds the speed.
    if (this.mode !== 'on') return null;
    const supplyLimited = achieved < k.target && !capBound && demand >= k.demandShare;
    if (supplyLimited) {
      let want = throughput / k.target;
      const reason = achieved < k.floor ? 'below-floor' : 'below-target';
      if (reason === 'below-floor') want *= k.floorCut;
      want = Math.max(k.minHoldFps, want);
      // Down at once; up (the throughput rose as the run slowed) by at most `raise` per window.
      const next =
        this.hold === null ? Math.min(want, readFps) : Math.min(want, this.hold * k.raise);
      if (this.hold !== null && Math.abs(next - this.hold) < 0.02 * this.hold) return null;
      if (this.hold === null && next >= readFps) return null;
      return this.set(
        next,
        s.framesRead,
        achieved,
        next < (this.hold ?? Infinity) ? reason : 'raised',
      );
    }
    if (this.hold === null) return null;
    // Not behind: release once the hold no longer binds (the run reads well below it, or the
    // user's own target is lower), else raise it while the rate is comfortably above the target
    // (or the cap or a lack of due tiles is what limits the visits).
    const userBinds = s.userFps > 0 && this.hold >= s.userFps;
    if (userBinds || readFps * k.releaseMargin < this.hold)
      return this.set(null, s.framesRead, achieved, 'released');
    if (achieved >= k.target * k.raiseMargin || capBound || demand < k.demandShare)
      return this.set(this.hold * k.raise, s.framesRead, achieved, 'raised');
    return null;
  }

  private set(
    fps: number | null,
    frame: number,
    achieved: number,
    reason: VisitHoldChange['reason'],
  ): VisitHoldChange {
    this.hold = fps;
    if (fps !== null) this.minHold = this.minHold === null ? fps : Math.min(this.minHold, fps);
    const c: VisitHoldChange = { frame, fps, achieved, reason };
    if (this.changes.length < HOLD_LOG_MAX) this.changes.push(c);
    else this.dropped++;
    return c;
  }

  /** Release the hold (Discover ended). */
  release(): void {
    this.hold = null;
  }

  summary(): VisitRateSummary {
    const k = this.k;
    const a = this.first;
    const b = this.last;
    const read = b ? b.framesRead : 0;
    const observed = b ? b.observed : 0;
    const visits = b ? b.visits : 0;
    return {
      mode: this.mode,
      floor: k.floor,
      target: k.target,
      cap: this.mode === 'off' ? 0 : k.cap,
      achieved_visits_per_frame: read > 0 ? visits / read : null,
      achieved_visits_per_observed_frame: observed > 0 ? visits / observed : null,
      visits,
      frames_read: read,
      frames_observed: observed,
      capped_frames: b ? b.cappedFrames - (a?.cappedFrames ?? 0) : 0,
      held_s: this.heldMs / 1000,
      min_hold_fps: this.minHold,
      below_floor_s: this.belowFloorMs / 1000,
      hold_changes: this.changes.map((c) => ({ ...c })),
      hold_changes_dropped: this.dropped,
    };
  }
}

/** The Speed block's line while the hold binds (null: it does not). */
export function visitHoldText(
  hold: number | null,
  userFps: number,
  k: VisitRateConstants = VISIT_RATE,
): string | null {
  if (hold === null || (userFps > 0 && hold >= userFps)) return null;
  return `Held at ${Math.round(hold)} fps to keep refinement at ${k.target} visits/frame`;
}
