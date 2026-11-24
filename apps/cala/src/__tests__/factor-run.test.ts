import { describe, expect, it } from 'vitest';
import { FACTOR_TILING, factorRunPlan } from '../lib/factor-run.ts';

describe('factorRunPlan', () => {
  const base = { live: false, factors: false, compress: false, discover: true };
  it('a live stream with ?factors compresses on the offset grids and settles on its factors', () => {
    expect(factorRunPlan({ ...base, live: true, factors: true })).toEqual({
      compress: FACTOR_TILING,
      factorSettle: true,
      factorFile: false,
    });
    expect(FACTOR_TILING).toBe('offset');
  });
  it('a recording with ?factors is a ?compress run (plain tiles, no factor settle)', () => {
    expect(factorRunPlan({ ...base, factors: true })).toEqual({
      compress: 'plain',
      factorSettle: false,
      factorFile: false,
    });
    expect(factorRunPlan({ ...base, compress: true })).toEqual({
      compress: 'plain',
      factorSettle: false,
      factorFile: false,
    });
  });
  it('a stream without ?factors is as today, with or without ?compress', () => {
    expect(factorRunPlan({ ...base, live: true })).toEqual({
      compress: null,
      factorSettle: false,
      factorFile: false,
    });
    expect(factorRunPlan({ ...base, live: true, compress: true })).toEqual({
      compress: 'plain',
      factorSettle: false,
      factorFile: false,
    });
  });
  it('a stream run without Discover has nothing to settle', () => {
    expect(factorRunPlan({ ...base, live: true, factors: true, discover: false })).toEqual({
      compress: 'plain',
      factorSettle: false,
      factorFile: false,
    });
  });
});

describe('factorRunPlan with ?factors=file', () => {
  const base = { live: false, factors: false, compress: false, discover: true };
  it('a recording compresses on the offset grids and is a factor file run', () => {
    expect(factorRunPlan({ ...base, factors: true, factorsFile: true })).toEqual({
      compress: FACTOR_TILING,
      factorSettle: false,
      factorFile: true,
    });
  });
  it('a stream with ?factors=file is a ?factors stream', () => {
    expect(factorRunPlan({ ...base, live: true, factors: true, factorsFile: true })).toEqual({
      compress: FACTOR_TILING,
      factorSettle: true,
      factorFile: false,
    });
  });
  it('a Joint run or a run without Discover is a plain ?compress run', () => {
    const plain = { compress: 'plain', factorSettle: false, factorFile: false };
    expect(factorRunPlan({ ...base, factors: true, factorsFile: true, joint: true })).toEqual(
      plain,
    );
    expect(factorRunPlan({ ...base, factors: true, factorsFile: true, discover: false })).toEqual(
      plain,
    );
  });
});
