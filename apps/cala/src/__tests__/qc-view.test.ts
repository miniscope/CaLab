// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  FLAG_CORRELATED_PAIR,
  FLAG_FOLLOWS_MOTION,
  FLAG_LIKELY_DUPLICATE,
  FLAG_LOW_SNR,
  FLAG_UNMEASURED,
  MIN_SNR,
  MOTION_R2_FLAG,
  PAIR_R,
} from '../lib/qc.ts';
import { METRIC_SCALE } from '../lib/qc-colors.ts';
import {
  filterRows,
  metricText,
  QC_METRICS,
  qcCounts,
  qcMedian,
  qcMetric,
  qcReason,
  qcStatus,
  SNR_BAR,
  thresholdTitle,
  topBySnr,
} from '../lib/qc-view.ts';
import { rangePosition } from '@calab/ui';
import { qcRow } from './qc-fixtures.ts';

const pass = qcRow({ id: 1 });
const low = qcRow({ id: 2, flags: FLAG_LOW_SNR, pass: false, peakSnr: 3 });
const dup = qcRow({ id: 3, flags: FLAG_LIKELY_DUPLICATE, pass: false, peakSnr: 12 });
const pending = qcRow({ id: 4, flags: FLAG_UNMEASURED, pass: false, peakSnr: NaN });

describe('QC status buckets', () => {
  it('puts every cell in exactly one of pass, fail and not measured', () => {
    expect([pass, low, dup, pending].map(qcStatus)).toEqual(['pass', 'fail', 'fail', 'unmeasured']);
    expect(qcStatus(undefined)).toBe('unmeasured');
    // An unmeasured row that claims pass is still unmeasured.
    expect(qcStatus(qcRow({ flags: FLAG_UNMEASURED, pass: true }))).toBe('unmeasured');
    const c = qcCounts([pass, low, dup, pending]);
    expect(c).toEqual({ all: 4, pass: 1, fail: 2, unmeasured: 1 });
    expect(c.pass + c.fail + c.unmeasured).toBe(c.all);
  });

  it('filters by status and keeps the order', () => {
    const rows = [dup, pass, low, pending];
    expect(filterRows(rows, 'all')).toBe(rows);
    expect(filterRows(rows, 'fail').map((r) => r.id)).toEqual([3, 2]);
    expect(filterRows(rows, 'unmeasured').map((r) => r.id)).toEqual([4]);
  });
});

describe('qcReason', () => {
  it('names failing rules first, then cautions', () => {
    expect(qcReason(pass)).toBe('');
    expect(qcReason(low)).toBe('low SNR');
    expect(qcReason(qcRow({ flags: FLAG_LOW_SNR | FLAG_LIKELY_DUPLICATE, pass: false }))).toBe(
      'low SNR, duplicate?',
    );
    expect(qcReason(qcRow({ flags: FLAG_CORRELATED_PAIR }))).toBe('pair');
    expect(qcReason(qcRow({ flags: FLAG_FOLLOWS_MOTION }))).toBe('motion');
    expect(qcReason(qcRow({ motionR2: MOTION_R2_FLAG + 0.1 }))).toBe('motion');
    expect(qcReason(pending)).toBe('');
  });
});

describe('topBySnr', () => {
  it('lists measured cells by SNR, largest first, ties by id', () => {
    const rows = [
      qcRow({ id: 9, peakSnr: 8 }),
      qcRow({ id: 5, peakSnr: 15 }),
      qcRow({ id: 2, peakSnr: 15 }),
      qcRow({ id: 7, peakSnr: NaN }),
      pending,
      low,
    ];
    expect(topBySnr(rows, 3).map((r) => r.id)).toEqual([2, 5, 9]);
    expect(topBySnr(rows, 10).map((r) => r.id)).toEqual([2, 5, 9, 2]);
    expect(topBySnr(rows, 0)).toEqual([]);
    expect(topBySnr([], 5)).toEqual([]);
  });
});

describe('metric specs', () => {
  it('draw the rules of qc.ts as threshold ticks on the overlay scales', () => {
    expect(qcMetric('peakSnr').threshold).toBe(MIN_SNR);
    expect(qcMetric('peakSnr').range).toEqual({ min: 1, max: 100, scale: 'log' });
    expect(qcMetric('projR').range).toEqual({
      min: METRIC_SCALE.projR.lo,
      max: METRIC_SCALE.projR.hi,
    });
    expect(qcMetric('maxNeighbourR').threshold).toBe(PAIR_R);
    expect(qcMetric('motionR2').threshold).toBe(MOTION_R2_FLAG);
    expect(qcMetric('vif').range).toEqual({ min: METRIC_SCALE.vif.lo, max: METRIC_SCALE.vif.hi });
  });

  it('give no tick where no threshold separates good from bad, and no bar without a fixed scale', () => {
    for (const k of ['projR', 'vif', 'maxOverlap', 'fpError', 'eventRate'] as const) {
      expect(qcMetric(k).threshold).toBeUndefined();
    }
    expect(qcMetric('fpError').range).toBeUndefined();
    expect(qcMetric('eventRate').range).toBeUndefined();
    for (const m of QC_METRICS) {
      if (m.range) expect(m.range.max).toBeGreaterThan(m.range.min);
      if (m.threshold !== undefined && m.range) {
        expect(m.threshold).toBeGreaterThan(m.range.min);
        expect(m.threshold).toBeLessThan(m.range.max);
      }
    }
  });

  it('formats a figure, or null (a grey dash) when not measured', () => {
    expect(metricText(qcMetric('peakSnr'), 12.345)).toBe('12.3');
    expect(metricText(qcMetric('projR'), NaN)).toBeNull();
    expect(metricText(qcMetric('projR'), undefined)).toBeNull();
  });
});

describe('population median and bar position', () => {
  it('puts SNR 10 in the middle of the log 1-100 bar and the threshold at log(MIN_SNR)/log(100)', () => {
    expect(rangePosition(10, SNR_BAR)!.t).toBeCloseTo(0.5, 12);
    expect(rangePosition(1, SNR_BAR)!.t).toBeCloseTo(0, 12);
    expect(rangePosition(100, SNR_BAR)!.t).toBeCloseTo(1, 12);
    expect(rangePosition(qcMetric('peakSnr').threshold, SNR_BAR)!.t).toBeCloseTo(
      Math.log(MIN_SNR) / Math.log(100),
      12,
    );
  });

  it('is the median of the measured, finite values only', () => {
    const rows = [
      qcRow({ id: 1, peakSnr: 10 }),
      qcRow({ id: 2, peakSnr: 30 }),
      qcRow({ id: 3, peakSnr: 20 }),
      qcRow({ id: 4, peakSnr: 999, flags: FLAG_UNMEASURED }),
      qcRow({ id: 5, peakSnr: NaN }),
    ];
    const m = qcMedian(rows, 'peakSnr')!;
    expect(m.value).toBe(20);
    expect(m.n).toBe(3);
    expect(m.title).toBe('median of 3 cells: 20.0');
    expect(qcMedian([...rows, qcRow({ id: 6, peakSnr: 40 })], 'peakSnr')!.value).toBe(25);
    expect(qcMedian([rows[3], rows[4]], 'peakSnr')).toBeNull();
    expect(qcMedian([], 'peakSnr')).toBeNull();
  });

  it('spells the threshold out', () => {
    expect(qcMetric('peakSnr').thresholdText).toBe(`pass ≥ ${MIN_SNR}`);
    expect(thresholdTitle(qcMetric('projR'))).toBeUndefined();
  });
});
