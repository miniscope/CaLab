// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCalaWasm } from '../lib/cala-wasm.ts';
import {
  flatFieldChangeLine,
  flatFieldKey,
  flatFieldStatusLine,
  gainToGray8,
  initialFlatFieldState,
  type FlatFieldApplied,
  type FlatFieldEvent,
  type FlatFieldMap,
} from '../lib/flat-field.ts';
import {
  createIndexedDbFlatFieldCache,
  mapFromRecord,
  mapIsValid,
  recordFits,
  recordFromMap,
} from '../lib/flat-field-cache.ts';
import {
  FlatFieldRunner,
  type FlatFieldBatch,
  type FlatFieldSink,
  type FlatFieldStart,
} from '../lib/flat-field-runner.ts';
import type { FramePixels } from '../lib/frame-source.ts';
import { parseDeviceIdentity } from '../lib/miniscope-meta.ts';
import type { FrameReader } from '../lib/pipeline-engine.ts';
import {
  FrontStage,
  MotionStage,
  type FlatFieldRun,
  type ReplayInput,
} from '../lib/pipeline-stages.ts';
import { RunRecord } from '../lib/run-record.ts';
import { StagePool } from '../lib/stage-pool.ts';

beforeAll(async () => {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
});

const W = 64;
const H = 48;
const PX = W * H;
const OPTIONS = { calibrationFrames: 20, motionWarmupFrames: 20, batchSize: 8, previewMaxSide: 32 };
const FRAMES = 70;

/** A textured scene panned over a lit disc: shifts change at frame 30. */
function makeMovie(frames: number, gain?: Float32Array): FrameReader {
  let seed = 5;
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
      const dst = (out as Uint8Array | undefined) ?? new Uint8Array(count * PX);
      for (let i = 0; i < count; i++) {
        const f = start + i;
        const sy = f < 30 ? 0 : 2;
        const sx = f < 30 ? 0 : -3;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const lit = (y - H / 2) ** 2 + (x - W / 2) ** 2 < (0.48 * W) ** 2;
            let v = 110;
            for (const b of blobs) {
              const d2 = (y - sy - b.y) ** 2 + (x - sx - b.x) ** 2;
              if (d2 < 40) v += b.a * Math.exp(-d2 / 6);
            }
            const g = gain ? gain[y * W + x] : 1;
            dst[i * PX + y * W + x] = lit ? Math.min(255, Math.round(g * v)) : 3;
          }
        }
      }
      return dst;
    },
  };
}

/** A map that scales the left half of the frame down by 8%. */
function halfMap(): FlatFieldMap {
  const gain = new Float32Array(PX).fill(1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) gain[y * W + x] = 1.08;
  return { gain, offset: new Float32Array(0), dark: 0, binsUsed: 2, framesUsed: 100, gainSd: 0.04 };
}

/** A sink that records what stage A hands it (a stand-in for the estimator worker). */
class RecordingSink implements FlatFieldSink {
  started: FlatFieldStart[] = [];
  batches: FlatFieldBatch[] = [];
  stopped = 0;
  accept = true;
  start(msg: FlatFieldStart) {
    this.started.push(msg);
  }
  ready() {
    return this.accept;
  }
  push(msg: FlatFieldBatch) {
    this.batches.push(msg);
  }
  stop() {
    this.stopped++;
  }
}

interface ChainResult {
  /** Preprocessed front-half output of every process batch. */
  fronts: Float32Array[];
  events: (FlatFieldApplied | undefined)[];
  dy: Float32Array[];
  dx: Float32Array[];
  flicker: { offset: Float32Array[]; gain: Float32Array[]; flags: Uint32Array[] };
  frameStarts: number[];
}

/**
 * Stages A and B chained in-process (no transport), as the workers run them:
 * after B finds a batch's shifts they go back to A (`onShifts`). `afterBatch`:
 * an estimator map offered to A after that many process batches.
 */
