// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCalaWasm, quantizeTiles, TileCompressor } from '../lib/cala-wasm.ts';
import { CompressFeed } from '../lib/compress-feed.ts';
import { CompressRunner, factorName, tileGrid } from '../lib/compress-runner.ts';
import { compressReadout } from '../lib/compress-store.ts';
import { memoryStore } from '../lib/window-store.ts';
import type { CompressToMain, FastToCompress } from '../workers/compress-types.ts';

beforeAll(async () => {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
});

const W = 40;
const H = 24;
const PX = W * H;
const TILE = 16;
const QUANT = 64;

/** Frame `t` of a movie that is exactly rank 3 in time, with slow time courses. */
function frame(t: number): Float32Array {
  const out = new Float32Array(PX);
  const a = t / 9;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const b = (x + 2 * y) / 11;
      out[y * W + x] =
        20 +
        9 * Math.sin(a) * Math.cos(b) +
        5 * Math.cos(0.7 * a) * Math.sin(2 * b) +
        3 * Math.sin(1.9 * a) * Math.cos(3 * b);
    }
  }
  return out;
}

function batch(start: number, count: number): Float32Array {
  const out = new Float32Array(count * PX);
  for (let i = 0; i < count; i++) out.set(frame(start + i), i * PX);
  return out;
}

/** A feed whose messages are collected instead of posted. */
function collectingFeed(window: number, quantize = quantizeTiles) {
  const sent: FastToCompress[] = [];
  const feed = new CompressFeed(
    { width: W, height: H, session: 7, tile: TILE, window, quant: QUANT },
    { postMessage: (m) => sent.push(m) },
    quantize,
  );
  return { feed, sent };
}

function runner(store = memoryStore()) {
  const toMain: CompressToMain[] = [];
  const r = new CompressRunner({
    store,
    create: (quant) => new TileCompressor(quant),
    toMain: { postMessage: (m) => toMain.push(m) },
    yieldNow: () => Promise.resolve(),
  });
  return { r, store, toMain };
}

/** The tiles of a factor file: position, rank and the three float arrays. */
function readFactors(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('CALAFAC1');
  const [width, height, tile, frames, n] = [8, 12, 16, 20, 24].map((o) => view.getUint32(o, true));
  const start = view.getFloat64(28, true);
  const tiles = [];
  let at = 36;
  for (let i = 0; i < n; i++) {
    const len = view.getUint32(at, true);
    const b = bytes.slice(at + 4, at + 4 + len);
    at += 4 + len;
    const v = new DataView(b.buffer);
    expect(new TextDecoder().decode(b.subarray(0, 4))).toBe('CTF1');
    const [x0, y0, w, h, rank, t] = [4, 8, 12, 16, 20, 24].map((o) => v.getUint32(o, true));
    const p = w * h;
    const floats = new Float32Array(b.buffer.slice(48));
    tiles.push({
      x0,
      y0,
      w,
      h,
      rank,
      frames: t,
      mean: floats.subarray(0, p),
      spatial: floats.subarray(p, p + p * rank),
      temporal: floats.subarray(p + p * rank),
    });
  }
  expect(at).toBe(bytes.length);
  return { width, height, tile, frames, start, tiles };
}

describe('CompressFeed', () => {
  it('cuts the stream into windows and marks the chunk that completes one', () => {
    const calls: number[] = [];
    const { feed, sent } = collectingFeed(5, (_f, count, _w, _h, _t, _q, out) => {
      calls.push(count);
      out.fill(count);
    });
    feed.push(new Float32Array(3 * PX), 0, 3);
    feed.push(new Float32Array(4 * PX), 3, 4); // 2 complete window 0, 2 open window 1
    feed.end();
    expect(sent.map((m) => m.type)).toEqual(['init', 'chunk', 'chunk', 'chunk', 'close']);
    const chunks = sent.filter((m) => m.type === 'chunk');
    expect(chunks.map((c) => [c.window, c.start, c.count, c.last])).toEqual([
      [0, 0, 3, false],
      [0, 3, 2, true],
      [1, 5, 2, false],
    ]);
    expect(chunks.map((c) => c.data.length)).toEqual([3 * PX, 2 * PX, 2 * PX]);
    expect(calls).toEqual([3, 2, 2]);
    expect(sent[4]).toEqual({ type: 'close', session: 7, final: true });
  });

  it('closes the open window at a gap in the stream', () => {
    const { feed, sent } = collectingFeed(10, (_f, _c, _w, _h, _t, _q, out) => out.fill(0));
    feed.push(new Float32Array(2 * PX), 0, 2);
    feed.push(new Float32Array(2 * PX), 8, 2);
    const kinds = sent.map((m) => (m.type === 'chunk' ? `chunk${m.window}` : m.type));
    expect(kinds).toEqual(['init', 'chunk0', 'close', 'chunk1']);
  });

  it('sends nothing after a reset', () => {
    const { feed, sent } = collectingFeed(10);
    feed.push(batch(0, 1), 0, 1);
    feed.reset();
    feed.push(batch(1, 1), 1, 1);
    feed.end();
    expect(sent.map((m) => m.type)).toEqual(['init', 'chunk', 'reset']);
  });
});

