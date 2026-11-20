// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  movedAgainstNoise,
  noiseMap,
  planFrames,
  SETTLE,
  SettleFeed,
  settlePlan,
  unitFootprints,
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
