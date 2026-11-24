// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  buildSlowLoop,
  framesFrom,
  SlowRunner,
  type PublishedLibrary,
  type SlowLoopLike,
} from '../lib/slow-runner.ts';
import { lookbackFrames } from '../lib/lookback-reader.ts';
import { SETTLE } from '../lib/settle.ts';
import type { LookbackToSlow, SlowToLookback } from '../workers/lookback-types.ts';
import type {
  FastToSlow,
  OwnerToVisit,
  SlowInit,
  SlowToFast,
  SlowToMain,
  VisitToOwner,
} from '../workers/slow-types.ts';

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

function frames(start: number, count = 2): Extract<FastToSlow, { type: 'frames' }> {
  return {
    type: 'frames',
    session: 1,
    start,
    count,
    version: 0,
    cells: 0,
    frames: new Float32Array(2 * count),
    traces: new Float32Array(0),
  };
}

/** A fake loop with a look-back scheduler: `need` frames wanted, 1 id each. */
function fakeLoop(need: number) {
  let credit = 0;
  let left = need;
  let idle = false;
  const calls: string[] = [];
  const observed: { stream: number; ids: number[] }[] = [];
  const streams: (number | undefined)[] = [];
  let version = 10;
  const loop: SlowLoopLike = {
    observe: (_f, _v, _t, _b, stream) => {
      streams.push(stream);
      calls.push('observe');
      return true;
    },
    step: vi.fn(() => undefined),
    finalize: vi.fn(() => fakeLib(++version)),
    publishedLibrary: vi.fn(() => fakeLib(version)),
    setNoise: vi.fn(),
    setEditScope: vi.fn((s: string) => void calls.push(`scope:${s}`)),
    cellCount: 1,
    reservoirBytes: 0,
    stats: () => new Float64Array(17),
    free: vi.fn(),
    enableLookback: vi.fn(),
    lookbackNote: vi.fn((_seen: number, n: number) => {
      credit += 2 * n;
    }),
    lookbackAddCredit: vi.fn((n: number) => {
      credit += n;
    }),
    lookbackTake: vi.fn((max: number) => {
      const out: number[] = [];
      idle = false;
      for (let k = 0; k < max; k++) {
        if (left === 0) {
          idle = true;
          break;
        }
        if (credit < 1) break;
        credit--;
        out.push(need - left, 0, 1, 7);
        left--;
      }
      return Float64Array.from(out);
    }),
    get lookbackIdle() {
      return idle;
    },
    observeLookback: vi.fn((_f, _v, _t, _b, stream: number, ids: Float64Array) => {
      observed.push({ stream, ids: [...ids] });
      return true;
    }),
    markAllDue: vi.fn(() => void calls.push('markAllDue')),
    lookbackStats: () => Float64Array.of(need - left, observed.length, 0, 0, 1, left, 8),
    footprintNoise: vi.fn(() => Float64Array.of(1, 0.1)),
    footprintNoiseOn: vi.fn(() => 0.1),
  };
  return { loop, calls, observed, streams };
}

function setup(need: number, opts: { visits?: number; lookback?: boolean } = {}) {
  const f = fakeLoop(need);
  const toMain: SlowToMain[] = [];
  const toFast: SlowToFast[] = [];
  const toLb: SlowToLookback[] = [];
  const toVisit: OwnerToVisit[][] = Array.from({ length: opts.visits ?? 0 }, () => []);
  const deferred: (() => void)[] = [];
  const created: SlowInit[] = [];
  const r = new SlowRunner({
    create: (init) => {
      created.push(init);
      return f.loop;
    },
    toFast: { postMessage: (m) => toFast.push(m) },
    toMain: { postMessage: (m) => toMain.push(m) },
    visits: toVisit.map((q) => ({ postMessage: (m: OwnerToVisit) => q.push(m) })),
    ...(opts.lookback === false ? {} : { lookback: { postMessage: (m) => toLb.push(m) } }),
    now: () => 0,
    defer: (fn) => deferred.push(fn),
    timer: () => () => {},
  });
  const answered = new Set<number>();
  const pending = () =>
    toLb.find((m) => m.type === 'request' && !answered.has(m.id)) as
      Extract<SlowToLookback, { type: 'request' }> | undefined;
  /** Answer the oldest unanswered request with one frame per item. */
  const answer = () => {
    const req = pending();
    if (!req) throw new Error('no request');
    answered.add(req.id);
    const n = lookbackFrames(req.items).length;
    const reply: LookbackToSlow = {
      type: 'frames',
      session: 1,
      id: req.id,
      version: 10,
      count: n,
      cells: 1,
      frames: new Float32Array(2 * n),
      traces: new Float32Array(n),
    };
    r.handleLookback(reply);
    return reply;
  };
  /** Run deferred steps and answer requests until settled (or `max` rounds). */
  const run = (max = 100_000) => {
    for (let k = 0; k < max; k++) {
      if (deferred.length) deferred.shift()!();
      else if (pending()) answer();
      else return;
    }
  };
  return { r, ...f, toMain, toFast, toLb, toVisit, deferred, created, answer, run };
}

