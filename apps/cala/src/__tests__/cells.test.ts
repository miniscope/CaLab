// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initCalaWasm, QcMonitor, SlowLoop, TraceEngine, TraceLibrary } from '../lib/cala-wasm.ts';
import {
  buildGeometry,
  FOOTPRINT_ALPHA,
  pickCell,
  renderOverlay,
  type Rgb,
} from '../lib/cell-overlay.ts';
import { CellMetrics, pushRecent, summarize } from '../lib/cell-store.ts';
import {
  FastLoop,
  type TraceBackend,
  type TraceEngineLike,
  type TraceLibraryLike,
} from '../lib/fast-loop.ts';
import { ForwardPool } from '../lib/forward-pool.ts';
import {
  SlowRunner,
  type PublishedLibrary,
  type SlowLoopLike,
  type SlowRunnerDeps,
} from '../lib/slow-runner.ts';
import { TraceHistory } from '../lib/trace-history.ts';
import { parseQc } from '../lib/qc.ts';
import type {
  FastToSlow,
  LibraryView,
  OwnerToVisit,
  SlowToFast,
  SlowToMain,
  VisitToOwner,
} from '../workers/slow-types.ts';

beforeAll(async () => {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
});

/** A port that records what was posted (and what was transferred). */
function recorder<T>() {
  const sent: { msg: T; transfer: Transferable[] }[] = [];
  return {
    sent,
    postMessage(msg: T, transfer: Transferable[] = []) {
      sent.push({ msg, transfer });
    },
    of<K extends string>(type: K) {
      return sent.map((s) => s.msg).filter((m) => (m as { type: string }).type === type) as Extract<
        T,
        { type: K }
      >[];
    },
  };
}

describe('ForwardPool (the dropping policy)', () => {
  it('hands out at most `size` buffers and drops batches while all are in flight', () => {
    const pool = new ForwardPool(2, 10);
    const a = pool.acquire(4);
    const b = pool.acquire(4);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(pool.acquire(4)).toBeNull();
    expect(pool.acquire(3)).toBeNull();
    expect(pool.inFlight).toBe(2);
    expect(pool.forwardedFrames).toBe(8);
    expect(pool.droppedFrames).toBe(7);
    pool.release(a);
    // The returned buffer is reused, not reallocated.
    expect(pool.acquire(4)).toBe(a);
  });

  it('a lossless pool (Refine) never drops: it allocates past `size` and keeps only `size`', () => {
    const pool = new ForwardPool(2, 10, true);
    const bufs = [pool.acquire(4), pool.acquire(4), pool.acquire(4)];
    expect(bufs.every((b) => b !== null)).toBe(true);
    expect(pool.inFlight).toBe(3);
    expect(pool.droppedFrames).toBe(0);
    expect(pool.forwardedFrames).toBe(12);
    expect(pool.extraBuffers).toBe(1);
    for (const b of bufs) pool.release(b);
    expect(pool.inFlight).toBe(0);
    // Two kept for reuse, the extra one let go.
    expect(pool.acquire(4)).toBe(bufs[1]);
    expect(pool.acquire(4)).toBe(bufs[0]);
    expect(pool.extraBuffers).toBe(1);
  });

  it('frees the slot for a foreign buffer without keeping it', () => {
    const pool = new ForwardPool(1, 10);
    pool.acquire(1);
    pool.release(new Float32Array(3));
    expect(pool.inFlight).toBe(0);
    const c = pool.acquire(1)!;
    expect(c.length).toBe(10);
    // Extra releases never go negative.
    pool.release(null);
    pool.release(null);
    expect(pool.inFlight).toBe(0);
  });
});

