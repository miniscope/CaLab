import { describe, it, expect } from 'vitest';
import { poolRawMax, poolBytesMax, normalizeByte, smoothWidthFrames } from '../raster-pool.ts';

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

  it('smoothing lowers pooled white-noise brightness but keeps a realistic transient', () => {
    // seeded gaussian noise
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const N = 20,
      T = 6000;
    const noise = new Float32Array(N * T).map(() => gauss());
    // normalize so noise sits mid-range: p1=-4, range=8 -> mean ~ 128
    const mean = (a: Uint8Array) => a.reduce((s, v) => s + v, 0) / a.length;
    const raw = poolRawMax(noise, T, false, N, T, 20, 100, -4, 8, 1);
    const sm = poolRawMax(noise, T, false, N, T, 20, 100, -4, 8, 3);
    expect(mean(sm.out)).toBeLessThan(mean(raw.out) - 20);

    // 30 Hz GCaMP-like transient: ~2 frame rise, ~0.4 s decay; peak height 1
    const tr = new Float32Array(T);
    tr[3000] = 0.5;
    for (let k = 0; k < 60; k++) tr[3001 + k] = Math.exp(-k / 12);
    const p = poolRawMax(tr, T, false, 1, T, 1, 100, 0, 1, 3);
    expect(Math.max(...p.out)).toBeGreaterThanOrEqual(0.9 * 255);
  });

  it('smoothing width: none without pooling, ~0.1 s with it', () => {
    expect(smoothWidthFrames(1200, 30)).toBe(1);
    expect(smoothWidthFrames(54000, 30)).toBe(3);
    expect(smoothWidthFrames(54000, null)).toBe(1);
  });

  it('smoothed pooling agrees across layouts', () => {
    const N = 6,
      T = 40;
    const a = new Float32Array(N * T).map((_, i) => (i * 7) % 5);
    const b = new Float32Array(N * T);
    for (let n = 0; n < N; n++) for (let t = 0; t < T; t++) b[t * N + n] = a[n * T + t];
    const x = poolRawMax(a, T, false, N, T, 3, 8, 0, 5, 4);
    const y = poolRawMax(b, N, true, N, T, 3, 8, 0, 5, 4);
    expect(Array.from(x.out)).toEqual(Array.from(y.out));
  });
});
