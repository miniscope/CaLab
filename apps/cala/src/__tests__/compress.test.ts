// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
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
import { CompressFeed } from '../lib/compress-feed.ts';
import { CompressRunner, factorName, tilesOf } from '../lib/compress-runner.ts';
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
