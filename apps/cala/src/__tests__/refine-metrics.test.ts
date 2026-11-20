import { describe, expect, it } from 'vitest';
import {
  footprintChanges,
  ladder125,
  quantile,
  RATE_MIN_S,
  RefineTracker,
  refineHistory,
  runComparison,
  seriesMeta,
} from '../lib/refine-metrics.ts';
import { stageMeta } from '../lib/export.ts';
import type { StageRun } from '../lib/run-stages.ts';
import type { LibraryView } from '../workers/slow-types.ts';

/** A library of one-pixel footprints with these values (cell i at pixel i, id i + 1). */
function lib(version: number, values: number[]): LibraryView {
  const n = values.length;
  return {
    version,
    frame: 0,
    width: 8,
    height: 8,
    ids: Uint32Array.from(values.map((_, i) => i + 1)),
    centers: new Float32Array(2 * n),
    radii: new Float32Array(n),
    starts: Uint32Array.from({ length: n + 1 }, (_, i) => i),
    pixels: Uint32Array.from(values.map((_, i) => i)),
    values: Float32Array.from(values),
  };
}

describe('footprint changes and quantiles', () => {
  it('measures |a′ − a| / |a| per changed cell only', () => {
    const { changes, cells } = footprintChanges(lib(1, [1, 2, 4]), lib(2, [1, 3, 2]));
    expect(cells).toBe(3);
    expect([...changes.keys()]).toEqual([2, 3]);
    expect(changes.get(2)).toBeCloseTo(0.5);
    expect(changes.get(3)).toBeCloseTo(0.5);
  });

  it('interpolates quantiles and is null when empty', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([3], 0.9)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([0, 10], 0.9)).toBeCloseTo(9);
  });

  it('steps a 1/2/5 ladder', () => {
    expect([0.3, 0.5, 0.51, 7, 120].map(ladder125)).toEqual([0.5, 0.5, 1, 10, 200]);
  });
});

describe('RefineTracker', () => {
  it('counts refines per minute over the last minute, none before RATE_MIN_S', () => {
    const t = new RefineTracker(lib(1, [1, 1]), 10);
    t.status(50, 2); // 5 s
    expect(t.samples()[0].refinesPerMin).toBeNull();
    t.status(10 * RATE_MIN_S, 4); // 10 s: 4 refines in 10 s
    expect(t.samples()[1].refinesPerMin).toBeCloseTo(24);
    t.status(600, 30); // 60 s: 30 in the minute
    expect(t.samples()[2].refinesPerMin).toBeCloseTo(30);
    t.status(900, 33); // 90 s: the count at 30 s is the one recorded at 10 s (4)
    expect(t.samples()[3].refinesPerMin).toBeCloseTo(29);
    expect(t.samples().map((s) => s.t)).toEqual([5, 10, 60, 90]);
  });

  it('takes each publish once: change median, p90 and the cumulative share refined', () => {
    const start = lib(1, [1, 1, 1, 1]);
    const t = new RefineTracker(start, 20);
    t.library(start, 10); // the starting library: ignored
    expect(t.samples()).toHaveLength(0);
    t.library(lib(2, [1.1, 1.2, 1, 1]), 200);
    t.library(lib(2, [1.1, 1.2, 1, 1]), 220); // same version again
    const a = t.samples();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ t: 10, changed: 2, refinedShare: 0.5 });
    expect(a[0].changeMedian).toBeCloseTo(0.15);
    expect(a[0].changeP90).toBeCloseTo(0.19);
    // Against the previous publish, not the start: cell 1 is unchanged now.
    t.library(lib(3, [1.1, 1.2, 1.5, 1]), 400);
    const b = t.samples()[1];
    expect(b.changed).toBe(1);
    expect(b.changeMedian).toBeCloseTo(0.5);
    expect(b.refinedShare).toBe(0.75);
    const sum = t.summary();
    expect(sum.publishes).toBe(2);
    expect(sum.refinedShare).toBe(0.75);
    // All published changes: 0.1, 0.2, 0.5.
    expect(sum.changeP90).toBeCloseTo(0.44);
  });

  it('builds the plot history and the export columns from the samples', () => {
    const t = new RefineTracker(lib(1, [1, 1]), 10);
    t.status(100, 1);
    t.library(lib(2, [2, 1]), 150);
    t.status(200, 3);
    const h = refineHistory(t.samples(), 30);
    expect(h.latest('refines_per_min')).toBeCloseTo(9);
    expect(h.latest('change_median')).toBeCloseTo(1);
    expect(h.latest('refined_share')).toBeCloseTo(0.5);
    // Declared ranges: the change stepped its ladder from 0.5 to 1, never fitted.
    expect(h.displayRange('refined_share')).toMatchObject({ lo: 0, hi: 1 });
    const m = seriesMeta(t.samples());
    expect(m.t).toEqual([10, 15, 20]);
    expect(m.change_median).toEqual([null, 1, null]);
    expect(m.refines).toEqual([1, 1, 3]);
  });
});

describe('the comparison across runs', () => {
  const run = (stage: StageRun['stage'], index: number, extra: Partial<StageRun>): StageRun => ({
    stage,
    index,
    startedAt: '',
    endedAt: '',
    outcome: 'done',
    frames: 100,
    cells: 10,
    libraryVersion: 1,
    ...extra,
  });

  it('starts at the newest Discover, skips Extract and running runs, and tops ranges on a ladder', () => {
    const runs = [
      run('discover', 1, { refinesPerMin: 300 }),
      run('discover', 2, { refinesPerMin: 80 }),
      run('refine', 1, { refinesPerMin: 40, medianFootprintChange: 0.6, footprintsRefined: 5 }),
      run('extract', 1, {}),
      run('refine', 2, { refinesPerMin: 20, medianFootprintChange: 0.2, footprintsRefined: 2 }),
      run('refine', 3, { outcome: 'running' }),
    ];
    const c = runComparison(runs);
    expect(c.points.map((p) => p.label)).toEqual(['D', '1', '2']);
    expect(c.points.map((p) => p.refinesPerMin)).toEqual([80, 40, 20]);
    expect(c.points.map((p) => p.medianChange)).toEqual([null, 0.6, 0.2]);
    expect(c.points.map((p) => p.refinedShare)).toEqual([null, 0.5, 0.2]);
    // Initial tops 50 /min and 0.5, stepped to hold 80 and 0.6.
    expect(c.rateTop).toBe(100);
    expect(c.changeTop).toBe(1);
    expect(runComparison(runs.slice(0, 2)).rateTop).toBe(100);
    expect(runComparison([run('discover', 1, { refinesPerMin: 10 })]).rateTop).toBe(50);
  });

  it('exports a Refine run’s p90, share and series in meta_json.stages', () => {
    const t = new RefineTracker(lib(1, [1, 1]), 10);
    t.library(lib(2, [2, 1]), 150);
    const m = stageMeta(
      run('refine', 1, { changeP90: 0.3, refinedShare: 0.5, series: t.samples() }),
    );
    expect(m).toMatchObject({ change_p90: 0.3, refined_share: 0.5 });
    expect((m.series as Record<string, unknown[]>).change_median).toEqual([1]);
    expect(stageMeta(run('discover', 1, {}))).not.toHaveProperty('series');
  });
});
