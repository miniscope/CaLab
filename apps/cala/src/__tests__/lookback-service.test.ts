// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FrameServer } from '../lib/factor-reader.ts';
import type { LookbackPrepared } from '../lib/lookback-reader.ts';
import { LookbackService, type LookbackReaderLike } from '../lib/lookback-service.ts';
import { StagePool } from '../lib/stage-pool.ts';
import type { FlatFieldMap } from '../lib/flat-field.ts';
import type { LookbackToSlow, MainToLookback, SlowToLookback } from '../workers/lookback-types.ts';

/** A macrotask later (a message from another thread arriving later). */
const later = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A fake reader: what a frame is preprocessed from (the newest back state
 * and flat map it had then), and libraries as `LookbackReader` keeps them
 * (the newest in hand is applied by `applyLibrary`).
 */
function fakeReader() {
  let back = 'none';
  let flat = 'none';
  let pending = 0;
  let version = 0;
  const prepared: { frames: number[]; back: string; flat: string }[] = [];
  const events: string[] = [];
  const reader: LookbackReaderLike = {
    pushRows: () => {},
    setBackState: (s) => {
      back = `back${s[0]}`;
    },
    setSession: () => {},
    setFlatField: (m) => {
      flat = m ? `flat${m.dark}` : 'none';
    },
    setLibrary: (v) => {
      if (v > version && v > pending) pending = v;
    },
    applyLibrary: () => {
      if (pending > version) version = pending;
      pending = 0;
    },
    async prepare(frames, out): Promise<LookbackPrepared> {
      // Reading takes a while (the file), as in the worker.
      await later();
      prepared.push({ frames: frames.map((f) => f.frame), back, flat });
      events.push(`prepare:${frames[0]?.frame}`);
      return {
        count: frames.length,
        out,
        timing: { readMs: 0, preprocessMs: 0, solveMs: 0, otherMs: 0, waitMs: 0 },
      };
    },
    solve(p) {
      events.push(`solve:v${version}`);
      return {
        version,
        cells: 1,
        traces: new Float32Array(p.count),
        timing: { readMs: 0, preprocessMs: 0, solveMs: 0, otherMs: 0, waitMs: 0 },
      };
    },
    async serve(frames, out, skip) {
      reader.applyLibrary();
      return reader.solve(await reader.prepare(frames, out), skip);
    },
    dispose: () => {},
  };
  return { reader, prepared, events };
}

async function setup() {
  const f = fakeReader();
  const toSlow: LookbackToSlow[] = [];
  const pool = new StagePool(3, 4);
  const s: LookbackService = new LookbackService({
    open: () => Promise.resolve({ server: f.reader, reader: f.reader, pool }),
    factorServer: () => {
      throw new Error('no factors here');
    },
    postSlow: (m) => {
      toSlow.push(m);
      // The slow worker observes an answer and gives its buffer back.
      if (m.type === 'frames')
        setTimeout(() => s.handleSlow({ type: 'release', session: m.session, frames: m.frames }));
    },
    postMain: () => {},
  });
  const main = (m: Exclude<MainToLookback, { type: 'connect' }>) => s.handleMain(m);
  main({ type: 'begin', session: 1, source: { entries: [] } });
  // (The worker has taken in the `begin` before any request: the main thread sent it at the start.)
  await settle();
  let id = 0;
  const request = (frames: number[], opts: { final?: boolean; hold?: boolean } = {}) => {
    const items = Float64Array.from(frames.flatMap((fr) => [fr, -1, 0]));
    const m: SlowToLookback = { type: 'request', session: 1, id: ++id, items, ...opts };
    s.handleSlow(m);
    return id;
  };
  const backState = (k: number) =>
    main({ type: 'back-state', session: 1, frame: 100, state: Uint8Array.of(k) });
  const flatMap = (k: number) =>
    main({ type: 'flat', session: 1, map: { dark: k } as unknown as FlatFieldMap });
  return { s, ...f, toSlow, pool, main, request, backState, flatMap };
}

