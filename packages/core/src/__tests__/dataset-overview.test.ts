import { describe, it, expect } from 'vitest';
import {
  OVERVIEW_PARAMS,
  HEIGHT_PROBS,
  quantileSorted,
  medianOf,
  quantileRanks,
  robustZ,
  cellOverviewFromJson,
  heightShapeDistance,
  populationBaseline,
  buildDatasetOverview,
  isNearNoiseFloor,
  cellsWithFlag,
  flagCounts,
  sortCells,
  rowOfCell,
  processedCeiling,
  ceilingAt,
  fitCeilingC,
  type CellOverview,
} from '../metrics/dataset-overview.ts';

const BINS = 10;

function cell(over: Partial<CellOverview> = {}): CellOverview {
  return {
    snr: 6,
    sigma: 1,
    nu: null,
    nEvents: 20,
    isSilent: false,
    eventRateHz: 0.5,
    medianEventHeight: 5,
    heightQuantiles: HEIGHT_PROBS.map((p) => 0.5 + p),
    baselineBins: new Array(BINS).fill(100),
    baselineStart: 100,
    baselineEnd: 100,
    nAtMax: 1,
    clipFraction: 1e-4,
    nanCount: 0,
    longestGapFrames: 0,
    ...over,
  };
}

/** Twenty ordinary cells with mildly varying σ/drift so the MADs are non-zero. */
function population(n = 20): CellOverview[] {
  return Array.from({ length: n }, (_, i) =>
    cell({
      snr: 4 + i * 0.5,
      sigma: 1 + 0.02 * (i % 5),
      eventRateHz: 0.1 * (i % 7),
      heightQuantiles: HEIGHT_PROBS.map((p) => (0.5 + p) * (1 + 0.01 * (i % 3))),
      baselineEnd: 100 + (i % 4),
    }),
  );
}

describe('numeric helpers', () => {
  it('quantileSorted interpolates and handles empty input', () => {
    expect(quantileSorted([], 0.5)).toBeNaN();
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3], -1)).toBe(1);
    expect(quantileSorted([1, 2, 3], 2)).toBe(3);
  });

  it('medianOf ignores non-finite values', () => {
    expect(medianOf([3, NaN, 1, Infinity, 2])).toBe(2);
  });

  it('quantileRanks gives mid-ranks in [0, 1], ties shared, NaN for non-finite', () => {
    expect(quantileRanks([10, 30, 20])).toEqual([0, 1, 0.5]);
    expect(quantileRanks([1, 1, 2])).toEqual([0.25, 0.25, 1]);
    const r = quantileRanks([5, NaN]);
    expect(r[0]).toBe(0.5);
    expect(r[1]).toBeNaN();
  });

  it('robustZ is 0 without spread and flags a far point', () => {
    expect(robustZ([1, 1, 1])).toEqual([0, 0, 0]);
    const z = robustZ([1, 2, 3, 4, 5, 100, NaN]);
    expect(z[5]).toBeGreaterThan(OVERVIEW_PARAMS.outlierZ);
    expect(Math.abs(z[2])).toBeLessThan(1);
    expect(z[6]).toBe(0);
  });
});

describe('cellOverviewFromJson', () => {
  it('maps snake_case to camelCase and nulls to NaN', () => {
    const c = cellOverviewFromJson({
      snr: 5,
      sigma: 2,
      nu: null,
      n_events: 3,
      is_silent: false,
      event_rate_hz: 0.1,
      median_event_height: 4,
      height_quantiles: [1],
      baseline_bins: [1, null],
      baseline_start: null,
      baseline_end: 2,
      n_at_max: 1,
      clip_fraction: 0.01,
      nan_count: 0,
      longest_gap_frames: 0,
    });
    expect(c.nEvents).toBe(3);
    expect(c.baselineBins[1]).toBeNaN();
    expect(c.baselineStart).toBeNaN();
    expect(c.baselineEnd).toBe(2);
    expect(c.nu).toBeNull();
  });
});

describe('heightShapeDistance', () => {
  it('is 0 for identical shapes and grows with a different tail', () => {
    const q = HEIGHT_PROBS.map((p) => 0.5 + p);
    expect(heightShapeDistance(q, q)).toBe(0);
    const wide = q.map((v, k) => (k > 15 ? v * 3 : v));
    expect(heightShapeDistance(wide, q)).toBeCloseTo(Math.log(3));
  });

  it('is NaN for empty/mismatched or non-positive inputs', () => {
    expect(heightShapeDistance([], [])).toBeNaN();
    expect(heightShapeDistance([1], [1, 2])).toBeNaN();
    expect(heightShapeDistance([0], [1])).toBeNaN();
  });
});

