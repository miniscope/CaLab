/**
 * The end-of-Discover settle of a look-back run (qc_eval's
 * `--settle-frames N --settle-batch 16`, `LookBack::settle`): with the cell
 * set frozen, the look-back worker re-reads the recording once and every
 * frame goes through the slow loop's ordinary `observe`, as a Refine pass
 * feeds its frames. That renews the held-out test frames each refinement is
 * judged on, which look-back alone never does (tools/cala-eval/results/
 * 2026-11-19-lookback-settle.md). `SlowRunner` drives it; this module holds
 * the frame plan and the "cells still moving" readout, both pure.
 */
import { median } from './stats.ts';

/** The settle's settings. */
export const SETTLE = {
  /**
   * Frames fed at most: one pass over a recording up to this length; a
   * longer one is sampled in `block`-frame blocks spread evenly over it.
   * About three half-lives of the footprint statistics (6000 frames).
   */
  maxFrames: 18_000,
  /** Frames read in a row (the look-back block; a gap restarts the back half's preprocessor). */
  block: 64,
  /** Frames per request to the look-back worker (each earns its visits after it is observed). */
  batch: 16,
  /** Frames between checkpoints: a published library and the "cells still moving" count. */
  checkEvery: 1200,
  /** A cell is moving when it changed by more than this many times its split-half noise since the last checkpoint. */
  movingK: 2,
  /**
   * Above this share of cells moving at the last checkpoint the run reports
   * "not settled" (a floor, not a stop rule: the settle always feeds its
   * whole budget). See tools/cala-eval/results/2026-11-22-settledness.md.
   */
  movingShare: 0.04,
  /** The last round of visits: every tile due, this many slow-loop budgets (without visit workers). */
  finalSteps: 64,
  /** With visit workers: at most this many visits in the last round (besides the work cap). */
  finalVisitsMax: 4096,
  /**
   * With visit workers: tile visits per settle frame fed (`SlowInit.settleVisitRate`). Each
   * observed frame earns this much credit and a visit is handed out only against it, so the
   * settle makes the same number of visits however fast it runs. 0.4 is at the low end of the
   * rates that leave cells and footprints unchanged, so the settle spends little slow-worker
   * time on visits (hand-out, apply and library builds). See
   * tools/cala-eval/results/2026-11-25-settle-visits-and-pool.md.
   */
  visitRate: 0.4,
  /**
   * Visits owed (earned, not handed out) above which the settle observes no further frame
   * while a visit is out: it waits for the visit workers instead of running ahead of them. In
   * settle frames' worth of credit (one request's).
   */
  visitOwedFrames: 16,
  /**
   * With visit workers: settle frames observed between give-ways while a visit is out, so visit
   * results are applied within an answer instead of after all 16 of its frames. Divides `batch`
   * and `checkEvery`.
   */
  observePiece: 4,
} as const;

/**
 * The settle's visit rate from a `?debug&settlevisits=` value: `off` (or 0) is no rate (visits
 * whenever a visit worker is free), a positive number is that rate, and
 * anything else the default (`SETTLE.visitRate`).
 */
export function settleVisitRate(v: string | null): number {
  if (v === null) return SETTLE.visitRate;
  if (v === 'off') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && v.trim() !== '' ? n : SETTLE.visitRate;
}

/** A run of consecutive frames `[start, end)` the settle reads. */
export interface FrameRun {
  start: number;
  end: number;
}

/**
 * The frames the settle feeds for a recording of `total` frames: all of
 * them when `total <= cap`, else about `cap` frames in whole `block`-frame
 * blocks spread evenly over the recording (adjacent blocks merged).
 */
export function settlePlan(
  total: number,
  cap: number = SETTLE.maxFrames,
  block: number = SETTLE.block,
): FrameRun[] {
  if (!(total > 0)) return [];
  if (total <= cap) return [{ start: 0, end: total }];
  const blocks = Math.ceil(total / block);
  const want = Math.max(1, Math.min(blocks, Math.round(cap / block)));
  const runs: FrameRun[] = [];
  for (let j = 0; j < want; j++) {
    const b = Math.floor((j * blocks) / want);
    const start = b * block;
    const end = Math.min(total, start + block);
    const last = runs.at(-1);
    if (last && last.end === start) last.end = end;
    else runs.push({ start, end });
  }
  return runs;
}

