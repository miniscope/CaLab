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
  const plan = (q: string, live: boolean, joint = false) => {
    const p = page(q);
    return factorRunPlan({
      live,
      factors: p.factors,
      factorsFile: p.factorsFile,
      factorsGpu: p.factorsGpu,
      factorsDefault: p.factorsDefault,
      compress: p.compressAsked,
      discover: true,
      joint,
    });
  };
  const settle = { compress: FACTOR_TILING, factorSettle: true, factorFile: false };
  const none = { compress: null, factorSettle: false, factorFile: false };
  const plain = { compress: 'plain', factorSettle: false, factorFile: false };
  const gpu = { compress: FACTOR_TILING, factorSettle: false, factorFile: true, gpu: true };
  const cpuFile = { compress: FACTOR_TILING, factorSettle: false, factorFile: true };

  it('without a switch a stream is a factor run and a recording a GPU factor run', () => {
    expect(page('')).toMatchObject({
      factors: false,
      factorsFile: true,
      factorsGpu: true,
      factorsDefault: true,
      compressWorker: true,
      review: false,
    });
    expect(plan('', true)).toEqual(settle);
    expect(plan('', false)).toEqual(gpu);
  });
  it('a Joint run of several sessions without a switch has no factor route', () => {
    expect(plan('', false, true)).toEqual(none);
    expect(plan('factors=gpu', false, true)).toEqual(plain);
  });
  it('?factors=0 turns factors off for streams and recordings (no compress worker)', () => {
    expect(page('factors=0')).toMatchObject({
      factors: false,
      factorsFile: false,
      factorsGpu: false,
      factorsDefault: false,
      compressWorker: false,
    });
    expect(plan('factors=0', true)).toEqual(none);
    expect(plan('factors=0', false)).toEqual(none);
    expect(plan('factors=0&compress', true)).toEqual(plain);
    expect(plan('factors=0&compress', false)).toEqual(plain);
  });
  it('?factors=file keeps the CPU route and ?factors=gpu is the default route', () => {
    expect(page('factors=file')).toMatchObject({ factorsFile: true, factorsGpu: false });
    expect(plan('factors=file', false)).toEqual(cpuFile);
    expect(plan('factors=gpu', false)).toEqual(gpu);
    expect(plan('factors=gpu', false)).toEqual(plan('', false));
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
  it('?compress alone changes no default: a stream is a factor run, a recording a GPU factor run', () => {
    expect(plan('compress', true)).toEqual(settle);
    expect(plan('compress', false)).toEqual(gpu);
  });
  it('?compress&review keeps a recording on plain tiles for the review', () => {
    expect(page('compress&review')).toMatchObject({ factorsFile: false, factorsGpu: false });
    expect(plan('compress&review', false)).toEqual(plain);
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