async function chain(args: {
  flat?: FlatFieldRun;
  replay?: ReplayInput;
  options?: typeof OPTIONS & { flatField?: boolean };
  frames?: number;
  afterBatch?: { n: number; seq: number; map: FlatFieldMap };
  movie?: FrameReader;
}): Promise<ChainResult> {
  const len = OPTIONS.batchSize * PX;
  const frontPool = new StagePool(3, len);
  const outPool = new StagePool(3, len);
  const a = new FrontStage(
    args.movie ?? makeMovie(args.frames ?? FRAMES),
    args.options ?? OPTIONS,
    () => frontPool.acquire(),
    undefined,
    args.replay,
    args.flat,
  );
  const b = new MotionStage(a.setup, () => outPool.acquire());
  const out: ChainResult = {
    fronts: [],
    events: [],
    dy: [],
    dx: [],
    flicker: { offset: [], gain: [], flags: [] },
    frameStarts: [],
  };
  let processed = 0;
  for (;;) {
    const job = await a.next();
    if (!job) break;
    if (job.step.phase === 'process') {
      out.fronts.push(job.front!.slice(0, job.step.count * PX));
      out.events.push(job.flatField);
      out.frameStarts.push(job.step.start);
    }
    const done = await b.handle(job);
    if (done.step.phase === 'process') {
      out.dy.push(done.dy!.slice());
      out.dx.push(done.dx!.slice());
      out.flicker.offset.push(done.flickerOffset!.slice());
      out.flicker.gain.push(done.flickerGain!.slice());
      out.flicker.flags.push(done.flags!.slice());
      a.onShifts(done.step.start, done.dy!, done.dx!);
      processed++;
      if (args.afterBatch && processed === args.afterBatch.n) {
        a.offerFlatField(args.afterBatch.seq, args.afterBatch.map);
      }
    }
    if (done.front) frontPool.release(done.front);
    if (done.corrected) outPool.release(done.corrected);
  }
  a.dispose();
  b.dispose();
  return out;
}

const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);

