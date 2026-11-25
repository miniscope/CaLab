import { describe, expect, it } from 'vitest';
import {
  createCompressStore,
  FACTOR_STALL_MS,
  factorCoverage,
  factorState,
  factorsBlocked,
  FactorWatchdog,
} from '../lib/compress-store.ts';
import type { CompressStatus } from '../workers/compress-types.ts';

const W = (index: number, start: number, frames: number) => ({ index, start, frames });
function st(o: Partial<CompressStatus> = {}): CompressStatus {
  return {
    windows: 2,
    frames: 1200,
    pending: 0,
    pendingFrames: 0,
    meanRank: 5,
    msPerFrame: 1,
    factorBytes: 10,
    final: true,
    tiling: 'offset',
    source: 'discover',
    folder: 'run-a',
    compressed: [W(0, 0, 600), W(1, 600, 600)],
    ...o,
  };
}

describe('factorCoverage', () => {
  it('counts the frames covered from 0 and finds the first gap', () => {
    expect(factorCoverage([W(1, 600, 600), W(0, 0, 600)])).toEqual({ frames: 1200, gap: null });
    expect(factorCoverage([W(0, 0, 600), W(1, 700, 600)])).toEqual({ frames: 600, gap: 600 });
    expect(factorCoverage([])).toEqual({ frames: 0, gap: null });
  });
});

describe('factorState (a live run with ?factors)', () => {
  it('ready once the stream ended and every window of the offset grids is compressed', () => {
    expect(factorState(st(), null, true, 1200)).toBe('ready');
  });
  it('ready with a last window of one frame left out (it cannot be compressed)', () => {
    expect(factorState(st(), null, true, 1201)).toBe('ready');
  });
  it('compressing before the end, while windows wait, or before the first status', () => {
    expect(factorState(st(), null, false, 1200)).toBe('compressing');
    expect(factorState(st({ pending: 1, final: false }), null, true, 1800)).toBe('compressing');
    expect(factorState(null, null, true, 1200)).toBe('compressing');
  });
  it('unusable after an error, with a gap, with more than one frame missing, or on plain tiles', () => {
    expect(factorState(st(), 'quota', true, 1200)).toBe('unusable');
    expect(factorState(st({ compressed: [W(0, 0, 600), W(2, 700, 600)] }), null, true, 1300)).toBe(
      'unusable',
    );
    expect(factorState(st(), null, true, 1202)).toBe('unusable');
    expect(factorState(st({ tiling: 'plain' }), null, true, 1200)).toBe('unusable');
    expect(factorState(st({ compressed: [], windows: 0, frames: 0 }), null, true, 1)).toBe(
      'unusable',
    );
  });
  it('says why', () => {
    expect(factorsBlocked('ready', st(), null)).toBeNull();
    expect(factorsBlocked('compressing', st({ pending: 2 }), null)).toBe(
      'Waiting for the last windows to be compressed (2 waiting).',
    );
    expect(factorsBlocked('unusable', st(), 'quota exceeded')).toBe(
      'The factors cannot be read: quota exceeded',
    );
    expect(factorsBlocked('unusable', st(), null)).toBe('The factors do not cover the stream.');
  });
});

describe('FactorWatchdog', () => {
  it('fires after FACTOR_STALL_MS without a change in the compressor, and not before', () => {
    const w = new FactorWatchdog();
    w.note(st({ pending: 2, final: false }), 0);
    expect(w.stalled(FACTOR_STALL_MS - 1)).toBe(false);
    w.note(st({ pending: 1, final: false }), 60_000);
    expect(w.stalled(60_000 + FACTOR_STALL_MS - 1)).toBe(false);
    expect(w.stalled(60_000 + FACTOR_STALL_MS)).toBe(true);
    w.reset();
    expect(w.stalled(10 * FACTOR_STALL_MS)).toBe(false);
  });
});

describe('the store', () => {
  it('changed() resolves at the next status, error or reset', async () => {
    const s = createCompressStore();
    s.reset(3);
    const a = s.changed();
    s.onMessage({ type: 'status', session: 3, status: st() });
    await a;
    const b = s.changed();
    s.onMessage({ type: 'error', session: -1, message: 'crashed' });
    await b;
    const c = s.changed();
    s.reset(4);
    await c;
  });
  it('fail() makes the factors unusable with the reason', () => {
    const s = createCompressStore();
    s.reset(3);
    s.onMessage({ type: 'status', session: 3, status: st() });
    s.fail('The compressor made no progress for 120 s.');
    expect(s.factors(true, 1200)).toBe('unusable');
    expect(s.factorInfo()).toEqual({
      folder: 'run-a',
      tiling: 'offset',
      windows: st().compressed,
      frames: 1200,
      meanRank: 5,
    });
  });
});

describe('factorState for a recording (no tail)', () => {
  it('is ready only when the windows cover every frame', () => {
    expect(factorState(st(), null, true, 1200, false)).toBe('ready');
    expect(factorState(st(), null, true, 1201, false)).toBe('unusable');
    expect(factorState(st(), null, true, 1201)).toBe('ready'); // a stream keeps its tail rule
  });
});
