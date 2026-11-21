import { describe, expect, it } from 'vitest';
import { lookbackText } from '../lib/lookback-text.ts';
import type { LookbackStatus } from '../workers/lookback-types.ts';

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
      'Settling: 1,200 of 18,000 frames (spread over 23,700) · 70 of 700 cells still moving (not settled yet)',
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
      'Look-back: 9,000 frames re-read for 700 new cells · settled over 9,600 of 9,600 frames · 10 of 500 cells still moving',
    );
    expect(
      lookbackText({ ...base, settle: { ...settle, fed: 2400, stopped: true } }, true),
    ).toContain('settling stopped by you after 2,400 of 9,600 frames');
  });
});