describe('flat field in the stages', () => {
  it('sends the raw batches and the shifts stage B found to the estimator sink', async () => {
    const sink = new RecordingSink();
    const r = await chain({ flat: { sink, session: 7 } });
    expect(sink.started).toHaveLength(1);
    expect(sink.started[0]).toMatchObject({ session: 7, width: W, height: H, sixteen: false });
    expect(sink.started[0].fovMask.length).toBe(PX);
    expect(sink.stopped).toBe(1);
    // Every process batch arrived once, with B's shifts and the raw frames of that batch.
    const starts = sink.batches.map((b) => b.start);
    expect(starts).toEqual(r.frameStarts);
    const movie = makeMovie(FRAMES);
    for (let i = 0; i < sink.batches.length; i++) {
      const b = sink.batches[i];
      expect(b.session).toBe(7);
      expect(Array.from(b.dy)).toEqual(Array.from(r.dy[i]));
      expect(Array.from(b.dx)).toEqual(Array.from(r.dx[i]));
      const raw = (await movie.readFrames(b.start, b.count)) as Uint8Array;
      expect(Buffer.compare(Buffer.from(b.raw as Uint8Array), Buffer.from(raw))).toBe(0);
    }
    // The registration really moved at frame 30: the shifts are not all zero.
    expect(r.dy.some((d) => d.some((v) => Math.abs(v) > 0.5))).toBe(true);
  });

  it('drops frames for a sink that has fallen behind and never blocks', async () => {
    const sink = new RecordingSink();
    sink.accept = false;
    const r = await chain({ flat: { sink } });
    expect(sink.batches).toHaveLength(0);
    expect(r.fronts.length).toBeGreaterThan(0);
  });

  it('applies a map that arrives mid-run at the next batch boundary, never mid-batch', async () => {
    const plain = await chain({});
    const map = halfMap();
    const sink = new RecordingSink();
    const run = await chain({ flat: { sink }, afterBatch: { n: 3, seq: 1, map } });
    // Batches 0..3 were processed before the offer took effect (offer after batch 3 finished: next is 3).
    expect(run.events.slice(0, 3).every((e) => e === undefined)).toBe(true);
    expect(run.events[3]).toEqual({ frame: 24, seq: 1, source: 'estimate', first: true });
    expect(run.events.slice(4).every((e) => e === undefined)).toBe(true);
    for (let i = 0; i < 3; i++) expect(run.fronts[i]).toEqual(plain.fronts[i]);
    for (let i = 3; i < run.fronts.length; i++) {
      expect(sum(run.fronts[i])).not.toBe(sum(plain.fronts[i]));
    }
    // Motion and flicker bookkeeping are unchanged in shape (same frames, same batches).
    expect(run.frameStarts).toEqual(plain.frameStarts);
  });

  it('a second map is applied the same way and is not a first switch', async () => {
    const sink = new RecordingSink();
    const len = OPTIONS.batchSize * PX;
    const pool = new StagePool(3, len);
    const a = new FrontStage(
      makeMovie(FRAMES),
      OPTIONS,
      () => pool.acquire(),
      undefined,
      undefined,
      {
        sink,
      },
    );
    const events: (FlatFieldApplied | undefined)[] = [];
    let n = 0;
    for (;;) {
      const job = await a.next();
      if (!job) break;
      if (job.step.phase === 'process') {
        events.push(job.flatField);
        n++;
        if (n === 1) a.offerFlatField(1, halfMap());
        if (n === 4) a.offerFlatField(2, halfMap());
      }
      if (job.front) pool.release(job.front);
    }
    a.dispose();
    expect(events.filter(Boolean)).toEqual([
      { frame: 8, seq: 1, source: 'estimate', first: true },
      { frame: 32, seq: 2, source: 'estimate', first: false },
    ]);
  });

  it('flatField: false ignores the sink, a stored map and offers', async () => {
    const sink = new RecordingSink();
    const off = { ...OPTIONS, flatField: false };
    const plain = await chain({});
    const run = await chain({
      options: off,
      flat: { sink, initial: halfMap() },
      afterBatch: { n: 2, seq: 1, map: halfMap() },
    });
    expect(sink.started).toHaveLength(0);
    expect(sink.batches).toHaveLength(0);
    expect(run.events.every((e) => e === undefined)).toBe(true);
    expect(run.fronts).toEqual(plain.fronts);
  });

  it('a stored map is in force from the first processed frame, before the motion warm-up', async () => {
    const plain = await chain({});
    const sink = new RecordingSink();
    const run = await chain({ flat: { sink, initial: halfMap(), session: 3 } });
    expect(run.events[0]).toEqual({ frame: 0, seq: 0, source: 'cache', first: true });
    expect(run.events.slice(1).every((e) => e === undefined)).toBe(true);
    // The estimator is seeded with the same map.
    expect(sink.started[0].seed?.gain[0]).toBeCloseTo(1.08);
    // Corrected from the first batch on.
    for (let i = 0; i < run.fronts.length; i++) {
      expect(sum(run.fronts[i])).not.toBe(sum(plain.fronts[i]));
    }
    // The motion template was built on corrected frames, so the registration differs from
    // the uncorrected run only by rounding, not by a systematic shift of the scene.
    for (let i = 0; i < run.dy.length; i++) {
      for (let k = 0; k < run.dy[i].length; k++)
        expect(Math.abs(run.dy[i][k] - plain.dy[i][k])).toBeLessThan(0.75);
    }
  });

  it('pass 2 applies the pass-1 map from frame 0 and estimates nothing', async () => {
    const pass1 = await chain({});
    const rec = new RunRecord();
    for (let i = 0; i < pass1.dy.length; i++)
      rec.push(
        pass1.frameStarts[i],
        pass1.dy[i],
        pass1.dx[i],
        pass1.flicker.flags[i],
        pass1.flicker.offset[i],
        pass1.flicker.gain[i],
      );
    const span = rec.snapshot();
    const replay: ReplayInput = { frameCount: FRAMES, ...span };
    const plain = await chain({ replay });
    const sink = new RecordingSink();
    const withMap = await chain({
      replay: { ...replay, flatField: halfMap() },
      flat: { sink },
    });
    expect(withMap.events[0]).toEqual({ frame: 0, seq: 0, source: 'replay', first: true });
    expect(withMap.events.slice(1).every((e) => e === undefined)).toBe(true);
    expect(sink.started).toHaveLength(0);
    expect(sink.batches).toHaveLength(0);
    for (let i = 0; i < withMap.fronts.length; i++) {
      expect(sum(withMap.fronts[i])).not.toBe(sum(plain.fronts[i]));
    }
    // The recorded shifts replay unchanged.
    expect(withMap.dy).toEqual(plain.dy);
    // An identity map (gain 1, no offset, no dark) is a no-op.
    const identity: FlatFieldMap = {
      gain: new Float32Array(PX).fill(1),
      offset: new Float32Array(0),
      dark: 0,
      binsUsed: 0,
      framesUsed: 0,
      gainSd: 0,
    };
    const ident = await chain({ replay: { ...replay, flatField: identity } });
    expect(ident.fronts).toEqual(plain.fronts);
  });
});

