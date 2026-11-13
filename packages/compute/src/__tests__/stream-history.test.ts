import { describe, it, expect } from 'vitest';
import { StreamHistory } from '../stream-history.ts';
import type { SeriesKind, RangeRule, SeriesSpec } from '../stream-history.ts';

function spec(
  key: string,
  kind: SeriesKind = 'value',
  range: [number, number] = [0, 1],
  rangeRule: RangeRule = 'ladder125',
): SeriesSpec {
  return {
    key,
    label: key,
    unit: '',
    group: 'g',
    kind,
    range,
    rangeRule,
    color: '#000',
    digits: 1,
  };
}

describe('memory bound', () => {
  it('29 series over 5 days stay under 10 MB with 5 levels', () => {
    const h = new StreamHistory();
    const keys: string[] = [];
    for (let i = 0; i < 29; i++) {
      const k = `s${i}`;
      keys.push(k);
      h.define(spec(k, i < 2 ? 'band' : 'value', [-1e6, 1e6]));
    }
    const days5 = 5 * 86400;
    const t0 = performance.now();
    for (let t = 0; t < days5; t += 0.5) {
      for (let i = 0; i < 29; i++) {
        const v = Math.sin(t / 100 + i);
        if (i < 2) h.push(keys[i], t, v, [v - 1, v + 1]);
        else if (i < 7 || t % 1 === 0) h.push(keys[i], t, v);
      }
    }
    const ms = performance.now() - t0;
    console.log(
      `5 days: bytes=${h.bytes()} (${(h.bytes() / 1e6).toFixed(2)} MB), ${ms.toFixed(0)} ms`,
    );
    expect(h.bytes()).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(h.levels().length).toBe(5);
    expect(h.levels().map((l) => l.k)).toEqual([0, 1, 2, 3, 4]);
  }, 60000);

  it('per-frame series at 30 fps in 30-frame batches', () => {
    const h = new StreamHistory();
    h.define(spec('motion', 'value', [-10, 10]));
    const batch = new Float32Array(30).fill(0.5);
    for (let f = 0; f < 30 * 3600; f += 30) h.pushFrames('motion', f, batch, 30);
    expect(h.end()).toBeCloseTo(3600 - 1 / 30, 3);
    expect(h.levels().length).toBe(1);
    expect(h.at('motion', 100)!.count).toBe(30);
  });
});

describe('extrema survive coarsening', () => {
  const build = () => {
    const h = new StreamHistory();
    h.define(spec('a', 'value', [-1000, 1000]));
    const days = 3 * 86400;
    for (let t = 0; t < days; t++) {
      let v = Math.sin(t / 50);
      if (t === 86400) v = 500;
      if (t === 86400 + 5000) v = -400;
      h.push('a', t, v);
    }
    return h;
  };
  it('a one-sample spike and dip at day 1 reach the top level', () => {
    const h = build();
    const top = h.levels().length - 1;
    expect(top).toBeGreaterThanOrEqual(3);
    const v = h.view('a', 0, h.end(), 600)!;
    expect(v.level).toBe(top);
    expect(Math.max(...Array.from(v.max).filter((x) => !Number.isNaN(x)))).toBe(500);
    expect(Math.min(...Array.from(v.min).filter((x) => !Number.isNaN(x)))).toBe(-400);
  });
});

