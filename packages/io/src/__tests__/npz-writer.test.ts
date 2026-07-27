import { describe, it, expect } from 'vitest';
import { writeNpz } from '../npz-writer.ts';
import { parseNpz } from '../npz-parser.ts';

describe('writeNpz', () => {
  it('round-trips a single named array through parseNpz', () => {
    const data = new Float32Array([1, 2, 3, 4, 5, 6]);
    const buf = writeNpz({ activity: { data, shape: [2, 3] } });

    const parsed = parseNpz(buf);
    expect(parsed.arrayNames).toEqual(['activity']);
    expect(parsed.arrays['activity'].shape).toEqual([2, 3]);
    expect(parsed.arrays['activity'].dtype).toBe('<f4');
    expect(Array.from(parsed.arrays['activity'].data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('round-trips multiple named arrays', () => {
    const buf = writeNpz({
      activity: { data: new Float32Array([1, 2, 3, 4]), shape: [2, 2] },
      alpha: { data: new Float32Array([0.5, 1.5]), shape: [2] },
    });

    const parsed = parseNpz(buf);
    expect(parsed.arrayNames.sort()).toEqual(['activity', 'alpha']);
    expect(parsed.arrays['activity'].shape).toEqual([2, 2]);
    expect(parsed.arrays['alpha'].shape).toEqual([2]);
    expect(Array.from(parsed.arrays['alpha'].data)).toEqual([0.5, 1.5]);
  });
});
