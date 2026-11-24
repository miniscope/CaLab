import { describe, expect, it } from 'vitest';
import { FactorSettle, type FactorSettleInput } from '../lib/factor-settle.ts';

const info = {
  folder: 'run-a',
  tiling: 'offset' as const,
  windows: [{ index: 0, start: 0, frames: 600 }],
  frames: 600,
  meanRank: 4,
};
const I = (o: Partial<FactorSettleInput> = {}): FactorSettleInput => ({
  session: 5,
  factorRun: true,
  waiting: true,
  final: false,
  state: 'ready',
  reason: null,
  info,
  width: 4,
  height: 3,
  ...o,
});

describe('FactorSettle', () => {
  it('begins once when the slow loop waits and the factors are ready', () => {
    const c = new FactorSettle();
    expect(c.act(I())).toEqual({
      kind: 'begin',
      session: 5,
      frames: 600,
      factors: { folder: 'run-a', windows: info.windows, width: 4, height: 3 },
    });
    expect(c.act(I())).toEqual({ kind: 'none' });
  });
  it('does nothing before the slow loop waits, while compressing, or on a run without ?factors', () => {
    const c = new FactorSettle();
    expect(c.act(I({ waiting: false }))).toEqual({ kind: 'none' });
    expect(c.act(I({ state: 'compressing' }))).toEqual({ kind: 'none' });
    expect(c.act(I({ factorRun: false }))).toEqual({ kind: 'none' });
  });
  it('fails the wait once with the reason when the factors are unusable', () => {
    const c = new FactorSettle();
    expect(c.act(I({ state: 'unusable', reason: 'The factors do not cover the stream.' }))).toEqual(
      {
        kind: 'fail',
        session: 5,
        reason: 'The factors do not cover the stream.',
      },
    );
    expect(c.act(I({ state: 'unusable', reason: 'x' }))).toEqual({ kind: 'none' });
  });
  it('releases the look-back worker once at the final library, and starts over with a new session', () => {
    const c = new FactorSettle();
    c.act(I());
    expect(c.act(I({ waiting: false, final: true }))).toEqual({ kind: 'release', session: 5 });
    expect(c.act(I({ waiting: false, final: true }))).toEqual({ kind: 'none' });
    expect(c.act(I({ session: 6 })).kind).toBe('begin');
  });
  it('a new session releases the old worker first if it was begun and never released', () => {
    const c = new FactorSettle();
    c.act(I());
    expect(c.act(I({ session: 6, waiting: false }))).toEqual({ kind: 'release', session: 5 });
  });
});
