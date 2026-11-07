/**
 * Per-cell traces on the main thread, for the selected-cell trace viewer.
 *
 * Each cell keeps every frame since it first appeared, as f32, in a buffer
 * that grows 1.5x as it fills (so memory follows the data actually held, about
 * 4 bytes per cell per frame plus headroom: 600 cells x 24k frames = 58-80 MB).
 * Two bounds keep
 * it finite on very long recordings:
 *   - `capacity` frames per cell (default 2^17 = 131072, 1.8 h at 20 fps):
 *     past it, the buffer becomes a ring that keeps the newest frames;
 *   - `maxBytes` in total (default 256 MB): a buffer that would grow past it
 *     stops growing and becomes a ring at its current size.
 * At most `maxCells` cells are tracked. Frames a cell missed (a gap in the
 * stream) are stored as NaN. Cells that leave the library are dropped by
 * `retain`. Pure, unit-tested.
 */

interface Buffer {
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
/** Buffer growth factor: at most a third of a buffer is unused headroom. */
const GROWTH = 1.5;

export class TraceHistory {
  readonly capacity: number;
  readonly maxCells: number;
  readonly maxBytes: number;
  private readonly bufs = new Map<number, Buffer>();
  private held = 0;

  constructor(capacity = 1 << 17, maxCells = 3000, maxBytes = 256 * 1048576) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.maxCells = Math.max(1, Math.floor(maxCells));
    this.maxBytes = Math.max(4, Math.floor(maxBytes));
  }

  get cellCount(): number {
    return this.bufs.size;
  }

  /** Bytes held by the trace buffers. */
  get bytes(): number {
    return this.held;
  }

  /** Count `frames` more f32 samples against the budget; false when over it. */
  private reserve(frames: number): boolean {
    const bytes = frames * 4;
    if (this.held + bytes > this.maxBytes) return false;
    this.held += bytes;
    return true;
  }

  /** Make room for `frames` more samples in `b` while it is still linear. */
  private grow(b: Buffer, frames: number): void {
    const size = b.values.length;
    // Once wrapped (len < frames since origin) a buffer never grows again.
    if (b.len !== b.end - b.origin || b.len + frames <= size || size >= this.capacity) return;
    let next = size;
    while (next < b.len + frames && next < this.capacity) next = Math.ceil(next * GROWTH);
    next = Math.min(next, this.capacity);
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
    for (let j = 0; j < n; j++) {
      const id = ids[j];
      let b = this.bufs.get(id);
      if (b && (start < b.end || start - b.end > this.capacity)) {
        // Rewound, or a gap longer than the buffer: start this cell afresh.
        this.drop(id);
        b = undefined;
      }
      if (!b) {
        if (this.bufs.size >= this.maxCells) continue;
        const size = Math.min(this.capacity, Math.max(INITIAL_FRAMES, count));
        if (!this.reserve(size)) continue;
        b = { values: new Float32Array(size), origin: start, len: 0, end: start };
        this.bufs.set(id, b);
      }
      // Frames this cell missed are kept as NaN, so frames stay aligned.
      const gap = start - b.end;
      this.grow(b, gap + count);
      for (let f = b.end; f < start; f++) this.write(b, f, NaN);
      for (let i = 0; i < count; i++) this.write(b, start + i, traces[i * n + j]);
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
    const out = new Float64Array(Math.max(0, frames)).fill(NaN);
    const b = this.bufs.get(id);
    if (!b) return out;
    const size = b.values.length;
    const from = Math.max(0, b.end - b.len);
    const to = Math.min(frames, b.end);
    for (let f = from; f < to; f++) out[f] = b.values[(f - b.origin) % size];
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
