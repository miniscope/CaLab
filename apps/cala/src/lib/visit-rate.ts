/**
 * The Discover visit rate: tile visits per Discover frame, held between a
 * floor and a cap so that cala's results stop depending on machine speed and
 * the Speed setting, with a target the engine's schedule sets.
 *
 * Visits per Discover frame set how many cells Discover finds and, at high
 * rates, how many false cells it adds; footprint and trace quality do not
 * move (`tools/cala-eval/results/2026-11-24-visit-budget-sweep.md`). Before
 * the fixed rate, the rate was whatever time was spare: about 0.2 visits per
 * frame at Max (the slow worker saturated) and about 4.7 paced at 30 fps.
 *
 * - **Schedule** (in the engine, `crates/cala/src/discover/visitrate.rs`,
 *   `VisitSchedule`; the one source of truth, shared with `qc_eval`): **Auto**
 *   (opt-in, `?debug&visitrate=auto`) keeps the target at 0.15 visits per frame while visits find
 *   new cells, slides it down a ladder to 0.0375 as new cells stop turning up
 *   and back up when they appear again. The signal is new cells per visit,
 *   never time or speed. **Fixed** (the default) keeps 0.15.
 *   The engine reports the target in force with every status
 *   (`VisitRateCounters.target`); this file reads it from there.
 * - **Cap** (in the engine): ordinary visits are handed out against a credit
 *   that grows by the cap (4/3 of the target in force) per observed Discover
 *   frame, so a paced or slow run stops over-visiting. Settle visits, the
 *   Final settle and Refine-scope visits are not held. Recordings and live
 *   streams alike.
 * - **Floor and target** (here, `VisitRateGovernor`): when the visits fall
 *   behind the target because the slow worker and the visit workers cannot keep
 *   up, the frame loop is held to a lower speed, the speed at which the
 *   measured visit throughput meets the target; below the floor (2/3 of the
 *   target) it is cut harder. The Speed setting still applies: the effective
 *   target is the lower of the two (`effectivePace`). Recordings only: a live
 *   stream cannot slow down.
 *
 * The floor and target count visits per frame **read** (the stream frames
 * Discover went through, dropped batches included), the cap per frame
 * observed. A run at Max drops batches for the slow loop (about 25 % of the
 * frames on the 3k sim); counted per observed frame, dropping frames would
 * itself meet the rate, and a run that drops more would visit less over the
 * same recording, which is the speed dependence this removes. Per frame read,
 * a recording gets the same number of visits however fast it was read, and
 * holding the speed also ends most of the drops. The cap is per observed
 * frame because the engine only sees those. With the cap close to the target, a run that drops many
 * frames can sit under the target per frame read while the cap binds per observed frame; the governor
 * then still slows it (`dropMargin`), since fewer drops is what raises the rate.
 *
 * `?debug&visitrate=off` restores the behaviour before the fixed rate (no cap, no hold);
 * `?debug&visitrate=auto` the Auto schedule (the default is the fixed rate).
 * Pure: the clock is passed in; unit-tested in `visit-rate.test.ts`.
 */

/**
 * The constants in one place. `floor`, `target` and `cap` are the fixed schedule's values and
 * where Auto starts (the engine's `VisitSchedule::fixed`; mirrored here for the Speed block's
 * text before the first status and for older builds). During a run the governor uses the values
 * the engine reports. Chosen from constant-rate qc_eval runs (PR #500): on full-length sims
 * recall saturates by about 0.2 while false cells (late second copies of found cells) keep growing.
 * At 0.15 the motion sim has the most matched-minus-false cells of the rates tried (677 against 660
 * at 0.25, 35 false cells against 58) and the static sim the same (739 / 737); on real data 0.15
 * gives the same QC-pass cells as 0.25. Only early in a recording (the first ~2000 frames) do more
 * visits find cells sooner (recall 4-5 points lower at 0.15 than at 0.25 there). Visits are what the
 * slow worker spends its time on, so the lower rate also lets Discover run faster. The cap at 0.2
 * keeps paced runs close to held Max runs.
 */
