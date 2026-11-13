import { describe, expect, it, vi } from 'vitest';
import type { CellStore } from '../lib/cell-store.ts';
import type { PipelineClient } from '../lib/frame-client.ts';
import type { PipelineStepResult } from '../lib/pipeline-engine.ts';
import type { PipelinePlan } from '../lib/pipeline-plan.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { createRefineStore } from '../lib/refine-store.ts';
import { RunRecord } from '../lib/run-record.ts';
import { createStageLog } from '../lib/run-stages.ts';
import type { LibraryView, SlowStatus } from '../workers/slow-types.ts';

const PLAN: PipelinePlan = {
  frameCount: 12,
  batchSize: 4,
  calibrationFrames: 4,
  motionWarmupFrames: 4,
  previewMaxSide: 32,
};

function batch(start: number, count: number): PipelineStepResult {
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
  };
}

function lib(version: number, values: number[]): LibraryView {
  const n = values.length;
  return {
    version,
    frame: 0,
    width: 4,
    height: 4,
    ids: Uint32Array.from(values.map((_, i) => i + 1)),
    centers: new Float32Array(2 * n),
    radii: new Float32Array(n),
    starts: Uint32Array.from({ length: n + 1 }, (_, i) => i),
    pixels: Uint32Array.from(values.map((_, i) => i)),
    values: Float32Array.from(values),
  };
}

/**
 * A Discover run that has finished (slow loop run 1, final), and a fake
 * slow loop: it takes the forwarded batches when `consume` says so (at once
 * by default), and publishes `after` with 6 more refines at the end.
 */
function setup(opts: { lagging?: boolean } = {}) {
  const rec = new RunRecord();
  for (let t = 0; t < 12; t++) rec.push(t, [0], [0], [0], [0], [0]);
  let slow = {
    run: 1,
    final: true,
    frame: 12,
    consumed: 12,
    counters: { refines: 10 },
  } as unknown as SlowStatus;
  const before = lib(5, [1, 1, 1, 1]);
  const after = lib(9, [1, 1.2, 1, 1]);
  let current = before;
  let forwarded = 0;
  const ahead: number[] = [];
  const steps: PipelineStepResult[] = [batch(0, 4), batch(4, 4), batch(8, 4), { kind: 'done' }];
  const started: { cells: unknown; replay: unknown }[] = [];
  const stops: unknown[] = [];
  const consume = (to: number) => {
    slow = { ...slow, frame: to, consumed: to };
  };
  const client: PipelineClient = {
    async startPipeline(_o, cells, replay) {
      started.push({ cells, replay });
      // The slow worker takes the `replay` message with the first batch.
      slow = { ...slow, run: 2, final: false, frame: 0, consumed: 0, editScope: 'refine' };
      return PLAN;
    },
    async stepPipeline() {
      const s = steps.shift() ?? { kind: 'done' };
      if (s.kind === 'batch') {
        forwarded = s.start + s.count;
        ahead.push(forwarded - (slow.consumed ?? 0));
        if (!opts.lagging) consume(forwarded);
      } else if (s.kind === 'done') {
        // The slow loop publishes its final library after the end.
        setTimeout(() => {
          slow = { ...slow, final: true, counters: { ...slow.counters, refines: 16 } };
          current = after;
        }, 5);
      }
      return s;
    },
    stopPipeline: vi.fn(async (o?: { keepSlow?: boolean }) => {
      stops.push(o);
    }),
  };
  const pipeline = {
    plan: () => PLAN,
    record: () => rec,
    flatFieldMap: () => null,
  } as unknown as PipelineStore;
  const cells = {
    library: () => current,
    libraryBytes: () => Uint8Array.of(5),
    status: () => slow,
    session: () => 7,
    fps: () => 2,
    error: () => null,
  } as unknown as CellStore;
  const log = createStageLog();
  log.begin('discover');
  log.end('discover', 'done', { frames: 12, refines: 10, refinesPerMin: 100 });
  const store = createRefineStore(client, pipeline, cells, log, () => null);
  return {
    store,
    log,
    started,
    stops,
    client,
    ahead,
    consume,
    forwarded: () => forwarded,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(2);
  }
}

describe('Refine store', () => {
  it('replays the recording into the Discover slow loop and logs the run with its readout', async () => {
    const t = setup();
    await t.store.run();
    expect(t.started).toHaveLength(1);
    expect(t.started[0].cells).toMatchObject({
      session: 7,
      discover: true,
      refine: true,
      qc: false,
      library: Uint8Array.of(5),
    });
    expect((t.started[0].replay as { frameCount: number }).frameCount).toBe(12);
    await until(() => t.store.status() === 'done');
    expect(t.store.processed()).toBe(12);
    const r = t.log.last('refine')!;
    expect(r).toMatchObject({
      index: 1,
      outcome: 'done',
      frames: 12,
      cells: 4,
      libraryVersion: 9,
      refines: 6,
      footprintsRefined: 1,
      medianFootprintChange: expect.closeTo(0.2, 5),
    });
    // 6 refines over 12 frames at 2 fps = 0.1 min.
    expect(r.refinesPerMin).toBeCloseTo(60);
  });

  it('waits for the final library of its own run before it is done', async () => {
    const t = setup();
    await t.store.run();
    await until(() => t.store.status() === 'finishing');
    expect(t.log.last('refine')!.outcome).toBe('running');
    await until(() => t.store.status() === 'done');
  });

  it('never gets more than one batch ahead of the slow loop (nothing is dropped)', async () => {
    const t = setup({ lagging: true });
    await t.store.run();
    await wait(30);
    // Two batches out (the forward pool), then it waits for the slow loop.
    expect(t.forwarded()).toBe(8);
    t.consume(4);
    await until(() => t.forwarded() === 12);
    t.consume(12);
    await until(() => t.store.status() === 'done');
    expect(Math.max(...t.ahead)).toBeLessThanOrEqual(8);
  });

  it('cancels keeping the slow loop (it publishes what it refined) and logs the run', async () => {
    const t = setup({ lagging: true });
    await t.store.run();
    await wait(10);
    t.store.cancel();
    expect(t.store.status()).toBe('cancelled');
    expect(t.stops).toEqual([{ keepSlow: true }]);
    expect(t.log.last('refine')!.outcome).toBe('cancelled');
  });

  it('does not start when the stage rules say no', async () => {
    const t = setup();
    const store = createRefineStore(
      t.client,
      {} as PipelineStore,
      {} as CellStore,
      t.log,
      () => 'Extract is running.',
    );
    await store.run();
    expect(store.status()).toBe('error');
    expect(store.error()).toBe('Extract is running.');
    expect(t.started).toHaveLength(0);
  });
});
