import { describe, expect, it } from 'vitest';
import { parsePageFlags, urlFlags } from '../lib/page-flags.ts';

describe('parsePageFlags', () => {
  it('defaults: WebGPU, look-back and QC on, nothing from the URL', () => {
    const f = parsePageFlags('');
    expect(f).toMatchObject({
      debug: false,
      gpu: true,
      visits: null,
      lookbackOff: false,
      noqc: false,
      csettle: null,
      visitRate: null,
      paceFps: null,
      live: null,
    });
  });

  it('debug-only flags need ?debug', () => {
    const q =
      'lbpool=3&cpool=2,3&cbacklog=4&fextract=0&lbpoolmax&gpucheck=5&needfirst&visitrate=auto&settlevisits=off&pacefps=30&smooth=0&fwait';
    expect(parsePageFlags(`?${q}`)).toMatchObject({
      lbpool: null,
      cpool: null,
      cbacklogGb: NaN,
      frameExtract: false,
      poolAtMax: false,
      gpucheck: NaN,
      needFirst: false,
      visitRate: null,
      settleVisits: null,
      paceFps: null,
      smoothOff: false,
      fwait: false,
    });
    expect(parsePageFlags(`?debug&${q}`)).toMatchObject({
      lbpool: 3,
      cpool: { discover: 2, after: 3, extract: 3 },
      cbacklogGb: 4,
      frameExtract: true,
      poolAtMax: true,
      gpucheck: 5,
      needFirst: true,
      visitRate: 'auto',
      settleVisits: 0,
      paceFps: 30,
      smoothOff: true,
      fwait: true,
    });
  });

  it('Background settle: the URL speaks only with csettle or csrate', () => {
    expect(parsePageFlags('?csettle').csettle).toEqual({ on: true, yield: null, ceiling: null });
    expect(parsePageFlags('?csettle=0').csettle).toEqual({ on: false, yield: null, ceiling: null });
    expect(parsePageFlags('?csettle=yield').csettle).toEqual({ on: true, yield: 1, ceiling: null });
    expect(parsePageFlags('?csettle=yield4&csrate=0.5').csettle).toEqual({
      on: true,
      yield: 4,
      ceiling: 0.5,
    });
    // `csrate` alone turns the settle on (over a saved cap of 0); a bare `csrate` is a cap of 0.
    expect(parsePageFlags('?csrate').csettle).toEqual({ on: true, yield: null, ceiling: 0 });
  });

  it('keeps the old reads: visits as a number, lbpool 0 for junk, off switches only at 0', () => {
    expect(parsePageFlags('?visits=').visits).toBeNull();
    expect(parsePageFlags('?visits=2').visits).toBe(2);
    expect(parsePageFlags('?debug&lbpool=x').lbpool).toBe(0);
    expect(parsePageFlags('?gpu=0&flatfield=0&lookback=0')).toMatchObject({
      gpu: false,
      flatFieldOff: true,
      lookbackOff: true,
    });
    expect(parsePageFlags('?gpu&flatfield&lookback')).toMatchObject({
      gpu: true,
      flatFieldOff: false,
      lookbackOff: false,
    });
  });
});

describe('urlFlags', () => {
  it('records a flag the app does not read (e.g. `pipeline`) by name only', () => {
    const f = urlFlags('?pipeline=0&gpu=0');
    expect(f.flags.pipeline).toBeUndefined();
    expect(f.other_flags).toEqual(['pipeline']);
    expect(f.flags.gpu).toEqual({ value: '0', in_effect: true });
  });
});