/** Frames in a plan. */
export function planFrames(runs: readonly FrameRun[]): number {
  return runs.reduce((n, r) => n + r.end - r.start, 0);
}

/** One frame to request: its index, and the preprocessor block it belongs to. */
export interface SettleFrame {
  frame: number;
  /**
   * Block sequence for the look-back worker: a changed value starts a fresh copy
   * of the live back half (only at a gap in the plan, as qc_eval restarts
   * its preprocessor only when a frame does not follow the last one).
   * Negative, so never one of the scheduler's.
   */
  block: number;
}

/** Walks a plan in requests of at most `max` frames. */
export class SettleFeed {
  readonly total: number;
  private run = 0;
  private next: number;
  /** Frames handed out but not served (`putBack`): handed out again first. */
  private back: number[] = [];

  constructor(private readonly runs: readonly FrameRun[]) {
    this.total = planFrames(runs);
    this.next = runs[0]?.start ?? 0;
  }

  /** Frames handed out so far. */
  get taken(): number {
    let n = 0;
    for (let i = 0; i < this.run && i < this.runs.length; i++)
      n += this.runs[i].end - this.runs[i].start;
    if (this.run < this.runs.length) n += this.next - this.runs[this.run].start;
    return n - this.back.length;
  }

  get done(): boolean {
    return this.run >= this.runs.length && this.back.length === 0;
  }

  /** Frames of a request that was not served (its worker failed): the next `take` hands them out first. */
  putBack(frames: readonly number[]): void {
    this.back.push(...frames);
  }

  /** The next up to `max` frames (empty when done). */
  take(max: number): SettleFrame[] {
    const out: SettleFrame[] = [];
    while (out.length < max && this.back.length > 0) {
      const frame = this.back.shift()!;
      const run = this.runs.findIndex((r) => frame >= r.start && frame < r.end);
      out.push({ frame, block: -1 - run });
    }
    while (out.length < max && this.run < this.runs.length) {
      const r = this.runs[this.run];
      out.push({ frame: this.next, block: -1 - this.run });
      this.next++;
      if (this.next >= r.end) {
        this.run++;
        this.next = this.runs[this.run]?.start ?? 0;
      }
    }
    return out;
  }
}

/** What the change readouts need of a library (a `LibraryView`, or the getters of a published one). */
export interface FootprintsLike {
  ids: ArrayLike<number>;
  starts: ArrayLike<number>;
  pixels: ArrayLike<number>;
  values: ArrayLike<number>;
}

/** One cell's footprint, scaled to a unit peak (as qc_eval's settle checkpoints compare them). */
type UnitFootprint = Map<number, number>;

/** Every cell's unit-peak footprint, by id. */
export function unitFootprints(lib: FootprintsLike): Map<number, UnitFootprint> {
  const out = new Map<number, UnitFootprint>();
  for (let s = 0; s < lib.ids.length; s++) {
    let peak = 0;
    for (let k = lib.starts[s]; k < lib.starts[s + 1]; k++) peak = Math.max(peak, lib.values[k]);
    const m: UnitFootprint = new Map();
    for (let k = lib.starts[s]; k < lib.starts[s + 1]; k++)
      m.set(lib.pixels[k], peak > 0 ? lib.values[k] / peak : lib.values[k]);
    out.set(lib.ids[s], m);
  }
  return out;
}

/** `[id, noise, id, noise, ...]` (`SlowLoop.footprintNoise`) as a map; NaN and non-positive entries left out. */
export function noiseMap(flat: ArrayLike<number> | undefined): Map<number, number> {
  const m = new Map<number, number>();
  if (!flat) return m;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const n = flat[i + 1];
    if (Number.isFinite(n) && n > 0) m.set(flat[i], n);
  }
  return m;
}

