import { describe, it, expect } from 'vitest';
import {
  computeSparsityRatio,
  computeResidualRMS,
  computeRSquared,
  computeFitMetrics,
} from '../metrics/solver-metrics.ts';

describe('computeSparsityRatio', () => {
  it('returns 0 for empty array', () => {
    expect(computeSparsityRatio(new Float64Array([]))).toBe(0);
  });

  it('returns 1.0 for all-zero array', () => {
    expect(computeSparsityRatio(new Float64Array([0, 0, 0, 0]))).toBe(1.0);
  });

  it('returns 0 for array with no values below threshold', () => {
    expect(computeSparsityRatio(new Float64Array([1, 2, 3, 4]))).toBe(0);
  });

  it('respects custom threshold', () => {
    const data = new Float64Array([0.001, 0.01, 0.1, 1.0]);
    expect(computeSparsityRatio(data, 0.005)).toBe(0.25); // only 0.001 is below 0.005
  });

  it('handles mix of zero and non-zero values', () => {
    const data = new Float64Array([0, 0, 1, 2]);
    expect(computeSparsityRatio(data)).toBe(0.5);
  });
});

describe('computeResidualRMS', () => {
  it('returns 0 for empty arrays', () => {
    expect(computeResidualRMS(new Float64Array([]), new Float64Array([]))).toBe(0);
  });

  it('returns 0 for length mismatch', () => {
    expect(computeResidualRMS(new Float64Array([1, 2]), new Float64Array([1]))).toBeNaN();
  });

  it('returns approximately 0 for perfect reconstruction', () => {
    const raw = new Float64Array([1, 2, 3, 4, 5]);
    const recon = new Float64Array([1, 2, 3, 4, 5]);
    expect(computeResidualRMS(raw, recon)).toBeCloseTo(0, 10);
  });

  it('computes correct RMS for known residuals', () => {
    const raw = new Float64Array([1, 2, 3, 4]);
    const recon = new Float64Array([2, 3, 4, 5]); // diff is always 1
    // sqrt(mean([1,1,1,1])) = sqrt(1) = 1
    expect(computeResidualRMS(raw, recon)).toBeCloseTo(1.0, 10);
  });
});

describe('computeRSquared', () => {
  it('returns approximately 1.0 for perfect reconstruction', () => {
    const raw = new Float64Array([1, 2, 3, 4, 5]);
    const recon = new Float64Array([1, 2, 3, 4, 5]);
    expect(computeRSquared(raw, recon)).toBeCloseTo(1.0, 10);
  });

  it('returns 0 for empty arrays', () => {
    expect(computeRSquared(new Float64Array([]), new Float64Array([]))).toBe(0);
  });

  it('returns 0 for length mismatch', () => {
    expect(computeRSquared(new Float64Array([1, 2]), new Float64Array([1]))).toBeNaN();
  });

  it('returns 1 when raw signal is constant (SS_total=0)', () => {
    const raw = new Float64Array([5, 5, 5, 5]);
    const recon = new Float64Array([5, 5, 5, 5]);
    expect(computeRSquared(raw, recon)).toBe(1);
  });

  it('returns negative value when reconstruction is worse than mean', () => {
    const raw = new Float64Array([1, 2, 3, 4, 5]);
    // Reconstruct with wildly wrong values — far from mean (3)
    const recon = new Float64Array([10, 10, 10, 10, 10]);
    expect(computeRSquared(raw, recon)).toBeLessThan(0);
  });
});

describe('computeFitMetrics', () => {
  it('compares like with like', () => {
    const ref = new Float32Array([0, 1, 2, 3]);
    const r = computeFitMetrics(ref, new Float32Array([0, 1, 2, 3]));
    expect(r).toEqual({ ok: true, residualRms: 0, rSquared: 1 });
  });

  it('surfaces a length mismatch (a windowed fit against the full raw trace) instead of 0', () => {
    const raw = new Float64Array(100).map((_, i) => Math.sin(i / 5));
    const windowedFit = new Float32Array(40);
    const r = computeFitMetrics(raw, windowedFit);
    expect(r).toEqual({
      ok: false,
      reason: 'length-mismatch',
      referenceLength: 100,
      fitLength: 40,
    });
  });

  it('reports a missing reference', () => {
    expect(computeFitMetrics(undefined, new Float32Array(5))).toMatchObject({
      ok: false,
      reason: 'no-reference',
    });
  });
});
