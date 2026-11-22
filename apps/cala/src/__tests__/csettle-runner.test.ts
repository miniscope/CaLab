// @vitest-environment node
/**
 * Settle during Discover ("Background settle", frames only; `SlowInit.csettle`):
 * armed below Max only, the governor's dose, the runner's requests to the
 * look-back worker, and what reaches the slow loop.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildSlowLoop,
  SlowRunner,
  type PublishedLibrary,
  type SlowLoopLike,
} from '../lib/slow-runner.ts';
import { lookbackFrames } from '../lib/lookback-reader.ts';
import { CSETTLE } from '../lib/settle.ts';
import type { LookbackToSlow, SlowToLookback } from '../workers/lookback-types.ts';
import type { FastToSlow, SlowInit, SlowToFast, SlowToMain } from '../workers/slow-types.ts';

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

function frames(start: number, count = 8): Extract<FastToSlow, { type: 'frames' }> {
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

/** Stream frames the fake holds out: every third. */
const held = (f: number) => f % 3 === 0;

/** A fake loop: `need` need-driven look-back frames wanted, and the settle's frame picker. */
function fakeLoop(need: number, settle = true, gate = { open: true }) {
  let credit = 0;
  let published = false;
  let left = need;
  let chunk = 0;
  let taken = 0;
  let skipped = 0;
  const settled: number[] = [];
  const lookedBack: number[] = [];
  const seens: number[] = [];
  let version = 10;
  const loop: SlowLoopLike = {
    observe: () => true,
    // The first library (version 10) comes with the first step once the gate is open.
    step: vi.fn(() => {
      if (!gate.open || published) return undefined;
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
    enableLookback: vi.fn(),
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
    observeLookback: vi.fn((_f, _v, _t, _b, stream: number) => {
      lookedBack.push(stream);
      return true;
    }),
    markAllDue: vi.fn(),
    lookbackStats: () => Float64Array.of(need - left, lookedBack.length, 0, 0, 1, left, 8),
    footprintNoise: vi.fn(() => Float64Array.of(1, 0.1)),
    ...(settle
      ? {
          enableSettle: vi.fn(),
          settleTake: vi.fn((seen: number, max: number) => {
            seens.push(seen);
            if (seen < max) return new Float64Array(0);
            chunk++;
            const start = (chunk * 5) % (seen - max + 1);
            const out: number[] = [];
            for (let k = 0; k < max; k++)
              out.push(start + k, -1_000_000 - chunk, held(start + k) ? 1 : 0);
            taken += max;
            return Float64Array.from(out);
          }),
          observeSettle: vi.fn((_f, _v, _t, _b, stream: number) => {
            if (held(stream)) throw new Error(`held-out frame ${stream} reached the slow loop`);
            settled.push(stream);
            return true;
          }),
          settleSkipped: vi.fn((n: number) => {
            skipped += n;
          }),
          settleStats: () => Float64Array.of(taken, settled.length, skipped, 0),
        }
      : {}),
  };
  return { loop, settled, lookedBack, seens };
}

function setup(
  o: {
    need?: number;
    /** The cap (re-read frames per live frame; 0 = Off); absent: the run may not settle. */
    csettle?: number;
    /** The pacer's target, live fps (0 = Max); default 100. Each live batch advances the clock by its period. */
    pace?: number;
    needFirst?: boolean;
    yieldFrames?: number;
    settle?: boolean;
    lb?: boolean;
    /** false: the slow loop publishes no library until `gate.open` is set. */
    library?: boolean;
  } = {},
) {
  const gate = { open: o.library !== false };
  const f = fakeLoop(o.need ?? 0, o.settle ?? true, gate);
  const timers: (() => void)[] = [];
  const toMain: SlowToMain[] = [];
  const toFast: SlowToFast[] = [];
  const toLb: SlowToLookback[] = [];
  const deferred: (() => void)[] = [];
  const created: SlowInit[] = [];
  const pace = o.pace ?? 100;
  const clock = { ms: 1_000_000 };
  const r = new SlowRunner({
    create: (init) => {
      created.push(init);
      return f.loop;
    },
    toFast: { postMessage: (m) => toFast.push(m) },
    toMain: { postMessage: (m) => toMain.push(m) },
    lookback: { postMessage: (m) => toLb.push(m) },
    now: () => 0,
    epochNow: () => clock.ms,
    defer: (fn) => deferred.push(fn),
    timer: (fn) => {
      timers.push(fn);
      return () => {};
    },
  });
  // The target and the cap come before the run's init, as from the main thread.
  r.setPace(pace, false);
  if (o.csettle !== undefined) r.setCap(o.csettle);
  r.handle({
    ...INIT,
    ...(o.lb === false ? { lookback: undefined } : {}),
    ...(o.csettle !== undefined ? { csettle: true } : {}),
    ...(o.needFirst ? { csettleNeedFirst: true } : {}),
    ...(o.yieldFrames ? { csettleYield: o.yieldFrames } : {}),
  });
  type Req = Extract<SlowToLookback, { type: 'request' }>;
  const requests = () => toLb.filter((m): m is Req => m.type === 'request');
  const answered = new Set<number>();
  const pending = () => requests().find((m) => !answered.has(m.id));
  /** Answer the request out (library version 10, or `version`). */
  const answer = (version = 10) => {
    const req = pending();
    if (!req) throw new Error('no request');
    answered.add(req.id);
    const n = lookbackFrames(req.items).length;
    const reply: LookbackToSlow = {
      type: 'frames',
      session: 1,
      id: req.id,
      version,
      count: n,
      cells: 1,
      frames: new Float32Array(2 * n),
      traces: new Float32Array(n),
    };
    r.handleLookback(reply);
  };
  /** Feed `n` live batches of 8 frames. */
  let at = 0;
  const live = (n: number) => {
    for (let k = 0; k < n; k++, at += 8) {
      // On time at the target (at Max, a batch every 10 ms).
      clock.ms += (8 * 1000) / (pace > 0 ? pace : 800);
      r.handle(frames(at));
    }
  };
  const status = () =>
    toMain.flatMap((m) => (m.type === 'status' ? [m.status] : [])).at(-1)!.lookback!;
  const settleRequests = () => requests().filter((q) => q.skip !== undefined);
  const releases = () => toLb.filter((m) => m.type === 'release').length;
  /** Live batches (need-driven requests answered) until one more settle request is out; the batches fed. */
  const untilSettle = (max = 5000) => {
    const n0 = settleRequests().length;
    let k = 0;
    while (settleRequests().length === n0 && k < max) {
      live(1);
      k++;
      while (pending() && !pending()!.skip) answer();
    }
    if (settleRequests().length === n0) throw new Error('no settle request');
    return k;
  };
  return {
    r,
    ...f,
    toMain,
    toLb,
    deferred,
    created,
    requests,
    settleRequests,
    pending,
    answer,
    live,
    status,
    releases,
    untilSettle,
    timers,
    gate,
    clock,
    frameAt: () => at,
  };
}

describe('settle during Discover: off by default', () => {
  it('a look-back run without the flag asks for nothing more and reports nothing more', () => {
    const t = setup({ need: 40 });
    t.live(8);
    while (t.pending()) t.answer();
    expect(t.created[0]).not.toHaveProperty('csettle');
    expect(t.loop.enableSettle).not.toHaveBeenCalled();
    expect(t.loop.settleTake).not.toHaveBeenCalled();
    expect(t.loop.observeSettle).not.toHaveBeenCalled();
    expect(t.settleRequests()).toEqual([]);
    expect(t.requests().length).toBeGreaterThan(0);
    for (const q of t.requests()) expect(q).not.toHaveProperty('skip');
    expect(t.status()).not.toHaveProperty('csettle');
  });

  it('is ignored without look-back, and with a slow loop that cannot do it', () => {
    const a = setup({ csettle: 2, lb: false });
    a.live(8);
    expect(a.created[0]).not.toHaveProperty('csettle');
    expect(a.toLb).toEqual([]);
    const b = setup({ csettle: 2, settle: false });
    b.live(8);
    expect(b.requests()).toEqual([]);
    expect(b.status()).not.toHaveProperty('csettle');
  });

  it('buildSlowLoop never turns the engine side on: the runner does, when it arms the settle', () => {
    class Fake {
      settle: unknown[] | null = null;
      static withConfig() {
        return new Fake();
      }
      enableLookback() {}
      enableSettle(...a: unknown[]) {
        this.settle = a;
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
      lookback: true,
    };
    expect(buildSlowLoop(Fake, init).settle).toBeNull();
    expect(buildSlowLoop(Fake, { ...init, csettle: true }).settle).toBeNull();
  });
});

describe('settle during Discover: at Max', () => {
  it('a run at Max never arms it: the same requests as a run that may not settle', () => {
    const off = setup({ need: 400, pace: 0 });
    const max = setup({ need: 400, pace: 0, csettle: 2 });
    for (const t of [off, max]) {
      for (let k = 0; k < 300; k++) {
        t.live(1);
        while (t.pending()) t.answer();
      }
    }
    expect(max.loop.enableSettle).not.toHaveBeenCalled();
    expect(max.loop.settleTake).not.toHaveBeenCalled();
    expect(max.settleRequests()).toEqual([]);
    const items = (t: typeof off) => t.requests().map((q) => Array.from(q.items));
    expect(items(max)).toEqual(items(off));
    expect(items(max).length).toBeGreaterThan(10);
    expect(max.status()).not.toHaveProperty('csettle');
  });

  it('a run that goes below Max arms it then (the engine side too), and back at Max asks for nothing', () => {
    const t = setup({ pace: 0, csettle: 2 });
    t.live(50);
    expect(t.loop.enableSettle).not.toHaveBeenCalled();
    t.r.setPace(100, false);
    expect(t.loop.enableSettle).toHaveBeenCalledWith(CSETTLE.chunk);
    t.untilSettle();
    expect(t.status().csettle!.governor).toMatchObject({ target: 100, cap: 2 });
    while (t.pending()) t.answer();
    t.r.setPace(0, false);
    const n = t.settleRequests().length;
    for (let k = 0; k < 200; k++) {
      t.live(1);
      while (t.pending()) t.answer();
    }
    expect(t.settleRequests().length).toBe(n);
    expect(t.status().csettle!.governor).toMatchObject({ limit: 'off', rate: 0 });
    expect(t.loop.enableSettle).toHaveBeenCalledTimes(1);
  });
});

describe('settle during Discover: the cap during a run', () => {
  it('cap Off stops the settle at once; a cap again resumes it', () => {
    const t = setup({ csettle: 2 });
    t.untilSettle();
    while (t.pending()) t.answer();
    t.r.setCap(0);
    expect(t.status().csettle!.governor).toMatchObject({
      limit: 'off',
      rate: 0,
      cap: 0,
      credit: 0,
    });
    const n = t.settleRequests().length;
    for (let k = 0; k < 200; k++) {
      t.live(1);
      while (t.pending()) t.answer();
    }
    expect(t.settleRequests().length).toBe(n);
    t.r.setCap(1);
    t.untilSettle();
    expect(t.status().csettle!.governor!.cap).toBe(1);
    expect(t.status().csettle!.rate).toBe(1);
  });

  it('a run started with the cap Off arms when a cap is set', () => {
    const t = setup({ csettle: 0 });
    t.live(50);
    expect(t.loop.enableSettle).not.toHaveBeenCalled();
    t.r.setCap(2);
    expect(t.loop.enableSettle).toHaveBeenCalledTimes(1);
    t.untilSettle();
  });

  it('a lower cap holds the rate down at once', () => {
    const t = setup({ csettle: 2, pace: 100 });
    for (let k = 0; k < 400; k++) {
      t.live(1);
      while (t.pending()) t.answer();
    }
    const before = t.status().csettle!.governor!;
    expect(before.rate).toBeGreaterThan(50);
    t.r.setCap(0.5);
    const after = t.status().csettle!.governor!;
    expect(after.rate).toBeLessThanOrEqual(0.5 * 100 + 1e-9);
    expect(after.limit).toBe('cap');
    expect(after.credit).toBeLessThanOrEqual(CSETTLE.chunk);
  });
});

describe('settle during Discover: dose and requests', () => {
  it('asks for one chunk of saved frames once a whole chunk is owed, one request at a time', () => {
    const t = setup({ csettle: 2 });
    t.untilSettle();
    expect(t.requests().length).toBe(1);
    const q = t.requests()[0];
    const fr = lookbackFrames(q.items);
    expect(fr.length).toBe(CSETTLE.chunk);
    expect(fr.every((f, i) => f.frame === fr[0].frame + i && f.frame < t.frameAt())).toBe(true);
    // A block of its own: never the look-back scheduler's (>= 0) or the end settle's (-1 - run).
    expect(fr.every((f) => f.block < -1_000_000)).toBe(true);
    expect(Array.from(q.skip!)).toEqual(fr.map((f) => (held(f.frame) ? 1 : 0)));
    // More live frames: still one request out.
    t.live(20);
    expect(t.requests().length).toBe(1);
  });

  it('the bank: what the look-back worker cannot deliver is not saved up', () => {
    const t = setup({ csettle: 2 });
    // 1,000 live batches (80 s at 100 fps); the worker answers nothing meanwhile.
    t.live(1000);
    expect(t.requests().length).toBe(1);
    // With no new live frames, only the bank (4 chunks) is asked for after the one out.
    let n = 0;
    while (t.pending() && n < 100) {
      t.answer();
      n++;
    }
    expect(t.requests().length).toBe(1 + CSETTLE.bankChunks);
  });

  it('a worker that keeps up is held at the cap: 2, 1 or 0.5 per live frame', () => {
    for (const rate of CSETTLE.rates) {
      const t = setup({ csettle: rate, pace: 50 });
      for (let k = 0; k < 600; k++) {
        t.live(1);
        while (t.pending()) t.answer();
      }
      t.live(1);
      const cs = t.status().csettle!;
      expect(cs.rate).toBe(rate);
      expect(cs.live).toBe(601 * 8);
      expect(cs.governor).toMatchObject({ limit: 'cap', cap: rate });
      expect(cs.governor!.rate).toBeCloseTo(rate * 50, 0);
      const reread = cs.fit + cs.heldOut + cs.dropped;
      // (One request may still be out.)
      expect(cs.requested - reread).toBe(t.pending() ? CSETTLE.chunk : 0);
      expect(reread / cs.live).toBeLessThanOrEqual(rate);
    }
  });

  it('held-out frames never reach the slow loop; the rest go to the footprint statistics', () => {
    const t = setup({ csettle: 2 });
    t.untilSettle();
    const q = t.requests()[0];
    const fr = lookbackFrames(q.items).map((f) => f.frame);
    t.answer();
    // (The fake throws if a held-out frame is observed.)
    expect(t.settled).toEqual(fr.filter((f) => !held(f)));
    expect(t.loop.observeLookback).not.toHaveBeenCalled();
    t.live(1);
    const cs = t.status().csettle!;
    expect(cs.heldOut).toBe(fr.filter(held).length);
    expect(cs.fit + cs.heldOut).toBe(16);
    expect(cs.answers).toBe(1);
    expect(t.releases()).toBe(1);
  });

  it('an answer solved before the first library is dropped', () => {
    const t = setup({ csettle: 2 });
    t.untilSettle();
    t.answer(0);
    expect(t.settled).toEqual([]);
    t.live(1);
    expect(t.status().csettle!.dropped).toBe(16);
    expect(t.releases()).toBe(1);
  });

  it('takes turns with need-driven look-back when both have frames to ask for', () => {
    const t = setup({ need: 100_000, csettle: 2 });
    for (let k = 0; k < 400; k++) {
      t.live(1);
      if (t.pending()) t.answer();
    }
    const kinds = t.requests().map((q) => (q.skip ? 'settle' : 'need'));
    // (Before a whole chunk is owed only need-driven look-back has frames to ask for.)
    expect(kinds[0]).toBe('need');
    const first = kinds.indexOf('settle');
    expect(first).toBeGreaterThan(0);
    expect(kinds.filter((k) => k === 'settle').length).toBeGreaterThan(20);
    // A settle request is always followed by a need-driven one.
    for (let i = first + 1; i < kinds.length; i++)
      if (kinds[i - 1] === 'settle') expect(kinds[i]).toBe('need');
    expect(t.lookedBack.length).toBeGreaterThan(0);
    expect(t.settled.length).toBeGreaterThan(0);
  });

  it('need-first: the settle asks only when need-driven look-back has nothing to ask', () => {
    const run = (needFirst: boolean) => {
      const t = setup({ need: 100_000, csettle: 2, needFirst });
      for (let k = 0; k < 400; k++) {
        t.live(1);
        if (t.pending()) t.answer();
      }
      // Every settle request went out when need-driven look-back had nothing to ask for.
      const take = t.loop.lookbackTake as ReturnType<typeof vi.fn>;
      return { t, needEmpty: take.mock.results.filter((r) => r.value.length === 0).length };
    };
    const turns = run(false);
    const first = run(true);
    expect(first.t.settleRequests().length).toBeGreaterThan(0);
    expect(first.t.settleRequests().length).toBeLessThanOrEqual(first.needEmpty);
    expect(first.t.lookedBack.length).toBeGreaterThanOrEqual(turns.t.lookedBack.length);
    expect(first.t.settleRequests().length).toBeLessThan(turns.t.settleRequests().length);
  });
});

describe('settle during Discover: answers in pieces', () => {
  it('feeds an answer a few frames at a time, giving way in between', () => {
    const t = setup({ csettle: 2, yieldFrames: 4 });
    t.untilSettle();
    const fr = lookbackFrames(t.requests()[0].items).map((f) => f.frame);
    const fit = (n: number) => fr.slice(0, n).filter((f) => !held(f));
    t.answer();
    expect(t.settled).toEqual(fit(4));
    expect(t.deferred.length).toBe(1);
    expect(t.releases()).toBe(0);
    // Live batches come in between pieces; no second settle request while one is being fed.
    t.live(40);
    expect(t.settleRequests().length).toBe(1);
    t.deferred.shift()!();
    expect(t.settled).toEqual(fit(8));
    t.deferred.shift()!();
    t.deferred.shift()!();
    expect(t.settled).toEqual(fit(16));
    expect(t.deferred.length).toBe(0);
    // Done: the buffer goes back, and the next request goes out (a chunk was owed meanwhile).
    expect(t.releases()).toBe(1);
    expect(t.settleRequests().length).toBe(2);
    t.live(1);
    expect(t.status().csettle).toMatchObject({ yieldFrames: 4, answers: 1, fit: fit(16).length });
  });
});

describe('settle during Discover: the end of Discover', () => {
  it('stops at the last frame; the end settle runs as without it and the count stays', () => {
    const t = setup({ csettle: 2, yieldFrames: 4 });
    t.untilSettle();
    t.answer();
    const fedBefore = t.settled.length;
    // The last frame arrives while an answer is half fed and a request is out.
    t.live(40);
    t.r.handle({ type: 'end', session: 1 });
    // The piece left over does nothing; its buffer went back.
    while (t.deferred.length) t.deferred.shift()!();
    expect(t.settled.length).toBe(fedBefore);
    expect(t.releases()).toBe(1);
    const taken = (t.loop.settleTake as ReturnType<typeof vi.fn>).mock.calls.length;
    // The end settle: plain requests (no skip), every frame through `observe`.
    let n = 0;
    while (t.pending() && n < 1000) {
      t.answer();
      while (t.deferred.length) t.deferred.shift()!();
      n++;
    }
    expect((t.loop.settleTake as ReturnType<typeof vi.fn>).mock.calls.length).toBe(taken);
    expect(t.settled.length).toBe(fedBefore);
    const last = t.toMain.flatMap((m) => (m.type === 'status' ? [m.status] : [])).at(-1)!;
    expect(last.final).toBe(true);
    const frames = t.frameAt();
    expect(last.lookback!.settle).toMatchObject({ done: true, fed: frames, total: frames });
    const cs = last.lookback!.csettle!;
    expect(cs.fit).toBe(fedBefore);
    // 12 frames of the answer cut short are counted as dropped (and a request out, if any).
    expect(cs.requested).toBe(cs.fit + cs.heldOut + cs.dropped);
    expect(cs.live).toBe(frames);
  });
});

describe('settle during Discover: failures and edges', () => {
  const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('sends no settle read before the first library', () => {
    const t = setup({ csettle: 2, library: false });
    // Live batches for 40 s, but no library yet: nothing is owed.
    t.live(500);
    expect(t.status().csettle!.live).toBe(4000);
    expect(t.status().csettle!.governor).toMatchObject({ limit: 'waiting', credit: 0 });
    expect(t.settleRequests()).toEqual([]);
    expect(t.loop.settleTake).not.toHaveBeenCalled();
    t.gate.open = true;
    t.untilSettle();
  });

  it('a settle request that times out turns off the settle only', () => {
    const spy = warn();
    const t = setup({ need: 100_000, csettle: 2 });
    // Run until a settle request is the one out.
    for (let k = 0; k < 2000 && !(t.pending() && t.pending()!.skip); k++) {
      t.live(1);
      if (t.pending() && !t.pending()!.skip) t.answer();
    }
    expect(t.pending()!.skip).toBeDefined();
    const before = t.status().csettle!;
    t.timers.at(-1)!();
    const st = t.status();
    expect(st).not.toHaveProperty('error');
    expect(st.csettle!.dropped).toBe(before.dropped + CSETTLE.chunk);
    // Need-driven look-back goes on, and no further settle request goes out.
    const nSettle = t.settleRequests().length;
    const nAll = t.requests().length;
    for (let k = 0; k < 10; k++) {
      t.live(1);
      if (t.pending()) t.answer();
    }
    expect(t.requests().length).toBeGreaterThan(nAll);
    expect(t.settleRequests().length).toBe(nSettle);
    // The end settle still runs.
    t.r.handle({ type: 'end', session: 1 });
    let n = 0;
    while (t.pending() && n < 1000) {
      t.answer();
      while (t.deferred.length) t.deferred.shift()!();
      n++;
    }
    const last = t.toMain.flatMap((m) => (m.type === 'status' ? [m.status] : [])).at(-1)!;
    expect(last.final).toBe(true);
    expect(last.lookback!.settle).toMatchObject({ done: true });
    expect(last.lookback).not.toHaveProperty('error');
    spy.mockRestore();
  });

  it('a settle request answered with an error turns off the settle only', () => {
    const spy = warn();
    const t = setup({ need: 100_000, csettle: 2 });
    for (let k = 0; k < 2000 && !(t.pending() && t.pending()!.skip); k++) {
      t.live(1);
      if (t.pending() && !t.pending()!.skip) t.answer();
    }
    const req = t.pending()!;
    expect(req.skip).toBeDefined();
    t.r.handleLookback({ type: 'error', session: 1, id: req.id, message: 'boom' });
    expect(t.status()).not.toHaveProperty('error');
    const nSettle = t.settleRequests().length;
    for (let k = 0; k < 10; k++) {
      t.live(1);
      if (t.pending()) t.answer();
    }
    expect(t.settleRequests().length).toBe(nSettle);
    expect(t.lookedBack.length).toBeGreaterThan(0);
    // A need-driven error still stops look-back.
    const need = t.pending();
    if (need) {
      t.r.handleLookback({ type: 'error', session: 1, id: need.id, message: 'boom' });
      expect(t.status().error).toBe('boom');
    }
    spy.mockRestore();
  });

  it('a late settle answer after the end of Discover is released and ignored; its frames count as dropped', () => {
    const t = setup({ csettle: 2 });
    t.untilSettle();
    const old = t.pending()!;
    expect(old.skip).toBeDefined();
    t.r.handle({ type: 'end', session: 1 });
    const rel = t.releases();
    const n = lookbackFrames(old.items).length;
    t.r.handleLookback({
      type: 'frames',
      session: 1,
      id: old.id,
      version: 10,
      count: n,
      cells: 1,
      frames: new Float32Array(2 * n),
      traces: new Float32Array(n),
    });
    expect(t.releases()).toBe(rel + 1);
    expect(t.settled).toEqual([]);
    const last = t.toMain.flatMap((m) => (m.type === 'status' ? [m.status] : [])).at(-1)!;
    const cs = last.lookback!.csettle!;
    expect(cs.dropped).toBe(CSETTLE.chunk);
    expect(cs.requested).toBe(cs.fit + cs.heldOut + cs.dropped);
  });

  it('a reset while an answer is part-fed releases it and sends nothing more', () => {
    const t = setup({ csettle: 2, yieldFrames: 4 });
    t.untilSettle();
    t.answer();
    expect(t.deferred.length).toBe(1);
    expect(t.releases()).toBe(0);
    const sent = t.requests().length;
    const fed = t.settled.length;
    t.r.handle({ type: 'reset', session: 1 });
    // (The runner is back to nothing: the next piece does nothing.)
    while (t.deferred.length) t.deferred.shift()!();
    expect(t.settled.length).toBe(fed);
    expect(t.requests().length).toBe(sent);
  });

  it('the end of Discover with an answer part-fed: released, counted, nothing more sent', () => {
    const t = setup({ csettle: 2, yieldFrames: 4 });
    t.untilSettle();
    t.answer();
    const requests = t.settleRequests().length;
    t.r.handle({ type: 'end', session: 1 });
    expect(t.releases()).toBe(1);
    while (t.deferred.length) t.deferred.shift()!();
    expect(t.releases()).toBe(1);
    expect(t.settleRequests().length).toBe(requests);
    const last = t.toMain.flatMap((m) => (m.type === 'status' ? [m.status] : [])).at(-1)!;
    const cs = last.lookback!.csettle!;
    expect(cs.requested).toBe(cs.fit + cs.heldOut + cs.dropped);
  });
});
