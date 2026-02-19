import { describe, it, expect } from 'vitest';
import {
  INDICATOR_OPTIONS,
  SPECIES_OPTIONS,
  MICROSCOPE_TYPE_OPTIONS,
  CELL_TYPE_OPTIONS,
  BRAIN_REGION_OPTIONS,
} from '../field-options.ts';

const ALL_ARRAYS = {
  INDICATOR_OPTIONS,
  SPECIES_OPTIONS,
  MICROSCOPE_TYPE_OPTIONS,
  CELL_TYPE_OPTIONS,
  BRAIN_REGION_OPTIONS,
} as const;

describe('field-options arrays', () => {
  it('all 5 arrays are non-empty', () => {
    for (const [name, arr] of Object.entries(ALL_ARRAYS)) {
      expect(arr.length, `${name} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('all items are non-empty strings', () => {
    for (const [name, arr] of Object.entries(ALL_ARRAYS)) {
      for (const item of arr) {
        expect(typeof item, `${name} contains non-string`).toBe('string');
        expect(item.length, `${name} contains empty string`).toBeGreaterThan(0);
      }
    }
  });

  it('no duplicates in any array', () => {
    for (const [name, arr] of Object.entries(ALL_ARRAYS)) {
      const unique = new Set(arr);
      expect(unique.size, `${name} has duplicates`).toBe(arr.length);
    }
  });

  it('INDICATOR_OPTIONS has at least 30 items', () => {
    expect(INDICATOR_OPTIONS.length).toBeGreaterThanOrEqual(30);
  });

  it('BRAIN_REGION_OPTIONS has at least 60 items', () => {
    expect(BRAIN_REGION_OPTIONS.length).toBeGreaterThanOrEqual(60);
  });
});
