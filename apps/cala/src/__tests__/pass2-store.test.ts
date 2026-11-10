import { describe, expect, it } from 'vitest';
import type { CellStore } from '../lib/cell-store.ts';
import type { PipelineClient } from '../lib/frame-client.ts';
import type { PipelineStepResult } from '../lib/pipeline-engine.ts';
import type { PipelinePlan } from '../lib/pipeline-plan.ts';
import { createPass2Store } from '../lib/pass2-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { RunRecord } from '../lib/run-record.ts';
import type { LibraryView } from '../workers/slow-types.ts';

const PLAN: PipelinePlan = {
  frameCount: 100,
  batchSize: 4,
  calibrationFrames: 4,
  motionWarmupFrames: 4,
  previewMaxSide: 32,
};
const IDS = Uint32Array.of(3, 8);

function batch(start: number, count: number, ids = IDS): PipelineStepResult {
  const traces = new Float32Array(count * ids.length);
  for (let f = 0; f < count; f++)
    for (let c = 0; c < ids.length; c++) traces[f * ids.length + c] = 10 * (start + f) + c;
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

function setup(opts: { final?: boolean; frames?: number; status?: string } = {}) {
  const rec = new RunRecord();
  const frames = opts.frames ?? 8;
  for (let t = 0; t < frames; t++) rec.push(t, [t], [-t], [0], [0.5], [0.01]);
  const started: { options: unknown; cells: unknown; replay: unknown }[] = [];
  const steps: PipelineStepResult[] = [batch(0, 4), batch(4, 4), { kind: 'done' }];
  const client: PipelineClient = {
    async startPipeline(options, cells, replay) {
      started.push({ options, cells, replay });
      return PLAN;
    },
    async stepPipeline() {
      return steps.shift() ?? { kind: 'done' };
    },
    async stopPipeline() {},
  };
  const view = { version: 5, ids: IDS, centers: new Float32Array(4) } as unknown as LibraryView;
  const pipeline = {
    status: () => opts.status ?? 'done',
    record: () => rec,
    plan: () => PLAN,
  } as unknown as PipelineStore;
  const cells = {
    library: () => view,
    libraryBytes: () => Uint8Array.of(1, 2, 3),
    status: () => ({ final: opts.final ?? true }),
  } as unknown as CellStore;
  return { store: createPass2Store(client, pipeline, cells), started, steps };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('pass 2 store', () => {
  it('replays the recorded frames with the final library and gathers the traces', async () => {
    const { store, started } = setup();
    expect(store.blockedReason()).toBeNull();
    await store.run();
    await settle();
    expect(store.status()).toBe('done');
    expect(started).toHaveLength(1);
    expect(started[0].cells).toMatchObject({ discover: false, qc: false });
    expect(started[0].options).toMatchObject({ batchSize: 4, calibrationFrames: 4 });
    const replay = started[0].replay as { frameCount: number; dx: Float32Array };
    expect(replay.frameCount).toBe(8);
    expect(replay.dx[3]).toBe(-3);
    const r = store.result()!;
    expect(r.frames).toBe(8);
    expect(r.cells).toBe(2);
    // Frame-major: frame f, cell c at f * 2 + c.
    expect([...(await r.traces.readFrames(5, 6))]).toEqual([50, 51]);
    expect(store.processed()).toBe(8);
  });

  it('says why it cannot run', () => {
    expect(setup({ status: 'running' }).store.blockedReason()).toMatch(/still running/);
    expect(setup({ status: 'idle' }).store.blockedReason()).toMatch(/Run pass 1/);
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
