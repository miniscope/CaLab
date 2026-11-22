import { describe, expect, it } from 'vitest';
import { FOOTPRINT_PAD, FootprintHistory } from '../lib/footprint-history.ts';
import type { LibraryView } from '../workers/slow-types.ts';

/** A library on a 40 x 40 image; each cell is a list of [pixel, value]. */
function view(
  version: number,
  frame: number,
  cells: Record<number, [number, number][]>,
): LibraryView {
  const ids = Object.keys(cells).map(Number);
  const starts = [0];
  const pixels: number[] = [];
  const values: number[] = [];
  for (const id of ids) {
    for (const [p, v] of cells[id]) {
      pixels.push(p);
      values.push(v);
    }
    starts.push(pixels.length);
  }
  return {
    version,
    frame,
    width: 40,
    height: 40,
    ids: Uint32Array.from(ids),
    centers: new Float32Array(2 * ids.length),
    radii: new Float32Array(ids.length),
    starts: Uint32Array.from(starts),
    pixels: Uint32Array.from(pixels),
    values: Float32Array.from(values),
  };
}

const px = (y: number, x: number) => y * 40 + x;

describe('FootprintHistory', () => {
  it('snapshots a cell only when its footprint changed, cropped and 8-bit', () => {
    const h = new FootprintHistory();
    const a: [number, number][] = [
      [px(20, 20), 2],
      [px(20, 21), 1],
    ];
    h.record(view(1, 100, { 5: a, 6: [[px(2, 2), 1]] }));
    h.record(view(2, 200, { 5: a, 6: [[px(2, 2), 3]] }));
    h.record(view(3, 300, { 5: [...a, [px(21, 20), 4]], 6: [[px(2, 2), 3]] }));

    const five = h.get(5);
    expect(five.map((s) => [s.version, s.frame])).toEqual([
      [1, 100],
      [3, 300],
    ]);
    const s0 = five[0];
    expect([s0.x0, s0.y0, s0.w, s0.h]).toEqual([
      20 - FOOTPRINT_PAD,
      20 - FOOTPRINT_PAD,
      2 + 2 * FOOTPRINT_PAD,
      1 + 2 * FOOTPRINT_PAD,
    ]);
    expect(s0.peak).toBe(2);
    expect(s0.data[FOOTPRINT_PAD * s0.w + FOOTPRINT_PAD]).toBe(255);
    expect(s0.data[FOOTPRINT_PAD * s0.w + FOOTPRINT_PAD + 1]).toBe(128);
    // Cell 6 changed value only (same support), and the crop is clipped at the image edge.
    const six = h.get(6);
    expect(six.map((s) => s.version)).toEqual([1, 2]);
    expect([six[0].x0, six[0].y0]).toEqual([0, 0]);
    expect(h.count).toBe(4);
    expect(h.bytes).toBeGreaterThan(0);
  });

  it('keeps the first snapshot and the newest ones per cell and in total', () => {
    const h = new FootprintHistory(4);
    for (let v = 1; v <= 10; v++) h.record(view(v, v * 10, { 1: [[px(10, 10), v]] }));
    expect(h.get(1).map((s) => s.version)).toEqual([1, 5, 8, 10]);

    const one = h.bytes / h.count;
    const t = new FootprintHistory(64, Math.floor(one * 5));
    for (let v = 1; v <= 6; v++) {
      t.record(view(v, v, { 1: [[px(10, 10), v]], 2: [[px(30, 30), v % 2 ? 1 : 2]] }));
    }
    expect(t.bytes).toBeLessThanOrEqual(one * 5);
    expect(t.get(1)[0].version).toBe(1);
    expect(t.get(1).at(-1)!.version).toBe(6);
    expect(t.get(2)[0].version).toBe(1);
  });

  it('thins evenly: after many updates the kept snapshots span the whole recording', () => {
    const h = new FootprintHistory(64);
    const N = 2000;
    for (let f = 1; f <= N; f++) h.record(view(f, f, { 1: [[px(10, 10), f]] }));
    const kept = h.get(1);
    const frames = kept.map((s) => s.frame);
    expect(kept).toHaveLength(64);
    expect(frames[0]).toBe(1);
    expect(frames.at(-1)).toBe(N);
    // Every tenth of the recording has a kept snapshot (the middle is not lost).
    for (let d = 0; d < 10; d++) {
      expect(frames.some((f) => f > d * (N / 10) && f <= (d + 1) * (N / 10))).toBe(true);
    }
    // Spacing stays roughly even: no gap more than 2x the mean gap.
    const gaps = frames.slice(1).map((f, i) => f - frames[i]);
    const mean = (N - 1) / gaps.length;
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2 * mean);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1);
  });

  it('thins the total cap evenly too, and the byte cap still holds', () => {
    const N = 1500;
    const one = new FootprintHistory(64);
    one.record(view(1, 1, { 1: [[px(10, 10), 1]] }));
    const perSnap = one.bytes;
    const h = new FootprintHistory(64, Math.floor(perSnap * 60));
    for (let f = 1; f <= N; f++) {
      h.record(
        view(f, f, {
          1: [[px(10, 10), f]],
          2: [[px(20, 20), f % 3 === 0 ? 1 : 2]],
          3: [[px(30, 30), f]],
        }),
      );
    }
    expect(h.bytes).toBeLessThanOrEqual(perSnap * 60);
    for (const id of [1, 3]) {
      const frames = h.get(id).map((s) => s.frame);
      expect(frames[0]).toBe(1);
      expect(frames.at(-1)).toBe(N);
      expect(frames.some((f) => f > N / 2 - 100 && f < N / 2 + 100)).toBe(true);
    }
  });

  it('drops cells that left the library except the kept one', () => {
    const h = new FootprintHistory();
    h.record(view(1, 1, { 1: [[px(1, 1), 1]], 2: [[px(5, 5), 1]] }));
    h.retain([2], 1);
    expect(h.get(1)).toHaveLength(1);
    h.retain([2]);
    expect(h.get(1)).toHaveLength(0);
    expect(h.count).toBe(1);
    h.clear();
    expect(h.bytes).toBe(0);
  });
});
