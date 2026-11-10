/**
 * Per-cell traces on the main thread, for the selected-cell trace viewer.
 *
 * Each cell keeps every frame since it first appeared, as f32, in a buffer
 * that grows 1.5x as it fills (so memory follows the data actually held, about
 * 4 bytes per cell per frame plus headroom: 600 cells x 24k frames = 58-80 MB).
 * Memory is split evenly: the per-cell ring size is
 * `min(capacity, max(MIN_RING, maxBytes / 4 / cells))` for the cells tracked,
 * so a cell found late in a long recording gets a trace as good as the first
 * one's. When new cells arrive and the share shrinks, every longer buffer is
 * cut back to the newest frames that fit (the whole-session envelope keeps the
 * overview). `capacity` frames per cell (default 2^17, 1.8 h at 20 fps) is the
 * most any one cell keeps; past its ring size a buffer keeps the newest frames.
 * Defaults: 256 MB, so 4000 cells keep 16k frames each (9 min at 30 fps), 700
 * cells keep 93k (52 min). Up to `maxCells` cells are tracked (default 20000,
 * well above any library; each costs a fixed 12 KiB envelope too). Frames a
 * cell missed (a gap in the
 * stream) are stored as NaN. Cells that leave the library are dropped by
 * `retain`. Each tracked cell also retains a fixed 12 KiB whole-session min/max
 * envelope (at most about 36 MiB at maxCells). Pure, unit-tested.
 */

import { OVERVIEW_BUCKETS, TraceOverviewHistory, type TraceEnvelope } from './trace-overview.ts';

interface Buffer {
  overview: TraceOverviewHistory;
  values: Float32Array;
  /** Stream frame of the first sample ever stored (index origin). */
  origin: number;
  /** Samples held (up to values.length) and the stream frame after the newest. */
  len: number;
  end: number;
}

export interface CellTrace {
  /** Stream frame of each sample, oldest first. */
  frames: number[];
  values: number[];
}

const INITIAL_FRAMES = 1024;
/** Smallest ring a cell is cut back to (beyond the budget only past ~65k cells at 256 MB). */
const MIN_RING = 256;
/** Buffer growth factor: at most a third of a buffer is unused headroom. */
const GROWTH = 1.5;

export class TraceHistory {
  readonly capacity: number;
  readonly maxCells: number;
  readonly maxBytes: number;
  private readonly bufs = new Map<number, Buffer>();
  private held = 0;
  /** Ring size per cell for the batch being pushed (see `push`). */
  private cap = 0;

