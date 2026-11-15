import { describe, expect, it } from 'vitest';
import { TraceHistory } from '../lib/trace-history.ts';

describe('TraceHistory block storage', () => {
  it('preserves the newest samples and reuses whole blocks when a new cell halves the share', () => {
    const h = new TraceHistory(8192, 4, 8192 * 4);
    h.push(0, 8192, [1], Float32Array.from({ length: 8192 }, (_, i) => i));

    // Observe only the implementation detail needed to prevent the old
    // resize regression: existing full blocks must survive by reference.
    const internal = h as unknown as {
      bufs: Map<number, { values: Float32Array[] }>;
    };
    const before = internal.bufs.get(1)!.values;
    h.push(8192, 1, [1, 2], [8192, 20]);

    expect(h.bytes).toBe((4096 + 1024) * 4);
    expect(h.get(1).frames).toEqual(Array.from({ length: 4096 }, (_, i) => i + 4097));
    expect(h.get(1).values.slice(0, -1)).toEqual(Array.from({ length: 4095 }, (_, i) => i + 4097));
    expect(h.get(1).values.at(-1)).toBe(8192);
    expect(h.get(2)).toEqual({ frames: [8192], values: [20] });

    const after = internal.bufs.get(1)!.values;
    expect(after.some((chunk) => before.includes(chunk))).toBe(true);
  });

  it('keeps exact frame alignment through block wrap, gaps, and bounded reads', () => {
    const h = new TraceHistory(2500);
    h.push(10, 1200, [4], Float32Array.from({ length: 1200 }, (_, i) => i));
    h.push(1215, 1500, [4], Float32Array.from({ length: 1500 }, (_, i) => 2000 + i));

    expect(h.span(4)).toEqual({ first: 215, end: 2715 });
    expect(Array.from(h.range(4, 1198, 1218))).toEqual([
      1188, 1189, 1190, 1191, 1192, 1193, 1194, 1195, 1196, 1197, 1198, 1199,
      ...new Array(5).fill(NaN), 2000, 2001, 2002,
    ]);
    expect(h.get(4).values.slice(-3)).toEqual([3497, 3498, 3499]);
    expect(h.bytes).toBe(2500 * 4);
  });

  it('bounds block fragmentation and keeps byte accounting exact through repeated resizes', () => {
    const h = new TraceHistory(8192, 64, 8192 * 64 * 4);
    h.push(0, 8192, [0], new Float32Array(8192).fill(1));
    for (let id = 1; id < 48; id++) h.push(id, 1, [0, id], [id, id]);

    const internal = h as unknown as {
      bufs: Map<number, { size: number; values: Float32Array[] }>;
    };
    for (const b of internal.bufs.values()) {
      expect(b.values.length).toBeLessThanOrEqual(Math.ceil(b.size / 1024) + 2);
    }
    const allocated = [...internal.bufs.values()].reduce(
      (sum, b) => sum + b.values.reduce((n, chunk) => n + chunk.length * 4, 0),
      0,
    );
    expect(allocated).toBe(h.bytes);
    expect(h.bytes).toBeLessThanOrEqual(h.maxBytes);
  });
});
