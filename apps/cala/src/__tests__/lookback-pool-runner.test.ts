// @vitest-environment node
/**
 * The look-back pool and the settle governor in `SlowRunner`: worker 0
 * need-driven only, workers 1..S (once in the run's pool) the settle's
 * chunks, one request out per worker, failures confined to one worker, a
 * pool joining mid-run, and the governor driving the settle from the
 * pacer's target.
 */
import { describe, expect, it, vi } from 'vitest';
import { SlowRunner, type PublishedLibrary, type SlowLoopLike } from '../lib/slow-runner.ts';
import { lookbackFrames } from '../lib/lookback-reader.ts';
import { SETTLE } from '../lib/settle.ts';
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
  /** The next `step` publishes a new library. */
  const again = { on: false };
  let chunk = 0;
  let version = 10;
  const settled: number[] = [];
  const loop: SlowLoopLike = {
    observe: () => true,
    step: vi.fn(() => {
      if (again.on) {
        again.on = false;
        return fakeLib(++version);
      }
      if (published) return undefined;
      published = true;
      return fakeLib(10);
    }),
    finalize: vi.fn(() => fakeLib(++version)),
    publishedLibrary: vi.fn(() => (published ? fakeLib(version) : undefined)),
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
  return { loop, settled, again };
}

type Req = Extract<SlowToLookback, { type: 'request' }>;

