/** Bounded whole-session min/max envelope. Coarsening never drops extrema. */
export const OVERVIEW_BUCKETS = 512;

export interface TraceEnvelope {
  frames: number[];
  values: (number | null)[];
  bucketFrames: number;
}

export class TraceOverviewHistory {
  private width = 8;
  private readonly low = new Float32Array(OVERVIEW_BUCKETS).fill(Infinity);
  private readonly high = new Float32Array(OVERVIEW_BUCKETS).fill(-Infinity);
  private readonly lowFrame = new Float64Array(OVERVIEW_BUCKETS);
  private readonly highFrame = new Float64Array(OVERVIEW_BUCKETS);
  private end = 0;

  /** Fixed typed-array storage per tracked cell. */
  readonly bytes = OVERVIEW_BUCKETS * 24;

  push(frame: number, value: number): void {
    while (frame >= this.width * OVERVIEW_BUCKETS) this.coarsen();
    this.end = Math.max(this.end, frame + 1);
    if (!Number.isFinite(value)) return;
    const b = Math.floor(frame / this.width);
    if (value <= this.low[b]) {
      this.low[b] = value;
      this.lowFrame[b] = frame;
    }
    if (value > this.high[b]) {
      this.high[b] = value;
      this.highFrame[b] = frame;
    }
  }

  private coarsen(): void {
    for (let b = 0; b < OVERVIEW_BUCKETS / 2; b++) {
      const a = 2 * b;
      const lo = this.low[a] < this.low[a + 1] ? a : a + 1;
      const hi = this.high[a] >= this.high[a + 1] ? a : a + 1;
      this.low[b] = this.low[lo];
      this.lowFrame[b] = this.lowFrame[lo];
      this.high[b] = this.high[hi];
      this.highFrame[b] = this.highFrame[hi];
    }
    this.low.fill(Infinity, OVERVIEW_BUCKETS / 2);
    this.high.fill(-Infinity, OVERVIEW_BUCKETS / 2);
    this.width *= 2;
  }

  get(): TraceEnvelope {
    const frames: number[] = [];
    const values: (number | null)[] = [];
    const n = Math.min(OVERVIEW_BUCKETS, Math.ceil(this.end / this.width));
    for (let b = 0; b < n; b++) {
      if (!Number.isFinite(this.low[b])) {
        frames.push(b * this.width);
        values.push(null);
        continue;
      }
      const lo = this.lowFrame[b];
      const hi = this.highFrame[b];
      frames.push(Math.min(lo, hi), Math.max(lo, hi));
      values.push(lo <= hi ? this.low[b] : this.high[b], lo <= hi ? this.high[b] : this.low[b]);
    }
    return { frames, values, bucketFrames: this.width };
  }
}
