import { describe, expect, it, vi } from 'vitest';
import type { CellStore } from '../lib/cell-store.ts';
import type { FactorState } from '../lib/compress-store.ts';
import { createCompressStore } from '../lib/compress-store.ts';
import { createPass2Factors, lowValidCells } from '../lib/factor-extract.ts';
import type { FactorWindowTraces, Pass2Factors } from '../lib/factor-extract.ts';
import type { FlatFieldMap } from '../lib/flat-field.ts';
import type { FovProjections } from '../lib/fov-projection.ts';
import type { PipelineClient } from '../lib/frame-client.ts';
import type { PipelineStepResult } from '../lib/pipeline-engine.ts';
import type { PipelinePlan } from '../lib/pipeline-plan.ts';
import { createPass2Store } from '../lib/pass2-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { RunRecord } from '../lib/run-record.ts';
import { TraceFile } from '../lib/trace-file.ts';
import type { LibraryView } from '../workers/slow-types.ts';

const PLAN: PipelinePlan = {
  frameCount: 100,
  batchSize: 4,
  calibrationFrames: 4,
  motionWarmupFrames: 4,
  previewMaxSide: 32,
  boundaries: [],
  sessionFix: true,
};
const IDS = Uint32Array.of(3, 8);

function batch(start: number, count: number, ids = IDS, withSigned = true): PipelineStepResult {
  const traces = new Float32Array(count * ids.length);
  for (let f = 0; f < count; f++)
    for (let c = 0; c < ids.length; c++) traces[f * ids.length + c] = 10 * (start + f) + c;
  // Signed: the traces minus 1000 (made-up values; only where they land matters).
  const signed = withSigned ? traces.map((v) => v - 1000) : undefined;
  const z = new Float32Array(count);
  return {
    kind: 'batch',
    start,
    count,
    dy: z,
    dx: z,
    quality: z,
    flags: new Uint32Array(count),
    flickerOffset: z,
    flickerGain: z,
    previews: {} as never,
    timings: { readMs: 0, preprocessMs: 0, motionMs: 0, otherMs: 0, traceMs: 0 },
    stageBusyMs: [1, 1, 1],
    cells: {
      version: 5,
      ids,
      traces,
      ...(signed ? { signed } : {}),
      swapMs: 0,
      solveMs: 0,
      forwardMs: 0,
      discovering: false,
      forwardedFrames: 0,
      droppedFrames: 0,
      slowFrame: 0,
      qcOn: false,
    },
  };
}

function setup(
  opts: {
    final?: boolean;
    frames?: number;
    /** The motion record misses frame 3 (a file's replay is refused). */
    gap?: boolean;
    status?: string;
    flatMap?: FlatFieldMap | null;
    noSigned?: boolean;
    factors?: Pass2Factors;
    live?: { on(): boolean; blocked(): string | null };
    /** The replay never answers a step (still running when the test cancels it). */
    hang?: boolean;
    /** The replay fails to start. */
    startFails?: boolean;
    /** The replay's start waits for this. */
    startGate?: Promise<void>;
  } = {},
) {
  const rec = new RunRecord();
  const frames = opts.frames ?? 8;
  for (let t = 0; t < frames; t++)
    if (!(opts.gap && t === 3)) rec.push(t, [t], [-t], [0], [0.5], [0.01]);
  rec.noteSession(1, [0.25, 2, -3]);
  const started: { options: unknown; cells: unknown; replay: unknown }[] = [];
  const steps: PipelineStepResult[] = [
    batch(0, 4, IDS, !opts.noSigned),
    batch(4, 4, IDS, !opts.noSigned),
    { kind: 'done' },
  ];
  const stops: unknown[] = [];
  const client: PipelineClient = {
    async startPipeline(options, cells, replay) {
      started.push({ options, cells, replay });
      await opts.startGate;
      if (opts.startFails) throw new Error('no worker');
      return PLAN;
    },
    async stepPipeline() {
      if (opts.hang) return new Promise<PipelineStepResult>(() => {});
      return steps.shift() ?? { kind: 'done' };
    },
    async stopPipeline(o) {
      stops.push(o);
    },
  };
  const view = { version: 5, ids: IDS, centers: new Float32Array(4) } as unknown as LibraryView;
  const pipeline = {
    status: () => opts.status ?? 'done',
    record: () => rec,
    plan: () => PLAN,
    flatFieldMap: () => opts.flatMap ?? null,
  } as unknown as PipelineStore;
  const cells = {
    library: () => view,
    libraryBytes: () => Uint8Array.of(1, 2, 3),
    status: () => ({ final: opts.final ?? true }),
  } as unknown as CellStore;
  return {
    store: createPass2Store(client, pipeline, cells, undefined, undefined, opts.factors, opts.live),
    started,
    steps,
    stops,
  };
}

