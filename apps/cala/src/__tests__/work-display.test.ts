import { describe, expect, it } from 'vitest';
import {
  bandPath,
  busyWorkers,
  displayState,
  formatDuration,
  squareStack,
  gridGroups,
  groupedRows,
  squareTitle,
  linePath,
  planPath,
  plannedSettleFrames,
  rowAriaLabel,
  rowBusy,
  rowLabel,
  settledSummary,
  speedPos,
  settlednessFromHints,
  stackBands,
  stepPoints,
  stoppedLookbackRows,
  BG_SETTLE_GROUND,
  BG_SETTLE_HATCH,
  KIND_COLOR,
  stripLayout,
  thinIndices,
  FINAL_SEGMENT_SHARE,
} from '../lib/work-display.ts';
import { workByKind, WORK_KINDS, type WorkKind, type WorkRates } from '../lib/work-meter.ts';

const vals = (o: Partial<Record<WorkKind, number>>): Record<WorkKind, number> => ({
  live: 0,
  discovery: 0,
  lookback: 0,
  bgSettle: 0,
  finalSettle: 0,
  ...o,
});

describe('speedPos', () => {
  it('is the fixed log scale 10 to 500, clamped', () => {
    expect(speedPos(10)).toBe(0);
    expect(speedPos(500)).toBe(1);
    expect(speedPos(5)).toBe(0);
    expect(speedPos(1000)).toBe(1);
    expect(speedPos(Infinity)).toBe(1);
    expect(speedPos(Math.sqrt(10 * 500))).toBeCloseTo(0.5, 10);
    expect(speedPos(0)).toBe(0);
  });
});

describe('busyWorkers', () => {
  it('is capped at the count', () => {
    expect(busyWorkers(vals({ live: 3, discovery: 3 }), 5)).toBe(5);
    expect(busyWorkers(vals({ live: 1 }), 5)).toBe(1);
  });
});

describe('rows', () => {
  const rates = {
    spanMs: 1000,
    slow: {
      live: 0.2,
      visit: 0.1,
      housekeep: 0,
      need: 0.1,
      csettle: 0.2,
      end: 0,
      publish: 0,
      setup: 0,
      idle: 0.4,
    },
    visit: [0.5, 0.6],
    settle: {
      slow: { live: 0, visit: 0, housekeep: 0, need: 0, csettle: 0, end: 0, publish: 0, setup: 0 },
      visit: [0, 0],
    },
    lookback: {
      busy: 1.5,
      workers: [0.7, 0.8],
      workersEnd: [0, 0],
      capacity: 2,
      kinds: {
        need: {
          busy: 0.7,
          framesPerS: 0,
          answers: 0,
          msPerAnswer: { read: 0, preprocess: 0, solve: 0 },
        },
        csettle: {
          busy: 0.8,
          framesPerS: 0,
          answers: 0,
          msPerAnswer: { read: 0, preprocess: 0, solve: 0 },
        },
        end: {
          busy: 0,
          framesPerS: 0,
          answers: 0,
          msPerAnswer: { read: 0, preprocess: 0, solve: 0 },
        },
      },
    },
    batchWait: { meanMs: 0, lastMs: 0, max1sMs: 0 },
    fast: { stages: [0.16, 0.12, 0.24] },
  } satisfies WorkRates;
  const by = workByKind(rates);

  it('short labels and a flag where a group starts', () => {
    const rows = groupedRows(by);
    expect(rows.map((r) => r.label)).toEqual([
      'read + prepare',
      'motion',
      'traces',
      'cell model',
      'footprint helper 1',
      'footprint helper 2',
      'look-back 0',
      'settle helper 1',
    ]);
    expect(rows.filter((r) => r.groupStart).map((r) => r.label)).toEqual([
      'cell model',
      'footprint helper 1',
      'look-back 0',
    ]);
    expect(groupedRows(null)).toEqual([]);
  });
  it('a row is busy by the sum of its kinds, at most 1', () => {
    for (const w of by.workers) expect(rowBusy(w)).toBeLessThanOrEqual(1);
    expect(rowBusy(by.workers[0])).toBeCloseTo(0.16, 10);
  });
  it('the grid groups the squares by worker group, each worker once, in order', () => {
    const groups = gridGroups(by);
    expect(groups.map((g) => [g.label, g.squares.length])).toEqual([
      ['Frame loop', 3],
      ['Cell model', 1],
      ['Footprint helpers', 2],
      ['Look-back and settle', 2],
    ]);
    expect(groups.flatMap((g) => g.squares.map((q) => q.index))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(gridGroups(null)).toEqual([]);
  });
  it('a square fills bottom up with every job, each as tall as its share, never over 100 %', () => {
    const w = (shares: Partial<Record<WorkKind, number>>) => ({
      name: 'Slow worker',
      group: 'slow' as const,
      shares: vals(shares),
    });
    const st = squareStack(w({ discovery: 0.3, bgSettle: 0.36 }));
    // Every kind, in the fixed order (stable segments), zero where the worker did not do it.
    expect(st.map((x) => x.kind)).toEqual([...WORK_KINDS]);
    expect(st.find((x) => x.kind === 'discovery')!.pct).toBeCloseTo(30, 10);
    expect(st.find((x) => x.kind === 'bgSettle')!.pct).toBeCloseTo(36, 10);
    expect(st.find((x) => x.kind === 'live')!.pct).toBe(0);
    const over = squareStack(w({ discovery: 0.7, lookback: 0.6 }));
    expect(over.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(100, 10);
  });
  it("a square's hover text says what the worker does and what its percentages are of", () => {
    const t = squareTitle('cell model', by.workers[3]);
    expect(t).toContain('cell model: The cell model');
    expect(t).toContain('% of the last second');
    expect(t).toContain('Find cells');
  });
  it('totals plus Spare equal the worker count, so the bar closes', () => {
    const sum = WORK_KINDS.reduce((a, k) => a + by.totals[k], 0) + by.totals.spare;
    expect(sum).toBeCloseTo(by.count, 10);
    expect(rowLabel({ name: 'Look-back worker', group: 'lookback', shares: vals({}) })).toBe(
      'look-back',
    );
  });
});

describe('displayState', () => {
  const base = { live: false, settling: false };
  it('maps the pipeline status', () => {
    expect(displayState({ ...base, status: 'idle' })).toBe('idle');
    expect(displayState({ ...base, status: 'error' })).toBe('idle');
    expect(displayState({ ...base, status: 'running' })).toBe('running');
    expect(displayState({ ...base, status: 'paused' })).toBe('paused');
    expect(displayState({ ...base, status: 'done' })).toBe('done');
    expect(displayState({ ...base, status: 'done', settling: true })).toBe('final-settle');
    expect(displayState({ live: true, settling: false, status: 'running' })).toBe('streaming');
  });
});

describe('text', () => {
  it('durations', () => {
    expect(formatDuration(105)).toBe('1 min 45 s');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(3725)).toBe('1 h 02 min');
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(-1)).toBe('-');
  });
  it('plans at most the settle cap', () => {
    expect(plannedSettleFrames(30000, 18000)).toBe(18000);
    expect(plannedSettleFrames(5000, 18000)).toBe(5000);
    expect(plannedSettleFrames(Infinity, 18000)).toBe(0);
  });
});

