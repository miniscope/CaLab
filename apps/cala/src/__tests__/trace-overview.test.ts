// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OVERVIEW_BUCKETS, TraceOverviewHistory } from '../lib/trace-overview.ts';
import { TraceHistory } from '../lib/trace-history.ts';

describe('whole-session trace envelope', () => {
  it('preserves old extrema and their frames through repeated coarsening', () => {
    const h = new TraceOverviewHistory();
    h.push(2, 500);
    h.push(3, -400);
    for (let f = 4; f < 100_000; f++) h.push(f, f % 7);
    const e = h.get();
    expect(e.values[e.frames.indexOf(2)]).toBe(500);
    expect(e.values[e.frames.indexOf(3)]).toBe(-400);
    expect(e.frames.every((f, i) => i === 0 || f >= e.frames[i - 1])).toBe(true);
    expect(e.frames.length).toBeLessThanOrEqual(2 * OVERVIEW_BUCKETS);
    expect(h.bytes).toBe(12 * 1024);
    expect(e.bucketFrames).toBeGreaterThan(8);
  });

  it('keeps empty buckets as gaps and skips non-finite values', () => {
    const h = new TraceOverviewHistory();
    h.push(0, 3);
    h.push(1, 3);
    h.push(8, NaN);
    h.push(9, Infinity);
    h.push(24, 5);
    const e = h.get();
    expect(e.values).toEqual([3, 3, null, null, 5, 5]);
    expect(e.frames).toEqual([0, 1, 8, 16, 24, 24]);
  });

  it('survives detail rollover and long gaps, then releases a removed cell', () => {
    const h = new TraceHistory(4);
    h.push(0, 6, [7], [100, 1, 2, 3, 4, 5]);
    expect(h.span(7)).toEqual({ first: 2, end: 6 });
    expect(h.overview(7).values).toContain(100);
    h.push(1_000_000, 1, [7], [20]);
    expect(h.span(7)).toEqual({ first: 1_000_000, end: 1_000_001 });
    expect(h.overview(7).values).toContain(100);
    expect(h.overview(7).values).toContain(20);
    expect(h.overviewBytes).toBe(12 * 1024);
    h.retain([]);
    expect(h.overviewBytes).toBe(0);
    expect(h.overview(7).frames).toEqual([]);
  });

  it('starts a fresh overview on rewind and resets all storage on clear', () => {
    const h = new TraceHistory(4);
    h.push(10, 1, [7], [100]);
    h.push(0, 1, [7], [3]);
    expect(h.overview(7).values).not.toContain(100);
    h.clear();
    expect(h.overviewBytes).toBe(0);
    expect(h.bytes).toBe(0);
  });
});
