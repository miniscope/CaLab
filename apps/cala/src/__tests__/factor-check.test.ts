// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { quantizeFrames, quantizeTiles, TileCompressor, tileLayout } from '../lib/cala-wasm.ts';
import { cutTile, readTile, tileDiff, type TileView } from '../lib/factor-check.ts';
import { initTestWasm } from './wasm-test.ts';

beforeAll(initTestWasm);

const W = 24;
const H = 20;
const T = 40;
const QUANT = 64;

/** A rank-2 movie with noise (a fixed LCG). */
function movie(seed: number): Float32Array {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
  const out = new Float32Array(T * W * H);
  for (let t = 0; t < T; t++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        out[(t * H + y) * W + x] =
          10 +
          4 * Math.sin(t / 5) * Math.cos(x / 4) +
          2 * Math.cos(t / 3) * Math.sin(y / 3) +
          rnd();
  return out;
}

/** `mean · 1ᵀ + S · Tᵀ` written out, `P x T` row-major. */
function rebuild(v: TileView): Float64Array {
  const p = v.w * v.h;
  const out = new Float64Array(p * v.frames);
  for (let i = 0; i < p; i++)
    for (let t = 0; t < v.frames; t++) {
      let s = v.mean[i];
      for (let k = 0; k < v.rank; k++) s += v.spatial[i * v.rank + k] * v.temporal[t * v.rank + k];
      out[i * v.frames + t] = s;
    }
  return out;
}

describe('the GPU check (factor-check)', () => {
  const q = (): Int16Array => quantizeFrames(movie(3), QUANT);
  const tile = (seed: number, x0 = 4, y0 = 2, w = 16, h = 16): Uint8Array => {
    const raw = new Int16Array(T * w * h);
    cutTile(q(), W, H, T, x0, y0, w, h, raw);
    const c = new TileCompressor(QUANT);
    const f = c.compress(raw, T, x0, y0, w, h, seed);
    const bytes = f.toBytes();
    f.free();
    c.free();
    return bytes;
  };

  it('cuts a tile as quantizeTiles does', () => {
    const rects = tileLayout(W, H, 8, 'offset');
    const px = rects.reduce((n, _v, i) => (i % 4 === 2 ? n + rects[i] * rects[i + 1] : n), 0);
    const tiles = new Int16Array(T * px);
    quantizeTiles(movie(3), T, W, H, 8, 'offset', QUANT, tiles);
    const frames = q();
    let at = 0;
    for (let i = 0; i < rects.length; i += 4) {
      const [x0, y0, w, h] = [rects[i], rects[i + 1], rects[i + 2], rects[i + 3]];
      const got = new Int16Array(T * w * h);
      cutTile(frames, W, H, T, x0, y0, w, h, got);
      expect(got).toEqual(tiles.subarray(at, at + T * w * h));
      at += T * w * h;
    }
    expect(at).toBe(tiles.length);
  });

  it('reads a tile and measures two reconstructions as written out', () => {
    const a = readTile(tile(1));
    const b = readTile(tile(9_000_001));
    expect([a.w, a.h, a.frames]).toEqual([16, 16, T]);
    expect(a.rank).toBeGreaterThan(0);
    // The kept energy is the kept components' `‖S Tᵀ‖²` (T orthonormal).
    expect(tileDiff(a, a).signal / a.keptEnergy).toBeCloseTo(1, 4);
    const ya = rebuild(a);
    const yb = rebuild(b);
    let diff = 0;
    let ref = 0;
    let signal = 0;
    for (let i = 0; i < ya.length; i++) {
      diff += (ya[i] - yb[i]) ** 2;
      ref += yb[i] ** 2;
      signal += (yb[i] - b.mean[Math.floor(i / T)]) ** 2;
    }
    const d = tileDiff(a, b);
    expect(diff).toBeGreaterThan(0);
    expect(d.ref).toBeCloseTo(ref, -1);
    expect(d.ref / ref).toBeCloseTo(1, 6);
    expect(d.signal / signal).toBeCloseTo(1, 6);
    expect(Math.abs(d.diff - diff)).toBeLessThan(1e-6 * ref);
    expect(tileDiff(a, a).diff).toBeLessThan(1e-9 * ref);
  });

  it('refuses bytes that are not a tile', () => {
    expect(() => readTile(new Uint8Array(48))).toThrow(/not a tile/);
    const ok = tile(1);
    expect(() => readTile(ok.subarray(0, ok.length - 4))).toThrow(/wrong length/);
    // At an offset that is not a multiple of 4.
    const shifted = new Uint8Array(ok.length + 1);
    shifted.set(ok, 1);
    expect(readTile(shifted.subarray(1)).rank).toBe(readTile(ok).rank);
  });
});