describe('TraceHistory', () => {
  it('keeps the last `capacity` frames per cell, oldest first', () => {
    const h = new TraceHistory(5);
    // Two cells, frames 0..3 then 4..7.
    h.push(0, 4, [7, 9], [0, 100, 1, 101, 2, 102, 3, 103]);
    h.push(4, 4, [7, 9], [4, 104, 5, 105, 6, 106, 7, 107]);
    expect(h.get(7)).toEqual({ frames: [3, 4, 5, 6, 7], values: [3, 4, 5, 6, 7] });
    expect(h.get(9).values).toEqual([103, 104, 105, 106, 107]);
    expect(h.bytes).toBe(2 * 5 * 4);
  });

  it('starts a new cell at its first frame, fills gaps with NaN, restarts after a long one', () => {
    const h = new TraceHistory(16);
    h.push(0, 2, [1], [1, 2]);
    h.push(2, 2, [1, 2], [3, 30, 4, 40]);
    expect(h.get(2)).toEqual({ frames: [2, 3], values: [30, 40] });
    h.push(10, 1, [1, 2], [9, 90]);
    const one = h.get(1);
    expect(one.frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(one.values.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(one.values.slice(4, 10).every(Number.isNaN)).toBe(true);
    expect(one.values[10]).toBe(9);
    expect(h.span(2)).toEqual({ first: 2, end: 11 });
    // A gap longer than the buffer can hold starts the cell afresh.
    h.push(40, 1, [1], [5]);
    expect(h.get(1)).toEqual({ frames: [40], values: [5] });
  });

  it('grows with the data up to `capacity` frames, then keeps the newest', () => {
    const h = new TraceHistory(4096);
    const ids = [3];
    for (let f = 0; f < 3000; f += 10) {
      h.push(
        f,
        10,
        ids,
        Array.from({ length: 10 }, (_, i) => f + i),
      );
    }
    // 1024 -> 1536 -> 2304 -> 3456 frames as it filled.
    expect(h.bytes).toBe(3456 * 4);
    const t = h.get(3);
    expect(t.frames.length).toBe(3000);
    expect(t.values[2999]).toBe(2999);
    for (let f = 3000; f < 5000; f += 10) {
      h.push(
        f,
        10,
        ids,
        Array.from({ length: 10 }, (_, i) => f + i),
      );
    }
    const r = h.get(3);
    expect(r.frames[0]).toBe(5000 - 4096);
    expect(r.values[0]).toBe(5000 - 4096);
    expect(r.values[4095]).toBe(4999);
    expect(h.bytes).toBe(4096 * 4);
  });

  it('splits the byte budget evenly: late cells get as long a trace as early ones', () => {
    // 9 KB = 2304 frames of f32 for all cells together.
    const h = new TraceHistory(1 << 17, 10, 9 * 1024);
    for (let f = 0; f < 5000; f += 100) {
      h.push(
        f,
        100,
        [1, 2],
        new Array(200).fill(1).map((_, k) => f + (k >> 1)),
      );
    }
    // Two cells share 2304 frames: 1152 each.
    expect(h.bytes).toBe(2 * 1152 * 4);
    expect(h.get(1).frames.length).toBe(1152);
    expect(h.get(1).values[1151]).toBe(4999);
    // A third cell found late is tracked; every ring is cut back to its share (768).
    h.push(5000, 1, [1, 2, 7], [1, 2, 3]);
    expect(h.has(7)).toBe(true);
    expect(h.get(1).frames.length).toBe(768);
    expect(h.get(1).values[767]).toBe(1);
    expect(h.get(1).frames[0]).toBe(5001 - 768);
    expect(h.get(7).values).toEqual([3]);
    expect(h.bytes).toBeLessThanOrEqual(9 * 1024);
    // Dropping a cell frees its share; the others may grow back when linear.
    h.retain([1]);
    expect(h.bytes).toBe(768 * 4);
  });

  it('tracks every cell of a large library within the budget, late ones included', () => {
    const cells = 4000;
    const budget = 64 * 1048576;
    const h = new TraceHistory(1 << 17, 100_000, budget);
    const ids = Array.from({ length: cells }, (_, i) => i);
    // The first 1000 cells exist from the start; the rest appear one batch each.
    let frame = 0;
    for (; frame < 400; frame += 8) {
      const active = ids.slice(0, Math.min(cells, 1000 + frame * 8));
      h.push(frame, 8, active, new Float32Array(8 * active.length).fill(1));
    }
    expect(h.cellCount).toBe(cells);
    // Equal rings: 64 MB / 4000 cells / 4 B = 4194 frames each; every cell has data.
    expect(h.bytes).toBeLessThanOrEqual(budget);
    expect(h.get(cells - 1).frames.length).toBeGreaterThan(0);
    expect(h.span(0)!.end).toBe(h.span(cells - 1)!.end);
    // Once the library has stopped growing, long-lived cells are cut to the same ring as new ones.
    const sizes = new Set(ids.map((i) => h.get(i).frames.length).filter((n) => n > 8));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(Math.floor(budget / 4 / cells));
  });

  it('lays a trace out densely on stream frames with NaN where it has none', () => {
    const h = new TraceHistory(64);
    h.push(5, 3, [1], [1, 2, 3]);
    const d = h.dense(1, 10);
    expect(Array.from(d.subarray(5, 8))).toEqual([1, 2, 3]);
    expect([...d.subarray(0, 5), ...d.subarray(8)].every(Number.isNaN)).toBe(true);
    expect(h.dense(99, 4).every(Number.isNaN)).toBe(true);
  });

  it('reads a bounded window late in a recording, with gaps and wrapped history', () => {
    const h = new TraceHistory(4);
    h.push(1_000_000, 6, [1], [1, 2, 3, 4, 5, 6]);
    const v = h.range(1, 999_999, 1_000_007);
    expect(v.length).toBe(8);
    expect(Array.from(v)).toEqual([NaN, NaN, NaN, 3, 4, 5, 6, NaN]);
    expect(Array.from(h.range(1, 1_000_003, 1_000_005))).toEqual([4, 5]);
    expect(h.range(99, 1_000_000, 1_000_003).every(Number.isNaN)).toBe(true);
    expect(h.range(1, 10, 10).length).toBe(0);
  });

  it('drops cells that left the library, except the kept one, and caps the cell count', () => {
    const h = new TraceHistory(4, 2);
    h.push(0, 1, [1, 2, 3], [1, 2, 3]);
    expect(h.cellCount).toBe(2);
    expect(h.has(3)).toBe(false);
    h.retain([2], 1);
    expect(h.has(1)).toBe(true);
    expect(h.has(2)).toBe(true);
    h.retain([2]);
    expect(h.has(1)).toBe(false);
    expect(h.get(1)).toEqual({ frames: [], values: [] });
  });
});

/** Fake WASM trace objects: traces = frame index * 10 + slot. */
function fakeBackend() {
  const freed: number[] = [];
  const libs = new Map<number, number[]>();
  let engines = 0;
  const swaps: number[] = [];
  const lib = (bytes: Uint8Array): TraceLibraryLike => {
    const version = bytes[0];
    return {
      version,
      ids: () => Uint32Array.from(libs.get(version) ?? []),
      free: () => freed.push(version),
    };
  };
  let ids: number[] = [];
  let last = new Float32Array(0);
  const backend: TraceBackend = {
    libraryFromBytes: lib,
    newEngine(l): TraceEngineLike {
      engines++;
      ids = Array.from(l.ids());
      swaps.push(l.version);
      return {
        setLibrary(n) {
          ids = Array.from(n.ids());
          swaps.push(n.version);
        },
        processFrames(_f, count) {
          const out = new Float32Array(count * ids.length);
          for (let i = 0; i < count; i++)
            for (let j = 0; j < ids.length; j++) out[i * ids.length + j] = i * 10 + j;
          last = out.map((v) => v + 0.5);
          return out;
        },
        // Ring levels of the last batch: traces + 0.5.
        lastBackground: () => last.slice(),
        free() {},
      };
    },
  };
  return { backend, libs, freed, swaps, engines: () => engines };
}

const calibration = {
  fovMask: () => new Uint8Array(4).fill(1),
  noiseSigma: () => new Float32Array(4).fill(1),
};

function fastLoop(port: ReturnType<typeof recorder<FastToSlow>>, backend: TraceBackend) {
  return new FastLoop(
    {
      width: 2,
      height: 2,
      batchSize: 3,
      session: 5,
      cellDiameterPx: 10,
      flattenSigmaPx: 0,
      startFrame: 6,
      noiseEvery: 9,
      poolSize: 2,
    },
    port,
    backend,
  );
}

describe('FastLoop online QC', () => {
  function fakeQc() {
    const calls = { process: 0, noise: 0, freed: false, created: 0 };
    const backend = fakeBackend();
    backend.backend.qcFields = () => ({
      cell: 'id,peak_snr,flags,pass',
      global: 'cells,explained',
    });
    backend.backend.newQc = () => {
      calls.created++;
      return {
        processFrames(engine, f, n) {
          calls.process++;
          return engine.processFrames(f, n);
        },
        setNoise: () => void calls.noise++,
        cellMetrics: () => Float64Array.of(7, 9, 0, 1, 8, 2, 1, 0),
        globalMetrics: () => Float64Array.of(2, 0.5),
        neighbours: (slot) => (slot === 0 ? Float64Array.of(8, 0.3, 0.9) : new Float64Array(0)),
        residualMap: () => Float32Array.of(0, 1),
        residualMapDims: () => Uint32Array.of(2, 1, 8),
        free: () => void (calls.freed = true),
      };
    };
    return { ...backend, calls };
  }

  it('solves through the monitor and sends a snapshot at most once per qcEveryS of stream', () => {
    const t = fakeQc();
    t.libs.set(4, [7, 8]);
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const fl = new FastLoop(
      {
        width: 2,
        height: 2,
        batchSize: 3,
        session: 1,
        cellDiameterPx: 10,
        flattenSigmaPx: 0,
        // 4 frames of stream between snapshots.
        fps: 20,
        qcEveryS: 0.2,
        noiseEvery: 6,
      },
      null,
      t.backend,
    );
    const frames = new Float32Array(12);
    // No library yet: nothing to observe.
    expect(fl.process(frames, 0, 3, calibration).qcOn).toBe(false);
    fl.handleSlow({ type: 'library', session: 1, version: 4, bytes: Uint8Array.of(4) });
    const a = fl.process(frames, 3, 3, calibration);
    expect(a.qcOn).toBe(true);
    expect(Array.from(a.traces)).toEqual([0, 1, 10, 11, 20, 21]);
    expect(a.qc).toBeDefined();
    const snap = parseQc(a.qc!);
    expect(snap.frame).toBe(6);
    expect(snap.version).toBe(4);
    expect(snap.rows.map((r) => [r.id, r.peakSnr, r.pass])).toEqual([
      [7, 9, true],
      [8, 2, false],
    ]);
    expect(snap.neighbours.get(7)).toEqual([
      { id: 8, overlap: expect.closeTo(0.3, 5), r: expect.closeTo(0.9, 5) },
    ]);
    expect(snap.neighbours.get(8)).toEqual([]);
    expect(snap.global.explained).toBe(0.5);
    // Within the interval: no snapshot. After it: one; the noise map is refreshed every 6 frames.
    clock = 500;
    expect(fl.process(frames, 6, 3, calibration).qc).toBeUndefined();
    clock = 1200;
    expect(fl.process(frames, 9, 3, calibration).qc).toBeDefined();
    expect(t.calls.process).toBe(3);
    expect(t.calls.noise).toBe(1);
    expect(t.calls.created).toBe(1);
    fl.dispose();
    expect(t.calls.freed).toBe(true);
    vi.restoreAllMocks();
  });

  it('can be turned off', () => {
    const t = fakeQc();
    t.libs.set(4, [7]);
    const fl = new FastLoop(
      {
        width: 2,
        height: 2,
        batchSize: 3,
        session: 1,
        cellDiameterPx: 10,
        flattenSigmaPx: 0,
        qc: false,
      },
      null,
      t.backend,
    );
    fl.handleSlow({ type: 'library', session: 1, version: 4, bytes: Uint8Array.of(4) });
    const out = fl.process(new Float32Array(12), 0, 3, calibration);
    expect(out.qcOn).toBe(false);
    expect(out.qc).toBeUndefined();
    expect(t.calls.created).toBe(0);
  });
});

describe('FastLoop (fast worker side of the hand-off)', () => {
  it('starts the slow loop at startFrame and forwards batches as transferables', () => {
    const port = recorder<FastToSlow>();
    const fl = fastLoop(port, fakeBackend().backend);
    const frames = new Float32Array(12).map((_, i) => i);
    fl.process(frames, 0, 3, calibration);
    expect(port.sent).toHaveLength(0);
    fl.process(frames, 3, 3, calibration);
    const [init] = port.of('init');
    expect(init).toMatchObject({
      session: 5,
      width: 2,
      height: 2,
      cellDiameterPx: 10,
      budget: 3e7,
    });
    const [batch] = port.of('frames');
    expect(batch).toMatchObject({ session: 5, start: 3, count: 3, version: 0, cells: 0 });
    expect(Array.from(batch.frames)).toEqual(Array.from(frames));
    expect(port.sent[1].transfer).toContain(batch.frames.buffer);
  });

  it('forwards the background levels of the same solve with the traces, transferred', () => {
    const port = recorder<FastToSlow>();
    const fake = fakeBackend();
    fake.libs.set(3, [11, 12]);
    const fl = fastLoop(port, fake.backend);
    const frames = new Float32Array(12);
    fl.process(frames, 3, 3, calibration);
    // No cells yet: no levels.
    expect(port.of('frames')[0].background).toBeUndefined();
    fl.handleSlow({ type: 'library', session: 5, version: 3, bytes: Uint8Array.of(3) });
    fl.process(frames, 6, 3, calibration);
    const batch = port.of('frames').at(-1)!;
    expect(batch).toMatchObject({ version: 3, cells: 2 });
    expect(Array.from(batch.traces)).toEqual([0, 1, 10, 11, 20, 21]);
    expect(Array.from(batch.background!)).toEqual([0.5, 1.5, 10.5, 11.5, 20.5, 21.5]);
    expect(port.sent.at(-1)!.transfer).toContain(batch.background!.buffer);
  });

  it('never waits for the slow worker: drops while both buffers are out, resumes on ack', () => {
    const port = recorder<FastToSlow>();
    const fl = fastLoop(port, fakeBackend().backend);
    const frames = new Float32Array(12);
    for (let s = 6; s < 6 + 4 * 3; s += 3) fl.process(frames, s, 3, calibration);
    let out = fl.process(frames, 18, 3, calibration);
    expect(port.of('frames').map((m) => m.start)).toEqual([6, 9]);
    expect(out.forwardedFrames).toBe(6);
    expect(out.droppedFrames).toBe(9);
    // The slow worker hands one buffer back.
    const first = port.of('frames')[0];
    fl.handleSlow({
      type: 'ack',
      session: 5,
      frames: first.frames,
      start: 6,
      count: 3,
      observed: 3,
    });
    out = fl.process(frames, 21, 3, calibration);
    expect(port.of('frames').map((m) => m.start)).toEqual([6, 9, 21]);
    expect(out.slowFrame).toBe(9);
    // A fresh noise map rides along every `noiseEvery` frames.
    expect(port.of('frames')[2].noise).toBeInstanceOf(Float32Array);
    // Acks of another session are ignored.
    fl.handleSlow({
      type: 'ack',
      session: 4,
      frames: first.frames,
      start: 0,
      count: 99,
      observed: 0,
    });
    expect(fl.process(frames, 24, 3, calibration).slowFrame).toBe(9);
  });

  it('swaps in the newest published library between batches', () => {
    const port = recorder<FastToSlow>();
    const fake = fakeBackend();
    fake.libs.set(3, [11, 12]);
    fake.libs.set(4, [11, 12, 13]);
    fake.libs.set(6, [12, 13]);
    const fl = fastLoop(port, fake.backend);
    const frames = new Float32Array(12);
    let out = fl.process(frames, 0, 3, calibration);
    expect(out.version).toBe(0);
    expect(out.traces).toHaveLength(0);
    fl.handleSlow({ type: 'library', session: 5, version: 3, bytes: Uint8Array.of(3) });
    out = fl.process(frames, 3, 3, calibration);
    expect(out.version).toBe(3);
    expect(Array.from(out.ids)).toEqual([11, 12]);
    expect(Array.from(out.traces)).toEqual([0, 1, 10, 11, 20, 21]);
    // Two versions before the next batch: only the newest is built.
    fl.handleSlow({ type: 'library', session: 5, version: 4, bytes: Uint8Array.of(4) });
    fl.handleSlow({ type: 'library', session: 5, version: 6, bytes: Uint8Array.of(6) });
    out = fl.process(frames, 6, 3, calibration);
    expect(out.version).toBe(6);
    expect(Array.from(out.ids)).toEqual([12, 13]);
    expect(fake.swaps).toEqual([3, 6]);
    expect(fake.engines()).toBe(1);
    // The JS handles are freed (the engine keeps its own reference).
    expect(fake.freed).toEqual([3, 6]);
    // The forwarded batch carries the version and cell count that produced its traces.
    const last = port.of('frames').at(-1)!;
    expect(last).toMatchObject({ version: 6, cells: 2 });
    // An older version arriving late is ignored.
    fl.handleSlow({ type: 'library', session: 5, version: 4, bytes: Uint8Array.of(4) });
    expect(fl.process(frames, 9, 3, calibration).version).toBe(6);
  });

  it('returns the residual of the last frame only while asked, and only with cells', () => {
    const port = recorder<FastToSlow>();
    const fake = fakeBackend();
    fake.libs.set(3, [11]);
    const seen: number[][] = [];
    const newEngine = fake.backend.newEngine;
    fake.backend.newEngine = (l) => ({
      ...newEngine(l),
      residualOfLast(f) {
        seen.push(Array.from(f));
        return f.map((v) => v - 1);
      },
    });
    const fl = fastLoop(port, fake.backend);
    const frames = Float32Array.from({ length: 12 }, (_, i) => i);
    fl.setResidual(true);
    // No library yet: nothing to subtract.
    expect(fl.process(frames, 0, 3, calibration).residual).toBeUndefined();
    fl.handleSlow({ type: 'library', session: 5, version: 3, bytes: Uint8Array.of(3) });
    const out = fl.process(frames, 3, 3, calibration);
    // The batch's last frame (pixels 8..11 of a 2 x 2 frame).
    expect(seen).toEqual([[8, 9, 10, 11]]);
    expect(Array.from(out.residual!)).toEqual([7, 8, 9, 10]);
    fl.setResidual(false);
    expect(fl.process(frames, 6, 3, calibration).residual).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it('forwards nothing with discovery off, and tells the slow worker on dispose', () => {
    const port = recorder<FastToSlow>();
    const fl = fastLoop(port, fakeBackend().backend);
    fl.setDiscovery(false);
    const out = fl.process(new Float32Array(12), 6, 3, calibration);
    expect(out.discovering).toBe(false);
    expect(port.sent).toHaveLength(0);
    // Back on: frames skipped while off do not count as slow-loop lag.
    fl.setDiscovery(true);
    expect(fl.process(new Float32Array(12), 30, 3, calibration).slowFrame).toBe(30);
    expect(port.of('frames').map((m) => m.start)).toEqual([30]);
    fl.dispose();
    expect(port.of('reset')).toEqual([{ type: 'reset', session: 5 }]);
  });

  it('Refine: the replayed frames carry the background levels of their solve', () => {
    const port = recorder<FastToSlow>();
    const fake = fakeBackend();
    fake.libs.set(3, [11, 12]);
    const fl = new FastLoop(
      {
        width: 2,
        height: 2,
        batchSize: 3,
        session: 5,
        cellDiameterPx: 10,
        flattenSigmaPx: 0,
        poolSize: 2,
        refine: true,
        initialLibrary: Uint8Array.of(3),
      },
      port,
      fake.backend,
    );
    fl.process(new Float32Array(12), 0, 3, calibration);
    expect(port.of('replay')).toHaveLength(1);
    const [batch] = port.of('frames');
    expect(batch).toMatchObject({ start: 0, version: 3, cells: 2 });
    expect(Array.from(batch.background!)).toEqual([0.5, 1.5, 10.5, 11.5, 20.5, 21.5]);
    fl.dispose(true);
  });

  it('Refine: replays into the existing slow loop from frame 0, without noise maps', () => {
    const port = recorder<FastToSlow>();
    const fl = new FastLoop(
      {
        width: 2,
        height: 2,
        batchSize: 3,
        session: 5,
        cellDiameterPx: 10,
        flattenSigmaPx: 0,
        startFrame: 6,
        noiseEvery: 3,
        poolSize: 2,
        refine: true,
      },
      port,
      fakeBackend().backend,
    );
    fl.process(new Float32Array(12), 0, 3, calibration);
    expect(port.of('init')).toHaveLength(0);
    expect(port.of('replay')).toEqual([{ type: 'replay', session: 5, scope: 'refine' }]);
    expect(port.of('frames').map((m) => m.start)).toEqual([0]);
    fl.handleSlow({
      type: 'ack',
      session: 5,
      frames: port.of('frames')[0].frames,
      start: 0,
      count: 3,
      observed: 3,
    });
    fl.process(new Float32Array(12), 3, 3, calibration);
    fl.process(new Float32Array(12), 6, 3, calibration);
    expect(port.of('frames').every((m) => m.noise === undefined)).toBe(true);
    // Stopped mid-run: the slow loop stays and publishes what it has.
    fl.dispose(true);
    expect(port.of('reset')).toHaveLength(0);
    expect(port.of('end')).toEqual([{ type: 'end', session: 5 }]);
  });
});

function fakeLib(version: number, ids: number[]): PublishedLibrary & { freed: boolean } {
  const lib = {
    version,
    freed: false,
    ids: () => Uint32Array.from(ids),
    centers: () => new Float32Array(2 * ids.length),
    radii: () => new Float32Array(ids.length).fill(5),
    supportStarts: () => Uint32Array.from(ids.map((_, i) => i).concat(ids.length)),
    supportPixels: () => Uint32Array.from(ids.map((_, i) => i)),
    footprintValues: () => new Float32Array(ids.length).fill(1),
    toBytes: () => Uint8Array.of(version),
    free() {
      lib.freed = true;
    },
  };
  return lib;
}

function runner(publishAt: Set<number>) {
  const toFast = recorder<SlowToFast>();
  const toMain = recorder<SlowToMain>();
  const observed: { version: number; first: number; traces: number[]; background?: number[] }[] =
    [];
  let steps = 0;
  const libs: ReturnType<typeof fakeLib>[] = [];
  const loop: SlowLoopLike = {
    observe(frame, version, traces, background) {
      if (version === 99) return false;
      observed.push({
        version,
        first: frame[0],
        traces: Array.from(traces),
        ...(background ? { background: Array.from(background) } : {}),
      });
      return true;
    },
    step() {
      steps++;
      if (!publishAt.has(steps)) return undefined;
      const l = fakeLib(100 + steps, [1, 2, steps]);
      libs.push(l);
      return l;
    },
    finalize() {
      const l = fakeLib(500, [1]);
      libs.push(l);
      return l;
    },
    setNoise: vi.fn(),
    cellCount: 3,
    reservoirBytes: 1024,
    framesPerTile: 40,
    reservoirWarning: 'capped',
    stats: () => Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11),
    cellStatus: () => Float64Array.of(1, 1, 3, 2, 0, 0),
    free: vi.fn(),
  };
  const create = vi.fn<SlowRunnerDeps['create']>(() => loop);
  const r = new SlowRunner({ create, toFast, toMain, now: () => 0 });
  return { r, toFast, toMain, observed, libs, loop, create };
}

const INIT: Extract<FastToSlow, { type: 'init' }> = {
  type: 'init',
  session: 2,
  width: 2,
  height: 1,
  fov: Uint8Array.of(1, 1),
  noise: Float32Array.of(1, 1),
  cellDiameterPx: 10,
  flattenSigmaPx: 0,
  budget: 123,
};

describe('SlowRunner (slow worker side of the hand-off)', () => {
  it('observes each frame with its own traces, steps, and returns the buffer', () => {
    const t = runner(new Set([2]));
    t.r.handle(INIT);
    expect(t.create).toHaveBeenCalledOnce();
    const frames = Float32Array.of(10, 11, 20, 21, 30, 31);
    t.r.handle({
      type: 'frames',
      session: 2,
      start: 40,
      count: 3,
      version: 0,
      cells: 1,
      frames,
      traces: Float32Array.of(7, 8, 9),
    });
    expect(t.observed).toEqual([
      { version: 0, first: 10, traces: [7] },
      { version: 0, first: 20, traces: [8] },
      { version: 0, first: 30, traces: [9] },
    ]);
    const [ack] = t.toFast.of('ack');
    expect(ack).toMatchObject({ session: 2, start: 40, count: 3, observed: 3 });
    expect(ack.frames).toBe(frames);
    // The library published at step 2 went to the fast worker (bytes) and the UI (view).
    const [lib] = t.toFast.of('library');
    expect(lib).toMatchObject({ session: 2, version: 102 });
    expect(Array.from(lib.bytes)).toEqual([102]);
    const [view] = t.toMain.of('library');
    expect(view.library).toMatchObject({ version: 102, frame: 42, width: 2, height: 1 });
    expect(Array.from(view.library.ids)).toEqual([1, 2, 2]);
    expect(t.libs.every((l) => l.freed)).toBe(true);
    const [status] = t.toMain.of('status');
    expect(status.status).toMatchObject({ frame: 43, observed: 3, cells: 3, version: 102 });
    expect(status.status.counters).toMatchObject({ adds: 3, deletes: 9, splits: 10, absorbs: 11 });
    // The reservoir's size and its memory-cap warning reach the UI.
    expect(status.status).toMatchObject({ framesPerTile: 40, reservoirWarning: 'capped' });
    // Evidence status rides along (the first status of a run always carries it).
    expect(Array.from(status.status.cellStatus!.ids)).toEqual([1, 2]);
    expect(Array.from(status.status.cellStatus!.established)).toEqual([1, 0]);
  });

  it("observes each frame with its own slice of the solve's background levels", () => {
    const t = runner(new Set());
    t.r.handle(INIT);
    t.r.handle({
      type: 'frames',
      session: 2,
      start: 0,
      count: 2,
      version: 0,
      cells: 2,
      frames: Float32Array.of(10, 11, 20, 21),
      traces: Float32Array.of(1, 2, 3, 4),
      background: Float32Array.of(0.1, 0.2, 0.3, 0.4),
    });
    expect(t.observed.map((o) => [o.traces, o.background!.map((v) => +v.toFixed(3))])).toEqual([
      [
        [1, 2],
        [0.1, 0.2],
      ],
      [
        [3, 4],
        [0.3, 0.4],
      ],
    ]);
  });

  it('skips frames of a version it no longer holds, and still acks', () => {
    const t = runner(new Set());
    t.r.handle(INIT);
    t.r.handle({
      type: 'frames',
      session: 2,
      start: 0,
      count: 2,
      version: 99,
      cells: 0,
      frames: new Float32Array(4),
      traces: new Float32Array(0),
    });
    expect(t.toFast.of('ack')[0].observed).toBe(0);
    expect(t.toMain.of('status')[0].status.skipped).toBe(2);
  });

  it('acks even when the slow loop fails, reports the error, and drops the loop', () => {
    const t = runner(new Set());
    t.r.handle(INIT);
    t.loop.observe = () => {
      throw new Error('boom');
    };
    t.r.handle({
      type: 'frames',
      session: 2,
      start: 0,
      count: 1,
      version: 0,
      cells: 0,
      frames: new Float32Array(2),
      traces: new Float32Array(0),
    });
    expect(t.toFast.of('ack')).toHaveLength(1);
    expect(t.toMain.of('error')[0]).toMatchObject({ session: 2, message: 'boom' });
    expect(t.loop.free).toHaveBeenCalled();
  });

  it('finalizes at the end, and ignores other sessions after a reset', () => {
    const t = runner(new Set());
    t.r.handle(INIT);
    t.r.handle({ type: 'end', session: 2 });
    expect(t.toFast.of('library')[0].version).toBe(500);
    expect(t.toMain.of('status').at(-1)!.status.final).toBe(true);
    t.r.handle({ type: 'reset', session: 3 });
    t.r.handle({ type: 'end', session: 2 });
    t.r.handle({ ...INIT, session: 1 });
    expect(t.toFast.of('library')).toHaveLength(1);
    expect(t.create).toHaveBeenCalledOnce();
  });
});

describe('SlowRunner run stages (Discover, then Refine replays)', () => {
  function withScope() {
    const t = runner(new Set());
    const scopes: string[] = [];
    t.loop.setEditScope = (s: string) => {
      scopes.push(s);
    };
    return { ...t, scopes };
  }
  const frames = (start: number): Extract<FastToSlow, { type: 'frames' }> => ({
    type: 'frames',
    session: 2,
    start,
    count: 2,
    version: 0,
    cells: 0,
    frames: new Float32Array(4),
    traces: new Float32Array(0),
  });

  it('keeps the loop, sets the refine scope and runs again from frame 0', () => {
    const t = withScope();
    t.r.handle(INIT);
    t.r.handle(frames(0));
    t.r.handle(frames(2));
    t.r.handle({ type: 'end', session: 2 });
    const done = t.toMain.of('status').at(-1)!.status;
    expect(done).toMatchObject({ final: true, run: 1, editScope: 'all', consumed: 4 });
    t.r.handle({ type: 'replay', session: 2, scope: 'refine' });
    expect(t.scopes).toEqual(['refine']);
    expect(t.create).toHaveBeenCalledOnce();
    const st = t.toMain.of('status').at(-1)!.status;
    expect(st).toMatchObject({ final: false, run: 2, editScope: 'refine', frame: 0, consumed: 0 });
    t.r.handle(frames(0));
    expect(t.toMain.of('status').at(-1)!.status).toMatchObject({ frame: 2, consumed: 2, run: 2 });
    t.r.handle({ type: 'end', session: 2 });
    expect(t.toMain.of('status').at(-1)!.status).toMatchObject({ final: true, run: 2 });
    // Repeatable.
    t.r.handle({ type: 'replay', session: 2, scope: 'refine' });
    expect(t.toMain.of('status').at(-1)!.status.run).toBe(3);
  });

  it('in Refine, a batch gives way between frames while a visit is out', async () => {
    const toFast = recorder<SlowToFast>();
    const toMain = recorder<SlowToMain>();
    const visit = recorder<OwnerToVisit>();
    const events: string[] = [];
    let jobs = 0;
    const loop: SlowLoopLike = {
      ...runner(new Set()).loop,
      observe: (frame: Float32Array) => {
        events.push(`observe ${frame[0]}`);
        return true;
      },
      setEditScope: () => {},
      takeJob: () => Uint8Array.of(++jobs),
      applyJob: (b: Uint8Array) => {
        events.push(`apply ${b[0]}`);
      },
      housekeep: () => undefined,
    };
    const r = new SlowRunner({
      create: () => loop,
      toFast,
      toMain,
      visits: [visit],
      now: () => 0,
    });
    // 1 x 1 frames: each frame is one value.
    const batch = (start: number): Extract<FastToSlow, { type: 'frames' }> => ({
      ...frames(start),
      count: 3,
      frames: Float32Array.of(start, start + 1, start + 2),
    });
    const result = (job: number): VisitToOwner => ({
      type: 'result',
      session: 2,
      bytes: Uint8Array.of(job),
      ms: 1,
    });
    r.handle({ ...INIT, width: 1, height: 1, fov: Uint8Array.of(1), noise: Float32Array.of(1) });
    let pauses = 0;
    const pause = async () => {
      pauses++;
      // The visit's result arrives while the batch gives way.
      if (pauses === 1) r.handleVisit(0, result(jobs));
    };
    // Discover: the job handed out after batch 0 is out during batch 3, but
    // Discover keeps its timing: no pause.
    await r.handleAsync(batch(0), pause);
    expect(visit.of('job')).toHaveLength(1);
    await r.handleAsync(batch(3), pause);
    expect(pauses).toBe(0);
    // Discover ends once the visit out is back.
    r.handle({ type: 'end', session: 2 });
    r.handleVisit(0, result(jobs));
    r.handle({ type: 'replay', session: 2, scope: 'refine' });
    // Refine: a job goes out after the first batch; the next batch pauses
    // after its first frame, applies the result and hands out the next job.
    await r.handleAsync(batch(10), pause);
    const out = visit.of('job').length;
    events.length = 0;
    await r.handleAsync(batch(20), pause);
    expect(toMain.of('error')).toEqual([]);
    expect(events).toEqual(['observe 20', `apply ${out}`, 'observe 21', 'observe 22']);
    // The result handed out the next job, which is out for the next frame too.
    expect(pauses).toBe(2);
    expect(visit.of('job')).toHaveLength(out + 1);
    // Each buffer still comes back once.
    expect(toFast.of('ack').map((a) => a.start)).toEqual([0, 3, 10, 20]);
  });

  it('refuses a replay before the final library, and without a loop', () => {
    const t = withScope();
    t.r.handle(INIT);
    t.r.handle({ type: 'replay', session: 2, scope: 'refine' });
    expect(t.toMain.of('error')[0].message).toMatch(/final library/);
    expect(t.scopes).toEqual([]);
    const u = withScope();
    u.r.handle({ type: 'replay', session: -1, scope: 'refine' });
    expect(u.toMain.of('error')[0].message).toMatch(/Discover first/);
  });
});

describe('cell overlay geometry', () => {
  const view: LibraryView = {
    version: 1,
    frame: 0,
    width: 6,
    height: 5,
    ids: Uint32Array.of(10, 20),
    centers: Float32Array.of(2, 1, 2, 4),
    radii: Float32Array.of(1, 1),
    // Cell 10: a 3x3 block at x 0..2; cell 20: a single bright pixel at (2, 4).
    starts: Uint32Array.of(0, 9, 10),
    pixels: Uint32Array.of(6, 7, 8, 12, 13, 14, 18, 19, 20, 16),
    values: Float32Array.of(0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.1, 2),
  };

  it('outlines each cell and picks the cell under a pixel', () => {
    const g = buildGeometry(view);
    expect(g.shapes[0].inside).toHaveLength(8);
    // The centre pixel (13) is the only interior one.
    expect(Array.from(g.shapes[0].contour)).not.toContain(13);
    expect(g.shapes[0].contour).toHaveLength(7);
    expect(pickCell(g, 1.5, 2.5)).toBe(10);
    expect(pickCell(g, 4.2, 2.9)).toBe(20);
    expect(pickCell(g, 5, 0)).toBeNull();
    expect(pickCell(g, -1, 0)).toBeNull();
  });

  it('draws outlines, fills and the selected cell on top', () => {
    const g = buildGeometry(view);
    const rgba = renderOverlay(g, {
      selected: 20,
      color: () => [1, 2, 3],
      fill: (id) => (id === 10 ? 0.5 : 0),
    });
    const px = (p: number) => Array.from(rgba.slice(p * 4, p * 4 + 4));
    expect(px(13)).toEqual([1, 2, 3, 128]);
    expect(px(6)).toEqual([1, 2, 3, 242]);
    expect(px(16)).toEqual([255, 255, 255, 255]);
    expect(px(0)).toEqual([0, 0, 0, 0]);
  });

  it('keeps every support pixel with its value over the peak', () => {
    const g = buildGeometry(view);
    expect(Array.from(g.shapes[0].support)).toEqual([6, 7, 8, 12, 13, 14, 18, 19, 20]);
    expect(g.shapes[0].rel[4]).toBe(1);
    expect(g.shapes[0].rel[8]).toBeCloseTo(0.1);
    expect(Array.from(g.shapes[1].rel)).toEqual([1]);
  });

  it('fills footprints over their full extent, below the contour level too', () => {
    const g = buildGeometry(view);
    const style = { selected: null, color: (): Rgb => [9, 8, 7], fill: () => 0 };
    const px = (rgba: Uint8ClampedArray, p: number) => Array.from(rgba.slice(p * 4, p * 4 + 4));
    const fp = renderOverlay(g, { ...style, mode: 'footprints' });
    // Pixel 20 is at 0.1 of the peak: under the outline level, still drawn.
    expect(px(fp, 20)).toEqual([9, 8, 7, Math.round(255 * FOOTPRINT_ALPHA * 0.1)]);
    expect(px(fp, 13)).toEqual([9, 8, 7, Math.round(255 * FOOTPRINT_ALPHA)]);
    // No outlines in this mode: an edge pixel has its fill opacity.
    expect(px(fp, 6)[3]).toBe(Math.round(255 * FOOTPRINT_ALPHA * 0.5));
    const both = renderOverlay(g, { ...style, mode: 'both' });
    expect(px(both, 6)).toEqual([9, 8, 7, 242]);
    expect(px(both, 20)[3]).toBe(Math.round(255 * FOOTPRINT_ALPHA * 0.1));
    // Off: only the selected cell.
    const off = renderOverlay(g, { ...style, selected: 20, mode: 'off' });
    expect(px(off, 6)).toEqual([0, 0, 0, 0]);
    expect(px(off, 16)).toEqual([255, 255, 255, 255]);
  });
});

describe('summarize', () => {
  it('gives mean, p99 and max', () => {
    const v = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(summarize(v)).toEqual({ n: 200, mean: 100.5, p99: 198, max: 200 });
    expect(summarize([])).toEqual({ n: 0, mean: 0, p99: 0, max: 0 });
  });
});

describe('bounded per-batch histories', () => {
  it('pushRecent keeps the newest cap..2cap samples', () => {
    const s: number[] = [];
    for (let i = 0; i < 100; i++) pushRecent(s, i, 8);
    expect(s.length).toBeGreaterThanOrEqual(8);
    expect(s.length).toBeLessThan(16);
    expect(s.at(-1)).toBe(99);
    // contiguous newest samples, in order
    expect(s).toEqual(Array.from({ length: s.length }, (_, k) => 100 - s.length + k));
  });

  it('CellMetrics thins every series together and keeps the newest point', () => {
    const m = new CellMetrics(8);
    for (let i = 0; i < 1000; i++) m.push(8 * (i + 1), i, i % 3 ? i : null, i, i, i / 10, i / 20);
    expect(m.length).toBeLessThanOrEqual(8);
    for (const s of [m.cells, m.working, m.lag, m.version, m.fastMs, m.solveMs])
      expect(s.length).toBe(m.length);
    expect(m.frame.at(-1)).toBe(8000);
    expect(m.lag.at(-1)).toBe(999);
    // the series stay aligned: cells[i] was pushed with frame[i]
    m.frame.forEach((f, i) => expect(m.cells[i]).toBe(f / 8 - 1));
    // frames stay increasing
    for (let i = 1; i < m.length; i++) expect(m.frame[i]).toBeGreaterThan(m.frame[i - 1]);
  });
});

/**
 * The real WASM objects end to end, wired as the two workers are: blinking
 * cells in preprocessed-domain frames go to `FastLoop` -> `SlowRunner`
 * (`SlowLoop`) -> a published library -> back to `FastLoop` (`TraceLibrary`
 * bytes) -> traces of those cells.
 */
describe('fast and slow loop over the real WASM bindings', () => {
  it('discovers cells and hands the library to the fast loop', () => {
    const W = 64;
    const H = 64;
    const px = W * H;
    const cells = [
      [20, 20],
      [40, 44],
      [44, 18],
    ];
    let seed = 3;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const gauss = () => {
      let s = 0;
      for (let k = 0; k < 12; k++) s += rand();
      return s - 6;
    };
    const level = cells.map(() => 0);
    const makeFrame = (out: Float32Array, off: number) => {
      for (let c = 0; c < cells.length; c++) {
        level[c] *= 0.7;
        if (rand() < 0.08) level[c] += 25;
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let v = gauss();
          for (let c = 0; c < cells.length; c++) {
            const d2 = (y - cells[c][0]) ** 2 + (x - cells[c][1]) ** 2;
            v += level[c] * Math.exp(-d2 / 8);
          }
          out[off + y * W + x] = v;
        }
      }
    };

    const toSlow: { msg: FastToSlow }[] = [];
    const sentFrames: Extract<FastToSlow, { type: 'frames' }>[] = [];
    const toFast: { msg: SlowToFast }[] = [];
    const toMain = recorder<SlowToMain>();
    const fast = new FastLoop(
      {
        width: W,
        height: H,
        batchSize: 8,
        session: 1,
        cellDiameterPx: 6,
        flattenSigmaPx: 0,
        startFrame: 8,
        // Plenty of budget per frame for a 64 x 64 movie.
        budget: 1e8,
        // A QC snapshot after every batch.
        qcEveryS: 0,
      },
      {
        postMessage: (msg) => {
          toSlow.push({ msg });
          if (msg.type === 'frames') sentFrames.push(msg);
        },
      },
      {
        libraryFromBytes: (b) => TraceLibrary.fromBytes(b),
        newEngine: (l) => new TraceEngine(l as TraceLibrary, 0, 0),
        newQc: (q) => {
          const m = new QcMonitor(q.width, q.height, q.fov, q.noise, q.fps, 0);
          return {
            processFrames: (e, f, n) => m.processFrames(e as TraceEngine, f, n),
            setNoise: (n) => m.setNoise(n),
            cellMetrics: () => m.cellMetrics(),
            globalMetrics: () => m.globalMetrics(),
            neighbours: (s) => m.neighbours(s),
            residualMap: () => m.residualMap(),
            residualMapDims: () => m.residualMapDims(),
            free: () => m.free(),
          };
        },
        qcFields: () => ({ cell: QcMonitor.cellFields(), global: QcMonitor.globalFields() }),
      },
    );
    const slow = new SlowRunner({
      create: (i) =>
        new SlowLoop(
          i.width,
          i.height,
          i.fov,
          i.noise,
          i.cellDiameterPx,
          i.flattenSigmaPx,
        ) as unknown as SlowLoopLike,
      toFast: { postMessage: (msg) => toFast.push({ msg }) },
      toMain,
    });
    const calib = {
      fovMask: () => new Uint8Array(px).fill(1),
      noiseSigma: () => new Float32Array(px).fill(1),
    };
    const batch = new Float32Array(8 * px);
    let last = null as ReturnType<FastLoop['process']> | null;
    for (let start = 0; start < 640; start += 8) {
      for (let i = 0; i < 8; i++) makeFrame(batch, i * px);
      last = fast.process(batch, start, 8, calib);
      // Deliver everything queued, both ways (the workers' event loops).
      while (toSlow.length) slow.handle(toSlow.shift()!.msg);
      while (toFast.length) fast.handleSlow(toFast.shift()!.msg);
    }
    expect(last!.version).toBeGreaterThan(0);
    expect(last!.ids.length).toBeGreaterThanOrEqual(2);
    expect(last!.traces).toHaveLength(8 * last!.ids.length);
    expect(last!.droppedFrames).toBe(0);
    // The ring levels of the same solve went with the traces, one per cell and frame.
    const sent = sentFrames.at(-1)!;
    expect(sent.version).toBe(last!.version);
    expect(sent.background).toHaveLength(8 * sent.cells);
    expect(sent.background!.some((v) => v !== 0)).toBe(true);
    const views = toMain.of('library');
    expect(views.length).toBeGreaterThan(0);
    const g = buildGeometry(views.at(-1)!.library);
    // Every true cell centre falls inside a discovered footprint.
    const found = cells.filter(([y, x]) => pickCell(g, x, y) !== null);
    expect(found.length).toBeGreaterThanOrEqual(2);
    // Online QC rode along: one row per solved cell, in slot order.
    expect(last!.qcOn).toBe(true);
    const snap = parseQc(last!.qc!);
    expect(snap.rows.map((r) => r.id)).toEqual(Array.from(last!.ids));
    expect(snap.frame).toBe(640);
    expect(snap.global.cells).toBe(last!.ids.length);
    expect(snap.residual.blocksWide).toBe(8);
    expect(snap.residual.values).toHaveLength(64);
    expect(Number.isFinite(snap.global.explained)).toBe(true);
    expect(snap.rows.some((r) => Number.isFinite(r.peakSnr))).toBe(true);
    // The slow loop reports each cell's evidence status and the edit totals.
    const st = toMain.of('status').filter((m) => m.status.cellStatus);
    expect(st.length).toBeGreaterThan(0);
    const cs = st.at(-1)!.status.cellStatus!;
    expect(cs.ids.length).toBe(cs.established.length);
    expect(st.at(-1)!.status.counters.deletes).toBeGreaterThanOrEqual(0);
    fast.dispose();
  });
});
