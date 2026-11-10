// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCalaWasm, TraceLibraryBuilder } from '../lib/cala-wasm.ts';
import { FastLoop } from '../lib/fast-loop.ts';
import type { FramePixels } from '../lib/frame-source.ts';
import type { FrameReader, PipelineStepResult } from '../lib/pipeline-engine.ts';
import {
  BackStage,
  FrontStage,
  MotionStage,
  type ReplayInput,
  type StageJob,
} from '../lib/pipeline-stages.ts';
import { RunRecord } from '../lib/run-record.ts';
import { StagePool } from '../lib/stage-pool.ts';
import { traceBackend } from '../lib/trace-backend.ts';

beforeAll(async () => {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
});

const W = 64;
const H = 48;
const FRAMES = 70;
const OPTIONS = { calibrationFrames: 20, motionWarmupFrames: 20, batchSize: 8, previewMaxSide: 32 };

/** A seeded blob movie with a jump in field of view at frame 30 and a global flicker. */
function makeMovie(frames: number): FrameReader {
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
    info: { width: W, height: H, bitDepth: 8, frameCount: frames, fps: 20 },
    async readFrames(start: number, count: number, out?: FramePixels) {
      const dst = (out as Uint8Array | undefined) ?? new Uint8Array(count * W * H);
      for (let i = 0; i < count; i++) {
        const f = start + i;
        const sy = f < 30 ? 0 : 2;
        const sx = f < 30 ? 0 : -3;
        const gain = 1 + 0.04 * Math.sin((2 * Math.PI * f) / 5);
        // Blobs flash on and off so the traces are not constant.
        const on = (k: number) => (Math.floor(f / 9) + k) % 3 === 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const lit = (y - H / 2) ** 2 + (x - W / 2) ** 2 < (0.48 * W) ** 2;
            let v = 110;
            blobs.forEach((b, k) => {
              const d2 = (y - sy - b.y) ** 2 + (x - sx - b.x) ** 2;
              if (d2 < 40) v += (on(k) ? 1.6 : 0.6) * b.a * Math.exp(-d2 / 6);
            });
            const lv = gain * (v + ((f * 31 + y * 7 + x * 13) % 5));
            dst[i * W * H + y * W + x] = lit ? Math.min(255, Math.round(lv)) : 3;
          }
        }
      }
      return dst;
    },
  };
}

/** A library of Gaussian footprints at the given centres (row, column). */
function makeLibrary(centres: [number, number][]): { bytes: Uint8Array; version: number } {
  const b = new TraceLibraryBuilder(W, H);
  const R = 6;
  centres.forEach(([cy, cx], i) => {
    const size = 2 * R + 1;
    const v = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) v[y * size + x] = Math.exp(-((y - R) ** 2 + (x - R) ** 2) / 9);
    b.addFootprint(i + 1, cy - R, cx - R, size, size, v);
  });
  const lib = b.buildUnfiltered();
  const out = { bytes: lib.toBytes(), version: Number(lib.version) };
  lib.free();
  return out;
}

type Batch = Extract<PipelineStepResult, { kind: 'batch' }>;

/** Run the three stages in-process (CPU motion) and return every batch result. */
async function run(
  options: {
    library: Uint8Array;
    /** Replace the library by this one when batch `at` starts (a slow-loop publish). */
    swap?: { at: number; bytes: Uint8Array; version: number };
    replay?: ReplayInput;
  },
  onBatch?: (b: Batch) => void,
): Promise<Batch[]> {
  const len = OPTIONS.batchSize * W * H;
  const frontPool = new StagePool(3, len);
  const outPool = new StagePool(3, len);
  const a = new FrontStage(
    makeMovie(FRAMES),
    OPTIONS,
    () => frontPool.acquire(),
    undefined,
    options.replay,
  );
  const b = new MotionStage(a.setup, () => outPool.acquire());
  const fast = new FastLoop(
    {
      ...a.fastSetup,
      session: 1,
      discover: false,
      qc: false,
      initialLibrary: options.library,
    },
    null,
    traceBackend,
  );
  const c = new BackStage(a.setup, fast);
  const batches: Batch[] = [];
  let n = 0;
  for (;;) {
    const job: StageJob | null = await a.next();
    if (!job) break;
    const done = await b.handle(job);
    if (done.front) frontPool.release(done.front);
    if (options.swap && job.step.phase === 'process' && n === options.swap.at)
      fast.handleSlow({
        type: 'library',
        session: 1,
        version: options.swap.version,
        bytes: options.swap.bytes,
      });
    const r = c.handle(done);
    if (done.corrected) outPool.release(done.corrected);
    if (r.kind === 'batch') {
      n++;
      batches.push(r);
      onBatch?.(r);
    }
  }
  a.dispose();
  b.dispose();
  c.dispose();
  return batches;
}