describe('view', () => {
  it('picks the covering level, <= maxBins, and is O(maxBins)', () => {
    const h = new StreamHistory();
    h.define(spec('a', 'value', [-2, 2]));
    const end = 5 * 86400;
    for (let t = 0; t < end; t += 1) h.push('a', t, Math.sin(t / 77));
    h.advance(end);
    const recent = h.view('a', end - 300, end, 600)!;
    expect(recent.level).toBe(0);
    expect(recent.n).toBeLessThanOrEqual(600);
    const old = h.view('a', 86400, 86400 + 600, 600)!;
    expect(old.level).toBeGreaterThan(0);
    expect(old.n).toBeLessThanOrEqual(600);
    const full = h.view('a', 0, end, 600)!;
    expect(full.n).toBeLessThanOrEqual(600);
    expect(full.level).toBe(h.levels().length - 1);
    const t0 = performance.now();
    const N = 200;
    for (let i = 0; i < N; i++) h.view('a', 0, end, 600);
    const avg = (performance.now() - t0) / N;
    console.log(`view over 5 days, 600 bins: ${avg.toFixed(3)} ms avg`);
    expect(avg).toBeLessThan(2);
  }, 60000);

  it('aggregates onto the level grid and reports NaN for empty output bins', () => {
    const h = new StreamHistory();
    h.define(spec('a'));
    h.push('a', 0.5, 1);
    h.push('a', 3.5, 3);
    h.advance(10);
    const v = h.view('a', 0, 4, 2)!;
    expect(v.binS).toBe(2);
    expect(Array.from(v.max)).toEqual([1, 3]);
    expect(h.view('nope', 0, 1, 1)).toBeNull();
  });
});

describe('display ranges', () => {
  /** Push one sample and close its bin. */
  const spike = (h: StreamHistory, key: string, t: number, v: number) => {
    h.push(key, t, v);
    h.advance(t + 1);
  };
  it('ladder125 steps 10 -> 20 -> 50 symmetrically; never shrinks', () => {
    const h = new StreamHistory();
    h.define(spec('m', 'value', [-10, 10]));
    const steps: unknown[] = [];
    h.onRangeStep = (k, e) => steps.push([k, e]);
    spike(h, 'm', 1, 13);
    expect(h.displayRange('m')).toMatchObject({ lo: -20, hi: 20 });
    spike(h, 'm', 2, 5);
    expect(h.displayRange('m')).toMatchObject({ lo: -20, hi: 20 });
    spike(h, 'm', 3, -45);
    const r = h.displayRange('m');
    expect([r.lo, r.hi]).toEqual([-50, 50]);
    expect(r.expansions).toHaveLength(2);
    expect(r.expansions[0]).toEqual({ t: 1, from: [-10, 10], to: [-20, 20] });
    expect(r.initial).toEqual([-10, 10]);
    expect(steps).toHaveLength(2);
  });
  it("'double' and lo = 0 expand only hi", () => {
    const h = new StreamHistory();
    h.define(spec('d', 'value', [0, 20], 'double'));
    spike(h, 'd', 1, 35);
    expect(h.displayRange('d')).toMatchObject({ lo: 0, hi: 40 });
    spike(h, 'd', 2, -5);
    expect(h.displayRange('d')).toMatchObject({ lo: 0, hi: 40 });
  });
  it('asymmetric ranges expand the exceeded side', () => {
    const h = new StreamHistory();
    h.define(spec('a', 'value', [-2, 10]));
    spike(h, 'a', 1, -3);
    expect(h.displayRange('a')).toMatchObject({ lo: -5, hi: 10 });
  });
  it("'fixed' never changes and sets clipped", () => {
    const h = new StreamHistory();
    h.define(spec('f', 'value', [0, 1], 'fixed'));
    let calls = 0;
    h.onRangeStep = () => calls++;
    spike(h, 'f', 1, 3);
    const r = h.displayRange('f');
    expect([r.lo, r.hi, r.clipped, calls]).toEqual([0, 1, true, 0]);
  });
  it('ignores NaN/Infinity and does not step on an open bin', () => {
    const h = new StreamHistory();
    h.define(spec('m', 'value', [-10, 10]));
    h.push('m', 1, NaN);
    h.push('m', 1.1, Infinity);
    h.push('m', 1.2, 50);
    expect(h.displayRange('m').hi).toBe(10);
    expect(h.at('m', 1.2)!.count).toBe(1);
    h.advance(3);
    expect(h.displayRange('m').hi).toBe(50);
  });
});

