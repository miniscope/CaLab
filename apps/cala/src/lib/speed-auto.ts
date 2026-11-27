/**
 * Auto speed: a time budget. The user picks how much extra time over a Max-speed run they
 * will spend (+50, +100 or +200 %); Auto estimates the Max run's time from the measured Max rate and the frame count, and
 * paces the run so it ends near that budget. A `TargetPolicy`: it plugs into the same
 * `SpeedDriver` and `armPolicy` seam as a curve. Pure: no store, no DOM, the clock is passed in.
 *
 * The budget is for Discover (reading the recording); the Final settle comes on top of it, unless
 * a Final settle estimate is passed in, which then counts against the budget.
 *
 * Rules, in order:
 *  - Until the Max rate is measured over `MIN_BATCHES` unpaced batches the run goes at Max. That
 *    measure is kept while paced below Max and only ever rises (settling work competing for the
 *    machine would otherwise push it down and the target with it, toward the floor).
 *  - Every `evalFrames` frames or `evalS` seconds the target is worked out again:
 *    `budget = (1 + share) x (frames to read / Max rate)`, `left = budget - elapsed - final settle`,
 *    `target = frames still to read / left`.
 *  - Never below the smart floor (slower gains nothing: sit at the floor and finish early); at or
 *    above the Max rate, or out of time, the target is Max.
 *  - Hysteresis: a new target within `holdRatio` of the one in force is not taken.
 * The Speed block's quality-aware closed loop is not here (it needs a settledness measure).
 */
import { AUTO_BUDGETS, AUTO_DEFAULT_BUDGET, budgetLabel, isAutoBudget } from './speed-track.ts';
import { snapToLadder } from './speed-floor.ts';
import {
  resolveFps,
  type PolicyInput,
  type PolicyTarget,
  type TargetPolicy,
} from './speed-schedule.ts';

/** Settings of Auto speed. */
export const AUTO = {
  /** Work the target out again this many frames after the last time ... */
  evalFrames: 2000,
  /** ... or this many seconds, whichever comes first. */
  evalS: 30,
  /** A target closer than this (a ratio) to the one in force is not taken. */
  holdRatio: 0.15,
  /** Batches read at Max before the Max rate is trusted (the first is warm-up and may read slow). */
  minBatches: 5,
  /** The record keeps at most this many decisions (the first, then the newest). */
  maxDecisions: 40,
} as const;

/** Why Auto chose its target. */
export type AutoReason = 'budget' | 'floor' | 'max' | 'over budget';

/** One change of target, compact, for the run record. */
export interface AutoDecision {
  frame: number;
  /** The target set, fps (0: Max). */
  fps: number;
  reason: AutoReason;
  /** The Max rate it was worked from, fps. */
  max_fps: number;
  /** The time the budget left for the frames still to read, seconds (rounded). */
  left_s: number;
}

/** Round a wanted rate to something steady: the floor's ladder below 300, steps of 50 above. */
function steady(fps: number): number {
  return fps > 300 ? Math.round(fps / 50) * 50 : snapToLadder(fps);
}

/**
 * A wall clock that leaves paused time out: `now(rawMs)` is the raw clock less the time spent
 * paused, so a pause does not eat the budget.
 */
export class PauseClock {
  private pausedMs = 0;
  private since: number | null = null;

  pause(rawMs: number): void {
    this.since ??= rawMs;
  }

  resume(rawMs: number): void {
    if (this.since !== null) this.pausedMs += Math.max(0, rawMs - this.since);
    this.since = null;
  }

  reset(): void {
    this.pausedMs = 0;
    this.since = null;
  }

  now(rawMs: number): number {
    const open = this.since !== null ? Math.max(0, rawMs - this.since) : 0;
    return rawMs - this.pausedMs - open;
  }
}

/** The Auto target policy: paces the run to end within a time budget. */
export class AutoPolicy implements TargetPolicy {
  readonly source = 'auto' as const;
  readonly decisions: AutoDecision[] = [];
  private start: { frame: number; wallS: number } | null = null;
  private last: { frame: number; wallS: number } | null = null;
  /** The target in force (null: none worked out yet; 0: Max). */
  private cur: number | null = null;
  /** Batches seen with a Max estimate while unpaced. */
  private unpaced = 0;
  /** The Max rate the budget is worked from (null: not measured yet). */
  private maxLock: number | null = null;

  /**
   * @param share the extra time over a Max run, 0.5 to 2.
   * @param finalSettleS estimate of the Final settle's time, seconds (null: not known).
   */
  constructor(
    readonly share: number,
    private readonly finalSettleS: () => number | null = () => null,
  ) {}

  /** The target in force now, fps (0: Max; null: still measuring Max). */
  current(): number | null {
    return this.cur;
  }

  target(i: PolicyInput): PolicyTarget {
    const raw = i.maxFps;
    if (raw !== null && raw > 0) {
      if (this.cur === null || this.cur === 0) {
        // Unpaced: the estimate is a clean reading of Max.
        this.unpaced++;
        if (this.unpaced >= AUTO.minBatches) this.maxLock = raw;
      } else if (this.maxLock !== null && raw > this.maxLock) {
        this.maxLock = raw;
      }
    }
    const maxFps = this.maxLock;
    if (!(i.totalFrames > 0) || maxFps === null) {
      return { fps: this.cur ?? 0, phase: this.cur === null ? 'auto-measure' : 'auto' };
    }
    this.start ??= { frame: i.frame, wallS: i.wallS };
    const due =
      this.last === null ||
      i.frame - this.last.frame >= AUTO.evalFrames ||
      i.wallS - this.last.wallS >= AUTO.evalS;
    if (!due) return { fps: this.cur ?? 0, phase: 'auto' };
    this.last = { frame: i.frame, wallS: i.wallS };

    const remaining = i.totalFrames - i.frame;
    if (remaining <= 0) return { fps: this.cur ?? 0, phase: 'auto' };
    const budgetS = ((1 + this.share) * (i.totalFrames - this.start.frame)) / maxFps;
    const leftS = budgetS - (i.wallS - this.start.wallS) - (this.finalSettleS() ?? 0);
    const wanted = leftS > 0 ? remaining / leftS : Infinity;
    const floor = resolveFps('floor', i);

    let next: number;
    let reason: AutoReason;
    if (leftS <= 0) [next, reason] = [0, 'over budget'];
    else if (wanted >= maxFps || floor >= maxFps) [next, reason] = [0, 'max'];
    else if (wanted < floor) [next, reason] = [floor, 'floor'];
    else {
      next = Math.min(steady(wanted), maxFps);
      reason = 'budget';
      if (next < floor) [next, reason] = [floor, 'floor'];
    }

    if (this.cur !== null) {
      const was = this.cur > 0 ? this.cur : maxFps;
      const now = next > 0 ? next : maxFps;
      if (Math.abs(now - was) / was < AUTO.holdRatio) return { fps: this.cur, phase: 'auto' };
    }
    if (next !== this.cur) {
      this.cur = next;
      this.decisions.push({
        frame: i.frame,
        fps: next,
        reason,
        max_fps: Math.round(maxFps * 10) / 10,
        left_s: Math.max(0, Math.round(leftS)),
      });
      // Keep the first decision and the newest ones.
      if (this.decisions.length > AUTO.maxDecisions) this.decisions.splice(1, 1);
    }
    return { fps: this.cur ?? 0, phase: 'auto' };
  }
}

/** Re-exported for callers of Auto. */
export { AUTO_BUDGETS, AUTO_DEFAULT_BUDGET, budgetLabel, isAutoBudget };