describe('flat-field runner (the estimator driver)', () => {
  it('estimates a map from dithered frames and delivers it to both sides', async () => {
    // A fixed 6% left-right gain ramp on a scene that moves: the dither lets the estimator see it.
    const gain = new Float32Array(PX);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) gain[y * W + x] = 0.94 + 0.12 * (x / (W - 1));
    const events: FlatFieldEvent[] = [];
    const delivered: { session: number; seq: number; map: FlatFieldMap }[] = [];
    const runner = new FlatFieldRunner(
      (e) => events.push(e),
      (session, seq, map) => delivered.push({ session, seq, map }),
    );
    const fov = new Uint8Array(PX).fill(1);
    runner.start({
      session: 9,
      width: W,
      height: H,
      fovMask: fov,
      fps: 20,
      sixteen: false,
      firstS: 20,
      refineS: 10,
    });
    // Frames of a scene panned over four positions, 20 frames each.
    const positions: [number, number][] = [
      [0, 0],
      [3, -2],
      [-2, 3],
      [2, 2],
    ];
    const movieAt = (sy: number, sx: number): Uint8Array => {
      const out = new Uint8Array(PX);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const yy = y - sy;
          const xx = x - sx;
          const tissue = 100 + 50 * Math.sin(yy / 3.1) * Math.cos(xx / 2.3);
          out[y * W + x] = Math.round(gain[y * W + x] * tissue);
        }
      return out;
    };
    for (let rep = 0; rep < 12; rep++) {
      positions.forEach(([sy, sx], pi) => {
        const raw = new Uint8Array(8 * PX);
        const one = movieAt(sy, sx);
        for (let k = 0; k < 8; k++) raw.set(one, k * PX);
        for (let b = 0; b < 3; b++) {
          runner.push({
            session: 9,
            start: (rep * 4 + pi) * 24 + b * 8,
            count: 8,
            raw: raw.slice(),
            dy: new Float32Array(8).fill(sy),
            dx: new Float32Array(8).fill(sx),
          });
        }
      });
    }
    // A stale session is ignored.
    runner.push({
      session: 1,
      start: 0,
      count: 8,
      raw: new Uint8Array(8 * PX),
      dy: new Float32Array(8),
      dx: new Float32Array(8),
    });
    runner.stop();
    expect(events.some((e) => e.type === 'progress')).toBe(true);
    const maps = events.filter((e) => e.type === 'map');
    expect(maps.length).toBeGreaterThan(0);
    expect(delivered.length).toBe(maps.length);
    const m = maps[0];
    if (m.type !== 'map') throw new Error('unreachable');
    expect(m.session).toBe(9);
    expect(m.map.gain.length).toBe(PX);
    expect(delivered[0].session).toBe(9);
    // The two sides got separate copies.
    expect(delivered[0].map.gain).not.toBe(m.map.gain);
    expect(delivered[0].map.gain).toEqual(m.map.gain);
    expect(m.change).not.toBeNull();
  });
});