/** Cells that moved against their own noise. */
export interface MovedAgainstNoise {
  /** Cells in both libraries with a noise estimate. */
  cells: number;
  /** Of those, cells whose change exceeds 1x and `k`x their split-half noise. */
  above1: number;
  aboveK: number;
  /** `aboveK / cells` (null with no cells). */
  shareK: number | null;
}

/**
 * Per cell present in both with a noise estimate: the relative change of its
 * unit-peak footprint, `|a' - a| / |a|` over the union of the supports
 * (qc_eval's `SettleSnap::change_from`), against its split-half noise
 * (`noise`, from the newer library: `SlowLoop.footprintNoise`).
 */
export function movedAgainstNoise(
  before: Map<number, UnitFootprint>,
  after: Map<number, UnitFootprint>,
  noise: Map<number, number>,
  k: number = SETTLE.movingK,
): MovedAgainstNoise {
  let cells = 0;
  let above1 = 0;
  let aboveK = 0;
  for (const c of footprintChanges(before, after, noise)) {
    const r = c.change / c.noise;
    cells++;
    if (r > 1) above1++;
    if (r > k) aboveK++;
  }
  return { cells, above1, aboveK, shareK: cells > 0 ? aboveK / cells : null };
}

/** One cell's relative footprint change between two libraries, and its split-half noise. */
export interface FootprintChange {
  id: number;
  change: number;
  noise: number;
}

/** The cells `movedAgainstNoise` counts, one by one (present in both, with a noise estimate). */
export function footprintChanges(
  before: Map<number, UnitFootprint>,
  after: Map<number, UnitFootprint>,
  noise: Map<number, number>,
): FootprintChange[] {
  const out: FootprintChange[] = [];
  for (const [id, b] of after) {
    const a = before.get(id);
    const n = noise.get(id);
    if (!a || n === undefined) continue;
    let d2 = 0;
    let a2 = 0;
    let b2 = 0;
    for (const [p, v] of b) {
      const u = a.get(p) ?? 0;
      d2 += (v - u) * (v - u);
      b2 += v * v;
    }
    for (const [p, u] of a) {
      a2 += u * u;
      if (!b.has(p)) d2 += u * u;
    }
    if (!(a2 > 0 && b2 > 0)) continue;
    out.push({ id, change: Math.sqrt(d2 / a2), noise: n });
  }
  return out;
}

/** How far a library moved between two points (the end settle of a look-back run, as a whole). */
export interface SettleChange extends MovedAgainstNoise {
  /** Cells in the earlier and in the later library. */
  cellsBefore: number;
  cellsAfter: number;
  /** Median relative footprint change, and median change over the cell's own noise (null with no cells). */
  medianChange: number | null;
  medianRatio: number | null;
}

/** `movedAgainstNoise` with the medians (measurement scripts: the `?debug` hook). */
export function settleChange(
  before: Map<number, UnitFootprint>,
  after: Map<number, UnitFootprint>,
  noise: Map<number, number>,
  k: number = SETTLE.movingK,
): SettleChange {
  const ch = footprintChanges(before, after, noise);
  return {
    ...movedAgainstNoise(before, after, noise, k),
    cellsBefore: before.size,
    cellsAfter: after.size,
    medianChange: median(ch.map((c) => c.change)),
    medianRatio: median(ch.map((c) => c.change / c.noise)),
  };
}

// ---- settle during Discover ("Background settle", frames only) ----

/**
 * Settle during Discover ("Background settle"; on whenever a look-back
 * Discover's target is below Max, up to the cap; qc_eval's arm `CS2F`,
 * `--csettle 0.667 --csettle-mode frames`; tools/cala-eval/results/
 * 2026-11-20-concurrent-settle2.md and 2026-11-21-concurrent-settle3.md):
 * while a look-back Discover runs, the look-back worker also re-reads saved
 * frames spread over the history seen so far; each is solved with the
 * current library and updates the footprint statistics, and Discover's
 * ordinary visits do the refining. No settle visits, no quiet rule; held-out
 * frames never reach fitting. The end settle still runs after the last frame.
 */