const statuses = (t: { toMain: SlowToMain[] }) =>
  t.toMain.flatMap((m) => (m.type === 'status' ? [m.status] : []));
const finals = (t: { toMain: SlowToMain[] }) => statuses(t).filter((s) => s.final);

describe('buildSlowLoop', () => {
  class Fake {
    args: unknown[];
    lookback: unknown[] | null = null;
    constructor(...args: unknown[]) {
      this.args = ['new', ...args];
    }
    static withConfig(...args: unknown[]) {
      const f = new Fake();
      f.args = ['withConfig', ...args];
      return f;
    }
    enableLookback(...a: unknown[]) {
      this.lookback = a;
    }
  }
  const init: SlowInit = {
    width: 4,
    height: 3,
    fov: new Uint8Array(12),
    noise: new Float32Array(12),
    cellDiameterPx: 9,
    flattenSigmaPx: 0,
    budget: 1,
  };

  it('uses the plain constructor with look-back off', () => {
    const l = buildSlowLoop(Fake, init);
    expect(l.args).toEqual(['new', 4, 3, init.fov, init.noise, 9, 0]);
    expect(l.lookback).toBeNull();
  });

  it('a ?factors stream builds with the replay in refine visits only and no look-back', () => {
    const l = buildSlowLoop(Fake, { ...init, factorSettle: true });
    expect(l.args).toEqual([
      'withConfig',
      4,
      3,
      init.fov,
      init.noise,
      9,
      0,
      'refine',
      'all',
      Infinity,
    ]);
    expect(l.lookback).toBeNull();
  });

  it('look-back wins over factorSettle (they never come together)', () => {
    const l = buildSlowLoop(Fake, { ...init, lookback: true, factorSettle: true });
    expect(l.args.slice(-3)).toEqual(['all', 'all', 0.6]);
  });

  it('builds with the look-back options and enables it', () => {
    const l = buildSlowLoop(Fake, { ...init, lookback: true });
    expect(l.args).toEqual(['withConfig', 4, 3, init.fov, init.noise, 9, 0, 'all', 'all', 0.6]);
    expect(l.lookback).toEqual([2, 3000]);
  });
});

describe('SlowRunner look-back in a Joint run (fake loop)', () => {
  it('drops look-back frames before a floor, request by request', () => {
    const flat = Float64Array.of(3, 0, 1, 7, 5, 0, 2, 7, 8, 9, 0, 0);
    expect(Array.from(framesFrom(flat, 0))).toEqual(Array.from(flat));
    expect(Array.from(framesFrom(flat, 4))).toEqual([5, 0, 2, 7, 8, 9, 0, 0]);
    expect(Array.from(framesFrom(flat, 6))).toEqual([9, 0, 0]);
    expect(framesFrom(flat, 10).length).toBe(0);
  });

  it('moves the floor to the session being read (also past a dropped first batch) and asks only for its frames', () => {
    const t = setup(1000);
    const floor = vi.fn();
    t.loop.setLookbackFloor = floor;
    t.r.handle({ ...INIT, lookback: true, sessionStarts: [4, 10] });
    expect(t.created[0].sessionStarts).toEqual([4, 10]);
    t.r.handle(frames(0));
    t.r.handle(frames(2));
    expect(floor).not.toHaveBeenCalled();
    t.run();
    // The forward pool dropped the batch at 4: the batch at 6 is session 1 all the same.
    t.r.handle(frames(6));
    expect(floor.mock.calls).toEqual([[4]]);
    t.run();
    // A scheduler that still hands out earlier frames (a build without the floor): they never go out.
    t.loop.lookbackTake = vi.fn(() => Float64Array.of(2, 0, 1, 7, 5, 0, 1, 7));
    const requests = () =>
      t.toLb.filter((m): m is Extract<SlowToLookback, { type: 'request' }> => m.type === 'request');
    t.r.handle(frames(8));
    expect(lookbackFrames(requests().at(-1)!.items).map((f) => f.frame)).toEqual([5]);
    t.r.handle(frames(10));
    expect(floor.mock.calls).toEqual([[4], [10]]);
    // Only earlier frames on offer: the answer is not followed by another request.
    const n = requests().length;
    t.answer();
    expect(requests().length).toBe(n);
  });
});