describe('bin math', () => {
  it('count-weighted means cascade across levels', () => {
    const h = new StreamHistory({ binsPerLevel: 8, factor: 2, maxLevels: 4 });
    h.define(spec('a', 'value', [0, 100]));
    // 9 s: L1 exists. Bin 0 holds 3 samples (mean 2), bin 1 holds 1 sample (10).
    h.push('a', 0.1, 1);
    h.push('a', 0.2, 2);
    h.push('a', 0.3, 3);
    h.push('a', 1.5, 10);
    for (let t = 2; t < 10; t++) h.push('a', t, 0);
    expect(h.levels().length).toBeGreaterThan(1);
    const v = h.view('a', 0, 2, 1)!;
    expect(v.mean[0]).toBeCloseTo((1 + 2 + 3 + 10) / 4, 5);
    expect(v.max[0]).toBe(10);
    expect(v.min[0]).toBe(1);
    expect(v.last[0]).toBe(10);
  });
  it('rate: per-minute rate, 0 for empty bins, mean = true mean rate', () => {
    const h = new StreamHistory();
    h.define(spec('r', 'rate', [0, 50]));
    expect(h.latest('r')).toBeNaN();
    h.push('r', 0.2, 1);
    h.push('r', 0.7, 2);
    expect(h.at('r', 0.5)!.mean).toBe(180);
    h.advance(4);
    expect(h.latest('r')).toBe(0);
    expect(h.at('r', 0.5)!.mean).toBe(180);
    expect(h.at('r', 1.5)!.mean).toBe(0);
    expect(h.at('r', 2.5)!.max).toBe(0);
    const v = h.view('r', 0, 4, 1)!;
    expect(v.max[0]).toBe(180);
    expect(v.mean[0]).toBeCloseTo(180 / 4, 4);
  });
  it('band lo/hi are kept; at() returns the finest bin; advance() makes empty bins', () => {
    const h = new StreamHistory();
    h.define(spec('b', 'band', [0, 10]));
    h.define(spec('v'));
    h.push('b', 0.5, 4, [3, 6]);
    h.push('v', 0.5, 1);
    h.advance(5);
    const bin = h.at('b', 0.5)!;
    expect([bin.level, bin.lo, bin.hi, bin.last]).toEqual([0, 3, 6, 4]);
    const empty = h.at('v', 3.5)!;
    expect(empty.count).toBe(0);
    expect(empty.min).toBeNaN();
    expect(h.view('b', 0, 2, 2)!.hi![0]).toBe(6);
    expect(h.latest('v')).toBe(1);
  });
  it('late samples merge into the open bin; closed bins are not rewritten', () => {
    const h = new StreamHistory();
    h.define(spec('a'));
    h.push('a', 0.5, 1);
    h.push('a', 5.5, 2);
    h.push('a', 0.6, 9);
    expect(h.at('a', 0.5)!.max).toBe(1);
    expect(h.at('a', 5.5)!.max).toBe(9);
  });
  it('pushFrames scales and places samples at frame / fps', () => {
    const h = new StreamHistory();
    h.define(spec('p'));
    h.pushFrames('p', 60, [1, 2, 3, 4], 30, 2);
    expect(h.at('p', 2.0)!.max).toBe(8);
    expect(h.at('p', 2.0)!.min).toBe(2);
  });
  it('version bumps on closes; has/specs/duplicate define', () => {
    const h = new StreamHistory();
    h.define(spec('a'));
    expect(() => h.define(spec('a'))).toThrow();
    expect(h.has('a')).toBe(true);
    const v0 = h.version();
    h.advance(2);
    expect(h.version()).toBeGreaterThan(v0);
    expect(h.specs()).toHaveLength(1);
  });
  it('toExport shapes and meta', () => {
    const h = new StreamHistory();
    h.define(spec('a'));
    h.define(spec('b', 'band'));
    h.push('a', 0.5, 1);
    h.push('b', 1.5, 2, [1, 3]);
    h.advance(3);
    const ex = h.toExport();
    expect(ex.levels).toHaveLength(1);
    expect(ex.levels[0].n).toBe(4);
    expect(ex.levels[0].data.length).toBe(2 * 4 * 4);
    expect(ex.bands![0].data.length).toBe(1 * 4 * 2);
    expect(ex.bands![0].data[(0 * 4 + 1) * 2 + 1]).toBe(3);
    expect(ex.levels[0].data[0 * 4 + 1]).toBe(1);
    const meta = ex.meta as {
      series: { key: string; band_index: number | null }[];
      levels: unknown[];
      time_base: string;
    };
    expect(meta.series.map((s) => s.band_index)).toEqual([null, 0]);
    expect(meta.levels).toHaveLength(1);
    expect(meta.time_base).toContain('stream seconds');
  });
});

