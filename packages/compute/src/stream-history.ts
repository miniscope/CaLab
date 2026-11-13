/**
 * StreamHistory: bounded, multi-resolution history of scalar series against
 * stream time (CONTRACT STUB: the implementation replaces the bodies; the
 * exported types and signatures are the contract HistoryPlot and the app use).
 *
 * Time is stream time in seconds (`t = frame / fps`), never wall time.
 * Level k holds bins of `baseBinS * factor^k` seconds; each bin keeps
 * min, max, mean and last (Float32; NaN = empty), plus lo/hi for band series.
 * Closed bins cascade into the next level (min of mins, max of maxes,
 * count-weighted mean, last of lasts) so extrema survive every level. Levels
 * are created lazily; the top level never wraps and always covers the whole
 * run; at `maxLevels` the top level coarsens in place in pairs.
 *
 * Display ranges are declared per series and never come from the data. A
 * closed L0 bin outside the range steps it up once along its rule; ranges
 * never shrink.
 */

export type SeriesKind = 'value' | 'band' | 'step' | 'rate' | 'stem';
export type RangeRule = 'fixed' | 'ladder125' | 'double';

export interface SeriesSpec {
  /** Unique key, snake_case (also the export key). */
  key: string;
  /** Full name (tooltips, export). */
  label: string;
  /** Short chip name (default: label). */
  short?: string;
  /** Unit as displayed ('' for none), e.g. 'px', 'µm', '%', 'grey', 'fps', 's', '/min'. */
  unit: string;
  /** Group id, e.g. 'convergence', 'scales', 'imaging', 'motion', 'throughput'. */
  group: string;
  kind: SeriesKind;
  /** Initial display range, from physics or biology, never from data. */
  range: [number, number];
  rangeRule: RangeRule;
  /** CSS colour (Okabe-Ito). */
  color: string;
  /** Canvas line dash, e.g. [3, 2]. */
  dash?: number[];
  /** Decimal digits of displayed values. */
  digits: number;
  /** One-line description for the chip tooltip. */
  hint?: string;
}

export interface StreamHistoryOptions {
  /** Width of a level-0 bin, stream seconds (default 1). */
  baseBinS?: number;
  /** Bins per level ring (default 4096). */
  binsPerLevel?: number;
  /** Bin width ratio between levels (default 4). */
  factor?: number;
  /** Levels before the top one coarsens in place (default 7). */
  maxLevels?: number;
  /** Ring allocation chunk, bins (default 512). */
  chunk?: number;
}

/** Bins of one series over a window, aggregated to at most `maxBins`. NaN = no data. */
export interface BinView {
  /** Stream time of the start of output bin 0, s. */
  t0: number;
  /** Width of each output bin, s. */
  binS: number;
  /** Level the bins were read from. */
  level: number;
  /** Width of that level's bins, s. */
  levelBinS: number;
  n: number;
  min: Float32Array;
  max: Float32Array;
  mean: Float32Array;
  last: Float32Array;
  /** Band series only: lo/hi of the last sample in each bin. */
  lo?: Float32Array;
  hi?: Float32Array;
}

/** The finest bin that holds a time. */
export interface BinValue {
  t0: number;
  binS: number;
  level: number;
  min: number;
  max: number;
  mean: number;
  last: number;
  lo?: number;
  hi?: number;
  /** Samples merged into the bin. */
  count: number;
}

export interface RangeExpansion {
  /** Stream time of the closed bin that stepped the range, s. */
  t: number;
  from: [number, number];
  to: [number, number];
}

export interface DisplayRange {
  lo: number;
  hi: number;
  initial: [number, number];
  expansions: readonly RangeExpansion[];
  /** A 'fixed' range saw a value outside it (the value is clipped when drawn, never rescaled). */
  clipped: boolean;
}

export interface LevelInfo {
  k: number;
  binS: number;
  /** Stream time of the oldest bin held, s. */
  t0: number;
  /** Bins held (closed plus the open one). */
  n: number;
}

/** Arrays for the `.npz` export (see the cala export docs). */
export interface HistoryExport {
  /** Per level k: float32 [S, n_k, 4] (min, max, mean, last), row-major. */
  levels: { k: number; binS: number; t0: number; n: number; data: Float32Array }[];
  /** Per level k: float32 [S_band, n_k, 2] (lo, hi) of the band series, or null when none. */
  bands: { k: number; data: Float32Array }[] | null;
  /** JSON-able layout description (`meta_json.history`). */
  meta: Record<string, unknown>;
}

