import { describe, it, expect } from 'vitest';
import { DEMO_PRESET_FILTER, clearedFilterState } from '../filter-state.ts';

describe('clearedFilterState', () => {
  // The browser clears filters when switching between the demo and user views:
  // each view hides the other's controls, so a leftover filter would narrow the
  // new view with nothing on screen to undo it. An indicator filter is the worst
  // case — demo rows store indicator as 'simulated', so it blanks the demo view.

  it('nulls every filter key, app-specific ones included', () => {
    expect(
      clearedFilterState({
        indicator: 'GCaMP6f (AAV)',
        species: 'Mouse',
        brainRegion: 'CA1',
        demoPreset: 'gcamp6f',
      }),
    ).toEqual({ indicator: null, species: null, brainRegion: null, demoPreset: null });
  });

  it('returns a new object rather than mutating the current state', () => {
    const current = { indicator: 'GCaMP6f (AAV)', species: null, brainRegion: null };
    const cleared = clearedFilterState(current);
    expect(cleared).not.toBe(current);
    expect(current.indicator).toBe('GCaMP6f (AAV)');
  });

  it('keeps identity when nothing is set, so clearing twice is a no-op update', () => {
    const current = { indicator: null, species: null, brainRegion: null, demoPreset: null };
    expect(clearedFilterState(current)).toBe(current);
  });
});

describe('DEMO_PRESET_FILTER', () => {
  // The dropdown must only offer ids the simulator can actually record, or a
  // selection silently matches nothing (the bug this filter had with 'clean').
  it('offers the simulator indicator ids the write side records', () => {
    expect(DEMO_PRESET_FILTER.id).toBe('demoPreset');
    expect(DEMO_PRESET_FILTER.options.map((o) => o.id)).toEqual([
      'gcamp6f',
      'gcamp6s',
      'gcamp6m',
      'jgcamp8f',
      'ogb1',
    ]);
  });
});
