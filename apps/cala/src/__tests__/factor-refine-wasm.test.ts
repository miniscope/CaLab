// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
  factorHeader,
  quantizeTiles,
  SlowLoop,
  tileLayout,
  TileCompressor,
} from '../lib/cala-wasm.ts';
import type { FactorReader } from '../lib/cala-wasm.ts';
import { CompressFeed } from '../lib/compress-feed.ts';
import { CompressRunner, factorName } from '../lib/compress-runner.ts';
import { memoryStore } from '../lib/window-store.ts';
import type { FastToCompress } from '../workers/compress-types.ts';
import { initTestWasm } from './wasm-test.ts';

beforeAll(initTestWasm);

const W = 64;
const H = 48;
const WINDOW = 50;

/** Frame `t` of a `width x height` movie, rank 3 in time with slow time courses. */
function frameOf(width: number, height: number, t: number): Float32Array {
  const out = new Float32Array(width * height);
  const a = t / 9;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const b = (x + 2 * y) / 11;
      out[y * width + x] =
        20 +
        9 * Math.sin(a) * Math.cos(b) +
        5 * Math.cos(0.7 * a) * Math.sin(2 * b) +
        3 * Math.sin(1.9 * a) * Math.cos(3 * b);
    }
  return out;
}

/** The factor files of `frames` frames (windows of 50, offset grids), as the compress worker writes them. */
async function factorFiles(width = W, height = H, frames = 100): Promise<Uint8Array[]> {
  const sent: FastToCompress[] = [];
  const feed = new CompressFeed(
    { width, height, session: 1, tile: 16, window: WINDOW, tiling: 'offset', source: 'replay' },
    { postMessage: (m) => sent.push(m) },
  );
  const px = width * height;
  const batch = new Float32Array(10 * px);
  for (let s = 0; s < frames; s += 10) {
    for (let i = 0; i < 10; i++) batch.set(frameOf(width, height, s + i), i * px);
    feed.push(batch, s, 10);
  }
  feed.end();
  const store = memoryStore();
  const runner = new CompressRunner({
    store,
    quantize: quantizeTiles,
    layout: tileLayout,
    header: factorHeader,
    create: (quant) => new TileCompressor(quant),
    toMain: { postMessage() {} },
    yieldNow: () => Promise.resolve(),
  });
  for (const m of sent) await runner.handle(m);
  await runner.idle();
  return Array.from({ length: frames / WINDOW }, (_, i) => store.files.get(factorName(i))!);
}

/** A slow loop of a W x H recording that published an empty library (Discover found nothing). */
function discoverLoop(): SlowLoop {
  const px = W * H;
  const loop = new SlowLoop(W, H, new Uint8Array(px).fill(1), new Float32Array(px).fill(1), 6, 0);
  loop.finalize().free();
  return loop;
}

const reader = (files: Uint8Array[]) => ({ windows: files.length, read: (w: number) => files[w] });

