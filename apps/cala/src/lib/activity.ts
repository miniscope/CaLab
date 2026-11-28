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
  let n = 0;
  for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) n++;
  if (n < 8) return null;
  // Typed arrays: their sort is numeric and fast (a seed is read for every cell now and then).
  const x = new Float64Array(n);
  for (let i = 0, j = 0; i < v.length; i++) if (Number.isFinite(v[i])) x[j++] = v[i];
  const d = new Float64Array(n - 1);
  let peak = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] > peak) peak = x[i];
    if (i > 0) d[i - 1] = Math.abs(x[i] - x[i - 1]);
  }
  d.sort();
  // First differences of white noise have sigma * sqrt 2; their MAD is 0.6745 of that.
  const noise = d[Math.floor(d.length / 2)] / (0.6745 * Math.SQRT2);
  x.sort();
  return { base: x[Math.floor(n / 2)], noise, peak };
}

export interface CellActivity extends ActivitySeed {
  /** Level 0..1 at the last tick. */
  level: number;
  /** Display glow 0..1. */
  glow: number;
  ticks: number;
  /** Frame-level onset latch: a new onset needs the trace to fall under `REARM_K` sigmas first. */
  armed?: boolean;
  /** Stream frame (exclusive end) of the last seed, for the frame-based re-read. */
  seededAt?: number;
}

/**
 * With per-frame onsets, a cell's seed is also re-read once this many stream frames have passed
 * (plus a stagger by id, so cells do not all re-read on one tick): at a high speed the 20-tick
 * rule alone would leave a baseline thousands of frames old.
 */
export const RESEED_FRAMES = 1500;

/**
 * Per-frame onsets (the ribbon, the portrait) are gated by noise alone: a rise to `ONSET_K`
 * noise sigmas over the baseline, re-armed once the trace is back under `REARM_K`. Unlike the
 * glow's level, no running peak: the threshold must not depend on how much of a cell's history
 * was read (which differs with the speed), nor on how big its events are.
 */
export const ONSET_K = 8;
export const REARM_K = 4;

/**
 * Level 0..1 of one sample `x` of a cell: 0 within `NOISE_K` sigmas of the baseline, else its
 * height over the baseline against the cell's range (at least twice the noise floor).
 */
export function levelOf(c: ActivitySeed, x: number): number {
  const floor = NOISE_K * c.noise;
  const h = x - c.base;
  const span = Math.max(c.peak - c.base, 2 * floor);
  return h <= floor || span <= 0 ? 0 : Math.min(1, h / span);
}

/**
 * Frame offsets in `v` where the cell has an onset: the trace reaches `ONSET_K` noise sigmas over
 * its baseline while armed (it re-arms under `REARM_K`). Updates `c.armed`. Non-finite samples
 * are skipped; a cell without a noise estimate never has one.
 */
export function scanOnsets(
  c: Pick<ActivitySeed, 'base' | 'noise'> & { armed?: boolean },
  v: ArrayLike<number>,
): number[] {
  const out: number[] = [];
  if (!(c.noise > 0)) return out;
  const on = c.base + ONSET_K * c.noise;
  const off = c.base + REARM_K * c.noise;
  let armed = c.armed ?? true;
  for (let k = 0; k < v.length; k++) {
    const x = v[k];
    if (!Number.isFinite(x)) continue;
    if (armed && x >= on) {
      out.push(k);
      armed = false;
    } else if (!armed && x < off) armed = true;
  }
  c.armed = armed;
  return out;
}

/**
 * Onsets of one cell over a whole trace (the session portrait's "most active cell"): its
 * baseline and noise read from the trace itself, then `scanOnsets`. 0 for too few samples.
 */
