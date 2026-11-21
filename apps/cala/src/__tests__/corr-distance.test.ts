import { describe, expect, it } from 'vitest';
import {
  binOf,
  binStats,
  computeCorrDistance,
  highPass,
  quantile,
  selectPairs,
  selectScatter,
  somaDiameter,
} from '../lib/corr-distance.ts';
import { corrYRange } from '../components/CorrDistancePanel.tsx';

describe('highPass', () => {
  it('removes a constant and keeps a fast oscillation', () => {
    const x = Float64Array.from({ length: 400 }, (_, i) => 5 + (i % 2 ? 1 : -1));
    const out = highPass(x, 10, new Float64Array(400));
    for (let i = 20; i < 380; i++) expect(Math.abs(out[i] - (i % 2 ? 1 : -1))).toBeLessThan(0.25);
  });
  it('matches the direct centred moving average with nearest edges', () => {
    const x = Float64Array.from({ length: 30 }, (_, i) => Math.sin(i) * i);
    const w = 6;
    const out = highPass(x, w, new Float64Array(30));
    for (let i = 0; i < 30; i++) {
      let s = 0;
      for (let k = i - w / 2; k < i - w / 2 + w; k++) s += x[Math.min(29, Math.max(0, k))];
      expect(out[i]).toBeCloseTo(x[i] - s / w, 10);
    }
  });
});

describe('bins and quantiles', () => {
  it('puts distances in the 8 bins', () => {
    expect([0, 0.49, 0.5, 0.99, 1.0, 1.49, 1.5, 2.99, 3, 10].map(binOf)).toEqual([
      0, 0, 1, 2, 3, 4, 5, 6, 7, 7,
    ]);
  });
  it('interpolates quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
  });
  it('gives median and IQR per bin and the 1.5-3 D far median', () => {
    const dist = [0.2, 0.2, 0.2, 1.6, 2.5, 2.6, 5];
    const r = [0.1, 0.3, 0.5, 0.0, 0.1, 0.3, 0.9];
    const { bins, farMedian } = binStats(dist, r);
    expect(bins[0].median).toBeCloseTo(0.3);
    expect(bins[0].q25).toBeCloseTo(0.2);
    expect(bins[0].q75).toBeCloseTo(0.4);
    expect(bins[1].median).toBeNull();
    expect(bins[7].n).toBe(1);
    expect(farMedian).toBeCloseTo(0.1);
  });
});

describe('selectPairs', () => {
  // 20 cells on a line, 1 D apart (D = 10 px).
  const centers = new Float32Array(40);
  for (let i = 0; i < 20; i++) centers[2 * i + 1] = i * 10;
  it('keeps every pair within 6 D and nothing farther', () => {
    const p = selectPairs(centers, 20, 10);
    let within = 0;
    for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) if (j - i < 6) within++;
    expect(p.total).toBe(within);
    expect(p.kept).toBe(within);
    expect(p.dist.length).toBe(within);
    for (let k = 0; k < p.kept; k++) expect(p.dist[k]).toBeLessThan(6);
  });
  it('thins uniformly across the whole range when over the cap', () => {
    const p = selectPairs(centers, 20, 10, 40, 7);
    expect(p.kept).toBeGreaterThan(15);
    expect(p.kept).toBeLessThan(70);
    expect(p.total).toBeGreaterThan(p.kept);
  });
  it('is reproducible and has no duplicate pairs', () => {
    const a = selectPairs(centers, 20, 10, 50, 3);
    const b = selectPairs(centers, 20, 10, 50, 3);
    expect([...a.a]).toEqual([...b.a]);
    const keys = new Set([...a.a].map((v, k) => v * 100 + a.b[k]));
    expect(keys.size).toBe(a.a.length);
  });
  it('takes all pairs when under the cap', () => {
    const p = selectPairs(centers, 20, 10, 1000);
    expect(p.kept).toBe(p.total);
  });
});

describe('somaDiameter', () => {
  it('is the equivalent diameter of the half-max area', () => {
    // one cell: 4 pixels at 1.0, 4 at 0.2 -> area 4 -> d = 2 sqrt(4/pi)
    const lib = {
      ids: new Uint32Array([1]),
      starts: new Uint32Array([0, 8]),
      values: new Float32Array([1, 1, 1, 1, 0.2, 0.2, 0.2, 0.2]),
    };
    expect(somaDiameter(lib)).toBeCloseTo(2 * Math.sqrt(4 / Math.PI), 6);
  });
});

