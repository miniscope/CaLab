import { describe, expect, it } from 'vitest';
import { stepNumbers, stepViews, type StepInput } from '../lib/step-view.ts';
import { formatDuration } from '../lib/work-display.ts';

const base: StepInput = {
  live: false,
  discover: 'idle',
  processed: 0,
  total: 1000,
  discoverFps: 0,
  lookback: true,
  lookbackRun: false,
  settling: false,
  settleFed: 0,
  settleTotal: 1000,
  settleFps: 0,
  finalLibrary: false,
  inNeed: null,
  extract: 'idle',
  extractDone: 0,
  extractTotal: 0,
  extractFps: 0,
  autoExtract: true,
};
const states = (i: Partial<StepInput>) => stepViews({ ...base, ...i }).map((v) => v.state);

describe('stepViews', () => {
  it('walks Discover, Final settle, Extract in order', () => {
    expect(states({})).toEqual(['waiting', 'waiting', 'waiting']);
    expect(states({ discover: 'running', lookbackRun: true, processed: 500 })).toEqual([
      'running',
      'waiting',
      'waiting',
    ]);
    expect(states({ discover: 'done', lookbackRun: true, settling: true })).toEqual([
      'done',
      'running',
      'waiting',
    ]);
    expect(
      states({ discover: 'done', lookbackRun: true, finalLibrary: true, extract: 'running' }),
    ).toEqual(['done', 'done', 'running']);
    expect(
      states({ discover: 'done', lookbackRun: true, finalLibrary: true, extract: 'done' }),
    ).toEqual(['done', 'done', 'done']);
  });

  it('marks steps that will not run as off', () => {
    // Look-back off: no Final settle; Extract unticked; a live stream has neither.
    expect(states({ lookback: false })).toEqual(['waiting', 'off', 'waiting']);
    expect(states({ discover: 'running', lookbackRun: false })[1]).toBe('off');
    expect(states({ autoExtract: false })[2]).toBe('off');
    expect(states({ live: true, discover: 'running', total: Infinity })).toEqual([
      'running',
      'off',
      'off',
    ]);
  });

  it('gives progress, rate and time left for the running step only', () => {
    const [d, s] = stepViews({
      ...base,
      discover: 'running',
      lookbackRun: true,
      processed: 250,
      discoverFps: 100,
      inNeed: 3,
    });
    expect(d.fraction).toBeCloseTo(0.25, 10);
    expect(d.fps).toBe(100);
    expect(d.secondsLeft).toBeCloseTo(7.5, 10);
    expect(d.note).toContain('3 cells waiting');
    expect(s.fps).toBeNull();
    const settle = stepViews({
      ...base,
      discover: 'done',
      lookbackRun: true,
      settling: true,
      settleFed: 600,
      settleTotal: 1000,
      settleFps: 200,
    })[1];
    expect(settle.fraction).toBeCloseTo(0.6, 10);
    expect(settle.secondsLeft).toBeCloseTo(2, 10);
    expect(stepNumbers(settle, formatDuration)).toBe('60 % · 200 frames/s · 2 s left');
  });

  it('a live stream has no end: no fraction, no time left', () => {
    const d = stepViews({
      ...base,
      live: true,
      discover: 'running',
      total: Infinity,
      discoverFps: 30,
    })[0];
    expect(d.fraction).toBeNull();
    expect(d.secondsLeft).toBeNull();
    expect(stepNumbers(d, formatDuration)).toBe('30 frames/s');
  });
});

describe('stepViews and the visit hold', () => {
  it('notes the hold on Discover while it runs, not on a live stream', () => {
    const run = { discover: 'running', processed: 100, discoverFps: 80 } as const;
    expect(stepViews({ ...base, ...run, visitHold: 81.6 })[0].note).toBe(
      'held at 82 fps to keep refinement',
    );
    expect(stepViews({ ...base, ...run, lookbackRun: true, visitHold: 40 })[0].note).toBe(
      'with look-back and Background settle; held at 40 fps to keep refinement',
    );
    expect(stepViews({ ...base, ...run, visitHold: null })[0].note).toBe('');
    expect(stepViews({ ...base, ...run, live: true, visitHold: 40 })[0].note).toBe('live stream');
    expect(stepViews({ ...base, discover: 'done', visitHold: 40 })[0].note).toBe('');
  });
});
