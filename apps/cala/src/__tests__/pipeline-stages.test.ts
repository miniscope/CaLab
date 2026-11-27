// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { FastLoop, type TraceBackend } from '../lib/fast-loop.ts';
import type { FramePixels } from '../lib/frame-source.ts';
import {
  transferablesOf,
  type FastLoopSetup,
  type FrameReader,
  type PipelineStepResult,
} from '../lib/pipeline-types.ts';
import { framePreviewImage } from '../lib/preview.ts';
import { StageChain } from '../lib/stage-chain.ts';
import { StagePool } from '../lib/stage-pool.ts';
import type { FastToSlow } from '../workers/slow-types.ts';
import { initTestWasm } from './wasm-test.ts';

beforeAll(initTestWasm);

const W = 64;
const H = 48;

/**
 * A seeded blob movie with a moving field of view and a global flicker.
 * `boundary`: a second session starts there, ×0.8 as bright and moved.
 */
function sessionMovie(frames: number, boundary?: number): FrameReader {
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const blobs = Array.from({ length: 40 }, () => ({
    y: rand() * H,
    x: rand() * W,
    a: 40 + rand() * 60,
  }));
  return {
    info: {
      width: W,
      height: H,
      bitDepth: 8,
      frameCount: frames,
      fps: 20,
      ...(boundary !== undefined
        ? {
            sessions: [0, boundary].map((startFrame, index) => ({
              index,
              name: `s${index}`,
              dir: `s${index}`,
              startFrame,
              frameCount: index === 0 ? boundary : frames - boundary,
              fps: 20,
              files: 1,
            })),
          }
        : {}),
    },
    async readFrames(start: number, count: number, out?: FramePixels) {
      const dst = (out as Uint8Array | undefined) ?? new Uint8Array(count * W * H);
      for (let i = 0; i < count; i++) {
        const f = start + i;
        const b = boundary !== undefined && f >= boundary;
        const sy = (f < 30 ? 0 : 2) + (b ? 3 : 0);
        const sx = (f < 30 ? 0 : -3) + (b ? -2 : 0);
        const gain = (1 + 0.04 * Math.sin((2 * Math.PI * f) / 5)) * (b ? 0.8 : 1);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const lit = (y - H / 2) ** 2 + (x - W / 2) ** 2 < (0.48 * W) ** 2;
            let v = 110;
            for (const b of blobs) {
              const d2 = (y - sy - b.y) ** 2 + (x - sx - b.x) ** 2;
              if (d2 < 40) v += b.a * Math.exp(-d2 / (6 + (f % 7) * 0.1));
            }
            const lv = gain * (v + ((f * 31 + y * 7 + x * 13) % 5));
            dst[i * W * H + y * W + x] = lit ? Math.min(255, Math.round(lv)) : 3;
          }
        }
      }
      return dst;
    },
  };
}

/** A fast loop whose port records what it is sent and acks every batch at once. */
function recordingFastLoop(setup: FastLoopSetup, sent: FastToSlow[]): FastLoop {
  const backend: TraceBackend = {
    libraryFromBytes: () => {
      throw new Error('no library in this test');
    },
    newEngine: () => {
      throw new Error('no library in this test');
    },
  };
  // eslint-disable-next-line prefer-const
  let fast: FastLoop;
  const port = {
    postMessage(msg: FastToSlow) {
      // Copy: forwarded buffers are pooled and reused after the ack.
      sent.push(
        msg.type === 'frames'
          ? { ...msg, frames: msg.frames.slice(), traces: msg.traces.slice() }
          : msg,
      );
      if (msg.type === 'frames') {
        fast.handleSlow({
          type: 'ack',
          session: 1,
          frames: msg.frames,
          start: msg.start,
          count: msg.count,
          observed: msg.count,
        });
      }
    },
  };
  fast = new FastLoop(
    { ...setup, session: 1, discover: true, qc: false, startFrame: 20, noiseEvery: 16 },
    port,
    backend,
  );
  return fast;
}

/**
 * Seeded blob texture at 96 x 80, sampled at `(y - sy, x - sx)`: content moved by
 * `shifts[f]`. `gain(f)` scales every lit pixel of frame `f` (a global LED flicker).
 */
function shiftedMovie(
  shifts: [number, number][],
  gain: (f: number) => number = () => 1,
): FrameReader & { reads: [number, number][] } {
  const w = 96;
  const h = 80;
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const blobs = Array.from({ length: 70 }, () => ({
    y: rand() * h,
    x: rand() * w,
    a: 40 + rand() * 60,
  }));
  const frame = (f: number, out: Uint8Array) => {
    const [sy, sx] = shifts[f];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // The lens disk is fixed to the sensor; only the tissue moves.
        const lit = (y - h / 2) ** 2 + (x - w / 2) ** 2 < (0.48 * w) ** 2;
        let v = 110;
        for (const b of blobs) {
          const d2 = (y - sy - b.y) ** 2 + (x - sx - b.x) ** 2;
          if (d2 < 40) v += b.a * Math.exp(-d2 / 6);
        }
        const lv = gain(f) * (v + ((f * 31 + y * 7 + x * 13) % 5));
        out[y * w + x] = lit ? Math.min(255, Math.round(lv)) : 3;
      }
    }
  };
  const reads: [number, number][] = [];
  return {
    reads,
    info: { width: w, height: h, bitDepth: 8, frameCount: shifts.length, fps: 20 },
    async readFrames(start: number, count: number, out?: FramePixels) {
      reads.push([start, count]);
      const dst = (out as Uint8Array | undefined) ?? new Uint8Array(count * w * h);
      expect(dst.length).toBe(count * w * h);
      for (let i = 0; i < count; i++) frame(start + i, dst.subarray(i * w * h, (i + 1) * w * h));
      return dst;
    },
  };
}

