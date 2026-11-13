import { describe, it, expect } from 'vitest';
import {
  rectifiedBannerText,
  rectifiedCellIndices,
  RECTIFIED_INPUT_FIX,
} from '../rectified-input.ts';

describe('rectifiedCellIndices', () => {
  it('returns sorted unique flagged cells', () => {
    const entries = [
      { cellIndex: 5, rectifiedInput: true },
      { cellIndex: 2, rectifiedInput: false },
      { cellIndex: 1, rectifiedInput: true },
      { cellIndex: 5, rectifiedInput: true },
      { cellIndex: 3 },
    ];
    expect(rectifiedCellIndices(entries)).toEqual([1, 5]);
    expect(rectifiedCellIndices([])).toEqual([]);
  });
});

describe('rectifiedBannerText', () => {
  it('is empty with no flagged cells', () => {
    expect(rectifiedBannerText(0)).toBe('');
  });

  it('counts the cells and names the fix', () => {
    expect(rectifiedBannerText(1)).toMatch(/^1 cell looks clipped at zero/);
    const many = rectifiedBannerText(12);
    expect(many).toMatch(/^12 cells look clipped at zero/);
    expect(many).toContain(RECTIFIED_INPUT_FIX);
    expect(many).toContain('Extract');
    expect(many).toContain('C + YrA');
  });
});
