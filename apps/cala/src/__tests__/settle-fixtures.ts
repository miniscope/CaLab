/**
 * The Final settle wired with fakes, for the settle tests: the slow worker (`SlowRunner`), scripted
 * look-back workers and visit workers, joined by ports that deliver each message after a random
 * delay, in order per port, as between threads. The slow loop is a fake whose tiles come due with
 * the frames it observes and which refuses a tile next to a visit out (as `take_job` does), so
 * what it hands out depends on when results come back. A look-back worker's traces depend on the
 * request it served before (as the trace solver's warm start does). Every slow-loop call that
 * changes its state is logged in order (`SettleRun.log`).
 */
import { expect } from 'vitest';
import { PACE_BATCH } from '../lib/frame-pacer.ts';
import { SETTLE } from '../lib/settle.ts';
import { SlowRunner } from '../lib/slow-runner.ts';
import type { LookbackToSlow, SettleStatus, SlowToLookback } from '../workers/lookback-types.ts';
import type { FastToSlow, OwnerToVisit, SlowToMain } from '../workers/slow-types.ts';
import { lcg } from './blob-movie.ts';
import { fakeLib, stubSlowLoop } from './slow-fixtures.ts';
import { DEFAULT_PARAMS } from './params-fixtures.ts';

/** A port: in order, each message a random 0..`maxMs` ms after the one before is delivered. */
export function port<T>(deliver: (m: T) => void, rand: () => number, maxMs: number) {
  let chain = Promise.resolve();
  return (m: T) => {
    const wait = Math.floor(rand() * (maxMs + 1));
    chain = chain.then(() => new Promise<void>((r) => setTimeout(r, wait))).then(() => deliver(m));
  };
}

const TILES = 24;

/**
 * Tiles in a row; every observed frame adds a slot to two of them, and a tile is due after
 * `due` slots (so about 2 / `due` visits per frame come due). A visit takes the freshest due
 * tile whose neighbours have no visit out.
 */
function fakeLoop(due: number, log: string[]) {
  let version = 10;
  const fresh = new Array<number>(TILES).fill(0);
  const out = new Set<number>();
  let observed = 0;
  /** Settle frames observed, and visits handed out in the pass (before any tile was made due at once). */
  const pass = { frames: 0, visits: 0, settling: false, allDue: false, over: 0 };
  const loop = stubSlowLoop({
    observe: (_f, _v, traces) => {
      const f = observed++;
      log.push(`o${f}:${traces?.[0] ?? ''}`);
      fresh[f % TILES]++;
      fresh[(f * 7 + 3) % TILES]++;
      if (pass.settling) pass.frames++;
      return true;
    },
    finalize: () => fakeLib(++version),
    publishedLibrary: () => fakeLib(version),
    setEditScope: (s) => {
      if (s === 'refine') pass.settling = true;
    },
    takeJob: () => {
      let best = -1;
      for (let t = 0; t < TILES; t++) {
        if (fresh[t] < due || out.has(t) || out.has(t - 1) || out.has(t + 1)) continue;
        if (best < 0 || fresh[t] > fresh[best]) best = t;
      }
      if (best < 0) return undefined;
      fresh[best] = 0;
      out.add(best);
      log.push(`t${best}`);
      if (pass.settling && !pass.allDue) {
        pass.visits++;
        // Never more visits than the frames observed so far earned (`SETTLE.visitRate`).
        if (pass.visits > Math.floor(SETTLE.visitRate * pass.frames + 1e-9)) pass.over++;
      }
      return Uint8Array.of(best);
    },
    applyJob: (b) => {
      out.delete(b[0]);
      log.push(`a${b[0]}`);
    },
    markAllDue: () => {
      pass.allDue = true;
      fresh.fill(due);
    },
    cellCount: 1,
    footprintNoise: () => Float64Array.of(1, 0.1),
    footprintNoiseOn: () => 0.1,
  });
  return { loop, pass };
}

/**
 * A look-back worker: answers every request after its port's delay; a `hold` request waits for
 * its `solve` (`drop`: never answered). Its traces are the first frame of the request it answered
 * before (-1: none), so an answer depends on that worker's history.
 */
function fakeLookback(
  answer: (m: LookbackToSlow) => void,
  count: { answers: number; releases: number },
) {
  const held = new Map<number, Extract<SlowToLookback, { type: 'request' }>>();
  let before = -1;
  const reply = (m: Extract<SlowToLookback, { type: 'request' }>) => {
    const n = m.items.length / 3;
    count.answers++;
    const traces = new Float32Array(n).fill(before);
    before = m.items[0];
    answer({
      type: 'frames',
      session: m.session,
      id: m.id,
      version: 1,
      count: n,
      cells: 1,
      frames: new Float32Array(2 * n),
      traces,
      timing: { readMs: 0, preprocessMs: 0, solveMs: 1, otherMs: 0, waitMs: 0 },
    });
  };
  return (m: SlowToLookback) => {
    if (m.type === 'request') {
      if (m.hold) held.set(m.id, m);
      else reply(m);
    } else if (m.type === 'solve') {
      const r = held.get(m.id);
      held.delete(m.id);
      if (r) reply(r);
    } else if (m.type === 'drop') held.delete(m.id);
    else if (m.type === 'release') count.releases++;
  };
}

/** Frames of the Discover run before each settle. */
export const FRAMES = 20 * SETTLE.batch + 7;

