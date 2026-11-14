// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { FastLoop, type TraceBackend } from '../lib/fast-loop.ts';
import type { FramePixels } from '../lib/frame-source.ts';
import {
  PipelineEngine,
  type FastLoopSetup,
  type FrameReader,
  type PipelineStepResult,
} from '../lib/pipeline-engine.ts';
import { BackStage, FrontStage, MotionStage } from '../lib/pipeline-stages.ts';
import { StagePool } from '../lib/stage-pool.ts';
import type { FastToSlow } from '../workers/slow-types.ts';

beforeAll(async () => {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
});

const W = 64;
const H = 48;

/**
 * A seeded blob movie with a moving field of view and a global flicker.
 * `boundary`: a second session starts there, ×0.8 as bright and moved.
 */
function makeMovie(frames: number, boundary?: number): FrameReader {
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

const OPTIONS = { calibrationFrames: 20, motionWarmupFrames: 20, batchSize: 8, previewMaxSide: 32 };
const FRAMES = 70;

describe('pipeline stages', () => {
  it.each([
    ['one session', undefined],
    ['two sessions (session fix)', 37],
  ])(
    'give the same results and slow-loop feed as the single-worker engine: %s',
    async (_, boundary) => {
      // Single-worker path.
      const sentOld: FastToSlow[] = [];
      const engine = new PipelineEngine(makeMovie(FRAMES, boundary), OPTIONS, undefined, (setup) =>
        recordingFastLoop(setup, sentOld),
      );
      const old: PipelineStepResult[] = [];
      for (;;) {
        const r = await engine.step();
        old.push(r);
        if (r.kind === 'done') break;
      }
      engine.dispose();

      // Three stages chained in-process, with the same bounded pools the workers use.
      const sentNew: FastToSlow[] = [];
      const len = OPTIONS.batchSize * W * H;
      const frontPool = new StagePool(3, len);
      const outPool = new StagePool(3, len);
      const a = new FrontStage(makeMovie(FRAMES, boundary), OPTIONS, () => frontPool.acquire());
      const b = new MotionStage(a.setup, () => outPool.acquire());
      const c = new BackStage(a.setup, recordingFastLoop(a.fastSetup, sentNew));
      const staged: PipelineStepResult[] = [];
      for (;;) {
        const job = await a.next();
        if (!job) {
          c.end();
          staged.push({ kind: 'done' });
          break;
        }
        const done = await b.handle(job);
        // As the motion worker's postMessage does: the calibration's FOV mask
        // moves on to C, detached in B (B must keep its own copy).
        if (done.calib) {
          const m = done.calib.fovMask;
          done.calib = { ...done.calib, fovMask: structuredClone(m, { transfer: [m.buffer] }) };
        }
        if (done.front) frontPool.release(done.front);
        staged.push(c.handle(done));
        if (done.corrected) outPool.release(done.corrected);
        expect(frontPool.inFlight).toBe(0);
        expect(outPool.inFlight).toBe(0);
      }
      a.dispose();
      b.dispose();
      c.dispose();

      expect(staged).toHaveLength(old.length);
      const batches = old.filter((r) => r.kind === 'batch');
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
      for (let i = 0; i < old.length; i++) {
        const o = old[i];
        const s = staged[i];
        expect(s.kind).toBe(o.kind);
        if (o.kind === 'setup' && s.kind === 'setup') {
          expect([s.phase, s.done, s.total]).toEqual([o.phase, o.done, o.total]);
        } else if (o.kind === 'batch' && s.kind === 'batch') {
          expect(s.start).toBe(o.start);
          expect(s.count).toBe(o.count);
          // Bit-identical, not merely close.
          for (const key of [
            'dy',
            'dx',
            'quality',
            'flags',
            'flickerOffset',
            'flickerGain',
          ] as const) {
            expect(s[key], `${key} of batch ${i}`).toEqual(o[key]);
          }
          expect(s.previews, `previews of batch ${i}`).toEqual(o.previews);
          expect(s.session, `session of batch ${i}`).toEqual(o.session);
          // The boundary flags' null samples (none here: the sessions are under 100 frames).
          expect(s.boundaryNull).toBe(o.boundaryNull);
          expect(s.cells?.traces).toEqual(o.cells?.traces);
          expect(s.cells?.ids).toEqual(o.cells?.ids);
          expect(s.cells?.version).toBe(o.cells?.version);
          expect(s.cells?.forwardedFrames).toBe(o.cells?.forwardedFrames);
          expect(s.cells?.droppedFrames).toBe(o.cells?.droppedFrames);
          expect(s.stageBusyMs).toHaveLength(3);
        }
      }
      // The slow loop sees the same init, noise maps and frames, byte for byte.
      expect(sentOld.some((m) => m.type === 'frames')).toBe(true);
      expect(sentOld.some((m) => m.type === 'frames' && m.noise)).toBe(true);
      expect(sentNew).toEqual(sentOld);
    },
  );

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
});
