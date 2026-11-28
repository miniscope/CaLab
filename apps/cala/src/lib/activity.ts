/**
 * Cell activity around the shown frame, for the "Live activity" colour scheme and the choir.
 * Read at most twice a second: per cell, the largest trace value over the frames shown since
 * the last tick (`TraceHistory.range` on that window only, never the whole history), placed
 * between the cell's running baseline and running peak. A cell that fires glows at once and
 * fades over the next ticks. Display only: it reads the traces, never changes them.
 */

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
