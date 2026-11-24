import { describe, expect, it } from 'vitest';
import { rebuildFrames, type FactorWindowLike } from '../lib/factor-frames.ts';

function fakeWindow(px: number, frames: number): FactorWindowLike & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    frames,
    start: 600,
    calls,
    reconstruct(t0, count, out) {
      calls.push([t0, count]);
      for (let k = 0; k < count; k++)
        for (let p = 0; p < px; p++) out[k * px + p] = 100 * (t0 + k) + p;
    },
    neverValid: () => Uint8Array.of(0, 1, 0, 0),
    free() {},
  };
}

describe('rebuildFrames', () => {
  it('rebuilds the frames and puts NaN where the window never had a valid sample', () => {
    const w = fakeWindow(4, 10);
    const out = new Float32Array(8);
    rebuildFrames(w, w.neverValid!(), 3, 2, out);
    expect(w.calls).toEqual([[3, 2]]);
    expect([...out]).toEqual([300, NaN, 302, 303, 400, NaN, 402, 403]);
  });
  it('without a mask the rebuilt frames stay as they are', () => {
    const w = fakeWindow(4, 10);
    const out = new Float32Array(4);
    rebuildFrames(w, null, 0, 1, out);
    expect([...out]).toEqual([0, 1, 2, 3]);
  });
});