describe('populationBaseline', () => {
  it('uses ratio mode for positive F0 and reports end/start ratios', () => {
    const cells = [
      cell({ baselineBins: Array.from({ length: BINS }, (_, k) => 100 - k), baselineEnd: 91 }),
      cell(),
    ];
    const b = populationBaseline(cells, 100)!;
    expect(b.mode).toBe('ratio');
    expect(b.time).toHaveLength(BINS);
    expect(b.time[0]).toBeCloseTo(5);
    expect(b.drift[0]).toBeCloseTo(0.91);
    expect(b.drift[1]).toBe(1);
    expect(b.median[0]).toBeGreaterThan(b.median[BINS - 1]);
    expect(b.q25[0]).toBeLessThanOrEqual(b.q75[0]);
  });

  it('uses sigma mode for ΔF/F-like data centred near zero', () => {
    const cells = [
      cell({ baselineBins: new Array(BINS).fill(0), baselineStart: 0, baselineEnd: 2, sigma: 0.5 }),
      cell({ baselineBins: new Array(BINS).fill(0.1), baselineStart: 0.1, baselineEnd: 0.1 }),
      cell({ baselineBins: [], baselineStart: 0, baselineEnd: 0, sigma: 0 }),
    ];
    const b = populationBaseline(cells, 10)!;
    expect(b.mode).toBe('sigma');
    expect(b.drift[0]).toBeCloseTo(4);
    expect(b.drift[1]).toBe(0);
    expect(b.drift[2]).toBeNaN();
    expect(b.median[0]).toBe(0);
  });

  it('returns null without cells or bins', () => {
    expect(populationBaseline([], 10)).toBeNull();
    expect(populationBaseline([cell({ baselineBins: [] })], 10)).toBeNull();
  });

  it('ratio mode gives NaN for a non-positive median or start', () => {
    const cells = [
      ...population(9),
      cell({ baselineBins: new Array(BINS).fill(0), baselineStart: 100, baselineEnd: 100 }),
    ];
    const b = populationBaseline(cells, 10)!;
    expect(b.mode).toBe('ratio');
    expect(b.drift[9]).toBe(1);
  });
});

describe('buildDatasetOverview flags', () => {
  it('flags silent, clipped, gap and outlier cells and nothing else', () => {
    const cells = population();
    cells[1] = { ...cells[1], isSilent: true, heightQuantiles: [] };
    cells[2] = { ...cells[2], nAtMax: OVERVIEW_PARAMS.clipMinSamples };
    cells[3] = { ...cells[3], nanCount: 5, longestGapFrames: 5 };
    cells[4] = { ...cells[4], sigma: 20 };
    cells[5] = { ...cells[5], heightQuantiles: HEIGHT_PROBS.map((p) => (0.5 + p) ** 4) };
    cells[6] = { ...cells[6], baselineEnd: 160 };
    const o = buildDatasetOverview(cells, 30, 3000);

    expect(o.kind).toBe('dataset-overview');
    expect(o.durationS).toBe(100);
    expect(o.flags[0]).toEqual([]);
    expect(o.flags[1]).toEqual(['silent']);
    expect(o.flags[2]).toEqual(['clipped']);
    expect(o.flags[3]).toEqual(['gap']);
    expect(o.flags[4]).toEqual(['outlier-noise']);
    expect(o.flags[5]).toEqual(['outlier-height']);
    expect(o.flags[6]).toEqual(['outlier-drift']);
    for (let i = 7; i < cells.length; i++) expect(o.flags[i]).toEqual([]);
    expect(o.heightDistance[1]).toBeNaN();
    expect(cellsWithFlag(o, 'gap')).toEqual([3]);

    const counts = flagCounts(o);
    expect(counts.anyFlag).toBe(6);
    expect(counts.byFlag.find((f) => f.flag === 'silent')!.count).toBe(1);
  });

  it('ranks SNR within the dataset and reports its median', () => {
    const o = buildDatasetOverview(population(5), 30, 300);
    expect(o.snrRank).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(o.medianSnr).toBe(5);
  });

  it('handles no events anywhere and a zero sampling rate', () => {
    const o = buildDatasetOverview([cell({ heightQuantiles: [] })], 0, 100);
    expect(o.pooledHeights).toBeNull();
    expect(o.durationS).toBe(0);
    expect(o.heightDistance[0]).toBeNaN();
  });

  it('works when no baseline is available', () => {
    const o = buildDatasetOverview([cell({ baselineBins: [] })], 30, 30);
    expect(o.baseline).toBeNull();
    expect(o.flags[0]).toEqual([]);
  });

  it('sigma-mode drift outliers use the raw σ-unit change', () => {
    const cells = population().map((c, i) => ({
      ...c,
      baselineBins: new Array(BINS).fill(0),
      baselineStart: 0,
      baselineEnd: 0.1 * (i % 4),
    }));
    cells[7] = { ...cells[7], baselineEnd: 30 };
    const o = buildDatasetOverview(cells, 30, 3000);
    expect(o.baseline!.mode).toBe('sigma');
    expect(o.flags[7]).toContain('outlier-drift');
  });
});

