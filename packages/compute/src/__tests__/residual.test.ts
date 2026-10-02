import { describe, it, expect } from 'vitest';
import {
  computeBandLayout,
  downsampleMinMax,
  residualBandSeries,
  scaleToBand,
} from '@calab/compute';

describe('computeBandLayout', () => {
  it('stacks the deconv band below the raw trace and the residual band below that', () => {
    const layout = computeBandLayout(0, 10, {
      deconvGap: 1,
      deconvScale: 0.5,
      residGap: 2,
      residScale: 0.25,
    });
    expect(layout).toEqual({
      deconvTop: -1,
      deconvBottom: -6,
      deconvHeight: 5,
      residTop: -8,
      residBottom: -10.5,
      residHeight: 2.5,
    });
  });
});

describe('scaleToBand', () => {
  it('maps [srcMin, srcMax] onto the band and keeps nulls', () => {
    expect(scaleToBand([0, 5, null, 10], 0, 10, -10, 2)).toEqual([-10, -9, null, -8]);
  });

  it('clamps values above srcMax only when clampTop is set', () => {
    expect(scaleToBand([20], 0, 10, -10, 2, { clampTop: true })).toEqual([-8]);
    expect(scaleToBand([20], 0, 10, -10, 2)).toEqual([-6]);
  });

  it('does not divide by zero on a flat source range', () => {
    expect(scaleToBand([3, 3], 3, 3, -10, 2)).toEqual([-10, -10]);
  });
});

describe('residualBandSeries', () => {
  // 10 buckets of 10 samples, each with the same pattern. In every bucket the
  // signal's max comes before its min, while the fit's min comes before its
  // max, so independently downsampled outputs pair signal-max with fit-min and
  // signal-min with fit-max.
  const signalBucket = [5, 0, 0, 0, 0, 0, 0, 0, 0, -5];
  const fitBucket = [0.5, 0.5, 0, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5];
  // True residual per bucket: [4.5, -0.5, 0, -0.5, -0.5, -0.5, -0.5, -1, -0.5, -5.5]
  const buckets = 10;
  const n = buckets * signalBucket.length;
  const x = Array.from({ length: n }, (_, i) => i);
  const signal = Array.from({ length: n }, (_, i) => signalBucket[i % 10]);
  const fit = Array.from({ length: n }, (_, i) => fitBucket[i % 10]);

  it('naive subtraction of independently downsampled series is wrong (precondition)', () => {
    const [, dsSignal] = downsampleMinMax(x, signal, buckets);
    const [, dsFit] = downsampleMinMax(x, fit, buckets);
    const naive = dsSignal.map((v, i) => (v as number) - (dsFit[i] as number));
    // Values that never occur in the true residual (whose range is [-5.5, 4.5]).
    expect(naive.slice(0, 2)).toEqual([5, -6]);
  });

  it('computes the residual at full resolution before downsampling', () => {
    // Band [0, 1]: the true residual range [-5.5, 4.5] maps exactly onto it.
    const out = residualBandSeries(x, signal, fit, buckets, 0, 1);
    expect(out.length).toBe(2 * buckets);
    for (let b = 0; b < buckets; b++) {
      // Residual max (4.5, sample 0) then min (-5.5, sample 9), in time order.
      expect(out[2 * b]).toBeCloseTo(1, 12);
      expect(out[2 * b + 1]).toBeCloseTo(0, 12);
    }
  });

  it('stays aligned with downsampleMinMax output for the same x', () => {
    const [dsX] = downsampleMinMax(x, signal, buckets);
    expect(residualBandSeries(x, signal, fit, buckets, 0, 1).length).toBe(dsX.length);
  });

  it('excludes samples before fitStartIndex', () => {
    const ones = Array.from({ length: n }, () => 1);
    const zeros = Array.from({ length: n }, () => 0);
    const out = residualBandSeries(x, ones, zeros, buckets, -10, 2, 20);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
    expect(out.slice(4).every((v) => v === -10)).toBe(true);
  });

  it('skips non-finite samples', () => {
    const sig = signal.slice();
    sig[0] = NaN;
    const out = residualBandSeries(x, sig, fit, buckets, 0, 1);
    expect(out.every((v) => v === null || Number.isFinite(v))).toBe(true);
  });

  it('returns all nulls when there is no fit', () => {
    const out = residualBandSeries(x, signal, null, buckets, 0, 1);
    expect(out.length).toBe(2 * buckets);
    expect(out.every((v) => v === null)).toBe(true);
  });
});
