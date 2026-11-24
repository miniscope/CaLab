import { describe, expect, it } from 'vitest';
import { FACTOR_TILING, factorRunPlan } from '../lib/factor-run.ts';

describe('factorRunPlan', () => {
  const base = { live: false, factors: false, compress: false, discover: true };
  it('a live stream with ?factors compresses on the offset grids and settles on its factors', () => {
    expect(factorRunPlan({ ...base, live: true, factors: true })).toEqual({
      compress: FACTOR_TILING,
      factorSettle: true,
    });
    expect(FACTOR_TILING).toBe('offset');
  });
  it('a recording with ?factors is a ?compress run (plain tiles, no factor settle)', () => {
    expect(factorRunPlan({ ...base, factors: true })).toEqual({
      compress: 'plain',
      factorSettle: false,
    });
    expect(factorRunPlan({ ...base, compress: true })).toEqual({
      compress: 'plain',
      factorSettle: false,
    });
  });
  it('a stream without ?factors is as today, with or without ?compress', () => {
    expect(factorRunPlan({ ...base, live: true })).toEqual({ compress: null, factorSettle: false });
    expect(factorRunPlan({ ...base, live: true, compress: true })).toEqual({
      compress: 'plain',
      factorSettle: false,
    });
  });
  it('a stream run without Discover has nothing to settle', () => {
    expect(factorRunPlan({ ...base, live: true, factors: true, discover: false })).toEqual({
      compress: 'plain',
      factorSettle: false,
    });
  });
});
