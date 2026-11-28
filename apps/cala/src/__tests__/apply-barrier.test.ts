// @vitest-environment node
/**
 * Repeatable runs (`RunCells.repeatable`): the apply barrier's ledger, the slow worker handing
 * out and applying at batch ends whatever order and time results arrive in, and the fast loop
 * adopting stamped libraries at a fixed frame.
 */
import { describe, expect, it, vi } from 'vitest';
import { APPLY_LAG_FRAMES, ApplyBarrier } from '../lib/apply-barrier.ts';
import { FastLoop, type TraceBackend } from '../lib/fast-loop.ts';
import { SlowRunner } from '../lib/slow-runner.ts';
import type { LookbackToSlow, SlowToLookback } from '../workers/lookback-types.ts';
import type {
  FastToSlow,
  OwnerToVisit,
  SlowToFast,
  SlowToMain,
  VisitToOwner,
} from '../workers/slow-types.ts';
import { fakeLib, INIT, stubSlowLoop } from './slow-fixtures.ts';

describe('ApplyBarrier', () => {
  it('applies in hand-out order at the due frame, whatever order answers arrive in', () => {
    const b = new ApplyBarrier<string>(16);
    const v0 = b.issue('visit', 0, 56);
    const l0 = b.issue('lookback', 0, 56, 7);
    const v1 = b.issue('visit', 1, 64);
    expect(b.ready(64)).toBe(true);
    expect(b.ready(72)).toBe(false);
    expect(b.arrive('visit', 1, 'v1')).toBe(true);
    expect(b.arrive('lookback', 0, 'l0', 8)).toBe(false);
    expect(b.arrive('lookback', 0, 'l0', 7)).toBe(true);
    expect(b.ready(72)).toBe(false);
    expect(b.arrive('visit', 0, 'v0')).toBe(true);
    expect(b.ready(72)).toBe(true);
    expect(b.takeDue(72).map((it) => [it.seq, it.result])).toEqual([
      [v0, 'v0'],
      [l0, 'l0'],
    ]);
    expect(b.takeDue(80).map((it) => it.seq)).toEqual([v1]);
    expect(b.size).toBe(0);
  });

  it('waits until everything due is back, and stops waiting on abort or cancel', async () => {
    const b = new ApplyBarrier<string>(16);
    b.issue('visit', 0, 0);
    b.issue('lookback', 0, 0, 3);
    let done = false;
    const w = b.wait(16).then(() => {
      done = true;
    });
    b.arrive('visit', 0, 'v');
    await Promise.resolve();
    expect(done).toBe(false);
    b.cancel('lookback', 0, 3);
    await w;
    expect(done).toBe(true);
    b.issue('visit', 1, 16);
    const w2 = b.wait(32);
    b.abort();
    await w2;
    expect(b.ready(Infinity)).toBe(true);
  });

  it('refuses to take an answer that is not back', () => {
    const b = new ApplyBarrier<string>(16);
    b.issue('visit', 0, 0);
    expect(() => b.takeDue(16)).toThrow();
  });
});

type Frames = Extract<FastToSlow, { type: 'frames' }>;

