import { describe, it, expect } from 'vitest';
import { computeCellFitMetrics, fitUnavailableReason } from '../fit-metrics.ts';

describe('computeCellFitMetrics', () => {
  const windowLen = 50;
  const working = new Float32Array(windowLen).map((_, i) => Math.sin(i / 4));
  const deconv = new Float32Array(windowLen);

  it('scores the fit against the solver working trace of the same window', () => {
    const m = computeCellFitMetrics(3, {
      filteredTrace: working,
      deconvolved: deconv,
      reconvolution: new Float32Array(working),
    });
    expect(m.fit).toEqual({ ok: true, residualRms: 0, rSquared: 1 });
    expect(m.sparsity).toBe(1);
  });

  it('does not report a number when the fit and the reference lengths differ', () => {
    // Regression: the panel scored the FULL raw trace against the windowed fit and showed 0.
    const m = computeCellFitMetrics(3, {
      filteredTrace: new Float32Array(200),
      deconvolved: deconv,
      reconvolution: new Float32Array(windowLen),
    });
    expect(m.fit.ok).toBe(false);
    expect(fitUnavailableReason(m.fit)).toMatch(/50 samples.*200 samples/);
  });

  it('reports a missing working trace', () => {
    const m = computeCellFitMetrics(0, {
      filteredTrace: undefined,
      deconvolved: deconv,
      reconvolution: new Float32Array(windowLen),
    });
    expect(m.fit).toMatchObject({ ok: false, reason: 'no-reference' });
    expect(fitUnavailableReason(m.fit)).toMatch(/working trace/);
  });
});
