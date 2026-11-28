/**
 * Speed curves: a step schedule
 * of the target speed over a recording, and the driver that applies a schedule (or Auto)
 * during a run. Pure: no store and no DOM; the clock is passed in.
 *
 * - `SpeedCurve` is what the user sets and what the run record keeps: points `{ at, fps }`, `at` the
 *   position in the recording (0 to 1), `fps` a number, `'max'`, or a symbol resolved live:
 *   `'floor'` (the smart floor) and `'seeAll'` (the rate below which the slow loop sees every frame).
 * - `normalizeCurve` merges steps too short for the governor's ramp (an authored curve only; a
 *   replayed curve passes through untouched).
 * - `TargetPolicy` is the seam: a policy turns the run's state into a target. `SpeedSchedule` is
 *   one; Auto is another that plugs into the same `SpeedDriver` and the same record fields.
 */
import { GOVERNOR } from './settle-governor.ts';
import { snapToLadder } from './speed-floor.ts';
import { SPEED_SCALE, type CurvePresetId } from './speed-track.ts';

/** A target: frames per second, `'max'` (unpaced), or a symbol resolved against the live floor. */
export type CurveFps = number | 'max' | 'floor' | 'seeAll';

/** One step of a curve: from `at` on, the target is `fps`. */
export interface CurvePoint {
  /** Position in the recording, 0 to 1 (the share of its frames). */
  at: number;
  fps: CurveFps;
}

/** A step schedule of the target over a recording. */
export interface SpeedCurve {
  points: CurvePoint[];
}

/** At most this many points in an authored curve. */
export const MAX_CURVE_POINTS = 8;

/**
 * A paced step must last at least `baseS` plus `rampFactor` times the Background settle's climb from
 * 0 to its cap (`climbSeconds`), or
 * it is merged into its neighbour. A Max step has no pacer to re-anchor and no governor to climb,
 * so it is exempt.
 */
export const MIN_STEP = { baseS: 20, rampFactor: 2 } as const;

/**
 * Seconds the Background settle takes to climb to its cap read at `fps`: `cap x
 * GOVERNOR.rampFrames` live frames.
 */
export function climbSeconds(fps: number, cap: number): number {
  return cap > 0 && fps > 0 ? (cap * GOVERNOR.rampFrames) / fps : 0;
}

/** The shortest a step paced at `fps` may last, seconds. */
export function minStepSeconds(fps: number, cap: number): number {
  return MIN_STEP.baseS + MIN_STEP.rampFactor * climbSeconds(fps, cap);
}

// ---- presets ----

/** The curve presets of the Curve mode. */
export const CURVE_PRESETS: Record<
  CurvePresetId,
  { label: string; title: string; curve: SpeedCurve }
> = {
  'find-fast': {
    label: 'Find fast, then settle',
    title: 'Max for the first half, while most cells are found, then the floor.',
    curve: {
      points: [
        { at: 0, fps: 'max' },
        { at: 0.5, fps: 'floor' },
      ],
    },
  },
  'step-down': {
    label: 'Step down',
    title: 'Max for the first third, every-frame-seen speed to two thirds, then the floor.',
    curve: {
      points: [
        { at: 0, fps: 'max' },
        { at: 0.33, fps: 'seeAll' },
        { at: 0.66, fps: 'floor' },
      ],
    },
  },
};

/** A copy of a preset's curve. */
export function presetCurve(id: CurvePresetId): SpeedCurve {
  return { points: CURVE_PRESETS[id].curve.points.map((p) => ({ ...p })) };
}

// ---- resolving ----

const clampFps = (x: number) => Math.min(SPEED_SCALE.hi, Math.max(SPEED_SCALE.lo, x));

/** What a symbol or number means at this moment, as a pacer target: fps, 0 for Max. */
export function resolveFps(f: CurveFps, live: { floorFps: number; seeAllFps: number }): number {
  if (f === 'max') return 0;
  // The ladder keeps the symbols from drifting with the raw estimates (each change re-anchors the pacer).
  if (f === 'floor') return clampFps(snapToLadder(live.floorFps));
  if (f === 'seeAll') return clampFps(snapToLadder(live.seeAllFps));
  return Number.isFinite(f) && f > 0 ? clampFps(f) : 0;
}

