// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { entriesFromFiles, FrameSource } from '../lib/frame-source.ts';
import { LookbackReader, lookbackFrames } from '../lib/lookback-reader.ts';
import type { PipelineStepResult } from '../lib/pipeline-engine.ts';
import { BackStage, FrontStage, MotionStage } from '../lib/pipeline-stages.ts';
import { StagePool } from '../lib/stage-pool.ts';
import { buildAvi, makeFile } from './synth-avi.ts';
import { initTestWasm } from './wasm-test.ts';

beforeAll(initTestWasm);

const W = 48;
const H = 40;
const FRAMES = 72;
const OPTIONS = { calibrationFrames: 16, motionWarmupFrames: 16, batchSize: 8, previewMaxSide: 32 };

const openAvi = () =>
  FrameSource.open(
    entriesFromFiles([makeFile('0.avi', buildAvi({ width: W, height: H, frames: FRAMES }), 'rec')]),
  );

/**
 * Discover's stages A -> B -> C chained in-process (as the stage test does),
 * keeping C's post-back frames (what the slow loop observes) and its back
 * half's state before each batch.
 */
async function liveRun() {
  const src = await openAvi();
  const len = OPTIONS.batchSize * W * H;
  const frontPool = new StagePool(3, len);
  const outPool = new StagePool(3, len);
  const a = new FrontStage(src, OPTIONS, () => frontPool.acquire());
  const b = new MotionStage(a.setup, () => outPool.acquire());
  const c = new BackStage(a.setup, null, null, 16);
  const out = new Float32Array(FRAMES * W * H);
  const before = new Map<number, Uint8Array>();
  const steps: PipelineStepResult[] = [];
  for (;;) {
    const job = await a.next();
    if (!job) break;
    const done = await b.handle(job);
    if (done.front) frontPool.release(done.front);
    if (done.step.phase === 'process') before.set(done.step.start, c.backState()!);
    const r = c.handle(done);
    steps.push(r);
    if (r.kind === 'batch') out.set(done.corrected!.subarray(0, r.count * W * H), r.start * W * H);
    if (done.corrected) outPool.release(done.corrected);
  }
  a.dispose();
  b.dispose();
  c.dispose();
  src.dispose();
  return { out, before, steps };
}

describe('LookbackReader', () => {
  it('parses lookbackTake output', () => {
    expect(lookbackFrames([5, 2, 2, 11, 12, 6, 2, 1, 11])).toEqual([
      { frame: 5, block: 2 },
      { frame: 6, block: 2 },
    ]);
  });

  it('preprocesses a requested frame exactly as Discover did, from the back state of its block', async () => {
    const live = await liveRun();
    const batches = live.steps.filter((s) => s.kind === 'batch');
    expect(batches.length).toBe(FRAMES / 8);
    // Snapshots: after the first batch, then every 16 frames.
    expect(batches.filter((s) => s.backState).map((s) => s.backState!.frame)).toEqual([
      8, 24, 40, 56, 72,
    ]);
    const src = await openAvi();
    const reader = new LookbackReader(src);
    for (const s of batches)
      reader.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
    // Block 1 starts at frame 24 from C's state before that batch: 3 frames forward.
    reader.setBackState(live.before.get(24)!);
    const px = W * H;
    const y = new Float32Array(3 * px);
    const solved = await reader.serve(
      [24, 25, 26].map((frame) => ({ frame, block: 1 })),
      y,
    );
    // No library yet: nothing solved, the frames are preprocessed all the same.
    expect(solved.version).toBe(0);
    expect(Array.from(y)).toEqual(Array.from(live.out.subarray(24 * px, 27 * px)));
    // The same block goes on from where it stopped, across requests.
    const z = new Float32Array(px);
    await reader.serve([{ frame: 27, block: 1 }], z);
    expect(Array.from(z)).toEqual(Array.from(live.out.subarray(27 * px, 28 * px)));
    // A new block starts from the newest state: frame 48 from C's state before it.
    reader.setBackState(live.before.get(48)!);
    await reader.serve([{ frame: 48, block: 2 }], z);
    expect(Array.from(z)).toEqual(Array.from(live.out.subarray(48 * px, 49 * px)));
    // The check has teeth: frame 24 from a later state is not what Discover saw.
    await reader.serve([{ frame: 24, block: 3 }], z);
    expect(Array.from(z)).not.toEqual(Array.from(live.out.subarray(24 * px, 25 * px)));
    expect(z.some((v) => v !== 0)).toBe(true);
    reader.dispose();
    src.dispose();
  });

  it('waits for the rows of a frame Discover has not recorded yet', async () => {
    const live = await liveRun();
    const batches = live.steps.filter((s) => s.kind === 'batch');
    const src = await openAvi();
    const reader = new LookbackReader(src);
    reader.setBackState(live.before.get(16)!);
    const first = batches[0];
    if (first.kind !== 'batch') throw new Error('no batch');
    reader.pushRows(
      first.start,
      first.dy,
      first.dx,
      first.flags,
      first.flickerOffset,
      first.flickerGain,
    );
    let done = false;
    const y = new Float32Array(W * H);
    const p = reader.serve([{ frame: 17, block: 0 }], y).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    for (const s of batches.slice(1, 3))
      if (s.kind === 'batch')
        reader.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
    await p;
    expect(done).toBe(true);
    // A gap in the record fails the request instead of waiting forever.
    reader.pushRows(40, Float32Array.of(0), Float32Array.of(0), [0], [0], [0]);
    await expect(reader.serve([{ frame: 60, block: 3 }], y)).rejects.toThrow(/gap/);
    reader.dispose();
    src.dispose();
  });

  it('dispose rejects a request still waiting for the back state', async () => {
    const live = await liveRun();
    const first = live.steps.find((s) => s.kind === 'batch');
    if (!first || first.kind !== 'batch') throw new Error('no batch');
    const src = await openAvi();
    const reader = new LookbackReader(src);
    reader.pushRows(
      first.start,
      first.dy,
      first.dx,
      first.flags,
      first.flickerOffset,
      first.flickerGain,
    );
    const y = new Float32Array(W * H);
    // The rows are there, the back state is not: the request waits on it.
    let chain: Promise<unknown> = Promise.resolve();
    const run = () => reader.serve([{ frame: first.start, block: 0 }], y);
    const waiting = run().then(
      () => 'done',
      (e: Error) => e.message,
    );
    chain = chain.then(() => waiting);
    await new Promise((r) => setTimeout(r, 10));
    reader.dispose();
    await expect(waiting).resolves.toMatch(/stopped/);
    // The serial chain (the worker's `requests`) moves on after the rejection.
    await expect(chain).resolves.toBeDefined();
    src.dispose();
  });
});
