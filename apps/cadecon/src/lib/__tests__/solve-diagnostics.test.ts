import { describe, it, expect } from 'vitest';
import { solveDiagnosticNotes, PEAK_OUTLIER_RATIO_NOTE_THRESHOLD } from '../solve-diagnostics.ts';
import { DEFAULT_MAX_FIRING_RATE, isValidMaxFiringRate } from '../max-firing-rate.ts';

describe('solveDiagnosticNotes', () => {
  it('is empty with no flags', () => {
    expect(solveDiagnosticNotes(undefined)).toEqual([]);
    expect(
      solveDiagnosticNotes({
        capLimited: false,
        noSizeFit: false,
        peakOutlierRatio: PEAK_OUTLIER_RATIO_NOTE_THRESHOLD,
        droppedSpikes: 0,
      }),
    ).toEqual([]);
  });

  it('reports each applicable diagnostic', () => {
    const notes = solveDiagnosticNotes({
      capLimited: true,
      noSizeFit: true,
      peakOutlierRatio: 5,
      droppedSpikes: 2,
    });
    expect(notes).toHaveLength(4);
    expect(notes[2].text).toContain('5.0x');
    expect(notes[3].text).toBe('2 spikes dropped');
  });
});

describe('max firing rate', () => {
  it('defaults to 300 spikes/s', () => {
    expect(DEFAULT_MAX_FIRING_RATE).toBe(300);
  });

  it('accepts (0, 10000] only', () => {
    expect(isValidMaxFiringRate(300)).toBe(true);
    expect(isValidMaxFiringRate(10000)).toBe(true);
    for (const v of [0, -1, 10001, NaN, Infinity]) expect(isValidMaxFiringRate(v)).toBe(false);
  });
});
