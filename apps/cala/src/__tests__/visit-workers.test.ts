// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  initCalaWasm,
  QcMonitor,
  SlowLoop,
  TraceEngine,
  TraceLibrary,
  VisitWorker,
} from '../lib/cala-wasm.ts';
import { buildGeometry, pickCell } from '../lib/cell-overlay.ts';
import { FastLoop } from '../lib/fast-loop.ts';
import { RESERVED_THREADS, visitWorkerCount } from '../lib/slow-client.ts';
import { SlowRunner, type PublishedLibrary, type SlowLoopLike } from '../lib/slow-runner.ts';
import type {
  FastToSlow,
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

describe('visitWorkerCount', () => {
  it('leaves the reserved threads free and caps the count', () => {
    expect(visitWorkerCount(undefined)).toBe(0);
    expect(visitWorkerCount(4)).toBe(0);
    expect(visitWorkerCount(RESERVED_THREADS + 1)).toBe(1);
    expect(visitWorkerCount(8)).toBe(3);
    expect(visitWorkerCount(64)).toBe(4);
    expect(visitWorkerCount(Number.NaN)).toBe(0);
  });
});

function fakeLib(version: number): PublishedLibrary {
  return {
    version,
    ids: () => Uint32Array.of(1),
    centers: () => Float32Array.of(0, 0),
    radii: () => Float32Array.of(1),
    supportStarts: () => Uint32Array.of(0, 1),
    supportPixels: () => Uint32Array.of(0),
    footprintValues: () => Float32Array.of(1),
    toBytes: () => Uint8Array.of(version),
    free: vi.fn(),
  };
}

const INIT: Extract<FastToSlow, { type: 'init' }> = {
  type: 'init',
  session: 1,
  width: 2,
  height: 1,
  fov: Uint8Array.of(1, 1),
  noise: Float32Array.of(1, 1),
  cellDiameterPx: 10,
  flattenSigmaPx: 0,
  budget: 123,
};

function frames(start: number, noise?: Float32Array): Extract<FastToSlow, { type: 'frames' }> {
  return {
    type: 'frames',
    session: 1,
    start,
    count: 2,
    version: 0,
    cells: 0,
    frames: new Float32Array(4),
    traces: new Float32Array(0),
    ...(noise ? { noise } : {}),
  };
}

describe('SlowRunner with visit workers (fakes)', () => {
  function setup(jobsDue: number) {
    const toVisit: { i: number; msg: OwnerToVisit }[][] = [[], []];
    const toMain: SlowToMain[] = [];
    const toFast: SlowToFast[] = [];
    let due = jobsDue;
    const applied: number[] = [];
    let housekeeps = 0;
    const loop: SlowLoopLike = {
      observe: () => true,
      step: vi.fn(() => undefined),
      finalize: () => fakeLib(900),
      setNoise: vi.fn(),
      takeJob: () => (due-- > 0 ? Uint8Array.of(due) : undefined),
      applyJob: (b) => applied.push(b[0]),
      housekeep: () => (++housekeeps === 3 ? fakeLib(7) : undefined),
      cellCount: 0,
      reservoirBytes: 0,
      stats: () => new Float64Array(16),
      free: vi.fn(),
    };
    const r = new SlowRunner({
      create: () => loop,
      toFast: { postMessage: (m) => toFast.push(m) },
      toMain: { postMessage: (m) => toMain.push(m) },
      visits: [0, 1].map((i) => ({
        postMessage: (m: OwnerToVisit) => toVisit[i].push({ i, msg: m }),
      })),
      now: () => 0,
    });
    return { r, loop, toVisit, toMain, toFast, applied };
  }

  it('observes only, hands a visit to each idle worker, applies results, publishes', () => {
    const t = setup(3);
    t.r.handle(INIT);
    // Both workers got the settings.
    expect(t.toVisit.map((q) => q[0].msg.type)).toEqual(['init', 'init']);
    const noise = Float32Array.of(2, 2);
    t.r.handle(frames(0, noise));
    expect(t.loop.step).not.toHaveBeenCalled();
    expect(t.loop.setNoise).toHaveBeenCalledWith(noise);
    // Noise reaches every worker before its first job.
    expect(t.toVisit.map((q) => q.map((m) => m.msg.type))).toEqual([
      ['init', 'noise', 'job'],
      ['init', 'noise', 'job'],
    ]);
    expect(t.toFast.filter((m) => m.type === 'ack')).toHaveLength(1);
    // A result frees its worker, which gets the third visit at once.
    const res: VisitToOwner = { type: 'result', session: 1, bytes: Uint8Array.of(42), ms: 5 };
    t.r.handleVisit(0, res);
    expect(t.applied).toEqual([42]);
    expect(t.toVisit[0].at(-1)!.msg.type).toBe('job');
    // Nothing more due: the next result leaves the worker idle.
    t.r.handleVisit(1, res);
    expect(t.toVisit[1].filter((m) => m.msg.type === 'job')).toHaveLength(1);
    // The third housekeeping published a library.
    expect(t.toFast.filter((m) => m.type === 'library')).toHaveLength(1);
    t.r.handle(frames(2));
    const st = t.toMain.filter((m) => m.type === 'status').at(-1)!;
    expect(st.type === 'status' && st.status).toMatchObject({
      visitWorkers: 2,
      jobs: 2,
      jobsInFlight: 1,
      visitMs: 5,
    });
  });

  it('waits for the visits out before the final library', () => {
    const t = setup(2);
    t.r.handle(INIT);
    t.r.handle(frames(0));
    t.r.handle({ type: 'end', session: 1 });
    const finals = () => t.toFast.filter((m) => m.type === 'library' && m.version === 900);
    expect(finals()).toHaveLength(0);
    const res: VisitToOwner = { type: 'result', session: 1, bytes: Uint8Array.of(1), ms: 1 };
    t.r.handleVisit(0, res);
    expect(finals()).toHaveLength(0);
    t.r.handleVisit(1, res);
    expect(finals()).toHaveLength(1);
    // No new visits once the recording ended.
    expect(t.toVisit.flat().filter((m) => m.msg.type === 'job')).toHaveLength(2);
  });

  it('drops results of an old session and reports a worker error', () => {
    const t = setup(2);
    t.r.handle(INIT);
    t.r.handle(frames(0));
    t.r.handleVisit(0, { type: 'result', session: 0, bytes: Uint8Array.of(9), ms: 1 });
    expect(t.applied).toEqual([]);
    t.r.handleVisit(1, { type: 'error', session: 1, message: 'boom' });
    const err = t.toMain.find((m) => m.type === 'error');
    expect(err).toMatchObject({ session: 1, message: 'visit worker 1: boom' });
    expect(t.loop.free).toHaveBeenCalled();
  });
});

/**
 * The real WASM objects with two visit workers, wired as the workers are,
 * with visit results arriving one batch late: the cells are still found.
 */
describe('parallel tile visits over the real WASM bindings', () => {
  it('discovers cells with visits run on two VisitWorkers', () => {
    const W = 64;
    const H = 64;
    const px = W * H;
    const cells = [
      [14, 14],
      [48, 50],
      [50, 14],
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
    const toSlow: FastToSlow[] = [];
    const toFast: SlowToFast[] = [];
    const toMain: SlowToMain[] = [];
    const fast = new FastLoop(
      {
        width: W,
        height: H,
        batchSize: 8,
        session: 1,
        cellDiameterPx: 6,
        flattenSigmaPx: 0,
        startFrame: 8,
        budget: 1e8,
        qc: false,
      },
      { postMessage: (msg) => toSlow.push(msg) },
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
    // Each visit worker: its own VisitWorker, messages queued like a port.
    const inbox: OwnerToVisit[][] = [[], []];
    const workers: (VisitWorker | null)[] = [null, null];
    const replies: { i: number; msg: VisitToOwner }[] = [];
    const runVisitWorker = (i: number) => {
      for (const msg of inbox[i].splice(0)) {
        if (msg.type === 'init') {
          workers[i]?.free();
          workers[i] = new VisitWorker(
            msg.width,
            msg.height,
            msg.fov,
            msg.noise,
            msg.cellDiameterPx,
            msg.flattenSigmaPx,
          );
        } else if (msg.type === 'noise') workers[i]!.setNoise(msg.noise);
        else if (msg.type === 'job') {
          const bytes = workers[i]!.run(msg.bytes);
          replies.push({ i, msg: { type: 'result', session: msg.session, bytes, ms: 1 } });
        }
      }
    };
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
      toFast: { postMessage: (msg) => toFast.push(msg) },
      toMain: { postMessage: (msg) => toMain.push(msg) },
      visits: [0, 1].map((i) => ({ postMessage: (m: OwnerToVisit) => inbox[i].push(m) })),
    });
    const calib = {
      fovMask: () => new Uint8Array(px).fill(1),
      noiseSigma: () => new Float32Array(px).fill(1),
    };
    const batch = new Float32Array(8 * px);
    let last = null as ReturnType<FastLoop['process']> | null;
    let maxOut = 0;
    for (let start = 0; start < 800; start += 8) {
      for (let i = 0; i < 8; i++) makeFrame(batch, i * px);
      last = fast.process(batch, start, 8, calib);
      // Results of the visits handed out last batch come back first.
      for (const r of replies.splice(0)) slow.handleVisit(r.i, r.msg);
      while (toSlow.length) slow.handle(toSlow.shift()!);
      maxOut = Math.max(maxOut, inbox.filter((q) => q.some((m) => m.type === 'job')).length);
      runVisitWorker(0);
      runVisitWorker(1);
      while (toFast.length) fast.handleSlow(toFast.shift()!);
    }
    const errors = toMain.filter((m) => m.type === 'error');
    expect(errors).toEqual([]);
    expect(last!.version).toBeGreaterThan(0);
    const views = toMain.filter((m) => m.type === 'library');
    const g = buildGeometry(views.at(-1)!.library);
    const found = cells.filter(([y, x]) => pickCell(g, x, y) !== null);
    expect(found.length).toBeGreaterThanOrEqual(2);
    const st = toMain.filter((m) => m.type === 'status').at(-1)!;
    expect(st.type === 'status' && st.status.jobs).toBeGreaterThan(0);
    expect(maxOut).toBeGreaterThanOrEqual(1);
    for (const w of workers) w?.free();
    fast.dispose();
  });
});