describe('SlowLoop.refineOnFactors (the WASM binding)', () => {
  it('runs one iteration on factor files: an empty library settles with nothing accepted', async () => {
    const files = await factorFiles();
    const loop = discoverLoop();
    try {
      loop.setEditScope('refine');
      const r = loop.refineOnFactors(reader(files), 0.99, 0.02, 0);
      expect(r).toHaveLength(10);
      // cells, frames, accepted, settle
      expect([r[1], r[2], r[4], r[9]]).toEqual([0, 100, 0, 2]);
    } finally {
      loop.free();
    }
  });

  it('turns a window of another frame size into an Error naming refineOnFactors', async () => {
    const loop = discoverLoop();
    try {
      loop.setEditScope('refine');
      const other = await factorFiles(32, 24);
      expect(() => loop.refineOnFactors(reader(other), 0.99, 0.02, 0)).toThrow(
        /refineOnFactors: .*factors of/,
      );
      // The instance still works: no trap.
      expect(loop.refineOnFactors(reader(await factorFiles()), 0.99, 0.02, 0)[9]).toBe(2);
    } finally {
      loop.free();
    }
  });

  it("passes a reader's error on as an Error, and refuses a reader without windows or a corrupt file", async () => {
    const loop = discoverLoop();
    try {
      loop.setEditScope('refine');
      const failing = {
        windows: 2,
        read: (): Uint8Array => {
          throw new Error('the file is gone');
        },
      };
      expect(() => loop.refineOnFactors(failing, 0.99, 0.02, 0)).toThrow(
        /refineOnFactors: .*factor window 0: .*the file is gone/,
      );
      expect(() => loop.refineOnFactors(reader([]), 0.99, 0.02, 0)).toThrow(
        /refineOnFactors: .*no factor windows/,
      );
      const corrupt = (await factorFiles()).map((f, i) =>
        i === 1 ? f.subarray(0, f.length - 1) : f,
      );
      expect(() => loop.refineOnFactors(reader(corrupt), 0.99, 0.02, 0)).toThrow(
        /factor window 1: truncated or corrupt factor file/,
      );
    } finally {
      loop.free();
    }
  });

  it('refuses a loop outside the Refine scope (Discover)', async () => {
    const files = await factorFiles();
    const loop = discoverLoop();
    try {
      expect(() => loop.refineOnFactors(reader(files), 0.99, 0.02, 0)).toThrow(/cell set frozen/);
    } finally {
      loop.free();
    }
  });

  it('refuses a reader whose window count cannot be read, and the instance still works', async () => {
    const files = await factorFiles();
    const read = (w: number) => files[w];
    const bad: [string, unknown][] = [
      ['undefined', undefined],
      ['null', null],
      ['a number', 5],
      [
        'a throwing getter',
        {
          get windows(): number {
            throw new Error('getter');
          },
          read,
        },
      ],
      ['a BigInt', { windows: 2n, read }],
      ['a fraction', { windows: 1.5, read }],
      ['negative', { windows: -1, read }],
      ['NaN', { windows: NaN, read }],
      ['Infinity', { windows: Infinity, read }],
      ['beyond 2^32', { windows: 2 ** 32 + 1, read }],
    ];
    const loop = discoverLoop();
    try {
      loop.setEditScope('refine');
      for (const [what, r] of bad) {
        expect(() => loop.refineOnFactors(r as FactorReader, 0.99, 0.02, 0), what).toThrow(
          /^refineOnFactors: .*windows/,
        );
        expect(loop.refineOnFactors(reader(files), 0.99, 0.02, 0)[9], what).toBe(2);
      }
    } finally {
      loop.free();
    }
  });

  it('refuses a window with too many frames at once (rank-0 tiles keep the file small)', async () => {
    const loop = discoverLoop();
    try {
      loop.setEditScope('refine');
      for (const frames of [9601, 0xffffffff]) {
        const t0 = performance.now();
        expect(() => loop.refineOnFactors(reader([rank0File(frames)]), 0.99, 0.02, 0)).toThrow(
          new RegExp(`^refineOnFactors: .*factor window 0: ${frames} frames`),
        );
        expect(performance.now() - t0).toBeLessThan(1000);
      }
      expect(loop.refineOnFactors(reader(await factorFiles()), 0.99, 0.02, 0)[9]).toBe(2);
    } finally {
      loop.free();
    }
  });

  it('refuses testFrames below the loop minimum, but not 0', async () => {
    const files = await factorFiles();
    const loop = discoverLoop();
    try {
      loop.setEditScope('refine');
      expect(() => loop.refineOnFactors(reader(files), 0.99, 0.02, 1)).toThrow(
        /^refineOnFactors: .*min_test_frames/,
      );
      expect(loop.refineOnFactors(reader(files), 0.99, 0.02, 0)[9]).toBe(2);
    } finally {
      loop.free();
    }
  });

  it('pins the call sequence: finalize before and after an iteration, then observe takes its version', async () => {
    // This movie gets no refinement accepted, so the version does not move
    // here; the native test `the_js_surface_publishes_the_iteration_on_finalize`
    // covers a version that moves.
    const files = await factorFiles();
    const px = W * H;
    const loop = new SlowLoop(W, H, new Uint8Array(px).fill(1), new Float32Array(px).fill(1), 6, 0);
    try {
      expect(loop.addReviewed(blobCandidate(24, 32))).toBe(1);
      loop.setNoise(new Float32Array(px).fill(1));
      loop.setEditScope('refine');
      const start = loop.finalize();
      expect(start.cellCount).toBe(1);
      start.free();
      const r = loop.refineOnFactors(reader(files), 0.99, 0.02, 0);
      expect(r[1]).toBe(1);
      const lib = loop.finalize();
      const version = lib.version;
      lib.free();
      expect(version).toBe(r[0]);
      expect(loop.knowsVersion(r[0])).toBe(true);
      // A second finalize publishes nothing new.
      const frames = loop.frames;
      const again = loop.finalize();
      expect(again.version).toBe(version);
      again.free();
      expect(loop.frames).toBe(frames);
      // A frame solved with the iteration's library is observed.
      expect(loop.observe(frameOf(W, H, 0), r[0], new Float32Array([1]))).toBe(true);
      expect(loop.frames).toBe(frames + 1);
    } finally {
      loop.free();
    }
  });
});

/** A factor file of one plain 64 x 48 tile at rank 0 that claims `frames` frames. */
function rank0File(frames: number): Uint8Array {
  const px = W * H;
  const tileLen = 48 + 12 * px;
  const b = new Uint8Array(48 + tileLen);
  const v = new DataView(b.buffer);
  const enc = new TextEncoder();
  b.set(enc.encode('CALAFAC2'), 0);
  // width, height, tile, frames, tiles; start (f64) 0; tiling plain (0, 0)
  [W, H, 64, frames, 1].forEach((x, i) => v.setUint32(8 + 4 * i, x, true));
  v.setUint32(44, tileLen, true);
  const t = 48;
  b.set(enc.encode('CTF2'), t);
  // x0, y0, w, h, rank, frames, svd rank; energies (f64) 0
  [0, 0, W, H, 0, frames, 0].forEach((x, i) => v.setUint32(t + 4 + 4 * i, x, true));
  for (let p = 0; p < px; p++) {
    v.setFloat32(t + 48 + 4 * p, 20, true); // mean
    v.setFloat32(t + 48 + 8 * px + 4 * p, 1, true); // valid (discarded stays 0)
  }
  return b;
}

/** A review candidate (`HistoryReview` wire: y0, x0, h, w, gain, events, values): a Gaussian soma at (`cy`, `cx`). */
function blobCandidate(cy: number, cx: number): Float32Array {
  const r = 6;
  const side = 2 * r + 1;
  const out = new Float32Array(6 + side * side);
  out.set([cy - r, cx - r, side, side, 10, 10]);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const d2 = (y - r) ** 2 + (x - r) ** 2;
      out[6 + y * side + x] = d2 <= r * r ? Math.exp(-d2 / (2 * 2.5 * 2.5)) : 0;
    }
  return out;
}
