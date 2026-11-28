import { describe, expect, it } from 'vitest';
import {
  beatStrength,
  binFrames,
  BirthQueue,
  clock,
  createSoul,
  MAX_BIRTH_QUEUE,
  mostActive,
  newIds,
  OnsetRibbon,
  portraitLines,
  RIBBON_MAX_SHARE,
  ribbonCaption,
  ribbonHeight,
  shapeCentre,
  SYNC_SHARE,
} from '../lib/soul.ts';
import { countOnsets, emptyActivity, scanOnsets, seedOf, stepActivity } from '../lib/activity.ts';
import { HOT_FPS, isHot, trackEdges } from '../lib/juice.ts';
import { nextSpikeS, NEAR_ISI_S, REST_ISI_S } from '../components/NeuronSketch.tsx';
import type { CellShape } from '../lib/cell-overlay.ts';
import type { StageSegment } from '@calab/ui';
import { createRoot } from 'solid-js';

/** A noisy-free trace: baseline 0, transients of height 10 at the given frames (3 frames each). */
function trace(n: number, at: number[]): Float32Array {
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = 0.1 * Math.sin(i * 1.7);
  for (const a of at) for (let k = 0; k < 3; k++) if (a + k < n) v[a + k] = 10 * (1 - k * 0.3);
  return v;
}

describe('per-frame onsets', () => {
  it('counts each transient once, at its rising frame', () => {
    const v = trace(200, [20, 80, 150]);
    const c = { base: 0, noise: 0.05, peak: 10 };
    expect(scanOnsets(c, v)).toEqual([20, 80, 150]);
  });

  it('a transient split over two windows counts once (the latch carries over)', () => {
    const c = { base: 0, noise: 0.05, peak: 10 };
    const v = trace(40, [18]);
    expect(scanOnsets(c, v.subarray(0, 19))).toEqual([18]);
    expect(scanOnsets(c, v.subarray(19))).toEqual([]);
  });

  it('noise alone never fires', () => {
    const c = { base: 0, noise: 0.05, peak: 10 };
    expect(scanOnsets(c, trace(300, []))).toEqual([]);
  });

  it('counts onsets over a whole trace from the trace itself', () => {
    expect(countOnsets(trace(500, [50, 120, 300, 420]))).toBe(4);
    expect(countOnsets([NaN, 1])).toBe(0);
  });

  it('stepActivity reports per-frame onsets alongside the tick crossing', () => {
    const st = emptyActivity();
    const v = trace(100, [10, 60]);
    const got: [number, number][] = [];
    stepActivity(
      st,
      [7],
      () => 10,
      () => ({ base: 0, noise: 0.05, peak: 10 }),
      { window: () => v, onset: (id, k) => got.push([id, k]) },
    );
    expect(got).toEqual([
      [7, 10],
      [7, 60],
    ]);
  });
});

describe('per-frame onsets do not depend on the speed', () => {
  it('the same trace read 5 or 170 frames per tick gives the same onsets', () => {
    const n = 3000;
    const at: number[] = [];
    for (let f = 40; f < n; f += 97 + ((f * 13) % 50)) at.push(f);
    const v = trace(n, at);
    // Transients of varying height (a cell's events are not all alike).
    for (const a of at) for (let k = 0; k < 3; k++) v[a + k] *= 0.6 + 0.4 * Math.abs(Math.sin(a));
    // Small bumps (a fifth of the big events) between them: still well above the noise.
    for (const a of at) for (let k = 0; k < 4; k++) if (a + 45 + k < n) v[a + 45 + k] = 2;
    const run = (step: number): number[] => {
      const st = emptyActivity();
      const got: number[] = [];
      for (let lo = 0; lo < n; lo += step) {
        const hi = Math.min(n, lo + step);
        const w = v.subarray(lo, hi);
        stepActivity(
          st,
          [1],
          () => Math.max(...w),
          () => seedOf(v.subarray(Math.max(0, hi - 1000), hi)),
          { window: () => w, onset: (_id, k) => got.push(lo + k), end: hi },
        );
      }
      return got;
    };
    const slow = run(5);
    const fast = run(170);
    expect(slow.length).toBeGreaterThan(at.length * 1.6);
    expect(Math.abs(slow.length - fast.length)).toBeLessThanOrEqual(Math.ceil(at.length * 0.05));
  });
});