function frames(start: number, count = 8): Frames {
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

/**
 * A runner with two visit workers and a look-back worker that never answer by themselves: the
 * test delivers what they were sent (`deliver`). Every slow-loop call is logged in `calls`.
 */
function setup(o: { repeatable?: boolean; pace?: number; lookback?: boolean } = {}) {
  const calls: string[] = [];
  let job = 0;
  let housekeeps = 0;
  let version = 0;
  const loop = stubSlowLoop({
    observe: vi.fn((_f, _v, _t, _b, stream?: number) => {
      calls.push(`o${stream ?? ''}`);
      return true;
    }),
    takeJob: vi.fn(() => {
      job++;
      calls.push(`t${job}`);
      return Uint8Array.of(job);
    }),
    applyJob: vi.fn((bytes: Uint8Array) => {
      calls.push(`a${bytes[0]}`);
    }),
    housekeep: vi.fn(() => {
      housekeeps++;
      if (housekeeps % 3 !== 0) return undefined;
      calls.push(`p${++version}`);
      return fakeLib(version);
    }),
    lookbackTake: vi.fn(() => {
      calls.push('k');
      return Float64Array.of(job, 0, 1, 7);
    }),
    observeLookback: vi.fn((_f, _v, _t, _b, stream: number) => {
      calls.push(`l${stream}`);
      return true;
    }),
  });
  const sentVisits: { slot: number; bytes: Uint8Array }[] = [];
  const sentLb: Extract<SlowToLookback, { type: 'request' }>[] = [];
  const toFast: SlowToFast[] = [];
  const toMain: SlowToMain[] = [];
  const visits = [0, 1].map((slot) => ({
    postMessage: (m: OwnerToVisit) => {
      if (m.type === 'job') sentVisits.push({ slot, bytes: m.bytes });
    },
  }));
  const r = new SlowRunner({
    create: () => loop,
    toFast: { postMessage: (m) => toFast.push(m) },
    toMain: { postMessage: (m) => toMain.push(m) },
    visits,
    lookback: {
      postMessage: (m) => {
        if (m.type === 'request') sentLb.push(m);
      },
    },
    now: () => 0,
    epochNow: () => 0,
    defer: (fn) => fn(),
    timer: () => () => {},
  });
  r.setPace(o.pace ?? 60, false);
  r.handle({
    ...INIT,
    ...(o.lookback !== false ? { lookback: true } : {}),
    ...(o.repeatable !== false ? { repeatable: true } : {}),
  });
  /** Send back what the workers were sent so far (`order`: as sent, or the reverse). */
  function deliver(order: 'sent' | 'reverse'): void {
    const v = sentVisits.splice(0);
    const l = sentLb.splice(0);
    const answers: (() => void)[] = [
      ...v.map(({ slot, bytes }) => () => {
        const m: VisitToOwner = { type: 'result', session: 1, bytes, ms: 1 };
        r.handleVisit(slot, m);
      }),
      ...l.map((req) => () => {
        const n = req.items.length / 4;
        const m: LookbackToSlow = {
          type: 'frames',
          session: 1,
          id: req.id,
          version: 1,
          count: n,
          cells: 0,
          frames: new Float32Array(2 * n),
          traces: new Float32Array(0),
        };
        r.handleLookback(m, 0);
      }),
    ];
    if (order === 'reverse') answers.reverse();
    for (const a of answers) a();
  }
  return { r, calls, toFast, toMain, deliver, sentVisits, sentLb };
}

const pause = () => Promise.resolve();
const tick = () => new Promise<void>((res) => setTimeout(res, 0));

/**
 * Ten batches. `eager`: every answer comes right after the batch that sent it, in order. `late`:
 * answers come only once the next batch is being handled, in reverse order, so the barrier
 * often has to wait for them.
 */
async function drive(policy: 'eager' | 'late', o: Parameters<typeof setup>[0] = {}) {
  const t = setup(o);
  for (let b = 0; b < 10; b++) {
    const p = t.r.handleAsync(frames(48 + 8 * b), pause);
    if (policy === 'late') {
      await tick();
      t.deliver('reverse');
    }
    await p;
    if (policy === 'eager') t.deliver('sent');
  }
  return t;
}

describe('SlowRunner apply barrier', () => {
  it('makes the same slow-loop calls whatever order and time results arrive in', async () => {
    const a = await drive('eager');
    const b = await drive('late');
    expect(a.calls.filter((c) => c.startsWith('a')).length).toBeGreaterThan(4);
    expect(a.calls.filter((c) => c.startsWith('l')).length).toBeGreaterThan(2);
    expect(b.calls).toEqual(a.calls);
    // Libraries are stamped with the batch they were published at, the same in both.
    const stamps = (t: typeof a) =>
      t.toFast.flatMap((m) => (m.type === 'library' ? [[m.version, m.frame]] : []));
    expect(stamps(a).length).toBeGreaterThan(0);
    expect(stamps(b)).toEqual(stamps(a));
    for (const [, frame] of stamps(a)) expect((frame! - 48) % 8).toBe(0);
  });

  it('applies results the lag after hand-out, not on arrival', async () => {
    const t = setup();
    await t.r.handleAsync(frames(48), pause);
    expect(t.calls.filter((c) => c.startsWith('t'))).toEqual(['t1', 't2']);
    t.deliver('sent');
    expect(t.calls.some((c) => c.startsWith('a') || c.startsWith('l'))).toBe(false);
    // One batch later: not due yet (the lag is two batches).
    await t.r.handleAsync(frames(56), pause);
    expect(APPLY_LAG_FRAMES).toBe(16);
    expect(t.calls.some((c) => c.startsWith('a') || c.startsWith('l'))).toBe(false);
    // No new hand-out while both slots are out, and no second look-back request.
    expect(t.calls.filter((c) => c === 'k')).toHaveLength(1);
    await t.r.handleAsync(frames(64), pause);
    const i = t.calls.lastIndexOf('o71');
    expect(t.calls.slice(i + 1, i + 6)).toEqual(['a1', 'a2', 'l2', 'p1', 't3']);
  });

  it('waits at the batch end for a late result', async () => {
    const t = setup();
    await t.r.handleAsync(frames(48), pause);
    await t.r.handleAsync(frames(56), pause);
    let done = false;
    const p = t.r.handleAsync(frames(64), pause).then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    // The ack of the waiting batch is not sent yet.
    expect(t.toFast.filter((m) => m.type === 'ack')).toHaveLength(2);
    t.deliver('reverse');
    await p;
    expect(done).toBe(true);
    const status = t.toMain.filter((m) => m.type === 'status').at(-1);
    expect(status?.type === 'status' && status.status.repeatable?.barrierWaits).toBe(1);
  });

  it('stops waiting when the run is reset', async () => {
    const t = setup();
    await t.r.handleAsync(frames(48), pause);
    await t.r.handleAsync(frames(56), pause);
    const p = t.r.handleAsync(frames(64), pause);
    await tick();
    t.r.abortBarrier(1);
    await p;
    t.r.handle({ type: 'reset', session: 2 });
    expect(t.calls.some((c) => c.startsWith('a'))).toBe(false);
  });

  it("at Discover's end applies the visits out in order before the final library", async () => {
    const t = setup({ lookback: false });
    await t.r.handleAsync(frames(48), pause);
    const end = t.r.handleAsync({ type: 'end', session: 1 }, pause);
    await tick();
    t.deliver('reverse');
    await end;
    const fin = t.calls.length;
    expect(t.calls.slice(fin - 2)).toEqual(['a1', 'a2']);
    const libs = t.toFast.filter((m) => m.type === 'library');
    // The final library is not stamped (the fast loop is done with Discover).
    expect(libs.at(-1)).not.toHaveProperty('frame');
  });

  it('adds history-review candidates once the visits out are applied, then hands out again', async () => {
    const t = setup({ lookback: false });
    const added: number[] = [];
    const loop = (t.r as unknown as { loop: { addReviewed: (c: Float32Array) => number } }).loop;
    loop.addReviewed = (c) => {
      added.push(c.length);
      t.calls.push('r');
      return c.length;
    };
    await t.r.handleAsync(frames(48), pause);
    t.r.handleReviewed({ type: 'reviewed', session: 1, candidates: new Float32Array(3) });
    expect(added).toEqual([]);
    t.deliver('sent');
    await t.r.handleAsync(frames(56), pause);
    await t.r.handleAsync(frames(64), pause);
    const i = t.calls.lastIndexOf('o');
    expect(t.calls.slice(i + 1)).toEqual(['a1', 'a2', 'p1', 'r', 't3', 't4']);
  });

  it('applies on arrival from a dropped batch on', async () => {
    const t = setup();
    await t.r.handleAsync(frames(48), pause);
    // Frames 56..63 never came: the batch from 64 ends the barrier, after the items out.
    const p = t.r.handleAsync(frames(64), pause);
    await tick();
    t.deliver('sent');
    await p;
    expect(t.calls.filter((c) => c.startsWith('a'))).toEqual(['a1', 'a2']);
    t.deliver('sent');
    // Applied on arrival now.
    expect(t.calls.filter((c) => c.startsWith('a'))).toEqual(['a1', 'a2', 'a3', 'a4']);
    const status = t.toMain.filter((m) => m.type === 'status').at(-1);
    expect(status?.type === 'status' && status.status.repeatable?.lostAt).toBe(56);
  });

  it('applies on arrival when the run is not repeatable, or at Max', async () => {
    for (const o of [{ repeatable: false }, { pace: 0 }]) {
      const t = setup(o);
      await t.r.handleAsync(frames(48), pause);
      t.deliver('sent');
      expect(t.calls.filter((c) => c.startsWith('a'))).toEqual(['a1', 'a2']);
      const a = await drive('eager', o);
      const b = await drive('late', o);
      // (Without the barrier the arrival schedule shows in the calls.)
      expect(b.calls).not.toEqual(a.calls);
      expect(a.toFast.some((m) => m.type === 'library' && m.frame !== undefined)).toBe(false);
    }
  });
});

describe('FastLoop stamped libraries', () => {
  function fastLoop() {
    const swaps: number[] = [];
    const backend: TraceBackend = {
      libraryFromBytes: (bytes) => ({ version: bytes[0], ids: () => Uint32Array.of(1), free() {} }),
      newEngine(l) {
        swaps.push(l.version);
        return {
          setLibrary: (n) => swaps.push(n.version),
          processFrames: (_f, count) => new Float32Array(count),
          lastBackground: () => new Float32Array(0),
          free() {},
        };
      },
    };
    const port = { postMessage: vi.fn() };
    const fl = new FastLoop(
      {
        width: 2,
        height: 2,
        batchSize: 8,
        session: 5,
        cellDiameterPx: 10,
        flattenSigmaPx: 0,
        poolSize: 2,
        qc: false,
      },
      port,
      backend,
    );
    return { fl, swaps, port };
  }
  const calibration = {
    fovMask: () => new Uint8Array(4).fill(1),
    noiseSigma: () => new Float32Array(4).fill(1),
  };

  it('adopts a stamped library at its frame, the newest due one first', () => {
    const { fl } = fastLoop();
    const px = new Float32Array(32);
    expect(fl.adoptFrame(56)).toBe(56 + 3 * 8);
    fl.process(px, 48, 8, calibration);
    fl.handleSlow({ type: 'library', session: 5, version: 2, bytes: Uint8Array.of(2), frame: 56 });
    fl.handleSlow({ type: 'library', session: 5, version: 3, bytes: Uint8Array.of(3), frame: 64 });
    const versions: number[] = [];
    for (let s = 56; s < 104; s += 8) versions.push(fl.process(px, s, 8, calibration).version);
    // 56 + 24 = 80 for v2, 64 + 24 = 88 for v3.
    expect(versions).toEqual([0, 0, 0, 2, 3, 3]);
  });

  it('adopts a late stamped library at the next batch and counts it', () => {
    const { fl, port } = fastLoop();
    const px = new Float32Array(32);
    for (let s = 48; s < 96; s += 8) {
      fl.process(px, s, 8, calibration);
      fl.handleSlow({
        type: 'ack',
        session: 5,
        frames: px.slice(),
        start: s,
        count: 8,
        observed: 8,
      });
    }
    fl.handleSlow({ type: 'library', session: 5, version: 2, bytes: Uint8Array.of(2), frame: 56 });
    expect(fl.process(px, 96, 8, calibration).version).toBe(2);
    const sent = port.postMessage.mock.calls
      .map((c) => c[0] as FastToSlow)
      .filter((m) => m.type === 'frames');
    expect(sent.at(-1)).toMatchObject({ lateLibraries: 1 });
  });

  it('adopts an unstamped library at the next batch, as before', () => {
    const { fl } = fastLoop();
    const px = new Float32Array(32);
    fl.process(px, 48, 8, calibration);
    fl.handleSlow({ type: 'library', session: 5, version: 2, bytes: Uint8Array.of(2) });
    expect(fl.process(px, 56, 8, calibration).version).toBe(2);
  });
});
