// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { CompressFeed, GPU_STALL_S } from '../lib/compress-feed.ts';
import { WindowPool, type TilePoolLike } from '../lib/compress-pool.ts';
import { solveWindow } from '../lib/factor-solve.ts';
import {
  backlogText,
  GPU_CHECK_SEED,
  GPU_TEXT,
  STOPPED_TEXT,
  CompressRunner,
  factorName,
  tilesOf,
  type CompressRunnerDeps,
} from '../lib/compress-runner.ts';
import { compressReadout, createCompressStore } from '../lib/compress-store.ts';
import { cutTile } from '../lib/factor-check.ts';
import {
  GpuSketchTooLarge,
  type GpuCompressorLike,
  type GpuWindowJob,
  type GpuWindowResult,
} from '../lib/gpu-compress.ts';
import { memoryStore } from '../lib/window-store.ts';
import type {
  CompressToFast,
  CompressToMain,
  CoordinatorToHelper,
  FastToCompress,
} from '../workers/compress-types.ts';
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

function runner(store = memoryStore()) {
  const toMain: CompressToMain[] = [];
  const r = new CompressRunner({
    store,
    quantize: quantizeTiles,
    layout: tileLayout,
    header: factorHeader,
    create: (quant) => new TileCompressor(quant),
    engine: (bytes) => {
      const lib = TraceLibrary.fromBytes(bytes);
      const engine = new TraceEngine(lib, 0, 0);
      const ids = lib.ids();
      lib.free();
      return {
        ids: () => ids,
        processFrames: (frames, count) => engine.processFrames(frames, count),
        free: () => engine.free(),
      };
    },
    factors: (bytes) => FactorWindow.fromBytes(bytes),
    toMain: { postMessage: (m) => toMain.push(m) },
    yieldNow: () => Promise.resolve(),
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
    const { feed, sent } = feedWith({});
    feed.push(batch(0, 50), 0, 50);
    feed.end();
    const { r, store, toMain } = runner();
    let broken = true;
    const deps = (r as unknown as { deps: { layout: typeof tileLayout } }).deps;
    const layout = deps.layout;
    deps.layout = (...a) => {
      if (broken) throw new Error('layout refused');
      return layout(...a);
    };
    await expect(r.handle(sent[0])).rejects.toThrow('layout refused');
    for (const m of sent.slice(1)) await r.handle(m); // late chunks of the refused session
    await r.idle();
    expect(store.files.size).toBe(0);
    broken = false;
    for (const m of sent) await r.handle(m);
    await r.idle();
    expect([...store.files.keys()]).toEqual([factorName(0)]);
    expect(toMain.some((m) => m.type === 'error')).toBe(false);
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

describe('the compress pool and the cap on waiting windows', () => {
  /** A pool that keeps every window until it is reset, and records the widths it is given. */
  function stuckPool() {
    const widths: number[] = [];
    let release: (() => void) | null = null;
    const pool: TilePoolLike = {
      begin: () => {},
      setWidth: (n) => void widths.push(n),
      width: () => widths.at(-1) ?? 1,
      reset: () => {
        release?.();
        release = null;
      },
      compressWindow: () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(false);
        }),
    };
    return { pool, widths };
  }

  function runnerWith(deps: Partial<CompressRunnerDeps>) {
    const store = memoryStore();
    const toMain: CompressToMain[] = [];
    const r = new CompressRunner({
      store,
      quantize: quantizeTiles,
      layout: tileLayout,
      header: factorHeader,
      create: (quant) => new TileCompressor(quant),
      toMain: { postMessage: (m) => toMain.push(m) },
      yieldNow: () => Promise.resolve(),
      ...deps,
    });
    return { r, store, toMain };
  }

  /** Bytes of a 50-frame window file (plain tiles cover the frame once, int16). */
  const WINDOW_BYTES = 50 * PX * 2;

  it('gives the factors up past the cap: one error, no files, nothing written after; a new run compresses again', async () => {
    const { pool } = stuckPool();
    const { r, store, toMain } = runnerWith({
      pool,
      // Half of what the origin may store: one window.
      estimate: () => Promise.resolve({ quota: 3 * WINDOW_BYTES, usage: WINDOW_BYTES }),
    });
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 150; s += 10) feed.push(batch(s, 10), s, 10);
    for (const m of sent) await r.handle(m);
    const errors = toMain.filter((m) => m.type === 'error');
    expect(errors).toEqual([{ type: 'error', session: 7, message: backlogText(WINDOW_BYTES) }]);
    expect(store.files.size).toBe(0);

    const again: FastToCompress[] = [];
    const next = new CompressFeed(
      { width: W, height: H, session: 8, tile: TILE, window: 50, quant: QUANT },
      { postMessage: (m) => again.push(m) },
    );
    next.push(batch(0, 10), 0, 10);
    for (const m of again) await r.handle(m);
    expect([...store.files.keys()]).toEqual(['w0.i16']);
  });

  it('stops a run whose settle re-reads the file: no files, no error, nothing written after; another session is untouched', async () => {
    const { pool } = stuckPool();
    const { r, store, toMain } = runnerWith({ pool });
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) feed.push(batch(s, 10), s, 10);
    for (const m of sent) await r.handle(m);
    expect(store.files.size).toBeGreaterThan(0);
    await r.stop(6);
    expect(store.files.size).toBeGreaterThan(0);
    await r.stop(7);
    expect(store.files.size).toBe(0);
    sent.length = 0;
    feed.push(batch(100, 10), 100, 10);
    for (const m of sent) await r.handle(m);
    expect(store.files.size).toBe(0);
    expect(toMain.filter((m) => m.type === 'error')).toEqual([]);
    r.extract(7, 1, 0, new Uint8Array(0));
    expect(toMain.at(-1)).toEqual({ type: 'error', session: 7, job: 1, message: STOPPED_TEXT });
  });

  it('switches from the discover width to the after width when the recording ends', async () => {
    const { pool, widths } = stuckPool();
    const { r } = runnerWith({ pool });
    const sent: FastToCompress[] = [];
    const feed = new CompressFeed(
      {
        width: W,
        height: H,
        session: 7,
        tile: TILE,
        window: 50,
        quant: QUANT,
        pool: { discover: 2, after: 3 },
      },
      { postMessage: (m) => sent.push(m) },
    );
    feed.push(batch(0, 60), 0, 60);
    feed.end();
    for (const m of sent) await r.handle(m);
    expect(widths).toEqual([2, 3]);
  });

  it('reports the pool, the backlog and the lag at the end in its status', async () => {
    const { feed, sent } = collectingFeed(50);
    feed.push(batch(0, 120), 0, 120);
    feed.end();
    const { r, toMain } = runner();
    for (const m of sent) await r.handle(m);
    await r.idle();
    const last = toMain.filter((m) => m.type === 'status').at(-1);
    if (last?.type !== 'status') throw new Error('expected a status');
    expect(last.status).toMatchObject({ workers: 1, backlogBytes: 0, final: true });
    expect(last.status.backlogPeakBytes).toBeGreaterThanOrEqual(WINDOW_BYTES);
    expect(last.status.behindAtEnd).not.toBeNull();
    expect(last.status.fps).toBeGreaterThan(0);
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
      folder: 'run-a',
      compressed: [],
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
});

describe('Extract on the factors', () => {
  /** A solver that returns each frame's first value; its signed traces are the negatives. */
  function extractRunner(onBatch?: () => void) {
    const toMain: CompressToMain[] = [];
    const r = new CompressRunner({
      store: memoryStore(),
      quantize: quantizeTiles,
      layout: tileLayout,
      header: factorHeader,
      create: (quant) => new TileCompressor(quant),
      engine: (_bytes, signed) => {
        let last = new Float32Array(0);
        return {
          ids: () => Uint32Array.of(5),
          processFrames: (frames, count) => {
            onBatch?.();
            const out = new Float32Array(count);
            for (let i = 0; i < count; i++) out[i] = frames[i * PX];
            last = out.map((v) => -v);
            return out;
          },
          ...(signed ? { lastSigned: () => last } : {}),
          free: () => {},
        };
      },
      factors: (bytes) => FactorWindow.fromBytes(bytes),
      toMain: { postMessage: (m) => toMain.push(m) },
      yieldNow: () => Promise.resolve(),
    });
    return { r, toMain };
  }

  async function fed(r: CompressRunner): Promise<void> {
    const { feed, sent } = collectingFeed(50);
    for (let s = 0; s < 100; s += 10) feed.push(batch(s, 10), s, 10);
    feed.end();
    for (const m of sent) await r.handle(m);
    await r.idle();
  }

  it('posts one extracted per window in stream order, then extract-done', async () => {
    const { r, toMain } = extractRunner();
    await fed(r);
    r.extract(7, 3, 1, Uint8Array.of(1));
    await r.idle();
    const windows = toMain.filter((m) => m.type === 'extracted');
    expect(windows.map((m) => [m.job, m.start, m.count])).toEqual([
      [3, 0, 50],
      [3, 50, 50],
    ]);
    for (const m of windows) {
      expect([...m.ids]).toEqual([5]);
      for (const i of [0, 17, 49]) {
        expect(m.traces[i]).toBeCloseTo(frame(m.start + i)[0], 0);
        expect(m.signed?.[i]).toBeCloseTo(-m.traces[i], 5);
      }
    }
    expect(toMain.at(-1)).toMatchObject({ type: 'extract-done', session: 7, job: 3, frames: 100 });
  });

  it('extractCancel mid-job posts no more windows and no extract-done', async () => {
    let cancel = (): void => {};
    const { r, toMain } = extractRunner(() => cancel());
    await fed(r);
    cancel = () => r.extractCancel(7, 3);
    r.extract(7, 3, 1, Uint8Array.of(1));
    await r.idle();
    expect(toMain.filter((m) => m.type === 'extracted' || m.type === 'extract-done')).toEqual([]);
  });
});

describe('Extract on the factor extractor (slice 6)', () => {
  type Extracted = Extract<CompressToMain, { type: 'extracted' }>;

  /** A runner with the app's real engines; `extractor`: Extract through the `FactorExtractor`. */
  function realRunner(o: { extractor: boolean; windows?: WindowPool }) {
    const toMain: CompressToMain[] = [];
    const r = new CompressRunner({
      store: memoryStore(),
      quantize: quantizeTiles,
      layout: tileLayout,
      header: factorHeader,
      create: (quant) => new TileCompressor(quant),
      engine: (bytes, signed) => {
        const lib = TraceLibrary.fromBytes(bytes);
        const engine = new TraceEngine(lib, 0, 0);
        if (signed) engine.setSigned(true);
        const ids = lib.ids();
        lib.free();
        return {
          ids: () => ids,
          processFrames: (frames, count) => engine.processFrames(frames, count),
          ...(signed ? { lastSigned: () => engine.lastSigned() } : {}),
          free: () => engine.free(),
        };
      },
      factors: (bytes) => FactorWindow.fromBytes(bytes),
      ...(o.extractor
        ? {
            extractor: (bytes: Uint8Array, signed: boolean) => {
              const x = new FactorExtractor(bytes, 0, 0);
              if (signed) x.setSigned(true);
              return x;
            },
          }
        : {}),
      ...(o.windows ? { windows: o.windows } : {}),
      toMain: { postMessage: (m) => toMain.push(m) },
      yieldNow: () => Promise.resolve(),
    });
    return { r, toMain };
  }

  /** 150 frames of the two cells in 50-frame windows on the offset grids; `nan`: a pixel missing in frames `from..to`. */
  async function feedCells(
    r: CompressRunner,
    extract = 1,
    nan?: { pixel: number; from: number; to: number },
  ): Promise<void> {
    const sent: FastToCompress[] = [];
    const feed = new CompressFeed(
      {
        width: W,
        height: H,
        session: 7,
        tile: TILE,
        window: 50,
        quant: QUANT,
        tiling: 'offset',
        pool: { discover: 1, after: 1, extract },
      },
      { postMessage: (m) => sent.push(m) },
    );
    for (let s = 0; s < 150; s += 10) {
      const b = cellFrames(s, 10);
      if (nan) {
        for (let i = 0; i < 10; i++)
          if (s + i >= nan.from && s + i < nan.to) b[i * PX + nan.pixel] = NaN;
      }
      feed.push(b, s, 10);
    }
    feed.end();
    for (const m of sent) await r.handle(m);
    await r.idle();
  }

  const extracted = (toMain: CompressToMain[]): Extracted[] =>
    toMain.filter((m): m is Extracted => m.type === 'extracted');

  /** The largest `|a - b| / (1 + |a|)` over two runs' traces of one window. */
  function gap(a: Float32Array, b: Float32Array, from = 0, to = a.length): number {
    let worst = 0;
    for (let i = from; i < to; i++)
      worst = Math.max(worst, Math.abs(a[i] - b[i]) / (1 + Math.abs(a[i])));
    return worst;
  }

  async function extractAll(r: CompressRunner, toMain: CompressToMain[]): Promise<void> {
    r.extract(7, 3, 1, cellLibrary().bytes);
    await r.idle();
    expect(toMain.at(-1)?.type).toBe('extract-done');
  }

  it('projects every window of a recording without missing pixels, as the rebuilt frames to rounding', async () => {
    const ref = realRunner({ extractor: false });
    await feedCells(ref.r);
    await extractAll(ref.r, ref.toMain);
    const fx = realRunner({ extractor: true });
    await feedCells(fx.r);
    await extractAll(fx.r, fx.toMain);
    expect(fx.toMain.at(-1)).toMatchObject({ projected: 3, rebuilt: 0, frames: 150 });
    const [a, b] = [extracted(ref.toMain), extracted(fx.toMain)];
    expect(b.map((m) => [m.start, m.count])).toEqual(a.map((m) => [m.start, m.count]));
    // The first window starts cold in both: phase 2's bound.
    expect(gap(a[0].traces, b[0].traces)).toBeLessThan(2e-4);
    // Later windows start cold here and warm in the rebuilt route: their first frames differ
    // a little (1.3e-3 measured), from frame 10 on (2 cells a frame) again to rounding.
    for (let k = 1; k < 3; k++) {
      expect(gap(a[k].traces, b[k].traces)).toBeLessThan(5e-3);
      expect(gap(a[k].traces, b[k].traces, 20)).toBeLessThan(2e-4);
    }
    expect(b[0].signed?.length).toBe(b[0].traces.length);
  });

  it('solves a window with a pixel without data under a cell on rebuilt frames', async () => {
    const pixel = CELLS[0].cy * W + CELLS[0].cx;
    const nan = { pixel, from: 50, to: 100 };
    const ref = realRunner({ extractor: false });
    await feedCells(ref.r, 1, nan);
    await extractAll(ref.r, ref.toMain);
    const fx = realRunner({ extractor: true });
    await feedCells(fx.r, 1, nan);
    await extractAll(fx.r, fx.toMain);
    expect(fx.toMain.at(-1)).toMatchObject({ projected: 2, rebuilt: 1, frames: 150 });
    const [a, b] = [extracted(ref.toMain), extracted(fx.toMain)];
    // The same rebuilt frames, from a cold start instead of the last window's.
    expect(gap(a[1].traces, b[1].traces)).toBeLessThan(5e-3);
    expect(gap(a[1].traces, b[1].traces, 20)).toBeLessThan(2e-4);
  });

  it('gives the same traces with three helpers answering out of order as with none', async () => {
    const one = realRunner({ extractor: true });
    await feedCells(one.r, 1);
    await extractAll(one.r, one.toMain);

    // Three fake helpers that solve in this thread, answering the newest window first.
    const pending: { k: number; m: Extract<CoordinatorToHelper, { type: 'extract-window' }> }[] =
      [];
    const xs = new Map<number, { x: FactorExtractor; px: number }>();
    const ports = [0, 1, 2].map((k) => ({
      postMessage: (m: CoordinatorToHelper) => {
        if (m.type === 'extract-begin') {
          const x = new FactorExtractor(m.library, 0, 0);
          if (m.signed) x.setSigned(true);
          xs.set(k, { x, px: m.px });
        } else if (m.type === 'extract-window') pending.push({ k, m });
        else if (m.type === 'extract-end') {
          xs.get(k)?.x.free();
          xs.delete(k);
        }
      },
    }));
    const windows = new WindowPool({ helpers: ports });
    const three = realRunner({ extractor: true, windows });
    await feedCells(three.r, 3);
    three.r.extract(7, 3, 1, cellLibrary().bytes);
    for (let i = 0; i < 100 && !three.toMain.some((m) => m.type === 'extract-done'); i++) {
      await new Promise((res) => setTimeout(res, 0));
      for (const { k, m } of pending.splice(0).reverse()) {
        const h = xs.get(k)!;
        const r = solveWindow(h.x, m.bytes, (b) => FactorWindow.fromBytes(b), h.px, true);
        windows.onHelper(k, { type: 'window-done', job: m.job, index: m.index, ...r });
      }
    }
    expect(three.toMain.at(-1)).toMatchObject({ type: 'extract-done', workers: 3, frames: 150 });
    const [a, b] = [extracted(one.toMain), extracted(three.toMain)];
    expect(b.map((m) => m.start)).toEqual([0, 50, 100]);
    for (let k = 0; k < 3; k++) {
      expect([...b[k].traces]).toEqual([...a[k].traces]);
      expect([...(b[k].signed ?? [])]).toEqual([...(a[k].signed ?? [])]);
    }
  });
});

describe('a recording compressed on the GPU', () => {
  const GW = 64;
  const GH = 64;
  const GTILE = 16;
  /** Tiles of the offset layout of a 64 x 64 frame (after the WASM module is ready). */
  let GTILES = 0;
  beforeAll(() => {
    GTILES = tileLayout(GW, GH, GTILE, 'offset').length / 4;
  });

  function fakeGpuCompressor(window: number, slack: number) {
    const pending: {
      job: GpuWindowJob;
      resolve: (r: GpuWindowResult) => void;
      reject: (err: unknown) => void;
    }[] = [];
    const jobs: GpuWindowJob[] = [];
    /** Each upload's first stream frame and count. */
    const uploads: [number, number][] = [];
    let lose: (reason: string) => void = () => {};
    let destroyed = 0;
    const gpu: GpuCompressorLike = {
      window,
      slack,
      upload: (_q, start, count) => void uploads.push([start, count]),
      compress: (job) =>
        new Promise((resolve, reject) => {
          jobs.push(job);
          pending.push({ job, resolve, reject });
        }),
      lost: new Promise((r) => (lose = r)),
      destroy: () => void destroyed++,
    };
    /** Answer the oldest pending window with one 8-byte tile per layout tile. */
    const answer = (tiles: number) => {
      const p = pending.shift()!;
      p.resolve({
        tiles: Array.from({ length: tiles }, () => new Uint8Array(8)),
        ranks: Array(tiles).fill(3),
        ms: 1,
      });
    };
    return {
      gpu,
      pending,
      jobs,
      uploads,
      answer,
      lose: (r: string) => lose(r),
      destroyed: () => destroyed,
    };
  }

  /** A runner whose every run opens a new fake GPU compressor (window 50, slack 13). */
  function gpuRunner(open?: CompressRunnerDeps['openGpu'], toFast?: CompressRunnerDeps['toFast']) {
    const store = memoryStore();
    const toMain: CompressToMain[] = [];
    const fakes: ReturnType<typeof fakeGpuCompressor>[] = [];
    const r = new CompressRunner({
      store,
      quantize: quantizeTiles,
      layout: tileLayout,
      header: factorHeader,
      create: (quant) => new TileCompressor(quant),
      toMain: { postMessage: (m) => toMain.push(m) },
      ...(toFast ? { toFast } : {}),
      yieldNow: () => Promise.resolve(),
      openGpu:
        open ??
        (async () => {
          const f = fakeGpuCompressor(50, 13);
          fakes.push(f);
          return f.gpu;
        }),
    });
    return { r, store, toMain, fakes };
  }

  /** The feed's messages for `frames` frames in chunks of 10; its window (30) is not the GPU's. */
  function gpuFeed(frames: number, session = 7, end = true): FastToCompress[] {
    const sent: FastToCompress[] = [];
    const feed = new CompressFeed(
      {
        width: GW,
        height: GH,
        session,
        tile: GTILE,
        tiling: 'offset',
        window: 30,
        quant: QUANT,
        gpu: true,
      },
      { postMessage: (m) => sent.push(m) },
    );
    for (let s = 0; s < frames; s += 10) {
      const n = Math.min(10, frames - s);
      feed.push(new Float32Array(n * GW * GH).fill(s % 7), s, n);
    }
    if (end) feed.end();
    return sent;
  }

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** Handle each message, answering every window the GPU was given before the next. */
  async function feedAnswering(
    r: CompressRunner,
    fakes: ReturnType<typeof fakeGpuCompressor>[],
    sent: FastToCompress[],
  ): Promise<void> {
    for (const m of sent) {
      await r.handle(m);
      await tick();
      for (const f of fakes) {
        while (f.pending.length > 0) {
          f.answer(GTILES);
          await tick();
        }
      }
    }
  }

  const statuses = (toMain: CompressToMain[]) =>
    toMain.flatMap((m) => (m.type === 'status' ? [m] : []));
  const errors = (toMain: CompressToMain[]) =>
    toMain.flatMap((m) => (m.type === 'error' ? [m] : []));

  it("windows of the GPU's length cover every frame but a 1-frame tail", async () => {
    const { r, store, toMain, fakes } = gpuRunner();
    const sent = gpuFeed(120);
    expect(sent[0]).toMatchObject({ type: 'init', gpu: true, window: 30 });
    await feedAnswering(r, fakes, sent);
    const last = statuses(toMain).at(-1)!.status;
    expect(last.compressed).toEqual([
      { index: 0, start: 0, frames: 50 },
      { index: 1, start: 50, frames: 50 },
      { index: 2, start: 100, frames: 20 },
    ]);
    expect(last).toMatchObject({ final: true, windows: 3, frames: 120, pending: 0 });
    expect(last).toMatchObject({ window: 50, ring: 63, backend: 'gpu', meanRank: 3 });
    // The last window written, the GPU is freed; a device lost then changes nothing.
    expect(fakes[0].destroyed()).toBe(1);
    fakes[0].lose('late');
    await tick();
    expect(store.files.size).toBe(3);
    expect([...store.files.keys()].sort()).toEqual(['f0.bin', 'f1.bin', 'f2.bin']);
    // The factor file: the header, then per tile its length and bytes.
    const f2 = store.files.get('f2.bin')!;
    const head = factorHeader(GW, GH, GTILE, 'offset', 20, GTILES, 100);
    expect(f2.subarray(0, head.length)).toEqual(head);
    expect(f2.length).toBe(head.length + GTILES * (4 + 8));
    // The CPU's seeds, and each tile's rank of the window before.
    const jobs = fakes[0].jobs;
    expect(jobs.map((j) => [j.index, j.start, j.frames])).toEqual([
      [0, 0, 50],
      [1, 50, 50],
      [2, 100, 20],
    ]);
    expect(jobs[1].seeds(5)).toBe(((1 << 20) ^ 5) >>> 0);
    expect(jobs[0].prevRanks(0)).toBeUndefined();
    expect(jobs[1].prevRanks(0)).toBe(3);
    expect(errors(toMain)).toEqual([]);

    // 101 frames: the last frame alone is no window.
    const b = gpuRunner();
    await feedAnswering(b.r, b.fakes, gpuFeed(101));
    expect(statuses(b.toMain).at(-1)!.status.compressed).toEqual([
      { index: 0, start: 0, frames: 50 },
      { index: 1, start: 50, frames: 50 },
    ]);
    expect([...b.store.files.keys()].sort()).toEqual(['f0.bin', 'f1.bin']);
  });

  it('a GPU that falls behind gives the factors up and never blocks', async () => {
    const { r, store, toMain, fakes } = gpuRunner();
    const sent = gpuFeed(200);
    for (const m of sent) await r.handle(m); // never answered: every call must resolve
    expect(errors(toMain)).toEqual([{ type: 'error', session: 7, message: GPU_TEXT.behind }]);
    expect(store.files.size).toBe(0);
    expect(fakes[0].jobs).toHaveLength(1);
    expect(fakes[0].destroyed()).toBe(1);
    r.extract(7, 1, 0, new Uint8Array(0));
    expect(toMain.at(-1)).toEqual({ type: 'error', session: 7, job: 1, message: GPU_TEXT.behind });
  });

  it('a lost device ends the factors', async () => {
    const { r, store, toMain, fakes } = gpuRunner();
    const sent = gpuFeed(120);
    const first = sent.findIndex((m) => m.type === 'chunk' && m.start === 50);
    await feedAnswering(r, fakes, sent.slice(0, first));
    expect(store.files.has('f0.bin')).toBe(true);
    fakes[0].lose('gone');
    await tick();
    await feedAnswering(r, fakes, sent.slice(first));
    const errs = errors(toMain);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe(GPU_TEXT.lost('gone'));
    expect(errs[0].message).toContain('gone');
    expect(store.files.size).toBe(0);
    expect(fakes[0].jobs).toHaveLength(1);
  });

  it('a new run during a pending window writes nothing of the old run', async () => {
    const { r, store, toMain, fakes } = gpuRunner();
    for (const m of gpuFeed(50, 7, false)) await r.handle(m);
    expect(fakes[0].pending).toHaveLength(1);
    const next = gpuFeed(1, 8, false);
    await r.handle(next[0]); // init of session 8
    expect(fakes[0].destroyed()).toBe(1);
    fakes[0].answer(GTILES);
    await tick();
    await tick();
    expect(store.files.has('f0.bin')).toBe(false);
    expect(statuses(toMain).filter((m) => m.session === 7)).toEqual([]);
    await r.handle({ type: 'close', session: 8, final: true });
    const last = statuses(toMain).at(-1)!;
    expect(last.session).toBe(8);
    expect(last.status).toMatchObject({ windows: 0, frames: 0, compressed: [] });
  });

  it('a chunk going back in the stream after a window boundary gives the factors up', async () => {
    const { r, store, toMain, fakes } = gpuRunner();
    const sent = gpuFeed(60, 7, false);
    const at50 = sent.findIndex((m) => m.type === 'chunk' && m.start === 50);
    for (const m of sent.slice(0, at50)) await r.handle(m);
    expect(fakes[0].pending).toHaveLength(1); // window 0 (frames 0-49) on the GPU
    const back = gpuFeed(60, 7, false).find((m) => m.type === 'chunk' && m.start === 40)!;
    await r.handle(back); // frames 40-49 again: would overwrite window 0's ring slots
    expect(fakes[0].pending).toHaveLength(1);
    fakes[0].answer(GTILES);
    await tick();
    await tick();
    const errs = errors(toMain);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe(GPU_TEXT.error('frame 40 after frame 49'));
    expect(store.files.size).toBe(0);
    expect(fakes[0].jobs).toHaveLength(1);
  });

  it('a window the GPU cannot compress gives the factors up: no files, one error, no more windows', async () => {
    for (const [err, text] of [
      [new GpuSketchTooLarge('tile 3'), GPU_TEXT.sketch],
      [new Error('device busy'), GPU_TEXT.error('device busy')],
    ] as const) {
      const { r, store, toMain, fakes } = gpuRunner();
      const sent = gpuFeed(160);
      const at50 = sent.findIndex((m) => m.type === 'chunk' && m.start === 50);
      await feedAnswering(r, fakes, sent.slice(0, at50));
      expect(store.files.has('f0.bin')).toBe(true);
      for (const m of sent.slice(at50, at50 + 5)) await r.handle(m); // window 1 on the GPU
      expect(fakes[0].pending).toHaveLength(1);
      fakes[0].pending.shift()!.reject(err);
      await tick();
      await tick();
      await feedAnswering(r, fakes, sent.slice(at50 + 5));
      expect(errors(toMain)).toEqual([{ type: 'error', session: 7, message: text }]);
      expect(store.files.size).toBe(0);
      expect(fakes[0].jobs).toHaveLength(2);
      expect(fakes[0].destroyed()).toBe(1);
    }
  });

  it('a GPU window that cannot be written gives the factors up: no files, one error, no more windows', async () => {
    const { r, store, toMain, fakes } = gpuRunner();
    const open = store.open;
    store.open = async (name) => {
      if (name === 'f1.bin') throw new Error('disk full');
      return open(name);
    };
    await feedAnswering(r, fakes, gpuFeed(160));
    expect(errors(toMain)).toEqual([
      { type: 'error', session: 7, message: GPU_TEXT.error('disk full') },
    ]);
    expect(store.files.size).toBe(0);
    expect(fakes[0].jobs).toHaveLength(2);
    expect(fakes[0].destroyed()).toBe(1);
  });

  it('no GPU: the run says why and has no factors', async () => {
    const why = 'This browser has no WebGPU.';
    const { r, store, toMain } = gpuRunner(async () => ({ reason: why }));
    for (const m of gpuFeed(120)) await r.handle(m);
    const errs = errors(toMain);
    expect(errs).toEqual([{ type: 'error', session: 7, message: GPU_TEXT.none(why) }]);
    expect(errs[0].message).toContain(why);
    expect(store.files.size).toBe(0);
  });

  describe('Discover waits while the GPU ring is full', () => {
    afterEach(() => void vi.useRealTimers());

    /**
     * The feed and the runner connected both ways (each direction a macrotask,
     * as a MessagePort), and a trace stage that waits for room before each
     * batch of 10 frames, as the trace worker does. The fake GPU (window 50,
     * slack 13: a ring of 63) answers only when the test says.
     */
    function connected(frames: number, o: { stallMs?: number } = {}) {
      let clock = 0;
      let feed: CompressFeed | null = null;
      const toFeed: CompressToFast[] = [];
      const run = gpuRunner(undefined, {
        postMessage: (m) => {
          toFeed.push(m);
          setTimeout(() => feed?.answer(m), 0);
        },
      });
      let queue = Promise.resolve();
      const sent: FastToCompress[] = [];
      feed = new CompressFeed(
        {
          width: GW,
          height: GH,
          session: 7,
          tile: GTILE,
          tiling: 'offset',
          window: 30,
          quant: QUANT,
          gpu: true,
          ...o,
        },
        {
          postMessage: (m) => {
            sent.push(m);
            setTimeout(() => (queue = queue.then(() => run.r.handle(m))), 0);
          },
        },
        () => clock,
      );
      const f = feed;
      /** The batch the trace stage waits before (null: none), and whether it ended. */
      const stage = { waitingAt: null as number | null, waits: 0, ended: false };
      const done = (async () => {
        for (let s = 0; s < frames; s += 10) {
          await tick(); // one job at a time, as the trace worker's queue
          const n = Math.min(10, frames - s);
          const room = f.room(s, n);
          if (room) {
            stage.waitingAt = s;
            stage.waits++;
            await room;
            stage.waitingAt = null;
          }
          f.push(new Float32Array(n * GW * GH).fill(s % 7), s, n);
        }
        f.end();
        stage.ended = true;
      })();
      const settle = async (n = 50) => {
        for (let i = 0; i < n; i++) await tick();
        await queue;
      };
      return {
        ...run,
        feed: f,
        sent,
        toFeed,
        stage,
        done,
        settle,
        advance: (ms: number) => (clock += ms),
      };
    }

    it('a GPU slower than the feed: the feed waits, resumes when a window is done, and loses no frame', async () => {
      const c = connected(200);
      await c.settle();
      // Window 0 (frames 0-49) is on the GPU; 50-59 fit the slack, 60-69 would overwrite frame 0.
      expect(c.fakes[0].pending).toHaveLength(1);
      expect(c.stage.waitingAt).toBe(60);
      expect(c.toFeed[0]).toEqual({ type: 'room', session: 7, ring: 63, window: 50, keepFrom: 0 });
      const chunks = () => c.sent.filter((m) => m.type === 'chunk').length;
      const before = chunks();
      await c.settle();
      expect(chunks()).toBe(before); // still waiting: nothing sent
      // The GPU finishes window 0 after 2.5 s: room for frames up to 50 + 63.
      c.advance(2500);
      c.fakes[0].answer(GTILES);
      await c.settle();
      // The rest at the GPU's pace: a window is done only 1 s after the trace stage waits for it.
      for (let guard = 0; !c.stage.ended; guard++) {
        expect(guard).toBeLessThan(100);
        if (c.stage.waitingAt !== null) {
          expect(c.fakes[0].pending).toHaveLength(1);
          c.advance(1000);
          c.fakes[0].answer(GTILES);
        }
        await c.settle();
      }
      // Waits before frames 60, 110 and 160 (each a window behind the slack).
      expect(c.stage.waits).toBe(3);
      await c.done;
      await c.settle();
      while (c.fakes[0].pending.length > 0) {
        c.fakes[0].answer(GTILES);
        await c.settle();
      }
      expect(errors(c.toMain)).toEqual([]);
      // Every frame uploaded once, in order, and in exactly one window.
      expect(c.fakes[0].uploads.reduce((s, [, n]) => s + n, 0)).toBe(200);
      let next = 0;
      for (const [start, n] of c.fakes[0].uploads) {
        expect(start).toBe(next);
        next += n;
      }
      const last = statuses(c.toMain).at(-1)!.status;
      expect(last.compressed).toEqual([
        { index: 0, start: 0, frames: 50 },
        { index: 1, start: 50, frames: 50 },
        { index: 2, start: 100, frames: 50 },
        { index: 3, start: 150, frames: 50 },
      ]);
      expect(last).toMatchObject({ final: true, windows: 4, frames: 200 });
      // The waits: one 'waited' per wait, summed in the status.
      const waited = c.sent.flatMap((m) => (m.type === 'waited' ? [m] : []));
      expect(waited).toHaveLength(c.stage.waits);
      expect(waited.every((m) => !m.stalled)).toBe(true);
      expect(last.waits).toBe(c.stage.waits);
      expect(last.waitS).toBeCloseTo(waited.reduce((s, m) => s + m.ms, 0) / 1000, 9);
      expect(last.waitS).toBeCloseTo(4.5, 9);
      // The windows done, the GPU route ends: the feed is told never to wait again.
      expect(c.toFeed.at(-1)).toMatchObject({ ring: 0 });
    });

    it('a GPU that gives up releases the wait; the feed runs on without waiting', async () => {
      const c = connected(200);
      await c.settle();
      expect(c.stage.waitingAt).toBe(60);
      c.fakes[0].pending.shift()!.reject(new Error('device busy'));
      await c.settle(100);
      await c.done;
      expect(c.stage).toMatchObject({ ended: true, waits: 1 });
      expect(errors(c.toMain)).toEqual([
        { type: 'error', session: 7, message: GPU_TEXT.error('device busy') },
      ]);
      expect(c.store.files.size).toBe(0);
    });

    it('a lost device releases the wait', async () => {
      const c = connected(200);
      await c.settle();
      expect(c.stage.waitingAt).toBe(60);
      c.fakes[0].lose('gone');
      await c.settle(100);
      await c.done;
      expect(c.stage).toMatchObject({ ended: true, waits: 1 });
      expect(errors(c.toMain)).toEqual([
        { type: 'error', session: 7, message: GPU_TEXT.lost('gone') },
      ]);
    });

    it('a reset (Stop, a new run) or a release releases the wait', async () => {
      for (const end of ['reset', 'release'] as const) {
        const c = connected(200);
        await c.settle();
        expect(c.stage.waitingAt).toBe(60);
        if (end === 'reset') c.feed.reset();
        else c.feed.release();
        await c.settle();
        await c.done;
        expect(c.stage.ended).toBe(true);
        // The run is dropped: no wait reported, no chunk after the reset.
        const kinds = c.sent.map((m) => m.type);
        expect(kinds.at(-1)).toBe('reset');
        expect(kinds).not.toContain('waited');
        expect(c.store.files.size).toBe(0);
      }
    });

    it('a GPU without progress for the stall time ends the wait and the factors', async () => {
      vi.useFakeTimers();
      const sent: FastToCompress[] = [];
      let clock = 0;
      const feed = new CompressFeed(
        { width: GW, height: GH, session: 7, tile: GTILE, window: 30, quant: QUANT, gpu: true },
        { postMessage: (m) => sent.push(m) },
        () => clock,
      );
      feed.answer({ type: 'room', session: 7, ring: 63, window: 50, keepFrom: 0 });
      for (let s = 0; s < 60; s += 10) {
        expect(feed.room(s, 10)).toBeNull();
        feed.push(new Float32Array(10 * GW * GH), s, 10);
      }
      let released = false;
      void feed.room(60, 10)!.then(() => (released = true));
      // Progress (window 0's first frames freed, still no room) restarts the stall clock.
      clock = 20_000;
      vi.advanceTimersByTime(20_000);
      feed.answer({ type: 'room', session: 7, ring: 63, window: 50, keepFrom: 5 });
      // An answer of another run is not progress.
      feed.answer({ type: 'room', session: 8, ring: 63, window: 50, keepFrom: 50 });
      clock = 49_999;
      vi.advanceTimersByTime(GPU_STALL_S * 1000 - 1);
      await Promise.resolve();
      expect(released).toBe(false);
      clock = 50_000;
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(released).toBe(true);
      expect(sent.at(-1)).toEqual({ type: 'waited', session: 7, ms: 50_000, stalled: true });
      // No more waits: the compress worker judges alone (it gives the factors up).
      expect(feed.room(60, 10)).toBeNull();
    });

    it("the runner gives the factors up on a stalled wait and keeps the wait's seconds", async () => {
      const toFeed: CompressToFast[] = [];
      const { r, store, toMain, fakes } = gpuRunner(undefined, {
        postMessage: (m) => toFeed.push(m),
      });
      for (const m of gpuFeed(60, 7, false)) await r.handle(m);
      expect(fakes[0].pending).toHaveLength(1);
      await r.handle({ type: 'waited', session: 7, ms: 1500 });
      expect(statuses(toMain).at(-1)!.status).toMatchObject({ waitS: 1.5, waits: 1 });
      await r.handle({ type: 'waited', session: 7, ms: 30_000, stalled: true });
      expect(errors(toMain)).toEqual([{ type: 'error', session: 7, message: GPU_TEXT.stalled }]);
      expect(GPU_TEXT.stalled).toContain(`${GPU_STALL_S} s`);
      expect(statuses(toMain).at(-1)!.status).toMatchObject({ waitS: 31.5, waits: 2 });
      expect(store.files.size).toBe(0);
      expect(fakes[0].destroyed()).toBe(1);
      expect(toFeed.at(-1)).toMatchObject({ type: 'room', session: 7, ring: 0 });
      // A new run starts at zero.
      await r.handle(gpuFeed(1, 8, false)[0]);
      await r.handle({ type: 'close', session: 8, final: true });
      expect(statuses(toMain).at(-1)!.status).toMatchObject({ waitS: 0, waits: 0 });
    });

    it('a stream, a CPU factor run and a run without factor flags never wait', async () => {
      // A feed without `gpu` never waits, whatever it is told.
      const { feed, sent } = collectingFeed(10);
      feed.answer({ type: 'room', session: 7, ring: 12, window: 10, keepFrom: 0 });
      for (let s = 0; s < 100; s += 5) {
        expect(feed.room(s, 5)).toBeNull();
        feed.push(batch(s, 5), s, 5);
      }
      feed.end();
      expect(sent.some((m) => m.type === 'waited')).toBe(false);
      // A CPU run's runner tells the feed nothing and reports no waits.
      const toFeed: CompressToFast[] = [];
      const cpu = runner();
      const r = new CompressRunner({
        store: memoryStore(),
        quantize: quantizeTiles,
        layout: tileLayout,
        header: factorHeader,
        create: (quant) => new TileCompressor(quant),
        toMain: { postMessage: () => {} },
        toFast: { postMessage: (m) => toFeed.push(m) },
        yieldNow: () => Promise.resolve(),
      });
      for (const m of sent) await r.handle(m);
      await r.idle();
      expect(toFeed).toEqual([]);
      for (const m of sent) await cpu.r.handle(m);
      await cpu.r.idle();
      const last = cpu.toMain.flatMap((m) => (m.type === 'status' ? [m.status] : [])).at(-1)!;
      expect(last.final).toBe(true);
      expect(last).not.toHaveProperty('waitS');
      expect(last).not.toHaveProperty('waits');
    });
  });

  describe('the GPU check (?debug&gpucheck)', () => {
    /** A movie with noise (fixed LCG): its factors depend on the sketch's seed. */
    function noisy(n: number, start: number): Float32Array {
      const out = new Float32Array(n * GW * GH);
      let s = (start * 2654435761) >>> 0;
      for (let t = 0; t < n; t++)
        for (let i = 0; i < GW * GH; i++) {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          const a = (start + t) / 7;
          out[t * GW * GH + i] = 5 + 3 * Math.sin(a) * Math.cos(i / 50) + s / 2 ** 32;
        }
      return out;
    }

    /** A GPU compressor that compresses its ring with the CPU's `TileCompressor`. */
    function cpuBackedGpu(window: number, slack: number) {
      const frames = new Map<number, Int16Array>();
      const hw = GW * GH;
      const rects = tileLayout(GW, GH, GTILE, 'offset');
      const jobs: GpuWindowJob[] = [];
      const gpu: GpuCompressorLike = {
        window,
        slack,
        upload: (q, start, count) => {
          for (let t = 0; t < count; t++) frames.set(start + t, q.slice(t * hw, (t + 1) * hw));
        },
        compress: async (job) => {
          jobs.push(job);
          const data = new Int16Array(job.frames * hw);
          for (let t = 0; t < job.frames; t++) data.set(frames.get(job.start + t)!, t * hw);
          const c = new TileCompressor(QUANT);
          const tiles: Uint8Array[] = [];
          const ranks: number[] = [];
          for (let i = 0; i < rects.length / 4; i++) {
            const [x0, y0, w, h] = rects.subarray(4 * i, 4 * i + 4);
            const raw = new Int16Array(job.frames * w * h);
            cutTile(data, GW, GH, job.frames, x0, y0, w, h, raw);
            const f = c.compress(raw, job.frames, x0, y0, w, h, job.seeds(i), job.prevRanks(i));
            tiles.push(f.toBytes());
            ranks.push(f.rank);
            f.free();
          }
          c.free();
          return { tiles, ranks, ms: 1 };
        },
        lost: new Promise(() => {}),
        destroy: () => {},
      };
      return { gpu, jobs };
    }

    async function checkRun(gpuCheck?: number) {
      const store = memoryStore();
      const toMain: CompressToMain[] = [];
      const fake = cpuBackedGpu(50, 13);
      const r = new CompressRunner({
        store,
        quantize: quantizeTiles,
        layout: tileLayout,
        header: factorHeader,
        create: (quant) => new TileCompressor(quant),
        toMain: { postMessage: (m) => toMain.push(m) },
        yieldNow: () => Promise.resolve(),
        openGpu: async () => fake.gpu,
      });
      const sent: FastToCompress[] = [];
      const feed = new CompressFeed(
        {
          width: GW,
          height: GH,
          session: 7,
          tile: GTILE,
          tiling: 'offset',
          window: 30,
          quant: QUANT,
          gpu: true,
          ...(gpuCheck !== undefined ? { gpuCheck } : {}),
        },
        { postMessage: (m) => sent.push(m) },
      );
      for (let s = 0; s < 160; s += 10) feed.push(noisy(10, s), s, 10);
      return { r, store, toMain, fake, sent, feed };
    }

    it("the CPU's factors of the first windows against the GPU's: the same seeds give the same tiles", async () => {
      const { r, toMain, fake, sent, feed } = await checkRun(5);
      expect(sent[0]).toMatchObject({ type: 'init', gpu: true, gpuCheck: 5 });
      for (const m of sent) {
        await r.handle(m);
        await tick();
      }
      await r.idle();
      // Not before the recording ends: the check waits for the last window.
      expect(statuses(toMain).some((m) => m.status.check)).toBe(false);
      feed.end();
      for (const m of sent.slice(sent.length - 1)) await r.handle(m);
      await tick();
      await r.idle();
      const last = statuses(toMain).at(-1)!.status;
      expect(last.compressed.map((w) => w.frames)).toEqual([50, 50, 50, 10]);
      expect(fake.jobs).toHaveLength(4);
      const c = last.check!;
      // At most GPU_CHECK_MAX (2) windows are kept.
      expect(c).toMatchObject({
        windows: 2,
        tiles: 2 * GTILES,
        rankDiff: 0,
        rankDiffTiles: 0,
        keptDiff: 0,
        loss: 0,
      });
      expect(c.floorKeptDiff).toBeGreaterThan(0);
      expect(c.error).toBeUndefined();
      expect(c.floor).toBeGreaterThan(0);
      expect(c.ref).toBeGreaterThan(c.signal);
      expect(c.signal).toBeGreaterThan(0);
      expect(errors(toMain)).toEqual([]);
      expect(GPU_CHECK_SEED).toBe(7_000_000);
    });

    it('gpucheck=1 checks one window; without gpucheck there is no check', async () => {
      const { r, toMain, sent, feed } = await checkRun(1);
      feed.end();
      for (const m of sent) {
        await r.handle(m);
        await tick();
      }
      await r.idle();
      const st = statuses(toMain);
      expect(st.at(-1)!.status.check).toMatchObject({ windows: 1, loss: 0, rankDiff: 0 });

      const plain = await checkRun();
      expect(plain.sent[0]).not.toHaveProperty('gpuCheck');
      plain.feed.end();
      for (const m of plain.sent) {
        await plain.r.handle(m);
        await tick();
      }
      await plain.r.idle();
      expect(statuses(plain.toMain).at(-1)!.status).toMatchObject({ final: true, windows: 4 });
      expect(statuses(plain.toMain).some((m) => m.status.check)).toBe(false);
    });
  });
});