describe('CompressRunner', () => {
  it('lays out the tiles like the quantizer', () => {
    const grid = tileGrid(W, H, TILE);
    expect(grid.map((t) => [t.x0, t.y0, t.w, t.h])).toEqual([
      [0, 0, 16, 16],
      [16, 0, 16, 16],
      [32, 0, 8, 16],
      [0, 16, 16, 8],
      [16, 16, 16, 8],
      [32, 16, 8, 8],
    ]);
    expect(grid[grid.length - 1].offset + 64).toBe(PX);
  });

  it('turns the fed frames into factor files that rebuild them', async () => {
    const { feed, sent } = collectingFeed(50);
    // Uneven batches: 2 full windows and a last one of 20 frames.
    for (let s = 0; s < 120; s += 7)
      feed.push(batch(s, Math.min(7, 120 - s)), s, Math.min(7, 120 - s));
    feed.end();
    const { r, store, toMain } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();

    expect([...store.files.keys()].sort()).toEqual([0, 1, 2].map(factorName));
    const last = toMain[toMain.length - 1];
    expect(last.type).toBe('status');
    if (last.type !== 'status') return;
    expect(last.session).toBe(7);
    expect(last.status).toMatchObject({ windows: 3, frames: 120, pending: 0, final: true });
    const size = [...store.files.values()].reduce((s, f) => s + f.length, 0);
    expect(last.status.factorBytes).toBe(size);
    expect(compressReadout(last.status)).toMatch(/^Compression: 3 windows · rank \d/);

    const frames = [50, 50, 20];
    const starts = [0, 50, 100];
    for (let k = 0; k < 3; k++) {
      const f = readFactors(store.files.get(factorName(k))!);
      expect([f.width, f.height, f.tile, f.frames, f.start]).toEqual([
        W,
        H,
        TILE,
        frames[k],
        starts[k],
      ]);
      expect(f.tiles.length).toBe(6);
      // Rebuild one frame of the window from the factors.
      const t = Math.floor(frames[k] / 2);
      const want = frame(starts[k] + t);
      let worst = 0;
      for (const tile of f.tiles) {
        expect(tile.frames).toBe(frames[k]);
        expect(tile.rank).toBeGreaterThanOrEqual(1);
        expect(tile.rank).toBeLessThanOrEqual(6);
        for (let y = 0; y < tile.h; y++) {
          for (let x = 0; x < tile.w; x++) {
            const p = y * tile.w + x;
            let v = tile.mean[p];
            for (let c = 0; c < tile.rank; c++) {
              v += tile.spatial[p * tile.rank + c] * tile.temporal[t * tile.rank + c];
            }
            worst = Math.max(worst, Math.abs(v - want[(tile.y0 + y) * W + tile.x0 + x]));
          }
        }
      }
      // The 20-frame tail keeps fewer components: the white-noise test of the rank cut
      // (lag-1 autocorrelation above 4 / sqrt(frames)) is stricter on few frames.
      if (frames[k] === 50) expect(worst, `window ${k}`).toBeLessThan(0.1);
    }
  });

  it('drops its files on reset and ignores another session', async () => {
    const { feed, sent } = collectingFeed(10);
    feed.push(batch(0, 14), 0, 14);
    const { r, store, toMain } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();
    expect([...store.files.keys()].sort()).toEqual([factorName(0), 'w1.i16']);

    await r.handle({ type: 'reset', session: 99 });
    expect(store.files.size).toBe(2);
    await r.handle({ type: 'reset', session: 7 });
    expect(store.files.size).toBe(0);
    const before = toMain.length;
    await r.handle(sent[1]); // a late chunk of the old session
    await r.idle();
    expect(store.files.size).toBe(0);
    expect(toMain.length).toBe(before);
  });
});
