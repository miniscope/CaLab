import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { createFrameClient, type WorkerLike } from '../lib/frame-client.ts';
import { MAX_FRAMES_PER_READ } from '../lib/frame-source.ts';
import type { PipelineStepResult } from '../lib/pipeline-engine.ts';
import { makePlan, PipelineCursor, type PipelineStep } from '../lib/pipeline-plan.ts';
import {
  createPipelineStore,
  MAX_IN_FLIGHT,
  ShiftTrace,
  ThroughputMeter,
} from '../lib/pipeline-store.ts';
import { downsampleFrame, previewFactor } from '../lib/preview.ts';
import type { FrameRequest, FrameResponse } from '../workers/frame-types.ts';

function walk(cursor: PipelineCursor): PipelineStep[] {
  const steps: PipelineStep[] = [];
  for (let s = cursor.next(); s; s = cursor.next()) steps.push(s);
  return steps;
}

describe('pipeline plan', () => {
  it('clamps the warm-ups to the recording and the batch to one read', () => {
    const p = makePlan(50, { batchSize: 1000 });
    expect(p.calibrationFrames).toBe(50);
    expect(p.motionWarmupFrames).toBe(50);
    expect(p.batchSize).toBe(MAX_FRAMES_PER_READ);
    expect(() => makePlan(0)).toThrow(RangeError);
    expect(() => makePlan(10, { batchSize: 0 })).toThrow(RangeError);
  });

  it('walks calibrate, motion warm-up, then every frame in batches', () => {
    const plan = makePlan(150, { calibrationFrames: 130, motionWarmupFrames: 20, batchSize: 64 });
    const cursor = new PipelineCursor(plan);
    const steps = walk(cursor);
    expect(steps).toEqual([
      { phase: 'calibrate', start: 0, count: 64, last: false },
      { phase: 'calibrate', start: 64, count: 64, last: false },
      { phase: 'calibrate', start: 128, count: 2, last: true },
      { phase: 'motion-warmup', start: 0, count: 20, last: true },
      { phase: 'process', start: 0, count: 64, last: false },
      { phase: 'process', start: 64, count: 64, last: false },
      { phase: 'process', start: 128, count: 22, last: true },
    ]);
    expect(cursor.done).toBe(true);
    expect(cursor.next()).toBeNull();
  });

  it('processes each frame exactly once, in order, never more than a batch at a time', () => {
    const plan = makePlan(1001, { batchSize: 7 });
    const process = walk(new PipelineCursor(plan)).filter((s) => s.phase === 'process');
    let next = 0;
    for (const s of process) {
      expect(s.start).toBe(next);
      expect(s.count).toBeLessThanOrEqual(7);
      next += s.count;
    }
    expect(next).toBe(1001);
    expect(process.filter((s) => s.last)).toHaveLength(1);
  });
});