/** Every step of `chain` up to and including `done`; `after` sees the chain after each step. */
async function runAll(
  chain: StageChain,
  after?: (chain: StageChain) => void,
): Promise<PipelineStepResult[]> {
  const out: PipelineStepResult[] = [];
  for (;;) {
    const r = await chain.step();
    after?.(chain);
    out.push(r);
    if (r.kind === 'done') return out;
  }
}

const OPTIONS = { calibrationFrames: 20, motionWarmupFrames: 20, batchSize: 8, previewMaxSide: 32 };
const FRAMES = 70;
/** `shiftedMovie` runs: previews of at most 48 px. */
const SHIFTED_OPTIONS = { ...OPTIONS, previewMaxSide: 48 };

describe('pipeline stages', () => {
  it.each([
    ['one session', undefined],
    ['two sessions (session fix)', 37],
  ])('cover the recording and feed the slow loop: %s', async (_, boundary) => {
    const sent: FastToSlow[] = [];
    const chain = new StageChain(sessionMovie(FRAMES, boundary), OPTIONS, {
      fastLoop: (setup) => recordingFastLoop(setup, sent),
    });
    // The pools are bounded and every buffer comes back after each step.
    const results = await runAll(chain, (c) => expect(c.inFlight).toEqual([0, 0]));
    chain.dispose();

    const batches = results.filter((r) => r.kind === 'batch');
    expect(batches.reduce((n, b) => n + b.count, 0)).toBe(FRAMES);
    for (const b of batches) expect(b.stageBusyMs).toHaveLength(3);
    if (boundary === undefined) expect(batches.length).toBe(Math.ceil(FRAMES / 8));
    else {
      // The batch before the boundary is cut short; the session starts a batch and reports.
      expect(batches.map((r) => r.start)).toContain(boundary);
      const first = batches.find((r) => r.start === boundary)!;
      expect(first.session?.index).toBe(1);
      expect(first.session?.frame).toBe(boundary);
      // The floor and noise follow the ×0.8 step. Loose: on a 64 x 48 movie
      // flattened at σ = 20 px little tissue texture is left to fit (the
      // stitched sims read ×1.25 as ×1.248).
      expect(first.session?.floorGain).toBeGreaterThan(0.3);
      expect(first.session?.floorGain).toBeLessThan(0.95);
      expect(first.session?.noiseRatio).toBeGreaterThan(0.7);
      expect(first.session?.noiseRatio).toBeLessThan(0.9);
      expect(batches.filter((r) => r.session).length).toBe(1);
    }
    // The slow loop gets frames, with noise maps.
    expect(sent.some((m) => m.type === 'frames')).toBe(true);
    expect(sent.some((m) => m.type === 'frames' && m.noise)).toBe(true);
  });

  it('keeps the queues bounded: a stalled consumer blocks the producer', async () => {
    const pool = new StagePool(2, 4);
    const first = await pool.acquire();
    await pool.acquire();
    expect(pool.inFlight).toBe(2);
    let third = false;
    const pending = pool.acquire().then((b) => {
      third = true;
      return b;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    pool.release(first);
    expect(await pending).toBe(first);
    expect(pool.inFlight).toBe(2);
  });

  it('calibrates, warms up, then reports registering shifts and previews per batch', async () => {
    // Still for 40 frames (the warm-ups), then content moved by (+2, -3) px.
    const shifts: [number, number][] = Array.from({ length: 60 }, (_, f) =>
      f < 40 ? [0, 0] : [2, -3],
    );
    const movie = shiftedMovie(shifts);
    const chain = new StageChain(movie, SHIFTED_OPTIONS);
    const results = await runAll(chain);
    chain.dispose();

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

  it.each(['raw', 'preprocessed', 'corrected', 'output'] as const)(
    'previews every frame of the %s view when asked, the last one equal to the batch preview',
    async (view) => {
      const chain = new StageChain(
        shiftedMovie(Array.from({ length: 60 }, () => [0, 0] as [number, number])),
        SHIFTED_OPTIONS,
      );
      chain.framePreview = view;
      const batches = (await runAll(chain)).filter((r) => r.kind === 'batch');
      chain.dispose();
      for (const b of batches) {
        const fp = b.previews.frames!;
        expect(fp.view).toBe(view);
        expect(fp.first).toBe(b.start);
        expect(fp.count).toBe(b.count);
        expect(fp.data).toHaveLength(b.count * fp.width * fp.height);
        // The last frame of the batch is the batch's own preview of that view.
        expect(Array.from(framePreviewImage(fp, fp.count - 1).data)).toEqual(
          Array.from(b.previews[view].data),
        );
        expect(transferablesOf(b)).toHaveLength(11);
      }
    },
  );

  it('reports the global flicker it removes', async () => {
    // A 4 % LED gain flicker at 4 Hz (5 frames per period at 20 fps).
    const m = (f: number) => 0.04 * Math.sin((2 * Math.PI * f) / 5);
    const shifts: [number, number][] = Array.from({ length: 80 }, () => [0, 0]);
    const run = async (flickerMode?: number) => {
      const chain = new StageChain(
        shiftedMovie(shifts, (f) => 1 + m(f)),
        SHIFTED_OPTIONS,
        {
          ...(flickerMode !== undefined ? { flickerMode } : {}),
        },
      );
      const batches = (await runAll(chain)).filter((r) => r.kind === 'batch');
      chain.dispose();
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
    // Three runs: slow under coverage instrumentation in CI.
  }, 30_000);

  it('refuses to step after dispose', async () => {
    const chain = new StageChain(shiftedMovie([[0, 0]]), {});
    chain.dispose();
    await expect(chain.step()).rejects.toThrow('disposed');
  });
});
