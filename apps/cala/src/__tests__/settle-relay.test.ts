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
import { describe, expect, it } from 'vitest';
import type { LookbackPrepared } from '../lib/lookback-reader.ts';
import { LookbackService, type LookbackReaderLike } from '../lib/lookback-service.ts';
import { SETTLE } from '../lib/settle.ts';
import { SlowRunner } from '../lib/slow-runner.ts';
import { StagePool } from '../lib/stage-pool.ts';
import type { LookbackToSlow, SlowToLookback } from '../workers/lookback-types.ts';
import type { FastToSlow, OwnerToVisit, SlowToMain, VisitToOwner } from '../workers/slow-types.ts';
import { lcg } from './blob-movie.ts';
import { fakeLib, stubSlowLoop } from './slow-fixtures.ts';
import { DEFAULT_PARAMS } from './params-fixtures.ts';

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

/**
 * The slow loop: publishes a library at every step (as visits commit edits),
 * so a cue sent after an answer's observation, not before it, would take a
 * newer library (`librariesBeforeCues`).
 */
function fakeLoop() {
  let version = 10;
  const seen: { stream: number | undefined; version: number }[] = [];
  const loop = stubSlowLoop({
    observe: (_f, v, _t, _b, stream) => {
      seen.push({ stream, version: v });
      due++;
      return true;
    },
    step: () => fakeLib(++version),
    finalize: () => fakeLib(++version),
    cellCount: 1,
    footprintNoise: () => Float64Array.of(1, 0.1),
    footprintNoiseOn: () => 0.1,
    // With visit workers: a visit comes due with every observed frame, and a library at every
    // other housekeeping.
    takeJob: () => (due > 0 ? (due--, Uint8Array.of(1)) : undefined),
    housekeep: () => (++housekeeps % 2 === 0 ? fakeLib(++version) : undefined),
  });
  let housekeeps = 0;
  let due = 0;
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
    setParams: () => {},
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
async function settleRun(seed: number, finalDelayMs: number, visitWorkers = 0) {
  const rand = lcg(seed);
  const { loop, seen, nextVersion } = fakeLoop();
  const toMain: SlowToMain[] = [];
  /** What the slow worker posted to worker 0, in order (`library`, `request`, `solve`, ...). */
  const sent: SlowToLookback[] = [];
  /** Where in `sent` each answer reached the slow worker (the trigger of the next batch). */
  const arrivals: number[] = [];
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
  const toSlowPort = port<LookbackToSlow>(
    (m) => {
      if (m.type === 'frames') arrivals.push(sent.length);
      runner!.handleLookback(m, 0);
    },
    rand,
    3,
  );
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
    visits: Array.from({ length: visitWorkers }, (_, i) => {
      const back = port<VisitToOwner>((m) => runner!.handleVisit(i, m), rand, 6);
      return {
        postMessage: (m: OwnerToVisit) => {
          if (m.type === 'job')
            back.postMessage({ type: 'result', session: 1, bytes: m.bytes, ms: 1 });
        },
      };
    }),
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
    params: DEFAULT_PARAMS,
    budget: 1,
    ...(visitWorkers > 0 ? { settleVisitRate: 0.4 } : {}),
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
  return { seen: seen.slice(discover), sent, toMain, arrivals };
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

/**
 * Every cue went out where the one-request relay sent its request: at the
 * top of the handler of the answer before, so no library the slow worker
 * published while observing that answer comes between the answer and the
 * cue (the last batch's included, whose cue must not wait for the feed).
 */
function librariesBeforeCues(sent: SlowToLookback[], arrivals: number[]): number[] {
  const out: number[] = [];
  sent.forEach((m, i) => {
    if (m.type !== 'solve') return;
    const a = arrivals.filter((at) => at <= i).at(-1) ?? 0;
    out.push(sent.slice(a, i).filter((x) => x.type === 'library').length);
  });
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
      const cues = librariesBeforeCues(r.sent, r.arrivals);
      expect(cues).toEqual(cues.map(() => 0));
      // Libraries did change during the settle (the check has teeth).
      expect(new Set(r.seen.map((s) => s.version)).size).toBeGreaterThan(2);
    }
    // And so the same versions per frame under every schedule.
    for (const r of runs.slice(1)) expect(r.seen).toEqual(runs[0].seen);
  });

  it('with visit workers (answers observed in pieces, visits applied between them): the same frames in order, each solved with the library before its cue', async () => {
    for (const seed of [5, 6, 7]) {
      const r = await settleRun(seed, seed, 2);
      expect(r.seen.map((s) => s.stream)).toEqual([...Array(FRAMES).keys()]);
      const held = r.sent.filter((m) => m.type === 'request' && m.hold).length;
      expect(held).toBe(Math.ceil(FRAMES / SETTLE.batch) - 1);
      expect(r.sent.filter((m) => m.type === 'solve')).toHaveLength(held);
      // The cue goes out as its answer before begins (not when it arrived, if it waited).
      expect(r.seen.map((s) => s.version)).toEqual(expectedVersions(r.sent));
      expect(new Set(r.seen.map((s) => s.version)).size).toBeGreaterThan(2);
      // Every answer's buffer went back.
      expect(r.sent.filter((m) => m.type === 'release')).toHaveLength(held + 1);
    }
  });
});
