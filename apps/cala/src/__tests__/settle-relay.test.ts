// @vitest-environment node
/**
 * The end settle's relay, the slow worker (`SlowRunner`) and look-back
 * worker 0 (`LookbackService`) wired by scripted ports: messages arrive in
 * order per port, each after a random delay, as between two threads. The
 * settle prepares the next request ahead and cues its solve; these tests
 * hold it to the rule of the one-request relay it replaced: the same frames
 * in the same order, each batch solved with the newest library the slow
 * worker had posted before the point where that batch's request used to go
 * out (its cue now; the first batch's request itself).
 */
import { describe, expect, it, vi } from 'vitest';
import type { LookbackPrepared } from '../lib/lookback-reader.ts';
import { LookbackService, type LookbackReaderLike } from '../lib/lookback-service.ts';
import { SETTLE } from '../lib/settle.ts';
import { SlowRunner, type PublishedLibrary, type SlowLoopLike } from '../lib/slow-runner.ts';
import { StagePool } from '../lib/stage-pool.ts';
import type { LookbackToSlow, SlowToLookback } from '../workers/lookback-types.ts';
import type { FastToSlow, SlowToMain } from '../workers/slow-types.ts';

/** A small seeded generator (the delays of a schedule). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A port: in order, each message a random 0..`maxMs` ms after the one before is delivered. */
function port<T>(deliver: (m: T) => void, rand: () => number, maxMs: number) {
  let chain = Promise.resolve();
  return {
    postMessage(m: T) {
      const wait = Math.floor(rand() * (maxMs + 1));
      chain = chain
        .then(() => new Promise<void>((r) => setTimeout(r, wait)))
        .then(() => deliver(m));
    },
  };
}

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

/** The slow loop: publishes a library every third step (as visits commit edits). */
function fakeLoop() {
  let version = 10;
  let steps = 0;
  const seen: { stream: number | undefined; version: number }[] = [];
  const loop: SlowLoopLike = {
    observe: (_f, v, _t, _b, stream) => {
      seen.push({ stream, version: v });
      return true;
    },
    step: () => (++steps % 3 === 0 ? fakeLib(++version) : undefined),
    finalize: () => fakeLib(++version),
    setNoise: () => {},
    setEditScope: () => {},
    cellCount: 1,
    reservoirBytes: 0,
    stats: () => new Float64Array(17),
    free: () => {},
    enableLookback: () => {},
    lookbackNote: () => {},
    lookbackAddCredit: () => {},
    lookbackTake: () => new Float64Array(0),
    lookbackIdle: true,
    observeLookback: () => true,
    markAllDue: () => {},
    lookbackStats: () => new Float64Array(7),
    footprintNoise: () => Float64Array.of(1, 0.1),
    footprintNoiseOn: () => 0.1,
  };
  /** A version as the loop's next publish would have it. */
  const nextVersion = () => ++version;
  return { loop, seen, nextVersion };
}

/** A reader as `LookbackReader` keeps libraries; reading takes a random while. */
function fakeReader(rand: () => number) {
  let pending = 0;
  let version = 0;
  const reader: LookbackReaderLike = {
    pushRows: () => {},
    setBackState: () => {},
    setSession: () => {},
    setFlatField: () => {},
    setLibrary: (v) => {
      if (v > version && v > pending) pending = v;
    },
    applyLibrary: () => {
      if (pending > version) version = pending;
      pending = 0;
    },
    async prepare(frames, out): Promise<LookbackPrepared> {
      await new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));
      return {
        count: frames.length,
        out,
        timing: { readMs: 0, preprocessMs: 0, solveMs: 0, otherMs: 0, waitMs: 0 },
      };
    },
    solve: (p) => ({
      version,
      cells: 1,
      traces: new Float32Array(p.count),
      timing: { readMs: 0, preprocessMs: 0, solveMs: 0, otherMs: 0, waitMs: 0 },
    }),
    async serve(frames, out, skip) {
      reader.applyLibrary();
      return reader.solve(await reader.prepare(frames, out), skip);
    },
    dispose: () => {},
  };
  return reader;
}

const FRAMES = 6 * SETTLE.batch + 5;