/** Wait until the service has nothing left that can move (a few macrotasks). */
async function settle() {
  for (let k = 0; k < 20; k++) await later();
}

describe('LookbackService: the end settle waits for final inputs', () => {
  /**
   * Discover's last back state and the flat field's last map reach the worker
   * at some time during the settle, depending on the machine; with `final`
   * the settle's frames are preprocessed from the same inputs whatever that time.
   */
  async function settleRun(delayMs: number | null, gate: boolean) {
    const t = await setup();
    t.backState(1);
    t.flatMap(1);
    await settle();
    const send = async () => {
      // The last ones (stage C's final state; the estimator's last refine), then `final`.
      t.backState(2);
      t.flatMap(2);
      t.main({ type: 'final', session: 1 });
    };
    if (delayMs === 0) await send();
    for (let k = 0; k < 4; k++) t.request([16 * k, 16 * k + 1], { final: gate });
    if (delayMs !== null && delayMs > 0) {
      await later(delayMs);
      await send();
    }
    await settle();
    return t;
  }

  it('preprocesses every settle frame from the final inputs, however late they arrive', async () => {
    const early = await settleRun(0, true);
    const late = await settleRun(5, true);
    expect(late.prepared).toEqual(early.prepared);
    expect(early.prepared).toHaveLength(4);
    for (const p of early.prepared) expect([p.back, p.flat]).toEqual(['back2', 'flat2']);
    expect(late.toSlow.map((m) => m.type)).toEqual(['frames', 'frames', 'frames', 'frames']);
    // The wait is reported with the answer (instrumentation).
    const first = late.toSlow[0];
    expect(first.type === 'frames' && first.timing?.finalWaitMs).toBeGreaterThan(0);
  });

  it('without the gate the late inputs reach only the later frames (the race it removes)', async () => {
    const early = await settleRun(0, false);
    const late = await settleRun(5, false);
    expect(late.prepared).not.toEqual(early.prepared);
    expect(late.prepared[0]).toMatchObject({ back: 'back1', flat: 'flat1' });
  });

  it('a request without `final` does not wait', async () => {
    const t = await setup();
    t.backState(1);
    t.request([3]);
    await settle();
    expect(t.toSlow).toHaveLength(1);
    expect(t.prepared[0].back).toBe('back1');
  });

  it('a reset lets a request waiting for final inputs go, and the next run is served', async () => {
    const t = await setup();
    t.request([1], { final: true });
    await settle();
    expect(t.toSlow).toHaveLength(0);
    t.main({ type: 'reset', session: 1 });
    t.main({ type: 'begin', session: 2, source: { entries: [] } });
    await settle();
    t.s.handleSlow({ type: 'request', session: 2, id: 9, items: Float64Array.of(5, -1, 0) });
    await settle();
    expect(t.toSlow.map((m) => [m.type, m.id])).toEqual([['frames', 9]]);
  });
});

