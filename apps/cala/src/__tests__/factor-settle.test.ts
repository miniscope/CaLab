import { describe, expect, it } from 'vitest';
import {
  FactorSettle,
  FileSettleChoice,
  type FactorSettleInput,
  type FileSettleInput,
} from '../lib/factor-settle.ts';

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

describe('FileSettleChoice', () => {
  const finfo = {
    folder: 'run-a',
    tiling: 'offset' as const,
    windows: [],
    frames: 1000,
    meanRank: 3,
  };
  const at = (o: Partial<FileSettleInput>): FileSettleInput => ({
    session: 1,
    factorFile: true,
    waiting: true,
    state: 'compressing',
    reason: '2 windows (1,000 frames) are still being compressed.',
    info: finfo,
    behind: 400,
    window: 600,
    msPerFrame: 25,
    width: 8,
    height: 8,
    ...o,
  });

  it('more than a window behind at the first look: the file at once, with the lag', () => {
    const c = new FileSettleChoice();
    const a = c.act(at({ behind: 4210 }));
    expect(a).toMatchObject({ kind: 'file', session: 1 });
    expect(a.kind === 'file' && a.reason).toContain('4,210 frames');
    expect(c.act(at({ state: 'ready' }))).toEqual({ kind: 'none' }); // answered once
  });

  it('at most a window behind: waits for it, then the factors', () => {
    const c = new FileSettleChoice();
    expect(c.act(at({ behind: 400 }))).toEqual({ kind: 'none' });
    // Later looks never send it to the file for the lag (only the first look decides that).
    expect(c.act(at({ behind: 900 }))).toEqual({ kind: 'none' });
    expect(c.act(at({ state: 'ready', behind: 0 }))).toEqual({
      kind: 'factors',
      session: 1,
      frames: 1000,
      factors: { folder: 'run-a', windows: [], width: 8, height: 8 },
    });
  });

  it('with a pool of 3 after Discover: waits up to 3 windows behind, and the reason names the pool', () => {
    expect(new FileSettleChoice().act(at({ behind: 1800, workers: 3 }))).toEqual({ kind: 'none' });
    const a = new FileSettleChoice().act(at({ behind: 7440, workers: 3 }));
    expect(a).toMatchObject({ kind: 'file', session: 1 });
    // 7,440 frames x 25 ms / 3 workers = 62 s.
    expect(a.kind === 'file' && a.reason).toBe(
      'the compressor was 7,440 frames, about 62 s with 3 workers, behind when Discover ended',
    );
    expect(new FileSettleChoice().act(at({ behind: 1801, workers: 3 }))).toMatchObject({
      kind: 'file',
    });
  });

  it('unusable factors (an error, the watchdog, a one-frame tail): the file with the reason', () => {
    const c = new FileSettleChoice();
    expect(c.act(at({ behind: 400 }))).toEqual({ kind: 'none' });
    expect(c.act(at({ state: 'unusable', reason: 'stalled' }))).toEqual({
      kind: 'file',
      session: 1,
      reason: 'stalled',
    });
  });

  it('nothing without the switch or while the slow loop does not ask; a new session asks again', () => {
    const c = new FileSettleChoice();
    expect(c.act(at({ factorFile: false, state: 'ready' }))).toEqual({ kind: 'none' });
    expect(c.act(at({ waiting: false, state: 'ready' }))).toEqual({ kind: 'none' });
    expect(c.act(at({ state: 'ready' }))).toMatchObject({ kind: 'factors', session: 1 });
    expect(c.act(at({ session: 2, state: 'ready' }))).toMatchObject({
      kind: 'factors',
      session: 2,
    });
  });
});