export function countOnsets(v: ArrayLike<number>): number {
  const sd = seedOf(v);
  if (!sd) return 0;
  return scanOnsets({ ...sd }, v).length;
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
 * One tick: `windowMax(id)` is the cell's largest trace value over the frames read since the
 * last tick (NaN: no samples); `seed(id)` reads its recent baseline and noise (on first sight,
 * every `RESEED_TICKS`, and with `frames` every `RESEED_FRAMES`). A value within `NOISE_K` sigmas of the baseline is level 0; above
 * it the level is the height over the baseline against the cell's running peak. Updates `st`
 * (dropping cells not in `ids`) and returns the ids that fired, i.e. crossed `ONSET` from below.
 */
export function stepActivity(
  st: ActivityState,
  ids: readonly number[],
  windowMax: (id: number) => number,
  seed: (id: number) => ActivitySeed | null = () => null,
  /**
   * Per-frame onsets: the cell's window samples, where to report each onset's offset, and the
   * stream frame the read ends at (seeds are then also re-read every `RESEED_FRAMES`).
   */
  frames?: {
    window: (id: number) => ArrayLike<number> | null;
    onset: (id: number, k: number) => void;
    end?: number;
  },
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
    const end = frames?.end;
    const due =
      !c ||
      (c.ticks + id) % RESEED_TICKS === 0 ||
      (end !== undefined && end - (c.seededAt ?? -Infinity) >= RESEED_FRAMES + (id % 16) * 50);
    if (due) {
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
      if (sd) c.seededAt = end;
    }
    if (!c) continue;
    c.ticks++;
    c.peak = Math.max(v, c.base + (c.peak - c.base) * PEAK_RELAX);
    const lvl = levelOf(c, v);
    if (frames) {
      const w = frames.window(id);
      if (w) {
        for (const k of scanOnsets(c, w)) frames.onset(id, k);
      }
    }
    if (lvl >= ONSET && c.level < ONSET) fired.push(id);
    c.level = lvl;
    c.glow = Math.max(c.glow * GLOW_DECAY, lvl);
  }
  return fired;
}

/** The first `n` samples of `v` (a typed array's view, or a copy of a plain array). */
function subarray(v: ArrayLike<number>, n: number): ArrayLike<number> {
  if (n >= v.length) return v;
  const t = v as Float32Array;
  return typeof t.subarray === 'function' ? t.subarray(0, n) : Array.prototype.slice.call(v, 0, n);
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
/** One sampler tick, for the population figures (`soul.ts`): what was read and what fired. */
export interface ActivityTick {
  /** Cells that crossed `ONSET` this tick (one per cell at most). */
  fired: number[];
  /** Every per-frame onset this tick: the cell and its stream frame. */
  onsets: { id: number; frame: number }[];
  /** What each cell had read this tick: stream frames [from, to) with a solved trace. */
  reads: { id: number; from: number; to: number }[];
  /** Cells in the library. */
  cells: number;
}

export function createActivity(
  src: ActivitySource,
  active: () => boolean,
  onFire?: (ids: number[]) => void,
  onTick?: (t: ActivityTick) => void,
) {
  const st = emptyActivity();
  const [version, setVersion] = createSignal(0);
  let last: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Per cell, the next stream frame to read. A window ends at the cell's newest finite sample, so
   * frames whose trace is not solved yet (the slow loop lags the frames shown, more so at high
   * speed) are read on a later tick instead of being lost: the onsets do not depend on the speed.
   */
  const next = new Map<number, number>();
  const tick = () => {
    const ids = Array.from(src.ids() ?? []);
    const f = src.frame();
    if (f === null || last === null || f < last) {
      // Nothing on screen yet, or a jump back: start reading afresh from here; fade only.
      stepActivity(st, ids, () => NaN);
      if (f !== null) last = f;
      next.clear();
      onTick?.({ fired: [], onsets: [], reads: [], cells: ids.length });
    } else {
      const floor = f + 1 - MAX_WINDOW;
      const start = last + 1;
      const windows = new Map<number, { from: number; v: ArrayLike<number> }>();
      const reads: { id: number; from: number; to: number }[] = [];
      const win = (id: number) => {
        let w = windows.get(id);
        if (!w) {
          const from = Math.max(floor, next.get(id) ?? start);
          const v = from <= f ? src.range(id, from, f + 1) : new Float32Array(0);
          let end = -1;
          for (let k = v.length - 1; k >= 0; k--) {
            if (Number.isFinite(v[k])) {
              end = k + 1;
              break;
            }
          }
          w = { from, v: end > 0 ? subarray(v, end) : new Float32Array(0) };
          windows.set(id, w);
          if (end > 0) {
            next.set(id, from + end);
            reads.push({ id, from, to: from + end });
          }
        }
        return w;
      };
      const onsets: { id: number; frame: number }[] = [];
      const fired = stepActivity(
        st,
        ids,
        (id) => finiteMax(win(id).v),
        (id) => seedOf(src.range(id, f + 1 - SEED_FRAMES, f + 1)),
        {
          window: (id) => win(id).v,
          onset: (id, k) => onsets.push({ id, frame: win(id).from + k }),
          end: f + 1,
        },
      );
      for (const id of next.keys()) if (!st.has(id) && !windows.has(id)) next.delete(id);
      last = f;
      if (fired.length > 0) onFire?.(fired);
      onTick?.({ fired, onsets, reads, cells: ids.length });
    }
    setVersion((v) => v + 1);
  };
  createEffect(() => {
    if (!active()) {
      clearInterval(timer);
      timer = undefined;
      last = null;
      st.clear();
      next.clear();
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