describe('LookbackService: held requests', () => {
  it('prepares at once, solves on its cue with the newest library that came before the cue', async () => {
    const t = await setup();
    t.main({ type: 'final', session: 1 });
    t.s.handleSlow({ type: 'library', session: 1, version: 5, bytes: new Uint8Array(0) });
    const a = t.request([0], { final: true });
    const b = t.request([16], { final: true, hold: true });
    await settle();
    // `a` answered with version 5; `b` prepared, waiting.
    expect(t.toSlow.map((m) => [m.id, m.type === 'frames' && m.version])).toEqual([[a, 5]]);
    expect(t.events).toEqual(['prepare:0', 'solve:v5', 'prepare:16']);
    t.s.handleSlow({ type: 'library', session: 1, version: 6, bytes: new Uint8Array(0) });
    t.s.handleSlow({ type: 'solve', session: 1, id: b });
    // A library after the cue is not this request's.
    t.s.handleSlow({ type: 'library', session: 1, version: 7, bytes: new Uint8Array(0) });
    await settle();
    expect(t.toSlow.map((m) => [m.id, m.type === 'frames' && m.version])).toEqual([
      [a, 5],
      [b, 6],
    ]);
  });

  it('a cue that comes while the request is still being prepared takes the libraries before it', async () => {
    const t = await setup();
    t.main({ type: 'final', session: 1 });
    t.s.handleSlow({ type: 'library', session: 1, version: 3, bytes: new Uint8Array(0) });
    const b = t.request([16], { final: true, hold: true });
    t.s.handleSlow({ type: 'solve', session: 1, id: b });
    t.s.handleSlow({ type: 'library', session: 1, version: 4, bytes: new Uint8Array(0) });
    await settle();
    expect(t.toSlow.map((m) => [m.id, m.type === 'frames' && m.version])).toEqual([[b, 3]]);
  });

  it('a dropped request is never answered, its buffer goes back, and the next one is served', async () => {
    const t = await setup();
    t.main({ type: 'final', session: 1 });
    const b = t.request([16], { final: true, hold: true });
    const c = t.request([32], { final: true });
    await settle();
    t.s.handleSlow({ type: 'drop', session: 1, id: b });
    await settle();
    expect(t.toSlow.map((m) => m.id)).toEqual([c]);
    // All three buffers are free again (the dropped request's too).
    const bufs = await Promise.all([t.pool.acquire(), t.pool.acquire(), t.pool.acquire()]);
    expect(new Set(bufs).size).toBe(3);
  });
});

/** A factor server (`FactorReader`): libraries applied in `serve`, nothing to prepare ahead. */
function fakeFactorServer(tag: string) {
  let pending = 0;
  let version = 0;
  const served: { tag: string; frames: number[]; version: number }[] = [];
  let disposed = false;
  const server: FrameServer = {
    setLibrary: (v) => {
      if (v > version && v > pending) pending = v;
    },
    async serve(frames) {
      await later();
      if (pending > version) version = pending;
      pending = 0;
      served.push({ tag, frames: frames.map((f) => f.frame), version });
      return {
        version,
        cells: 1,
        traces: new Float32Array(frames.length),
        timing: { readMs: 0, preprocessMs: 0, solveMs: 0, otherMs: 0, waitMs: 0 },
      };
    },
    dispose: () => {
      disposed = true;
    },
  };
  return { server, served, disposed: () => disposed };
}

const SRC = { folder: 'run-a', windows: [], width: 2, height: 2 };