/** The timing of one settle run, and its options. */
export interface Schedule {
  seed: number;
  /** Visit workers. */
  visitWorkers: number;
  /** Most delay of a visit result and of a look-back answer, ms. */
  visitMs: number;
  /** Visit results come back before anything else runs (microtasks, not timers; `visitMs` unused). */
  visitInstant?: boolean;
  answerMs: number;
  /** The settle on factors with a pool worker (two look-back workers), else the recording's relay. */
  pool: boolean;
  /** Slots after which a tile is due (2: about one visit per frame comes due). */
  due?: number;
  /** The settle's visit rate (0: none, the behaviour before). */
  rate?: number;
  /** Press Stop this many ms into the settle. */
  stopAfterMs?: number;
  /** A repeatable run (`SlowInit.repeatable`): paced at 60 fps, Discover fed in batches. */
  repeatable?: boolean;
}

/**
 * One Discover run of `FRAMES` frames and its Final settle under `sch`: the settle's last status,
 * the fake loop's pass counts and call log, the look-back answers and releases, the accounting.
 */
export async function settleRun(sch: Schedule) {
  const rand = lcg(sch.seed);
  const log: string[] = [];
  const { loop, pass } = fakeLoop(sch.due ?? 2, log);
  const toMain: SlowToMain[] = [];
  let runner: SlowRunner | null = null;
  /** Delivered in order after a random delay, or in a microtask with `visitInstant`. */
  const visitPort = <T>(deliver: (m: T) => void, maxMs: number) =>
    sch.visitInstant ? (m: T) => queueMicrotask(() => deliver(m)) : port(deliver, rand, maxMs);
  const toVisit = Array.from({ length: sch.visitWorkers }, (_, i) =>
    visitPort<OwnerToVisit>((m) => {
      if (m.type !== 'job') return;
      back[i]({ type: 'result', session: m.session, bytes: m.bytes, ms: 1 });
    }, 0),
  );
  const back = Array.from({ length: sch.visitWorkers }, (_, i) =>
    visitPort<Parameters<SlowRunner['handleVisit']>[1]>(
      (m) => runner!.handleVisit(i, m),
      sch.visitMs,
    ),
  );
  const count = { answers: 0, releases: 0 };
  const lbPorts = Array.from({ length: sch.pool ? 2 : 1 }, (_, k) => {
    const toSlow = port<LookbackToSlow>((m) => runner!.handleLookback(m, k), rand, sch.answerMs);
    return port<SlowToLookback>(fakeLookback(toSlow, count), rand, 1);
  });
  runner = new SlowRunner({
    create: () => loop,
    toFast: { postMessage: () => {} },
    toMain: { postMessage: (m) => toMain.push(m) },
    visits: toVisit.map((post) => ({ postMessage: (m: OwnerToVisit) => post(m) })),
    lookback: { postMessage: (m: SlowToLookback) => lbPorts[0](m) },
    now: () => performance.now(),
    defer: (fn) => setTimeout(fn, 0),
    timer: () => () => {},
  });
  if (sch.pool) runner.connectLookback({ postMessage: (m: SlowToLookback) => lbPorts[1](m) }, 1);
  const rate = sch.rate ?? SETTLE.visitRate;
  const init: Extract<FastToSlow, { type: 'init' }> = {
    type: 'init',
    session: 1,
    width: 2,
    height: 1,
    fov: Uint8Array.of(1, 1),
    noise: Float32Array.of(1, 1),
    params: DEFAULT_PARAMS,
    budget: 1,
    lookback: true,
    ...(sch.pool ? { factorFile: true } : {}),
    ...(rate > 0 ? { settleVisitRate: rate } : {}),
    ...(sch.repeatable ? { repeatable: true } : {}),
  };
  const frames = (start: number, count: number): FastToSlow => ({
    type: 'frames',
    session: 1,
    start,
    count,
    version: 0,
    cells: 0,
    frames: new Float32Array(2 * count),
    traces: new Float32Array(0),
  });
  if (sch.repeatable) {
    // A repeatable Discover: paced, in batches, its visits applied at its batch ends.
    runner.setPace(60, false);
    runner.handle(init);
    const pause = () => new Promise<void>((r) => setTimeout(r, 0));
    for (let s = 0; s < FRAMES; s += PACE_BATCH)
      await runner.handleAsync(frames(s, Math.min(PACE_BATCH, FRAMES - s)), pause);
    await runner.handleAsync({ type: 'end', session: 1 }, pause);
  } else {
    runner.handle(init);
    runner.handle(frames(0, FRAMES));
    runner.handle({ type: 'end', session: 1 });
  }
  if (sch.pool) {
    // The factors are ready, then the pool worker joins (as the main thread starts it at Max).
    runner.factors({
      type: 'factors',
      session: 1,
      ready: true,
      frames: FRAMES,
      source: { folder: 'f', windows: [], width: 2, height: 1 },
    });
    runner.setSettlePool(1, 1);
  }
  if (sch.stopAfterMs !== undefined) setTimeout(() => runner!.stopSettling(1), sch.stopAfterMs);
  const final = () => toMain.some((m) => m.type === 'status' && m.status.final);
  for (let k = 0; k < 20_000 && !final(); k++) await new Promise((r) => setTimeout(r, 1));
  expect(final()).toBe(true);
  const st = toMain
    .filter((m) => m.type === 'status')
    .map((m) => (m.type === 'status' ? m.status.lookback?.settle : undefined))
    .filter((s): s is SettleStatus => s !== undefined)
    .at(-1)!;
  const accounting = toMain
    .map((m) => (m.type === 'status' ? m.status.accounting : undefined))
    .filter((a) => a !== undefined)
    .at(-1)!;
  // Answers still on their way when the settle ended (after a Stop) are released as they come.
  await new Promise((r) => setTimeout(r, 4 * (sch.answerMs + 2)));
  return { st, pass, count, accounting, log };
}
