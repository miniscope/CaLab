/**
 * Cell activity around the shown frame, for the "Live activity" colour scheme and the choir.
 * Read at most twice a second: per cell, the largest trace value over the frames shown since
 * the last tick (`TraceHistory.range` on that window only, never the whole history), placed
 * between the cell's baseline and its running peak; within a few noise sigmas of the baseline
 * it is noise and stays dark (baseline and noise come from the cell's last `SEED_FRAMES`
 * frames, re-read now and then). A cell that fires glows at once and fades over the next
 * ticks. Display only: it reads the traces, never changes them.
 */
import { createEffect, createSignal, onCleanup } from 'solid-js';

/** Glow kept per tick (2 Hz): about 1.5 s to fade to a tenth. */
export const GLOW_DECAY = 0.45;
/** A cell "fires" (an onset, one choir note) when its level crosses this share of its range. */
export const ONSET = 0.5;
/** A window maximum within this many noise sigmas of the baseline is noise: level 0. */
export const NOISE_K = 5;
/** Frames of recent history a cell's baseline and noise are read from. */
export const SEED_FRAMES = 1000;
/** A cell's baseline and noise are re-read every this many ticks (staggered by id). */
export const RESEED_TICKS = 20;
/** The running peak relaxes this much per tick, so a cell that dims is not dark forever. */
const PEAK_RELAX = 0.99;

/** A cell's recent baseline (median), noise (sigma from the median absolute first difference) and peak. */
export interface ActivitySeed {
  base: number;
  noise: number;
  peak: number;
}

/** Baseline, noise and peak of a stretch of trace (null when fewer than 8 finite samples). */
export function seedOf(v: ArrayLike<number>): ActivitySeed | null {
  const x: number[] = [];
  for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) x.push(v[i]);
  if (x.length < 8) return null;
  const d: number[] = [];
  for (let i = 1; i < x.length; i++) d.push(Math.abs(x[i] - x[i - 1]));
  const median = (a: number[]) => {
    const s = a.slice().sort((p, q) => p - q);
    return s[Math.floor(s.length / 2)];
  };
  // First differences of white noise have sigma * sqrt 2; their MAD is 0.6745 of that.
  const noise = median(d) / (0.6745 * Math.SQRT2);
  let peak = -Infinity;
  for (const y of x) if (y > peak) peak = y;
  return { base: median(x), noise, peak };
}

export interface CellActivity extends ActivitySeed {
  /** Level 0..1 at the last tick. */
  level: number;
  /** Display glow 0..1. */
  glow: number;
  ticks: number;
}

export type ActivityState = Map<number, CellActivity>;

export const emptyActivity = (): ActivityState => new Map();

/** Largest finite value of `v` (NaN when none). */
export function finiteMax(v: ArrayLike<number>): number {
  let m = NaN;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (Number.isFinite(x) && !(x <= m)) m = x;
  }
  return m;
}

/**
 * One tick: `windowMax(id)` is the cell's largest trace value over the frames shown since the
 * last tick (NaN: no samples); `seed(id)` reads its recent baseline and noise (on first sight
 * and every `RESEED_TICKS`). A value within `NOISE_K` sigmas of the baseline is level 0; above
 * it the level is the height over the baseline against the cell's running peak. Updates `st`
 * (dropping cells not in `ids`) and returns the ids that fired, i.e. crossed `ONSET` from below.
 */
export function stepActivity(
  st: ActivityState,
  ids: readonly number[],
  windowMax: (id: number) => number,
  seed: (id: number) => ActivitySeed | null = () => null,
): number[] {
  const fired: number[] = [];
  const keep = new Set(ids);
  for (const id of st.keys()) if (!keep.has(id)) st.delete(id);
  for (const id of ids) {
    const v = windowMax(id);
    let c = st.get(id);
    if (!Number.isFinite(v)) {
      if (c) c.glow *= GLOW_DECAY;
      continue;
    }
    if (!c || (c.ticks + id) % RESEED_TICKS === 0) {
      const sd = seed(id);
      if (!c) {
        if (!sd) continue;
        c = { ...sd, level: 0, glow: 0, ticks: 0 };
        st.set(id, c);
      } else if (sd) {
        c.base = sd.base;
        c.noise = sd.noise;
        c.peak = Math.max(c.peak, sd.peak);
      }
    }
    c.ticks++;
    const floor = NOISE_K * c.noise;
    c.peak = Math.max(v, c.base + (c.peak - c.base) * PEAK_RELAX);
    const h = v - c.base;
    const span = Math.max(c.peak - c.base, 2 * floor);
    const lvl = h <= floor || span <= 0 ? 0 : Math.min(1, h / span);
    if (lvl >= ONSET && c.level < ONSET) fired.push(id);
    c.level = lvl;
    c.glow = Math.max(c.glow * GLOW_DECAY, lvl);
  }
  return fired;
}

/** Ticks per second of the sampler (the 2 Hz limit of every live fun touch). */
export const ACTIVITY_MS = 500;
/** Frames read per cell per tick at most (the newest ones). */
const MAX_WINDOW = 400;

export interface ActivitySource {
  /** Ids of the cells in the library (null: none yet). */
  ids(): ArrayLike<number> | null;
  /** The trace of `id` over stream frames [first, end) (NaN where it has no sample). */
  range(id: number, first: number, end: number): ArrayLike<number>;
  /** The frame on screen (null: none). */
  frame(): number | null;
}

/**
 * The 2 Hz activity sampler. While `active()`, every `ACTIVITY_MS` it reads each cell's window
 * since the last tick and bumps `version()`; `onFire` gets the cells that fired. A paused or
 * stopped stream (no new frame) only lets the glow fade. Call inside a component.
 */
export function createActivity(
  src: ActivitySource,
  active: () => boolean,
  onFire?: (ids: number[]) => void,
) {
  const st = emptyActivity();
  const [version, setVersion] = createSignal(0);
  let last: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    const ids = Array.from(src.ids() ?? []);
    const f = src.frame();
    if (f === null || last === null || f <= last) {
      // Nothing new on screen (paused, or a jump back): fade only.
      stepActivity(st, ids, () => NaN);
      if (f !== null && (last === null || f < last)) last = f;
    } else {
      const lo = Math.max(last + 1, f + 1 - MAX_WINDOW);
      const fired = stepActivity(
        st,
        ids,
        (id) => finiteMax(src.range(id, lo, f + 1)),
        (id) => seedOf(src.range(id, f + 1 - SEED_FRAMES, f + 1)),
      );
      last = f;
      if (fired.length > 0) onFire?.(fired);
    }
    setVersion((v) => v + 1);
  };
  createEffect(() => {
    if (!active()) {
      clearInterval(timer);
      timer = undefined;
      last = null;
      st.clear();
      return;
    }
    timer ??= setInterval(tick, ACTIVITY_MS);
  });
  onCleanup(() => clearInterval(timer));
  return {
    version,
    /** Display glow 0..1 of `id` (0 when unknown). */
    glow: (id: number): number => st.get(id)?.glow ?? 0,
    /** Level 0..1 of `id` at the last tick. */
    level: (id: number): number => st.get(id)?.level ?? 0,
  };
}