function recordOf(batches: Batch[]): RunRecord {
  const rec = new RunRecord(3);
  for (const b of batches) rec.push(b.start, b.dy, b.dx, b.flags, b.flickerOffset, b.flickerGain);
  return rec;
}

function replayOf(rec: RunRecord, frames: number): ReplayInput {
  return { frameCount: frames, ...rec.snapshot() };
}

describe('pass 2', () => {
  let libA: ReturnType<typeof makeLibrary>;
  beforeAll(() => {
    libA = makeLibrary([
      [20, 20],
      [24, 40],
      [34, 30],
    ]);
  });

  it('reproduces pass 1 bit for bit with the same library', async () => {
    const pass1 = await run({ library: libA.bytes });
    expect(pass1.length).toBe(Math.ceil(FRAMES / 8));
    const rec = recordOf(pass1);
    expect(rec.frames).toBe(FRAMES);
    expect(rec.complete).toBe(true);

    // The motion and flicker the replay is fed are not trivial.
    expect(Math.max(...pass1.flatMap((b) => [...b.dx].map(Math.abs)))).toBeGreaterThan(1);
    expect(Math.max(...pass1.flatMap((b) => [...b.flickerGain].map(Math.abs)))).toBeGreaterThan(0);

    // Pass 2 over the first 56 frames only (a pass 1 that was finished early).
    const N = 56;
    const pass2 = await run({ library: libA.bytes, replay: replayOf(rec, N) });
    expect(pass2.length).toBe(N / 8);
    let compared = 0;
    for (let i = 0; i < pass2.length; i++) {
      const o = pass1[i];
      const s = pass2[i];
      expect(s.start).toBe(o.start);
      expect(s.count).toBe(o.count);
      for (const k of ['dy', 'dx', 'flags', 'flickerOffset', 'flickerGain'] as const)
        expect(s[k], `${k} of batch ${i}`).toEqual(o[k]);
      expect(s.cells?.ids).toEqual(o.cells?.ids);
      expect(s.cells?.traces, `traces of batch ${i}`).toEqual(o.cells?.traces);
      expect(s.previews.output, `output of batch ${i}`).toEqual(o.previews.output);
      compared += s.count;
    }
    expect(compared).toBe(N);
    // Not a trivial comparison: the cells have signal.
    const tr = pass2[pass2.length - 1].cells!.traces;
    expect(Math.max(...tr)).toBeGreaterThan(0);
  });

  it('matches pass 1 after a library swap, once the solver has converged', async () => {
    const libB = makeLibrary([
      [20, 20],
      [24, 40],
      [34, 30],
      [12, 50],
    ]);
    expect(libB.version).toBeGreaterThan(libA.version);
    const SWAP = 3;
    const pass1 = await run({ library: libA.bytes, swap: { at: SWAP, ...libB } });
    expect(pass1[SWAP - 1].cells!.ids.length).toBe(3);
    expect(pass1[SWAP].cells!.ids.length).toBe(4);
    const pass2 = await run({ library: libB.bytes, replay: replayOf(recordOf(pass1), FRAMES) });
    expect(pass2.length).toBe(pass1.length);

    // Frames solved by the same (final) library in both passes.
    let worst = 0;
    let scale = 0;
    let frames = 0;
    for (let i = SWAP; i < pass1.length; i++) {
      const a = pass1[i].cells!.traces;
      const b = pass2[i].cells!.traces;
      expect(b.length).toBe(a.length);
      for (let k = 0; k < a.length; k++) {
        worst = Math.max(worst, Math.abs(a[k] - b[k]));
        scale = Math.max(scale, Math.abs(b[k]));
      }
      frames += pass1[i].count;
    }
    expect(frames).toBe(FRAMES - SWAP * 8);
    // Warm-start differences only: a small fraction of the trace scale.
    expect(worst / scale).toBeLessThan(0.02);
    console.info(
      `pass 1 vs pass 2 after a swap: max |diff| ${worst.toExponential(2)} of scale ${scale.toFixed(2)} over ${frames} frames`,
    );
  });

  it('refuses a replay longer than the recording or a short record', () => {
    const rec = recordOf([]);
    const frontPool = new StagePool(1, 8);
    expect(
      () =>
        new FrontStage(
          makeMovie(FRAMES),
          OPTIONS,
          () => frontPool.acquire(),
          undefined,
          replayOf(rec, FRAMES + 1),
        ),
    ).toThrow(/Pass 2 replays/);
    expect(
      () =>
        new FrontStage(
          makeMovie(FRAMES),
          OPTIONS,
          () => frontPool.acquire(),
          undefined,
          replayOf(rec, 10),
        ),
    ).toThrow(/fewer values/);
  });
});
