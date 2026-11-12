import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import type { FlatFieldEvent, FlatFieldMap } from '../lib/flat-field.ts';
import { flatFieldStatusLine } from '../lib/flat-field.ts';
import type { FlatFieldCache, FlatFieldRecord } from '../lib/flat-field-cache.ts';
import type { PipelineClient } from '../lib/frame-client.ts';
import type { PipelineStepResult } from '../lib/pipeline-engine.ts';
import { makePlan } from '../lib/pipeline-plan.ts';
import { createPipelineStore } from '../lib/pipeline-store.ts';

const W = 4;
const H = 3;

function map(gain = 1.05): FlatFieldMap {
  return {
    gain: new Float32Array(W * H).fill(gain),
    offset: new Float32Array(0),
    dark: 0,
    binsUsed: 4,
    framesUsed: 3000,
    gainSd: 0.05,
  };
}

function memoryCache(initial?: FlatFieldRecord) {
  const store = new Map<string, FlatFieldRecord>();
  if (initial) store.set(initial.key, initial);
  const put = vi.fn(async (r: FlatFieldRecord) => {
    store.set(r.key, r);
  });
  const cache: FlatFieldCache = {
    get: async (key, w, h) => {
      const r = store.get(key);
      return r && r.width === w && r.height === h ? r : null;
    },
    put,
  };
  return { cache, put, store };
}

function batchStep(
  start: number,
  count: number,
  flatField?: PipelineStepResult,
): PipelineStepResult {
  const image = { width: 1, height: 1, data: new Float32Array(1) };
  const base = {
    kind: 'batch' as const,
    start,
    count,
    dy: new Float32Array(count),
    dx: new Float32Array(count),
    quality: new Float32Array(count),
    flags: new Uint32Array(count),
    flickerOffset: new Float32Array(count),
    flickerGain: new Float32Array(count),
    previews: { frame: start, raw: image, preprocessed: image, corrected: image, output: image },
    timings: { readMs: 0, preprocessMs: 0, motionMs: 0, otherMs: 0, traceMs: 0 },
  };
  return flatField && flatField.kind === 'batch'
    ? { ...base, flatField: flatField.flatField }
    : base;
}

