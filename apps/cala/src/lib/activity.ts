/**
 * Cell activity around the shown frame, for the "Live activity" colour scheme and the choir.
 * Read at most twice a second: per cell, the largest trace value over the frames shown since
 * the last tick (`TraceHistory.range` on that window only, never the whole history), placed
 * between the cell's running baseline and running peak. A cell that fires glows at once and
 * fades over the next ticks. Display only: it reads the traces, never changes them.
 */
import { createEffect, createSignal, onCleanup } from 'solid-js';

/** Glow kept per tick (2 Hz): about 1.5 s to fade to a tenth. */
export const GLOW_DECAY = 0.45;
/** A cell "fires" (an onset, one choir note) when its level crosses this share of its range. */
export const ONSET = 0.5;
/** Ticks a cell is watched before it can fire (its baseline and peak need a few samples). */
export const WARMUP_TICKS = 3;
/** The running peak relaxes this much per tick, so a cell that dims is not dark forever. */
const PEAK_RELAX = 0.99;
/** The running baseline follows a lower window maximum at once and a higher one slowly. */
const BASE_RISE = 0.05;

export interface CellActivity {
  peak: number;
  base: number;
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
 * last tick (NaN: no samples). Updates `st` (dropping cells not in `ids`) and returns the ids
 * that fired, i.e. crossed `ONSET` from below.
 */
export function stepActivity(
  st: ActivityState,
  ids: readonly number[],
  windowMax: (id: number) => number,
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
    if (!c) {
      c = { peak: v, base: v, level: 0, glow: 0, ticks: 0 };
      st.set(id, c);
    }
    c.ticks++;
    c.base = v < c.base ? v : c.base + BASE_RISE * (v - c.base);
    c.peak = Math.max(v, c.base + (c.peak - c.base) * PEAK_RELAX);
    const span = c.peak - c.base;
    const lvl = c.ticks > WARMUP_TICKS && span > 0 ? Math.min(1, (v - c.base) / span) : 0;
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
  /** Largest trace value of `id` over stream frames [first, end) (NaN: no samples). */
  windowMax(id: number, first: number, end: number): number;
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
      const fired = stepActivity(st, ids, (id) => src.windowMax(id, lo, f + 1));
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