/** One window of a factor Extract, with the traces `batch` would give. */
function win(
  start: number,
  count: number,
  ids = IDS,
  minValid: number[] = Array.from(ids, () => 1),
): FactorWindowTraces {
  const traces = new Float32Array(count * ids.length);
  for (let f = 0; f < count; f++)
    for (let c = 0; c < ids.length; c++) traces[f * ids.length + c] = 10 * (start + f) + c;
  return {
    start,
    count,
    ids,
    traces,
    signed: traces.map((v) => v - 1000),
    minValid: Float32Array.from(minValid),
  };
}

/**
 * Factors in `state`; Extract on them calls `before`, gives `windows`, then
 * fails with `fail` or ends when `gate` resolves (at once when absent).
 */
function fakeFactors(
  state: FactorState,
  windows: FactorWindowTraces[] = [],
  job: { fail?: string; gate?: Promise<void>; before?: () => void } = {},
) {
  const calls: string[] = [];
  const proj = { spans: [] } as unknown as FovProjections;
  const kept: FovProjections[] = [];
  let sink: (w: FactorWindowTraces) => void = () => {};
  const f: Pass2Factors = {
    state: () => state,
    replayCompress: () => {
      calls.push('compress');
      return state === 'none'
        ? {
            settings: { compress: true, compressTiling: 'offset', compressSession: 4 },
            ended: (ok) => void calls.push(`ended ${ok}`),
          }
        : { settings: {}, ended: () => {} };
    },
    keepProjection: (p) => void kept.push(p),
    projection: () => proj,
    info: () => ({ tiling: 'offset', meanRank: 4.5 }),
    async extract(library, onWindow) {
      calls.push(`extract ${library.length}`);
      sink = onWindow;
      job.before?.();
      for (const w of windows) onWindow(w);
      await job.gate;
      if (job.fail) throw new Error(job.fail);
      return { frames: windows.reduce((s, w) => s + w.count, 0), msPerFrame: 0.1 };
    },
  };
  /** A window of the last job that arrives after the job ended. */
  const late = (w: FactorWindowTraces) => sink(w);
  return { f, calls, proj, kept, late };
}

