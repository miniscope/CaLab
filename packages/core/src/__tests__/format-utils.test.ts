import { describe, it, expect } from 'vitest';
import { formatDuration } from '../format-utils.ts';

describe('formatDuration', () => {
  it('returns null for null input', () => {
    expect(formatDuration(null)).toBeNull();
  });

  it('formats 30 seconds as "30.0s"', () => {
    expect(formatDuration(30)).toBe('30.0s');
  });

  it('formats 59.9 seconds as "59.9s"', () => {
    expect(formatDuration(59.9)).toBe('59.9s');
  });

  it('formats 60 seconds as "1.0 min"', () => {
    expect(formatDuration(60)).toBe('1.0 min');
  });

  it('formats 90 seconds with showBoth as "90.0s (1.5 min)"', () => {
    expect(formatDuration(90, true)).toBe('90.0s (1.5 min)');
  });

  it('formats 0 seconds as "0.0s"', () => {
    expect(formatDuration(0)).toBe('0.0s');
  });
});
