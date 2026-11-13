import { describe, expect, it } from 'vitest';
import { RunRecord } from '../lib/run-record.ts';
import { referenceSpan, SESSION_REFERENCE_FRAMES, sessionStart } from '../lib/session-boundary.ts';

describe('session boundaries', () => {
  it('collects the reference from the frames just before each boundary', () => {
    const R = SESSION_REFERENCE_FRAMES;
    expect(referenceSpan([1000], 0, 8)).toBeNull();
    expect(referenceSpan([1000], 1000 - R - 4, 8)).toEqual({ from: 4, to: 8 });
    expect(referenceSpan([1000], 992, 8)).toEqual({ from: 0, to: 8 });
    expect(referenceSpan([1000], 1000, 8)).toBeNull();
    expect(referenceSpan([1000, 3000], 2996, 4)).toEqual({ from: 0, to: 4 });
  });

  it('records session transforms for replays', () => {
    const rec = new RunRecord(4);
    expect(rec.snapshot().sessionTransforms).toBeUndefined();
    rec.noteSession(2, [0.75, 1, -3]);
    const snap = rec.snapshot();
    expect(snap.sessionTransforms?.[1]).toBeUndefined();
    expect(snap.sessionTransforms?.[2]).toEqual([0.75, 1, -3]);
  });

  it('reports what the stages did at a session start', () => {
    const st = sessionStart(
      { session: { index: 1, frame: 40 }, sessionAlign: [0, 0, 0, 0.05, 1.2, -0.4, 0.8, 0.79] },
      [0, 0, 0],
      [1.25, 0.1, 0.9, 1.24],
    );
    expect(st).toEqual({
      index: 1,
      frame: 40,
      transform: [0, 0, 0],
      fitted: [0.05, 1.2, -0.4],
      ncc: 0.8,
      nccUnrotated: 0.79,
      floorGain: 1.25,
      floorOffset: 0.1,
      floorKept: 0.9,
      noiseRatio: 1.24,
    });
  });
});