describe('SlowRunner look-back (fake loop)', () => {
  it('toggle off: no look-back calls or messages, and observe gets no stream index (as before)', () => {
    const t = setup(5);
    t.r.handle(INIT);
    expect(t.created[0]).not.toHaveProperty('lookback');
    t.r.handle(frames(0));
    t.r.handle(frames(2));
    t.r.handle({ type: 'end', session: 1 });
    expect(t.streams).toEqual([undefined, undefined, undefined, undefined]);
    expect(t.loop.lookbackNote).not.toHaveBeenCalled();
    expect(t.loop.lookbackTake).not.toHaveBeenCalled();
    expect(t.loop.setEditScope).not.toHaveBeenCalled();
    expect(t.toLb).toEqual([]);
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).every((s) => s.lookback === undefined)).toBe(true);
  });

  it('notes each batch, keeps one request out, and observes the answer', () => {
    const t = setup(10);
    t.r.handle({ ...INIT, lookback: true });
    expect(t.created[0].lookback).toBe(true);
    t.r.handle(frames(0, 2));
    expect(t.loop.lookbackNote).toHaveBeenLastCalledWith(2, 2);
    const reqs = () => t.toLb.filter((m) => m.type === 'request');
    expect(reqs()).toHaveLength(1);
    // 2 frames observed x rate 2 = 4 frames of budget.
    expect(reqs()[0].type === 'request' && reqs()[0].items.length).toBe(16);
    // Outstanding: the next batch adds budget but sends nothing.
    t.r.handle(frames(2, 2));
    expect(reqs()).toHaveLength(1);
    const reply = t.answer();
    expect(t.observed.map((o) => o.stream)).toEqual([0, 1, 2, 3]);
    expect(t.observed[0].ids).toEqual([7]);
    // The buffer goes back for reuse, and the leftover budget is asked for at once.
    const release = t.toLb.find((m) => m.type === 'release');
    expect(release?.type === 'release' && release.frames).toBe(reply.frames);
    expect(reqs()).toHaveLength(2);
    // A stale answer (old id) is ignored.
    t.r.handleLookback({ ...reply, id: 1 });
    expect(t.observed).toHaveLength(4);
    const st = statuses(t).at(-1)!;
    expect(st.lookback).toMatchObject({ settling: false, requested: 4 });
  });

  it('publishes libraries to the look-back worker too', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0));
    t.r.handle({ type: 'end', session: 1 });
    t.run();
    const libs = t.toLb.filter((m) => m.type === 'library');
    expect(libs.length).toBeGreaterThan(0);
  });

  /** The settle requests (frames without ids) sent so far, as frames. */
  const settleReqs = (t: { toLb: SlowToLookback[] }) =>
    t.toLb.flatMap((m) =>
      m.type === 'request' && m.items[2] === 0 ? [lookbackFrames(m.items)] : [],
    );

  it('settles after the last frame: refine scope, one pass through observe, last visits, final once', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 20));
    t.r.handle(frames(20, 20));
    const discoverObserves = t.streams.length;
    t.r.handle({ type: 'end', session: 1 });
    expect(t.loop.setEditScope).toHaveBeenCalledWith('refine');
    expect(finals(t)).toHaveLength(0);
    const first = statuses(t).at(-1)!;
    expect(first.lookback?.settling).toBe(true);
    expect(first.lookback?.settle).toMatchObject({ fed: 0, total: 40, recording: 40, done: false });
    // Requests of SETTLE.batch frames, in order, one preprocessor block (no gap).
    const reqs = settleReqs(t);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].map((f) => f.frame)).toEqual([...Array(SETTLE.batch).keys()]);
    expect(new Set(reqs[0].map((f) => f.block))).toEqual(new Set([-1]));
    t.run();
    // Every frame once, through the ordinary observe with its stream index.
    expect(t.streams.slice(discoverObserves)).toEqual([...Array(40).keys()]);
    expect(t.observed).toHaveLength(0);
    expect(finals(t)).toHaveLength(1);
    const last = statuses(t).at(-1)!;
    expect(last.editScope).toBe('refine');
    expect(last.lookback).toMatchObject({ settling: false });
    expect(last.lookback?.settle).toMatchObject({ fed: 40, total: 40, done: true, stopped: false });
    // Steps earn the frames' budget (16 + 16 + 8), then one last round on every tile.
    const steps = (t.loop.step as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const settleSteps = steps.slice(-4);
    expect(settleSteps).toEqual([16 * 123, 16 * 123, 8 * 123, SETTLE.finalSteps * 123]);
    expect(t.calls.filter((c) => c === 'markAllDue')).toHaveLength(1);
    // The final status carries the cells' noise (the Refine readout).
    expect(finals(t)[0].footprintNoise).toEqual(Float64Array.of(1, 0.1));
  });

  it('the next request goes out before the answer is observed', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 40));
    t.r.handle({ type: 'end', session: 1 });
    const before = t.calls.length;
    t.answer();
    const reqs = t.toLb.filter((m) => m.type === 'request');
    expect(reqs).toHaveLength(2);
    // The second request was sent while the first answer had not been observed yet.
    expect(t.calls.slice(before).filter((c) => c === 'observe')).toHaveLength(SETTLE.batch);
    const order = t.toLb.map((m) => m.type);
    expect(order.lastIndexOf('request')).toBeLessThan(order.lastIndexOf('release'));
  });

  it('checkpoints publish the library and count the cells still moving', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 2 * SETTLE.checkEvery));
    t.r.handle({ type: 'end', session: 1 });
    const finalize = t.loop.finalize as ReturnType<typeof vi.fn>;
    const atStart = finalize.mock.calls.length;
    t.run();
    // The start, two checkpoints, and the final library.
    expect(finalize.mock.calls.length - atStart).toBe(3);
    // The fake's footprint never changes: no cell moves.
    expect(statuses(t).at(-1)!.lookback?.settle?.moving).toEqual({ cells: 1, above: 0 });
  });

  it('a ?factors init reaches the loop with its settle level; a plain one carries neither key', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, factorSettle: true, settleFraction: 0.6 });
    expect(t.created[0]).toMatchObject({ factorSettle: true, settleFraction: 0.6 });
    const u = setup(0);
    u.r.handle(INIT);
    expect(u.created[0]).not.toHaveProperty('factorSettle');
    expect(u.created[0]).not.toHaveProperty('settleFraction');
  });

  it('a Final-settle level stops the pass early: the plan keeps its first share, Thorough is untouched', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, lookback: true, settleFraction: 0.5 });
    expect(t.created.at(-1)).toMatchObject({ settleFraction: 0.5 });
    t.r.handle(frames(0, 80));
    t.r.handle({ type: 'end', session: 1 });
    const discoverObserves = t.streams.length;
    t.run();
    const st = statuses(t).at(-1)!.lookback!.settle!;
    expect(st).toMatchObject({ fed: 40, total: 40, recording: 80, done: true, stopped: false });
    expect(t.streams.slice(discoverObserves)).toEqual([...Array(40).keys()]);
    expect(finals(t)).toHaveLength(1);
    // No fraction (Thorough): the whole recording, and the init carries no field.
    const u = setup(0);
    u.r.handle({ ...INIT, lookback: true });
    expect(u.created.at(-1)).not.toHaveProperty('settleFraction');
    u.r.handle(frames(0, 80));
    u.r.handle({ type: 'end', session: 1 });
    u.run();
    expect(statuses(u).at(-1)!.lookback!.settle).toMatchObject({ fed: 80, total: 80 });
  });

  it('sends the still-moving hint with the status after a checkpoint, once', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 2 * SETTLE.checkEvery));
    t.r.handle({ type: 'end', session: 1 });
    t.run();
    const hints = statuses(t).filter((s) => s.stillMoving);
    // At most one per checkpoint (statuses are throttled), never with the final library alone.
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints.length).toBeLessThanOrEqual(2);
    for (const h of hints) expect([...h.stillMoving!]).toEqual([1, 0]);
    // Region noise was asked for the core and the edge of the cell.
    expect(t.loop.footprintNoiseOn).toHaveBeenCalled();
  });

  it('a long recording is sampled up to the cap', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, lookback: true });
    const n = SETTLE.maxFrames + 6400;
    t.r.handle(frames(0, n));
    t.r.handle({ type: 'end', session: 1 });
    t.run();
    const st = statuses(t).at(-1)!.lookback!.settle!;
    expect(st.recording).toBe(n);
    expect(st.total).toBeLessThanOrEqual(SETTLE.maxFrames + SETTLE.block);
    expect(st.fed).toBe(st.total);
    // Blocks restart the preprocessor at each gap.
    const blocks = new Set(settleReqs(t).flatMap((r) => r.map((f) => f.block)));
    expect(blocks.size).toBeGreaterThan(1);
  });

  it('stop settling publishes the final library with what was fed', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 1000));
    t.r.handle({ type: 'end', session: 1 });
    t.answer();
    t.answer();
    expect(finals(t)).toHaveLength(0);
    t.r.stopSettling(1);
    t.run();
    expect(finals(t)).toHaveLength(1);
    const st = statuses(t).at(-1)!.lookback!.settle!;
    expect(st.stopped).toBe(true);
    expect(st.fed).toBe(2 * SETTLE.batch);
    // A late answer to the dropped request changes nothing.
    t.r.stopSettling(1);
    expect(finals(t)).toHaveLength(1);
  });

  it('a look-back error ends look-back, and settling still ends', () => {
    const t = setup(50);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 1));
    const req = t.toLb.find((m) => m.type === 'request')!;
    const id = req.type === 'request' ? req.id : 0;
    t.r.handleLookback({ type: 'error', session: 1, id, message: 'no file' });
    t.r.handle(frames(1, 1));
    expect(t.toLb.filter((m) => m.type === 'request')).toHaveLength(1);
    t.r.handle({ type: 'end', session: 1 });
    t.run();
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback?.error).toBe('no file');
  });

  it('without a look-back worker the run still settles and ends', () => {
    const t = setup(50, { lookback: false });
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 1));
    t.r.handle({ type: 'end', session: 1 });
    t.run();
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback?.error).toMatch(/not connected/);
  });

  it('with visit workers: due tiles go out as frames come in, and the last round waits for them', () => {
    const t = setup(0, { visits: 2 });
    let due = 0;
    t.loop.takeJob = () => (due-- > 0 ? Uint8Array.of(1) : undefined);
    t.loop.applyJob = vi.fn();
    t.loop.housekeep = () => undefined;
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    const jobs = () => t.toVisit.flat().filter((m) => m.type === 'job').length;
    due = 2;
    t.answer();
    expect(jobs()).toBe(2);
    t.run();
    // Every frame fed, but the visits out hold the final library.
    expect(statuses(t).at(-1)!.lookback?.settle?.fed).toBe(20);
    expect(finals(t)).toHaveLength(0);
    const res: VisitToOwner = { type: 'result', session: 1, bytes: Uint8Array.of(1), ms: 1 };
    t.r.handleVisit(0, res);
    t.r.handleVisit(1, res);
    t.run();
    expect(finals(t)).toHaveLength(1);
    expect(t.loop.step).not.toHaveBeenCalled();
  });

  it('with visit workers: the last round ends at its work cap even when tiles stay due', () => {
    const t = setup(0, { visits: 1 });
    let work = 0;
    t.loop.takeJob = () => Uint8Array.of(1);
    t.loop.applyJob = vi.fn(() => {
      work += 123 * 16;
    });
    t.loop.housekeep = () => undefined;
    Object.defineProperty(t.loop, 'work', { get: () => work });
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 16));
    t.r.handle({ type: 'end', session: 1 });
    t.run();
    const res: VisitToOwner = { type: 'result', session: 1, bytes: Uint8Array.of(1), ms: 1 };
    for (let k = 0; k < 100 && finals(t).length === 0; k++) {
      t.r.handleVisit(0, res);
      t.run();
    }
    expect(finals(t)).toHaveLength(1);
    // About SETTLE.finalSteps budgets of visits after the frames, not more.
    expect(work).toBeLessThanOrEqual(123 * (SETTLE.finalSteps + 3 * 16));
  });

  it('a reset drops the settling run', () => {
    const t = setup(1000);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 100));
    t.answer();
    t.r.handle({ type: 'end', session: 1 });
    t.answer();
    t.r.handle({ type: 'reset', session: 2 });
    t.run();
    expect(finals(t)).toHaveLength(0);
    // An answer that arrives after the reset is ignored (its buffer still goes back).
    expect(statuses(t).at(-1)!.lookback?.settle?.done).toBe(false);
  });

  it('a settle error from the look-back worker ends the settle with what was fed', () => {
    const t = setup(0);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 100));
    t.r.handle({ type: 'end', session: 1 });
    t.answer();
    const req = t.toLb.filter((m) => m.type === 'request').at(-1)!;
    t.r.handleLookback({
      type: 'error',
      session: 1,
      id: req.type === 'request' ? req.id : 0,
      message: 'disk',
    });
    t.run();
    expect(finals(t)).toHaveLength(1);
    const st = statuses(t).at(-1)!.lookback!;
    expect(st.error).toBe('disk');
    expect(st.settle).toMatchObject({ fed: SETTLE.batch, done: true });
  });
});