describe('LookbackService on factors', () => {
  /** A service whose `begin` opens the recording (the fake reader) or a stream's factors. */
  async function factorSetup(onFactors: boolean) {
    const rec = fakeReader();
    const live = fakeFactorServer('begin');
    const swapped = fakeFactorServer('swap');
    const toSlow: LookbackToSlow[] = [];
    const pool = new StagePool(2, 4);
    const s: LookbackService = new LookbackService({
      open: () =>
        Promise.resolve(
          onFactors
            ? { server: live.server, reader: null, pool }
            : { server: rec.reader, reader: rec.reader, pool },
        ),
      factorServer: () => swapped.server,
      postSlow: (m) => {
        toSlow.push(m);
        if (m.type === 'frames')
          setTimeout(() => s.handleSlow({ type: 'release', session: m.session, frames: m.frames }));
      },
      postMain: () => {},
    });
    s.handleMain({
      type: 'begin',
      session: 1,
      source: onFactors ? { factors: SRC } : { entries: [] },
    });
    await settle();
    let id = 0;
    const request = (frames: number[], opts: { final?: boolean; hold?: boolean } = {}) => {
      const items = Float64Array.from(frames.flatMap((fr) => [fr, -1, 0]));
      s.handleSlow({ type: 'request', session: 1, id: ++id, items, ...opts });
      return id;
    };
    return { s, rec, live, swapped, toSlow, pool, request };
  }

  it("a stream's factor run (no recording, no `final` ever sent) answers every request and releases its buffers", async () => {
    const t = await factorSetup(true);
    t.s.handleSlow({ type: 'library', session: 1, version: 4, bytes: new Uint8Array(0) });
    // More requests than the pool has buffers: each answer's release lets the next one go.
    // A `final` flag never makes a factor request wait (the main thread sends no `final` here).
    for (let k = 0; k < 5; k++) t.request([16 * k], { final: k % 2 === 0 });
    await settle();
    expect(t.toSlow.map((m) => m.type)).toEqual(Array(5).fill('frames'));
    expect(t.live.served.map((s) => s.version)).toEqual([4, 4, 4, 4, 4]);
    // The recording's inputs go nowhere (there is no reader) and break nothing.
    t.s.handleMain({ type: 'back-state', session: 1, frame: 3, state: Uint8Array.of(1) });
    t.s.handleMain({ type: 'final', session: 1 });
    t.request([99]);
    await settle();
    expect(t.toSlow).toHaveLength(6);
    for (const m of t.toSlow) expect(m.type === 'frames' && m.timing?.finalWaitMs).toBeFalsy();
  });

  it('a held request on a factor server is served whole on its cue, or dropped without a buffer', async () => {
    const t = await factorSetup(true);
    t.s.handleSlow({ type: 'library', session: 1, version: 2, bytes: new Uint8Array(0) });
    const a = t.request([0], { hold: true });
    await settle();
    expect(t.toSlow).toHaveLength(0);
    t.s.handleSlow({ type: 'library', session: 1, version: 3, bytes: new Uint8Array(0) });
    t.s.handleSlow({ type: 'solve', session: 1, id: a });
    await settle();
    expect(t.toSlow.map((m) => [m.id, m.type === 'frames' && m.version])).toEqual([[a, 3]]);
    const b = t.request([16], { hold: true });
    t.s.handleSlow({ type: 'drop', session: 1, id: b });
    const c = t.request([32]);
    await settle();
    expect(t.toSlow.map((m) => m.id)).toEqual([a, c]);
    const bufs = await Promise.all([t.pool.acquire(), t.pool.acquire()]);
    expect(new Set(bufs).size).toBe(2);
  });

  it("a recording's switch to factors: requests after it never wait for `final`, the one before it does", async () => {
    const t = await factorSetup(false);
    t.s.handleSlow({ type: 'library', session: 1, version: 7, bytes: new Uint8Array(0) });
    // Before the switch (the file): waits for final inputs.
    const a = t.request([0], { final: true });
    t.s.handleSlow({ type: 'factors', session: 1, factors: SRC });
    const b = t.request([16], { final: true });
    await settle();
    expect(t.toSlow).toHaveLength(0);
    t.s.handleMain({ type: 'final', session: 1 });
    await settle();
    expect(t.toSlow.map((m) => m.id)).toEqual([a, b]);
    expect(t.rec.prepared.map((p) => p.frames)).toEqual([[0]]);
    // The new server got the newest library at the switch and solved with it.
    expect(t.swapped.served).toEqual([{ tag: 'swap', frames: [16], version: 7 }]);
    // Switched before any request: no wait at all.
    const u = await factorSetup(false);
    u.s.handleSlow({ type: 'factors', session: 1, factors: SRC });
    u.request([5], { final: true });
    await settle();
    expect(u.toSlow.map((m) => m.type)).toEqual(['frames']);
  });

  it('a reset disposes the recording and the server the switch put in its place', async () => {
    const t = await factorSetup(false);
    let readerDisposed = false;
    t.rec.reader.dispose = () => {
      readerDisposed = true;
    };
    t.s.handleSlow({ type: 'factors', session: 1, factors: SRC });
    await settle();
    t.s.handleMain({ type: 'reset', session: 1 });
    await settle();
    expect(readerDisposed).toBe(true);
    expect(t.swapped.disposed()).toBe(true);
  });
});
