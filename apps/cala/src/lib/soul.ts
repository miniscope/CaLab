/**
 * The app's ambient life, read from the run itself: the population's onsets (the activity
 * ribbon under the field of view and the heartbeat of the Cala mark), cell births (a bloom
 * where each new cell appears), the run's moments (milestones, convergence, stage handoffs) and
 * the session portrait at the end. One page-level hub (`soul()`), fed by the field of view's
 * 2 Hz activity sampler and the rail's 2 Hz snapshot; nothing here reads per frame or touches
 * the data. The pure parts (the ribbon's bins, birth diffing, the milestone tracker, the
 * portrait's stats) are unit-tested.
 */
import { createSignal } from 'solid-js';
import type { CellShape } from './cell-overlay.ts';
import type { ActivityTick } from './activity.ts';

// ---- Activity ribbon: onsets binned by recording time ----

/** Seconds of recording per ribbon column. */
export const RIBBON_BIN_S = 0.5;
/** Seconds of recording the ribbon shows (newest at the right). */
export const RIBBON_SPAN_S = 60;
/** The ribbon's fixed scale: share of the library's cells with an onset in one column. */
export const RIBBON_MAX_SHARE = 0.25;
/** A column at or above this share reads as a synchronous event (often motion, or a real burst). */
export const SYNC_SHARE = 0.15;

/** Frames per ribbon column at a frame rate (at least 1). */
export const binFrames = (fps: number): number =>
  Math.max(1, Math.round((fps > 0 ? fps : 20) * RIBBON_BIN_S));

/**
 * Onsets per column of recording time. Columns are fixed blocks of `bin` stream frames; each
 * keeps the cells whose solved trace was read over it and the cells with an onset in it, so its
 * share is "cells that fired, of the cells read there" (a column the sampler never read, at a
 * speed above its window, is a gap, not a quiet stretch). Frames may arrive late (a trace the
 * slow loop has not solved yet is read on a later tick) and land in their own columns. Old
 * columns are dropped past `keep`; a jump far back starts afresh.
 */
export class OnsetRibbon {
  readonly bin: number;
  readonly keep: number;
  private read = new Map<number, Set<number>>();
  private fired = new Map<number, Set<number>>();
  /** Newest frame read (exclusive end), -1 before any. */
  end = -1;

  constructor(bin: number, keep = Math.ceil(RIBBON_SPAN_S / RIBBON_BIN_S) + 2) {
    this.bin = Math.max(1, Math.floor(bin));
    this.keep = keep;
  }

  private col(m: Map<number, Set<number>>, b: number): Set<number> {
    let s = m.get(b);
    if (!s) m.set(b, (s = new Set()));
    return s;
  }

  /** One tick's reads (each cell's solved frames [from, to)) and onsets. */
  add(
    reads: readonly { id: number; from: number; to: number }[],
    onsets: readonly { id: number; frame: number }[],
  ): void {
    let hi = -1;
    for (const r of reads) hi = Math.max(hi, r.to);
    if (hi <= 0) return;
    if (hi < this.end - this.keep * this.bin) this.clear();
    const oldest = Math.floor((Math.max(hi, this.end) - 1) / this.bin) - this.keep;
    for (const r of reads) {
      if (r.to <= r.from) continue;
      const b0 = Math.max(oldest, Math.floor(r.from / this.bin));
      const b1 = Math.floor((r.to - 1) / this.bin);
      for (let b = b0; b <= b1; b++) this.col(this.read, b).add(r.id);
    }
    for (const o of onsets) {
      const b = Math.floor(o.frame / this.bin);
      if (b >= oldest) this.col(this.fired, b).add(o.id);
    }
    this.end = Math.max(this.end, hi);
    for (const m of [this.read, this.fired]) for (const b of m.keys()) if (b < oldest) m.delete(b);
  }

  clear(): void {
    this.read.clear();
    this.fired.clear();
    this.end = -1;
  }

  /**
   * The newest `n` columns ending at the newest frame read, oldest first: the share of the cells
   * read there with an onset (NaN: not read), and the number of cells with an onset.
   */
  columns(n: number): { share: Float32Array; count: Int32Array } {
    const share = new Float32Array(n).fill(NaN);
    const count = new Int32Array(n);
    if (this.end <= 0) return { share, count };
    const last = Math.floor((this.end - 1) / this.bin);
    for (let i = 0; i < n; i++) {
      const b = last - (n - 1 - i);
      const r = this.read.get(b);
      if (!r || r.size === 0) continue;
      const c = this.fired.get(b)?.size ?? 0;
      count[i] = c;
      share[i] = c / r.size;
    }
    return { share, count };
  }
}

/** Ribbon column height 0..1 on the fixed scale, and whether it is clipped at the top. */
export function ribbonHeight(share: number): { h: number; clipped: boolean } {
  if (!Number.isFinite(share) || share <= 0) return { h: 0, clipped: false };
  return { h: Math.min(1, share / RIBBON_MAX_SHARE), clipped: share > RIBBON_MAX_SHARE };
}

