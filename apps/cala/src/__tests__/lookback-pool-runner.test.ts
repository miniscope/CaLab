// @vitest-environment node
/**
 * The look-back pool and the settle governor in `SlowRunner` (work-slider
 * PR 5): worker 0 need-driven only, workers 1..S the settle's chunks, one
 * request out per worker, failures confined to one worker, and the governor
 * driving the settle from the pacer's target.
 */
import { describe, expect, it, vi } from 'vitest';
import { SlowRunner, type PublishedLibrary, type SlowLoopLike } from '../lib/slow-runner.ts';
import { lookbackFrames } from '../lib/lookback-reader.ts';
import type { LookbackToSlow, SlowToLookback } from '../workers/lookback-types.ts';
import type { FastToSlow, SlowToMain } from '../workers/slow-types.ts';

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
  lookback: true,
};

/** A fake loop: `need` need-driven frames wanted (2 per live frame), and the settle's picker. */
function fakeLoop(need: number) {
  let credit = 0;
  let left = need;
  let published = false;
  let chunk = 0;
  let version = 10;
  const settled: number[] = [];
  const loop: SlowLoopLike = {
    observe: () => true,
    step: vi.fn(() => {
      if (published) return undefined;
      published = true;
      return fakeLib(10);
    }),
    finalize: vi.fn(() => fakeLib(++version)),
    setNoise: vi.fn(),
    setEditScope: vi.fn(),
    cellCount: 1,
    reservoirBytes: 0,
    stats: () => new Float64Array(17),
    free: vi.fn(),
    lookbackNote: vi.fn((_seen: number, n: number) => {
      credit += 2 * n;
    }),
    lookbackTake: vi.fn((max: number) => {
      const out: number[] = [];
      for (let k = 0; k < max && left > 0 && credit >= 1; k++) {
        credit--;
        out.push(need - left, 0, 1, 7);
        left--;
      }
      return Float64Array.from(out);
    }),
    observeLookback: vi.fn(() => true),
    markAllDue: vi.fn(),
    lookbackStats: () => Float64Array.of(need - left, 0, 0, 0, 1, left, 8),
    footprintNoise: vi.fn(() => Float64Array.of(1, 0.1)),
    settleTake: vi.fn((seen: number, max: number) => {
      if (seen < max) return new Float64Array(0);
      chunk++;
      const start = (chunk * 5) % (seen - max + 1);
      const out: number[] = [];
      for (let k = 0; k < max; k++) out.push(start + k, -1_000_000 - chunk, 0);
      return Float64Array.from(out);
    }),
    observeSettle: vi.fn((_f, _v, _t, _b, stream: number) => {
      settled.push(stream);
      return true;
    }),
    settleSkipped: vi.fn(),
    settleStats: () => Float64Array.of(0, settled.length, 0, 0),
  };
  return { loop, settled };
}

type Req = Extract<SlowToLookback, { type: 'request' }>;

