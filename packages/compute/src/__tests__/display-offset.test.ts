import { describe, it, expect } from 'vitest';
import { computeDisplayOffset } from '../display-offset.ts';

describe('computeDisplayOffset', () => {
  it('recovers the constant offset between raw and working traces', () => {
    const working = new Float32Array([0, 0.1, 2, 0.5, 0, 0.2, 3]);
    const raw = Float64Array.from(working, (v) => v + 500);
    expect(computeDisplayOffset(raw, working)).toBeCloseTo(500, 4);
  });
  it('is robust to transients that only appear in one trace', () => {
    const working = new Float32Array(101);
    const raw = new Float64Array(101).fill(100);
    raw[50] = 1e6;
    expect(computeDisplayOffset(raw, working)).toBe(100);
  });
  it('returns 0 for a missing or empty working trace', () => {
    expect(computeDisplayOffset([1, 2], null)).toBe(0);
    expect(computeDisplayOffset([], new Float32Array(0))).toBe(0);
  });
  it('is ~0 for dF/F-like data already near zero', () => {
    const w = new Float32Array([0.1, 0.2, 0.0, 0.3]);
    expect(computeDisplayOffset(Float64Array.from(w), w)).toBeCloseTo(0, 6);
  });
});
