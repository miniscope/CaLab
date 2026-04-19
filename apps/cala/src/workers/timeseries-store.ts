/**
 * Tiered per-name timeseries store for the archive worker (design §9.1).
 *
 * Each named metric gets two flat `Float32Array` rings:
 *
 *  * **L1** — recent full-resolution samples (most recent `l1Capacity`
 *    appends, drop-oldest).
 *  * **L2** — older samples downsampled in blocks of `l2Stride`, again
 *    drop-oldest at `l2Capacity`.
 *
 * When L1 evicts a sample it rolls into an accumulator; every
 * `l2Stride` evictions the accumulator's mean is emitted into L2 with
 * the midpoint timestamp. That keeps per-metric memory bounded at
 * `O(l1Capacity + l2Capacity)` regardless of recording length.
 *
 * The store is intentionally in-process: the archive worker owns it,
 * `TimeseriesStore.query` returns plain `Float32Array`s the worker can
 * post back without touching the internals. No magic numbers —
 * capacities and stride are caller-supplied.
 */
const EMPTY_F32 = new Float32Array(0);

export interface TimeseriesStoreConfig {
  /** Full-resolution ring size per metric name. */
  l1Capacity: number;
  /** Downsampled ring size per metric name. */
  l2Capacity: number;
  /** Number of L1 evictions that aggregate into one L2 sample. */
  l2Stride: number;
  /** Hard cap on distinct metric names (drop-oldest by insertion order). */
  maxNames: number;
}

export interface TimeseriesQuery {
  /** Oldest→newest L1 timestamps, chronological. */
  l1Times: Float32Array;
  /** Values paired with `l1Times`. */
  l1Values: Float32Array;
  /** Oldest→newest L2 timestamps (midpoint of their block). */
  l2Times: Float32Array;
  /** Mean value of each L2 block, paired with `l2Times`. */
  l2Values: Float32Array;
}

interface PerName {
  l1Times: Float32Array;
  l1Values: Float32Array;
  l1Head: number;
  l1Count: number;
  l2Times: Float32Array;
  l2Values: Float32Array;
  l2Head: number;
  l2Count: number;
  // Running L2 block aggregator fed by L1 evictions.
  accumSum: number;
  accumCount: number;
  accumFirstT: number;
  accumLastT: number;
}

function validateConfig(cfg: TimeseriesStoreConfig): void {
  const check = (name: keyof TimeseriesStoreConfig, v: number): void => {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`TimeseriesStoreConfig.${name} must be an integer ≥ 1 (got ${v})`);
    }
  };
  check('l1Capacity', cfg.l1Capacity);
  check('l2Capacity', cfg.l2Capacity);
  check('l2Stride', cfg.l2Stride);
  check('maxNames', cfg.maxNames);
}

export class TimeseriesStore {
  private readonly cfg: TimeseriesStoreConfig;
  private readonly byName = new Map<string, PerName>();

  constructor(cfg: TimeseriesStoreConfig) {
    validateConfig(cfg);
    this.cfg = cfg;
  }

  /**
   * Append `(t, value)` to the named series. If the name is new and
   * `maxNames` is exceeded, drops the oldest-inserted name (Map
   * iteration order is insertion order).
   */
  append(name: string, t: number, value: number): void {
    let entry = this.byName.get(name);
    if (!entry) {
      if (this.byName.size >= this.cfg.maxNames) {
        const oldest = this.byName.keys().next().value;
        if (oldest !== undefined) this.byName.delete(oldest);
      }
      entry = this.makeEntry();
      this.byName.set(name, entry);
    }

    if (entry.l1Count === this.cfg.l1Capacity) {
      const evictIdx = entry.l1Head;
      this.feedAccum(entry, entry.l1Times[evictIdx], entry.l1Values[evictIdx]);
    }
    const writeIdx = (entry.l1Head + entry.l1Count) % this.cfg.l1Capacity;
    entry.l1Times[writeIdx] = t;
    entry.l1Values[writeIdx] = value;
    if (entry.l1Count === this.cfg.l1Capacity) {
      entry.l1Head = (entry.l1Head + 1) % this.cfg.l1Capacity;
    } else {
      entry.l1Count += 1;
    }
  }

  /**
   * Snapshot the named series in chronological order. Unknown names
   * return empty arrays rather than throwing — the caller (dashboard)
   * typically polls before any samples exist.
   */
  query(name: string): TimeseriesQuery {
    const entry = this.byName.get(name);
    if (!entry) {
      return { l1Times: EMPTY_F32, l1Values: EMPTY_F32, l2Times: EMPTY_F32, l2Values: EMPTY_F32 };
    }
    return {
      l1Times: flatten(entry.l1Times, entry.l1Head, entry.l1Count, this.cfg.l1Capacity),
      l1Values: flatten(entry.l1Values, entry.l1Head, entry.l1Count, this.cfg.l1Capacity),
      l2Times: flatten(entry.l2Times, entry.l2Head, entry.l2Count, this.cfg.l2Capacity),
      l2Values: flatten(entry.l2Values, entry.l2Head, entry.l2Count, this.cfg.l2Capacity),
    };
  }

  names(): string[] {
    return Array.from(this.byName.keys());
  }

  private makeEntry(): PerName {
    return {
      l1Times: new Float32Array(this.cfg.l1Capacity),
      l1Values: new Float32Array(this.cfg.l1Capacity),
      l1Head: 0,
      l1Count: 0,
      l2Times: new Float32Array(this.cfg.l2Capacity),
      l2Values: new Float32Array(this.cfg.l2Capacity),
      l2Head: 0,
      l2Count: 0,
      accumSum: 0,
      accumCount: 0,
      accumFirstT: 0,
      accumLastT: 0,
    };
  }

  private feedAccum(entry: PerName, t: number, value: number): void {
    if (entry.accumCount === 0) entry.accumFirstT = t;
    entry.accumLastT = t;
    entry.accumSum += value;
    entry.accumCount += 1;
    if (entry.accumCount >= this.cfg.l2Stride) {
      const mean = entry.accumSum / entry.accumCount;
      const mid = (entry.accumFirstT + entry.accumLastT) / 2;
      this.pushL2(entry, mid, mean);
      entry.accumSum = 0;
      entry.accumCount = 0;
    }
  }

  private pushL2(entry: PerName, t: number, value: number): void {
    const writeIdx = (entry.l2Head + entry.l2Count) % this.cfg.l2Capacity;
    entry.l2Times[writeIdx] = t;
    entry.l2Values[writeIdx] = value;
    if (entry.l2Count === this.cfg.l2Capacity) {
      entry.l2Head = (entry.l2Head + 1) % this.cfg.l2Capacity;
    } else {
      entry.l2Count += 1;
    }
  }
}

function flatten(src: Float32Array, head: number, count: number, cap: number): Float32Array {
  if (count === 0) return EMPTY_F32;
  const out = new Float32Array(count);
  if (head + count <= cap) {
    out.set(src.subarray(head, head + count));
  } else {
    const first = cap - head;
    out.set(src.subarray(head, cap), 0);
    out.set(src.subarray(0, count - first), first);
  }
  return out;
}
