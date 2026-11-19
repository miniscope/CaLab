// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FactorExtractor,
  FactorWindow,
  factorHeader,
  quantizeTiles,
  tileLayout,
  TileCompressor,
  TraceEngine,
  TraceLibrary,
  TraceLibraryBuilder,
} from '../lib/cala-wasm.ts';
import { createCellStore } from '../lib/cell-store.ts';
import { CompressFeed, compressFeedFor, compressFeedOptions } from '../lib/compress-feed.ts';
import { CompressRunner, factorName, tilesOf } from '../lib/compress-runner.ts';
import type { CompressRunnerDeps } from '../lib/compress-runner.ts';
import { compressReadout, createCompressStore } from '../lib/compress-store.ts';
import { memoryStore } from '../lib/window-store.ts';
import type { CompressToMain, FastToCompress } from '../workers/compress-types.ts';
import { initTestWasm } from './wasm-test.ts';

beforeAll(initTestWasm);

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
function collectingFeed(window: number) {
  const sent: FastToCompress[] = [];
  const feed = new CompressFeed(
    { width: W, height: H, session: 7, tile: TILE, window, quant: QUANT },
    { postMessage: (m) => sent.push(m) },
  );
  return { feed, sent };
}

function runner(store = memoryStore(), extra: Partial<CompressRunnerDeps> = {}) {
  const toMain: CompressToMain[] = [];
  const r = new CompressRunner({
    store,
    quantize: quantizeTiles,
    layout: tileLayout,
    header: factorHeader,
    create: (quant) => new TileCompressor(quant),
    extract: (bytes) => new FactorExtractor(bytes, 0, 0),
    toMain: { postMessage: (m) => toMain.push(m) },
    yieldNow: () => Promise.resolve(),
    ...extra,
  });
  return { r, store, toMain };
}

/** The tiles of a v2 factor file: position, rank and the five float arrays. */
function readFactors(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('CALAFAC2');
  const [width, height, tile, frames, n] = [8, 12, 16, 20, 24].map((o) => view.getUint32(o, true));
  const start = view.getFloat64(28, true);
  const [kind, param] = [36, 40].map((o) => view.getUint32(o, true));
  const tiles = [];
  let at = 44;
  for (let i = 0; i < n; i++) {
    const len = view.getUint32(at, true);
    const b = bytes.slice(at + 4, at + 4 + len);
    at += 4 + len;
    const v = new DataView(b.buffer);
    expect(new TextDecoder().decode(b.subarray(0, 4))).toBe('CTF2');
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
      discarded: floats.subarray(p, 2 * p),
      valid: floats.subarray(2 * p, 3 * p),
      spatial: floats.subarray(3 * p, 3 * p + p * rank),
      temporal: floats.subarray(3 * p + p * rank),
    });
  }
  expect(at).toBe(bytes.length);
  return { width, height, tile, frames, start, kind, param, tiles };
}