/** A promise and its resolve. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

async function settle(): Promise<void> {
  // A factor Extract takes more turns than a replay (the job, the writes, finish).
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

describe('Extract (pass 2) store', () => {
  const LIVE = { on: () => true, blocked: () => null };

  it("reads the factors of a live run, as Discover's", async () => {
    const { f, calls } = fakeFactors('ready', [win(0, 4), win(4, 4)]);
    const { store, started } = setup({ factors: f, live: LIVE });
    expect(store.blockedReason()).toBeNull();
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(started).toHaveLength(0);
    expect(calls).toEqual(['extract 3']);
    expect(store.result()).toMatchObject({ source: 'factors', factors: 'discover' });
  });

  it('does not apply a replay reason to a live run', async () => {
    const { f, calls } = fakeFactors('ready', [win(0, 2), win(2, 1)]);
    const file = setup({ factors: f, gap: true });
    expect(file.store.blockedReason()).toBe('Discover has a gap in its motion record.');
    const { store, started } = setup({ factors: f, live: LIVE, gap: true });
    expect(store.blockedReason()).toBeNull();
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(started).toHaveLength(0);
    expect(calls).toEqual(['extract 3']);
  });

  it("marks a file's factor Extract as reading the replay's factors", async () => {
    const { f } = fakeFactors('ready', [win(0, 4), win(4, 4)]);
    const { store } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.result()?.factors).toBe('replay');
  });

  it('refuses to replay a stream, and says why the factors cannot be read yet', async () => {
    const why = "The stream's last windows are being compressed (2 waiting).";
    const { f, calls } = fakeFactors('compressing');
    const { store, started } = setup({ factors: f, live: { on: () => true, blocked: () => why } });
    expect(store.blockedReason()).toBe(why);
    await store.run();
    expect(store.status()).toBe('error');
    expect(store.error()).toBe(why);
    expect(started).toHaveLength(0);
    expect(calls).toEqual([]);
    const ready = fakeFactors('ready', [win(0, 4), win(4, 4)]);
    const raw = setup({ factors: ready.f, live: LIVE });
    await raw.store.run(undefined, 'raw');
    expect(raw.store.status()).toBe('error');
    expect(raw.store.error()).toBe(
      'A live stream has no file to replay: Extract reads the factors once they are ready.',
    );
    expect(raw.started).toHaveLength(0);
  });

  it('reads the factors of a live run again after a factor Extract failed', async () => {
    const { f, calls } = fakeFactors('ready', [win(0, 4), win(4, 4)], { fail: 'out of memory' });
    const { store, started } = setup({ factors: f, live: LIVE });
    await store.run();
    await settle();
    expect(store.status()).toBe('error');
    expect(store.factorsFailed()).toBe(true);
    await store.run();
    await settle();
    expect(calls).toEqual(['extract 3', 'extract 3']);
    expect(started).toHaveLength(0);
  });

  it('feeds the compressor on the offset grids when compression is on and no factors exist', async () => {
    const { f, calls } = fakeFactors('none');
    const { store, started } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(calls).toEqual(['compress', 'ended true']);
    expect(started[0].cells).toEqual({
      session: 0,
      discover: false,
      qc: false,
      signed: true,
      projection: true,
      library: Uint8Array.of(1, 2, 3),
      compress: true,
      compressTiling: 'offset',
      compressSession: 4,
    });
    expect(store.source()).toBe('raw');
    expect(store.result()?.source).toBe('raw');
  });

  it('replays the file when the factors are not ready, compressing only when there are none', async () => {
    for (const state of ['compressing', 'unusable'] as const) {
      const { f, calls } = fakeFactors(state);
      const { store, started } = setup({ factors: f });
      await store.run();
      await settle();
      expect(store.status()).toBe('done');
      expect(calls).toEqual([]);
      const keys = Object.keys(started[0].cells as object);
      expect(keys.filter((k) => k.startsWith('compress'))).toEqual([]);
      expect(store.result()?.source).toBe('raw');
    }
  });

  it('solves on the factors when they are ready, without replaying the file', async () => {
    const { f, calls, proj } = fakeFactors('ready', [win(0, 4), win(4, 4)]);
    const { store, started, stops } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(started).toHaveLength(0);
    expect(stops).toHaveLength(0);
    expect(calls).toEqual(['extract 3']);
    expect(store.source()).toBe('factors');
    const r = store.result()!;
    expect(r).toMatchObject({ source: 'factors', tiling: 'offset', meanRank: 4.5 });
    expect(r.frames).toBe(8);
    expect(r.cells).toBe(2);
    expect(r.projection).toBe(proj);
    expect([...(await r.traces.readFrames(5, 6))]).toEqual([50, 51]);
    expect([...(await r.signed!.readFrames(5, 6))]).toEqual([-950, -949]);
    expect(store.processed()).toBe(8);
  });

  it('keeps, per cell, the smallest valid share over the windows of a factor Extract', async () => {
    const { f } = fakeFactors('ready', [win(0, 4, IDS, [1, 0.75]), win(4, 4, IDS, [0.5, 1])]);
    const { store } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect([...store.result()!.minValid!]).toEqual([0.5, 0.75]);
    expect(lowValidCells(store.result()!.minValid)).toBe(2);
    expect(lowValidCells(Float32Array.of(1, 1))).toBe(0);
  });

  it('leaves no valid shares when the factor job fails, and none for a raw Extract', async () => {
    const job = { fail: 'solve failed' };
    const windows = [win(0, 4, IDS, [0.5, 0.75]), win(4, 4)];
    const failing = fakeFactors('ready', windows, job);
    const a = setup({ factors: failing.f });
    await a.store.run();
    await settle();
    expect(a.store.status()).toBe('error');
    expect(a.store.result()).toBeNull();

    const { store } = setup();
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(store.result()!.minValid).toBeUndefined();
    expect(lowValidCells(store.result()!.minValid)).toBeUndefined();
  });

  it('ends a factor Extract whose window has no valid share for each cell', async () => {
    const bad = { ...win(0, 4), minValid: new Float32Array(1) };
    const { f } = fakeFactors('ready', [bad, win(4, 4)]);
    const { store } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('error');
    expect(store.result()).toBeNull();
  });

  it('keeps the clipped traces only when the factor engine returns no signed ones', async () => {
    const unsigned = [win(0, 4), win(4, 4)].map((w) => ({ ...w, signed: new Float32Array(0) }));
    const { f } = fakeFactors('ready', unsigned);
    const { store } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    const r = store.result()!;
    expect(r.signed).toBeNull();
    expect([...(await r.traces.readFrames(5, 6))]).toEqual([50, 51]);
  });

  it('replays the file when asked, even with the factors ready', async () => {
    const { f, calls } = fakeFactors('ready', [win(0, 4), win(4, 4)]);
    const { store, started } = setup({ factors: f });
    await store.run(undefined, 'raw');
    await settle();
    expect(store.status()).toBe('done');
    expect(started).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(store.source()).toBe('raw');
    expect(store.result()?.source).toBe('raw');
  });

  it('ends with an error when the factor windows do not cover every frame', async () => {
    const { f } = fakeFactors('ready', [win(0, 4)]);
    const { store } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('error');
    expect(store.error()).toMatch(/4 of 8 frames/);
    expect(store.result()).toBeNull();
    expect(store.traceFile()).toBeNull();
  });

  it('ends with an error when the factor windows leave a gap', async () => {
    const { f } = fakeFactors('ready', [win(0, 2), win(4, 4)]);
    const { store } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('error');
    expect(store.error()).toMatch(/frames 2 to 3/);
    expect(store.result()).toBeNull();
  });

  it('ends with an error when the factor windows are for another library', async () => {
    const { f } = fakeFactors('ready', [win(0, 4, Uint32Array.of(3, 9)), win(4, 4)]);
    const { store } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('error');
    expect(store.error()).toMatch(/final library/);
    expect(store.result()).toBeNull();
  });

  it('keeps nothing of a factor job that fails after its windows were written', async () => {
    const g = gate();
    const job: { fail?: string; gate?: Promise<void> } = {};
    const windows = [win(0, 4), win(4, 4), win(8, 4)];
    const { f, late } = fakeFactors('ready', windows, job);
    const { store } = setup({ factors: f, frames: 12 });
    // An earlier Extract of the run finished; a new run clears its result at
    // its start, as a raw Extract does.
    await store.run();
    await settle();
    const earlier = store.result()!;
    expect(store.status()).toBe('done');
    // The next job sends two of the three windows, then fails.
    windows.pop();
    job.fail = 'solve failed';
    job.gate = g.promise;
    const running = store.run();
    await settle();
    expect(store.result()).toBeNull();
    await expect(earlier.traces.readFrames(0, 1)).rejects.toThrow();
    // Both windows are written to this run's file as they arrive.
    expect(store.processed()).toBe(8);
    const file = store.traceFile()!;
    expect([...(await file.readFrames(5, 6))]).toEqual([50, 51]);
    g.open();
    await running;
    await settle();
    expect(store.status()).toBe('error');
    expect(store.error()).toBe('solve failed');
    expect(store.result()).toBeNull();
    expect(store.traceFile()).toBeNull();
    // The run's file is gone.
    await expect(file.readFrames(0, 1)).rejects.toThrow();
    // The failed job's missing window, arriving late, writes nothing.
    const append = vi.spyOn(TraceFile.prototype, 'append');
    late(win(8, 4));
    expect(append).not.toHaveBeenCalled();
    expect(store.processed()).toBe(8);
    append.mockRestore();
  });

  it('ends a factor Extract at the first bad window and deletes what it wrote', async () => {
    const g = gate();
    let file: TraceFile | null = null;
    const job = { gate: g.promise, before: () => (file = store.traceFile()) };
    const { f } = fakeFactors('ready', [win(0, 4), win(2, 4)], job);
    const { store } = setup({ factors: f });
    // The job has not answered when `run` returns: the bad window alone ended the run.
    await store.run();
    await settle();
    expect(store.status()).toBe('error');
    expect(store.error()).toMatch(/frame 2 twice/);
    expect(store.traceFile()).toBeNull();
    expect(file).not.toBeNull();
    await expect(file!.readFrames(0, 1)).rejects.toThrow();
    g.open();
    await settle();
    expect(store.status()).toBe('error');
  });

  it('stops waiting for the factor job when cancelled, without touching the pipeline', async () => {
    const g = gate();
    const { f } = fakeFactors('ready', [win(0, 4), win(4, 4)], { gate: g.promise });
    const { store, stops, started } = setup({ factors: f });
    const running = store.run();
    await settle();
    store.cancel();
    expect(store.status()).toBe('cancelled');
    expect(stops).toHaveLength(0);
    // The wait ends although the job has not answered.
    let settled = false;
    void running.then(() => (settled = true));
    await settle();
    expect(settled).toBe(true);
    // The job ends late: nothing of it reaches the store.
    g.open();
    await settle();
    expect(store.status()).toBe('cancelled');
    expect(store.result()).toBeNull();
    expect(store.traceFile()).toBeNull();
    expect(started).toHaveLength(0);
  });

  it('cancels a factor Extract during its first wait without stopping a pipeline', async () => {
    const { f } = fakeFactors('ready', [win(0, 4), win(4, 4)]);
    const { store, stops, started } = setup({ factors: f });
    // The last run replayed the file.
    await store.run(undefined, 'raw');
    await settle();
    expect(store.source()).toBe('raw');
    const running = store.run();
    store.cancel();
    await running;
    expect(store.status()).toBe('cancelled');
    expect(stops).toHaveLength(0);
    expect(started).toHaveLength(1);
  });

  it('replays the file, without compressing, after a factor Extract failed', async () => {
    const job: { fail?: string } = { fail: 'solve failed' };
    const { f, calls } = fakeFactors('ready', [win(0, 4), win(4, 4)], job);
    const { store, started } = setup({ factors: f });
    await store.run();
    await settle();
    expect(store.status()).toBe('error');
    expect(store.factorsFailed()).toBe(true);
    job.fail = undefined;
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(store.source()).toBe('raw');
    expect(started).toHaveLength(1);
    const keys = Object.keys(started[0].cells as object);
    expect(keys.filter((k) => k.startsWith('compress'))).toEqual([]);
    expect(calls).toEqual(['extract 3']);
    // `clear` (called when a Discover starts; App.test.tsx covers that wiring)
    // resets it: Extract reads the factors again.
    store.clear();
    expect(store.factorsFailed()).toBe(false);
    await store.run();
    await settle();
    expect(store.source()).toBe('factors');
    expect(store.status()).toBe('done');
  });

  it('does not count a factor Extract aborted by a reset of the run as failed', async () => {
    const compress = createCompressStore();
    compress.reset(7);
    compress.onMessage({
      type: 'status',
      session: 7,
      status: {
        windows: 1,
        frames: 8,
        pending: 0,
        pendingFrames: 0,
        meanRank: 2,
        msPerFrame: 1,
        factorBytes: 1,
        final: true,
        tiling: 'offset',
        source: 'replay',
      },
    });
    const { store } = setup({ factors: createPass2Factors(compress, { extract() {} }) });
    const running = store.run();
    await settle();
    expect(store.source()).toBe('factors');
    // A new run resets the compress store: the job is aborted, not failed.
    compress.reset(8);
    await running;
    expect(store.status()).toBe('error');
    expect(store.factorsFailed()).toBe(false);
  });

  it('counts a gap and a compression error during the job as failed', async () => {
    const gap = setup({ factors: fakeFactors('ready', [win(0, 2), win(4, 4)]).f }).store;
    await gap.run();
    await settle();
    expect(gap.factorsFailed()).toBe(true);
    const twice = setup({ factors: fakeFactors('ready', [win(0, 4), win(2, 4)]).f }).store;
    await twice.run();
    await settle();
    expect(twice.factorsFailed()).toBe(true);
    const compress = createCompressStore();
    compress.reset(7);
    compress.onMessage({
      type: 'status',
      session: 7,
      status: {
        windows: 1,
        frames: 8,
        pending: 0,
        pendingFrames: 0,
        meanRank: 2,
        msPerFrame: 1,
        factorBytes: 1,
        final: true,
        tiling: 'offset',
        source: 'replay',
      },
    });
    const { store } = setup({ factors: createPass2Factors(compress, { extract() {} }) });
    const running = store.run();
    await settle();
    compress.onMessage({ type: 'error', session: 7, message: 'QuotaExceededError' });
    await running;
    expect(store.error()).toBe('QuotaExceededError');
    expect(store.factorsFailed()).toBe(true);
  });

  it('reads the factors again after a factor Extract was cancelled', async () => {
    const g = gate();
    const job: { gate?: Promise<void> } = { gate: g.promise };
    const { f } = fakeFactors('ready', [win(0, 4), win(4, 4)], job);
    const { store, started } = setup({ factors: f });
    const running = store.run();
    await settle();
    store.cancel();
    await running;
    expect(store.factorsFailed()).toBe(false);
    job.gate = undefined;
    await store.run();
    await settle();
    expect(store.source()).toBe('factors');
    expect(started).toHaveLength(0);
  });

  it('keeps the projections of a replay that compressed', async () => {
    const { f, calls, kept } = fakeFactors('none');
    const { store, steps } = setup({ factors: f });
    const proj = { spans: [] } as unknown as FovProjections;
    steps[2] = { kind: 'done', projection: proj } as PipelineStepResult;
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(kept).toEqual([proj]);
    expect(calls).toEqual(['compress', 'ended true']);
  });

  it('keeps no projections of a replay that did not compress', async () => {
    const { f, kept } = fakeFactors('unusable');
    const { store, steps } = setup({ factors: f });
    steps[2] = { kind: 'done', projection: { spans: [] } } as unknown as PipelineStepResult;
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(kept).toEqual([]);
  });

  it('releases the compress mark when its replay is cancelled', async () => {
    const { f, calls } = fakeFactors('none');
    const { store, stops } = setup({ factors: f, hang: true });
    await store.run();
    store.cancel();
    expect(calls).toEqual(['compress', 'ended false']);
    expect(stops).toHaveLength(1);
  });

  it('releases the compress mark when its replay fails to start', async () => {
    const { f, calls } = fakeFactors('none');
    const { store } = setup({ factors: f, startFails: true });
    await store.run();
    expect(store.status()).toBe('error');
    expect(calls).toEqual(['compress', 'ended false']);
  });

  it('releases the compress mark when its replay is cleared while starting', async () => {
    const g = gate();
    const { f, calls } = fakeFactors('none');
    const { store } = setup({ factors: f, startGate: g.promise });
    const running = store.run();
    await settle();
    expect(calls).toEqual(['compress']);
    store.clear();
    g.open();
    await running;
    expect(store.status()).toBe('idle');
    expect(calls).toEqual(['compress', 'ended false']);
  });

  it('releases the compress mark when its replay stops with an error', async () => {
    const { f, calls } = fakeFactors('none');
    const { store, steps } = setup({ factors: f });
    steps[0] = batch(0, 4, Uint32Array.of(3, 9));
    await store.run();
    await settle();
    expect(store.status()).toBe('error');
    expect(calls).toEqual(['compress', 'ended false']);
  });

  it('replays the recorded frames with the final library and gathers the traces', async () => {
    const { store, started } = setup();
    expect(store.blockedReason()).toBeNull();
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(started).toHaveLength(1);
    expect(started[0].cells).toEqual({
      session: 0,
      discover: false,
      qc: false,
      signed: true,
      projection: true,
      library: Uint8Array.of(1, 2, 3),
    });
    expect(started[0].options).toEqual({
      batchSize: 4,
      calibrationFrames: 4,
      motionWarmupFrames: 4,
      previewMaxSide: 32,
    });
    const replay = started[0].replay as ReturnType<RunRecord['snapshot']> & {
      frameCount: number;
    };
    expect(replay.frameCount).toBe(8);
    expect(replay.dy[3]).toBe(3);
    expect(replay.dx[3]).toBe(-3);
    expect(replay.flags).toEqual(new Uint8Array(8));
    expect(replay.flickerOffset).toEqual(new Float32Array(8).fill(0.5));
    expect(replay.flickerGain).toEqual(new Float32Array(8).fill(0.01));
    expect(replay.sessionTransforms?.[1]).toEqual([0.25, 2, -3]);
    const r = store.result()!;
    expect(r.frames).toBe(8);
    expect(r.cells).toBe(2);
    // Frame-major: frame f, cell c at f * 2 + c.
    expect([...(await r.traces.readFrames(5, 6))]).toEqual([50, 51]);
    // The signed traces, in a file of their own with the same layout.
    expect(r.signed).not.toBeNull();
    expect([...(await r.signed!.readFrames(5, 6))]).toEqual([-950, -949]);
    expect(store.processed()).toBe(8);
  });

  it('keeps the clipped traces only when the solver returns no signed ones', async () => {
    const { store } = setup({ noSigned: true });
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    const r = store.result()!;
    expect(r.signed).toBeNull();
    expect([...(await r.traces.readFrames(5, 6))]).toEqual([50, 51]);
  });

  it('replays with the flat-field map of pass 1 (applied from frame 0), or none', async () => {
    const map: FlatFieldMap = {
      gain: new Float32Array(4).fill(1.02),
      offset: new Float32Array(0),
      dark: 1,
      binsUsed: 3,
      framesUsed: 500,
      gainSd: 0.04,
    };
    const withMap = setup({ flatMap: map });
    await withMap.store.run();
    await settle();
    const replay = withMap.started[0].replay as { flatField?: FlatFieldMap };
    expect(replay.flatField).toBe(map);
    const without = setup();
    await without.store.run();
    await settle();
    expect('flatField' in (without.started[0].replay as object)).toBe(false);
  });

  it('says why it cannot run', () => {
    expect(setup({ status: 'running' }).store.blockedReason()).toMatch(/after Discover finishes/);
    expect(setup({ status: 'idle' }).store.blockedReason()).toMatch(/after Discover finishes/);
    expect(setup({ final: false }).store.blockedReason()).toMatch(/final library/);
    expect(setup({ frames: 2 }).store.blockedReason()).toMatch(/calibration/);
  });

  it('stops with an error when the traces are for another library', async () => {
    const { store, steps } = setup();
    steps[0] = batch(0, 4, Uint32Array.of(3, 9));
    await store.run();
    await settle();
    expect(store.status()).toBe('error');
    expect(store.error()).toMatch(/final library/);
    expect(store.result()).toBeNull();
  });
});