/** Per series, per level: chunk-allocated parallel arrays indexed by ring slot. */
interface Arr {
  cap: number;
  min: Float32Array;
  max: Float32Array;
  mean: Float32Array;
  last: Float32Array;
  /** Samples in the bin, saturating at 65535 (a weight for the mean only; keeps memory at 18 B/bin). */
  cnt: Uint16Array;
  lo?: Float32Array;
  hi?: Float32Array;
}
interface Ser {
  spec: SeriesSpec;
  idx: number;
  band: boolean;
  rate: boolean;
  lv: Arr[];
  /** Running count in the open L0 rate bin. */
  sum: number;
  latest: number;
  lastRate: number;
  range: {
    lo: number;
    hi: number;
    initial: [number, number];
    expansions: RangeExpansion[];
    clipped: boolean;
  };
}
/** Shared by all series: bin width and absolute index of the open bin (bins align to t = 0). */
interface Lvl {
  binS: number;
  open: number;
}

const CNT_MAX = 65535;

/** Smallest 1/2/5 x 10^k that is >= need. */
function ladder125(need: number): number {
  if (!(need > 0)) return 1;
  const e = Math.floor(Math.log10(need));
  for (const m of [1, 2, 5, 10]) if (m * 10 ** e >= need) return m * 10 ** e;
  return 10 ** (e + 1);
}
/** Next limit that holds `need`: base x 2^n for 'double' (base > 0), else the 1/2/5 ladder. */
function nextLimit(need: number, base: number, rule: RangeRule): number {
  if (rule !== 'double' || !(base > 0)) return ladder125(need);
  let v = base;
  while (v < need) v *= 2;
  return v;
}

export class StreamHistory {
  /** Called once per range step (the app logs a 'range' event). */
  onRangeStep: ((key: string, e: RangeExpansion) => void) | null = null;
  private readonly baseBinS: number;
  private readonly B: number;
  private readonly factor: number;
  private readonly maxLevels: number;
  private readonly chunk: number;
  private lv: Lvl[];
  private ser: Ser[] = [];
  private byKey = new Map<string, Ser>();
  private endT = 0;
  private ver = 0;

  constructor(o: StreamHistoryOptions = {}) {
    this.baseBinS = o.baseBinS ?? 1;
    this.B = o.binsPerLevel ?? 4096;
    this.factor = o.factor ?? 4;
    this.maxLevels = Math.max(1, o.maxLevels ?? 7);
    this.chunk = Math.max(1, o.chunk ?? 512);
    if (this.factor < 2 || this.B % this.factor !== 0 || this.B % 2 !== 0)
      throw new Error('StreamHistory: binsPerLevel must be even and a multiple of factor (>= 2)');
    this.lv = [{ binS: this.baseBinS, open: 0 }];
  }

  /** Register a series (throws on a duplicate key). Late series start empty (rate: 0) over the held bins. */
  define(spec: SeriesSpec): void {
    if (this.byKey.has(spec.key)) throw new Error(`StreamHistory: duplicate series ${spec.key}`);
    const s: Ser = {
      spec,
      idx: this.ser.length,
      band: spec.kind === 'band',
      rate: spec.kind === 'rate',
      lv: [],
      sum: 0,
      latest: NaN,
      lastRate: NaN,
      range: {
        lo: spec.range[0],
        hi: spec.range[1],
        initial: [spec.range[0], spec.range[1]],
        expansions: [],
        clipped: false,
      },
    };
    this.ser.push(s);
    this.byKey.set(spec.key, s);
    this.lv.forEach((L, k) => {
      s.lv.push(this.newArr());
      for (let a = this.first(L); a <= L.open; a++) this.initSlot(s, k, a % this.B);
    });
  }
  has(key: string): boolean {
    return this.byKey.has(key);
  }
  spec(key: string): SeriesSpec | undefined {
    return this.byKey.get(key)?.spec;
  }
  specs(): readonly SeriesSpec[] {
    return this.ser.map((s) => s.spec);
  }