/**
 * One line about the population over the newest columns, tied to what the ribbon shows:
 * how many onsets in the last `recentCols` columns, and a synchronous column if there is one.
 */
export function ribbonCaption(share: Float32Array, count: Int32Array, recentCols: number): string {
  let read = 0;
  let sum = 0;
  let sync = false;
  for (let i = Math.max(0, share.length - recentCols); i < share.length; i++) {
    if (!Number.isFinite(share[i])) continue;
    read++;
    sum += count[i];
    if (share[i] >= SYNC_SHARE) sync = true;
  }
  if (read === 0) return 'Waiting for frames';
  if (sync) return 'Many cells at once: a burst, or motion';
  if (sum === 0) return 'Quiet';
  return `${sum.toLocaleString('en-US')} cell onset${sum === 1 ? '' : 's'} in the last ${Math.round(read * RIBBON_BIN_S)} s`;
}

// ---- Heartbeat ----

/** Strength 0..1 of one heartbeat: the share of cells that fired this tick, on a fixed scale. */
export function beatStrength(onsets: number, cells: number): number {
  if (!(onsets > 0) || !(cells > 0)) return 0;
  return Math.min(1, onsets / cells / 0.1);
}

// ---- Births ----

/** Ids in `next` that were not in `prev` (in `next`'s order). */
export function newIds(prev: ArrayLike<number> | null, next: ArrayLike<number>): number[] {
  const seen = new Set<number>();
  if (prev) for (let i = 0; i < prev.length; i++) seen.add(prev[i]);
  const out: number[] = [];
  for (let i = 0; i < next.length; i++) if (!seen.has(next[i])) out.push(next[i]);
  return out;
}

/** Where a footprint sits: its weighted centre and a radius (pixels), from its support. */
export function shapeCentre(sh: CellShape, width: number): { x: number; y: number; r: number } {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < sh.support.length; k++) {
    const w = sh.rel[k];
    if (!(w > 0)) continue;
    const p = sh.support[k];
    const y = Math.floor(p / width);
    sx += w * (p - y * width + 0.5);
    sy += w * (y + 0.5);
    sw += w;
  }
  const r = Math.max(2, Math.max(sh.x1 - sh.x0, sh.y1 - sh.y0) / 2);
  if (sw <= 0) return { x: (sh.x0 + sh.x1) / 2, y: (sh.y0 + sh.y1) / 2, r };
  return { x: sx / sw, y: sy / sw, r };
}

/** Blooms on screen at once at most; more births wait their turn. */
export const MAX_BLOOMS = 24;
/** Births waiting at most; older ones are dropped (a library that adds hundreds at once). */
export const MAX_BIRTH_QUEUE = 96;

/**
 * The birth queue: `push` births as libraries arrive, `take(free)` the next ones to show when
 * there is room. Keeps at most `MAX_BIRTH_QUEUE` (newest kept).
 */
export class BirthQueue<T> {
  private q: T[] = [];
  push(items: readonly T[]): void {
    this.q.push(...items);
    if (this.q.length > MAX_BIRTH_QUEUE) this.q.splice(0, this.q.length - MAX_BIRTH_QUEUE);
  }
  take(free: number): T[] {
    return free > 0 ? this.q.splice(0, free) : [];
  }
  clear(): void {
    this.q.length = 0;
  }
  get size(): number {
    return this.q.length;
  }
}

// ---- Moments: milestones, convergence, stage handoffs ----

/** Cell counts that get a moment, with their note. */
export const MILESTONES: readonly { at: number; note: string }[] = [
  { at: 1, note: 'First cell!' },
  { at: 50, note: '50 cells' },
  { at: 100, note: '100 cells!' },
  { at: 250, note: '250 cells' },
  { at: 500, note: '500 cells!' },
  { at: 1000, note: '1,000 cells!' },
];

export const milestoneNote = (at: number): string =>
  MILESTONES.find((m) => m.at === at)?.note ?? `${at.toLocaleString('en-US')} cells`;

/**
 * Milestones crossed going from `prev` to `next` cells, not yet in `fired` (which it updates),
 * lowest first.
 */
export function crossMilestones(prev: number, next: number, fired: Set<number>): number[] {
  const out: number[] = [];
  for (const m of MILESTONES) {
    if (next >= m.at && prev < m.at && !fired.has(m.at)) {
      fired.add(m.at);
      out.push(m.at);
    }
  }
  return out;
}

/**
 * Milestones of one run's live cell count, read at the rail's 2 Hz. A run is known by its
 * `run` key (the cell store's session): a new key starts from zero, so a milestone never
 * depends on catching the brief 'starting' status (seeing it only marks the next run fresh),
 * and a remount (a new tracker) mid-run or after it primes on its first reading and never
 * replays. Nothing while idle, for a saved
 * result (`run` < 0), or before the first library. `observe` returns the highest milestone
 * crossed, or null.
 */
