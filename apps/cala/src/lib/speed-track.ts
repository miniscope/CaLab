/**
 * The Speed control's pure parts (beta speed control, PR D): the fixed
 * logarithmic track, snapping, the settings that persist, and the status
 * sentence. No DOM and no store: `components/SpeedControl.tsx` draws them.
 */
import { GOVERNOR_LIMIT_TEXT, type GovernorStatus } from './settle.ts';
import type { FloorDisplay } from './speed-floor.ts';

/** The track: the same 10 to 500 fps scale on every machine and recording; it never rescales. */
export const SPEED_SCALE = { lo: 10, hi: 500 } as const;

/** Stream rates marked on the track (and snapped to). */
export const SPEED_TICKS = [20, 30, 60, 120, 240] as const;

/** Steps of the range input behind the track. */
export const TRACK_STEPS = 1000;

const SPAN = Math.log(SPEED_SCALE.hi / SPEED_SCALE.lo);

/** A speed's place on the track, 0 to 1 (clamped to the scale). */
export function fpsToPos(fps: number): number {
  if (!Number.isFinite(fps)) return 0;
  const f = Math.min(SPEED_SCALE.hi, Math.max(SPEED_SCALE.lo, fps));
  return Math.log(f / SPEED_SCALE.lo) / SPAN;
}

/** The speed at a place on the track, 0 to 1 (clamped). */
export function posToFps(pos: number): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(pos) ? pos : 0));
  return SPEED_SCALE.lo * Math.exp(p * SPAN);
}

/** Whole fps below 100, steps of 5 to 250, steps of 10 above: a dragged thumb lands on a readable number. */
export function roundFps(fps: number): number {
  const f = Math.min(SPEED_SCALE.hi, Math.max(SPEED_SCALE.lo, fps));
  const step = f < 100 ? 1 : f < 250 ? 5 : 10;
  return Math.min(SPEED_SCALE.hi, Math.max(SPEED_SCALE.lo, Math.round(f / step) * step));
}

/**
 * A speed read off the track: pulled onto a mark (a stream rate or the
 * floor) when within `tol` of the track's width, else rounded.
 */
export function snapFps(fps: number, marks: readonly number[] = SPEED_TICKS, tol = 0.012): number {
  const pos = fpsToPos(fps);
  let best: number | null = null;
  let bestD = tol;
  for (const m of marks) {
    const d = Math.abs(fpsToPos(m) - pos);
    if (d <= bestD) {
      best = m;
      bestD = d;
    }
  }
  return best ?? roundFps(fps);
}

/**
 * One keyboard step from `fps`: a display unit (1 below 100, 5 below 250, 10
 * above), or with `big` the next mark (stream rates and `marks`) in that direction.
 */
export function nudgeFps(
  fps: number,
  dir: 1 | -1,
  big = false,
  marks: readonly number[] = SPEED_TICKS,
): number {
  const clamp = (x: number) => Math.min(SPEED_SCALE.hi, Math.max(SPEED_SCALE.lo, x));
  if (big) {
    const sorted = [...marks, SPEED_SCALE.lo, SPEED_SCALE.hi].sort((a, b) => a - b);
    const next =
      dir > 0
        ? sorted.find((m) => m > fps + 0.5)
        : [...sorted].reverse().find((m) => m < fps - 0.5);
    return clamp(next ?? (dir > 0 ? SPEED_SCALE.hi : SPEED_SCALE.lo));
  }
  // The step is the one of the place the move starts from; going down across 100 or 250 uses the finer one.
  const probe = dir > 0 ? fps : fps - 0.001;
  const step = probe < 100 ? 1 : probe < 250 ? 5 : 10;
  const k = dir > 0 ? Math.floor(fps / step + 1e-9) + 1 : Math.ceil(fps / step - 1e-9) - 1;
  return clamp(k * step);
}

/** What a value of the range input means as a speed (snapped), and back. */
export const stepToFps = (step: number, marks?: readonly number[]): number =>
  snapFps(posToFps(step / TRACK_STEPS), marks);
export const fpsToStep = (fps: number): number => Math.round(fpsToPos(fps) * TRACK_STEPS);

// ---- cap ----

/** The cap choices, re-read frames per live frame (0 = Off). */
export const CAP_CHOICES = [2, 1, 0.5, 0] as const;

export function capLabel(cap: number, live = false): string {
  if (cap === 0) return 'Off';
  if (live && cap === 2) return 'all spare, up to 2 per live frame';
  return `up to ${cap}${cap === 2 ? ' re-read frames per live frame' : ''}`;
}

// ---- settings that persist ----

export type SpeedMode = 'max' | 'fixed' | 'curve';

/** The curve presets of the Curve mode (`speed-schedule.ts` has their points). */
export const CURVE_PRESET_IDS = ['find-fast', 'step-down'] as const;
export type CurvePresetId = (typeof CURVE_PRESET_IDS)[number];