describe('preview downsampling', () => {
  it('picks the smallest integer factor that fits', () => {
    expect(previewFactor(600, 600, 320)).toBe(2);
    expect(previewFactor(100, 50, 320)).toBe(1);
    expect(previewFactor(641, 10, 320)).toBe(3);
  });

  it('box-averages one frame of a batch, with partial edge blocks', () => {
    // Two 3x2 frames; take the second.
    const batch = new Float32Array([0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
    const img = downsampleFrame(batch, 1, 3, 2, 2);
    expect(img.width).toBe(2);
    expect(img.height).toBe(1);
    expect(Array.from(img.data)).toEqual([(1 + 2 + 4 + 5) / 4, (3 + 6) / 2]);
  });

  it('skips non-finite pixels', () => {
    const img = downsampleFrame(new Float32Array([NaN, 2, Infinity, 4]), 0, 2, 2, 2);
    expect(Array.from(img.data)).toEqual([3]);
  });
});

describe('shift trace and throughput', () => {
  it('appends shifts at their frame indices', () => {
    const t = new ShiftTrace();
    t.push(10, [1, 2], [3, 4]);
    expect(t.frame).toEqual([10, 11]);
    expect(t.dy).toEqual([1, 2]);
    expect(t.dx).toEqual([3, 4]);
  });

  it('measures frames per second over a sliding window', () => {
    const m = new ThroughputMeter(1000);
    expect(m.record(0, 8)).toBe(0);
    expect(m.record(500, 8)).toBe(16);
    expect(m.record(1000, 8)).toBe(16);
    // The window drops the events older than 1000 ms: 8 frames over 1000 ms.
    expect(m.record(2000, 8)).toBeCloseTo(8);
  });
});

type Deferred = { resolve: (r: PipelineStepResult) => void; reject: (e: Error) => void };

/** A pipeline client whose steps resolve only when the test says so. */
function manualClient() {
  const steps: Deferred[] = [];
  return {
    steps,
    client: {
      startPipeline: vi.fn(async () => makePlan(100)),
      stepPipeline: vi.fn(
        () => new Promise<PipelineStepResult>((resolve, reject) => steps.push({ resolve, reject })),
      ),
      stopPipeline: vi.fn(async () => {}),
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function batch(start: number, count: number): PipelineStepResult {
  const image = { width: 1, height: 1, data: new Float32Array(1) };
  return {
    kind: 'batch',
    start,
    count,
    dy: new Float32Array(count).fill(1),
    dx: new Float32Array(count).fill(-2),
    quality: new Float32Array(count),
    flags: new Uint32Array(count),
    previews: { frame: start, raw: image, preprocessed: image, corrected: image, output: image },
    timings: { readMs: count, preprocessMs: 2 * count, motionMs: 3 * count, otherMs: 0 },
  };
}

describe('pipeline store backpressure', () => {
  it('keeps at most MAX_IN_FLIGHT steps outstanding and refills as they finish', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      expect(store.status()).toBe('running');
      expect(client.stepPipeline).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
      await flush();
      expect(client.stepPipeline).toHaveBeenCalledTimes(MAX_IN_FLIGHT);

      steps[0].resolve(batch(0, 8));
      await flush();
      expect(client.stepPipeline).toHaveBeenCalledTimes(MAX_IN_FLIGHT + 1);
      expect(store.inFlight()).toBe(MAX_IN_FLIGHT);
      expect(store.processed()).toBe(8);
      expect(store.trace().dx).toEqual(new Array(8).fill(-2));
      expect(store.stageMs().motionMs).toBe(3);
      dispose();
    });
  });

  it('stops requesting while paused and resumes', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      store.pause();
      steps[0].resolve(batch(0, 8));
      steps[1].resolve(batch(8, 8));
      await flush();
      // Answers to steps already sent still count, but nothing new is asked.
      expect(store.processed()).toBe(16);
      expect(client.stepPipeline).toHaveBeenCalledTimes(2);
      expect(store.inFlight()).toBe(0);
      store.resume();
      expect(client.stepPipeline).toHaveBeenCalledTimes(2 + MAX_IN_FLIGHT);
      dispose();
    });
  });

  it('finishes on done and stops asking', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      steps[0].resolve({ kind: 'done' });
      steps[1].resolve({ kind: 'done' });
      await flush();
      expect(store.status()).toBe('done');
      expect(client.stepPipeline).toHaveBeenCalledTimes(2);
      dispose();
    });
  });

  it('reports a worker error and drops answers from a stopped run', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      steps[0].reject(new Error('boom'));
      await flush();
      expect(store.status()).toBe('error');
      expect(store.error()).toBe('boom');

      store.stop();
      expect(client.stopPipeline).toHaveBeenCalledTimes(1);
      steps[1].resolve(batch(0, 8));
      await flush();
      expect(store.processed()).toBe(0);
      expect(store.status()).toBe('idle');
      dispose();
    });
  });
});

/** A fake worker that answers each request through `reply`. */
function fakeWorker(reply: (req: FrameRequest) => FrameResponse) {
  const sent: FrameRequest[] = [];
  const worker: WorkerLike & { emit(msg: FrameResponse): void } = {
    onmessage: null,
    onerror: null,
    postMessage(msg: FrameRequest) {
      sent.push(msg);
      queueMicrotask(() => worker.emit(reply(msg)));
    },
    terminate: vi.fn(),
    emit(msg) {
      worker.onmessage?.call(worker as unknown as Worker, { data: msg } as MessageEvent);
    },
  };
  return { worker, sent };
}

describe('pipeline message protocol', () => {
  it('pairs start/step/stop requests with their responses by id', async () => {
    const plan = makePlan(10);
    const { worker, sent } = fakeWorker((req) => {
      switch (req.type) {
        case 'pipeline-start':
          return { type: 'pipeline-ready', id: req.id, plan };
        case 'pipeline-step':
          return { type: 'pipeline-step', id: req.id, step: { kind: 'done' } };
        case 'pipeline-stop':
          return { type: 'pipeline-stopped', id: req.id };
        default:
          return { type: 'error', id: req.id, message: 'unexpected' };
      }
    });
    const client = createFrameClient(() => worker);
    expect(await client.startPipeline({ batchSize: 4 })).toEqual(plan);
    expect(await client.stepPipeline()).toEqual({ kind: 'done' });
    await client.stopPipeline();
    expect(sent.map((r) => r.type)).toEqual(['pipeline-start', 'pipeline-step', 'pipeline-stop']);
    expect(sent[0]).toMatchObject({ options: { batchSize: 4 } });
    expect(new Set(sent.map((r) => r.id)).size).toBe(3);
  });

  it('rejects on a worker error or a mismatched response', async () => {
    const { worker } = fakeWorker((req) =>
      req.type === 'pipeline-step'
        ? { type: 'error', id: req.id, message: 'The pipeline is not running.' }
        : { type: 'pipeline-stopped', id: req.id },
    );
    const client = createFrameClient(() => worker);
    await expect(client.stepPipeline()).rejects.toThrow('not running');
    await expect(client.startPipeline()).rejects.toThrow('Unexpected worker response');
  });
});
