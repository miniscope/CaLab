import { describe, expect, it } from 'vitest';
import { csettleText, lookbackText } from '../lib/lookback-text.ts';
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

describe('lookbackText', () => {
  it('shows the settle as frames of its plan, and the cells still moving', () => {
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
    expect(lookbackText(lb, false)).toBe(
      'Final settle: 1,200 of 18,000 frames (spread over 23,700) · 70 of 700 cells still moving (not settled yet)',
    );
  });

  it('after the settle: what it fed, and a Stop is named', () => {
    const settle = {
      fed: 9600,
      total: 9600,
      recording: 9600,
      moving: { cells: 500, above: 10 },
      stopped: false,
      done: true,
    };
    expect(lookbackText({ ...base, settle }, true)).toBe(
      'Look-back: 9,000 frames re-read for 700 new cells · final settle over 9,600 of 9,600 frames · 10 of 500 cells still moving',
    );
    expect(
      lookbackText({ ...base, settle: { ...settle, fed: 2400, stopped: true } }, true),
    ).toContain('final settle stopped by you after 2,400 of 9,600 frames');
  });
});

describe('background settle in the status line', () => {
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
  const settle = {
    fed: 9600,
    total: 9600,
    recording: 9600,
    moving: { cells: 500, above: 10 },
    stopped: false,
    done: true,
  };

  it('off: the lines are as before', () => {
    expect(csettleText(undefined, true)).toBe('');
    expect(lookbackText(base, false)).toBe(
      'Look-back: 9,000 frames re-read for 700 new cells · 40 cells still need data',
    );
  });

  it('while Discover runs: frames re-read so far, per live frame, against the ceiling', () => {
    expect(lookbackText({ ...base, csettle: cs }, false)).toBe(
      'Look-back: 9,000 frames re-read for 700 new cells · 40 cells still need data · background settle: 4,800 saved frames re-read (0.40 per live frame, ceiling 2)',
    );
    expect(csettleText({ ...cs, live: 0, fit: 0, heldOut: 0, dropped: 0 }, true)).toBe(
      ' · background settle: 0 saved frames re-read (ceiling 2)',
    );
    expect(csettleText({ ...cs, live: 2400 }, true)).toContain('(2.0 per live frame, ceiling 2)');
  });

  it('during and after the final settle: how many frames the background settle re-read', () => {
    expect(
      lookbackText(
        { ...base, settling: true, settle: { ...settle, done: false }, csettle: cs },
        false,
      ),
    ).toBe(
      'Final settle: 9,600 of 9,600 frames · 10 of 500 cells still moving · 4,800 frames re-read by the background settle (0.40 per live frame)',
    );
    expect(lookbackText({ ...base, settle, csettle: cs }, true)).toBe(
      'Look-back: 9,000 frames re-read for 700 new cells · 4,800 frames re-read by the background settle (0.40 per live frame) · final settle over 9,600 of 9,600 frames · 10 of 500 cells still moving',
    );
  });
});
