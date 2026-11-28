// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { entriesFromFiles, FrameSource } from '../lib/frame-source.ts';
import { TraceLibraryBuilder } from '../lib/cala-wasm.ts';
import { LookbackReader, lookbackFrames } from '../lib/lookback-reader.ts';
import { LookbackService } from '../lib/lookback-service.ts';
import type { LookbackToSlow } from '../workers/lookback-types.ts';
import type { PipelineStepResult } from '../lib/pipeline-types.ts';
import { BackStage, FrontStage, MotionStage, type ReplayInput } from '../lib/pipeline-stages.ts';
import { RunRecord } from '../lib/run-record.ts';
import type { SessionTransform } from '../lib/session-boundary.ts';
import { StagePool } from '../lib/stage-pool.ts';
import { buildAvi, expectedPixels, makeFile } from './synth-avi.ts';
import { initTestWasm } from './wasm-test.ts';
import { DEFAULT_PARAMS } from './params-fixtures.ts';

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
    reader.setParams(DEFAULT_PARAMS);
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

  it('a pinned request uses the snapshot and map it names, waiting for them, whatever came since', async () => {
    const live = await liveRun();
    const batches = live.steps.filter((s) => s.kind === 'batch');
    const src = await openAvi();
    const reader = new LookbackReader(src);
    reader.setParams(DEFAULT_PARAMS);
    for (const s of batches)
      reader.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
    const px = W * H;
    const map = {
      gain: new Float32Array(px).fill(0.5),
      offset: new Float32Array(0),
      dark: 0,
      binsUsed: 1,
      framesUsed: 1,
      gainSd: 0,
    };
    reader.setBackState(live.before.get(24)!, 24);
    // Newer inputs than the request names: a later snapshot and a first estimator map.
    reader.setBackState(live.before.get(48)!, 48);
    reader.setFlatField(map, 1);
    const y = new Float32Array(3 * px);
    const frames = [24, 25, 26].map((frame) => ({ frame, block: 1 }));
    reader.solve(await reader.prepare(frames, y, { flat: 0, state: 24 }));
    expect(Array.from(y)).toEqual(Array.from(live.out.subarray(24 * px, 27 * px)));
    // Unpinned, the same frames come from the newest inputs: not what Discover saw.
    const z = new Float32Array(px);
    await reader.serve([{ frame: 24, block: 2 }], z);
    expect(Array.from(z)).not.toEqual(Array.from(live.out.subarray(24 * px, 25 * px)));
    // A snapshot that has not come yet is waited for.
    let done = false;
    const later = reader
      .prepare([{ frame: 56, block: 3 }], z, { flat: 0, state: 56 })
      .then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    reader.setBackState(live.before.get(56)!, 56);
    await later;
    expect(Array.from(z)).toEqual(Array.from(live.out.subarray(56 * px, 57 * px)));
    reader.dispose();
    src.dispose();
  });

  it('prepare then solve gives what serve gives, solved with the library applied in between', async () => {
    const live = await liveRun();
    const batches = live.steps.filter((s) => s.kind === 'batch');
    const lib = (centres: [number, number][], version: number) => {
      const b = new TraceLibraryBuilder(W, H);
      centres.forEach(([cy, cx], i) => {
        const v = new Float32Array(81).fill(0.5);
        v[40] = 1;
        b.addFootprint(i + 1, cy - 4, cx - 4, 9, 9, v);
      });
      const l = b.buildUnfiltered();
      const out = { bytes: l.toBytes(), version };
      l.free();
      return out;
    };
    const a = lib([[12, 14]], 7);
    const b = lib(
      [
        [12, 14],
        [26, 30],
      ],
      8,
    );
    const px = W * H;
    const frames = [24, 25, 26].map((frame) => ({ frame, block: 1 }));
    const open = async () => {
      const src = await openAvi();
      const reader = new LookbackReader(src);
      reader.setParams(DEFAULT_PARAMS);
      for (const s of batches)
        reader.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
      reader.setBackState(live.before.get(24)!);
      return { src, reader };
    };
    // `serve` with library b in hand.
    const one = await open();
    one.reader.setLibrary(a.version, a.bytes);
    await one.reader.serve([{ frame: 23, block: 0 }], new Float32Array(px));
    one.reader.setLibrary(b.version, b.bytes);
    const y1 = new Float32Array(3 * px);
    const served = await one.reader.serve(frames, y1);
    // Prepared while library a is in use; b arrives, is applied (the cue), then the solve.
    const two = await open();
    two.reader.setLibrary(a.version, a.bytes);
    await two.reader.serve([{ frame: 23, block: 0 }], new Float32Array(px));
    const y2 = new Float32Array(3 * px);
    const prepared = await two.reader.prepare(frames, y2);
    two.reader.setLibrary(b.version, b.bytes);
    two.reader.applyLibrary();
    const solved = two.reader.solve(prepared);
    // (The version is the library's own, from its bytes: b's, built after a's.)
    expect(served.version).toBeGreaterThan(0);
    expect(solved.version).toBe(served.version);
    expect(solved.cells).toBe(2);
    expect(Array.from(y2)).toEqual(Array.from(y1));
    expect(Array.from(solved.traces)).toEqual(Array.from(served.traces));
    expect(Array.from(solved.background ?? [])).toEqual(Array.from(served.background ?? []));
    expect(served.traces.some((v) => v !== 0)).toBe(true);
    // A request that names its library (a repeatable run): a newer one in hand waits for a later request.
    const three = await open();
    three.reader.setLibrary(a.version, a.bytes);
    three.reader.setLibrary(b.version, b.bytes);
    three.reader.applyLibrary(a.version);
    const pinned = three.reader.solve(await three.reader.prepare(frames, new Float32Array(3 * px)));
    expect(pinned.cells).toBe(1);
    three.reader.applyLibrary(b.version);
    const next = three.reader.solve(await three.reader.prepare(frames, new Float32Array(3 * px)));
    expect(next.cells).toBe(2);
    for (const o of [one, two, three]) {
      o.reader.dispose();
      o.src.dispose();
    }
  });

  it('the worker service with the real reader: a gated, held request answers what serve gives', async () => {
    const live = await liveRun();
    const batches = live.steps.filter((s) => s.kind === 'batch');
    const px = W * H;
    const lib = (centres: [number, number][]) => {
      const b = new TraceLibraryBuilder(W, H);
      centres.forEach(([cy, cx], i) => {
        const v = new Float32Array(81).fill(0.5);
        v[40] = 1;
        b.addFootprint(i + 1, cy - 4, cx - 4, 9, 9, v);
      });
      const l = b.buildUnfiltered();
      const out = { bytes: l.toBytes(), version: Number(l.version) };
      l.free();
      return out;
    };
    const a = lib([[12, 14]]);
    const b = lib([
      [12, 14],
      [26, 30],
    ]);
    const open = async () => {
      const src = await openAvi();
      const reader = new LookbackReader(src);
      reader.setParams(DEFAULT_PARAMS);
      for (const s of batches)
        reader.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
      return { src, reader };
    };
    // Direct: the final back state in hand, library a for the first request, b for the second.
    const direct = await open();
    direct.reader.setBackState(live.before.get(24)!);
    direct.reader.setLibrary(a.version, a.bytes);
    const d1 = await direct.reader.serve(
      [24, 25].map((frame) => ({ frame, block: 1 })),
      new Float32Array(2 * px),
    );
    direct.reader.setLibrary(b.version, b.bytes);
    const y2 = new Float32Array(2 * px);
    const d2 = await direct.reader.serve(
      [26, 27].map((frame) => ({ frame, block: 1 })),
      y2,
    );
    // Through the service: an older back state first; the final one and `final` come after the
    // requests; the second request is held, and library b comes just before its cue.
    const svc = await open();
    const answers: LookbackToSlow[] = [];
    const service = new LookbackService({
      open: () =>
        Promise.resolve({
          server: svc.reader,
          reader: svc.reader,
          pool: new StagePool(3, 16 * px),
        }),
      factorServer: () => {
        throw new Error('no factors here');
      },
      postSlow: (m) => answers.push(m),
      postMain: () => {},
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    service.handleMain({ type: 'begin', session: 1, source: { entries: [] } });
    service.handleMain({
      type: 'back-state',
      session: 1,
      frame: 8,
      state: live.before.get(8)!.slice(),
    });
    await tick();
    service.handleSlow({ type: 'library', session: 1, version: a.version, bytes: a.bytes });
    const items = (frames: number[]) => Float64Array.from(frames.flatMap((f) => [f, 1, 0]));
    service.handleSlow({ type: 'request', session: 1, id: 1, items: items([24, 25]), final: true });
    service.handleSlow({
      type: 'request',
      session: 1,
      id: 2,
      items: items([26, 27]),
      final: true,
      hold: true,
    });
    await tick();
    expect(answers).toHaveLength(0);
    service.handleMain({ type: 'back-state', session: 1, frame: 24, state: live.before.get(24)! });
    service.handleMain({ type: 'final', session: 1 });
    for (let k = 0; k < 20 && answers.length < 1; k++) await tick();
    service.handleSlow({ type: 'library', session: 1, version: b.version, bytes: b.bytes });
    service.handleSlow({ type: 'solve', session: 1, id: 2 });
    for (let k = 0; k < 20 && answers.length < 2; k++) await tick();
    const [s1, s2] = answers.map((m) => (m.type === 'frames' ? m : null));
    expect(s1?.id).toBe(1);
    expect(s2?.id).toBe(2);
    expect(Array.from(s1!.traces)).toEqual(Array.from(d1.traces));
    expect(Array.from(s2!.traces)).toEqual(Array.from(d2.traces));
    expect(s2!.cells).toBe(2);
    expect(Array.from(s2!.frames.subarray(0, 2 * px))).toEqual(Array.from(y2));
    expect(Array.from(y2)).toEqual(Array.from(live.out.subarray(26 * px, 28 * px)));
    direct.reader.dispose();
    direct.src.dispose();
    svc.src.dispose();
  });

  it('a frame marked to skip is still preprocessed, so its block runs on', async () => {
    const live = await liveRun();
    const batches = live.steps.filter((s) => s.kind === 'batch');
    const src = await openAvi();
    const reader = new LookbackReader(src);
    reader.setParams(DEFAULT_PARAMS);
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
    reader.setParams(DEFAULT_PARAMS);
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
    reader.setParams(DEFAULT_PARAMS);
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
    reader.setParams(DEFAULT_PARAMS);
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
      const a = new FrontStage(src, OPTIONS, () => frontPool.acquire(), replay);
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
      reader.setParams(DEFAULT_PARAMS);
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
      one.setParams(DEFAULT_PARAMS);
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
      pool.setParams(DEFAULT_PARAMS);
      const all = new LookbackReader(three);
      all.setParams(DEFAULT_PARAMS);
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
      reader.setParams(DEFAULT_PARAMS);
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
      bare.setParams(DEFAULT_PARAMS);
      for (const s of replay.batches)
        if (s.kind === 'batch')
          bare.pushRows(s.start, s.dy, s.dx, s.flags, s.flickerOffset, s.flickerGain);
      bare.setBackState(replay.before.get(56)!, 56);
      await bare.serve([{ frame: 56, block: 1 }], z);
      expect(Array.from(z)).not.toEqual(Array.from(replay.out.subarray(56 * px, 57 * px)));
      // Nor with session 0's state: a session-1 frame never borrows it.
      const other = new LookbackReader(src);
      other.setParams(DEFAULT_PARAMS);
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
