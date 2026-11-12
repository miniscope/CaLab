// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  churnPerMin,
  CONVERGENCE_RULE,
  ConvergenceHistory,
  convergenceStatus,
  correlation,
  demixVerdict,
  EditRates,
  followsMotion,
  FLAG_CORRELATED_PAIR,
  FLAG_FOLLOWS_MOTION,
  FLAG_LIKELY_DUPLICATE,
  FLAG_LOW_SNR,
  FLAG_UNMEASURED,
  normalize,
  parseQc,
  sortRows,
  verdict,
  type CellQcRow,
  type ConvergencePoint,
  type EditTotals,
  type QcWire,
} from '../lib/qc.ts';
import {
  FAIL_RGB,
  fpErrorScale,
  PASS_RGB,
  PROBATION_RGB,
  qcColor,
  residualMax,
  residualRgba,
  UNKNOWN_RGB,
} from '../lib/qc-colors.ts';

function row(over: Partial<CellQcRow>): CellQcRow {
  return {
    id: 1,
    slot: 0,
    ageFrames: 2000,
    frames: 1200,
    peakSnr: 10,
    eventRate: 3,
    projR: 0.9,
    vif: 1.1,
    maxOverlap: 0.2,
    maxNeighbourR: 0.1,
    maxNeighbourId: -1,
    fpError: 0.1,
    nNeighbours: 1,
    fpLastR: 1,
    slowFrac: 0.3,
    zeroFrac: 0.2,
    diffSkew: 1,
    fpRadiusPx: 4,
    motionR2: 0.01,
    flags: 0,
    pass: true,
    ...over,
  };
}

