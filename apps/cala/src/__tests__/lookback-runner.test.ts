// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  buildSlowLoop,
  LOOKBACK,
  SlowRunner,
  type PublishedLibrary,
  type SlowLoopLike,
} from '../lib/slow-runner.ts';
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
      return true;
    },
    step: vi.fn(() => undefined),
    finalize: vi.fn(() => fakeLib(++version)),
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
    const n = req.items.length / 4;
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

  it('builds with the look-back options and enables it', () => {
    const l = buildSlowLoop(Fake, { ...init, lookback: true });
    expect(l.args).toEqual(['withConfig', 4, 3, init.fov, init.noise, 9, 0, 'all', 'all', 0.6]);
    expect(l.lookback).toEqual([2, 3000]);
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

  it('settles after the last frame: refine scope, look-back until idle, visits, then final', () => {
    const t = setup(6);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 1));
    t.answer();
    t.r.handle({ type: 'end', session: 1 });
    expect(t.loop.setEditScope).toHaveBeenCalledWith('refine');
    expect(finals(t)).toHaveLength(0);
    expect(statuses(t).at(-1)!.lookback?.settling).toBe(true);
    t.run();
    // Every needed frame was observed, then the last visits, then the final library.
    expect(t.observed).toHaveLength(6);
    expect(finals(t)).toHaveLength(1);
    const last = statuses(t).at(-1)!;
    expect(last.final).toBe(true);
    expect(last.editScope).toBe('refine');
    expect(last.lookback).toMatchObject({ settling: false, inNeed: 0, capped: false });
    expect(last.lookback!.drainSteps).toBeGreaterThan(0);
    // markAllDue at the first drain step and once more for the settle phase.
    expect(t.calls.filter((c) => c === 'markAllDue').length).toBeGreaterThanOrEqual(2);
    // Without visit workers: steps run here (drain steps + 256 settle steps).
    expect((t.loop.step as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(
      LOOKBACK.settleSteps,
    );
  });

  it('stop settling publishes the final library with what was refined', () => {
    const t = setup(1000);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 1));
    t.answer();
    t.r.handle({ type: 'end', session: 1 });
    for (let k = 0; k < 20; k++) t.run(3);
    expect(finals(t)).toHaveLength(0);
    t.r.stopSettling(1);
    t.run();
    expect(finals(t)).toHaveLength(1);
    expect(t.observed.length).toBeLessThan(1000);
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

  it('with visit workers: each drain step waits for its visits', () => {
    const t = setup(3, { visits: 2 });
    let due = 0;
    t.loop.takeJob = () => (due-- > 0 ? Uint8Array.of(1) : undefined);
    t.loop.applyJob = vi.fn();
    t.loop.housekeep = () => undefined;
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 1));
    t.answer();
    due = 2;
    t.r.handle({ type: 'end', session: 1 });
    // Two visits out: the step waits for them.
    const jobs = () => t.toVisit.flat().filter((m) => m.type === 'job').length;
    expect(jobs()).toBe(2);
    t.run();
    expect(finals(t)).toHaveLength(0);
    const res: VisitToOwner = { type: 'result', session: 1, bytes: Uint8Array.of(1), ms: 1 };
    t.r.handleVisit(0, res);
    t.r.handleVisit(1, res);
    t.run();
    expect(finals(t)).toHaveLength(1);
    expect(t.observed).toHaveLength(3);
  });

  it('a Refine run after it does no look-back', () => {
    const t = setup(1);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 1));
    t.answer();
    t.r.handle({ type: 'end', session: 1 });
    t.run();
    expect(finals(t)).toHaveLength(1);
    const notes = (t.loop.lookbackNote as ReturnType<typeof vi.fn>).mock.calls.length;
    t.r.handle({ type: 'replay', session: 1, scope: 'refine' });
    t.r.handle(frames(0, 2));
    expect((t.loop.lookbackNote as ReturnType<typeof vi.fn>).mock.calls.length).toBe(notes);
  });

  it('a reset drops the settling run', () => {
    const t = setup(1000);
    t.r.handle({ ...INIT, lookback: true });
    t.r.handle(frames(0, 1));
    t.answer();
    t.r.handle({ type: 'end', session: 1 });
    t.r.handle({ type: 'reset', session: 2 });
    t.run();
    expect(finals(t)).toHaveLength(0);
  });
});