describe('settledness slot', () => {
  it('is null until the measure exists, then counts the three states', () => {
    expect(settledSummary(null)).toBeNull();
    expect(settledSummary(undefined)).toBeNull();
    expect(
      settledSummary([
        { id: 1, state: 'settled', confidence: 0.9 },
        { id: 2, state: 'settling', confidence: null },
        { id: 3, state: 'new', confidence: null },
        { id: 4, state: 'settled', confidence: 1 },
      ]),
    ).toEqual({ settled: 2, settling: 1, fresh: 1, total: 4 });
  });
});

describe('strip layout', () => {
  it('without a Final settle Discover has the whole width', () => {
    const l = stripLayout(500, 34, 6, false);
    expect(l.final).toBeNull();
    expect(l.discover).toEqual({ x0: 34, x1: 494 });
  });
  it('the Final settle is a fixed quarter of the plot width, Discover keeps the rest', () => {
    const l = stripLayout(526, 34, 6, true, 8);
    const inner = 526 - 34 - 6;
    expect(l.final!.x1).toBe(520);
    expect(l.final!.x1 - l.final!.x0).toBeCloseTo(inner * FINAL_SEGMENT_SHARE, 10);
    expect(l.discover.x1).toBeCloseTo(l.final!.x0 - 8, 10);
    // The segment does not move while Discover runs: same layout for any frame count.
    expect(stripLayout(526, 34, 6, true, 8)).toEqual(l);
  });
});

describe('stack bands', () => {
  const pts = [
    { x: 0, values: vals({ live: 1, discovery: 2 }) },
    { x: 10, values: vals({ live: 1, discovery: 3, lookback: 1 }) },
  ];
  it('stack in kind order inside the fixed 0..count range', () => {
    const b = stackBands(pts, 10, 0, 100);
    expect(b.map((x) => x.kind)).toEqual([...WORK_KINDS]);
    // 1 of 10 workers is 10 px of the 100 px range, measured up from the bottom.
    expect(b[0].top[0]).toBe(90);
    expect(b[0].bottom[0]).toBe(100);
    expect(b[1].bottom[0]).toBe(90);
    expect(b[1].top[1]).toBe(60);
    expect(b[2].top[1]).toBe(50);
  });
  it('clamps at the worker count', () => {
    const b = stackBands([{ x: 0, values: vals({ live: 8, discovery: 8 }) }], 10, 0, 100);
    expect(b[1].top[0]).toBe(0);
  });
  it('a band with no thickness draws nothing', () => {
    const b = stackBands(pts, 10, 0, 100);
    expect(bandPath(b[4])).toBe('');
    expect(bandPath(b[0])).toMatch(/^M0\.0,90\.0 L10\.0,90\.0 L10\.0,100\.0 L0\.0,100\.0 Z$/);
  });
});

