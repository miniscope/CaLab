// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CSETTLE,
  csettleRate,
  movedAgainstNoise,
  noiseMap,
  planFrames,
  SETTLE,
  SETTLE_POOL,
  settleChange,
  SettleFeed,
  settlePlan,
  settlePoolSize,
  stillMovingMap,
  stillMovingRatios,
  truncatePlan,
  unitFootprints,
  FINAL_SETTLE_LEVELS,
  finalSettleLevel,
  footprintChanges,
} from '../lib/settle.ts';

describe('settlePlan', () => {
  it('one pass over a recording up to the cap', () => {
    expect(settlePlan(0)).toEqual([]);
    expect(settlePlan(9600)).toEqual([{ start: 0, end: 9600 }]);
    expect(settlePlan(SETTLE.maxFrames)).toEqual([{ start: 0, end: SETTLE.maxFrames }]);
  });

  it('a longer recording: whole blocks spread evenly, about the cap in total', () => {
    const total = 23_700;
    const runs = settlePlan(total);
    const n = planFrames(runs);
    expect(Math.abs(n - SETTLE.maxFrames)).toBeLessThanOrEqual(SETTLE.block);
    // Blocks start on block boundaries, inside the recording, in order, not overlapping.
    let end = -1;
    for (const r of runs) {
      expect(r.start % SETTLE.block).toBe(0);
      expect(r.start).toBeGreaterThan(end);
      expect(r.end).toBeLessThanOrEqual(total);
      end = r.end;
    }
    // Spread over the whole recording: the first block at 0, the last in its final 2 %.
    expect(runs[0].start).toBe(0);
    expect(runs.at(-1)!.end).toBeGreaterThan(0.98 * total);
  });

  it('a days-long recording keeps the cap', () => {
    const runs = settlePlan(5_000_000);
    expect(planFrames(runs)).toBe(Math.round(SETTLE.maxFrames / SETTLE.block) * SETTLE.block);
    expect(runs.length).toBe(Math.round(SETTLE.maxFrames / SETTLE.block));
  });
});

describe('SettleFeed', () => {
  it('hands out the plan in requests, with a new block only at a gap', () => {
    const feed = new SettleFeed([
      { start: 0, end: 5 },
      { start: 64, end: 66 },
    ]);
    expect(feed.total).toBe(7);
    const a = feed.take(4);
    expect(a.map((f) => f.frame)).toEqual([0, 1, 2, 3]);
    expect(new Set(a.map((f) => f.block))).toEqual(new Set([-1]));
    expect(feed.taken).toBe(4);
    const b = feed.take(4);
    expect(b).toEqual([
      { frame: 4, block: -1 },
      { frame: 64, block: -2 },
      { frame: 65, block: -2 },
    ]);
    expect(feed.done).toBe(true);
    expect(feed.taken).toBe(7);
    expect(feed.take(4)).toEqual([]);
  });

  it('hands out frames put back (a failed request) again first, in their own block', () => {
    const feed = new SettleFeed([
      { start: 0, end: 5 },
      { start: 64, end: 66 },
    ]);
    const a = feed.take(3);
    feed.take(4);
    expect(feed.done).toBe(true);
    feed.putBack(a.map((f) => f.frame));
    expect(feed.done).toBe(false);
    expect(feed.taken).toBe(4);
    expect(feed.take(2)).toEqual([
      { frame: 0, block: -1 },
      { frame: 1, block: -1 },
    ]);
    feed.putBack([65]);
    expect(feed.take(4)).toEqual([
      { frame: 2, block: -1 },
      { frame: 65, block: -2 },
    ]);
    expect(feed.done).toBe(true);
    expect(feed.taken).toBe(7);
  });
});