  /** One sample at stream time `t` (s). Band series pass [lo, hi]. Rate series pass a count. Unknown keys are ignored. */
  push(key: string, t: number, v: number, band?: [number, number]): void {
    const s = this.byKey.get(key);
    if (!s || !Number.isFinite(v) || !Number.isFinite(t)) return;
    this.sample(s, t, v, band);
    s.latest = v;
  }
  /** One sample per frame, frames `startFrame..` at `fps` (scaled by `scale`, default 1). */
  pushFrames(
    key: string,
    startFrame: number,
    values: ArrayLike<number>,
    fps: number,
    scale = 1,
  ): void {
    const s = this.byKey.get(key);
    if (!s) return;
    for (let i = 0; i < values.length; i++) {
      const v = values[i] * scale;
      if (!Number.isFinite(v)) continue;
      this.sample(s, (startFrame + i) / fps, v);
      s.latest = v;
    }
  }
  /** Close every open bin that ends at or before `t` (the stream advanced, e.g. to make empty bins). */
  advance(t: number): void {
    if (!Number.isFinite(t)) return;
    this.advanceTo(t);
    if (t > this.endT) this.endT = t;
  }

  /**
   * Bins of `key` over [t0, t1], at most `maxBins`; includes the open bin. Coarser levels lag the
   * newest data by at most one bin of the level below (closed bins cascade upward).
   */
  view(key: string, t0: number, t1: number, maxBins: number): BinView | null {
    const s = this.byKey.get(key);
    if (!s || !(t1 > t0) || maxBins < 1) return null;
    const lo0 = Math.max(0, t0);
    const need = (t1 - t0) / (4 * maxBins);
    let k = this.lv.length - 1;
    for (let j = 0; j < this.lv.length; j++) {
      const L = this.lv[j];
      if (L.binS >= need && this.first(L) * L.binS <= lo0) {
        k = j;
        break;
      }
    }
    const L = this.lv[k];
    const first = this.first(L);
    const a0 = Math.max(first, Math.floor(lo0 / L.binS));
    const a1 = Math.min(L.open, Math.max(a0, Math.ceil(t1 / L.binS) - 1));
    if (a0 > L.open) return null;
    let g = Math.ceil((a1 - a0 + 1) / maxBins);
    while (Math.ceil((a1 - Math.floor(a0 / g) * g + 1) / g) > maxBins) g++;
    const start = Math.floor(a0 / g) * g;
    const n = Math.ceil((a1 - start + 1) / g);
    const mk = () => new Float32Array(n).fill(NaN);
    const out: BinView = {
      t0: start * L.binS,
      binS: g * L.binS,
      level: k,
      levelBinS: L.binS,
      n,
      min: mk(),
      max: mk(),
      mean: mk(),
      last: mk(),
    };
    if (s.band) {
      out.lo = mk();
      out.hi = mk();
    }
    const A = s.lv[k];
    for (let j = 0; j < n; j++) {
      let mn = NaN,
        mx = NaN,
        sum = 0,
        w = 0,
        last = NaN,
        lo = NaN,
        hi = NaN;
      const b0 = Math.max(first, start + j * g);
      const b1 = Math.min(a1, start + (j + 1) * g - 1);
      for (let a = b0; a <= b1; a++) {
        const i = a % this.B;
        const c = A.cnt[i];
        if (!c) continue;
        if (!(A.min[i] >= mn)) mn = A.min[i];
        if (!(A.max[i] <= mx)) mx = A.max[i];
        sum += A.mean[i] * c;
        w += c;
        last = A.last[i];
        if (A.lo) {
          lo = A.lo[i];
          hi = A.hi![i];
        }
      }
      if (w > 0) {
        out.min[j] = mn;
        out.max[j] = mx;
        out.mean[j] = sum / w;
        out.last[j] = last;
        if (out.lo) {
          out.lo[j] = lo;
          out.hi![j] = hi;
        }
      }
    }
    return out;
  }
  /** The finest bin of `key` holding `t` (empty bins come back with NaN values and count 0), or null. */
  at(key: string, t: number): BinValue | null {
    const s = this.byKey.get(key);
    if (!s || !(t >= 0)) return null;
    for (let k = 0; k < this.lv.length; k++) {
      const L = this.lv[k];
      const a = Math.floor(t / L.binS);
      if (a < this.first(L) || a > L.open) continue;
      const A = s.lv[k];
      const i = a % this.B;
      const v: BinValue = {
        t0: a * L.binS,
        binS: L.binS,
        level: k,
        min: A.min[i],
        max: A.max[i],
        mean: A.mean[i],
        last: A.last[i],
        count: A.cnt[i],
      };
      if (A.lo) {
        v.lo = A.lo[i];
        v.hi = A.hi![i];
      }
      return v;
    }
    return null;
  }
  /** The newest sample of `key` (NaN when none). Rate: per-minute rate of the newest closed L0 bin. */
  latest(key: string): number {
    const s = this.byKey.get(key);
    return s ? (s.rate ? s.lastRate : s.latest) : NaN;
  }
  displayRange(key: string): DisplayRange {
    const s = this.byKey.get(key);
    if (!s) return { lo: 0, hi: 1, initial: [0, 1], expansions: [], clipped: false };
    const r = s.range;
    return { lo: r.lo, hi: r.hi, initial: r.initial, expansions: r.expansions, clipped: r.clipped };
  }
  /** Newest stream time pushed or advanced to, s (0 when empty). */
  end(): number {
    return this.endT;
  }
  /** Bumps whenever a bin closes (any level) or a range steps (cheap redraw check). */
  version(): number {
    return this.ver;
  }
  levels(): LevelInfo[] {
    return this.lv.map((L, k) => {
      const f = this.first(L);
      return { k, binS: L.binS, t0: f * L.binS, n: L.open - f + 1 };
    });
  }
  /** Bytes held by the typed arrays. */
  bytes(): number {
    let b = 0;
    for (const s of this.ser)
      for (const A of s.lv)
        b += A.min.byteLength * 4 + A.cnt.byteLength + (A.lo ? A.lo.byteLength * 2 : 0);
    return b;
  }