/** One Discover run of `FRAMES` frames and its end settle, under schedule `seed`. */
async function settleRun(seed: number, finalDelayMs: number) {
  const rand = lcg(seed);
  const { loop, seen, nextVersion } = fakeLoop();
  const toMain: SlowToMain[] = [];
  /** What the slow worker posted to worker 0, in order (`library`, `request`, `solve`, ...). */
  const sent: SlowToLookback[] = [];
  let runner: SlowRunner | null = null;
  const service = new LookbackService({
    open: () => {
      const reader = fakeReader(rand);
      return Promise.resolve({
        server: reader,
        reader,
        pool: new StagePool(3, 2 * SETTLE.batch),
      });
    },
    factorServer: () => {
      throw new Error('no factors here');
    },
    postSlow: (m) => toSlowPort.postMessage(m),
    postMain: () => {},
  });
  const toSlowPort = port<LookbackToSlow>((m) => runner!.handleLookback(m, 0), rand, 3);
  let finalSent = false;
  const toLbPort = port<SlowToLookback>(
    (m) => {
      service.handleSlow(m);
      // The main thread's `final` comes some time after the settle's first request is in.
      if (m.type === 'request' && m.final && !finalSent) {
        finalSent = true;
        setTimeout(() => service.handleMain({ type: 'final', session: 1 }), finalDelayMs);
      }
    },
    rand,
    3,
  );
  runner = new SlowRunner({
    create: () => loop,
    toFast: { postMessage: () => {} },
    toMain: { postMessage: (m) => toMain.push(m) },
    visits: [],
    lookback: {
      postMessage: (m: SlowToLookback) => {
        sent.push(m);
        toLbPort.postMessage(m);
      },
    },
    now: () => 0,
    defer: (fn) => setTimeout(fn, 0),
    timer: () => () => {},
  });
  service.handleMain({ type: 'begin', session: 1, source: { entries: [] } });
  const init: Extract<FastToSlow, { type: 'init' }> = {
    type: 'init',
    session: 1,
    width: 2,
    height: 1,
    fov: Uint8Array.of(1, 1),
    noise: Float32Array.of(1, 1),
    cellDiameterPx: 10,
    flattenSigmaPx: 0,
    budget: 1,
    lookback: true,
  };
  runner.handle(init);
  runner.handle({
    type: 'frames',
    session: 1,
    start: 0,
    count: FRAMES,
    version: 0,
    cells: 0,
    frames: new Float32Array(2 * FRAMES),
    traces: new Float32Array(0),
  });
  const discover = seen.length;
  runner.handle({ type: 'end', session: 1 });
  // A library the slow worker publishes while the first request waits for final inputs (visits
  // still out at the end of Discover commit): it came after that request, so it is not its library.
  const late: SlowToLookback = {
    type: 'library',
    session: 1,
    version: nextVersion(),
    bytes: new Uint8Array(0),
  };
  sent.push(late);
  toLbPort.postMessage(late);
  for (let k = 0; k < 2000 && !toMain.some((m) => m.type === 'status' && m.status.final); k++)
    await new Promise((r) => setTimeout(r, 1));
  return { seen: seen.slice(discover), sent, toMain };
}

/**
 * Per settle frame, the version the one-request relay solved it with: the
 * newest library posted before its request's trigger (the cue of a held
 * request, else the request).
 */
function expectedVersions(sent: SlowToLookback[]): number[] {
  const reqs = new Map<number, number>();
  for (const m of sent) if (m.type === 'request') reqs.set(m.id, m.items.length / 3);
  const out: number[] = [];
  let newest = 0;
  const held = new Set<number>();
  for (const m of sent) {
    if (m.type === 'library') newest = Math.max(newest, m.version);
    else if (m.type === 'request' && m.hold) held.add(m.id);
    else if (m.type === 'request' || m.type === 'solve')
      for (let k = 0; k < reqs.get(m.id)!; k++) out.push(newest);
  }
  return out;
}

describe('end settle relay (prepare ahead, solve on cue)', () => {
  it('same frames in the same order, each solved with the library of the one-request relay', async () => {
    const runs = [];
    for (const [seed, finalDelay] of [
      [1, 0],
      [2, 7],
      [3, 2],
      [4, 15],
    ])
      runs.push(await settleRun(seed, finalDelay));
    for (const r of runs) {
      expect(r.seen.map((s) => s.stream)).toEqual([...Array(FRAMES).keys()]);
      // Every batch after the first was prepared ahead (held) and cued.
      const held = r.sent.filter((m) => m.type === 'request' && m.hold).length;
      expect(held).toBe(Math.ceil(FRAMES / SETTLE.batch) - 1);
      expect(r.sent.filter((m) => m.type === 'solve')).toHaveLength(held);
      expect(r.seen.map((s) => s.version)).toEqual(expectedVersions(r.sent));
      // Libraries did change during the settle (the check has teeth).
      expect(new Set(r.seen.map((s) => s.version)).size).toBeGreaterThan(2);
    }
    // And so the same versions per frame under every schedule.
    for (const r of runs.slice(1)) expect(r.seen).toEqual(runs[0].seen);
  });
});