export function createMilestoneTracker() {
  const fired = new Set<number>();
  let key: number | null = null;
  let last: number | null = null;
  let sawStart = false;
  return {
    observe(status: string, cells: number | null, run: number): number | null {
      if (status === 'starting') sawStart = true;
      if (run < 0 || status === 'idle' || status === 'starting') return null;
      if (key !== run) {
        // First sight of this run: from zero when it is fresh (a start seen, a run after one
        // seen, or no cells yet), else primed (a remount).
        const fresh = sawStart || key !== null || cells === 0;
        sawStart = false;
        key = run;
        fired.clear();
        last = fresh ? 0 : cells;
        if (!fresh) {
          for (const m of MILESTONES) if (cells !== null && cells >= m.at) fired.add(m.at);
          return null;
        }
      }
      if (cells === null) return null;
      const crossed = crossMilestones(last ?? 0, cells, fired);
      last = cells;
      return crossed.at(-1) ?? null;
    },
  };
}

export type MomentKind = 'milestone' | 'converged' | 'handoff' | 'finished';

export interface Moment {
  /** Increments per moment (a keyed element replays its animation). */
  seq: number;
  kind: MomentKind;
  /** The big line (e.g. "100 cells!"). */
  title: string;
  /** The small line under it (may be empty). */
  note: string;
}

// ---- Session portrait ----

export interface PortraitStats {
  cells: number;
  /** Wall-clock run time, ms (null: unknown, e.g. after a remount). */
  runMs: number | null;
  /** Recording time covered, s (null: unknown). */
  recordingS: number | null;
  /** The cell with the most onsets over its whole live trace (null: none). */
  mostActive: { id: number; onsets: number } | null;
}

/** "1:05" / "12:34" / "1:02:03" for a duration in seconds. */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The portrait's stat lines, label and value. */
export function portraitLines(st: PortraitStats): { label: string; value: string }[] {
  const out = [{ label: 'Cells', value: st.cells.toLocaleString('en-US') }];
  if (st.recordingS !== null) out.push({ label: 'Recording', value: clock(st.recordingS) });
  if (st.runMs !== null) out.push({ label: 'Run time', value: clock(st.runMs / 1000) });
  if (st.mostActive)
    out.push({
      label: 'Most active',
      value: `cell ${st.mostActive.id} · ${st.mostActive.onsets} onsets`,
    });
  return out;
}

/** The id with the most onsets (ties: the lower id); null when none has any. */
export function mostActive(
  counts: ReadonlyMap<number, number>,
): { id: number; onsets: number } | null {
  let best: { id: number; onsets: number } | null = null;
  for (const [id, n] of counts) {
    if (n <= 0) continue;
    if (!best || n > best.onsets || (n === best.onsets && id < best.id)) best = { id, onsets: n };
  }
  return best;
}

// ---- The page hub ----

/** The page's ambient-life hub (one per page; `soul()` below). */
export function createSoul() {
  const [beat, setBeat] = createSignal<{ seq: number; strength: number }>({ seq: 0, strength: 0 });
  const [ribbonVersion, setRibbonVersion] = createSignal(0);
  const [moment, setMoment] = createSignal<Moment | null>(null);
  const [portrait, setPortrait] = createSignal<{ seq: number; runMs: number | null } | null>(null);
  const [stage, setStage] = createSignal<string | null>(null);
  let ribbon = new OnsetRibbon(binFrames(20));
  let seq = 0;
  return {
    /** The stage running or paused now (discover, settle, extract), null when none. */
    stage,
    setStage,
    /** The newest heartbeat (strength 0: a quiet tick). */
    beat,
    /** Bumps whenever the ribbon gained columns. */
    ribbonVersion,
    ribbon: () => ribbon,
    /** Set the frame rate (a new ribbon when its column size changes). */
    setFps(fps: number) {
      const b = binFrames(fps);
      if (b !== ribbon.bin) {
        ribbon = new OnsetRibbon(b);
        setRibbonVersion((v) => v + 1);
      }
    },
    /** One activity tick (the field of view's sampler). */
    tick(t: ActivityTick) {
      if (t.reads.length > 0) {
        ribbon.add(t.reads, t.onsets);
        setRibbonVersion((v) => v + 1);
      }
      setBeat((b) => ({ seq: b.seq + 1, strength: beatStrength(t.fired.length, t.cells) }));
    },
    /** A new run: the ribbon starts empty. */
    resetRun() {
      ribbon.clear();
      setRibbonVersion((v) => v + 1);
      setMoment(null);
      setPortrait(null);
    },
    moment,
    say(kind: MomentKind, title: string, note = '') {
      setMoment({ seq: ++seq, kind, title, note });
    },
    clearMoment: () => setMoment(null),
    /** The run finished: show the session portrait (`runMs`: wall-clock run time). */
    portrait,
    showPortrait: (runMs: number | null) => setPortrait({ seq: ++seq, runMs }),
    closePortrait: () => setPortrait(null),
  };
}

export type Soul = ReturnType<typeof createSoul>;

let page: Soul | null = null;
/** The page's hub, created on first use. */
export function soul(): Soul {
  page ??= createSoul();
  return page;
}

/** Tests: forget the page hub. */
export function resetSoulForTests(): void {
  page = null;
}