describe('device identity and cache key', () => {
  const dims = { width: 600, height: 600 };

  it('prefers a device serial, then a live name, then the recording folder', () => {
    const device = flatFieldKey({
      ...dims,
      device: { serial: ' SN-123 ', deviceType: 'Miniscope_V4_BNO', deviceId: '1' },
      folder: 'raw',
    });
    expect(device).toMatchObject({ key: 'device:SN-123|600x600', source: 'device' });
    const live = flatFieldKey({ ...dims, liveName: 'scope-A', folder: '' });
    expect(live).toMatchObject({ key: 'live:scope-A|600x600', source: 'live-name' });
    const folder = flatFieldKey({
      ...dims,
      device: { deviceType: 'Miniscope_V4_BNO', deviceId: '1' },
      folder: 'raw',
    });
    // deviceID is the camera index, not a sensor identity: no device key without a serial.
    expect(folder).toMatchObject({ key: 'folder:raw|Miniscope_V4_BNO|600x600', source: 'folder' });
    expect(folder.description).toContain('no device serial');
  });

  it('keeps live sources in their own namespace', () => {
    const live = flatFieldKey({
      ...dims,
      live: true,
      device: { serial: 'SN-1' },
      folder: '',
    });
    expect(live).toMatchObject({ key: 'live-device:SN-1|600x600', source: 'live-device' });
    const file = flatFieldKey({ ...dims, device: { serial: 'SN-1' }, folder: 'f' });
    expect(live.key).not.toBe(file.key);
    const named = flatFieldKey({ ...dims, live: true, liveName: 'SN-1', folder: '' });
    expect(named.key.startsWith('live:')).toBe(true);
  });

  it('puts the frame size in every key', () => {
    const a = flatFieldKey({ width: 600, height: 600, device: { serial: 'X' }, folder: 'f' });
    const b = flatFieldKey({ width: 608, height: 600, device: { serial: 'X' }, folder: 'f' });
    expect(a.key).not.toBe(b.key);
  });

  it('reads the workshop recording metadata as folder-keyed (no serial)', () => {
    const id = parseDeviceIdentity(
      JSON.stringify({
        ROI: { height: 600, leftEdge: 0, topEdge: 0, width: 600 },
        deviceID: 1,
        deviceName: 'miniscopeDeviceName',
        deviceType: 'Miniscope_V4_BNO',
        frameRate: '20FPS',
      }),
    );
    expect(id).toEqual({
      deviceType: 'Miniscope_V4_BNO',
      deviceName: 'miniscopeDeviceName',
      deviceId: '1',
    });
    expect(flatFieldKey({ ...dims, device: id ?? undefined, folder: 'raw' }).source).toBe('folder');
    expect(parseDeviceIdentity('{"serialNumber":"A1B2","deviceType":"V4"}')?.serial).toBe('A1B2');
    expect(parseDeviceIdentity('nope')).toBeNull();
    expect(parseDeviceIdentity('{"frameRate":"20FPS"}')).toBeNull();
  });
});

