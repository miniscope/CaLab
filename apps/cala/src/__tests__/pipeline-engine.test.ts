// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCalaWasm } from '../lib/cala-wasm.ts';
import type { FramePixels } from '../lib/frame-source.ts';
import {
  PipelineEngine,
  transferablesOf,
  type FrameReader,
  type PipelineStepResult,
} from '../lib/pipeline-engine.ts';

beforeAll(async () => {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
});

const W = 96;
const H = 80;

/**
 * Seeded blob texture, sampled at `(y - sy, x - sx)`: content moved by `(sy, sx)`.
 * `gain(f)` scales every lit pixel of frame `f` (a global LED flicker).
 */
function makeMovie(
  shifts: [number, number][],
  gain: (f: number) => number = () => 1,
): FrameReader & { reads: [number, number][] } {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const blobs = Array.from({ length: 70 }, () => ({
    y: rand() * H,
    x: rand() * W,
    a: 40 + rand() * 60,
  }));
  const frame = (f: number, out: Uint8Array) => {
    const [sy, sx] = shifts[f];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // The lens disk is fixed to the sensor; only the tissue moves.
        const lit = (y - H / 2) ** 2 + (x - W / 2) ** 2 < (0.48 * W) ** 2;
        let v = 110;
        for (const b of blobs) {
          const d2 = (y - sy - b.y) ** 2 + (x - sx - b.x) ** 2;
          if (d2 < 40) v += b.a * Math.exp(-d2 / 6);
        }
        const lv = gain(f) * (v + ((f * 31 + y * 7 + x * 13) % 5));
        out[y * W + x] = lit ? Math.min(255, Math.round(lv)) : 3;
      }
    }
  };
  const reads: [number, number][] = [];
  return {
    reads,
    info: { width: W, height: H, bitDepth: 8, frameCount: shifts.length, fps: 20 },
    async readFrames(start: number, count: number, out?: FramePixels) {
      reads.push([start, count]);
      const dst = (out as Uint8Array | undefined) ?? new Uint8Array(count * W * H);
      expect(dst.length).toBe(count * W * H);
      for (let i = 0; i < count; i++) frame(start + i, dst.subarray(i * W * H, (i + 1) * W * H));
      return dst;
    },
  };
}

async function runAll(engine: PipelineEngine): Promise<PipelineStepResult[]> {
  const out: PipelineStepResult[] = [];
  for (;;) {
    const r = await engine.step();
    out.push(r);
    if (r.kind === 'done') return out;
  }
}

describe('PipelineEngine (wasm)', () => {
  it('calibrates, warms up, then reports registering shifts and previews per batch', async () => {
    // Still for 40 frames (the warm-ups), then content moved by (+2, -3) px.
    const shifts: [number, number][] = Array.from({ length: 60 }, (_, f) =>
      f < 40 ? [0, 0] : [2, -3],
    );
    const movie = makeMovie(shifts);
    const engine = new PipelineEngine(movie, {
      calibrationFrames: 20,
      motionWarmupFrames: 20,
      batchSize: 8,
      previewMaxSide: 48,
    });
    const results = await runAll(engine);
    engine.dispose();

    const setup = results.filter((r) => r.kind === 'setup');
    // The calibration is one read; the motion warm-up streams in batches of 8
    // (20 frames: 8 + 8 + 4) into the corrector.
    expect(setup.map((r) => r.kind === 'setup' && r.phase)).toEqual([
      'calibrate',
      'motion-warmup',
      'motion-warmup',
      'motion-warmup',
    ]);
    // Reads stay batch-sized: the whole movie is never requested at once.
    expect(Math.max(...movie.reads.map(([, n]) => n))).toBeLessThanOrEqual(20);

    const batches = results.filter((r) => r.kind === 'batch');
    expect(batches.reduce((n, b) => n + b.count, 0)).toBe(60);
    const dy = batches.flatMap((b) => Array.from(b.dy));
    const dx = batches.flatMap((b) => Array.from(b.dx));
    // The registering shift undoes the content motion.
    for (let f = 0; f < 40; f++) {
      expect(Math.abs(dy[f])).toBeLessThan(0.3);
      expect(Math.abs(dx[f])).toBeLessThan(0.3);
    }
    for (let f = 45; f < 60; f++) {
      expect(dy[f]).toBeCloseTo(-2, 0);
      expect(dx[f]).toBeCloseTo(3, 0);
    }

    const last = batches[batches.length - 1];
    expect(last.previews.frame).toBe(59);
    expect(last.previews.raw.width).toBe(48);
    expect(last.previews.raw.height).toBe(40);
    for (const img of Object.values(last.previews).filter((v) => typeof v === 'object')) {
      expect(img.data.every(Number.isFinite)).toBe(true);
    }
    expect(last.timings.motionMs).toBeGreaterThanOrEqual(0);
    expect(last.flickerGain).toHaveLength(last.count);
    expect(last.flickerOffset).toHaveLength(last.count);
    expect(transferablesOf(last)).toHaveLength(10);
    expect(results[results.length - 1]).toEqual({ kind: 'done' });
  });

  it('reports the global flicker it removes', async () => {
    // A 4 % LED gain flicker at 4 Hz (5 frames per period at 20 fps).
    const m = (f: number) => 0.04 * Math.sin((2 * Math.PI * f) / 5);
    const shifts: [number, number][] = Array.from({ length: 80 }, () => [0, 0]);
    const opts = {
      calibrationFrames: 20,
      motionWarmupFrames: 20,
      batchSize: 8,
      previewMaxSide: 48,
    };
    const run = async (mode?: number) => {
      const engine = new PipelineEngine(
        makeMovie(shifts, (f) => 1 + m(f)),
        opts,
        mode,
      );
      const batches = (await runAll(engine)).filter((r) => r.kind === 'batch');
      engine.dispose();
      return {
        gain: batches.flatMap((b) => Array.from(b.flickerGain)),
        offset: batches.flatMap((b) => Array.from(b.flickerOffset)),
      };
    };
    // Gain only (2): the estimate follows the injected gain. It is relative to
    // the running mean of the frames, which the zero-mean flicker barely moves.
    const mult = await run(2);
    expect(mult.gain).toHaveLength(80);
    for (let f = 20; f < 80; f++) expect(mult.gain[f]).toBeCloseTo(m(f), 2);
    expect(mult.offset.every((a) => a === 0)).toBe(true);
    // Both (the default): on this nearly flat scene the offset and the gain
    // trade off against each other, but their sum at the mean brightness
    // (~120 grey levels) is the injected change.
    const both = await run();
    for (let f = 20; f < 80; f++) {
      expect(both.offset[f] + 120 * both.gain[f]).toBeCloseTo(120 * m(f), -0.5);
    }
    // Off (0): nothing is reported.
    const off = await run(0);
    expect(off.gain.every((g) => g === 0) && off.offset.every((a) => a === 0)).toBe(true);
  });

  it('refuses to step after dispose', async () => {
    const engine = new PipelineEngine(makeMovie([[0, 0]]), {});
    engine.dispose();
    await expect(engine.step()).rejects.toThrow('stopped');
  });
});
