import { describe, it, expect } from 'vitest';
import { poolRawMax, poolBytesMax, normalizeByte } from '../raster-pool.ts';

describe('raster pooling', () => {
  it('equals the normalized input when sizes match', () => {
    const N = 3,
      T = 4;
    const data = new Float32Array(N * T).map((_, i) => i);
    const { out, rows, cols } = poolRawMax(data, T, false, N, T, N, T, 0, 11);
    expect([rows, cols]).toEqual([N, T]);
    expect(Array.from(out)).toEqual(Array.from(data, (v) => normalizeByte(v, 0, 11)));
  });

  it('keeps every isolated nonzero sample when downsampling', () => {
    const N = 100,
      T = 200;
    const data = new Float32Array(N * T);
    for (let n = 0; n < N; n++) data[n * T + ((n * 37) % T)] = 1; // one event per cell
    const { out, rows, cols } = poolRawMax(data, T, false, N, T, 7, 9, 0, 1);
    expect([rows, cols]).toEqual([7, 9]);
    // every output row has an event (each row covers >=1 cell with one)
    for (let r = 0; r < rows; r++) {
      let m = 0;
      for (let c = 0; c < cols; c++) m = Math.max(m, out[r * cols + c]);
      expect(m).toBe(255);
    }
    // each source event lands in a nonzero output cell
    let total = 0;
    for (const v of out) if (v) total++;
    expect(total).toBeGreaterThanOrEqual(rows);
  });

  it('keeps a single sample and handles the swapped layout', () => {
    const N = 50,
      T = 60;
    const data = new Float32Array(N * T);
    data[41 * T + 33] = 1;
    const a = poolRawMax(data, T, false, N, T, 4, 5, 0, 1);
    expect(a.out.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(1);
    const sw = new Float32Array(N * T);
    sw[33 * N + 41] = 1;
    const b = poolRawMax(sw, N, true, N, T, 4, 5, 0, 1);
    expect(Array.from(b.out)).toEqual(Array.from(a.out));
  });

  it('never upsamples and maps non-finite to 0', () => {
    const { rows, cols, out } = poolRawMax(
      new Float32Array([NaN, 1]),
      2,
      false,
      1,
      2,
      10,
      10,
      0,
      1,
    );
    expect([rows, cols]).toEqual([1, 2]);
    expect(Array.from(out)).toEqual([0, 255]);
  });

  it('poolBytesMax preserves isolated peaks and is identity at equal size', () => {
    const src = new Uint8Array(8 * 8);
    src[5 * 8 + 6] = 200;
    expect(poolBytesMax(src, 8, 8, 8, 8).out).toBe(src);
    const p = poolBytesMax(src, 8, 8, 2, 2);
    expect(Math.max(...p.out)).toBe(200);
  });
});
