/**
 * Recent per-cell traces on the main thread, for the clicked-cell plot.
 *
 * Each cell keeps a ring buffer of its last `capacity` frames (allocated when
 * the cell first appears), and at most `maxCells` cells are tracked, so memory
 * is at most `maxCells * capacity * 4` bytes (defaults: 3000 x 4096 frames,
 * about 49 MB; ~11 MB for 700 cells). Cells that leave the library (merged or
 * deleted) are dropped by `retain`. Pure, unit-tested.
 */

interface Ring {
  values: Float32Array;
  /** Samples stored (up to capacity) and the stream frame after the newest. */
  len: number;
  end: number;
}

export interface CellTrace {
  /** Stream frame of each sample, oldest first. */
  frames: number[];
  values: number[];
}

export class TraceHistory {
  readonly capacity: number;
  readonly maxCells: number;
  private readonly rings = new Map<number, Ring>();

  constructor(capacity = 4096, maxCells = 3000) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.maxCells = Math.max(1, Math.floor(maxCells));
  }

  get cellCount(): number {
    return this.rings.size;
  }

  /** Bytes held by the trace buffers. */
  get bytes(): number {
    return this.rings.size * this.capacity * 4;
  }

  /**
   * Append a batch: `count` frames from stream frame `start`, `traces` holds
   * `count * ids.length` values, frame after frame, in `ids` order.
   */
  push(start: number, count: number, ids: ArrayLike<number>, traces: ArrayLike<number>): void {
    const n = ids.length;
    if (n === 0 || traces.length < count * n) return;
    const cap = this.capacity;
    for (let j = 0; j < n; j++) {
      const id = ids[j];
      let r = this.rings.get(id);
      if (!r) {
        if (this.rings.size >= this.maxCells) continue;
        r = { values: new Float32Array(cap), len: 0, end: start };
        this.rings.set(id, r);
      } else if (r.end !== start) {
        // A gap (frames this cell missed): start its history afresh.
        r.len = 0;
        r.end = start;
      }
      for (let i = 0; i < count; i++) {
        r.values[(r.end + i) % cap] = traces[i * n + j];
      }
      r.end += count;
      r.len = Math.min(cap, r.len + count);
    }
  }

  /** Drop every cell not in `ids` (except `keep`, e.g. the selected cell). */
  retain(ids: Iterable<number>, keep?: number | null): void {
    const live = new Set(ids);
    if (keep !== undefined && keep !== null) live.add(keep);
    for (const id of [...this.rings.keys()]) if (!live.has(id)) this.rings.delete(id);
  }

  has(id: number): boolean {
    return this.rings.has(id);
  }

  /** The stored history of `id`, oldest first (empty when unknown). */
  get(id: number): CellTrace {
    const r = this.rings.get(id);
    if (!r) return { frames: [], values: [] };
    const frames = new Array<number>(r.len);
    const values = new Array<number>(r.len);
    const first = r.end - r.len;
    for (let k = 0; k < r.len; k++) {
      frames[k] = first + k;
      values[k] = r.values[(first + k) % this.capacity];
    }
    return { frames, values };
  }

  clear(): void {
    this.rings.clear();
  }
}