describe('CompressFeed', () => {
  it('cuts the stream into windows and marks the chunk that completes one', () => {
    const { feed, sent } = collectingFeed(5);
    const first = batch(0, 3);
    const second = batch(3, 4);
    feed.push(first, 0, 3);
    feed.push(second, 3, 4); // 2 complete window 0, 2 open window 1
    feed.end();
    expect(sent.map((m) => m.type)).toEqual(['init', 'chunk', 'chunk', 'chunk', 'close']);
    const chunks = sent.filter((m) => m.type === 'chunk');
    expect(chunks.map((c) => [c.window, c.start, c.count, c.last])).toEqual([
      [0, 0, 3, false],
      [0, 3, 2, true],
      [1, 5, 2, false],
    ]);
    // Copies of the frames (the batch buffer is reused by the pipeline), in stream order.
    expect(chunks.map((c) => c.data.length)).toEqual([3 * PX, 2 * PX, 2 * PX]);
    expect(chunks[0].data).toEqual(first);
    expect(chunks[0].data.buffer).not.toBe(first.buffer);
    expect(chunks[1].data).toEqual(second.subarray(0, 2 * PX));
    expect(chunks[2].data).toEqual(second.subarray(2 * PX));
    expect(sent[4]).toEqual({ type: 'close', session: 7, final: true });
  });

  it('closes the open window at a gap in the stream', () => {
    const { feed, sent } = collectingFeed(10);
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

  it('keeps the windows when the fast loop is dropped after the end', () => {
    // Pass 2 replaces the fast loop in the trace worker once the recording
    // has ended; the compressed windows are the record of the run.
    const { feed, sent } = collectingFeed(10);
    feed.push(batch(0, 1), 0, 1);
    feed.end();
    feed.reset();
    expect(sent.map((m) => m.type)).toEqual(['init', 'chunk', 'close']);
  });
});

describe('CompressRunner', () => {
  it('a reset clears the status: no windows, no Recalibrated factors', async () => {
    const { feed, sent } = feedWith({ tiling: 'offset', source: 'replay' });
    feed.push(batch(0, 100), 0, 100);
    feed.reset();
    expect(sent[sent.length - 1].type).toBe('reset');
    const { r, store, toMain } = runner();
    for (const m of sent.slice(0, -1)) await r.handle(m);
    await r.idle();
    const mid = toMain[toMain.length - 1];
    if (mid.type !== 'status') throw new Error('the last message is not a status');
    expect(mid.status.windows).toBe(2);
    await r.handle(sent[sent.length - 1]);
    await r.idle();
    expect(store.files.size).toBe(0);
    const last = toMain[toMain.length - 1];
    if (last.type !== 'status') throw new Error('the last message is not a status');
    expect(last.status).toMatchObject({ windows: 0, frames: 0, pending: 0, final: false });
    expect(compressReadout(last.status)).not.toMatch(/Recalibrated factors/);
  });

  it('a replay of the same session replaces the windows of Discover', async () => {
    const discover = feedWith({});
    discover.feed.push(batch(0, 100), 0, 100);
    discover.feed.end();
    const replay = feedWith({ tiling: 'offset', source: 'replay' });
    replay.feed.push(batch(0, 60), 0, 60);
    replay.feed.end();
    const { r, store, toMain } = runner();
    // The replay starts while Discover's windows are still being compressed.
    for (const m of [...discover.sent, ...replay.sent]) await r.handle(m);
    await r.idle();

    expect([...store.files.keys()].sort()).toEqual([0, 1].map(factorName));
    const win = FactorWindow.fromBytes(store.files.get(factorName(1))!);
    try {
      expect([win.frames, win.start, win.tiling]).toEqual([10, 50, 'offset']);
    } finally {
      win.free();
    }
    const last = toMain[toMain.length - 1];
    if (last.type !== 'status') throw new Error('the last message is not a status');
    expect(last.status).toMatchObject({
      windows: 2,
      frames: 60,
      final: true,
      tiling: 'offset',
      source: 'replay',
    });
    expect(compressReadout(last.status, { version: 3, frames: 100, msPerFrame: 1 })).toMatch(
      /^Recalibrated factors: 2 windows · rank \d[^(]*$/,
    );
  });

  it('lays out the tiles like the quantizer', () => {
    const grid = tilesOf(tileLayout(W, H, TILE, 'plain'));
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
      expect([f.kind, f.param]).toEqual([0, 0]);
      // Rebuild one frame of the window from the factors.
      const t = Math.floor(frames[k] / 2);
      const want = frame(starts[k] + t);
      let worst = 0;
      for (const tile of f.tiles) {
        expect(tile.frames).toBe(frames[k]);
        expect([...tile.valid].every((v) => v === 1)).toBe(true);
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

  /** A feed with its own options whose messages are collected. */
  function feedWith(options: Partial<ConstructorParameters<typeof CompressFeed>[0]>) {
    const sent: FastToCompress[] = [];
    const feed = new CompressFeed(
      { width: W, height: H, session: 7, tile: TILE, window: 50, quant: QUANT, ...options },
      { postMessage: (m) => sent.push(m) },
    );
    return { feed, sent };
  }

  it('compresses on the offset grids and rebuilds the frames blended', async () => {
    const { feed, sent } = feedWith({ tiling: 'offset' });
    for (let s = 0; s < 120; s += 7)
      feed.push(batch(s, Math.min(7, 120 - s)), s, Math.min(7, 120 - s));
    feed.end();
    expect(sent[0]).toMatchObject({ type: 'init', tiling: 'offset', source: 'discover' });
    const { r, store, toMain } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();

    const tiles = tileLayout(W, H, TILE, 'offset').length / 4;
    expect(tiles).toBe(12);
    const last = toMain[toMain.length - 1];
    if (last.type !== 'status') throw new Error('the last message is not a status');
    expect(last.status).toMatchObject({
      windows: 3,
      frames: 120,
      final: true,
      tiling: 'offset',
      source: 'discover',
    });
    const out = new Float32Array(PX);
    const windows = [
      [0, 50, 0],
      [1, 50, 50],
      [2, 20, 100],
    ] as const;
    for (const [k, frames, start] of windows) {
      const bytes = store.files.get(factorName(k))!;
      const f = readFactors(bytes);
      expect([f.kind, f.tiles.length]).toEqual([2, tiles]);
      const win = FactorWindow.fromBytes(bytes);
      try {
        expect([win.frames, win.start, win.tiling, win.tile]).toEqual([
          frames,
          start,
          'offset',
          TILE,
        ]);
        const t = Math.floor(frames / 2);
        win.reconstruct(t, 1, out);
        const want = frame(start + t);
        let worst = 0;
        for (let i = 0; i < PX; i++) worst = Math.max(worst, Math.abs(out[i] - want[i]));
        if (frames === 50) expect(worst, `window ${k}`).toBeLessThan(0.1);
      } finally {
        win.free();
      }
    }
  });

  it('skips a last window of one frame under the offset grids', async () => {
    const { feed, sent } = feedWith({ tiling: 'offset' });
    feed.push(batch(0, 51), 0, 51);
    feed.end();
    const { r, store, toMain } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();
    expect([...store.files.keys()]).toEqual([factorName(0)]);
    const last = toMain[toMain.length - 1];
    if (last.type !== 'status') throw new Error('the last message is not a status');
    expect(last.status).toMatchObject({ windows: 1, frames: 50, pending: 0, final: true });
  });

  it('marks a missing pixel as not valid instead of pulling its mean to 0', async () => {
    const { feed, sent } = feedWith({});
    const frames = batch(0, 50);
    // Pixel (0, 0) is missing in the first 20 frames.
    for (let t = 0; t < 20; t++) frames[t * PX] = Number.NaN;
    feed.push(frames, 0, 50);
    feed.end();
    const { r, store } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();
    const first = readFactors(store.files.get(factorName(0))!).tiles[0];
    expect(first.valid[0]).toBeCloseTo(0.6, 6);
    expect(first.valid[1]).toBe(1);
    let mean = 0;
    for (let t = 20; t < 50; t++) mean += frame(t)[0] / 30;
    expect(first.mean[0]).toBeCloseTo(mean, 1);
  });

  it('refuses a tile below 2 in the feed', () => {
    expect(() => feedWith({ tile: 1 })).toThrow(RangeError);
    expect(() => feedWith({ tile: 2 })).not.toThrow();
  });

  it('keeps no half-initialised session when the layout is refused', async () => {
    // A runner with a valid session: Discover's window 0 compressed, window 1 open.
    const old = feedWith({});
    old.feed.push(batch(0, 60), 0, 60);
    const oldChunks = old.sent.filter((m) => m.type === 'chunk');
    expect(oldChunks.length).toBeGreaterThan(1);
    const { r, store, toMain } = runner();
    for (const m of old.sent) await r.handle(m);
    await r.idle();
    expect(store.files.has(factorName(0))).toBe(true);
    // Extract's replay reuses the session number; its layout is refused.
    const { feed, sent } = feedWith({ tiling: 'offset', source: 'replay' });
    feed.push(batch(0, 50), 0, 50);
    feed.end();
    expect(sent[0]).toMatchObject({ type: 'init', session: old.sent[0].session });
    let broken = true;
    const deps = (r as unknown as { deps: { layout: typeof tileLayout } }).deps;
    const layout = deps.layout;
    deps.layout = (...a) => {
      if (broken) throw new Error('layout refused');
      return layout(...a);
    };
    await expect(r.handle(sent[0])).rejects.toThrow('layout refused');
    // A stray chunk of the old session (same number) is not cut on its plain grid.
    await r.handle(oldChunks[oldChunks.length - 1]);
    for (const m of sent.slice(1)) await r.handle(m); // late chunks of the refused session
    await r.idle();
    expect(store.files.size).toBe(0);
    broken = false;
    for (const m of sent) await r.handle(m);
    await r.idle();
    expect([...store.files.keys()]).toEqual([factorName(0)]);
    expect(toMain.some((m) => m.type === 'error')).toBe(false);
  });

  it('reports the compute time per frame as the mean over all windows', async () => {
    // A clock that only quantizing (1 ms per frame) and compressing move: 2 ms
    // per tile for the window of 50 frames, 7 ms per tile for the one of 20.
    let clock = 0;
    const { feed, sent } = feedWith({});
    feed.push(batch(0, 70), 0, 70);
    feed.end();
    const { r, toMain } = runner(memoryStore(), {
      now: () => clock,
      quantize: (frames, count, ...rest) => {
        clock += count;
        quantizeTiles(frames, count, ...rest);
      },
      create: (quant) => {
        const c = new TileCompressor(quant);
        return {
          compress: (raw, frames, x0, y0, w, h, seed) => {
            clock += frames === 50 ? 2 : 7;
            return c.compress(raw, frames, x0, y0, w, h, seed);
          },
          free: () => c.free(),
        };
      },
    });
    for (const m of sent) await r.handle(m);
    await r.idle();
    const tiles = tileLayout(W, H, TILE, 'plain').length / 4;
    const statuses = toMain.flatMap((m) => (m.type === 'status' ? [m.status] : []));
    const first = statuses.find((s) => s.windows === 1)!;
    const last = statuses[statuses.length - 1];
    expect(last).toMatchObject({ windows: 2, frames: 70, final: true });
    expect(first.msPerFrame).toBeCloseTo((50 + 2 * tiles) / 50, 9);
    // Not the last window's (20 + 7 * tiles) / 20.
    expect(last.msPerFrame).toBeCloseTo((70 + 9 * tiles) / 70, 9);
  });

  it('reports the mean rank as the mean over all windows, weighted by frames', async () => {
    // Ranks by window of 50 and of 20 frames, summed over the tiles.
    const sums = new Map<number, number>();
    const { feed, sent } = feedWith({});
    feed.push(batch(0, 70), 0, 70);
    feed.end();
    const { r, toMain } = runner(memoryStore(), {
      create: (quant) => {
        const c = new TileCompressor(quant);
        return {
          compress: (raw, frames, x0, y0, w, h, seed) => {
            const f = c.compress(raw, frames, x0, y0, w, h, seed);
            sums.set(frames, (sums.get(frames) ?? 0) + f.rank);
            return f;
          },
          free: () => c.free(),
        };
      },
    });
    for (const m of sent) await r.handle(m);
    await r.idle();
    const tiles = tileLayout(W, H, TILE, 'plain').length / 4;
    const statuses = toMain.flatMap((m) => (m.type === 'status' ? [m.status] : []));
    const last = statuses[statuses.length - 1];
    expect(last).toMatchObject({ windows: 2, frames: 70 });
    const want = (50 * (sums.get(50) ?? 0) + 20 * (sums.get(20) ?? 0)) / tiles / 70;
    expect(last.meanRank).toBeCloseTo(want, 9);
    // The weighting is what is pinned: the plain mean of the two windows' ranks differs.
    const plain = (sums.get(50)! / tiles + sums.get(20)! / tiles) / 2;
    expect(Math.abs(want - plain)).toBeGreaterThan(0.1);
  });

  it('compresses a frame whose edge tile is one pixel (33 x 33, tile 16)', async () => {
    const n = 33;
    const sent: FastToCompress[] = [];
    const feed = new CompressFeed(
      { width: n, height: n, session: 7, tile: 16, window: 20, quant: QUANT, tiling: 'offset' },
      { postMessage: (m) => sent.push(m) },
    );
    const frames = new Float32Array(20 * n * n);
    for (let t = 0; t < 20; t++)
      for (let i = 0; i < n * n; i++) frames[t * n * n + i] = 10 + Math.sin(t / 4 + i / 9);
    feed.push(frames, 0, 20);
    const { r, store, toMain } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();
    expect(toMain.some((m) => m.type === 'error')).toBe(false);
    const win = FactorWindow.fromBytes(store.files.get(factorName(0))!);
    try {
      expect([win.frames, win.tiling]).toEqual([20, 'offset']);
    } finally {
      win.free();
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

/** Two cells with known footprints and slow, non-negative traces. */
const CELLS = [
  { id: 11, cy: 7, cx: 9, trace: (t: number) => 5 * (1 + Math.sin(t / 9)) },
  { id: 12, cy: 15, cx: 28, trace: (t: number) => 4 * (1 + Math.cos(t / 5)) },
];
const PATCH = 9;
const blob = (dy: number, dx: number): number => Math.exp(-(dy * dy + dx * dx) / 6);

function cellFrames(start: number, count: number): Float32Array {
  const out = new Float32Array(count * PX);
  for (let i = 0; i < count; i++) {
    for (const c of CELLS) {
      const v = c.trace(start + i);
      for (let y = c.cy - 4; y <= c.cy + 4; y++) {
        for (let x = c.cx - 4; x <= c.cx + 4; x++) {
          out[i * PX + y * W + x] += v * blob(y - c.cy, x - c.cx);
        }
      }
    }
  }
  return out;
}

function cellLibrary(): { version: number; bytes: Uint8Array } {
  const b = new TraceLibraryBuilder(W, H);
  for (const c of CELLS) {
    const values = new Float32Array(PATCH * PATCH);
    for (let y = 0; y < PATCH; y++) {
      for (let x = 0; x < PATCH; x++) values[y * PATCH + x] = blob(y - 4, x - 4);
    }
    b.addFootprint(c.id, c.cy - 4, c.cx - 4, PATCH, PATCH, values);
  }
  const lib = b.buildUnfiltered();
  const out = { version: lib.version, bytes: lib.toBytes() };
  lib.free();
  b.free();
  return out;
}

describe('back-fill from the factors', () => {
  it('solves the traces of every window with the library it is given', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    feed.library(lib.version, lib.bytes); // before the first frame: not sent
    for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.library(lib.version, lib.bytes);
    feed.end();
    expect(sent.filter((m) => m.type === 'library').length).toBe(1);

    const { r, toMain } = runner();
    // Asked for before anything is compressed: it waits for the windows and the library.
    await r.handle(sent[0]);
    r.backfill(7, lib.version);
    for (const m of sent.slice(1)) await r.handle(m);
    await r.idle();

    const windows = toMain.filter((m) => m.type === 'traces');
    expect(windows.map((m) => [m.first, m.start, m.count])).toEqual([
      [true, 0, 50],
      [false, 50, 50],
    ]);
    const done = toMain[toMain.length - 1];
    expect(done).toMatchObject({ type: 'backfilled', session: 7, frames: 100 });
    for (const m of windows) {
      expect('minValid' in m).toBe(false);
      expect([...m.ids]).toEqual(CELLS.map((c) => c.id));
      for (let i = 0; i < m.count; i++) {
        CELLS.forEach((c, j) => {
          expect(m.traces[i * CELLS.length + j]).toBeCloseTo(c.trace(m.start + i), 1);
        });
      }
    }

    // A second request needs a library at least that new.
    r.backfill(7, lib.version + 1);
    await r.idle();
    expect(toMain.filter((m) => m.type === 'backfilled').length).toBe(1);
    r.backfill(99, lib.version); // another session
    await r.idle();
    expect(toMain.filter((m) => m.type === 'backfilled').length).toBe(1);
  });

  it('gives the signed traces of the frame engine when asked', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 50; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.end();
    const { r, store } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();
    const file = store.files.get(factorName(0))!;
    const ex = new FactorExtractor(lib.bytes, 0, 0);
    const library = TraceLibrary.fromBytes(lib.bytes);
    const engine = new TraceEngine(library, 0, 0);
    try {
      expect(ex.lastSigned().length).toBe(0);
      const n = ex.open(file);
      ex.solve(0, 10);
      expect(ex.lastSigned().length).toBe(0); // off by default
      ex.setSigned(true);
      const traces = ex.solve(10, n - 10);
      const signed = ex.lastSigned();
      expect(signed.length).toBe(traces.length);
      const frames = new Float32Array(n * PX);
      const win = FactorWindow.fromBytes(file);
      try {
        win.reconstruct(0, n, frames);
      } finally {
        win.free();
      }
      engine.setSigned(true);
      engine.processFrames(frames, n);
      const want = engine.lastSigned().subarray(10 * CELLS.length);
      let worst = 0;
      for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(signed[i] - want[i]));
      // Both solves stop at the default tolerance; the tight comparison is the Rust test.
      expect(worst).toBeLessThan(0.1);
      ex.setSigned(false);
      ex.solve(0, 5);
      expect(ex.lastSigned().length).toBe(0);
    } finally {
      ex.free();
      engine.free();
      library.free();
    }
  });

  it('gives the traces of the frame engine on the rebuilt frames', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.library(lib.version, lib.bytes);
    feed.end();
    const { r, store, toMain } = runner();
    for (const m of sent) await r.handle(m);
    r.backfill(7, lib.version);
    await r.idle();
    const windows = toMain.filter((m) => m.type === 'traces');
    expect(windows.length).toBe(2);

    const library = TraceLibrary.fromBytes(lib.bytes);
    const engine = new TraceEngine(library, 0, 0);
    const frames = new Float32Array(50 * PX);
    try {
      for (const [k, m] of windows.entries()) {
        const win = FactorWindow.fromBytes(store.files.get(factorName(k))!);
        try {
          win.reconstruct(0, 50, frames);
        } finally {
          win.free();
        }
        const want = engine.processFrames(frames, 50);
        expect(m.traces.length).toBe(want.length);
        let worst = 0;
        for (let i = 0; i < want.length; i++) {
          worst = Math.max(worst, Math.abs(m.traces[i] - want[i]));
        }
        // The two routes agree to rounding (about 6e-6 seen); the bound is
        // loose only to stay clear of platform differences.
        expect(worst, `window ${k}`).toBeLessThan(1e-3);
      }
    } finally {
      engine.free();
      library.free();
    }
  });

  it('gives the traces of the frame engine when the last window is short', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 120; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.library(lib.version, lib.bytes);
    feed.end();
    const { r, store, toMain } = runner();
    for (const m of sent) await r.handle(m);
    r.backfill(7, lib.version);
    await r.idle();
    const windows = toMain.filter((m) => m.type === 'traces');
    expect(windows.map((m) => [m.start, m.count])).toEqual([
      [0, 50],
      [50, 50],
      [100, 20],
    ]);
    expect(toMain[toMain.length - 1]).toMatchObject({ type: 'backfilled', frames: 120 });

    const library = TraceLibrary.fromBytes(lib.bytes);
    const engine = new TraceEngine(library, 0, 0);
    const frames = new Float32Array(50 * PX);
    try {
      for (const [k, m] of windows.entries()) {
        const win = FactorWindow.fromBytes(store.files.get(factorName(k))!);
        try {
          win.reconstruct(0, m.count, frames.subarray(0, m.count * PX));
        } finally {
          win.free();
        }
        const want = engine.processFrames(frames.subarray(0, m.count * PX), m.count);
        expect(m.traces.length).toBe(want.length);
        let worst = 0;
        for (let i = 0; i < want.length; i++) {
          worst = Math.max(worst, Math.abs(m.traces[i] - want[i]));
        }
        expect(worst, `window ${k}`).toBeLessThan(1e-3);
      }
    } finally {
      engine.free();
      library.free();
    }
  });

  it('frees the factor engine and posts nothing more when a reset cuts it short', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.library(lib.version, lib.bytes);
    feed.end();
    const toMain: CompressToMain[] = [];
    let freed = 0;
    let solving = false;
    let cut: Promise<void> | null = null;
    const r: CompressRunner = new CompressRunner({
      store: memoryStore(),
      quantize: quantizeTiles,
      create: (quant) => new TileCompressor(quant),
      layout: tileLayout,
      header: factorHeader,
      extract: (bytes) => {
        const inner = new FactorExtractor(bytes, 0, 0);
        return {
          ids: () => inner.ids(),
          open: (file) => inner.open(file),
          get start() {
            return inner.start;
          },
          minValid: () => inner.minValid(),
          solve: (t0, n) => {
            solving = true;
            return inner.solve(t0, n);
          },
          free: () => {
            freed++;
            inner.free();
          },
        };
      },
      toMain: { postMessage: (m) => toMain.push(m) },
      // At the first yield after a solve, a reset arrives.
      yieldNow: async () => {
        if (solving && !cut) cut = r.handle({ type: 'reset', session: 7 });
      },
    });
    for (const m of sent) await r.handle(m);
    r.backfill(7, lib.version);
    await r.idle();
    await cut;
    expect(freed).toBe(1);
    expect(toMain.some((m) => m.type === 'traces' || m.type === 'backfilled')).toBe(false);
  });

  describe('FactorExtractor as JS reaches it', () => {
    /** A valid factor file and the library's bytes, from a compressed recording. */
    async function fixture() {
      const lib = cellLibrary();
      const { feed, sent } = collectingFeed(50);
      for (let s = 0; s < 50; s += 10) feed.push(cellFrames(s, 10), s, 10);
      feed.end();
      const { r, store } = runner();
      for (const m of sent) await r.handle(m);
      await r.idle();
      return { lib, file: store.files.get(factorName(0))! };
    }

    /** The object still works: a valid open and solve, then free. */
    function expectUsable(x: FactorExtractor, file: Uint8Array) {
      expect(x.open(file)).toBe(50);
      expect(x.solve(0, 5).length).toBe(5 * 2);
      expect(() => x.free()).not.toThrow();
    }

    it('refuses bad files, a solve before open and ranges past the window, and stays usable', async () => {
      const { lib, file } = await fixture();
      const x = new FactorExtractor(lib.bytes, 0, 0);
      try {
        expect([...x.ids()]).toEqual(CELLS.map((c) => c.id));
        expect(() => x.solve(0, 1)).toThrow(/no window is open/);
        expect(() => x.open(new Uint8Array([1, 2, 3, 4]))).toThrow();
        expect(() => x.open(file.slice(0, file.length - 7))).toThrow();
        expect(() => x.open(file.slice(0, 20))).toThrow();
        expect(() => x.solve(0, 1)).toThrow(/no window is open/);

        expect(x.open(file)).toBe(50);
        expect(x.start).toBe(0);
        expect(() => x.solve(40, 11)).toThrow();
        expect(() => x.solve(51, 0)).toThrow();
        expect(() => x.solve(2, 0xffffffff)).toThrow(); // `t0 + count` wraps on wasm32
        expect(() => x.solve(0xffffffff, 0xffffffff)).toThrow();
        expect(x.solve(45, 5).length).toBe(5 * 2);
        expect(x.solve(0, 0).length).toBe(0);
        // A failed open drops the window.
        expect(() => x.open(new Uint8Array(3))).toThrow();
        expect(() => x.solve(0, 1)).toThrow(/no window is open/);
        expectUsable(x, file);
      } catch (e) {
        x.free();
        throw e;
      }
    });

    it("reports each cell's smallest valid share, and not before a window is open", async () => {
      const lib = cellLibrary();
      const { feed, sent } = collectingFeed(50);
      for (let s = 0; s < 50; s += 10) {
        const frames = cellFrames(s, 10);
        // Pixel (7, 9), the centre of cell 0's footprint, never has data.
        for (let t = 0; t < 10; t++) frames[t * PX + 7 * W + 9] = Number.NaN;
        feed.push(frames, s, 10);
      }
      feed.end();
      const { r, store } = runner();
      for (const m of sent) await r.handle(m);
      await r.idle();
      const x = new FactorExtractor(lib.bytes, 0, 0);
      try {
        expect(() => x.minValid()).toThrow(/no window is open/);
        expect(x.open(store.files.get(factorName(0))!)).toBe(50);
        const v = x.minValid();
        expect(v.length).toBe(CELLS.length);
        expect(v[0]).toBe(0);
        expect(v[1]).toBe(1);
        // A failed open drops the window again.
        expect(() => x.open(new Uint8Array(3))).toThrow();
        expect(() => x.minValid()).toThrow(/no window is open/);
      } finally {
        x.free();
      }
    });

    it('takes a library without cells: no ids, and the back-fill posts nothing', async () => {
      const b = new TraceLibraryBuilder(W, H);
      const empty = b.buildUnfiltered();
      const bytes = empty.toBytes();
      const version = empty.version;
      empty.free();
      b.free();
      const x = new FactorExtractor(bytes, 0, 0);
      try {
        expect(x.ids().length).toBe(0);
      } finally {
        x.free();
      }

      const { feed, sent } = collectingFeed(50);
      for (let s = 0; s < 50; s += 10) feed.push(cellFrames(s, 10), s, 10);
      feed.library(version, bytes);
      feed.end();
      const { r, toMain } = runner();
      for (const m of sent) await r.handle(m);
      r.backfill(7, version);
      await r.idle();
      expect(toMain.some((m) => m.type === 'traces' || m.type === 'backfilled')).toBe(false);
      expect(toMain.some((m) => m.type === 'error')).toBe(false);
    });
  });

  it('is requested once per run, and its traces replace the live history', () => {
    const cells = createCellStore();
    const store = createCompressStore(cells);
    cells.reset(3);
    store.reset(3);
    const status = {
      windows: 2,
      frames: 100,
      pending: 0,
      pendingFrames: 0,
      meanRank: 2,
      msPerFrame: 8,
      factorBytes: 1 << 20,
      final: false,
      tiling: 'plain' as const,
      source: 'discover' as const,
    };
    store.onMessage({ type: 'status', session: 3, status });
    expect(store.takeBackfill(true, true, 4)).toBe(false); // windows still open
    store.onMessage({ type: 'status', session: 3, status: { ...status, final: true } });
    expect(store.takeBackfill(false, true, 4)).toBe(false); // still reading
    expect(store.takeBackfill(true, true, 0)).toBe(false); // no cells
    expect(store.takeBackfill(true, true, 4)).toBe(true);
    expect(store.takeBackfill(true, true, 4)).toBe(false);

    // Live history: cell 5 from frame 60 on. Back-fill: from frame 0.
    cells.history().push(60, 2, [5], [1, 2]);
    const traces = Float32Array.from({ length: 50 }, (_, i) => i);
    store.onMessage({
      type: 'traces',
      session: 3,
      version: 4,
      first: true,
      start: 0,
      count: 50,
      ids: Uint32Array.of(5),
      traces,
    });
    expect(cells.history().span(5)).toEqual({ first: 0, end: 50 });
    store.onMessage({
      type: 'traces',
      session: 9,
      version: 4,
      first: true,
      start: 0,
      count: 1,
      ids: Uint32Array.of(5),
      traces: Float32Array.of(7),
    });
    expect(cells.history().span(5)).toEqual({ first: 0, end: 50 });
    store.onMessage({ type: 'backfilled', session: 3, version: 4, frames: 100, msPerFrame: 2.5 });
    expect(compressReadout(store.status(), store.backfill())).toMatch(
      /traces back-filled \(100 frames, 2\.5 ms\/frame\)$/,
    );
  });

  it("is not requested on the final status of Extract's replay", () => {
    const store = createCompressStore();
    store.reset(3);
    const status = {
      windows: 2,
      frames: 100,
      pending: 0,
      pendingFrames: 0,
      meanRank: 2,
      msPerFrame: 8,
      factorBytes: 1 << 20,
      final: true,
      tiling: 'offset' as const,
      source: 'replay' as const,
    };
    store.onMessage({ type: 'status', session: 3, status });
    expect(store.takeBackfill(true, true, 4)).toBe(false);
    store.onMessage({
      type: 'status',
      session: 3,
      status: { ...status, tiling: 'plain', source: 'discover' },
    });
    expect(store.takeBackfill(true, true, 4)).toBe(true);
  });
});

describe('the compress store and the errors of Extract jobs', () => {
  it("an error that names a job is not the compression's", () => {
    const store = createCompressStore();
    store.reset(3);
    store.onMessage({ type: 'error', session: 3, job: 1, message: 'job failed' });
    expect(store.error()).toBeNull();
    store.onMessage({ type: 'error', session: 3, message: 'compression failed' });
    expect(store.error()).toBe('compression failed');
  });
});

describe('Extract on factors (the compress worker)', () => {
  it('solves every window with the given library, with signed traces, and says when it is done', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.end();
    const { r, store, toMain } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();
    r.extract(7, 3, lib.bytes.slice());
    await r.idle();
    const windows = toMain.filter((m) => m.type === 'extracted');
    expect(windows.map((m) => [m.job, m.start, m.count])).toEqual([
      [3, 0, 50],
      [3, 50, 50],
    ]);
    // The windows solved directly, in order, by one engine of the same class
    // (it keeps state from one window to the next, as the runner's does).
    const direct = new FactorExtractor(lib.bytes.slice(), 0, 0);
    direct.setSigned(true);
    windows.forEach((m, w) => {
      expect([...m.ids]).toEqual(CELLS.map((c) => c.id));
      expect(m.signed.length).toBe(m.traces.length);
      expect(direct.open(store.files.get(factorName(w))!)).toBe(m.count);
      const want = direct.solve(0, m.count);
      const wantSigned = direct.lastSigned();
      for (let k = 0; k < want.length; k++) {
        expect(m.traces[k]).toBeCloseTo(want[k], 3);
        expect(m.signed[k]).toBeCloseTo(wantSigned[k], 3);
      }
      for (let i = 0; i < m.count; i++) {
        CELLS.forEach((c, j) => {
          expect(m.traces[i * CELLS.length + j]).toBeCloseTo(c.trace(m.start + i), 1);
        });
      }
    });
    direct.free();
    expect(toMain[toMain.length - 1]).toMatchObject({
      type: 'extract-done',
      session: 7,
      job: 3,
      frames: 100,
    });
    expect(toMain.some((m) => m.type === 'traces' || m.type === 'backfilled')).toBe(false);
  });

  it("carries each window's smallest valid shares, one per cell, in trace column order", async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) {
      const frames = cellFrames(s, 10);
      // Cell 1's centre pixel has no data in the second window only.
      if (s >= 50) for (let t = 0; t < 10; t++) frames[t * PX + 15 * W + 28] = Number.NaN;
      feed.push(frames, s, 10);
    }
    feed.end();
    const { r, toMain } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();
    r.extract(7, 3, lib.bytes.slice());
    await r.idle();
    const windows = toMain.filter((m) => m.type === 'extracted');
    expect(windows.length).toBe(2);
    expect(windows.map((m) => [...m.minValid])).toEqual([
      [1, 1],
      [1, 0],
    ]);
    for (const m of windows) expect(m.minValid.length).toBe(m.ids.length);
  });

  it('refuses, naming the job, while a window is open or for another session', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 60; s += 10) feed.push(cellFrames(s, 10), s, 10);
    const { r, toMain } = runner();
    for (const m of sent) await r.handle(m); // window 1 is open: the recording has not ended
    await r.idle();
    r.extract(7, 4, lib.bytes.slice());
    r.extract(99, 5, lib.bytes.slice());
    await r.idle();
    const errors = toMain.filter((m) => m.type === 'error');
    expect(errors.map((m) => [m.session, m.job])).toEqual([
      [7, 4],
      [99, 5],
    ]);
    expect(toMain.some((m) => m.type === 'extracted')).toBe(false);
  });

  it("reports a failed solve as the job's error and keeps compressing later windows", async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.end();
    let fail = true;
    const { r, toMain } = runner(memoryStore(), {
      extract: (bytes) => {
        if (fail) throw new Error('out of memory');
        return new FactorExtractor(bytes, 0, 0);
      },
    });
    for (const m of sent) await r.handle(m);
    await r.idle();
    const before = toMain.length;
    r.extract(7, 6, lib.bytes.slice());
    await r.idle();
    expect(toMain.filter((m) => m.type === 'error')).toEqual([
      { type: 'error', session: 7, job: 6, message: 'out of memory' },
    ]);
    // No message after the call marks the compression as failed or unfinished.
    const after = toMain.slice(before);
    expect(after.filter((m) => m.type === 'status' && !m.status.final)).toEqual([]);
    // The windows are still readable: a second job with a working engine succeeds.
    fail = false;
    r.extract(7, 7, lib.bytes.slice());
    await r.idle();
    const second = toMain.slice(before).filter((m) => 'job' in m && m.job === 7);
    expect(second.map((m) => m.type)).toEqual(['extracted', 'extracted', 'extract-done']);
  });

  it('answers a queued job with its own error when the runner is reset', async () => {
    const lib = cellLibrary();
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) feed.push(cellFrames(s, 10), s, 10);
    feed.end();
    const { r, toMain } = runner();
    for (const m of sent) await r.handle(m); // the last window is still being compressed
    r.extract(7, 8, lib.bytes.slice());
    await r.handle({ type: 'reset', session: 7 });
    await r.idle();
    const mine = toMain.filter((m) => 'job' in m && m.job === 8);
    expect(mine.map((m) => m.type)).toEqual(['error']);
    expect(toMain.some((m) => m.type === 'extracted' || m.type === 'extract-done')).toBe(false);
  });
});