describe('flat-field cache', () => {
  it('matches a record only for the same frame size', () => {
    const key = flatFieldKey({ width: W, height: H, device: { serial: 'S' }, folder: 'f' });
    const rec = recordFromMap(key, W, H, halfMap(), 123);
    expect(recordFits(rec, W, H)).toBe(true);
    expect(recordFits(rec, H, W)).toBe(false);
    expect(recordFits(rec, W + 1, H)).toBe(false);
    expect(recordFits(null, W, H)).toBe(false);
    expect(mapFromRecord(rec).gain).toBe(rec.gain);
  });

  it('rejects implausible, non-finite or mis-sized maps whole, on read and on write', async () => {
    const key = flatFieldKey({ width: W, height: H, device: { serial: 'S' }, folder: 'f' });
    const good = recordFromMap(key, W, H, halfMap(), 1);
    expect(recordFits(good, W, H)).toBe(true);
    const bad = (patch: (m: FlatFieldMap) => void) => {
      const m = halfMap();
      patch(m);
      return recordFromMap(key, W, H, m, 1);
    };
    expect(
      recordFits(
        bad((m) => (m.gain[5] = NaN)),
        W,
        H,
      ),
    ).toBe(false);
    expect(
      recordFits(
        bad((m) => (m.gain[5] = Infinity)),
        W,
        H,
      ),
    ).toBe(false);
    expect(
      recordFits(
        bad((m) => (m.gain[5] = 0.3)),
        W,
        H,
      ),
    ).toBe(false);
    expect(
      recordFits(
        bad((m) => (m.gain[5] = 2.5)),
        W,
        H,
      ),
    ).toBe(false);
    expect(
      recordFits(
        bad((m) => (m.dark = NaN)),
        W,
        H,
      ),
    ).toBe(false);
    expect(
      recordFits(
        bad((m) => (m.offset = new Float32Array(PX).fill(NaN))),
        W,
        H,
      ),
    ).toBe(false);
    expect(
      recordFits(
        bad((m) => (m.offset = new Float32Array(7))),
        W,
        H,
      ),
    ).toBe(false);
    expect(
      recordFits(
        bad((m) => (m.gain = new Float32Array(PX - 1).fill(1))),
        W,
        H,
      ),
    ).toBe(false);
    expect(mapIsValid({ ...halfMap(), offset: new Float32Array(PX).fill(3) }, W, H)).toBe(true);

    // A fake IndexedDB: the write of an invalid map never reaches it.
    const puts: unknown[] = [];
    const store = {
      put: (r: unknown) => {
        puts.push(r);
        const req = {} as IDBRequest;
        setTimeout(() => (req as unknown as { onsuccess?: () => void }).onsuccess?.());
        return req;
      },
      get: () => {
        const req = { result: bad((m) => (m.gain[0] = NaN)) } as unknown as IDBRequest;
        setTimeout(() => (req as unknown as { onsuccess?: () => void }).onsuccess?.());
        return req;
      },
    };
    const db = { transaction: () => ({ objectStore: () => store }) };
    const factory = {
      open: () => {
        const req = { result: db } as unknown as IDBOpenDBRequest;
        setTimeout(() => (req as unknown as { onsuccess?: () => void }).onsuccess?.());
        return req;
      },
    } as unknown as IDBFactory;
    const cache = createIndexedDbFlatFieldCache(factory);
    await cache.put(bad((m) => (m.gain[0] = 9)));
    expect(puts).toHaveLength(0);
    await cache.put(good);
    expect(puts).toHaveLength(1);
    // A poisoned record in the store reads back as nothing.
    await expect(cache.get(key.key, W, H)).resolves.toBeNull();
  });

  it('is inert without IndexedDB: reads find nothing, writes do nothing', async () => {
    const cache = createIndexedDbFlatFieldCache(undefined);
    const key = flatFieldKey({ width: W, height: H, folder: 'f' });
    await expect(cache.put(recordFromMap(key, W, H, halfMap(), 1))).resolves.toBeUndefined();
    await expect(cache.get(key.key, W, H)).resolves.toBeNull();
  });

  it('survives an IndexedDB that throws', async () => {
    const broken = {
      open() {
        throw new Error('blocked');
      },
    } as unknown as IDBFactory;
    const cache = createIndexedDbFlatFieldCache(broken);
    await expect(cache.get('k', W, H)).resolves.toBeNull();
    await expect(
      cache.put(
        recordFromMap(flatFieldKey({ width: W, height: H, folder: 'f' }), W, H, halfMap(), 1),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('flat-field status line', () => {
  const base = { ...initialFlatFieldState(), supported: true };
  const map: FlatFieldMap = { ...halfMap(), binsUsed: 5, framesUsed: 4321.4, gainSd: 0.0523 };
  const key = flatFieldKey({ width: W, height: H, device: { serial: 'S9' }, folder: 'f' });

  it('names each state', () => {
    expect(flatFieldStatusLine({ ...base, enabled: false })).toBe('off');
    expect(flatFieldStatusLine({ ...base, frames: 1000, fps: 20 })).toBe(
      'estimating (50 / 150 s of frames)',
    );
    expect(flatFieldStatusLine({ ...base, map, updates: 1 })).toBe(
      'estimated (5 shift bins, 4321 frames, gain SD 5.2%)',
    );
    expect(flatFieldStatusLine({ ...base, map, reused: true, key })).toBe(
      'reused from this browser (device key device:S9|64x48)',
    );
    expect(flatFieldStatusLine({ ...base, map, reused: true, key, updates: 2 })).toContain(
      'reused + refined',
    );
    const skipped = flatFieldStatusLine({
      ...base,
      map,
      skipped: 'too little motion: 1 shift bins with >= 25 new frames, need 2',
    });
    expect(skipped).toBe('skipped: too little motion (keeping the previous map)');
    expect(flatFieldStatusLine({ ...base, supported: false })).toMatch(/^off/);
  });

  it('reports the change and shows the gain at a fixed range', () => {
    expect(flatFieldChangeLine({ median: 0.07, p99: 0.331, max: 1 })).toBe(
      'median 0.07 sigma, p99 0.33 sigma',
    );
    expect(flatFieldChangeLine(null)).toBeNull();
    expect(flatFieldChangeLine({ median: NaN, p99: 0, max: 0 })).toBeNull();
    const g = Array.from(gainToGray8([0.8, 0.9, 1.0, 1.1, 1.3]));
    expect([g[0], g[1], g[3], g[4]]).toEqual([0, 0, 255, 255]);
    expect(Math.abs(g[2] - 127.5)).toBeLessThanOrEqual(0.5);
  });
});
