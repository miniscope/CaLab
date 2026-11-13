import { describe, expect, it } from 'vitest';
import type { StageActivity, StageName } from '../lib/run-stages.ts';
import {
  autoStatusText,
  nextAutoAction,
  type AutoInput,
  type LibraryMode,
} from '../lib/session-run.ts';

function input(
  over: Partial<AutoInput> & { mode?: LibraryMode; refineRuns?: number } = {},
): AutoInput {
  const { mode, refineRuns, ...rest } = over;
  const availability: Record<StageName, string | null> = {
    discover: null,
    refine: null,
    extract: null,
  };
  return {
    settings: { mode: mode ?? 'separate', refineRuns: refineRuns ?? 1 },
    discover: 'done',
    refine: 'idle',
    extract: 'idle',
    refinesDone: 0,
    availability,
    exported: false,
    exporting: false,
    session: 0,
    sessions: 3,
    ...rest,
  };
}

const act = (s: StageActivity) => s;

describe('nextAutoAction', () => {
  it('waits while any stage runs', () => {
    for (const stage of ['discover', 'refine', 'extract'] as const) {
      expect(nextAutoAction(input({ [stage]: act('running') }))).toEqual({ kind: 'wait' });
    }
  });

  it('waits while exporting', () => {
    expect(nextAutoAction(input({ extract: 'done', exporting: true }))).toEqual({ kind: 'wait' });
  });

  it('running takes priority over an error elsewhere', () => {
    expect(nextAutoAction(input({ discover: 'error', refine: 'running' }))).toEqual({
      kind: 'wait',
    });
  });

  it.each([
    ['discover', 'error', 'Discover stopped with an error.'],
    ['refine', 'error', 'Refine stopped with an error.'],
    ['extract', 'error', 'Extract stopped with an error.'],
    ['discover', 'cancelled', 'Discover was cancelled.'],
    ['refine', 'cancelled', 'Refine was cancelled.'],
    ['extract', 'cancelled', 'Extract was cancelled.'],
  ] as const)('stops when %s is %s', (stage, st, reason) => {
    expect(nextAutoAction(input({ [stage]: st }))).toEqual({ kind: 'stopped', reason });
  });

  it('stops in apply mode', () => {
    expect(nextAutoAction(input({ mode: 'apply' }))).toEqual({
      kind: 'stopped',
      reason: 'Apply is not available yet.',
    });
  });

  it('waits until discover is done', () => {
    expect(nextAutoAction(input({ discover: 'idle' }))).toEqual({ kind: 'wait' });
  });

  it('refines while refinesDone < refineRuns and refine is available', () => {
    expect(nextAutoAction(input({ refineRuns: 2, refinesDone: 0 }))).toEqual({ kind: 'refine' });
    expect(nextAutoAction(input({ refineRuns: 2, refinesDone: 1, refine: 'done' }))).toEqual({
      kind: 'refine',
    });
  });

  it('extracts once the refines are reached', () => {
    expect(nextAutoAction(input({ refineRuns: 2, refinesDone: 2, refine: 'done' }))).toEqual({
      kind: 'extract',
    });
  });

  it('extracts straight after discover with refineRuns 0', () => {
    expect(nextAutoAction(input({ refineRuns: 0 }))).toEqual({ kind: 'extract' });
  });

  it('waits when the wanted stage is unavailable for another reason', () => {
    const availability = {
      discover: null,
      refine: null,
      extract: 'Waiting for the final library.',
    };
    expect(nextAutoAction(input({ refineRuns: 0, availability }))).toEqual({ kind: 'wait' });
    expect(nextAutoAction(input({ availability: { ...availability, refine: 'Busy.' } }))).toEqual({
      kind: 'wait',
    });
  });

  it('exports when extract is done and not yet exported', () => {
    for (const mode of ['separate', 'joint'] as const)
      expect(nextAutoAction(input({ mode, extract: 'done' }))).toEqual({ kind: 'export' });
  });

  it('separate: next-session after export unless last', () => {
    expect(nextAutoAction(input({ extract: 'done', exported: true, session: 0 }))).toEqual({
      kind: 'next-session',
    });
    expect(nextAutoAction(input({ extract: 'done', exported: true, session: 1 }))).toEqual({
      kind: 'next-session',
    });
    expect(nextAutoAction(input({ extract: 'done', exported: true, session: 2 }))).toEqual({
      kind: 'finished',
    });
  });

  it('joint: finished after export regardless of session index', () => {
    for (const session of [0, 1, 2])
      expect(
        nextAutoAction(input({ mode: 'joint', extract: 'done', exported: true, session })),
      ).toEqual({ kind: 'finished' });
  });

  describe('no cells', () => {
    const availability = {
      discover: null,
      refine: 'No cells were found.',
      extract: 'No cells were found.',
    };
    const skipped = 'no cells were found';

    it('separate, not last: next-session with skipped', () => {
      expect(nextAutoAction(input({ availability, session: 0 }))).toEqual({
        kind: 'next-session',
        skipped,
      });
    });
    it('separate, last: finished with skipped', () => {
      expect(nextAutoAction(input({ availability, session: 2 }))).toEqual({
        kind: 'finished',
        skipped,
      });
    });
    it('joint: finished with skipped', () => {
      expect(nextAutoAction(input({ availability, mode: 'joint', session: 0 }))).toEqual({
        kind: 'finished',
        skipped,
      });
    });
    it('applies when extract is the wanted stage too', () => {
      expect(nextAutoAction(input({ availability, refineRuns: 0 }))).toEqual({
        kind: 'next-session',
        skipped,
      });
    });
  });
});

describe('autoStatusText', () => {
  const pos = { session: 1, sessions: 4 };
  it('describes each action', () => {
    expect(autoStatusText({ kind: 'wait' }, pos)).toBe('Running session 2 of 4');
    expect(autoStatusText({ kind: 'refine' }, pos)).toBe('Starting Refine on session 2 of 4');
    expect(autoStatusText({ kind: 'extract' }, pos)).toBe('Starting Extract on session 2 of 4');
    expect(autoStatusText({ kind: 'export' }, pos)).toBe('Writing results');
    expect(autoStatusText({ kind: 'next-session' }, pos)).toBe('Opening the next session');
    expect(autoStatusText({ kind: 'finished' }, pos)).toBe('All sessions done');
  });
  it('mentions skips and stops', () => {
    expect(autoStatusText({ kind: 'next-session', skipped: 'no cells were found' }, pos)).toBe(
      'Skipping session 2 of 4: no cells were found',
    );
    expect(autoStatusText({ kind: 'stopped', reason: 'Extract was cancelled.' }, pos)).toBe(
      'Stopped: Extract was cancelled.',
    );
  });
});