function setup(
  o: {
    need?: number;
    /** Pool workers connected, and in the run's pool from its start (unless `join` is false). */
    pool?: number;
    join?: boolean;
    csettle?: number;
    /** The pacer's target (default 30 fps; 0 = Max). */
    pace?: number;
    /** More of the run's init (e.g. `factorFile`). */
    init?: Partial<typeof INIT>;
  } = {},
) {
  const f = fakeLoop(o.need ?? 0);
  const ports = 1 + (o.pool ?? 0);
  const pace = o.pace ?? 30;
  const toLb: SlowToLookback[][] = Array.from({ length: ports }, () => []);
  const toMain: SlowToMain[] = [];
  /** Each request's timeout, with the port the request went to (the last one posted to). */
  const timers: { fn: () => void; cancelled: boolean; port: number }[] = [];
  let lastPort = -1;
  let clock = 0;
  const r = new SlowRunner({
    create: () => f.loop,
    toFast: { postMessage: () => {} },
    toMain: { postMessage: (m) => toMain.push(m) },
    now: () => clock,
    epochNow: () => clock,
    defer: (fn) => fn(),
    timer: (fn) => {
      const t = { fn, cancelled: false, port: lastPort };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  for (let i = 0; i < ports; i++)
    r.connectLookback(
      {
        postMessage: (m) => {
          if (m.type === 'request') lastPort = i;
          toLb[i].push(m);
        },
      },
      i,
    );
  // From the main thread before the run's init: the target, the cap, the pool.
  r.setPace(pace, false);
  if (o.csettle !== undefined) r.setCap(o.csettle);
  if (ports > 1 && o.join !== false) r.setSettlePool(1, ports - 1);
  r.handle({ ...INIT, ...(o.csettle !== undefined ? { csettle: true } : {}), ...o.init });
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
  /** `n` live batches of 8 frames, `ms` apart (default: on time at the target). */
  const live = (n: number, ms = (8 * 1000) / (pace > 0 ? pace : 800)) => {
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
  /** Live batches, every port's requests answered except `hold`'s, until `until()` (at most 2,000). */
  const runUntil = (until: () => boolean, hold: number[] = []) => {
    for (let k = 0; k < 2000 && !until(); k++) {
      live(1);
      for (let i = 0; i < ports; i++) if (!hold.includes(i)) while (pending(i)) answer(i);
    }
    if (!until()) throw new Error('not reached');
  };
  return {
    r,
    f,
    toLb,
    toMain,
    requests,
    pending,
    answer,
    live,
    status,
    kinds,
    timers,
    runUntil,
    skip: (n: number) => (at += n),
  };
}

describe('look-back pool', () => {
  it('worker 0 does need-driven look-back only; the pool takes the settle chunks', () => {
    const t = setup({ need: 100_000, pool: 2, csettle: 2 });
    // Hold the pool's answers until both pool workers have a chunk out at once.
    t.runUntil(() => t.pending(1) !== undefined && t.pending(2) !== undefined, [1, 2]);
    expect(t.kinds(1)).toEqual(['csettle']);
    expect(t.kinds(2)).toEqual(['csettle']);
    for (let k = 0; k < 100; k++) {
      t.live(1);
      for (const i of [0, 1, 2]) while (t.pending(i)) t.answer(i);
    }
    expect(new Set(t.kinds(0))).toEqual(new Set(['need']));
    expect(new Set([...t.kinds(1), ...t.kinds(2)])).toEqual(new Set(['csettle']));
    expect(t.status().lookback!.csettle!.settleWorkers).toBe(2);
  });

  it("sends every library to every worker in the run's pool, a copy each", () => {
    const t = setup({ pool: 1, csettle: 2 });
    t.live(1);
    const libs = t.toLb.map((m) => m.filter((x) => x.type === 'library'));
    expect(libs[0]).toHaveLength(1);
    expect(libs[1]).toHaveLength(1);
    const a = libs[0][0] as Extract<SlowToLookback, { type: 'library' }>;
    const b = libs[1][0] as Extract<SlowToLookback, { type: 'library' }>;
    expect(a.bytes).not.toBe(b.bytes);
  });

  it('a pool worker connected but not in this run gets no library and no request', () => {
    const t = setup({ need: 100_000, pool: 1, join: false, csettle: 2 });
    t.runUntil(() => t.kinds(0).includes('csettle'));
    expect(t.toLb[1]).toEqual([]);
    expect(t.status().lookback!.csettle!.settleWorkers).toBe(0);
  });

  it('a pool joining mid-run gets the current library at once (a stable library too); worker 0 then stops taking settle turns', () => {
    const t = setup({ need: 100_000, pool: 1, join: false, csettle: 2 });
    t.runUntil(() => t.kinds(0).includes('csettle'));
    t.live(20);
    expect(t.toLb[1]).toEqual([]);
    // The library is stable (no new publish follows): the join itself sends it.
    t.r.setSettlePool(1, 1);
    const libs = t.toLb[1].filter((m) => m.type === 'library');
    expect(libs).toHaveLength(1);
    expect(libs[0]).toMatchObject({ session: 1, version: 10 });
    expect(t.status().lookback!.csettle!.settleWorkers).toBe(1);
    t.runUntil(() => t.pending(1) !== undefined, [1]);
    // The next publish goes to it as to every worker in the run (no second copy of this one).
    t.f.again.on = true;
    t.live(1);
    expect(t.toLb[1].filter((m) => m.type === 'library').map((m) => m.version)).toEqual([10, 11]);
    const n0 = t.kinds(0).length;
    for (let k = 0; k < 100; k++) {
      t.live(1);
      for (const i of [0, 1]) while (t.pending(i)) t.answer(i);
    }
    expect(new Set(t.kinds(0).slice(n0))).toEqual(new Set(['need']));
    expect(t.kinds(1).length).toBeGreaterThan(5);
  });

  it('a pool joining before the first library gets it with the first publish', () => {
    const t = setup({ pool: 1, join: false, csettle: 2 });
    t.r.setSettlePool(1, 1);
    expect(t.toLb[1]).toEqual([]);
    t.live(1);
    expect(t.toLb[1].filter((m) => m.type === 'library')).toHaveLength(1);
  });

  it('a pool held for another session does not join this run', () => {
    const t = setup({ pool: 1, join: false, csettle: 2 });
    t.r.setSettlePool(7, 1);
    t.f.again.on = true;
    t.live(5);
    expect(t.toLb[1]).toEqual([]);
  });

  it('a buffer goes back to the worker it came from, a stale answer too', () => {
    const t = setup({ need: 200, pool: 1, csettle: 2 });
    t.runUntil(() => t.pending(1) !== undefined, [1]);
    const req = t.pending(1)!;
    t.answer(1);
    expect(t.toLb[1].filter((m) => m.type === 'release')).toHaveLength(1);
    const r0 = t.toLb[0].filter((m) => m.type === 'release').length;
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
    expect(t.toLb[0].filter((m) => m.type === 'release')).toHaveLength(r0);
  });

  it('a pool worker that fails is left out alone; with none left the settle takes turns on worker 0', () => {
    const t = setup({ need: 100_000, pool: 1, csettle: 2 });
    t.runUntil(() => t.pending(1) !== undefined, [1]);
    t.answer(1, { error: 'boom' });
    expect(t.status().lookback!.error).toBeUndefined();
    expect(t.status().lookback!.csettle!.settleWorkers).toBe(0);
    const before = t.requests(1).length;
    const n0 = t.kinds(0).length;
    for (let k = 0; k < 200; k++) {
      t.live(1);
      while (t.pending(0)) t.answer(0);
    }
    // Nothing more to worker 1; worker 0 now alternates need and settle.
    expect(t.requests(1).length).toBe(before);
    expect(new Set(t.kinds(0).slice(n0))).toEqual(new Set(['need', 'csettle']));
  });

  it('a pool worker that times out is left out alone; need-driven look-back goes on', () => {
    const t = setup({ need: 100_000, pool: 2, csettle: 2 });
    t.runUntil(() => t.pending(1) !== undefined && t.pending(2) !== undefined, [1, 2]);
    const out2 = t.pending(2)!;
    const timer = t.timers.find((x) => x.port === 2 && !x.cancelled)!;
    timer.fn();
    expect(t.status().lookback!.csettle!.settleWorkers).toBe(1);
    expect(t.status().lookback!.error).toBeUndefined();
    const n0 = t.kinds(0).length;
    for (let k = 0; k < 50; k++) {
      t.live(1);
      for (const i of [0, 1]) while (t.pending(i)) t.answer(i);
    }
    expect(t.kinds(0).length).toBeGreaterThan(n0);
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
    t.runUntil(() => t.pending(1) !== undefined && t.pending(2) !== undefined, [1, 2]);
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
    const t = setup({ need: 100_000, pool: 0, csettle: 2 });
    t.runUntil(() => t.kinds(0).includes('csettle'));
    expect(new Set(t.kinds(0))).toEqual(new Set(['need', 'csettle']));
  });
});

describe('settle governor in the runner', () => {
  it('asks for nothing at Max (no pacer target), whatever the cap: the settle is not even armed', () => {
    const t = setup({ pool: 1, csettle: 2, pace: 0 });
    t.live(200, 33);
    expect(t.requests(1)).toEqual([]);
    expect(t.status().lookback!.csettle).toBeUndefined();
  });

  it('with a target, ramps the settle up to the cap and reports it', () => {
    const t = setup({ pool: 1, csettle: 2 });
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
    const t = setup({ pool: 1, csettle: 2 });
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
      const t = setup({ need, pool: 0, csettle: 2 });
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

describe("settle pool on a recording's factors (?factors=file)", () => {
  const SRC = {
    folder: 'run-a',
    windows: [{ index: 0, start: 0, frames: 400 }],
    width: 2,
    height: 1,
  };
  /** Discover of 50 batches (400 frames), its end and the answer with the factors. */
  const settleOnFactors = (o: { join?: boolean } = {}) => {
    const t = setup({ pool: 2, init: { factorFile: true }, ...o });
    t.live(50);
    t.r.handle({ type: 'end', session: 1 });
    const sent = t.toLb.map((m) => m.length);
    t.r.factors({ type: 'factors', session: 1, ready: true, frames: 400, source: SRC });
    return { ...t, sent };
  };
  /** Port `i`'s messages since the answer with the factors, by type. */
  const since = (t: ReturnType<typeof settleOnFactors>, i: number) =>
    t.toLb[i].slice(t.sent[i]).map((m) => m.type);
  /** One answer per worker in turn, until none is out. */
  const answerAll = (t: ReturnType<typeof settleOnFactors>) => {
    for (let k = 0; k < 1000 && [0, 1, 2].some((i) => t.pending(i)); k++)
      for (const i of [0, 1, 2]) if (t.pending(i)) t.answer(i);
  };

  it('every worker in the settle pool switches to the factors before its first settle request, and serves the settle', () => {
    const t = settleOnFactors();
    for (const i of [0, 1, 2]) {
      const kinds = since(t, i);
      expect(kinds.indexOf('factors')).toBeGreaterThanOrEqual(0);
      expect(kinds.indexOf('request')).toBeGreaterThan(kinds.indexOf('factors'));
      const sw = t.toLb[i][t.sent[i] + kinds.indexOf('factors')];
      expect(sw).toEqual({ type: 'factors', session: 1, factors: SRC });
    }
    answerAll(t);
    for (const i of [1, 2])
      expect(since(t, i).filter((k) => k === 'request').length).toBeGreaterThan(1);
    expect(t.status().final).toBe(true);
    expect(t.status().lookback!.settle).toMatchObject({
      source: 'factors',
      done: true,
      fed: 400,
      workers: 3,
    });
  });

  it('a pool that joins after the switch gets the factors with its library, before any settle request', () => {
    const t = settleOnFactors({ join: false });
    expect(since(t, 1)).toEqual([]);
    t.r.setSettlePool(1, 2);
    for (const i of [1, 2]) {
      const kinds = since(t, i);
      expect(kinds.slice(0, 2).sort()).toEqual(['factors', 'library']);
      expect(kinds.indexOf('request')).toBeGreaterThan(kinds.indexOf('factors'));
    }
    answerAll(t);
    expect(t.status().lookback!.settle).toMatchObject({ source: 'factors', done: true, fed: 400 });
  });

  it('a pool ended by the main thread (0 workers) gets nothing more: no request, no library', () => {
    const t = settleOnFactors();
    for (let k = 0; k < 3; k++) for (const i of [0, 1, 2]) if (t.pending(i)) t.answer(i);
    t.r.setSettlePool(1, 0);
    const after = t.toLb.map((m) => m.length);
    answerAll(t);
    for (const i of [1, 2])
      expect(
        t.toLb[i].slice(after[i]).filter((m) => m.type === 'request' || m.type === 'library'),
      ).toEqual([]);
    expect(t.status().final).toBe(true);
    expect(t.status().lookback!.settle).toMatchObject({ source: 'factors', done: true, fed: 400 });
  });

  it('a pool worker that fails in the settle is left out; the others finish it', () => {
    const t = settleOnFactors();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.answer(1, { error: 'broken' });
    const n1 = since(t, 1).filter((k) => k === 'request').length;
    answerAll(t);
    warn.mockRestore();
    expect(since(t, 1).filter((k) => k === 'request')).toHaveLength(n1);
    expect(t.status().final).toBe(true);
    // Its request's frames went to another worker: every frame fed.
    expect(t.status().lookback!.settle).toMatchObject({
      source: 'factors',
      done: true,
      workers: 2,
      fed: 400,
      total: 400,
    });
    expect(t.status().lookback!.error).toBeUndefined();
  });

  it('every pool worker fails in the settle: worker 0 feeds the rest', () => {
    const t = settleOnFactors();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.answer(1, { error: 'broken' });
    t.answer(2, { error: 'broken too' });
    answerAll(t);
    warn.mockRestore();
    expect(t.status().final).toBe(true);
    expect(t.status().lookback!.settle).toMatchObject({
      source: 'factors',
      done: true,
      workers: 1,
      fed: 400,
      total: 400,
    });
    expect(t.status().lookback!.error).toBeUndefined();
  });

  it('with no worker left the settle ends with the frames fed so far', () => {
    const t = settleOnFactors();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.answer(1, { error: 'broken' });
    t.answer(2, { error: 'broken too' });
    t.answer(0, { error: 'gone' });
    answerAll(t);
    warn.mockRestore();
    expect(t.status().final).toBe(true);
    const settle = t.status().lookback!.settle!;
    expect(settle).toMatchObject({ done: true, total: 400 });
    expect(settle.fed).toBeLessThan(settle.total);
  });

  it('the pooled settle on factors sends plain requests: none waits for final inputs or is held, no cues', () => {
    const t = settleOnFactors();
    answerAll(t);
    expect(t.status().lookback!.settle).toMatchObject({ source: 'factors', done: true, fed: 400 });
    for (const i of [0, 1, 2]) {
      const msgs = t.toLb[i].slice(t.sent[i]);
      const reqs = msgs.filter((m): m is Req => m.type === 'request');
      expect(reqs.length).toBeGreaterThan(0);
      for (const q of reqs) {
        expect(q.final).toBeUndefined();
        expect(q.hold).toBeUndefined();
      }
      expect(msgs.some((m) => m.type === 'solve' || m.type === 'drop')).toBe(false);
    }
  });

  it('the settle on the file waits for final inputs and is relayed on worker 0 (held, then cued)', () => {
    const t = setup({ pool: 2, init: { factorFile: true } });
    t.live(50);
    t.r.handle({ type: 'end', session: 1 });
    const sent = t.toLb[0].length;
    t.r.factors({ type: 'factors', session: 1, ready: false, reason: 'behind' });
    answerAll(t as ReturnType<typeof settleOnFactors>);
    const msgs = t.toLb[0].slice(sent);
    const reqs = msgs.filter((m): m is Req => m.type === 'request');
    expect(reqs.length).toBe(Math.ceil(400 / SETTLE.batch));
    expect(reqs.every((q) => q.final === true)).toBe(true);
    // The first goes out to be solved; every later one is held and cued once.
    expect(reqs.map((q) => q.hold === true)).toEqual(reqs.map((_, k) => k > 0));
    const cues = msgs.flatMap((m) => (m.type === 'solve' ? [m.id] : []));
    expect(cues).toEqual(reqs.slice(1).map((q) => q.id));
    expect(t.status().lookback!.settle).toMatchObject({ source: 'file', done: true, fed: 400 });
  });

  it('the settle on the file stays on worker 0 alone', () => {
    const t = setup({ pool: 2, init: { factorFile: true } });
    t.live(50);
    t.r.handle({ type: 'end', session: 1 });
    t.r.factors({ type: 'factors', session: 1, ready: false, reason: 'behind' });
    answerAll(t as ReturnType<typeof settleOnFactors>);
    expect(t.toLb[1].some((m) => m.type === 'request' || m.type === 'factors')).toBe(false);
    expect(t.status().lookback!.settle).toMatchObject({ source: 'file', done: true, workers: 1 });
  });
});
