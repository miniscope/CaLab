import { describe, expect, it } from 'vitest';
import { buildAvi, cellMovie, rowStride } from './synth-avi.ts';

describe('cellMovie', () => {
  it('gives the same frames for the same seed and other frames for another', () => {
    const a = cellMovie(96, 96, 50);
    const b = cellMovie(96, 96, 50);
    const c = cellMovie(96, 96, 50, 8);
    for (let f = 0; f < 50; f++) {
      const pa = a.payload(f);
      expect(pa).toEqual(b.payload(f));
      if (f === 0) expect(pa).not.toEqual(c.payload(f));
    }
  });

  it('puts 16 cells on the grid, brighter than the background on average', () => {
    const frames = 400;
    const m = cellMovie(96, 96, frames);
    expect(m.cells).toHaveLength(16);
    expect(m.cells[0]).toEqual([12, 12]);
    expect(m.cells[15]).toEqual([84, 84]);
    const stride = rowStride(96, 8);
    let centre = 0;
    let corner = 0;
    for (let f = 0; f < frames; f++) {
      const p = m.payload(f);
      expect(p.length).toBe(stride * 96);
      for (const [y, x] of m.cells) centre += p[y * stride + x];
      // (0, 0) is 12 px from the nearest centre: background only.
      corner += p[0];
    }
    const centreMean = centre / (frames * 16);
    const cornerMean = corner / frames;
    expect(cornerMean).toBeGreaterThan(28);
    expect(cornerMean).toBeLessThan(32);
    expect(centreMean).toBeGreaterThan(cornerMean + 3);
  });

  it('has the frames asked for, 3000 by default', () => {
    expect(cellMovie().frames).toBe(3000);
    expect(cellMovie(96, 96, 1800).frames).toBe(1800);
  });

  it('keeps transients sparse: each cell is active in a small share of frames', () => {
    // 600 frames hold about 6 transients per cell: enough for a share, quick to make.
    const frames = 600;
    const m = cellMovie(96, 96, frames);
    const stride = rowStride(96, 8);
    // Cell 0, cell 5 and cell 15; 15 grey levels over the background is 5 noise sds.
    const watched = [0, 5, 15];
    const active = watched.map(() => 0);
    for (let f = 0; f < frames; f++) {
      const p = m.payload(f);
      watched.forEach((k, i) => {
        const [y, x] = m.cells[k];
        if (p[y * stride + x] > 45) active[i]++;
      });
    }
    for (const n of active) {
      expect(n / frames).toBeGreaterThan(0.03);
      expect(n / frames).toBeLessThan(0.3);
    }
  });
});

describe('buildAvi payload', () => {
  it('writes the given payloads as the frames', () => {
    const payload = (f: number) => new Uint8Array(rowStride(6, 8) * 2).fill(f + 1);
    const file = buildAvi({ width: 6, height: 2, frames: 2, payload });
    const at = (f: number) => {
      const body = payload(f);
      for (let i = 0; i + body.length <= file.length; i++) {
        if (file[i] === 0x30 && file[i + 1] === 0x30 && file[i + 2] === 0x64) {
          const chunk = file.subarray(i + 8, i + 8 + body.length);
          if (chunk.every((v, k) => v === body[k])) return true;
        }
      }
      return false;
    };
    expect(at(0)).toBe(true);
    expect(at(1)).toBe(true);
  });
});