export const CSETTLE = {
  /** The default cap: re-read frames per live frame the slow loop observes (0 = Off). */
  rate: 2,
  /** The ceilings a user can pick (lower = less work beside the live frames). */
  rates: [2, 1, 0.5],
  /** Frames per request, read in a row (one chunk of the engine's `SettleSched`). */
  chunk: 16,
  /** At most this many chunks owed: what the look-back worker cannot deliver is not saved up. */
  bankChunks: 4,
} as const;

/** A valid ceiling from a setting or URL value: one of `CSETTLE.rates`, else the default. */
export function csettleRate(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return (CSETTLE.rates as readonly unknown[]).includes(n) ? (n as number) : CSETTLE.rate;
}

/**
 * Settle look-back workers besides worker 0 (the settle pool's S; beta speed
 * control, section 1 "Pool size"): one more worker
 * on machines with at least `minCores` logical cores, else none, and one
 * worker takes turns). Started the first time a run's target goes below Max,
 * or at Discover's end for a Final settle on the recording's factors (at Max
 * too).
 *
 * S depends on the logical core count alone (`navigator.hardwareConcurrency`,
 * which the run record keeps as `machine.hardware_concurrency`, next to
 * `settings.lookback_pool`), never on a measured speed, so the same machine
 * always runs the same settle shape. One worker is enough: with it the Final
 * settle on factors is bound by the slow worker, so a second would add memory,
 * not speed. Below the 12-core line the end settle's threads (slow worker,
 * two look-back workers and the visit workers) would outnumber the cores.
 * See tools/cala-eval/results/2026-11-25-settle-visits-and-pool.md.
 */
export const SETTLE_POOL = {
  /** Logical cores (`navigator.hardwareConcurrency`) from which the pool has `workers` workers. */
  minCores: 12,
  workers: 1,
  /** The most a `?debug&lbpool=S` override may ask for. */
  maxWorkers: 4,
} as const;

/**
 * The settle pool's size S for a machine with `cores` logical cores
 * (unknown: none), or the `override` (`?debug&lbpool=S`) when one is given.
 */
export function settlePoolSize(cores: number | undefined, override?: number | null): number {
  if (override !== undefined && override !== null && Number.isFinite(override))
    return Math.max(0, Math.min(SETTLE_POOL.maxWorkers, Math.floor(override)));
  return cores !== undefined && cores >= SETTLE_POOL.minCores ? SETTLE_POOL.workers : 0;
}

// ---- Final-settle levels (a stop point of the settle pass) ----

/**
 * How much of the final settle pass is read (tools/cala-eval/results/
 * 2026-11-22-settledness.md, answer 5): fixed in-order stop points, because no
 * adaptive rule beat them. Thorough is the whole pass and the default.
 */
export const FINAL_SETTLE_LEVELS = {
  thorough: { label: 'Thorough', fraction: 1, help: 'The full pass (default).' },
  standard: {
    label: 'Standard',
    fraction: 0.87,
    help: 'Stops after 87 % of the pass: about an eighth of the final settle saved, nearly the same footprints.',
  },
  quick: {
    label: 'Quick',
    fraction: 0.6,
    help: 'Stops after 60 % of the pass: about 40 % faster Final settle; slightly rougher edges, late-born cells and a few unfilled bites.',
  },
} as const;

/** A key of `FINAL_SETTLE_LEVELS`. */
export type FinalSettleLevel = keyof typeof FINAL_SETTLE_LEVELS;

/** The level used when none is chosen. */
export const FINAL_SETTLE_LEVEL_DEFAULT: FinalSettleLevel = 'thorough';

/** A valid level from a setting or a run record; anything else is the default. */
export function finalSettleLevel(v: unknown): FinalSettleLevel {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FINAL_SETTLE_LEVELS, v)
    ? (v as FinalSettleLevel)
    : FINAL_SETTLE_LEVEL_DEFAULT;
}

/**
 * The first `fraction` of a plan's frames, in plan order (the last run cut
 * short). A fraction of 1 or more (or not a number) returns the plan itself.
 */