describe('work readings as steps', () => {
  const p = (x: number, live: number) => ({ x, values: vals({ live }) });
  it('draws each reading flat back to the one before it', () => {
    const out = stepPoints([p(0, 1), p(10, 3), p(30, 2)]);
    expect(out.map((q) => [q.x, q.values.live])).toEqual([
      [0, 1],
      [0, 3],
      [10, 3],
      [10, 2],
      [30, 2],
    ]);
  });
  it('keeps a single reading and an empty list as they are', () => {
    expect(stepPoints([p(5, 1)]).map((q) => q.x)).toEqual([5]);
    expect(stepPoints([])).toEqual([]);
  });
  it('the stacked band of steps has a vertical edge at each reading', () => {
    const [live] = stackBands(stepPoints([p(0, 1), p(10, 3)]), 10, 0, 100);
    expect(live.x).toEqual([0, 0, 10]);
    expect(live.top).toEqual([90, 70, 70]);
  });
});

describe('paths', () => {
  it('lifts the pen at a gap', () => {
    expect(linePath([0, 1, 2, 3], [5, NaN, 6, 7])).toBe('M0.0,5.0M2.0,6.0L3.0,7.0');
  });
  it('thinning keeps the ends', () => {
    expect(thinIndices(3, 10)).toEqual([0, 1, 2]);
    const t = thinIndices(1000, 5);
    expect(t.length).toBe(5);
    expect(t[0]).toBe(0);
    expect(t[4]).toBe(999);
  });
});

describe('accessible names and stopped rows', () => {
  const w = (
    name: string,
    group: 'fast' | 'slow' | 'visit' | 'lookback',
    shares: Partial<Record<WorkKind, number>> = {},
  ) => ({ name, group, shares: vals(shares) });
  it('a row names its split as values', () => {
    expect(rowAriaLabel('slow', w('Slow worker', 'slow', { discovery: 0.3, bgSettle: 0.36 }))).toBe(
      'slow: 66% busy, Find cells 30%, Background settle 36%',
    );
    expect(rowAriaLabel('traces', w('t', 'fast'))).toBe('traces: 0% busy');
  });
  const rows = [
    w('Slow worker', 'slow'),
    w('Look-back worker 0', 'lookback'),
    w('Settle worker 1', 'lookback'),
    w('Settle worker 2', 'lookback'),
  ];
  it('the whole look-back stopping marks every look-back row, and only those', () => {
    expect(stoppedLookbackRows(rows, 3, true)).toEqual([false, true, true, true]);
  });
  it('one lost pool worker marks one row; none lost marks none', () => {
    expect(stoppedLookbackRows(rows, 3, false)).toEqual([false, false, false, false]);
    expect(stoppedLookbackRows(rows, 2, false)).toEqual([false, false, false, true]);
    expect(stoppedLookbackRows(rows, 1, false)).toEqual([false, false, true, true]);
    expect(stoppedLookbackRows(rows, undefined, false)).toEqual([false, false, false, false]);
    // The need-driven worker is never marked by the count.
    expect(stoppedLookbackRows(rows, 0, false)).toEqual([false, false, true, true]);
  });
  it('Background settle differs from Final settle by more than lightness', () => {
    expect(BG_SETTLE_HATCH).toContain('repeating-linear-gradient');
    expect(BG_SETTLE_HATCH).toContain(KIND_COLOR.finalSettle);
    expect(BG_SETTLE_HATCH).toContain(BG_SETTLE_GROUND);
    expect(BG_SETTLE_GROUND).not.toBe(KIND_COLOR.finalSettle);
  });
});

describe('settlednessFromHints', () => {
  it('is null before any hint, then settled / settling / new by the ratio and k', () => {
    expect(settlednessFromHints([1, 2], new Map(), 2)).toBeNull();
    const hints = new Map([
      [1, 0.5],
      [2, 2],
      [3, 3.5],
    ]);
    expect(settlednessFromHints([1, 2, 3, 4], hints, 2)?.map((f) => f.state)).toEqual([
      'settled',
      'settled',
      'settling',
      'new',
    ]);
    expect(settlednessFromHints([], hints, 2)).toBeNull();
  });
});

describe('the plan line', () => {
  it('draws steps flat over the segment, Max at the top and fps on the log scale', () => {
    const seg = { x0: 100, x1: 300 };
    const d = planPath(
      [
        { x: 0, fps: 0 },
        { x: 0.5, fps: 0 },
        { x: 0.5, fps: 70.71067811865476 },
        { x: 1, fps: 70.71067811865476 },
      ],
      seg,
      14,
      70,
    );
    // 10 to 500 fps: 70.7 fps is halfway up the log scale.
    expect(d).toBe('M100.0,14.0L200.0,14.0L200.0,42.0L300.0,42.0');
  });

  it('is empty for an empty plan', () => {
    expect(planPath([], { x0: 0, x1: 10 }, 0, 10)).toBe('');
  });
});
