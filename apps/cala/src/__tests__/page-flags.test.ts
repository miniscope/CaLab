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

  const inEffect = (search: string, name: string) => urlFlags(search).flags[name].in_effect;

  it('on: a value the app acts on is in effect', () => {
    expect(inEffect('?gpu=0', 'gpu')).toBe(true);
    expect(inEffect('?flatfield=0', 'flatfield')).toBe(true);
    expect(inEffect('?lookback=0', 'lookback')).toBe(true);
    expect(inEffect('?noqc', 'noqc')).toBe(true);
    expect(inEffect('?visits=2', 'visits')).toBe(true);
    expect(inEffect('?live=ws://h', 'live')).toBe(true);
    expect(inEffect('?pass2=memory', 'pass2')).toBe(true);
    expect(inEffect('?factors=0', 'factors')).toBe(true);
    expect(inEffect('?compress&review=4', 'review')).toBe(true);
    expect(inEffect('?debug&smooth=0', 'smooth')).toBe(true);
    expect(inEffect('?debug&visitrate=off', 'visitrate')).toBe(true);
    expect(inEffect('?debug&cbacklog=4', 'cbacklog')).toBe(true);
    expect(inEffect('?debug&gpucheck=3', 'gpucheck')).toBe(true);
    expect(inEffect('?debug&cpool=2,3', 'cpool')).toBe(true);
  });

  it('Background settle: bare, `=1`, `=0`, `=yieldN` and `csrate` all act (with look-back)', () => {
    for (const q of ['?csettle', '?csettle=1', '?csettle=0', '?csettle=yield', '?csettle=yield4']) {
      expect(inEffect(q, 'csettle')).toBe(true);
    }
    expect(inEffect('?csrate=0.5', 'csrate')).toBe(true);
    expect(inEffect('?lookback=0&csettle', 'csettle')).toBe(false);
    expect(inEffect('?lookback=0&csrate=1', 'csrate')).toBe(false);
  });

  it('no-op values are not in effect', () => {
    expect(inEffect('?gpu=1', 'gpu')).toBe(false);
    expect(inEffect('?gpu', 'gpu')).toBe(false);
    expect(inEffect('?flatfield=1', 'flatfield')).toBe(false);
    expect(inEffect('?lookback', 'lookback')).toBe(false);
    expect(inEffect('?visits=', 'visits')).toBe(false);
    expect(inEffect('?pass2=x', 'pass2')).toBe(false);
    expect(inEffect('?review=4', 'review')).toBe(false);
    expect(inEffect('?debug&smooth=1', 'smooth')).toBe(false);
    expect(inEffect('?debug&smooth', 'smooth')).toBe(false);
    expect(inEffect('?debug&needfirst=0', 'needfirst')).toBe(false);
    expect(inEffect('?debug&repeatable=1', 'repeatable')).toBe(false);
    expect(inEffect('?repeatable=0', 'repeatable')).toBe(false);
    expect(inEffect('?debug&repeatable=0', 'repeatable')).toBe(true);
    expect(inEffect('?debug&visitrate=fixed', 'visitrate')).toBe(false);
    expect(inEffect('?debug&cbacklog=0', 'cbacklog')).toBe(false);
    expect(inEffect('?debug&gpucheck=0', 'gpucheck')).toBe(false);
    expect(inEffect('?debug&cpool=junk', 'cpool')).toBe(false);
    expect(inEffect('?debug&fextract=1', 'fextract')).toBe(false);
  });

  it('debug-only flags are not in effect without ?debug', () => {
    for (const q of [
      'lbpool=3',
      'lbpoolmax',
      'settlevisits=0.1',
      'cpool=2,3',
      'cbacklog=4',
      'fextract=0',
      'fwait',
      'detlog',
      'gpucheck=5',
      'needfirst',
      'pacefps=30',
      'smooth=0',
      'visitrate=auto',
    ]) {
      const name = q.split('=')[0];
      expect(inEffect(`?${q}`, name)).toBe(false);
      expect(inEffect(`?debug&${q}`, name)).toBe(true);
    }
  });

  it('in_effect matches what parsePageFlags reads, so the record cannot drift from the app', () => {
    expect(inEffect('?gpu=0', 'gpu')).toBe(!parsePageFlags('?gpu=0').gpu);
    expect(inEffect('?csettle', 'csettle')).toBe(parsePageFlags('?csettle').csettle?.on);
  });
});