describe('motion R2 (trace follows motion)', () => {
  it('flags above 0.2 by value or by flag bit, never negative or NaN', () => {
    expect(followsMotion(row({ motionR2: 0.35 }))).toBe(true);
    expect(followsMotion(row({ motionR2: 0.2 }))).toBe(false);
    expect(followsMotion(row({ motionR2: -0.05 }))).toBe(false);
    expect(followsMotion(row({ motionR2: NaN }))).toBe(false);
    expect(followsMotion(row({ motionR2: NaN, flags: FLAG_FOLLOWS_MOTION }))).toBe(true);
  });

  it('is parsed by name and does not touch the verdict', () => {
    const wire: QcWire = {
      frame: 1,
      version: 1,
      cellFields: ['id', 'motion_r2', 'flags', 'pass'],
      globalFields: [],
      cells: Float64Array.of(1, 0.4, FLAG_FOLLOWS_MOTION, 1, 2, -0.1, 0, 1),
      global: new Float64Array(0),
      nbStarts: Uint32Array.of(0, 0, 0),
      nb: new Float32Array(0),
      residualDims: Uint32Array.of(0, 0, 8),
      residual: new Float32Array(0),
      buildMs: 0,
    };
    const s = parseQc(wire);
    expect(s.rows[0].motionR2).toBeCloseTo(0.4);
    expect(s.rows[1].motionR2).toBeCloseTo(-0.1);
    expect(s.rows.map(followsMotion)).toEqual([true, false]);
    expect(verdict(s.rows[0]).kind).toBe('pass');
  });

  it('sorts by value with NaN last', () => {
    const rows = [
      row({ id: 1, motionR2: NaN }),
      row({ id: 2, motionR2: 0.1 }),
      row({ id: 3, motionR2: 0.5 }),
    ];
    expect(sortRows(rows, 'motionR2', -1).map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe('parseQc', () => {
  it('reads fields by name, so a reordered or extended row still parses', () => {
    const wire: QcWire = {
      frame: 100,
      version: 3,
      cellFields: ['pass', 'extra', 'id', 'peak_snr', 'flags', 'max_neighbour_id'],
      globalFields: ['explained', 'cells', 'residual_excess'],
      cells: Float64Array.of(1, 0, 5, 12.5, 0, -1, 0, 0, 6, 3, FLAG_LOW_SNR, 5),
      global: Float64Array.of(0.6, 2, 0.4),
      nbStarts: Uint32Array.of(0, 1, 2),
      nb: Float32Array.of(6, 0.25, 0.5, 5, 0.25, 0.5),
      residualDims: Uint32Array.of(2, 1, 8),
      residual: Float32Array.of(0.5, NaN),
      buildMs: 0.2,
    };
    const s = parseQc(wire);
    expect(s.rows).toHaveLength(2);
    expect(s.rows[0]).toMatchObject({
      id: 5,
      slot: 0,
      peakSnr: 12.5,
      pass: true,
      maxNeighbourId: -1,
    });
    expect(s.rows[1]).toMatchObject({ id: 6, slot: 1, flags: FLAG_LOW_SNR, pass: false });
    // A field the wire does not carry is NaN, not a wrong column.
    expect(s.rows[0].projR).toBeNaN();
    expect(s.byId.get(6)?.maxNeighbourId).toBe(5);
    expect(s.neighbours.get(5)).toEqual([{ id: 6, overlap: 0.25, r: 0.5 }]);
    expect(s.global).toMatchObject({ explained: expect.closeTo(0.6, 6), cells: 2 });
    expect(s.residual).toMatchObject({ blocksWide: 2, blocksHigh: 1, blockPx: 8 });
  });
});

describe('verdict', () => {
  it('only the validated rule decides pass/fail; the rest are notes', () => {
    expect(verdict(undefined).kind).toBe('pending');
    expect(verdict(row({ flags: FLAG_UNMEASURED, pass: false })).label).toBe('not measured yet');
    expect(verdict(row({})).label).toBe('passes');
    // Low proj r and high vif are cautions, not failures.
    const caution = verdict(row({ projR: 0.3, vif: 2.5 }));
    expect(caution.kind).toBe('pass');
    expect(caution.notes.join(' ')).toMatch(/proj r 0.30/);
    expect(caution.notes.join(' ')).toMatch(/vif 2.5/);
    const low = verdict(row({ peakSnr: 3, flags: FLAG_LOW_SNR, pass: false }));
    expect(low).toMatchObject({ kind: 'fail', label: 'low SNR' });
    const dup = verdict(
      row({
        flags: FLAG_CORRELATED_PAIR | FLAG_LIKELY_DUPLICATE,
        pass: false,
        maxNeighbourId: 42,
        maxNeighbourR: 0.93,
      }),
    );
    expect(dup.label).toBe('possible duplicate of #42');
    // The stronger member of a correlated pair passes, with a note.
    const strong = verdict(
      row({ flags: FLAG_CORRELATED_PAIR, maxNeighbourId: 7, maxNeighbourR: 0.85 }),
    );
    expect(strong.kind).toBe('pass');
    expect(strong.notes[0]).toMatch(/#7/);
  });

  it('demixing verdict', () => {
    expect(demixVerdict(row({}), [])).toMatch(/no overlapping neighbours/);
    expect(demixVerdict(row({ maxNeighbourR: 0.2 }), [{ id: 2, overlap: 0.3, r: 0.2 }])).toMatch(
      /independent/,
    );
    expect(
      demixVerdict(row({ flags: FLAG_LIKELY_DUPLICATE, maxNeighbourId: 2 }), [
        { id: 2, overlap: 0.3, r: 0.9 },
      ]),
    ).toBe('possible split or duplicate of #2');
  });
});

describe('sortRows', () => {
  const rows = [
    row({ id: 1, peakSnr: 20 }),
    row({ id: 2, peakSnr: 3, flags: FLAG_LOW_SNR, pass: false }),
    row({ id: 3, flags: FLAG_UNMEASURED, pass: false, peakSnr: NaN }),
    row({ id: 4, peakSnr: 8, flags: FLAG_CORRELATED_PAIR }),
    row({ id: 5, peakSnr: 9 }),
    row({ id: 6, peakSnr: 1, flags: FLAG_LOW_SNR, pass: false }),
  ];
  it('flagged first (failing by SNR ascending, then pairs, passing, unmeasured)', () => {
    expect(sortRows(rows, 'flagged').map((r) => r.id)).toEqual([6, 2, 4, 5, 1, 3]);
  });
  it('by a metric, NaN last in both directions', () => {
    expect(sortRows(rows, 'peakSnr', 1).map((r) => r.id)).toEqual([6, 2, 4, 5, 1, 3]);
    expect(sortRows(rows, 'peakSnr', -1).map((r) => r.id)).toEqual([1, 5, 4, 2, 6, 3]);
  });
});

describe('trace helpers', () => {
  it('correlation skips non-finite samples', () => {
    expect(correlation([1, 2, 3, NaN, 5], [2, 4, 6, 100, 10])).toBeCloseTo(1, 10);
    expect(correlation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 10);
    expect(correlation([1, NaN], [1, 2])).toBeNaN();
  });
  it('normalize maps to [0, 1] and keeps gaps', () => {
    expect(Array.from(normalize([2, NaN, 4, 3]))).toEqual([0, NaN, 1, 0.5]);
  });
});

function point(minutes: number, over: Partial<ConvergencePoint> = {}): ConvergencePoint {
  return {
    minutes,
    cells: 300,
    explained: 0.8,
    residualExcess: 1,
    snrMedian: 10,
    passFrac: 0.7,
    stableCells: 280,
    fpStability: 1,
    traceSigmaChange: 0.01,
    stableFrac: 0.95,
    addsPerMin: 1,
    removesPerMin: 1,
    edits: edits({}),
    ...over,
  };
}

function edits(over: Partial<EditTotals>): EditTotals {
  return {
    adds: 5,
    merges: 1,
    splits: 0,
    deletes: 1,
    newAdds: 4,
    reAdds: 1,
    churned: 1,
    establishedRemovals: 1,
    ...over,
  };
}

const series = (n: number, f: (m: number) => Partial<ConvergencePoint>) =>
  Array.from({ length: n }, (_, i) => point(i * 0.25, f(i * 0.25)));

describe('convergenceStatus', () => {
  it('waits for cells, then needs the window of history and old enough cells', () => {
    expect(convergenceStatus([]).state).toBe('waiting');
    expect(convergenceStatus([point(0, { cells: 0 })]).state).toBe('waiting');
    expect(convergenceStatus([point(0), point(1)]).state).toBe('discovering');
    const young = series(20, () => ({ stableCells: 100 }));
    expect(convergenceStatus(young)).toMatchObject({ state: 'discovering' });
    expect(convergenceStatus(young).reason).toMatch(/under a minute old/);
    const unmeasured = series(20, () => ({ stableFrac: NaN }));
    expect(convergenceStatus(unmeasured).state).toBe('discovering');
  });
  it('new-cell discovery never blocks convergence', () => {
    // A library still growing by 30 new cells a minute (10 % of it) and
    // explaining more signal is converged when existing cells are stable
    // and churn is low.
    const growing = series(20, (m) => ({
      cells: 300 + 30 * m,
      stableCells: 250 + 30 * m,
      explained: 0.5 + 0.05 * m,
      addsPerMin: 30,
      edits: edits({ adds: 30, newAdds: 30 }),
    }));
    const st = convergenceStatus(growing);
    expect(st.state).toBe('converged');
    expect(st.reason).toMatch(/30\.0 new cells\/min/);
  });
  it('settling while churn is high or existing cells still change', () => {
    expect(convergenceStatus(series(20, () => ({}))).state).toBe('converged');
    // 6 re-adds + 6 churned + 3 established removals per minute: 5 % of 300.
    const churning = series(20, () => ({
      edits: edits({ reAdds: 6, churned: 6, establishedRemovals: 3 }),
    }));
    expect(convergenceStatus(churning)).toMatchObject({ state: 'settling' });
    expect(convergenceStatus(churning).reason).toMatch(/churn 5\.0%/);
    const changing = series(20, () => ({ stableFrac: 0.7 }));
    expect(convergenceStatus(changing).reason).toMatch(/30\.0% of cells still changing/);
    // Churn is averaged over the window: one busy point does not flip it.
    const blip = series(20, (m) => (m === 4.75 ? { edits: edits({ churned: 20 }) } : {}));
    expect(convergenceStatus(blip).state).toBe('converged');
    expect(churnPerMin(edits({}))).toBe(3);
    expect(CONVERGENCE_RULE.windowMin).toBe(2);
  });
});

describe('bounded histories', () => {
  it('ConvergenceHistory halves its resolution past maxPoints and keeps the newest', () => {
    const h = new ConvergenceHistory(8);
    for (let i = 0; i < 100; i++) h.push(point(i));
    expect(h.points.length).toBeLessThanOrEqual(8);
    expect(h.points.at(-1)!.minutes).toBe(99);
    for (let i = 1; i < h.points.length; i++)
      expect(h.points[i].minutes).toBeGreaterThan(h.points[i - 1].minutes);
  });
  it('EditRates: per-minute rates over the last minute of recording', () => {
    const r = new EditRates(1);
    expect(r.rates().adds).toBeNaN();
    const t = (adds: number) => edits({ adds, merges: adds / 2, deletes: 1, newAdds: adds / 2 });
    r.push(0, t(0));
    r.push(0.5, t(10));
    r.push(1, t(20));
    r.push(1.5, t(22));
    // Base is the newest sample at least a minute old (0.5): (22 - 10) / 1.
    expect(r.rates()).toMatchObject({ adds: 12, merges: 6, splits: 0, deletes: 0, newAdds: 6 });
    expect(r.rates().churned).toBe(0);
  });
});

const U = { lo: 0, hi: 1 };
const ramp = (t: number): [number, number, number] => [Math.round(255 * t), 0, 0];

describe('qc colours', () => {
  it('maps pass/status and greys out unmeasured cells', () => {
    expect(qcColor('pass', row({}), undefined, U, ramp)).toEqual(PASS_RGB);
    expect(qcColor('pass', row({ pass: false, flags: FLAG_LOW_SNR }), undefined, U, ramp)).toEqual(
      FAIL_RGB,
    );
    expect(qcColor('pass', row({ flags: FLAG_UNMEASURED }), undefined, U, ramp)).toEqual(
      UNKNOWN_RGB,
    );
    expect(qcColor('status', undefined, false, U, ramp)).toEqual(PROBATION_RGB);
    expect(qcColor('status', undefined, undefined, U, ramp)).toEqual(UNKNOWN_RGB);
    expect(qcColor('projR', row({ projR: NaN }), undefined, U, ramp)).toEqual(UNKNOWN_RGB);
    expect(qcColor('projR', row({ projR: 0 }), undefined, U, ramp)).not.toEqual(
      qcColor('projR', row({ projR: 1 }), undefined, U, ramp),
    );
  });
  it('fp_error is scaled to the data (no absolute threshold)', () => {
    const rows = Array.from({ length: 101 }, (_, i) => row({ fpError: i / 100 }));
    const s = fpErrorScale(rows);
    expect(s.lo).toBeCloseTo(0.05, 6);
    expect(s.hi).toBeCloseTo(0.95, 6);
  });
  it('residual map: transparent where only noise is left or outside the FOV', () => {
    const map = {
      blocksWide: 3,
      blocksHigh: 1,
      blockPx: 8,
      values: Float32Array.of(0, NaN, 4),
    };
    expect(residualMax(map)).toBe(4);
    const rgba = residualRgba(map);
    expect(rgba[3]).toBe(0);
    expect(rgba[7]).toBe(0);
    expect(rgba[11]).toBeGreaterThan(100);
  });
});