describe('activity ribbon', () => {
  const cellsRead = (n: number, from: number, to: number) =>
    Array.from({ length: n }, (_, id) => ({ id, from, to }));

  it('bins onsets by recording frames, as a share of the cells read there', () => {
    const r = new OnsetRibbon(10, 100);
    r.add(cellsRead(20, 0, 30), [
      { id: 1, frame: 3 },
      { id: 2, frame: 4 },
      { id: 1, frame: 15 },
    ]);
    const { share, count } = r.columns(3);
    expect(Array.from(count)).toEqual([2, 1, 0]);
    expect(share[0]).toBeCloseTo(0.1);
    expect(share[2]).toBe(0);
  });

  it('a cell with two onsets in one column counts once', () => {
    const r = new OnsetRibbon(10, 100);
    r.add(cellsRead(4, 0, 10), [
      { id: 0, frame: 1 },
      { id: 0, frame: 7 },
    ]);
    expect(r.columns(1).share[0]).toBeCloseTo(0.25);
  });

  it('a column never read is NaN (a gap), not quiet; late frames fill their own column', () => {
    const r = new OnsetRibbon(10, 100);
    r.add(cellsRead(5, 0, 10), []);
    r.add(cellsRead(5, 40, 50), [{ id: 3, frame: 41 }]);
    let { share } = r.columns(5);
    expect(share[0]).toBe(0);
    expect(Number.isNaN(share[1])).toBe(true);
    expect(share[4]).toBeCloseTo(0.2);
    // A lagging trace solved later: frames 10..20 of two cells, one onset.
    r.add(cellsRead(2, 10, 20), [{ id: 1, frame: 12 }]);
    ({ share } = r.columns(5));
    expect(share[1]).toBeCloseTo(0.5);
  });

  it('a share counts only the cells read in that column (an unsolved trace is not quiet)', () => {
    const r = new OnsetRibbon(10, 100);
    // 10 cells in the library, only 4 with a solved trace over the column.
    r.add(cellsRead(4, 0, 10), [{ id: 0, frame: 2 }]);
    expect(r.columns(1).share[0]).toBeCloseTo(0.25);
  });

  it('a jump far back starts it afresh; old columns are dropped', () => {
    const r = new OnsetRibbon(1, 5);
    r.add(cellsRead(1, 0, 100), [{ id: 0, frame: 99 }]);
    r.add(cellsRead(1, 0, 3), [{ id: 0, frame: 1 }]);
    expect(r.end).toBe(3);
    expect(Array.from(r.columns(3).count)).toEqual([0, 1, 0]);
  });

  it('half a second of recording per column', () => {
    expect(binFrames(30)).toBe(15);
    expect(binFrames(0)).toBe(10);
    expect(binFrames(1)).toBe(1);
  });

  it('a fixed scale: clipped above the top share', () => {
    expect(ribbonHeight(RIBBON_MAX_SHARE / 2)).toEqual({ h: 0.5, clipped: false });
    expect(ribbonHeight(0.9)).toEqual({ h: 1, clipped: true });
    expect(ribbonHeight(NaN)).toEqual({ h: 0, clipped: false });
  });

  it('captions what the newest columns show', () => {
    const f = (a: number[]) => Float32Array.from(a);
    const i = (a: number[]) => Int32Array.from(a);
    expect(ribbonCaption(f([NaN, NaN]), i([0, 0]), 4)).toBe('Waiting for frames');
    expect(ribbonCaption(f([0, 0]), i([0, 0]), 4)).toBe('Quiet');
    expect(ribbonCaption(f([0.05, 0.01]), i([3, 1]), 4)).toBe('4 cell onsets in the last 1 s');
    expect(ribbonCaption(f([SYNC_SHARE, 0]), i([30, 0]), 4)).toMatch(/burst, or motion/);
  });
});