function setup(o: { need?: number; pool?: number; csettle?: number; governor?: boolean } = {}) {
  const f = fakeLoop(o.need ?? 0);
  const ports = 1 + (o.pool ?? 0);
  const toLb: SlowToLookback[][] = Array.from({ length: ports }, () => []);
  const toMain: SlowToMain[] = [];
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  let clock = 0;
  const r = new SlowRunner({
    create: () => f.loop,
    toFast: { postMessage: () => {} },
    toMain: { postMessage: (m) => toMain.push(m) },
    now: () => clock,
    epochNow: () => clock,
    defer: (fn) => fn(),
    timer: (fn) => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  for (let i = 0; i < ports; i++) r.connectLookback({ postMessage: (m) => toLb[i].push(m) }, i);
  r.handle({
    ...INIT,
    ...(o.csettle !== undefined ? { csettle: o.csettle } : {}),
    ...(o.governor ? { csettleGovernor: true } : {}),
  });
  const requests = (i: number) => toLb[i].filter((m): m is Req => m.type === 'request');
  const answered = new Set<number>();
  const pending = (i: number) => requests(i).find((m) => !answered.has(m.id));
  const answer = (i: number, o2: { error?: string } = {}) => {
    const req = pending(i);
    if (!req) throw new Error(`no request on port ${i}`);
    answered.add(req.id);
    const n = lookbackFrames(req.items).length;
    const reply: LookbackToSlow = o2.error
      ? { type: 'error', session: 1, id: req.id, message: o2.error }
      : {
          type: 'frames',
          session: 1,
          id: req.id,
          version: 10,
          count: n,
          cells: 1,
          frames: new Float32Array(2 * n),
          traces: new Float32Array(n),
          timing: { readMs: 50, preprocessMs: 50, solveMs: 40, otherMs: 0, waitMs: 0 },
        };
    r.handleLookback(reply, i);
    return req;
  };
  let at = 0;
  /** `n` live batches of 8 frames, `ms` apart (sent on time). */
  const live = (n: number, ms = 0) => {
    for (let k = 0; k < n; k++, at += 8) {
      clock += ms;
      r.handle({
        type: 'frames',
        session: 1,
        start: at,
        count: 8,
        version: 0,
        cells: 0,
        frames: new Float32Array(16),
        traces: new Float32Array(0),
        sentAt: clock,
      });
    }
  };
  const status = () => toMain.flatMap((m) => (m.type === 'status' ? [m.status] : [])).at(-1)!;
  const kinds = (i: number) => requests(i).map((q) => (q.skip ? 'csettle' : 'need'));
  return {
    r,
    f,
    toLb,
    requests,
    pending,
    answer,
    live,
    status,
    kinds,
    timers,
    skip: (n: number) => (at += n),
  };
}

describe('look-back pool', () => {
  it('worker 0 does need-driven look-back only; the pool takes the settle chunks', () => {
    const t = setup({ need: 200, pool: 2, csettle: 2 });
    t.live(4);
    // Both pool workers have a chunk out at once; worker 0 has need-driven frames.
    expect(t.kinds(0)).toEqual(['need']);
    expect(t.kinds(1)).toEqual(['csettle']);
    expect(t.kinds(2)).toEqual(['csettle']);
    // Answers keep each worker on its own kind, one request out per worker.
    for (let k = 0; k < 6; k++) {
      t.answer(0);
      t.answer(1);
      t.answer(2);
      t.live(2);
    }
    expect(new Set(t.kinds(0))).toEqual(new Set(['need']));
    expect(new Set([...t.kinds(1), ...t.kinds(2)])).toEqual(new Set(['csettle']));
    expect(t.status().lookback!.csettle!.settleWorkers).toBe(2);
  });

  it('sends every library to every worker, a copy each', () => {
    const t = setup({ pool: 1, csettle: 2 });
    t.live(1);
    const libs = t.toLb.map((m) => m.filter((x) => x.type === 'library'));
    expect(libs[0]).toHaveLength(1);
    expect(libs[1]).toHaveLength(1);
    const a = libs[0][0] as Extract<SlowToLookback, { type: 'library' }>;
    const b = libs[1][0] as Extract<SlowToLookback, { type: 'library' }>;
    expect(a.bytes).not.toBe(b.bytes);
  });

  it('a buffer goes back to the worker it came from, a stale answer too', () => {
    const t = setup({ need: 200, pool: 1, csettle: 2 });
    t.live(4);
    const req = t.pending(1)!;
    t.answer(1);
    expect(t.toLb[1].filter((m) => m.type === 'release')).toHaveLength(1);
    expect(t.toLb[0].filter((m) => m.type === 'release')).toHaveLength(0);
    // The same id again (stale): still released to worker 1.
    t.r.handleLookback(
      {
        type: 'frames',
        session: 1,
        id: req.id,
        version: 10,
        count: 1,
        cells: 1,
        frames: new Float32Array(2),
        traces: new Float32Array(1),
      },
      1,
    );
    expect(t.toLb[1].filter((m) => m.type === 'release')).toHaveLength(2);
    expect(t.toLb[0].filter((m) => m.type === 'release')).toHaveLength(0);
  });

  it('a pool worker that fails is left out alone; with none left the settle takes turns on worker 0', () => {
    const t = setup({ need: 400, pool: 1, csettle: 2 });
    t.live(4);
    t.answer(1, { error: 'boom' });
    expect(t.status().lookback!.error).toBeUndefined();
    expect(t.status().lookback!.csettle!.settleWorkers).toBe(0);
    const before = t.requests(1).length;
    for (let k = 0; k < 6; k++) {
      t.answer(0);
      t.live(2);
    }
    // Nothing more to worker 1; worker 0 now alternates need and settle.
    expect(t.requests(1).length).toBe(before);
    expect(new Set(t.kinds(0))).toEqual(new Set(['need', 'csettle']));
  });

  it('a pool worker that times out is left out alone; need-driven look-back goes on', () => {
    const t = setup({ need: 400, pool: 2, csettle: 2 });
    t.live(4);
    // Requests went out in port order (0, 1, 2): the last timer is worker 2's.
    const out2 = t.pending(2)!;
    const timer = t.timers.at(-1)!;
    expect(timer.cancelled).toBe(false);
    timer.fn();
    expect(t.status().lookback!.csettle!.settleWorkers).toBe(1);
    expect(t.status().lookback!.error).toBeUndefined();
    t.answer(0);
    t.live(2);
    expect(t.kinds(0).every((k) => k === 'need')).toBe(true);
    // Its late answer is released to it and ignored.
    t.r.handleLookback(
      {
        type: 'frames',
        session: 1,
        id: out2.id,
        version: 10,
        count: 16,
        cells: 1,
        frames: new Float32Array(32),
        traces: new Float32Array(16),
      },
      2,
    );
    expect(t.toLb[2].filter((m) => m.type === 'release')).toHaveLength(1);
    expect(t.status().lookback!.csettle!.settleWorkers).toBe(1);
  });

  it('the end of Discover drops every request out; the end settle goes to worker 0 only', () => {
    const t = setup({ need: 400, pool: 2, csettle: 2 });
    t.live(4);
    const n1 = t.requests(1).length;
    const n2 = t.requests(2).length;
    t.r.handle({ type: 'end', session: 1 });
    // Every timer of a request out was cancelled.
    expect(t.timers.slice(0, -1).every((x) => x.cancelled)).toBe(true);
    expect(t.requests(1).length).toBe(n1);
    expect(t.requests(2).length).toBe(n2);
    const end = t.requests(0).at(-1)!;
    expect(lookbackFrames(end.items).every((f) => f.block < 0 && f.block > -1_000_000)).toBe(true);
  });

  it('without a pool the settle takes turns on worker 0, as before', () => {
    const t = setup({ need: 400, pool: 0, csettle: 2 });
    t.live(4);
    for (let k = 0; k < 6; k++) {
      t.answer(0);
      t.live(2);
    }
    expect(new Set(t.kinds(0))).toEqual(new Set(['need', 'csettle']));
  });
});

describe('settle governor in the runner', () => {
  it('asks for nothing at Max (no pacer target), whatever the cap', () => {
    const t = setup({ pool: 1, csettle: 2, governor: true });
    t.live(200, 33);
    expect(t.requests(1)).toEqual([]);
    expect(t.status().lookback!.csettle!.governor!.limit).toBe('off');
  });

  it('with a target, ramps the settle up to the cap and reports it', () => {
    const t = setup({ pool: 1, csettle: 2, governor: true });
    t.r.setPace(30, false);
    // 30 fps: a batch of 8 every 267 ms; answers come straight back.
    for (let k = 0; k < 160; k++) {
      t.live(1, 267);
      while (t.pending(1)) t.answer(1);
    }
    const g = t.status().lookback!.csettle!.governor!;
    expect(g.target).toBe(30);
    expect(g.limit).toBe('cap');
    expect(g.rate).toBeCloseTo(60, 0);
    expect(t.requests(1).length).toBeGreaterThan(20);
  });

  it('halves on a forward-pool drop (a gap in the stream)', () => {
    const t = setup({ pool: 1, csettle: 2, governor: true });
    t.r.setPace(30, false);
    for (let k = 0; k < 120; k++) {
      t.live(1, 267);
      while (t.pending(1)) t.answer(1);
    }
    const before = t.status().lookback!.csettle!.governor!.rate;
    t.skip(8);
    for (let k = 0; k < 5; k++) {
      t.live(1, 267);
      while (t.pending(1)) t.answer(1);
    }
    const g = t.status().lookback!.csettle!.governor!;
    expect(g.halvings).toBe(1);
    expect(g.rate).toBeLessThan(before);
  });

  it('taking turns, worker 0 need-driven time counts towards the settle busy share', () => {
    const busy = (need: number) => {
      const t = setup({ need, pool: 0, csettle: 2, governor: true });
      t.r.setPace(30, false);
      for (let k = 0; k < 40; k++) {
        t.live(1, 267);
        while (t.pending(0)) t.answer(0);
      }
      expect(t.kinds(0)).toContain('csettle');
      return t.status().lookback!.csettle!.governor!.busy;
    };
    expect(busy(100_000)).toBeGreaterThan(busy(0));
  });
});