export function truncatePlan(runs: readonly FrameRun[], fraction: number): readonly FrameRun[] {
  if (!(fraction < 1)) return runs;
  const want = Math.round(planFrames(runs) * Math.max(0, fraction));
  const out: FrameRun[] = [];
  let left = want;
  for (const r of runs) {
    if (left <= 0) break;
    const n = Math.min(left, r.end - r.start);
    out.push({ start: r.start, end: r.start + n });
    left -= n;
  }
  return out;
}

// ---- Per-footprint "still moving" hint (information only) ----

/** The hint's fixed display scale, in multiples of the cell's split-half noise (clipped; never auto-scaled). */
export const STILL_MOVING_SCALE = { lo: 0, hi: 3 } as const;

/** Tooltip of the column and the colour-by option. */
export const STILL_MOVING_HELP =
  'How much this footprint changed over the last 1,200 settle frames, relative to its noise (centre and edge, whichever is larger). About 1 or below: changes are at noise level. Higher: still settling. Edges count.';

/**
 * Split-half noise of cell `id`'s footprint estimate on `pixels`, relative to
 * the norm of the estimate there (`SlowLoop.footprintNoiseOn`); NaN or
 * non-positive when there is no estimate.
 */
export type RegionNoise = (id: number, pixels: Uint32Array) => number;

/**
 * Per cell present in both libraries: how much its footprint changed over
 * one step against its own split-half noise, as the larger of the core's and
 * the edge's change over that region's noise (so a busy core cannot drown the
 * edge; the study's "edge-ring step", settledness.md answer 6). Each region
 * is measured in the same units as its noise: the L2 change of the unit-peak
 * footprints over the larger of their norms in the region, against
 * `regionNoise` (half the split-half difference over the norm of the mean,
 * on the same pixels). Core = pixels at or above half the peak in either
 * footprint; edge = the union support minus the core. A region with no
 * noise estimate is left out; a cell with neither region, or with no earlier
 * footprint, is left out. Returns `[id, ratio, ...]`.
 */
export function stillMovingRatios(
  before: Map<number, UnitFootprint>,
  after: Map<number, UnitFootprint>,
  regionNoise: RegionNoise,
): Float64Array {
  const out: number[] = [];
  for (const [id, b] of after) {
    const a = before.get(id);
    if (!a) continue;
    const core: number[] = [];
    const edge: number[] = [];
    const seen = new Set<number>();
    for (const m of [a, b])
      for (const p of m.keys()) {
        if (seen.has(p)) continue;
        seen.add(p);
        ((a.get(p) ?? 0) >= 0.5 || (b.get(p) ?? 0) >= 0.5 ? core : edge).push(p);
      }
    let best = Number.NaN;
    for (const region of [core, edge]) {
      if (region.length === 0) continue;
      const pixels = Uint32Array.from(region);
      const n = regionNoise(id, pixels);
      if (!(n > 0 && Number.isFinite(n))) continue;
      let d2 = 0;
      let a2 = 0;
      let b2 = 0;
      for (const p of pixels) {
        const u = a.get(p) ?? 0;
        const v = b.get(p) ?? 0;
        d2 += (v - u) * (v - u);
        a2 += u * u;
        b2 += v * v;
      }
      const norm = Math.sqrt(Math.max(a2, b2));
      const r = norm > 0 ? Math.sqrt(d2) / norm / n : 0;
      if (!(r <= best)) best = r;
    }
    if (!Number.isNaN(best)) out.push(id, best);
  }
  return Float64Array.from(out);
}

/** `[id, ratio, ...]` as a map (non-finite ratios kept as `Infinity` only if positive; NaN left out). */
export function stillMovingMap(flat: ArrayLike<number> | undefined): Map<number, number> {
  const m = new Map<number, number>();
  if (!flat) return m;
  for (let i = 0; i + 1 < flat.length; i += 2)
    if (!Number.isNaN(flat[i + 1])) m.set(flat[i], flat[i + 1]);
  return m;
}
