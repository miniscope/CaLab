import { describe, it, expect } from 'vitest';
import { ordinal, percentileLabel, describeSnr, snrTag } from '../snr-display.ts';

describe('percentile labels', () => {
  it('uses English ordinals, including the teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 62, 93].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '62nd',
      '93rd',
    ]);
  });

  it('clamps to 1..99 and tolerates NaN', () => {
    expect(percentileLabel(0)).toBe('1st percentile');
    expect(percentileLabel(1)).toBe('99th percentile');
    expect(percentileLabel(0.5)).toBe('50th percentile');
    expect(percentileLabel(NaN)).toBe('');
  });
});

describe('describeSnr', () => {
  it('states the shared metric, the percentile and that colour is not a grade', () => {
    const t = describeSnr({ snr: 8.34, rank: 0.8, nCells: 200 });
    expect(t).toContain('Measured SNR 8.3, 80th percentile of 200 cells');
    expect(t).toContain('not a grade');
    expect(t).not.toContain('≈ noise');
  });

  it('flags a near-noise cell and a silent cell', () => {
    expect(describeSnr({ snr: 2.7 })).toContain('≈ noise');
    expect(describeSnr({ snr: 9, silent: true })).toContain('Silent');
  });
});

describe('snrTag', () => {
  it('prefers silent over ≈ noise, and is empty for a healthy cell', () => {
    expect(snrTag({ snr: 2.6, silent: true })).toBe('silent');
    expect(snrTag({ snr: 2.6 })).toBe('≈ noise');
    expect(snrTag({ snr: 3.0 })).toBe('≈ noise');
    expect(snrTag({ snr: 3.5 })).toBe('');
  });
});
