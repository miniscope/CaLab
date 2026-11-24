import { describe, expect, it, vi } from 'vitest';
import { FACTOR_CACHE, FactorReader, type FactorSolver } from '../lib/factor-reader.ts';
import type { FactorWindowLike } from '../lib/factor-frames.ts';

const PX = 3;
/** Window files whose byte 0 is the window index; window i holds frames 100*i.. (10 frames). */
function setup() {
  const reads: string[] = [];
  const files = {
    read: vi.fn(async (name: string) => {
      reads.push(name);
      return Uint8Array.of(Number(name.slice(1, -4)));
    }),
  };
  const windows = [0, 1, 2].map((i) => ({ index: i, start: 10 * i, frames: 10 }));
  const freed: number[] = [];
  const open = (bytes: Uint8Array): FactorWindowLike => {
    const i = bytes[0];
    return {
      start: 10 * i,
      frames: 10,
      reconstruct(t0, n, out) {
        for (let k = 0; k < n; k++) for (let p = 0; p < PX; p++) out[k * PX + p] = 10 * i + t0 + k;
      },
      neverValid: () => Uint8Array.of(0, 0, 1),
      free: () => void freed.push(i),
    };
  };
  const solver = (lib: Uint8Array): FactorSolver => ({
    cells: 1,
    processFrames: (y) => Float32Array.of(y[0] + 1000 * lib[0]),
    lastBackground: () => Float32Array.of(0.5),
    free: vi.fn(),
  });
  const r = new FactorReader(files, windows, PX, { open, solver });
  return { r, reads, freed };
}
const F = (frame: number) => ({ frame, block: -1 });

describe('FactorReader', () => {
  it('rebuilds the asked frames (NaN where never valid) and solves them with the newest library', async () => {
    const t = setup();
    t.r.setLibrary(4, Uint8Array.of(4));
    const out = new Float32Array(2 * PX);
    const s = await t.r.serve([F(3), F(12)], out);
    expect([...out]).toEqual([3, 3, NaN, 12, 12, NaN]);
    expect(s.version).toBe(4);
    expect([...s.traces]).toEqual([4003, 4012]);
    expect([...s.background!]).toEqual([0.5, 0.5]);
  });
  it('before a library it rebuilds but solves nothing (version 0)', async () => {
    const t = setup();
    const s = await t.r.serve([F(0)], new Float32Array(PX));
    expect(s.version).toBe(0);
    expect(s.traces).toHaveLength(0);
  });
  it('reads each window once while cached, and frees what leaves the cache', async () => {
    const t = setup();
    const out = new Float32Array(PX);
    for (const f of [0, 1, 11, 2, 21, 3]) await t.r.serve([F(f)], out);
    expect(t.reads).toEqual(['f0.bin', 'f1.bin', 'f2.bin', 'f0.bin']);
    expect(FACTOR_CACHE).toBe(2);
    expect(t.freed).toEqual([0, 1]);
  });
  it('a held-out frame (skip) is rebuilt but not solved', async () => {
    const t = setup();
    t.r.setLibrary(1, Uint8Array.of(1));
    const s = await t.r.serve([F(0), F(1)], new Float32Array(2 * PX), Uint8Array.of(0, 1));
    expect([...s.traces]).toEqual([1000, 0]);
  });
  it('refuses a frame no compressed window holds, and a file that is not the window listed', async () => {
    const t = setup();
    await expect(t.r.serve([F(30)], new Float32Array(PX))).rejects.toThrow('frame 30');
    const bad = new FactorReader(
      { read: async () => Uint8Array.of(2) },
      [{ index: 0, start: 0, frames: 10 }],
      PX,
      {
        open: (b) => ({ start: 10 * b[0], frames: 10, reconstruct() {}, free() {} }),
        solver: () => {
          throw new Error();
        },
      },
    );
    await expect(bad.serve([F(0)], new Float32Array(PX))).rejects.toThrow('f0.bin');
  });
  it('after dispose a serve fails with "look-back stopped"', async () => {
    const t = setup();
    t.r.dispose();
    await expect(t.r.serve([F(0)], new Float32Array(PX))).rejects.toThrow('look-back stopped');
  });
});
