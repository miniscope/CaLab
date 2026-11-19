// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
  factorHeader,
  quantizeTiles,
  SlowLoop,
  tileLayout,
  TileCompressor,
} from '../lib/cala-wasm.ts';
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
});