const validFps = (f: unknown): f is CurveFps =>
  f === 'max' ||
  f === 'floor' ||
  f === 'seeAll' ||
  (typeof f === 'number' && Number.isFinite(f) && f > 0);

/**
 * A curve made safe: valid points only, ascending, the first at 0, no two at the same place (the
 * later wins). Null when nothing valid is left. Does not limit the number of points (`limitPoints`).
 */
export function sanitizeCurve(c: unknown): SpeedCurve | null {
  const raw = (c as { points?: unknown } | null)?.points;
  if (!Array.isArray(raw)) return null;
  const pts: CurvePoint[] = [];
  for (const p of raw as unknown[]) {
    const o = p as Partial<CurvePoint> | null;
    if (!o || typeof o.at !== 'number' || !Number.isFinite(o.at) || !validFps(o.fps)) continue;
    pts.push({ at: Math.min(1, Math.max(0, o.at)), fps: o.fps });
  }
  if (pts.length === 0) return null;
  pts.sort((a, b) => a.at - b.at);
  const out: CurvePoint[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.at === p.at) last.fps = p.fps;
    else out.push({ ...p });
  }
  out[0].at = 0;
  return { points: out };
}

/** The first `MAX_CURVE_POINTS` points (an authored curve; a replayed one is not cut). */
export function limitPoints(c: SpeedCurve): SpeedCurve {
  return { points: c.points.slice(0, MAX_CURVE_POINTS) };
}

// ---- merging steps too short for the ramp ----

/** What the plan needs of the run. */
export interface PlanContext {
  totalFrames: number;
  /** Background settle's cap, re-read frames per live frame (0: Off). */
  cap: number;
  floorFps: number;
  seeAllFps: number;
  /** Live estimate of Max, fps; null when not known. */
  maxFps: number | null;
}

/** Each step's start, end (as shares) and resolved target (0: Max). */
export function steps(
  c: SpeedCurve,
  live: { floorFps: number; seeAllFps: number },
): { from: number; to: number; fps: number }[] {
  return c.points.map((p, i) => ({
    from: p.at,
    to: i + 1 < c.points.length ? c.points[i + 1].at : 1,
    fps: resolveFps(p.fps, live),
  }));
}

/**
 * How long step `i` takes at its target, seconds (null: a Max step, whose time is not the point).
 * A step paced above what the machine reaches takes as long as Max does (when Max is known).
 */
function stepSeconds(c: SpeedCurve, i: number, plan: PlanContext): number | null {
  const s = steps(c, plan)[i];
  if (s.fps <= 0 || !(plan.totalFrames > 0)) return null;
  const rate = plan.maxFps !== null && plan.maxFps > 0 ? Math.min(s.fps, plan.maxFps) : s.fps;
  return ((s.to - s.from) * plan.totalFrames) / rate;
}

/**
 * Merge the steps shorter than `minStepSeconds` for their target into a neighbour: a short step is
 * dropped and the one before it runs on over it; a short first step is dropped and the next one
 * starts at 0. Repeated until every paced step is long enough (one step is always left). Returns the
 * curve and how many steps were merged.
 */
export function normalizeCurve(
  curve: SpeedCurve,
  plan: PlanContext,
): { curve: SpeedCurve; merged: number } {
  let pts = curve.points.map((p) => ({ ...p }));
  let merged = 0;
  for (;;) {
    if (pts.length <= 1) break;
    const c = { points: pts };
    const st = steps(c, plan);
    let bad = -1;
    for (let i = 0; i < pts.length; i++) {
      const secs = stepSeconds(c, i, plan);
      if (secs !== null && secs < minStepSeconds(st[i].fps, plan.cap)) {
        bad = i;
        break;
      }
    }
    if (bad < 0) break;
    if (bad === 0) {
      pts = pts.slice(1);
      pts[0] = { ...pts[0], at: 0 };
    } else {
      pts = pts.filter((_, i) => i !== bad);
    }
    merged++;
  }
  return { curve: { points: pts }, merged };
}

// ---- policies and the driver ----