describe("SlowRunner settle on a stream's factors (fake loop)", () => {
  const FINIT = { ...INIT, factorSettle: true } as const;
  const ready = (n: number) => ({ type: 'factors', session: 1, ready: true, frames: n }) as const;
  const requests = (t: { toLb: SlowToLookback[] }) => t.toLb.filter((m) => m.type === 'request');

  it('waits after the last frame, then settles on the factors through port 0 with the current library first', () => {
    const t = setup(0);
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle(frames(20, 20));
    const observes = t.streams.length;
    // Discover asks look-back nothing and observes without a stream index (as a stream today).
    expect(requests(t)).toHaveLength(0);
    expect(t.streams.every((s) => s === undefined)).toBe(true);
    t.r.handle({ type: 'end', session: 1 });
    expect(finals(t)).toHaveLength(0);
    expect(statuses(t).at(-1)!.lookback).toMatchObject({
      settling: true,
      settle: { waiting: true, source: 'factors', fed: 0 },
    });
    expect(requests(t)).toHaveLength(0);
    t.r.factors(ready(39)); // one-frame tail left out
    // The worker gets the library before the first request.
    const kinds = t.toLb.map((m) => m.type);
    expect(kinds.indexOf('library')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('library')).toBeLessThan(kinds.indexOf('request'));
    expect(t.loop.setEditScope).toHaveBeenCalledWith('refine');
    t.run();
    expect(t.streams.slice(observes)).toEqual([...Array(39).keys()]);
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback!.settle).toMatchObject({
      fed: 39,
      total: 39,
      recording: 39,
      done: true,
      source: 'factors',
    });
  });

  it("factors that cannot be read end the wait with Discover's library as the final one", () => {
    const t = setup(0);
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    t.r.factors({
      type: 'factors',
      session: 1,
      ready: false,
      reason: 'The factors do not cover the stream.',
    });
    expect(finals(t)).toHaveLength(1);
    expect(requests(t)).toHaveLength(0);
    expect(statuses(t).at(-1)!.lookback!.settle).toMatchObject({
      fed: 0,
      done: true,
      error: 'The factors do not cover the stream.',
    });
  });

  it('Stop settling while waiting publishes the final library; a late "ready" changes nothing', () => {
    const t = setup(0);
    t.r.handle(FINIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    t.r.stopSettling(1);
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback!.settle).toMatchObject({
      stopped: true,
      done: true,
      fed: 0,
    });
    t.r.factors(ready(20));
    expect(requests(t)).toHaveLength(0);
    expect(finals(t)).toHaveLength(1);
  });

  it('a stream without factorSettle ends at once, as today', () => {
    const t = setup(0);
    t.r.handle(INIT);
    t.r.handle(frames(0, 20));
    t.r.handle({ type: 'end', session: 1 });
    expect(finals(t)).toHaveLength(1);
    expect(statuses(t).at(-1)!.lookback).toBeUndefined();
  });
});
