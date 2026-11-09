import { describe, expect, it } from 'vitest';
import { cubicWeights, parsePrefilterParams } from '../lib/gpu-motion.ts';

describe('gpu-motion helpers', () => {
  it('cubic weights sum to one and interpolate at integers', () => {
    for (const t of [0, 0.25, 0.5, 0.9]) {
      const w = cubicWeights(t);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
    expect(cubicWeights(0)[1]).toBe(1);
    expect(cubicWeights(0)[2]).toBe(0);
  });

  it('parses the corrector prefilter parameters', () => {
    const p = new Float32Array([
      1, 2, 30, 40, 3, 4, 20, 25, 1, 1.5, 12.5, 3, 0.25, 0.5, 0.25, 7, 7, 9,
    ]);
    const g = parsePrefilterParams(p)!;
    expect([g.extY0, g.extX0, g.extH, g.extW]).toEqual([1, 2, 30, 40]);
    expect(g.median).toBe(true);
    expect(Array.from(g.kernel)).toEqual([0.25, 0.5, 0.25]);
    expect(g.boxes).toEqual([7, 7, 9]);
    expect(parsePrefilterParams(p.slice(0, 17))).toBeNull();
    expect(parsePrefilterParams(new Float32Array(0))).toBeNull();
  });
});