/** A pipelined-looking client: flat-field events are pushed by the test. */
function fakeClient(steps: PipelineStepResult[]) {
  let listener: ((e: FlatFieldEvent) => void) | null = null;
  const startPipeline = vi.fn(async () => makePlan(100));
  let i = 0;
  const client: PipelineClient = {
    startPipeline: startPipeline as unknown as PipelineClient['startPipeline'],
    stepPipeline: async () => steps[i++] ?? { kind: 'done' },
    stopPipeline: async () => {},
    subscribeFlatField: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return { client, startPipeline, emit: (e: FlatFieldEvent) => listener?.(e) };
}

/** The session the store started the run with (a module counter, so it differs per test). */
function sid(start: { mock: { calls: unknown[][] } }): number {
  return (start.mock.calls.at(-1)![1] as { session: number }).session;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const identity = () => ({
  width: W,
  height: H,
  device: { serial: 'SN1' },
  folder: 'raw',
});

describe('flat field in the pipeline store', () => {
  it('starts without a stored map, tracks the estimator, and records where maps took effect', async () => {
    const applied = {
      kind: 'batch' as const,
      flatField: { frame: 16, seq: 1, source: 'estimate' as const, first: true },
    };
    const { client, startPipeline, emit } = fakeClient([
      batchStep(0, 8),
      batchStep(8, 8),
      batchStep(16, 8, applied as unknown as PipelineStepResult),
    ]);
    const { cache, store: db } = memoryCache();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client, {}, undefined, undefined, true, undefined, {
        cache,
        identity,
      });
      await store.start();
      // Flat field is on by default and no seed was passed.
      const args = startPipeline.mock.calls[0] as unknown[];
      expect((args[0] as { flatField: boolean }).flatField).toBe(true);
      expect(args[3]).toBeUndefined();
      expect(flatFieldStatusLine(store.flatField())).toBe('estimating (0 / 150 s of frames)');

      emit({ type: 'progress', session: sid(startPipeline), frames: 400, fps: 20 });
      // An event of another session is ignored.
      emit({ type: 'progress', session: 99, frames: 1, fps: 20 });
      expect(flatFieldStatusLine(store.flatField())).toBe('estimating (20 / 150 s of frames)');
      emit({
        type: 'map',
        session: sid(startPipeline),
        seq: 1,
        map: map(),
        change: { median: 0.84, p99: 3.9, max: 6 },
      });
      expect(flatFieldStatusLine(store.flatField())).toBe(
        'estimated (4 shift bins, 3000 frames, gain SD 5.0%)',
      );
      expect(store.flatField().lastChange?.p99).toBe(3.9);
      expect(store.flatFieldMap()?.gain[0]).toBeCloseTo(1.05);
      emit({
        type: 'skipped',
        session: sid(startPipeline),
        message: 'too little motion: 1 shift bins',
      });
      expect(flatFieldStatusLine(store.flatField())).toContain('skipped: too little motion');

      await flush();
      await flush();
      // The batch where the first map took effect is in the run record and the status.
      expect(store.record().flatFieldApplied).toEqual([applied.flatField]);
      expect(store.flatField().firstFrame).toBe(16);
      // The run ended: the newest map was written to the cache once.
      expect(store.status()).toBe('done');
      expect(db.size).toBe(1);
      const rec = [...db.values()][0];
      expect(rec.key).toBe('device:SN1|4x3');
      expect(rec.gain[0]).toBeCloseTo(1.05);
      dispose();
    });
  });

  it('seeds the run from a stored map of the same device and frame size', async () => {
    const stored: FlatFieldRecord = {
      key: 'device:SN1|4x3',
      keySource: 'device',
      width: W,
      height: H,
      gain: new Float32Array(W * H).fill(0.97),
      offset: new Float32Array(0),
      dark: 2,
      framesUsed: 9000,
      binsUsed: 6,
      gainSd: 0.04,
      updatedAt: 1,
    };
    const { client, startPipeline, emit } = fakeClient([]);
    const { cache } = memoryCache(stored);
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client, {}, undefined, undefined, true, undefined, {
        cache,
        identity,
      });
      await store.start();
      const seed = (startPipeline.mock.calls[0] as unknown[])[3] as { seed: FlatFieldMap };
      expect(seed.seed.gain[0]).toBeCloseTo(0.97);
      expect(seed.seed.dark).toBe(2);
      expect(flatFieldStatusLine(store.flatField())).toBe(
        'reused from this browser (device key device:SN1|4x3)',
      );
      // Pass 2 would get this map even before the estimator produced one.
      expect(store.flatFieldMap()?.gain[0]).toBeCloseTo(0.97);
      emit({ type: 'map', session: sid(startPipeline), seq: 1, map: map(), change: null });
      expect(flatFieldStatusLine(store.flatField())).toContain('reused + refined');
      dispose();
    });
  });

  it('does not reuse a map of another frame size', async () => {
    const stored: FlatFieldRecord = {
      key: 'device:SN1|4x3',
      keySource: 'device',
      width: 8,
      height: 6,
      gain: new Float32Array(48).fill(1),
      offset: new Float32Array(0),
      dark: 0,
      framesUsed: 1,
      binsUsed: 1,
      gainSd: 0,
      updatedAt: 1,
    };
    const { client, startPipeline } = fakeClient([]);
    const { cache } = memoryCache(stored);
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client, {}, undefined, undefined, true, undefined, {
        cache,
        identity,
      });
      await store.start();
      expect((startPipeline.mock.calls[0] as unknown[])[3]).toBeUndefined();
      dispose();
    });
  });

  it('throttles cache writes to one per interval and writes the rest at the end', async () => {
    let t = 0;
    const { client, startPipeline, emit } = fakeClient([batchStep(0, 8)]);
    const { cache, put } = memoryCache();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client, {}, undefined, undefined, true, undefined, {
        cache,
        identity,
        writeIntervalMs: 60_000,
        now: () => t,
      });
      await store.start();
      t = 100_000;
      emit({ type: 'map', session: sid(startPipeline), seq: 1, map: map(1.01), change: null });
      expect(put).toHaveBeenCalledTimes(1);
      t = 130_000;
      emit({ type: 'map', session: sid(startPipeline), seq: 2, map: map(1.02), change: null });
      t = 140_000;
      emit({ type: 'map', session: sid(startPipeline), seq: 3, map: map(1.03), change: null });
      // Within a minute of the last write: held back.
      expect(put).toHaveBeenCalledTimes(1);
      store.flushFlatField();
      expect(put).toHaveBeenCalledTimes(2);
      expect((put.mock.calls[1][0] as FlatFieldRecord).gain[0]).toBeCloseTo(1.03);
      dispose();
    });
  });

  it('turned off: the run starts with flatField false and no seed, status is off', async () => {
    const { client, startPipeline } = fakeClient([]);
    const { cache } = memoryCache();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client, {}, undefined, undefined, true, undefined, {
        cache,
        identity,
      });
      store.setFlatEnabled(false);
      await store.start();
      const args = startPipeline.mock.calls[0] as unknown[];
      expect((args[0] as { flatField: boolean }).flatField).toBe(false);
      expect(args[3]).toBeUndefined();
      expect(flatFieldStatusLine(store.flatField())).toBe('off');
      dispose();
    });
  });

  it('works without a cache or an estimator (single-worker client)', async () => {
    const client: PipelineClient = {
      startPipeline: async () => makePlan(100),
      stepPipeline: async () => ({ kind: 'done' }),
      stopPipeline: async () => {},
    };
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      expect(store.flatField().supported).toBe(false);
      expect(flatFieldStatusLine(store.flatField())).toMatch(/^off/);
      expect(store.flatFieldMap()).toBeNull();
      dispose();
    });
  });
});