  toExport(): HistoryExport {
    const S = this.ser.length;
    const bandSer = this.ser.filter((s) => s.band);
    const levels: HistoryExport['levels'] = [];
    const bands: { k: number; data: Float32Array }[] = [];
    this.lv.forEach((L, k) => {
      const f = this.first(L);
      const n = L.open - f + 1;
      const data = new Float32Array(S * n * 4);
      const bd = new Float32Array(bandSer.length * n * 2);
      for (const s of this.ser) {
        const A = s.lv[k];
        const bi = s.band ? bandSer.indexOf(s) : -1;
        for (let j = 0; j < n; j++) {
          const i = (f + j) % this.B;
          const o = (s.idx * n + j) * 4;
          data[o] = A.min[i];
          data[o + 1] = A.max[i];
          data[o + 2] = A.mean[i];
          data[o + 3] = A.last[i];
          if (bi >= 0) {
            bd[(bi * n + j) * 2] = A.lo![i];
            bd[(bi * n + j) * 2 + 1] = A.hi![i];
          }
        }
      }
      levels.push({ k, binS: L.binS, t0: f * L.binS, n, data });
      if (bandSer.length) bands.push({ k, data: bd });
    });
    const meta = {
      time_base: 'stream seconds = frame / sampling_rate_hz',
      base_bin_s: this.baseBinS,
      factor: this.factor,
      bins_per_level: this.B,
      levels: levels.map((l) => ({ k: l.k, bin_s: l.binS, t0_s: l.t0, n: l.n })),
      series: this.ser.map((s) => ({
        key: s.spec.key,
        label: s.spec.label,
        unit: s.spec.unit,
        kind: s.spec.kind,
        group: s.spec.group,
        range_initial: s.range.initial,
        range_final: [s.range.lo, s.range.hi],
        band_index: s.band ? bandSer.indexOf(s) : null,
        expansions: s.range.expansions.map((e) => ({ t: e.t, from: e.from, to: e.to })),
      })),
    };
    return { levels, bands: bandSer.length ? bands : null, meta };
  }