describe('sorting', () => {
  const cells = [
    cell({ snr: 3, eventRateHz: 1 }),
    cell({ snr: 9, eventRateHz: 0.2 }),
    cell({ snr: NaN, eventRateHz: 0.2, isSilent: true }),
    cell({ snr: 5, eventRateHz: 2, nanCount: 2 }),
  ];
  const o = buildDatasetOverview(cells, 30, 300);

  it('keeps index order by default', () => {
    expect(sortCells(o, 'index')).toEqual([0, 1, 2, 3]);
  });
  it('sorts SNR high to low with non-finite last', () => {
    expect(sortCells(o, 'snr')).toEqual([1, 3, 0, 2]);
  });
  it('sorts event rate high to low, ties by index', () => {
    expect(sortCells(o, 'eventRate')).toEqual([3, 0, 1, 2]);
  });
  it('puts flagged cells first, weakest SNR first', () => {
    const order = sortCells(o, 'flags');
    expect(order.slice(0, 2).sort()).toEqual([2, 3]);
    expect(order.slice(2)).toEqual([0, 1]);
  });
  it('rowOfCell inverts the order', () => {
    expect(Array.from(rowOfCell([2, 0, 1]))).toEqual([1, 2, 0]);
  });
});

describe('noise floor', () => {
  it('marks SNR up to the band edge', () => {
    expect(isNearNoiseFloor(2.7)).toBe(true);
    expect(isNearNoiseFloor(OVERVIEW_PARAMS.noiseFloorBandHi)).toBe(true);
    expect(isNearNoiseFloor(3.5)).toBe(false);
    expect(isNearNoiseFloor(NaN)).toBe(false);
  });
});

describe('PVE ceiling', () => {
  it('processedCeiling is 1 − σ²/Var(working)', () => {
    const w = [1, -1, 1, -1];
    expect(processedCeiling(w, 0.25)).toBeCloseTo(0.75);
  });

  it('processedCeiling is null without noise, data or variance', () => {
    expect(processedCeiling(undefined, 1)).toBeNull();
    expect(processedCeiling([1], 1)).toBeNull();
    expect(processedCeiling([1, -1], 0)).toBeNull();
    expect(processedCeiling([1, -1], undefined)).toBeNull();
    expect(processedCeiling([2, 2, 2], 1)).toBeNull();
  });

  it('ceilingAt follows c·SNR²/(c·SNR²+1)', () => {
    expect(ceilingAt(1, 1)).toBe(0.5);
    expect(ceilingAt(0.25, 4)).toBeCloseTo(0.8);
    expect(ceilingAt(0, 10)).toBe(0);
  });

  it('fitCeilingC recovers c from exact ceilings', () => {
    const c = 0.3;
    const pts = Array.from({ length: 12 }, (_, i) => {
      const snr = 3 + i;
      return { snr, ceiling: ceilingAt(c, snr) };
    });
    const fit = fitCeilingC(pts)!;
    expect(fit.c).toBeCloseTo(c, 10);
    expect(fit.logCSe).toBeCloseTo(0, 10);
    expect(fit.n).toBe(12);
  });

  it('fitCeilingC skips unusable points and needs enough cells', () => {
    const pts = [
      { snr: 0, ceiling: 0.5 },
      { snr: 5, ceiling: 1 },
      { snr: 5, ceiling: 0 },
      { snr: 4, ceiling: 0.8 },
      { snr: 6, ceiling: 0.95 },
    ];
    expect(fitCeilingC(pts)).toBeNull();
    const fit = fitCeilingC(pts, 2)!;
    expect(fit.n).toBe(2);
    expect(fit.logCSe).toBeGreaterThan(0);
  });
});
