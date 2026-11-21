// @vitest-environment node
/**
 * Settle during Discover (experimental, frames only; `SlowInit.csettle`):
 * the runner's dose, its requests to the look-back worker, and what reaches
 * the slow loop.
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
function fakeLoop(need: number, settle = true) {
  let credit = 0;
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
    step: vi.fn(() => undefined),
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
  o: { need?: number; csettle?: number; yieldFrames?: number; settle?: boolean; lb?: boolean } = {},
) {
  const f = fakeLoop(o.need ?? 0, o.settle ?? true);
  const toMain: SlowToMain[] = [];
  const toFast: SlowToFast[] = [];
  const toLb: SlowToLookback[] = [];
  const deferred: (() => void)[] = [];
  const created: SlowInit[] = [];
  const r = new SlowRunner({
    create: (init) => {
      created.push(init);
      return f.loop;
    },
    toFast: { postMessage: (m) => toFast.push(m) },
    toMain: { postMessage: (m) => toMain.push(m) },
    lookback: { postMessage: (m) => toLb.push(m) },
    now: () => 0,
    defer: (fn) => deferred.push(fn),
    timer: () => () => {},
  });
  r.handle({
    ...INIT,
    ...(o.lb === false ? { lookback: undefined } : {}),
    ...(o.csettle !== undefined ? { csettle: o.csettle } : {}),
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
    for (let k = 0; k < n; k++, at += 8) r.handle(frames(at));
  };
  const status = () =>
    toMain.flatMap((m) => (m.type === 'status' ? [m.status] : [])).at(-1)!.lookback!;
  const settleRequests = () => requests().filter((q) => q.skip !== undefined);
  const releases = () => toLb.filter((m) => m.type === 'release').length;
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

  it('buildSlowLoop turns the engine side on only when asked', () => {
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
    expect(buildSlowLoop(Fake, { ...init, csettle: 0 }).settle).toBeNull();
    expect(buildSlowLoop(Fake, { ...init, csettle: 2 }).settle).toEqual([CSETTLE.chunk]);
  });
});

describe('settle during Discover: dose and requests', () => {
  it('asks for one chunk of saved frames once a whole chunk is owed, one request at a time', () => {
    const t = setup({ csettle: 2 });
    // 2 per live frame: the first batch of 8 owes 16, but nothing is saved yet.
    t.live(1);
    expect(t.seens).toEqual([0]);
    expect(t.requests()).toEqual([]);
    t.live(2);
    // Now 16 frames are saved: one request, of frames in a row among those seen.
    expect(t.requests().length).toBe(1);
    const q = t.requests()[0];
    const fr = lookbackFrames(q.items);
    expect(fr.length).toBe(CSETTLE.chunk);
    expect(fr.every((f, i) => f.frame === fr[0].frame + i && f.frame < 16)).toBe(true);
    // A block of its own: never the look-back scheduler's (>= 0) or the end settle's (-1 - run).
    expect(fr.every((f) => f.block < -1_000_000)).toBe(true);
    expect(Array.from(q.skip!)).toEqual(fr.map((f) => (held(f.frame) ? 1 : 0)));
    // More live frames: still one request out.
    t.live(20);
    expect(t.requests().length).toBe(1);
  });

  it('the ceiling: what the look-back worker cannot deliver is not saved up', () => {
    const t = setup({ csettle: 2 });
    // 1,000 live batches owe 16,000 frames; the worker answers nothing meanwhile.
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

  it('a worker that keeps up delivers the ceiling: 2, 1 or 0.5 per live frame', () => {
    for (const rate of CSETTLE.rates) {
      const t = setup({ csettle: rate });
      for (let k = 0; k < 400; k++) {
        t.live(1);
        while (t.pending()) t.answer();
      }
      t.live(1);
      const cs = t.status().csettle!;
      const reread = cs.fit + cs.heldOut + cs.dropped;
      expect(cs.rate).toBe(rate);
      expect(cs.live).toBe(401 * 8);
      // (One request may still be out.)
      expect(cs.requested - reread).toBe(t.pending() ? CSETTLE.chunk : 0);
      expect(reread / cs.live).toBeGreaterThan(rate * 0.97);
      expect(reread / cs.live).toBeLessThanOrEqual(rate);
    }
  });

  it('held-out frames never reach the slow loop; the rest go to the footprint statistics', () => {
    const t = setup({ csettle: 2 });
    t.live(3);
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
    t.live(3);
    t.answer(0);
    expect(t.settled).toEqual([]);
    t.live(1);
    expect(t.status().csettle!.dropped).toBe(16);
    expect(t.releases()).toBe(1);
  });

  it('takes turns with need-driven look-back when both have frames to ask for', () => {
    const t = setup({ need: 10_000, csettle: 2 });
    for (let k = 0; k < 40; k++) {
      t.live(1);
      if (t.pending()) t.answer();
    }
    const kinds = t.requests().map((q) => (q.skip ? 'settle' : 'need'));
    // (Before a whole chunk is saved only need-driven look-back has frames to ask for.)
    expect(kinds[0]).toBe('need');
    const first = kinds.indexOf('settle');
    expect(first).toBeGreaterThan(0);
    expect(kinds.length - first).toBeGreaterThan(20);
    for (let i = first + 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
    expect(t.lookedBack.length).toBeGreaterThan(0);
    expect(t.settled.length).toBeGreaterThan(0);
  });
});

describe('settle during Discover: answers in pieces', () => {
  it('feeds an answer a few frames at a time, giving way in between', () => {
    const t = setup({ csettle: 2, yieldFrames: 4 });
    t.live(3);
    const fr = lookbackFrames(t.requests()[0].items).map((f) => f.frame);
    const fit = (n: number) => fr.slice(0, n).filter((f) => !held(f));
    t.answer();
    expect(t.settled).toEqual(fit(4));
    expect(t.deferred.length).toBe(1);
    expect(t.releases()).toBe(0);
    // Live batches come in between pieces; no second settle request while one is being fed.
    t.live(4);
    expect(t.settleRequests().length).toBe(1);
    t.deferred.shift()!();
    expect(t.settled).toEqual(fit(8));
    t.deferred.shift()!();
    t.deferred.shift()!();
    expect(t.settled).toEqual(fit(16));
    expect(t.deferred.length).toBe(0);
    // Done: the buffer goes back, and the next request goes out.
    expect(t.releases()).toBe(1);
    expect(t.settleRequests().length).toBe(2);
    t.live(1);
    expect(t.status().csettle).toMatchObject({ yieldFrames: 4, answers: 1, fit: fit(16).length });
  });
});

describe('settle during Discover: the end of Discover', () => {
  it('stops at the last frame; the end settle runs as without it and the count stays', () => {
    const t = setup({ csettle: 2, yieldFrames: 4 });
    t.live(3);
    t.answer();
    const fedBefore = t.settled.length;
    // The last frame arrives while an answer is half fed and a request is out.
    t.live(4);
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
    expect(last.lookback!.settle).toMatchObject({ done: true, fed: 56, total: 56 });
    const cs = last.lookback!.csettle!;
    expect(cs.fit).toBe(fedBefore);
    // 12 frames of the answer cut short are counted as dropped.
    expect(cs.dropped).toBe(12);
    expect(cs.live).toBe(56);
  });
});
