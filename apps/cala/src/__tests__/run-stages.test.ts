import { describe, expect, it } from 'vitest';
import {
  createStageLog,
  EXTRACT_AFTER_DISCOVER_DEFAULT,
  LIVE_NOTE,
  NEXT_STEP_HINT,
  perMinute,
  showNextStepHint,
  stageAvailability,
  STAGE_LABEL,
  type StageInput,
} from '../lib/run-stages.ts';

const READY: StageInput = {
  live: false,
  discover: 'done',
  extract: 'idle',
  finalLibrary: true,
  cells: 12,
  replayBlocked: null,
};

describe('stage availability (the order of the stages)', () => {
  it('runs Extract only after Discover has finished with its final library', () => {
    expect(stageAvailability(READY)).toEqual({ discover: null, extract: null });
    for (const discover of ['idle', 'running', 'error'] as const) {
      expect(stageAvailability({ ...READY, discover }).extract).toMatch(/Discover/);
    }
    expect(stageAvailability({ ...READY, finalLibrary: false }).extract).toMatch(/final library/);
    expect(stageAvailability({ ...READY, cells: 0 }).extract).toMatch(/No cells/);
    expect(stageAvailability({ ...READY, replayBlocked: 'gap' }).extract).toBe('gap');
  });

  it('runs one replay at a time: no Discover while Extract runs, Extract again afterwards', () => {
    const extracting = stageAvailability({ ...READY, extract: 'running' });
    expect(extracting.extract).toBe('Extract is running.');
    expect(extracting.discover).toBe('Extract is running.');
    expect(stageAvailability({ ...READY, extract: 'done' }).extract).toBeNull();
    expect(stageAvailability({ ...READY, extract: 'cancelled' }).extract).toBeNull();
  });

  it('streams Discover only, with the note about loading a saved stream', () => {
    const a = stageAvailability({ ...READY, live: true });
    expect(a.discover).toBeNull();
    expect(a.extract).toBe(LIVE_NOTE);
    expect(LIVE_NOTE).toMatch(/load it as a recording/);
  });

  it('has no Refine stage any more (only saved results mention one)', () => {
    expect(Object.keys(stageAvailability(READY))).toEqual(['discover', 'extract']);
    expect(STAGE_LABEL.refine).toMatch(/removed/);
  });
});

describe('stage log', () => {
  it('numbers the runs per stage, closes the newest one, and starts over', () => {
    let t = Date.parse('2026-11-13T10:00:00Z');
    const log = createStageLog(() => new Date((t += 1000)));
    log.begin('discover');
    log.end('discover', 'done', { frames: 600, refines: 30 });
    log.begin('extract');
    log.end('extract', 'done', { frames: 600 });
    log.begin('extract');
    expect(log.runs().map((r) => `${r.stage}${r.index}:${r.outcome}`)).toEqual([
      'discover1:done',
      'extract1:done',
      'extract2:running',
    ]);
    log.end('extract', 'cancelled', { frames: 100 });
    expect(log.last('extract')).toMatchObject({ index: 2, outcome: 'cancelled', frames: 100 });
    expect(log.runs()[0].startedAt).toBe('2026-11-13T10:00:01.000Z');
    expect(log.runs()[0].endedAt).toBe('2026-11-13T10:00:02.000Z');
    // Ending a stage that is not running changes nothing.
    log.end('discover', 'done', {});
    expect(log.runs()).toHaveLength(3);
    log.reset();
    expect(log.runs()).toEqual([]);
  });
});

describe('rates', () => {
  it('rates refines per minute of recording', () => {
    expect(perMinute(30, 1200, 20)).toBe(30);
    expect(perMinute(30, 1200, 0)).toBeNull();
  });
});

describe('Extract after Discover default and the next-step hint', () => {
  const HINT_IN = { live: false, discover: 'done', extract: 'idle' } as const;

  it('is on by default for recordings', () => {
    expect(EXTRACT_AFTER_DISCOVER_DEFAULT).toBe(true);
  });

  it('shows the hint after Discover, before any Extract', () => {
    expect(NEXT_STEP_HINT).toBe('Extract to solve the final traces with the settled footprints.');
    expect(showNextStepHint(HINT_IN)).toBe(true);
  });

  it('hides the hint for live streams, during Discover, and once Extract has run', () => {
    expect(showNextStepHint({ ...HINT_IN, live: true })).toBe(false);
    expect(showNextStepHint({ ...HINT_IN, discover: 'running' })).toBe(false);
    expect(showNextStepHint({ ...HINT_IN, extract: 'running' })).toBe(false);
    expect(showNextStepHint({ ...HINT_IN, extract: 'done' })).toBe(false);
  });
});