describe('heartbeat, births, portrait', () => {
  it('beats by the share of cells that fired, on a fixed scale', () => {
    expect(beatStrength(0, 100)).toBe(0);
    expect(beatStrength(5, 100)).toBeCloseTo(0.5);
    expect(beatStrength(50, 100)).toBe(1);
    expect(beatStrength(3, 0)).toBe(0);
  });

  it('new ids are the ones not in the last library', () => {
    expect(newIds(null, [1, 2])).toEqual([1, 2]);
    expect(newIds([1, 2, 3], [2, 3, 4, 5])).toEqual([4, 5]);
  });

  it('a footprint centre is its weighted centre', () => {
    const w = 10;
    const sh = {
      id: 1,
      support: Uint32Array.from([2 * w + 2, 2 * w + 4]),
      rel: Float32Array.from([1, 1]),
      x0: 2,
      x1: 5,
      y0: 2,
      y1: 3,
    } as unknown as CellShape;
    const c = shapeCentre(sh, w);
    expect(c.x).toBeCloseTo(3.5);
    expect(c.y).toBeCloseTo(2.5);
    expect(c.r).toBe(2);
  });

  it('the birth queue keeps the newest and hands out what fits', () => {
    const q = new BirthQueue<number>();
    q.push(Array.from({ length: MAX_BIRTH_QUEUE + 10 }, (_, i) => i));
    expect(q.size).toBe(MAX_BIRTH_QUEUE);
    expect(q.take(3)).toEqual([10, 11, 12]);
    expect(q.take(0)).toEqual([]);
  });

  it('most active: the most onsets, ties to the lower id, none without any', () => {
    expect(
      mostActive(
        new Map([
          [4, 2],
          [9, 7],
          [3, 7],
        ]),
      ),
    ).toEqual({ id: 3, onsets: 7 });
    expect(mostActive(new Map([[1, 0]]))).toBeNull();
  });

  it('portrait lines and clock', () => {
    expect(clock(65)).toBe('1:05');
    expect(clock(3723)).toBe('1:02:03');
    expect(
      portraitLines({
        cells: 1234,
        runMs: 42_000,
        recordingS: 600,
        mostActive: { id: 7, onsets: 31 },
      }),
    ).toEqual([
      { label: 'Cells', value: '1,234' },
      { label: 'Recording', value: '10:00' },
      { label: 'Run time', value: '0:42' },
      { label: 'Most active', value: 'cell 7 · 31 onsets' },
    ]);
    expect(
      portraitLines({ cells: 0, runMs: null, recordingS: null, mostActive: null }),
    ).toHaveLength(1);
  });

  it('the hub: ticks fill the ribbon and beat; a new run clears it', () => {
    createRoot((dispose) => {
      const s = createSoul();
      s.setFps(20);
      s.tick({
        fired: [1, 2],
        onsets: [
          { id: 1, frame: 3 },
          { id: 2, frame: 4 },
        ],
        reads: Array.from({ length: 10 }, (_, id) => ({ id, from: 0, to: 20 })),
        cells: 10,
      });
      expect(s.beat().strength).toBe(1);
      expect(s.ribbon().columns(2).count[1]).toBe(0);
      expect(s.ribbon().columns(2).count[0]).toBe(2);
      s.say('milestone', '100 cells!');
      expect(s.moment()?.title).toBe('100 cells!');
      s.resetRun();
      expect(s.moment()).toBeNull();
      expect(s.ribbon().end).toBe(-1);
      dispose();
    });
  });
});

describe('juice', () => {
  it('runs hot near the target when paced, above HOT_FPS unpaced', () => {
    expect(isHot('discover', 98, 100)).toBe(true);
    expect(isHot('discover', 80, 100)).toBe(false);
    expect(isHot('discover', HOT_FPS, null)).toBe(true);
    expect(isHot('extract', 40, 0)).toBe(false);
    expect(isHot(null, 900, null)).toBe(false);
    expect(isHot('discover', null, null)).toBe(false);
  });

  it('track edges: the running fill end and each segment end', () => {
    const seg = (id: string, weight: number, state: StageSegment['state'], fraction?: number) =>
      ({ id, label: id, hue: 'discover', weight, state, fraction }) as StageSegment;
    const e = trackEdges([
      seg('a', 2, 'done'),
      seg('b', 1, 'running', 0.5),
      seg('c', 1, 'waiting'),
    ]);
    expect(e.lead).toBeCloseTo(0.625);
    expect(e.ends.map((x) => x.at)).toEqual([0.5, 0.75, 1]);
    expect(trackEdges([seg('a', 1, 'running', null as unknown as number)]).lead).toBeNull();
  });
});

describe('neuron sketch', () => {
  it('fires sparsely at rest, more often with the cursor near', () => {
    const u = Math.exp(-1);
    expect(nextSpikeS(Infinity, u)).toBeCloseTo(REST_ISI_S);
    expect(nextSpikeS(0, u)).toBeCloseTo(NEAR_ISI_S);
  });
});