describe('computeCorrDistance', () => {
  it('finds excess r for close cells that share a signal, none far away', () => {
    const frames = 3000;
    const fps = 20; // window 300
    const cells = 6;
    let s = 12345;
    const noise = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296 - 0.5;
    };
    const shared = Float32Array.from({ length: frames }, () => noise());
    const traces = new Float32Array(cells * frames);
    for (let c = 0; c < cells; c++)
      for (let t = 0; t < frames; t++)
        // cells 0 and 1 share half their variance; a slow drift is common to all
        traces[c * frames + t] =
          noise() + (c < 2 ? shared[t] : 0) + 5 * Math.sin((2 * Math.PI * t) / 2900);
    const centers = new Float32Array(2 * cells);
    // cells 0,1 at 0.4 D; the others are far apart
    const xs = [0, 4, 40, 80, 120, 160];
    xs.forEach((v, i) => (centers[2 * i + 1] = v));
    const res = computeCorrDistance({ traces, cells, frames, fps, centers, diameter: 10 });
    expect(res.cells).toBe(6);
    expect(res.bins[0].n).toBe(1);
    expect(res.bins[7].n).toBe(5);
    expect(res.bins[0].median!).toBeGreaterThan(0.4);
    // the shared slow drift is removed by the high-pass: the 3-6 D pairs sit near 0
    expect(Math.abs(res.bins[7].median!)).toBeLessThan(0.1);
    expect(res.pairsKept).toBe(6);
  });
  it('skips short and flat cells and treats NaN frames as missing', () => {
    const frames = 1500;
    const traces = new Float32Array(3 * frames);
    for (let t = 0; t < frames; t++) {
      traces[t] = Math.sin(t / 7);
      traces[frames + t] = 3; // flat
      traces[2 * frames + t] = t < 1400 ? NaN : Math.sin(t / 5); // too short
    }
    const res = computeCorrDistance({
      traces,
      cells: 3,
      frames,
      fps: 20,
      centers: new Float32Array(6),
      diameter: 10,
    });
    expect(res.cells).toBe(1);
    expect(res.skipped).toBe(2);
    expect(res.bins.every((b) => b.n === 0)).toBe(true);
  });
});

describe('corrYRange', () => {
  const mk = (q25: number, q75: number) => ({
    farMedian: 0,
    bins: [{ label: 'a', lo: 0, hi: 1, n: 3, medianDist: 0.5, median: 0, q25, q75 }],
  });
  it('is fixed at -0.1..0.5 for ordinary data', () => {
    expect(corrYRange(mk(-0.05, 0.4))).toEqual([-0.1, 0.5]);
  });
  it('grows in steps of 0.1 only when the data needs it', () => {
    expect(corrYRange(mk(-0.23, 0.62))).toEqual([-0.3, 0.7]);
  });
});

describe('scatter', () => {
  it('returns per-pair typed arrays and bin positions', () => {
    const res = computeCorrDistance({
      traces: new Float32Array(3 * 600).map((_, i) => Math.sin(i * 0.3) + ((i * 7919) % 13)),
      cells: 3,
      frames: 600,
      fps: 1,
      centers: [0, 0, 0, 1, 0, 50],
      diameter: 1,
    });
    expect(res.pairDist).toBeInstanceOf(Float32Array);
    expect(res.pairR).toBeInstanceOf(Float32Array);
    expect(res.pairDist.length).toBe(res.pairsKept);
    expect(res.pairsKept).toBe(1);
    expect(res.bins[3].medianDist!).toBeCloseTo(1);
    expect(res.bins[1].medianDist).toBeNull();
  });
  it('keeps points in range and counts the rest', () => {
    const dist = Float32Array.from([0.2, 1, 2.9, 3.5, 4, 5, 7, 8]);
    const r = Float32Array.from([0.1, 0.9, 0.2, 0.3, -0.5, 0.1, 0.1, 0.1]);
    const all = selectScatter({ pairDist: dist, pairR: r }, 6, [-0.1, 0.5]);
    expect(Array.from(all.idx)).toEqual([0, 2, 3, 5]);
    expect(all.offY).toBe(2);
    expect(all.offX).toBe(2);
  });
});
