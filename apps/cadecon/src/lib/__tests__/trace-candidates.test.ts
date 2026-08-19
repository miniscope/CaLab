import { describe, it, expect } from 'vitest';
import type { NpzResult } from '@calab/core';
import { soleTraceCandidate, traceCandidates } from '../trace-candidates.ts';

/** Build an NpzResult from name -> shape, with data sized to match. */
function container(shapes: Record<string, number[]>): NpzResult {
  const arrays: NpzResult['arrays'] = {};
  for (const [name, shape] of Object.entries(shapes)) {
    const count = shape.reduce((n, d) => n * d, 1);
    arrays[name] = {
      data: new Float64Array(count),
      shape,
      dtype: '<f8',
      fortranOrder: false,
    };
  }
  return { arrays, arrayNames: Object.keys(shapes) };
}

describe('traceCandidates', () => {
  describe('happy path', () => {
    it('keeps 2D matrices', () => {
      const c = container({ traces: [30, 1000] });
      expect(traceCandidates(c)).toEqual(['traces']);
    });

    it('lists matrices before vectors', () => {
      const c = container({ tvec: [1, 1000], traces: [30, 1000] });
      expect(traceCandidates(c)).toEqual(['traces', 'tvec']);
    });
  });

  describe('MATLAB degenerate dimensions', () => {
    // MATLAB stores a scalar as 1x1 and a vector as 1xN, so a bare
    // `shape.length === 2` test would offer both as trace matrices.
    it('drops 1x1 scalars', () => {
      const c = container({ traces: [3, 5], fps: [1, 1] });
      expect(traceCandidates(c)).toEqual(['traces']);
    });

    it('keeps 1xN vectors as candidates but ranks them last', () => {
      const c = container({ fps: [1, 1], tvec: [1, 5], traces: [3, 5] });
      expect(traceCandidates(c)).toEqual(['traces', 'tvec']);
    });
  });

  describe('edge cases', () => {
    it('ignores arrays that are not 2D', () => {
      const c = container({ movie: [64, 64, 100], scalar: [1], traces: [3, 5] });
      expect(traceCandidates(c)).toEqual(['traces']);
    });

    it('returns empty when nothing could hold traces', () => {
      expect(traceCandidates(container({ fps: [1, 1] }))).toEqual([]);
    });
  });
});

describe('soleTraceCandidate', () => {
  it('auto-selects a lone candidate', () => {
    expect(soleTraceCandidate(container({ traces: [30, 1000] }))).toBe('traces');
  });

  it('auto-selects a lone single-cell recording rather than prompting', () => {
    // 1xN is ambiguous in general, but with nothing to choose between there is
    // nothing to ask about.
    expect(soleTraceCandidate(container({ traces: [1, 1000] }))).toBe('traces');
  });

  it('auto-selects the only matrix among vectors and scalars', () => {
    const c = container({ traces: [3, 5], tvec: [1, 5], fps: [1, 1] });
    expect(soleTraceCandidate(c)).toBe('traces');
  });

  it('prompts when two matrices compete', () => {
    const c = container({ traces: [3, 5], raw: [3, 5] });
    expect(soleTraceCandidate(c)).toBeNull();
  });

  it('prompts when only vectors are available', () => {
    const c = container({ tvec: [1, 5], other: [1, 7] });
    expect(soleTraceCandidate(c)).toBeNull();
  });

  it('returns null when there are no candidates', () => {
    expect(soleTraceCandidate(container({ fps: [1, 1] }))).toBeNull();
  });
});
