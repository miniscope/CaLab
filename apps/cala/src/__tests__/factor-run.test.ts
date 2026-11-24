import { describe, expect, it } from 'vitest';
import {
  FACTOR_TILING,
  FACTORS_REVIEW_OFF,
  factorRunPlan,
  factorsFromPage,
} from '../lib/factor-run.ts';

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

describe('factorsFromPage: the stream default and its switches', () => {
  const page = (q: string) => factorsFromPage(new URLSearchParams(q));
  const plan = (q: string, live: boolean) => {
    const p = page(q);
    return factorRunPlan({
      live,
      factors: p.factors,
      factorsFile: p.factorsFile,
      factorsDefault: p.factorsDefault,
      compress: p.compressAsked,
      discover: true,
    });
  };
  const settle = { compress: FACTOR_TILING, factorSettle: true, factorFile: false };
  const none = { compress: null, factorSettle: false, factorFile: false };
  const plain = { compress: 'plain', factorSettle: false, factorFile: false };

  it('without a switch a stream is a factor run and a recording does not compress', () => {
    expect(page('')).toMatchObject({ factorsDefault: true, compressWorker: true, review: false });
    expect(plan('', true)).toEqual(settle);
    expect(plan('', false)).toEqual(none);
  });
  it('?factors=0 runs a stream as before (no compress worker; ?compress gives plain tiles)', () => {
    expect(page('factors=0')).toMatchObject({
      factors: false,
      factorsDefault: false,
      compressWorker: false,
    });
    expect(plan('factors=0', true)).toEqual(none);
    expect(plan('factors=0&compress', true)).toEqual(plain);
  });
  it('?compress&review turns the default off and keeps the review', () => {
    expect(page('compress&review')).toMatchObject({ factorsDefault: false, review: true });
    expect(plan('compress&review', true)).toEqual(plain);
  });
  it('an explicit ?factors wins over ?review, with a warning', () => {
    expect(page('factors&compress&review')).toMatchObject({
      review: false,
      warn: FACTORS_REVIEW_OFF,
    });
    expect(page('compress&review').warn).toBeNull();
  });
  it('?compress alone: a stream is a factor run, a recording compresses plain tiles', () => {
    expect(plan('compress', true)).toEqual(settle);
    expect(plan('compress', false)).toEqual(plain);
  });
  it('?factors=gpu is ?factors=file compressed on the GPU, for a recording only', () => {
    expect(page('factors=gpu')).toMatchObject({
      factors: true,
      factorsFile: true,
      factorsGpu: true,
    });
    expect(page('factors=file').factorsGpu).toBe(false);
    const p = page('factors=gpu');
    const input = {
      factors: p.factors,
      factorsFile: p.factorsFile,
      factorsGpu: p.factorsGpu,
      compress: p.compressAsked,
      discover: true,
    };
    expect(factorRunPlan({ ...input, live: false })).toEqual({
      compress: FACTOR_TILING,
      factorSettle: false,
      factorFile: true,
      gpu: true,
    });
    expect(factorRunPlan({ ...input, live: true })).toEqual(settle);
  });
  it('?factors and ?factors=file keep their meaning', () => {
    expect(plan('factors', true)).toEqual(settle);
    expect(plan('factors', false)).toEqual(plain);
    expect(plan('factors=file', true)).toEqual(settle);
    expect(plan('factors=file', false)).toEqual({
      compress: FACTOR_TILING,
      factorSettle: false,
      factorFile: true,
    });
  });
});
