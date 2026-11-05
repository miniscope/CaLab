import { describe, it, expect } from 'vitest';
import {
  poolRawMax,
  poolMatrixMax,
  pooledBounds,
  normalizeByte,
  smoothWidthFrames,
} from '../raster-pool.ts';

function makeRng(seed: number) {
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return {
    rnd,
    gauss: () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()),
  };
}

describe('raster pooling', () => {
  it('places cells on their display rows when sorted', () => {
    const N = 3,
      T = 2;
    const data = new Float32Array([0, 0, 1, 1, 2, 2]);
    // cell 0 -> row 2, cell 1 -> row 0, cell 2 -> row 1
    const { out } = poolRawMax(data, T, false, N, T, N, T, 1, [2, 0, 1]);
    expect(Array.from(out)).toEqual([1, 1, 2, 2, 0, 0]);
  });

  it('equals the input when sizes match', () => {
    const N = 3,
      T = 4;
    const data = new Float32Array(N * T).map((_, i) => i);
    const { out, rows, cols } = poolRawMax(data, T, false, N, T, N, T);
    expect([rows, cols]).toEqual([N, T]);
    expect(Array.from(out)).toEqual(Array.from(data));
  });

  it('keeps every isolated nonzero sample when downsampling', () => {
    const N = 100,
      T = 200;
    const data = new Float32Array(N * T);
    for (let n = 0; n < N; n++) data[n * T + ((n * 37) % T)] = 1; // one event per cell
    const { out, rows, cols } = poolRawMax(data, T, false, N, T, 7, 9);
    expect([rows, cols]).toEqual([7, 9]);
    for (let r = 0; r < rows; r++) {
      let m = 0;
      for (let c = 0; c < cols; c++) m = Math.max(m, out[r * cols + c]);
      expect(m).toBe(1);
    }
  });

  it('keeps a single sample and handles the swapped layout', () => {
    const N = 50,
      T = 60;
    const data = new Float32Array(N * T);
    data[41 * T + 33] = 1;
    const a = poolRawMax(data, T, false, N, T, 4, 5);
    expect(a.out.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(1);
    const sw = new Float32Array(N * T);
    sw[33 * N + 41] = 1;
    const b = poolRawMax(sw, N, true, N, T, 4, 5);
    expect(Array.from(b.out)).toEqual(Array.from(a.out));
  });

  it('never upsamples; non-finite samples are ignored', () => {
    const { rows, cols, out } = poolRawMax(new Float32Array([NaN, 1]), 2, false, 1, 2, 10, 10);
    expect([rows, cols]).toEqual([1, 2]);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBe(1);
    expect(normalizeByte(out[0], 0, 1)).toBe(0);
  });

  it('poolMatrixMax preserves isolated peaks and is identity at equal size', () => {
    const src = new Float32Array(8 * 8);
    src[5 * 8 + 6] = 200;
    expect(poolMatrixMax(src, 8, 8, 8, 8).out).toBe(src);
    expect(Math.max(...poolMatrixMax(src, 8, 8, 2, 2).out)).toBe(200);
  });

  it('smoothed pooling agrees across layouts', () => {
    const N = 6,
      T = 40;
    const a = new Float32Array(N * T).map((_, i) => (i * 7) % 5);
    const b = new Float32Array(N * T);
    for (let n = 0; n < N; n++) for (let t = 0; t < T; t++) b[t * N + n] = a[n * T + t];
    const x = poolRawMax(a, T, false, N, T, 3, 8, 4);
    const y = poolRawMax(b, N, true, N, T, 3, 8, 4);
    expect(Array.from(x.out)).toEqual(Array.from(y.out));
  });

  it('smoothing lowers the pooled noise level and keeps a realistic transient', () => {
    const { gauss } = makeRng(12345);
    const N = 20,
      T = 6000;
    const noise = new Float32Array(N * T).map(() => gauss());
    const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
    const raw = poolRawMax(noise, T, false, N, T, 20, 100, 1);
    const sm = poolRawMax(noise, T, false, N, T, 20, 100, 3);
    expect(mean(sm.out)).toBeLessThan(mean(raw.out) - 0.5);

    // 30 Hz GCaMP-like transient: ~2 frame rise, ~0.4 s decay; peak height 1
    const tr = new Float32Array(T);
    tr[3000] = 0.5;
    for (let k = 0; k < 60; k++) tr[3001 + k] = Math.exp(-k / 12);
    const p = poolRawMax(tr, T, false, 1, T, 1, 100, 3);
    expect(Math.max(...p.out)).toBeGreaterThanOrEqual(0.9);
  });

  it('smoothing width: none without pooling, ~0.1 s with it', () => {
    expect(smoothWidthFrames(1200, 30)).toBe(1);
    expect(smoothWidthFrames(54000, 30)).toBe(3);
    expect(smoothWidthFrames(54000, null)).toBe(1);
  });

  it('with bounds from the pooled image, event cells stand out above a dark noise floor', () => {
    // 300 cells x 6000 frames @30 Hz, noise sigma 0.1, 1/3 of cells carry ~0.5 Hz transients
    const { rnd, gauss } = makeRng(7);
    const N = 300,
      T = 6000,
      fs = 30;
    const data = new Float32Array(N * T).map(() => 0.1 * gauss());
    const isEvent = (n: number) => n % 3 === 0;
    for (let n = 0; n < N; n++) {
      if (!isEvent(n)) continue;
      for (let t = 0; t < T - 60; t++) {
        if (rnd() < 0.5 / fs) {
          data[n * T + t] += 0.5;
          for (let k = 0; k < 60; k++) data[n * T + t + 1 + k] += Math.exp(-k / 12);
        }
      }
    }
    const { out, rows, cols } = poolRawMax(
      data,
      T,
      false,
      N,
      T,
      100,
      200,
      smoothWidthFrames(T, fs),
    );
    const { lo, range } = pooledBounds(out);
    let evSum = 0,
      evN = 0,
      noSum = 0,
      noN = 0;
    for (let r = 0; r < rows; r++) {
      // each output row covers 3 cells so every row has an event cell; use the
      // per-cell source instead: row r holds cells 3r..3r+2 (cell 3r is the event cell)
      for (let c = 0; c < cols; c++) {
        evSum += normalizeByte(out[r * cols + c], lo, range);
        evN++;
      }
    }
    // noise-only reference: same pooling on a noise-only matrix, same bounds
    const noiseOnly = new Float32Array(N * T).map(() => 0.1 * gauss());
    const no = poolRawMax(noiseOnly, T, false, N, T, 100, 200, smoothWidthFrames(T, fs));
    for (const v of no.out) {
      noSum += normalizeByte(v, lo, range);
      noN++;
    }
    // event-containing pixels are much brighter than pooled noise
    expect(evSum / evN).toBeGreaterThan(noSum / noN + 40);
    // pooled noise sits on a dark floor
    expect(noSum / noN).toBeLessThan(90);
  });
});
