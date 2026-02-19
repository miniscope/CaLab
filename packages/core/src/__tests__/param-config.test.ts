import { describe, it, expect } from 'vitest';
import { PARAM_RANGES } from '../param-config.ts';

describe('PARAM_RANGES', () => {
  it('has expected keys: tauRise, tauDecay, lambda', () => {
    expect(PARAM_RANGES).toHaveProperty('tauRise');
    expect(PARAM_RANGES).toHaveProperty('tauDecay');
    expect(PARAM_RANGES).toHaveProperty('lambda');
  });

  it('has min < max for each parameter', () => {
    expect(PARAM_RANGES.tauRise.min).toBeLessThan(PARAM_RANGES.tauRise.max);
    expect(PARAM_RANGES.tauDecay.min).toBeLessThan(PARAM_RANGES.tauDecay.max);
    expect(PARAM_RANGES.lambda.min).toBeLessThan(PARAM_RANGES.lambda.max);
  });

  it('has default within [min, max] for each parameter', () => {
    for (const key of ['tauRise', 'tauDecay', 'lambda'] as const) {
      const range = PARAM_RANGES[key];
      expect(range.default).toBeGreaterThanOrEqual(range.min);
      expect(range.default).toBeLessThanOrEqual(range.max);
    }
  });

  it('has step > 0 for tauRise and tauDecay', () => {
    expect(PARAM_RANGES.tauRise.step).toBeGreaterThan(0);
    expect(PARAM_RANGES.tauDecay.step).toBeGreaterThan(0);
  });
});
