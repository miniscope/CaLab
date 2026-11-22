// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { entriesFromFiles, FrameSource } from '../lib/frame-source.ts';
import { LookbackReader, lookbackFrames } from '../lib/lookback-reader.ts';
import type { PipelineStepResult } from '../lib/pipeline-engine.ts';
import { BackStage, FrontStage, MotionStage, type ReplayInput } from '../lib/pipeline-stages.ts';
import { RunRecord } from '../lib/run-record.ts';
import type { SessionTransform } from '../lib/session-boundary.ts';
import { StagePool } from '../lib/stage-pool.ts';
import { buildAvi, expectedPixels, makeFile } from './synth-avi.ts';
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

  it('a frame marked to skip is still preprocessed, so its block runs on', async () => {
    const live = await liveRun();
    const batches = live.steps.filter((s) => s.kind === 'batch');
    const src = await openAvi();
    const reader = new LookbackReader(src);
    for (const s of batches)
      reader.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
    reader.setBackState(live.before.get(24)!);
    const px = W * H;
    const y = new Float32Array(3 * px);
    // (The settle during Discover marks held-out frames: not solved, never fitted.)
    const solved = await reader.serve(
      [24, 25, 26].map((frame) => ({ frame, block: -1_000_001 })),
      y,
      Uint8Array.of(0, 1, 0),
    );
    expect(solved.version).toBe(0);
    expect(Array.from(y)).toEqual(Array.from(live.out.subarray(24 * px, 27 * px)));
    reader.dispose();
    src.dispose();
  });

  it('a settle chunk never disturbs the need-driven block: its preprocessor goes on across the chunk', async () => {
    const live = await liveRun();
    const batches = live.steps.filter((s) => s.kind === 'batch');
    const src = await openAvi();
    const reader = new LookbackReader(src);
    for (const s of batches)
      reader.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
    reader.setBackState(live.before.get(24)!);
    const px = W * H;
    const z = new Float32Array(px);
    // Need-driven block 1 in 1-frame requests, with a settle chunk (its own block seq) in between.
    await reader.serve([{ frame: 24, block: 1 }], z);
    await reader.serve([{ frame: 25, block: 1 }], z);
    const y = new Float32Array(2 * px);
    await reader.serve(
      [8, 9].map((frame) => ({ frame, block: -1_000_001 })),
      y,
      Uint8Array.of(0, 1),
    );
    await reader.serve([{ frame: 26, block: 1 }], z);
    // As Discover saw it: block 1 went on from frame 25, not from the live state again.
    expect(Array.from(z)).toEqual(Array.from(live.out.subarray(26 * px, 27 * px)));
    // And a second chunk, then more of the need block.
    await reader.serve([{ frame: 10, block: -1_000_002 }], z);
    await reader.serve([{ frame: 27, block: 1 }], z);
    expect(Array.from(z)).toEqual(Array.from(live.out.subarray(27 * px, 28 * px)));
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

  describe('a Joint run (two sessions)', () => {
    /** Session 0: frames 0..47, session 1: 48..79 (a boundary at 48, a batch edge). */
    const S0 = 48;
    const S1 = 32;
    /** The re-registration of session 1, forced (a replay installs the recorded one). */
    const T1: SessionTransform = [1.5, 2, -1];
    const openJoint = () =>
      FrameSource.openSessions(
        (
          [
            ['day1', S0],
            ['day2', S1],
          ] as const
        ).map(([name, frames]) => ({
          name,
          dir: `data/${name}`,
          entries: entriesFromFiles([
            makeFile('0.avi', buildAvi({ width: W, height: H, frames }), `data/${name}`),
          ]),
        })),
      );

    /** Stages A -> B -> C in-process; `replay`: Extract's replay of the recorded run. */
    async function run(src: FrameSource, replay?: ReplayInput) {
      const len = OPTIONS.batchSize * W * H;
      const frontPool = new StagePool(3, len);
      const outPool = new StagePool(3, len);
      const a = new FrontStage(src, OPTIONS, () => frontPool.acquire(), undefined, replay);
      const b = new MotionStage(a.setup, () => outPool.acquire());
      const c = new BackStage(a.setup, null, null, 16);
      const total = src.info.frameCount;
      const out = new Float32Array(total * W * H);
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
        if (r.kind === 'batch')
          out.set(done.corrected!.subarray(0, r.count * W * H), r.start * W * H);
        if (done.corrected) outPool.release(done.corrected);
      }
      a.dispose();
      b.dispose();
      c.dispose();
      return { out, before, batches: steps.filter((x) => x.kind === 'batch') };
    }

    /** Discover's run, then Extract's replay of it with session 1 re-registered by `T1`. */
    async function jointRuns() {
      const src = await openJoint();
      const live = await run(src);
      const record = new RunRecord();
      for (const s of live.batches)
        if (s.kind === 'batch')
          record.push(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
      record.noteSession(1, T1);
      const replay = await run(src, { frameCount: S0 + S1, ...record.snapshot() });
      return { src, live, replay };
    }

    it("maps a global frame to its session and reads it from that session's file", async () => {
      const src = await openJoint();
      const reader = new LookbackReader(src);
      expect(reader.sessionOf(0)).toBe(0);
      expect(reader.sessionOf(S0 - 1)).toBe(0);
      expect(reader.sessionOf(S0)).toBe(1);
      expect(reader.sessionOf(S0 + S1 - 1)).toBe(1);
      // Global frame S0 + 3 is day2's frame 3 (each file starts its own frame count).
      const opts = { width: W, height: H, frames: S1 };
      expect(Array.from(await src.readFrames(S0 + 3, 1))).toEqual(
        Array.from(expectedPixels(opts, 3)),
      );
      reader.dispose();
      src.dispose();
      // A recording without sessions is one session.
      const plain = await openAvi();
      const one = new LookbackReader(plain);
      expect([0, FRAMES - 1].map((f) => one.sessionOf(f))).toEqual([0, 0]);
      one.dispose();
      plain.dispose();
    });

    it("a pool reader keeps the newest two sessions' states; worker 0 keeps every one", async () => {
      const src = await openJoint();
      // A third session's worth of frame indices: boundaries at 48 only, so fake a source.
      const three = {
        info: {
          ...src.info,
          sessions: [0, 48, 64].map((startFrame, index) => ({
            ...src.info.sessions![0],
            index,
            startFrame,
          })),
        },
        readFrames: src.readFrames.bind(src),
      };
      const pool = new LookbackReader(three, { keepSessions: 2 });
      const all = new LookbackReader(three);
      const held = (r: LookbackReader) =>
        [...(r as unknown as { backStates: Map<number, Uint8Array> }).backStates.keys()].sort();
      for (const [frame, v] of [
        [40, 1],
        [56, 2],
        [72, 3],
      ] as const) {
        pool.setBackState(Uint8Array.of(v), frame);
        all.setBackState(Uint8Array.of(v), frame);
      }
      expect(held(pool)).toEqual([1, 2]);
      expect(held(all)).toEqual([0, 1, 2]);
      pool.dispose();
      all.dispose();
      src.dispose();
    });

    it('stage C snapshots the first and last batch of every session', async () => {
      const src = await openJoint();
      const live = await run(src);
      const frames = live.batches.map((s) => (s.kind === 'batch' ? s.backState?.frame : null));
      // After the first batch, every 16 frames, and at the join: the last batch of
      // session 0 (ends at 48) and the first of session 1 (ends at 56).
      expect(frames.filter((f) => f != null)).toEqual([8, 24, 40, 48, 56, 72]);
      src.dispose();
    });

    it("serves a session's frames with its re-registration and its own back state, as Extract replays them", async () => {
      const { src, replay } = await jointRuns();
      // The replay installed the recorded transform (no estimate) at the join.
      const join = replay.batches.find((s) => s.kind === 'batch' && s.session);
      expect(join?.kind === 'batch' && join.session).toMatchObject({ frame: S0, transform: T1 });
      expect(join?.kind === 'batch' && join.session?.fitted).toBeUndefined();
      const reader = new LookbackReader(src);
      for (const s of replay.batches)
        if (s.kind === 'batch')
          reader.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
      reader.setSession(1, T1);
      const px = W * H;
      // Session 1's state before its second batch (frame 56 starts it), and session 0's
      // before its frame 32: each block starts from the state of its own session.
      reader.setBackState(replay.before.get(56)!, 56);
      reader.setBackState(replay.before.get(32)!, 32);
      const y = new Float32Array(3 * px);
      await reader.serve(
        [56, 57, 58].map((frame) => ({ frame, block: 1 })),
        y,
      );
      // Extract's replay of the same frames: the warp, the rigid shift, the session's floor
      // and noise, and validity against the FOV as the warp moved it.
      expect(Array.from(y)).toEqual(Array.from(replay.out.subarray(56 * px, 59 * px)));
      // A Final-settle block that starts in session 0 goes on with session 0's state.
      const z = new Float32Array(px);
      await reader.serve([{ frame: 32, block: 2 }], z);
      expect(Array.from(z)).toEqual(Array.from(replay.out.subarray(32 * px, 33 * px)));
      reader.dispose();

      // The check has teeth: without the session's warp the frame is not what Extract saw.
      const bare = new LookbackReader(src);
      for (const s of replay.batches)
        if (s.kind === 'batch')
          bare.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
      bare.setBackState(replay.before.get(56)!, 56);
      await bare.serve([{ frame: 56, block: 1 }], z);
      expect(Array.from(z)).not.toEqual(Array.from(replay.out.subarray(56 * px, 57 * px)));
      // Nor with session 0's state: a session-1 frame never borrows it.
      const other = new LookbackReader(src);
      for (const s of replay.batches)
        if (s.kind === 'batch')
          other.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
      other.setSession(1, T1);
      other.setBackState(replay.before.get(40)!, 40);
      let served = false;
      const waiting = other.serve([{ frame: 56, block: 1 }], z).then(() => (served = true));
      await new Promise((r) => setTimeout(r, 10));
      // A session-1 frame waits for a session-1 state; it never borrows session 0's.
      expect(served).toBe(false);
      other.setBackState(replay.before.get(56)!, 56);
      await waiting;
      expect(Array.from(z)).toEqual(Array.from(replay.out.subarray(56 * px, 57 * px)));
      bare.dispose();
      other.dispose();
      src.dispose();
    });
  });
});