describe('the feed options of the cells of a worker', () => {
  it('Discover: plain tiles, discover frames, its own session', () => {
    expect(compressFeedOptions({ compress: true, session: 3 }, 64, 48)).toEqual({
      width: 64,
      height: 48,
      session: 3,
      source: 'discover',
    });
  });
  it('Extract: offset tiles, replay frames, the compress session', () => {
    const cells = {
      compress: true,
      session: 0,
      library: Uint8Array.of(1),
      compressTiling: 'offset' as const,
      compressSession: 4,
    };
    expect(compressFeedOptions(cells, 64, 48)).toEqual({
      width: 64,
      height: 48,
      session: 4,
      tiling: 'offset',
      source: 'replay',
    });
  });
  it('without compress: no options and no feed', () => {
    expect(compressFeedOptions({ session: 1 }, 64, 48)).toBeNull();
    expect(compressFeedOptions(undefined, 64, 48)).toBeNull();
    expect(compressFeedFor({ session: 1 }, 64, 48, { postMessage: () => {} })).toBeNull();
    expect(compressFeedFor({ compress: true, session: 1 }, 64, 48, null)).toBeNull();
  });
});

describe('the batch driver waits for the final status of a stage', () => {
  const st = { source: 'replay', final: true, pending: 0 };
  it('accepts only the final status of the expected source', async () => {
    const { compressSettled } = await import('../../scripts/compress-settled.mjs');
    expect(compressSettled(st, 'replay')).toBe(true);
    expect(compressSettled({ ...st, source: 'discover' }, 'replay')).toBe(false);
    expect(compressSettled({ ...st, final: false }, 'replay')).toBe(false);
    expect(compressSettled({ ...st, pending: 2 }, 'replay')).toBe(false);
    expect(compressSettled(null, 'replay')).toBe(false);
    expect(compressSettled(null, 'discover')).toBe(false);
  });
});