  /**
   * A history read back from `toExport()` (a saved run). `specs` give the
   * series their display settings by key (series the export has but `specs`
   * lack get a plain grey line; specs the export lacks start empty). Bins come
   * back as they were saved, each counting as one sample (the export has no
   * counts), so a mean over several saved bins is unweighted. Ranges come back
   * as they ended, with their steps. `end` is the stream time the run reached
   * (default: the end of the newest saved level-0 bin).
   */
  static fromExport(
    exp: HistoryExport,
    specs: readonly SeriesSpec[] = [],
    end?: number,
  ): StreamHistory {
    const m = exp.meta as {
      base_bin_s?: number;
      factor?: number;
      bins_per_level?: number;
      series?: {
        key: string;
        label?: string;
        unit?: string;
        kind?: SeriesKind;
        group?: string;
        range_initial?: [number, number];
        range_final?: [number, number];
        expansions?: RangeExpansion[];
      }[];
    };
    const levels = [...exp.levels].sort((a, b) => a.k - b.k);
    const h = new StreamHistory({
      baseBinS: m.base_bin_s,
      binsPerLevel: m.bins_per_level,
      factor: m.factor,
      maxLevels: Math.max(7, levels.length),
    });
    const byKey = new Map(specs.map((s) => [s.key, s]));
    const saved = m.series ?? [];
    for (const x of saved) {
      const range: [number, number] = x.range_initial ?? [0, 1];
      h.define(
        byKey.get(x.key) ?? {
          key: x.key,
          label: x.label ?? x.key,
          unit: x.unit ?? '',
          group: x.group ?? 'other',
          kind: x.kind ?? 'value',
          range,
          rangeRule: 'fixed',
          color: '#888888',
          digits: 2,
        },
      );
    }
    if (levels.length > 0) {
      h.lv = levels.map((l) => ({
        binS: l.binS,
        open: Math.round(l.t0 / l.binS) + Math.max(1, l.n) - 1,
      }));
      const bandSer = h.ser.filter((s) => s.band);
      for (const s of h.ser) {
        s.lv = [];
        levels.forEach((l, k) => {
          const A = h.newArr();
          s.lv.push(A);
          const L = h.lv[k];
          for (let a = h.first(L); a <= L.open; a++) h.initSlot(s, k, a % h.B);
          const bi = s.band ? bandSer.indexOf(s) : -1;
          const band = exp.bands?.find((b) => b.k === l.k)?.data;
          const first = Math.round(l.t0 / l.binS);
          for (let j = 0; j < l.n; j++) {
            const i = (first + j) % h.B;
            const o = (s.idx * l.n + j) * 4;
            const mean = l.data[o + 2];
            A.min[i] = l.data[o];
            A.max[i] = l.data[o + 1];
            A.mean[i] = mean;
            A.last[i] = l.data[o + 3];
            A.cnt[i] = Number.isNaN(mean) ? 0 : 1;
            if (A.lo && band && bi >= 0) {
              A.lo[i] = band[(bi * l.n + j) * 2];
              A.hi![i] = band[(bi * l.n + j) * 2 + 1];
            }
          }
        });
        const L0 = h.lv[0];
        const A0 = s.lv[0];
        for (let a = L0.open; a >= h.first(L0); a--) {
          const v = A0.last[a % h.B];
          if (!Number.isNaN(v)) {
            s.latest = v;
            if (s.rate) s.lastRate = A0.mean[a % h.B];
            break;
          }
        }
      }
    }
    for (const x of saved) {
      const s = h.byKey.get(x.key)!;
      if (x.range_final) {
        s.range.lo = x.range_final[0];
        s.range.hi = x.range_final[1];
      }
      if (x.range_initial) s.range.initial = [x.range_initial[0], x.range_initial[1]];
      s.range.expansions = (x.expansions ?? []).map((e) => ({ t: e.t, from: e.from, to: e.to }));
    }
    for (const spec of specs) if (!h.has(spec.key)) h.define(spec);
    const L0 = h.lv[0];
    h.endT = end ?? (levels.length > 0 ? (L0.open + 1) * L0.binS : 0);
    h.ver++;
    return h;
  }

  // ---- internals ----