describe('movedAgainstNoise', () => {
  const lib = (values: number[][]) => {
    const ids: number[] = [];
    const starts = [0];
    const pixels: number[] = [];
    const vals: number[] = [];
    values.forEach((v, i) => {
      ids.push(i + 1);
      v.forEach((x, p) => {
        pixels.push(p);
        vals.push(x);
      });
      starts.push(pixels.length);
    });
    return unitFootprints({ ids, starts, pixels, values: vals });
  };

  it('compares unit-peak footprints, so a pure rescale is no change', () => {
    const m = movedAgainstNoise(lib([[1, 2, 1]]), lib([[2, 4, 2]]), noiseMap([1, 0.01]));
    expect(m).toEqual({ cells: 1, above1: 0, aboveK: 0, shareK: 0 });
  });

  it('counts cells above 1x and k x their own noise', () => {
    // Cell 1 changes by |[0, 0, 0.5]| / |[0.5, 1, 0.5]| = 0.408.
    const before = lib([
      [0.5, 1, 0.5],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const after = lib([
      [0.5, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const noise = noiseMap([1, 0.3, 2, 0.1, 3, NaN]);
    const m = movedAgainstNoise(before, after, noise, 2);
    // Cell 3 has no noise estimate; cell 2 did not move; cell 1 moved 1.36x its noise.
    expect(m).toEqual({ cells: 2, above1: 1, aboveK: 0, shareK: 0 });
    expect(movedAgainstNoise(before, after, noiseMap([1, 0.1]), 2).aboveK).toBe(1);
  });

  it('pixels dropped from the support count as change', () => {
    const before = lib([[1, 1]]);
    const after = unitFootprints({ ids: [1], starts: [0, 1], pixels: [0], values: [1] });
    // |[0, -1]| / |[1, 1]| = 0.707.
    expect(movedAgainstNoise(before, after, noiseMap([1, 0.5])).above1).toBe(1);
    expect(movedAgainstNoise(before, after, noiseMap([1, 0.8])).above1).toBe(0);
  });
});

describe('settle during Discover settings', () => {
  it('the pool: one more look-back worker from 12 cores, none below; an override wins', () => {
    expect(settlePoolSize(18)).toBe(1);
    expect(settlePoolSize(12)).toBe(1);
    expect(settlePoolSize(11)).toBe(0);
    expect(settlePoolSize(undefined)).toBe(0);
    expect(settlePoolSize(18, 0)).toBe(0);
    expect(settlePoolSize(4, 2)).toBe(2);
    expect(settlePoolSize(4, 99)).toBe(SETTLE_POOL.maxWorkers);
    expect(settlePoolSize(18, null)).toBe(1);
  });

  it('a ceiling is one of the offered values, else the default', () => {
    expect(CSETTLE.rate).toBe(2);
    expect(csettleRate(1)).toBe(1);
    expect(csettleRate('0.5')).toBe(0.5);
    expect(csettleRate(3)).toBe(2);
    expect(csettleRate('')).toBe(2);
    expect(csettleRate(NaN)).toBe(2);
    expect(csettleRate(undefined)).toBe(2);
  });
});

describe('settleChange', () => {
  it('adds the medians to the counts of movedAgainstNoise', () => {
    const fp = (v: number[]) => new Map(v.map((x, i) => [i, x]));
    const before = new Map([
      [1, fp([1, 0.5])],
      [2, fp([1, 0.5])],
      [3, fp([1, 0.5])],
      [9, fp([1])],
    ]);
    const after = new Map([
      [1, fp([1, 0.5])],
      [2, fp([1, 0.6])],
      [3, fp([1, 1])],
    ]);
    const noise = new Map([
      [1, 0.1],
      [2, 0.1],
      [3, 0.1],
    ]);
    const c = settleChange(before, after, noise);
    expect(c).toMatchObject({ cells: 3, cellsBefore: 4, cellsAfter: 3, above1: 1, aboveK: 1 });
    // Cell 2: |0.1| / |(1, 0.5)|.
    expect(c.medianChange).toBeCloseTo(0.1 / Math.hypot(1, 0.5), 6);
    expect(c.medianRatio).toBeCloseTo(1 / Math.hypot(1, 0.5), 6);
    expect(settleChange(new Map(), new Map(), noise).medianChange).toBeNull();
  });
});

describe('Final-settle levels', () => {
  it('Thorough is the whole pass and the default; unknown values fall back to it', () => {
    expect(FINAL_SETTLE_LEVELS.thorough.fraction).toBe(1);
    expect(FINAL_SETTLE_LEVELS.standard.fraction).toBe(0.87);
    expect(FINAL_SETTLE_LEVELS.quick.fraction).toBe(0.6);
    expect(finalSettleLevel('quick')).toBe('quick');
    expect(finalSettleLevel(undefined)).toBe('thorough');
    expect(finalSettleLevel('toString')).toBe('thorough');
    expect(finalSettleLevel(3)).toBe('thorough');
  });

  it('truncatePlan: a fraction of 1 returns the plan itself', () => {
    const plan = settlePlan(23_700);
    expect(truncatePlan(plan, 1)).toBe(plan);
    expect(truncatePlan(plan, Number.NaN)).toBe(plan);
  });

  it('truncatePlan keeps the first share of the frames, in order', () => {
    const plan = [{ start: 0, end: 100 }];
    expect(truncatePlan(plan, 0.6)).toEqual([{ start: 0, end: 60 }]);
    const runs = [
      { start: 0, end: 64 },
      { start: 640, end: 704 },
      { start: 1280, end: 1344 },
      { start: 1920, end: 1984 },
    ];
    const cut = truncatePlan(runs, 0.6);
    expect(planFrames(cut)).toBe(Math.round(0.6 * 256));
    expect(cut.slice(0, 2)).toEqual(runs.slice(0, 2));
    expect(cut[2]).toEqual({ start: 1280, end: 1280 + 154 - 128 });
    expect(truncatePlan(runs, 0)).toEqual([]);
    expect(truncatePlan([], 0.5)).toEqual([]);
  });

  it('truncatePlan on a real plan feeds the first 60 % of a pass', () => {
    const feed = new SettleFeed(truncatePlan(settlePlan(9600), 0.6));
    expect(feed.total).toBe(5760);
    expect(feed.take(5)[0].frame).toBe(0);
  });
});

describe('stillMovingRatios', () => {
  const W = 20;
  /** A square blob of side `s` at (10, 10), unit peak, with a soft rim of value `rim`. */
  const blob = (s: number, rim = 0.2): Map<number, number> => {
    const m = new Map<number, number>();
    const r = s / 2;
    for (let y = 10 - r - 1; y <= 10 + r; y++)
      for (let x = 10 - r - 1; x <= 10 + r; x++) {
        const inside = x >= 10 - r && x < 10 + r && y >= 10 - r && y < 10 + r;
        m.set(y * W + x, inside ? 1 : rim);
      }
    return m;
  };
  /** The same noise on every region (id-independent), recording the regions asked for. */
  const flat =
    (n: number, asked: Uint32Array[] = []) =>
    (_id: number, px: Uint32Array) => {
      asked.push(px);
      return n;
    };

  it('an unchanged footprint scores 0', () => {
    const r = stillMovingRatios(new Map([[1, blob(4)]]), new Map([[1, blob(4)]]), flat(0.1));
    expect([...r]).toEqual([1, 0]);
  });

  it('a core change is scored against the noise on the core', () => {
    const a = blob(4);
    const b = new Map(a);
    for (const [p, v] of a) if (v === 1) b.set(p, 0.8);
    const asked: Uint32Array[] = [];
    // Core: every pixel moves by 0.2 of 1: step 0.2 / noise 0.1 = 2.
    const r = stillMovingRatios(new Map([[1, a]]), new Map([[1, b]]), flat(0.1, asked));
    expect(r[1]).toBeCloseTo(2, 6);
    // Two regions asked: the core (the 16 pixels at the peak) and the edge (the 20 rim pixels).
    expect(asked.map((x) => x.length).sort((x, y) => x - y)).toEqual([20, 36 - 20].sort());
  });

  it('an edge-only change counts, against the edge region norm', () => {
    const a = blob(4, 0.2);
    const b = new Map(a);
    for (const [p, v] of a) if (v < 1) b.set(p, 0.4);
    const r = stillMovingRatios(new Map([[1, a]]), new Map([[1, b]]), flat(0.1));
    // Edge step over the larger edge norm: 0.2 / 0.4 = 0.5; / noise 0.1 = 5.
    expect(r[1]).toBeCloseTo(5, 6);
  });

  it('each region is divided by its own noise', () => {
    const a = blob(4, 0.2);
    const b = new Map(a);
    for (const [p, v] of a) b.set(p, v === 1 ? 0.9 : 0.3);
    // Core step 0.1 / 1 = 0.1; edge step 0.1 / 0.3 = 0.333. Noise: core 0.05, edge 1.
    const noise = (_id: number, px: Uint32Array) => (a.get(px[0]) === 1 ? 0.05 : 1);
    const r = stillMovingRatios(new Map([[1, a]]), new Map([[1, b]]), noise);
    expect(r[1]).toBeCloseTo(2, 6);
  });

  it('a region with no noise estimate is left out; with neither, so is the cell', () => {
    const a = blob(4);
    const b = new Map(a);
    for (const [p, v] of a) if (v === 1) b.set(p, 0.5);
    const edgeOnly = (_id: number, px: Uint32Array) => (a.get(px[0]) === 1 ? Number.NaN : 0.1);
    expect([...stillMovingRatios(new Map([[1, a]]), new Map([[1, b]]), edgeOnly)]).toEqual([1, 0]);
    expect(stillMovingRatios(new Map([[1, a]]), new Map([[1, b]]), flat(Number.NaN))).toHaveLength(
      0,
    );
  });

  it('leaves out cells with no earlier footprint; the map reads it back', () => {
    const r = stillMovingRatios(
      new Map([[1, blob(4)]]),
      new Map([
        [1, blob(4)],
        [2, blob(4)],
      ]),
      flat(0.1),
    );
    expect(stillMovingMap(r)).toEqual(new Map([[1, 0]]));
  });

  it('on noise-sized steps the hint sits near 1 where the whole-footprint ratio is 1, and the old per-region-norm rule did not', () => {
    // Gaussian blobs (sigma 4 px, support to 1 % of the peak), each stepped by white noise.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const SIDE = 400;
    const eps = 0.02;
    const before = new Map<number, Map<number, number>>();
    const after = new Map<number, Map<number, number>>();
    const wholeNoise = new Map<number, number>();
    const truth = new Map<number, Map<number, number>>();
    for (let c = 0; c < 300; c++) {
      const cx = 20 + Math.floor(rnd() * (SIDE - 40));
      const cy = 20 + Math.floor(rnd() * (SIDE - 40));
      const t = new Map<number, number>();
      const b = new Map<number, number>();
      let a2 = 0;
      for (let dy = -12; dy <= 12; dy++)
        for (let dx = -12; dx <= 12; dx++) {
          const v = Math.exp(-(dx * dx + dy * dy) / 32);
          if (v < 0.01) continue;
          const p = (cy + dy) * SIDE + cx + dx;
          t.set(p, v);
          b.set(p, v + eps * gauss());
          a2 += v * v;
        }
      truth.set(c, t);
      before.set(c, t);
      after.set(c, b);
      // The noise of an estimate with white noise eps per pixel, relative to its norm.
      wholeNoise.set(c, (eps * Math.sqrt(t.size)) / Math.sqrt(a2));
    }
    const median = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
    const whole = median(
      footprintChanges(before, after, wholeNoise).map((c) => c.change / c.noise),
    );
    expect(whole).toBeGreaterThan(0.9);
    expect(whole).toBeLessThan(1.1);
    // The region noise of the same white-noise estimates: eps * sqrt(pixels) / norm of the truth there.
    const regionNoise = (id: number, px: Uint32Array) => {
      const t = truth.get(id)!;
      let n2 = 0;
      for (const p of px) n2 += (t.get(p) ?? 0) ** 2;
      return (eps * Math.sqrt(px.length)) / Math.sqrt(n2);
    };
    const hint = stillMovingMap(stillMovingRatios(before, after, regionNoise));
    const h = [...hint.values()];
    expect(h).toHaveLength(300);
    // About 1 or below... a max over two regions adds a little: a noise-sized step reads at most about 1.1.
    expect(median(h)).toBeLessThan(1.15);
    expect(median(h)).toBeGreaterThan(0.9);
    // The old rule (each region over its own norm, then the whole-footprint noise) read much higher.
    const old = [...before].map(([id, a]) => {
      const b = after.get(id)!;
      const step = (keep: (v: number) => boolean) => {
        let d2 = 0;
        let n2 = 0;
        for (const [p, v] of a)
          if (keep(v)) {
            d2 += (b.get(p)! - v) ** 2;
            n2 += v * v;
          }
        return Math.sqrt(d2 / n2);
      };
      return (
        Math.max(
          step((v) => v >= 0.5),
          step((v) => v < 0.5),
        ) / wholeNoise.get(id)!
      );
    });
    expect(median(old)).toBeGreaterThan(1.5);
  });
});