  constructor(capacity = 1 << 17, maxCells = 20000, maxBytes = 256 * 1048576) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.maxCells = Math.max(1, Math.floor(maxCells));
    this.maxBytes = Math.max(4, Math.floor(maxBytes));
  }

  get cellCount(): number {
    return this.bufs.size;
  }

  /** Bytes held by full-resolution trace buffers (envelopes counted separately). */
  get bytes(): number {
    return this.held;
  }

  /** Fixed envelope storage, released with its cell (at most maxCells * 12 KiB). */
  get overviewBytes(): number {
    return this.bufs.size * OVERVIEW_BUCKETS * 24;
  }

  overview(id: number): TraceEnvelope {
    return this.bufs.get(id)?.overview.get() ?? { frames: [], values: [], bucketFrames: 8 };
  }

  /** Count `frames` more f32 samples against the budget; false when over it. */
  private reserve(frames: number): boolean {
    const bytes = frames * 4;
    if (this.held + bytes > this.maxBytes) return false;
    this.held += bytes;
    return true;
  }

  /** The ring size each of `cells` tracked cells gets (equal share of the budget). */
  ringFor(cells: number): number {
    const share = Math.floor(this.maxBytes / 4 / Math.max(1, cells));
    return Math.min(this.capacity, Math.max(Math.min(MIN_RING, this.capacity), share));
  }

  /** Cut `b` back to its newest `size` frames, linearised (so it may grow again later). */
  private shrink(b: Buffer, size: number): void {
    const old = b.values.length;
    const keep = Math.min(b.len, size);
    const first = b.end - keep;
    const next = new Float32Array(size);
    for (let k = 0; k < keep; k++) next[k] = b.values[(first + k - b.origin) % old];
    this.held -= (old - size) * 4;
    b.values = next;
    b.origin = first;
    b.len = keep;
  }

  /** Make room for `frames` more samples in `b` while it is still linear. */
  private grow(b: Buffer, frames: number): void {
    const size = b.values.length;
    const cap = this.cap;
    // Once wrapped (len < frames since origin) a buffer never grows again.
    if (b.len !== b.end - b.origin || b.len + frames <= size || size >= cap) return;
    let next = size;
    while (next < b.len + frames && next < cap) next = Math.ceil(next * GROWTH);
    next = Math.min(next, cap);
    if (!this.reserve(next - size)) return;
    const bigger = new Float32Array(next);
    bigger.set(b.values.subarray(0, b.len));
    b.values = bigger;
  }

  private write(b: Buffer, frame: number, v: number): void {
    const size = b.values.length;
    b.values[(frame - b.origin) % size] = v;
  }

  /**
   * Append a batch: `count` frames from stream frame `start`, `traces` holds
   * `count * ids.length` values, frame after frame, in `ids` order.
   */
  push(start: number, count: number, ids: ArrayLike<number>, traces: ArrayLike<number>): void {
    const n = ids.length;
    if (n === 0 || traces.length < count * n) return;
    // New cells take an equal share: cut the longer rings back to it first.
    let fresh = 0;
    for (let j = 0; j < n; j++) if (!this.bufs.has(ids[j])) fresh++;
    // The share this batch works with: the cells tracked once the new ones are in.
    this.cap = this.ringFor(Math.min(this.maxCells, this.bufs.size + fresh));
    if (fresh > 0) {
      for (const b of this.bufs.values()) if (b.values.length > this.cap) this.shrink(b, this.cap);
    }
    for (let j = 0; j < n; j++) {
      const id = ids[j];
      let b = this.bufs.get(id);
      // A long gap resets detailed storage, but keeps the session envelope.
      const overview = b && start >= b.end ? b.overview : new TraceOverviewHistory();
      if (b && (start < b.end || start - b.end > this.capacity)) {
        // Rewound, or a gap longer than the buffer: start this cell afresh.
        this.drop(id);
        b = undefined;
      }
      if (!b) {
        if (this.bufs.size >= this.maxCells) continue;
        const size = Math.min(this.cap, Math.max(INITIAL_FRAMES, count));
        if (!this.reserve(size)) continue;
        b = { values: new Float32Array(size), origin: start, len: 0, end: start, overview };
        this.bufs.set(id, b);
      }
      // Frames this cell missed are kept as NaN, so frames stay aligned.
      const gap = start - b.end;
      this.grow(b, gap + count);
      for (let f = b.end; f < start; f++) this.write(b, f, NaN);
      for (let i = 0; i < count; i++) {
        const value = traces[i * n + j];
        this.write(b, start + i, value);
        b.overview.push(start + i, value);
      }
      b.end = start + count;
      b.len = Math.min(b.values.length, b.len + gap + count);
    }
  }

  private drop(id: number): void {
    const b = this.bufs.get(id);
    if (!b) return;
    this.held -= b.values.length * 4;
    this.bufs.delete(id);
  }

  /** Drop every cell not in `ids` (except `keep`, e.g. the selected cell). */
  retain(ids: Iterable<number>, keep?: number | null): void {
    const live = new Set(ids);
    if (keep !== undefined && keep !== null) live.add(keep);
    for (const id of [...this.bufs.keys()]) if (!live.has(id)) this.drop(id);
  }

  has(id: number): boolean {
    return this.bufs.has(id);
  }

  /** Stream frames [first, end) held for `id` (null when unknown). */
  span(id: number): { first: number; end: number } | null {
    const b = this.bufs.get(id);
    return b ? { first: b.end - b.len, end: b.end } : null;
  }

  /**
   * The trace of `id` laid out on stream frames [0, frames): NaN where it has
   * no sample (before it appeared, or frames since lost to the ring).
   */
  dense(id: number, frames: number): Float64Array {
    return this.range(id, 0, frames);
  }

  /** A dense slice on [first, end), allocating only the requested window. */
  range(id: number, first: number, end: number): Float64Array {
    first = Math.max(0, Math.floor(first));
    end = Math.max(first, Math.floor(end));
    const out = new Float64Array(end - first).fill(NaN);
    const b = this.bufs.get(id);
    if (!b) return out;
    const size = b.values.length;
    const from = Math.max(first, b.end - b.len);
    const to = Math.min(end, b.end);
    for (let f = from; f < to; f++) out[f - first] = b.values[(f - b.origin) % size];
    return out;
  }

  /** The stored history of `id`, oldest first (empty when unknown). */
  get(id: number): CellTrace {
    const b = this.bufs.get(id);
    if (!b) return { frames: [], values: [] };
    const size = b.values.length;
    const frames = new Array<number>(b.len);
    const values = new Array<number>(b.len);
    const first = b.end - b.len;
    for (let k = 0; k < b.len; k++) {
      frames[k] = first + k;
      values[k] = b.values[(first + k - b.origin) % size];
    }
    return { frames, values };
  }

  clear(): void {
    this.bufs.clear();
    this.held = 0;
  }
}