/** What a policy sees of the run. */
export interface PolicyInput {
  /** Frames Discover has processed. */
  frame: number;
  totalFrames: number;
  /** The floor as the Speed control shows it (the published one once measured), the every-frame rate, and Max (null: unknown). */
  floorFps: number;
  seeAllFps: number;
  maxFps: number | null;
  /** The run's wall time, seconds (a clock that only goes forward). */
  wallS: number;
}

/** What a policy answers: a target (0: Max) and the phase it belongs to. */
export interface PolicyTarget {
  fps: number;
  /** A change of phase (a new step, a new state) applies at once; a change inside one is rate limited. */
  phase: string;
}

/**
 * The seam between a rule and the pacer: `SpeedSchedule` follows a curve, Auto decides from the
 * run. `source` is what the run record's `target_speed.changes` names.
 */
export interface TargetPolicy {
  readonly source: 'curve' | 'auto';
  target(i: PolicyInput): PolicyTarget;
}

/** A policy that follows a (normalised) curve over the recording. */
export class SpeedSchedule implements TargetPolicy {
  readonly source = 'curve' as const;

  constructor(readonly curve: SpeedCurve) {
    if (curve.points.length === 0) throw new Error('A speed curve needs at least one point.');
  }

  /** The index of the step the frame is in. */
  stepAt(frame: number, totalFrames: number): number {
    const share = totalFrames > 0 ? frame / totalFrames : 0;
    let k = 0;
    for (let i = 0; i < this.curve.points.length; i++) if (share >= this.curve.points[i].at) k = i;
    return k;
  }

  target(i: PolicyInput): PolicyTarget {
    const k = this.stepAt(i.frame, i.totalFrames);
    return { fps: resolveFps(this.curve.points[k].fps, i), phase: `step${k}` };
  }
}

/**
 * Applies a policy: `tick` returns the change to make (or null). The first tick always applies. A
 * new phase applies at once; a symbol that moves inside a phase (the floor rising) waits
 * `holdS` since the last change, and only a different value counts, so one republish is one change.
 */
export class SpeedDriver {
  private last: { fps: number; phase: string; at: number } | null = null;

  constructor(
    readonly policy: TargetPolicy,
    private readonly holdS = 15,
  ) {}

  tick(i: PolicyInput): { fps: number; source: 'curve' | 'auto' } | null {
    const t = this.policy.target(i);
    const prev = this.last;
    if (prev && prev.phase === t.phase && prev.fps === t.fps) return null;
    if (prev && prev.phase === t.phase && i.wallS - prev.at < this.holdS) return null;
    this.last = { fps: t.fps, phase: t.phase, at: i.wallS };
    // The same value in a new phase is a new phase, not a change of target.
    if (prev && prev.fps === t.fps) return null;
    return { fps: t.fps, source: this.policy.source };
  }
}

// ---- the plan, for display ----

/**
 * The curve as a step line over the recording for the strip: one `{ x, fps }` pair per step
 * boundary (a share 0 to 1; fps 0 is Max), each step as a start and an end so it draws flat.
 */
export function planLine(
  c: SpeedCurve,
  live: { floorFps: number; seeAllFps: number },
): { x: number; fps: number }[] {
  const out: { x: number; fps: number }[] = [];
  for (const s of steps(c, live)) out.push({ x: s.from, fps: s.fps }, { x: s.to, fps: s.fps });
  return out;
}

/** The curve in words, for the line under the Speed control. */
export function curveWords(c: SpeedCurve, live: { floorFps: number; seeAllFps: number }): string {
  const name = (f: CurveFps): string =>
    f === 'max'
      ? 'Max'
      : f === 'floor'
        ? `the floor (${resolveFps(f, live)})`
        : f === 'seeAll'
          ? `every frame seen (${resolveFps(f, live)})`
          : `${Math.round(f)} fps`;
  return c.points
    .map((p, i) => {
      const next = c.points[i + 1];
      return next
        ? `${name(p.fps)} to ${Math.round(next.at * 100)} %`
        : `${i === 0 ? '' : 'then '}${name(p.fps)}`;
    })
    .join(', ');
}