  /** Oldest absolute bin held at a level (rings drop the oldest; the top level only shrinks by coarsening). */
  private first(L: Lvl): number {
    return Math.max(0, L.open - this.B + 1);
  }
  private newArr(): Arr {
    return {
      cap: 0,
      min: new Float32Array(0),
      max: new Float32Array(0),
      mean: new Float32Array(0),
      last: new Float32Array(0),
      cnt: new Uint16Array(0),
    };
  }
  /** Grow to hold `slots` slots, rounded up to the chunk (never past B); new bins are empty (NaN). */
  private ensureCap(s: Ser, A: Arr, slots: number): void {
    if (slots <= A.cap) return;
    const cap = Math.min(this.B, Math.ceil(slots / this.chunk) * this.chunk);
    const grow = (a: Float32Array) => {
      const n = new Float32Array(cap).fill(NaN);
      n.set(a);
      return n;
    };
    A.min = grow(A.min);
    A.max = grow(A.max);
    A.mean = grow(A.mean);
    A.last = grow(A.last);
    const c = new Uint16Array(cap);
    c.set(A.cnt);
    A.cnt = c;
    if (s.band) {
      A.lo = grow(A.lo ?? new Float32Array(0));
      A.hi = grow(A.hi ?? new Float32Array(0));
    }
    A.cap = cap;
  }
  /** Make a slot empty (NaN); an L0 rate bin starts at 0 per minute with weight 1 (time passed, no events). */
  private initSlot(s: Ser, k: number, slot: number): void {
    const A = s.lv[k];
    this.ensureCap(s, A, slot + 1);
    const zero = k === 0 && s.rate;
    const v = zero ? 0 : NaN;
    A.min[slot] = A.max[slot] = A.mean[slot] = A.last[slot] = v;
    A.cnt[slot] = zero ? 1 : 0;
    if (A.lo) A.lo[slot] = A.hi![slot] = NaN;
    if (k === 0) s.sum = 0;
  }
  /** Fold bin (level k, slot sf) of series s into (level kt, slot st); kt === k merges within a level. */
  private merge(s: Ser, k: number, sf: number, kt: number, st: number): void {
    const f = s.lv[k],
      t = s.lv[kt];
    const c = f.cnt[sf];
    if (!c) return;
    const tc = t.cnt[st];
    if (!tc) {
      t.min[st] = f.min[sf];
      t.max[st] = f.max[sf];
      t.mean[st] = f.mean[sf];
      t.cnt[st] = c;
    } else {
      t.min[st] = Math.min(t.min[st], f.min[sf]);
      t.max[st] = Math.max(t.max[st], f.max[sf]);
      t.mean[st] = (t.mean[st] * tc + f.mean[sf] * c) / (tc + c);
      t.cnt[st] = Math.min(CNT_MAX, tc + c);
    }
    t.last[st] = f.last[sf];
    if (f.lo) {
      t.lo![st] = f.lo[sf];
      t.hi![st] = f.hi![sf];
    }
  }
  private sample(s: Ser, t: number, v: number, band?: [number, number]): void {
    if (t < 0) t = 0;
    const L0 = this.lv[0];
    if (t >= (L0.open + 1) * L0.binS) this.advanceTo(t);
    if (t > this.endT) this.endT = t;
    const A = s.lv[0];
    const i = L0.open % this.B;
    if (s.rate) {
      s.sum += v;
      A.min[i] = A.max[i] = A.mean[i] = A.last[i] = (s.sum * 60) / L0.binS;
      return;
    }
    const c = A.cnt[i];
    if (c === 0) {
      A.min[i] = A.max[i] = A.mean[i] = v;
    } else {
      if (v < A.min[i]) A.min[i] = v;
      if (v > A.max[i]) A.max[i] = v;
      A.mean[i] = (A.mean[i] * c + v) / (c + 1);
    }
    A.last[i] = v;
    if (c < CNT_MAX) A.cnt[i] = c + 1;
    if (band && A.lo) {
      A.lo[i] = band[0];
      A.hi![i] = band[1];
    }
  }
  private advanceTo(t: number): void {
    const target = Math.floor(t / this.lv[0].binS);
    while (this.lv[0].open < target) this.closeBin(0);
  }
  /** Close the open bin of level k for every series, cascade it upward and open the next one. */
  private closeBin(k: number): void {
    const L = this.lv[k];
    const a = L.open;
    const slot = a % this.B;
    const next = this.lv[k + 1];
    for (const s of this.ser) {
      if (k === 0) {
        if (s.rate) s.lastRate = s.lv[0].mean[slot];
        this.checkRange(s, slot, a * L.binS);
      }
      if (next) this.merge(s, k, slot, k + 1, next.open % this.B);
    }
    L.open = a + 1;
    this.ver++;
    if (!next && L.open >= this.B) {
      if (k + 1 < this.maxLevels) this.createLevel(k);
      else this.coarsen(k);
    }
    for (const s of this.ser) this.initSlot(s, k, L.open % this.B);
    if (next && (a + 1) % Math.round(next.binS / L.binS) === 0) this.closeBin(k + 1);
  }
  /** Level k just filled its ring: build k+1 from all its bins so the new top covers the whole run. */
  private createLevel(k: number): void {
    const L = this.lv[k];
    const N: Lvl = { binS: L.binS * this.factor, open: Math.floor(L.open / this.factor) };
    this.lv.push(N);
    for (const s of this.ser) {
      s.lv.push(this.newArr());
      for (let a = 0; a <= N.open; a++) this.initSlot(s, k + 1, a);
      for (let j = 0; j < L.open; j++) this.merge(s, k, j, k + 1, Math.floor(j / this.factor));
    }
  }
  /** The top level is full at the level cap: merge bins in pairs, doubling the bin width (constant memory). */
  private coarsen(k: number): void {
    const L = this.lv[k];
    const half = this.B / 2;
    for (const s of this.ser) {
      const A = s.lv[k];
      for (let i = 0; i < half; i++) {
        // Slot i <= 2i and i ascends, so the sources 2i, 2i+1 are never overwritten before being read.
        if (i !== 2 * i) {
          A.min[i] = A.min[2 * i];
          A.max[i] = A.max[2 * i];
          A.mean[i] = A.mean[2 * i];
          A.last[i] = A.last[2 * i];
          A.cnt[i] = A.cnt[2 * i];
          if (A.lo) {
            A.lo[i] = A.lo[2 * i];
            A.hi![i] = A.hi![2 * i];
          }
        }
        this.mergeSlots(A, 2 * i + 1, i);
      }
      for (let i = half; i < this.B; i++) this.initSlot(s, k, i);
    }
    L.binS *= 2;
    L.open = half;
  }
  private mergeSlots(A: Arr, sf: number, st: number): void {
    const c = A.cnt[sf];
    if (!c) return;
    const tc = A.cnt[st];
    if (!tc) {
      A.min[st] = A.min[sf];
      A.max[st] = A.max[sf];
      A.mean[st] = A.mean[sf];
      A.cnt[st] = c;
    } else {
      A.min[st] = Math.min(A.min[st], A.min[sf]);
      A.max[st] = Math.max(A.max[st], A.max[sf]);
      A.mean[st] = (A.mean[st] * tc + A.mean[sf] * c) / (tc + c);
      A.cnt[st] = Math.min(CNT_MAX, tc + c);
    }
    A.last[st] = A.last[sf];
    if (A.lo) {
      A.lo[st] = A.lo[sf];
      A.hi![st] = A.hi![sf];
    }
  }
  /** Step the display range once when a closed L0 bin leaves it (never shrinks; 'fixed' only flags clipping). */
  private checkRange(s: Ser, slot: number, t: number): void {
    const r = s.range;
    const mx = s.lv[0].max[slot],
      mn = s.lv[0].min[slot];
    const above = mx > r.hi,
      below = mn < r.lo;
    if (!above && !below) return;
    const rule = s.spec.rangeRule;
    if (rule === 'fixed') {
      r.clipped = true;
      return;
    }
    const [ilo, ihi] = r.initial;
    let lo = r.lo,
      hi = r.hi;
    if (ilo === -ihi && ihi > 0) {
      hi = nextLimit(Math.max(mx, -mn), ihi, rule);
      lo = -hi;
    } else {
      if (above) hi = nextLimit(mx, ihi, rule);
      if (below) {
        if (ilo < 0) lo = -nextLimit(-mn, -ilo, rule);
        else r.clipped = true;
      }
    }
    if (lo === r.lo && hi === r.hi) return;
    const e: RangeExpansion = { t, from: [r.lo, r.hi], to: [lo, hi] };
    r.lo = lo;
    r.hi = hi;
    r.expansions.push(e);
    this.ver++;
    this.onRangeStep?.(s.spec.key, e);
  }
}
