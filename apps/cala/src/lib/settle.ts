/**
 * The end-of-Discover settle of a look-back run (experimental; qc_eval's
 * `--settle-frames N --settle-batch 16`, `LookBack::settle`): with the cell
 * set frozen, the look-back worker re-reads the recording once and every
 * frame goes through the slow loop's ordinary `observe`, as a Refine pass
 * feeds its frames. That renews the held-out test frames each refinement is
 * judged on, which look-back alone never does (tools/cala-eval/results/
 * 2026-11-19-lookback-settle.md). `SlowRunner` drives it; this module holds
 * the frame plan and the "cells still moving" readout, both pure.
 */

/** The settle's settings (see `settle_design.md`, "Design of the end-of-Discover settle"). */
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
   * whole budget; 4 % separated settled from unsettled libraries on sims and
   * the workshop recording).
   */
  movingShare: 0.04,
  /** The last round of visits: every tile due, this many slow-loop budgets (without visit workers). */
  finalSteps: 64,
  /** With visit workers: at most this many visits in the last round (besides the work cap). */
  finalVisitsMax: 4096,
} as const;

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
   * Block sequence for the look-back worker: a new value starts a fresh copy
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
    return n;
  }

  get done(): boolean {
    return this.run >= this.runs.length;
  }

  /** The next up to `max` frames (empty when done). */
  take(max: number): SettleFrame[] {
    const out: SettleFrame[] = [];
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
  const median = (v: number[]) => {
    if (v.length === 0) return null;
    const s = [...v].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    ...movedAgainstNoise(before, after, noise, k),
    cellsBefore: before.size,
    cellsAfter: after.size,
    medianChange: median(ch.map((c) => c.change)),
    medianRatio: median(ch.map((c) => c.change / c.noise)),
  };
}

// ---- settle during Discover (experimental, frames only) ----

/**
 * Settle during Discover (experimental, default off; qc_eval's arm `CS2F`,
 * `--csettle 0.667 --csettle-mode frames`; tools/cala-eval/results/
 * 2026-11-20-concurrent-settle2.md and 2026-11-21-concurrent-settle3.md):
 * while a look-back Discover runs, the look-back worker also re-reads saved
 * frames spread over the history seen so far; each is solved with the
 * current library and updates the footprint statistics, and Discover's
 * ordinary visits do the refining. No settle visits, no quiet rule; held-out
 * frames never reach fitting. The end settle still runs after the last frame.
 */
export const CSETTLE = {
  /** The default ceiling: re-read frames per live frame the slow loop observes. */
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
 * The dose of the settle during Discover (qc_eval's `Timed::cs_owed`): every
 * live frame the slow loop observes earns `rate` re-read frames; a request
 * of one chunk goes out when a whole chunk is owed (and no other is out);
 * at most `CSETTLE.bankChunks` chunks are saved up. So `rate` is a ceiling:
 * a look-back worker that cannot keep up delivers less and the rest lapses.
 */
export class SettleDose {
  private owedFrames = 0;
  readonly cap: number;

  constructor(
    readonly rate: number,
    readonly chunk: number = CSETTLE.chunk,
    bankChunks: number = CSETTLE.bankChunks,
  ) {
    this.cap = chunk * bankChunks;
  }

  /** Re-read frames owed now. */
  get owed(): number {
    return this.owedFrames;
  }

  /** `live` frames were observed. */
  earn(live: number): void {
    if (!(this.rate > 0) || !(live > 0)) return;
    this.owedFrames = Math.min(this.cap, this.owedFrames + live * this.rate);
  }

  /** A whole chunk is owed. */
  get ready(): boolean {
    return this.owedFrames >= this.chunk;
  }

  /** `frames` were asked for. */
  spend(frames: number): void {
    this.owedFrames = Math.max(0, this.owedFrames - frames);
  }
}