describe('top-level coarsening', () => {
  it('keeps memory constant and extrema with small options', () => {
    const h = new StreamHistory({ binsPerLevel: 16, maxLevels: 3, chunk: 4 });
    h.define(spec('a', 'value', [-1000, 1000]));
    h.define(spec('b', 'band', [-1000, 1000]));
    const feed = (from: number, to: number) => {
      for (let t = from; t < to; t++) {
        let v = Math.sin(t);
        if (t === 100) v = 77;
        if (t === 150) v = -66;
        h.push('a', t, v);
        h.push('b', t, v, [v - 1, v + 1]);
      }
    };
    feed(0, 1000);
    const b1 = h.bytes();
    expect(h.levels()).toHaveLength(3);
    feed(1000, 20000);
    expect(h.bytes()).toBe(b1);
    const top = h.levels()[2];
    expect(top.binS).toBeGreaterThan(16);
    const v = h.view('a', 0, h.end(), 16)!;
    expect(Math.max(...Array.from(v.max).filter((x) => !Number.isNaN(x)))).toBe(77);
    expect(Math.min(...Array.from(v.min).filter((x) => !Number.isNaN(x)))).toBe(-66);
    expect(top.t0).toBe(0);
    expect(h.view('b', 0, h.end(), 16)!.lo).toBeDefined();
  });
});

describe('fromExport', () => {
  it('reads back what toExport wrote, across levels, bands and range steps', () => {
    const h = new StreamHistory({ binsPerLevel: 16, factor: 4, chunk: 4 });
    h.define(spec('a', 'value', [0, 1]));
    h.define(spec('b', 'band', [-10, 10]));
    for (let t = 0; t < 100; t++) {
      h.push('a', t + 0.5, t === 50 ? 7 : Math.sin(t) * 0.5 + 0.5);
      h.push('b', t + 0.5, t % 5, [(t % 5) - 1, (t % 5) + 1]);
    }
    h.advance(100);
    const ex = h.toExport();
    const back = StreamHistory.fromExport(ex, [spec('a', 'value', [0, 1]), spec('c')], 100);
    expect(back.levels()).toEqual(h.levels());
    expect(back.displayRange('a')).toMatchObject({ lo: h.displayRange('a').lo, hi: 10 });
    expect(back.displayRange('a').expansions).toHaveLength(1);
    expect(back.end()).toBe(100);
    const v0 = h.view('a', 0, 100, 50)!;
    const v1 = back.view('a', 0, 100, 50)!;
    expect(Array.from(v1.max)).toEqual(Array.from(v0.max));
    expect(Array.from(back.view('b', 0, 100, 200)!.hi!)).toEqual(
      Array.from(h.view('b', 0, 100, 200)!.hi!),
    );
    // A spec the export lacks is defined, empty; a saved series keeps its key.
    expect(back.has('c')).toBe(true);
    expect(back.specs().map((s) => s.key)).toEqual(['a', 'b', 'c']);
    // Round trip again: the same bins for the saved series (c, empty, follows them).
    const ex2 = back.toExport();
    const saved = ex.levels[1].data.length;
    expect(Array.from(ex2.levels[1].data.subarray(0, saved))).toEqual(
      Array.from(ex.levels[1].data),
    );
  });
});