export const VISIT_RATE = {
  /** Visits per Discover frame read: the least the governor accepts (2/3 of the target). */
  floor: 0.1,
  /** Visits per Discover frame read: what the governor holds the speed for (Auto's top). */
  target: 0.15,
  /** Visits per observed Discover frame at most (the engine's credit; 4/3 of the target). */
  cap: 0.2,
  /** Auto's lowest target (the engine's `VisitSchedule::auto().floor()`). */
  autoFloor: 0.0375,
  /** Measurement window, ms of run time. */
  windowMs: 1000,
  /** Frames read before the governor acts (the first library and the first visits). */
  warmupFrames: 100,
  /** A window with fewer frames read does not count (paused, stalled). */
  minWindowFrames: 16,
  /**
   * A window must expect at least this many visits at the target (frames read x target): at
   * Auto's lowest target a 1 s window at 160 fps holds about 6, and rounding would read as behind.
   */
  minWindowVisits: 8,
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
  /** The cap binds but drops cost more than this share of the target per frame read: hold anyway. */
  dropMargin: 0.9,
  /** Tiles were due on at least this share of a window's samples: visits had demand. */
  demandShare: 0.5,
  /** The hold is released once it is this far above the frames actually read (not binding any more). */
  releaseMargin: 1.25,
  /** Windows the visit-limited top speed (`visitMaxFps`) is the median of. */
  maxWindows: 5,
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

/** How the target is set: the fixed rate (the default) or the engine's Auto schedule (opt-in). */
export type VisitSchedule = 'auto' | 'fixed';

/** The `?debug&visitrate=` setting: `off`, `auto` or (default) `fixed`. */
export type VisitRateSetting = VisitSchedule | 'off';

/** The URL's `visitrate` value as a setting (anything else: the fixed default). */
export function visitRateSetting(param: string | null | undefined): VisitRateSetting {
  return param === 'off' || param === 'auto' ? param : 'fixed';
}

/** The mode of a run: `off` from the URL wins, a live stream gets the cap only. */
export function visitRateMode(urlOff: boolean, live: boolean): VisitRateMode {
  if (urlOff) return 'off';
  return live ? 'cap-only' : 'on';
}

/** The cap the slow loop is started with (0: none; with a schedule the engine sets it). */
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
  /**
   * The engine's schedule (`VisitRateCounters`; absent in older builds: the constants): the target
   * in force and the hold's floor under it, visits per frame; the cap in force, visits per observed
   * frame; the credit earned so far; the yields (new cells per visit); the schedule's parameters.
   */
  target?: number;
  holdFloor?: number;
  cap?: number;
  earned?: number;
  yieldSlow?: number;
  yieldFast?: number;
  newCells?: number;
  scheduleParams?: readonly number[];
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

/** A change of the schedule's target, for the run record's log. */
export interface VisitTargetChange {
  /** Frames read when the status showed it. */
  frame: number;
  /** The new target, visits per frame. */
  target: number;
  /** New cells per visit, slow and fast windows, at that status. */
  yield_slow: number | null;
  yield_fast: number | null;
}

/** The engine's schedule parameters (`VisitRateCounters.schedule`) by name. */
export interface VisitScheduleParams {
  auto: boolean;
  target: number;
  steps: number;
  full_yield: number;
  slow_half_life_visits: number;
  fast_half_life_visits: number;
  warmup_visits_per_tile: number;
  cap_ratio: number;
  floor: number;
  hold_floor_ratio: number;
}

/** `VisitRateCounters.schedule` as named parameters (null: none). */
export function visitScheduleParams(a: readonly number[] | undefined): VisitScheduleParams | null {
  if (!a || a.length < 10) return null;
  return {
    auto: a[0] === 1,
    target: a[1],
    steps: a[2],
    full_yield: a[3],
    slow_half_life_visits: a[4],
    fast_half_life_visits: a[5],
    warmup_visits_per_tile: a[6],
    cap_ratio: a[7],
    floor: a[8],
    hold_floor_ratio: a[9],
  };
}

/** What the run record keeps (`RunRecordData.visit_rate`). */
export interface VisitRateSummary {
  mode: VisitRateMode;
  /** The schedule asked for (`auto` or `fixed`; null with the visit rate off). */
  schedule: VisitSchedule | null;
  /** The engine's schedule parameters (null: none reported, e.g. off or an older build). */
  schedule_params: VisitScheduleParams | null;
  /** The fixed rate's values (Auto's top): the governor's floor and target, and the cap. */
  floor: number;
  target: number;
  cap: number;
  /** The target in force at the last status, and the lowest it reached (null: never reported). */
  target_now: number | null;
  target_min: number | null;
  /** Frames read at each target (`frames` per `target`, in the order first seen). */
  target_frames: { target: number; frames: number }[];
  /** The target's changes (at most `HOLD_LOG_MAX`; the rest are counted). */
  target_changes: VisitTargetChange[];
  target_changes_dropped: number;
  /** New cells the schedule counted and its yields (new cells per visit) at the last status. */
  new_cells: number | null;
  yield_slow: number | null;
  yield_fast: number | null;
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
    earned: number | null;
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
  /** Recent readings of the visit throughput the run can sustain, visits/s (see `visitMaxFps`). */
  private maxes: number[] = [];
  /** The schedule's target as reported (null: not yet), its log and its frames. */
  private tgt: number | null = null;
  private tgtMin: number | null = null;
  private tgtChanges: VisitTargetChange[] = [];
  private tgtDropped = 0;
  private tgtFrames: { target: number; frames: number }[] = [];

  constructor(
    readonly mode: VisitRateMode,
    private readonly k: VisitRateConstants = VISIT_RATE,
    readonly schedule: VisitSchedule | null = mode === 'off' ? null : 'fixed',
  ) {}

  /** The hold now, fps (null: none). */
  get fps(): number | null {
    return this.hold;
  }

  /** The newest window's visits per frame read (null before the first window). */
  achieved: number | null = null;

  /** The target in force, visits per frame (the engine's, else the constant). */
  get target(): number {
    return this.tgt ?? this.k.target;
  }

  /** New cells per visit (slow window) at the last status (null: not reported). */
  get yieldSlow(): number | null {
    return this.last?.yieldSlow ?? null;
  }

  /**
   * The fastest the run can read while the visits keep the target, fps (null: not known). With the
   * hold on, this, not the fast loop's own top speed, is what Max reaches. Measured only where the
   * visits held the run back (throughput / target), so a paced run whose visits the cap limits gives
   * no reading (its throughput says nothing about the spare capacity); a later window that read
   * faster while keeping up raises it. Kept as visit throughput (visits/s, the median of the last
   * `maxWindows` readings) and divided by the target in force, so a lower Auto target raises it.
   * Null unless the mode is `on`.
   */
  get visitMaxFps(): number | null {
    if (this.mode !== 'on' || this.maxes.length === 0) return null;
    const a = [...this.maxes].sort((x, y) => x - y);
    const m = a.length >> 1;
    const med = a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    return med / this.target;
  }

  private noteMax(visitsPerS: number): void {
    if (!(visitsPerS > 0) || !Number.isFinite(visitsPerS)) return;
    this.maxes.push(visitsPerS);
    if (this.maxes.length > this.k.maxWindows) this.maxes.shift();
  }

  /** Track the schedule's target from a status: its log, its frames and its lowest value. */
  private noteTarget(s: VisitRateSample, prev: VisitRateSample | null): void {
    const t = s.target;
    if (t === undefined || !(t > 0)) return;
    if (prev && this.tgt !== null) {
      const d = Math.max(0, s.framesRead - prev.framesRead);
      const cur = this.tgtFrames.find((e) => e.target === this.tgt);
      if (cur) cur.frames += d;
    }
    if (this.tgt === null || Math.abs(t - this.tgt) > 1e-9 * t) {
      this.tgt = t;
      this.tgtMin = this.tgtMin === null ? t : Math.min(this.tgtMin, t);
      if (!this.tgtFrames.some((e) => e.target === t))
        this.tgtFrames.push({ target: t, frames: 0 });
      const c: VisitTargetChange = {
        frame: s.framesRead,
        target: t,
        yield_slow: s.yieldSlow ?? null,
        yield_fast: s.yieldFast ?? null,
      };
      if (this.tgtChanges.length < HOLD_LOG_MAX) this.tgtChanges.push(c);
      else this.tgtDropped++;
    }
  }

  /** A status reading; returns the change when the hold moved. */
  update(s: VisitRateSample): VisitHoldChange | null {
    const k = this.k;
    if (this.first === null) this.first = s;
    const prev = this.last;
    this.last = s;
    this.noteTarget(s, prev);
    const target = this.target;
    const floor =
      s.holdFloor !== undefined && s.holdFloor > 0 ? s.holdFloor : (target * k.floor) / k.target;
    const cap = s.cap !== undefined && s.cap > 0 ? s.cap : (target * k.cap) / k.target;
    // Time held: the hold slowed the run (below the user's target, or any hold at Max).
    if (prev && this.hold !== null && (s.userFps <= 0 || this.hold < s.userFps))
      this.heldMs += Math.max(0, s.now - prev.now);
    if (prev && this.achieved !== null && this.achieved < floor)
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
        earned: s.earned ?? null,
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
    const dEarned = s.earned !== undefined && w.earned !== null ? s.earned - w.earned : null;
    const demand = w.samples > 0 ? w.due / w.samples : 0;
    // Too few frames read, or too few visits expected at the target: keep the window open rather
    // than start a new one. Closing it would make a hold below `minWindowFrames` fps per window
    // permanent (no window would ever count, so the hold could never rise); seen on a 3 h v4
    // recording held at 5 fps for minutes. At Auto's low targets a short window holds only a few
    // visits, and rounding would read as behind (the fixed rate keeps main's window rule exactly).
    if (dRead < k.minWindowFrames) return null;
    if (this.schedule === 'auto' && dRead * target < k.minWindowVisits) return null;
    this.w = {
      t: s.now,
      read: s.framesRead,
      observed: s.observed,
      visits: s.visits,
      capped: s.cappedFrames,
      earned: s.earned ?? null,
      samples: 0,
      due: 0,
    };
    const achieved = dVisits / dRead;
    this.achieved = achieved;
    const readFps = (dRead / dt) * 1000;
    const throughput = (dVisits / dt) * 1000;
    // The cap binds when the visits used (nearly) all the credit the observed frames earned (the
    // engine's count when it reports one, else the cap in force times the frames), or the engine
    // reported a held-back visit on a good share of them. (The engine counts at most one capped
    // frame per hand-out, i.e. per batch with visit workers, so the count alone reads low. Visits
    // are whole and the credit is not: one visit of slack, which matters at low rates, where a
    // window holds only a handful of visits.)
    const credit = dEarned ?? cap * dObs;
    const capBound =
      dObs > 0 && (dVisits + 1 >= k.capBoundCredit * credit || dCapped >= k.capBoundShare * dObs);
    // Measured in every mode (the record); only `on` holds the speed.
    if (this.mode !== 'on') return null;
    // With the cap near the target, dropped frames alone can keep the rate per frame read below the
    // target while the cap binds per observed frame: then slowing down (fewer drops) is what helps.
    const dropBound = capBound && dObs < k.dropMargin * dRead * (target / cap);
    const supplyLimited = achieved < target && (!capBound || dropBound) && demand >= k.demandShare;
    if (supplyLimited) {
      this.noteMax(throughput);
      let want = throughput / target;
      const reason = achieved < floor ? 'below-floor' : 'below-target';
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
    // Kept up at this read rate: the visits allow at least this speed.
    const vmax = this.visitMaxFps;
    if (vmax !== null && readFps > vmax) this.noteMax(readFps * target);
    if (this.hold === null) return null;
    // Not behind: release once the hold no longer binds (the run reads well below it, or the
    // user's own target is lower), else raise it while the rate is comfortably above the target
    // (or the cap or a lack of due tiles is what limits the visits).
    const userBinds = s.userFps > 0 && this.hold >= s.userFps;
    if (userBinds || readFps * k.releaseMargin < this.hold)
      return this.set(null, s.framesRead, achieved, 'released');
    if (achieved >= target * k.raiseMargin || capBound || demand < k.demandShare)
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
      schedule: this.mode === 'off' ? null : this.schedule,
      schedule_params: visitScheduleParams(b?.scheduleParams),
      floor: k.floor,
      target: k.target,
      cap: this.mode === 'off' ? 0 : k.cap,
      target_now: this.tgt,
      target_min: this.tgtMin,
      target_frames: this.tgtFrames.map((e) => ({ ...e })),
      target_changes: this.tgtChanges.map((c) => ({ ...c })),
      target_changes_dropped: this.tgtDropped,
      new_cells: b?.newCells ?? null,
      yield_slow: b?.yieldSlow ?? null,
      yield_fast: b?.yieldFast ?? null,
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

/**
 * The top speed a run can reach, fps (0: not known): the fast loop's own (`MaxFpsEstimator`) and,
 * with the visit rate on, the speed the visits allow (`VisitRateGovernor.visitMaxFps`), whichever
 * is lower. With the visit rate off or cap-only the second is null and this is the fast loop's.
 */
export function heldMaxFps(fastFps: number, visitMax: number | null): number {
  const fast = fastFps > 0 && Number.isFinite(fastFps) ? fastFps : 0;
  if (visitMax === null || !(visitMax > 0)) return fast;
  return fast > 0 ? Math.min(fast, visitMax) : visitMax;
}

/** A visit rate for display: three significant digits at most (0.15, 0.106, 0.0375). */
export function fmtVisitRate(r: number): string {
  return Number(r.toPrecision(3)).toString();
}

/** The Speed block's line while the hold binds (null: it does not). */
export function visitHoldText(
  hold: number | null,
  userFps: number,
  target: number = VISIT_RATE.target,
): string | null {
  if (hold === null || (userFps > 0 && hold >= userFps)) return null;
  return `Held at ${Math.round(hold)} fps to keep refinement at ${fmtVisitRate(target)} visits/frame`;
}

/**
 * The Speed block's line on the visit rate in force during Discover (null: off). Auto says
 * whether new cells are still turning up (the target at its top) or not (below it).
 */
export function visitRateText(
  mode: VisitRateMode | null,
  schedule: VisitSchedule | null,
  target: number | null,
  yieldSlow: number | null,
  k: VisitRateConstants = VISIT_RATE,
): string | null {
  if (mode === null || mode === 'off') return null;
  const t = target ?? k.target;
  const rate = `Refinement ${fmtVisitRate(t)} visits/frame`;
  const live = mode === 'cap-only' ? ', at most' : '';
  if (schedule !== 'auto') return `${rate} (fixed${live})`;
  const per = yieldSlow !== null && Number.isFinite(yieldSlow) ? yieldSlow : null;
  const found =
    per === null ? '' : `, ${fmtVisitRate(Math.max(per, 0) * 100)} new cells per 100 visits`;
  return t >= k.target * (1 - 1e-6)
    ? `${rate} (Auto: new cells still turning up${found}${live})`
    : `${rate} (Auto: fewer new cells lately${found}; back up when they turn up${live})`;
}

/**
 * The Speed block's note at Max (null: not at Max). With 12 or more cores the Final settle runs a
 * second look-back worker (the settle pool), whose answers can arrive in a different order, so two
 * runs at Max can differ slightly; a target fps makes the run repeatable.
 */
export function maxRepeatText(userFps: number): string | null {
  return userFps > 0
    ? null
    : 'Results can differ slightly between runs at Max; set a target fps for repeatable runs.';
}
