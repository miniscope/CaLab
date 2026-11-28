import { describe, expect, it } from 'vitest';
import { csettleReread, lookbackFacts, notSettled, settleNote } from '../lib/lookback-text.ts';
import { leaveWarning } from '../lib/export-state.ts';
import type { CsettleStatus, LookbackStatus } from '../workers/lookback-types.ts';

const base: LookbackStatus = {
  requested: 10,
  pushed: 9000,
  heldOut: 0,
  dropped: 0,
  births: 700,
  inNeed: 40,
  recordBytes: 0,
  settling: false,
  drainSteps: 0,
  capped: false,
};

const visits = {
  rate: 0.4,
  handed: 3840,
  paidAtEnd: 0,
  unpaid: 0,
  owedMax: 6,
  holds: 0,
  heldMs: 0,
  starved: 0,
  finalRound: 100,
};

describe('lookbackFacts', () => {
  it('during Discover: frames re-read for new cells and the cells still waiting', () => {
    const f = lookbackFacts(base, false);
    expect(f).toMatchObject({ phase: 'discover', reread: 9000, births: 700, inNeed: 40 });
    expect(f.settle).toBeNull();
    expect(f.csettle).toBeNull();
    expect(settleNote(f)).toBe('');
  });

  it('the settle as frames of its plan, the cells still moving, and where it samples', () => {
    const lb: LookbackStatus = {
      ...base,
      settling: true,
      settle: {
        fed: 1200,
        total: 18_000,
        recording: 23_700,
        moving: { cells: 700, above: 70 },
        stopped: false,
        done: false,
      },
    };
    const f = lookbackFacts(lb, false);
    expect(f.phase).toBe('settling');
    expect(f.settle).toMatchObject({ fed: 1200, total: 18_000, moving: { above: 70, cells: 700 } });
    expect(notSettled(f.settle!.moving!)).toBe(true);
    expect(notSettled({ above: 10, cells: 500 })).toBe(false);
    expect(settleNote(f)).toBe('spread over 23,700 frames');
  });

  it('the visit rate while the settle runs, and the visits per frame it made once done', () => {
    const settle = {
      fed: 1200,
      total: 9600,
      recording: 9600,
      moving: null,
      stopped: false,
      done: false,
      source: 'factors' as const,
      visits: { ...visits, handed: 480 },
    };
    const running = lookbackFacts({ ...base, settling: true, settle }, false);
    expect(running.settle?.visitsPerFrame).toBe(0.4);
    expect(running.settle?.moving).toBeNull();
    expect(settleNote(running)).toBe('on the factors');
    const done = lookbackFacts(
      { ...base, settle: { ...settle, fed: 9600, done: true, visits } },
      true,
    );
    expect(done.phase).toBe('done');
    expect(done.settle?.visitsPerFrame).toBeCloseTo(0.4);
  });

  it('a stopped settle and a skipped one say so', () => {
    const settle = {
      fed: 2400,
      total: 9600,
      recording: 9600,
      moving: { cells: 500, above: 10 },
      stopped: true,
      done: true,
    };
    expect(settleNote(lookbackFacts({ ...base, settle }, true))).toBe('stopped by you');
    const skipped = lookbackFacts({ ...base, settle: { ...settle, error: 'no frames' } }, true);
    expect(skipped.phase).toBe('skipped');
    expect(skipped.settle).toBeNull();
    expect(settleNote(skipped)).toBe('Final settle skipped: no frames');
  });

  it('a settle on the file says why, and a wait for the last factor window is named', () => {
    const lb: LookbackStatus = {
      ...base,
      settling: true,
      settle: {
        fed: 1200,
        total: 9000,
        recording: 9000,
        moving: null,
        stopped: false,
        done: false,
        source: 'file',
        fileReason: 'the compressor was 4,210 frames behind when Discover ended',
      },
    };
    expect(settleNote(lookbackFacts(lb, false))).toBe(
      're-reads the file: the compressor was 4,210 frames behind when Discover ended',
    );
    const waiting: LookbackStatus = {
      ...lb,
      settle: { ...lb.settle!, source: undefined, fileReason: undefined, waiting: true },
    };
    expect(settleNote(lookbackFacts(waiting, false))).toBe('waiting for the last factor window');
  });

  it('a look-back error is in the note', () => {
    expect(settleNote(lookbackFacts({ ...base, error: 'worker gone' }, false))).toBe(
      'look-back stopped: worker gone',
    );
  });
});

describe('Background settle', () => {
  const cs: CsettleStatus = {
    rate: 2,
    requested: 4816,
    fit: 3200,
    heldOut: 1584,
    dropped: 16,
    live: 12_000,
    answers: 300,
    answerMs: 9000,
    maxBlockMs: 61,
    yieldFrames: 0,
  };

  it('frames re-read so far, per live frame, against the ceiling', () => {
    expect(csettleReread(cs)).toBe(4800);
    expect(lookbackFacts({ ...base, csettle: cs }, false).csettle).toEqual({
      reread: 4800,
      perLive: 0.4,
      ceiling: 2,
    });
    expect(
      lookbackFacts({ ...base, csettle: { ...cs, live: 0, fit: 0, heldOut: 0, dropped: 0 } }, false)
        .csettle,
    ).toEqual({ reread: 0, perLive: null, ceiling: 2 });
  });
});

describe('leaving a result', () => {
  it('warns before dropping an unexported result only', () => {
    const o = { extractDone: true, exported: false, multiSession: false };
    expect(leaveWarning(o)).toContain('not been exported');
    expect(leaveWarning({ ...o, exported: true })).toBeNull();
    expect(leaveWarning({ ...o, extractDone: false })).toBeNull();
  });
});