export interface SpeedSettings {
  mode: SpeedMode;
  /** The last Fixed target, fps (kept while in Max). */
  fixedFps: number;
  /** Background settle cap, re-read frames per live frame (0 = Off). */
  cap: number;
  /** The curve preset Curve mode uses. */
  preset: CurvePresetId;
}

export const SPEED_DEFAULTS: SpeedSettings = {
  mode: 'max',
  fixedFps: 30,
  cap: 2,
  preset: 'find-fast',
};

export const SPEED_STORAGE_KEY = 'cala.speed.v1';

/** Settings from stored text; anything missing or invalid falls back to the default, field by field. */
export function parseSpeedSettings(raw: string | null | undefined): SpeedSettings {
  const out = { ...SPEED_DEFAULTS };
  if (!raw) return out;
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== 'object' || o === null) return out;
    const r = o as Record<string, unknown>;
    if (r.mode === 'max' || r.mode === 'fixed' || r.mode === 'curve') out.mode = r.mode;
    if ((CURVE_PRESET_IDS as readonly unknown[]).includes(r.preset))
      out.preset = r.preset as CurvePresetId;
    if (
      typeof r.fixedFps === 'number' &&
      r.fixedFps >= SPEED_SCALE.lo &&
      r.fixedFps <= SPEED_SCALE.hi
    )
      out.fixedFps = r.fixedFps;
    if (typeof r.cap === 'number' && (CAP_CHOICES as readonly number[]).includes(r.cap))
      out.cap = r.cap;
  } catch {
    // Unreadable: defaults.
  }
  return out;
}

export function loadSpeedSettings(storage?: Pick<Storage, 'getItem'>): SpeedSettings {
  try {
    return parseSpeedSettings((storage ?? localStorage).getItem(SPEED_STORAGE_KEY));
  } catch {
    return { ...SPEED_DEFAULTS };
  }
}

export function saveSpeedSettings(s: SpeedSettings, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(SPEED_STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Private window or blocked storage: the settings last for this page only.
  }
}

// ---- the sentence under the headline ----

export interface SpeedStatusInput {
  running: boolean;
  /** Target, fps (0: Max). */
  target: number;
  /** The floor, fps; null where there is none to show. */
  floor: number | null;
  governor: GovernorStatus | null;
  /** Background settle is on (a cap above 0) and look-back is on in this run. */
  settleOn: boolean;
}

const TOL = 0.97;

/** One or two plain sentences: on target or not, Background settle's rate, and what limits it. */
export function speedStatusText(i: SpeedStatusInput): string {
  if (!i.running) {
    return i.target > 0
      ? 'Discover will read at this speed once it starts.'
      : 'Discover will run as fast as the machine goes.';
  }
  if (i.target <= 0) return 'Max: no pacing. Settling happens after the last frame.';
  const g = i.governor;
  const parts: string[] = [];
  if (g?.achieved != null) {
    if (g.achieved >= i.target * TOL) parts.push('On target.');
    else parts.push(`Achieved ${g.achieved.toFixed(0)} · ${GOVERNOR_LIMIT_TEXT.discover}.`);
  }
  if (i.settleOn && g && g.achieved != null && g.achieved > 0) {
    const perLive = g.deliveredFps / g.achieved;
    parts.push(
      `Background settle ${g.deliveredFps.toFixed(0)} re-read frames/s = ${perLive.toFixed(2)} per live frame (cap ${g.cap}) · limited by: ${GOVERNOR_LIMIT_TEXT[g.limit]}`,
    );
  } else if (!i.settleOn) {
    parts.push('Background settle is off.');
  }
  return parts.join(' ');
}

/** The note under the track when the target sits under the floor (a choice that stays where the user put it). */
export function belowFloorNote(target: number, floor: number | null): string | null {
  if (target <= 0 || floor === null || target >= floor) return null;
  return `No gain below ${floor} fps: the extra time is idle.`;
}

// ---- the floor's words ----

const LIMITING_TEXT = {
  'look-back': 'look-back',
  'slow-worker': 'slow worker',
  visits: 'visits',
  minimum: 'the minimum',
  max: 'Max',
  prior: 'the prior',
} as const;

/** The floor as the mark and the line under the track say it. `d` is `FloorMeter.display()`. */
export function floorWords(d: Pick<FloorDisplay, 'fps' | 'published' | 'prior' | 'estimate'>): {
  mark: string;
  line: string;
} {
  const fps = Math.round(d.fps);
  if (d.prior) {
    return { mark: `about ${fps}`, line: `Floor about ${fps} fps (not measured yet)` };
  }
  const how = d.estimate.confidence === 'unpaced' ? 'measured at Max' : 'measured';
  const about = d.published === null || d.estimate.confidence === 'unpaced';
  return {
    mark: `${about ? 'about ' : 'floor '}${fps}`,
    line: `Floor ${fps} fps: set by ${LIMITING_TEXT[d.estimate.limiting]} (${how})`,
  };
}
