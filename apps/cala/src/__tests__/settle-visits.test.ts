// @vitest-environment node
/**
 * The Final settle's visit rate (`SETTLE.visitRate`): with visit workers, the
 * settle's pass hands out `floor(rate x fed)` tile visits whatever the timing.
 *
 * The slow worker (`SlowRunner`), scripted look-back workers and visit
 * workers are wired by ports that deliver each message after a random delay,
 * in order per port, as between threads. The slow loop is a fake whose tiles
 * come due with the frames it observes and which refuses a tile next to a
 * visit out (as `take_job` does), so how many visits it can hand out depends
 * on when results come back. Schedules vary the delays (visits much slower
 * than look-back answers, as when the slow worker's queue is long), the visit
 * workers (1, 2, 4) and the look-back workers (worker 0 on the recording with
 * its relay, or worker 0 plus a pool worker on the factors).
 */
import { describe, expect, it } from 'vitest';
import { SETTLE } from '../lib/settle.ts';
import { SlowRunner, type PublishedLibrary, type SlowLoopLike } from '../lib/slow-runner.ts';
import type { LookbackToSlow, SettleStatus, SlowToLookback } from '../workers/lookback-types.ts';
import type { FastToSlow, OwnerToVisit, SlowToMain } from '../workers/slow-types.ts';

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
  return (m: T) => {
    const wait = Math.floor(rand() * (maxMs + 1));
    chain = chain.then(() => new Promise<void>((r) => setTimeout(r, wait))).then(() => deliver(m));
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
    free: () => {},
  };
}

const TILES = 24;

/**
 * Tiles in a row; every observed frame adds a slot to two of them, and a tile is due after
 * `due` slots (so about 2 / `due` visits per frame come due). A visit takes the freshest due
 * tile whose neighbours have no visit out.
 */
function fakeLoop(due: number) {
  let version = 10;
  const fresh = new Array<number>(TILES).fill(0);
  const out = new Set<number>();
  let observed = 0;
  /** Settle frames observed, and visits handed out in the pass (before any tile was made due at once). */
  const pass = { frames: 0, visits: 0, settling: false, allDue: false, over: 0 };
  const loop: SlowLoopLike = {
    observe: () => {
      const f = observed++;
      fresh[f % TILES]++;
      fresh[(f * 7 + 3) % TILES]++;
      if (pass.settling) pass.frames++;
      return true;
    },
    step: () => undefined,
    finalize: () => fakeLib(++version),
    publishedLibrary: () => fakeLib(version),
    setNoise: () => {},
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
      if (pass.settling && !pass.allDue) {
        pass.visits++;
        // Never more visits than the frames observed so far earned (`SETTLE.visitRate`).
        if (pass.visits > Math.floor(SETTLE.visitRate * pass.frames + 1e-9)) pass.over++;
      }
      return Uint8Array.of(best);
    },
    applyJob: (b) => {
      out.delete(b[0]);
    },
    housekeep: () => undefined,
    markAllDue: () => {
      pass.allDue = true;
      fresh.fill(due);
    },
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
    lookbackStats: () => new Float64Array(7),
    footprintNoise: () => Float64Array.of(1, 0.1),
    footprintNoiseOn: () => 0.1,
  };
  return { loop, pass };
}

/**
 * A look-back worker: answers every request after its port's delay; a `hold` request waits for
 * its `solve` (`drop`: never answered).
 */
function fakeLookback(
  answer: (m: LookbackToSlow) => void,
  count: { answers: number; releases: number },
) {
  const held = new Map<number, Extract<SlowToLookback, { type: 'request' }>>();
  const reply = (m: Extract<SlowToLookback, { type: 'request' }>) => {
    const n = m.items.length / 3;
    count.answers++;
    answer({
      type: 'frames',
      session: m.session,
      id: m.id,
      version: 1,
      count: n,
      cells: 1,
      frames: new Float32Array(2 * n),
      traces: new Float32Array(n),
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

const FRAMES = 20 * SETTLE.batch + 7;

interface Schedule {
  seed: number;
  /** Visit workers. */
  visitWorkers: number;
  /** Most delay of a visit result and of a look-back answer, ms. */
  visitMs: number;
  answerMs: number;
  /** The settle on factors with a pool worker (two look-back workers), else the recording's relay. */
  pool: boolean;
  /** Slots after which a tile is due (2: about one visit per frame comes due). */
  due?: number;
  /** The settle's visit rate (0: none, the behaviour before). */
  rate?: number;
  /** Press Stop this many ms into the settle. */
  stopAfterMs?: number;
}

/** One Discover run of `FRAMES` frames and its Final settle under `sch`; the settle's last status. */
async function settleRun(sch: Schedule) {
  const rand = lcg(sch.seed);
  const { loop, pass } = fakeLoop(sch.due ?? 2);
  const toMain: SlowToMain[] = [];
  let runner: SlowRunner | null = null;
  const toVisit = Array.from({ length: sch.visitWorkers }, (_, i) =>
    port<OwnerToVisit>(
      (m) => {
        if (m.type !== 'job') return;
        back[i]({ type: 'result', session: m.session, bytes: m.bytes, ms: 1 });
      },
      rand,
      0,
    ),
  );
  const back = Array.from({ length: sch.visitWorkers }, (_, i) =>
    port<Parameters<SlowRunner['handleVisit']>[1]>(
      (m) => runner!.handleVisit(i, m),
      rand,
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
    cellDiameterPx: 10,
    flattenSigmaPx: 0,
    budget: 1,
    lookback: true,
    ...(sch.pool ? { factorFile: true } : {}),
    ...(rate > 0 ? { settleVisitRate: rate } : {}),
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
  runner.handle({ type: 'end', session: 1 });
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
  // Answers still on their way when the settle ended (after a Stop) are released as they come.
  await new Promise((r) => setTimeout(r, 4 * (sch.answerMs + 2)));
  return { st, pass, count };
}

const SCHEDULES: Schedule[] = [
  // Visits as fast as answers, one look-back worker (the recording's relay).
  { seed: 1, visitWorkers: 4, visitMs: 2, answerMs: 2, pool: false },
  // Visits far slower than answers (X1's shape: results wait behind look-back answers).
  { seed: 2, visitWorkers: 4, visitMs: 25, answerMs: 1, pool: false },
  { seed: 3, visitWorkers: 1, visitMs: 12, answerMs: 1, pool: false },
  { seed: 4, visitWorkers: 2, visitMs: 6, answerMs: 4, pool: false },
  // The settle on factors with a pool worker: two look-back workers, answers in either order.
  { seed: 5, visitWorkers: 4, visitMs: 2, answerMs: 3, pool: true },
  { seed: 6, visitWorkers: 4, visitMs: 25, answerMs: 1, pool: true },
  { seed: 7, visitWorkers: 1, visitMs: 10, answerMs: 2, pool: true },
];

describe('Final settle visit rate', () => {
  it.each(SCHEDULES)(
    'hands out floor(rate x fed) visits in the pass, never ahead of the frames (%o)',
    async (sch) => {
      const { st, pass, count } = await settleRun(sch);
      // Every answer was observed and its buffer went back.
      expect(count.releases).toBe(count.answers);
      expect(st.fed).toBe(st.total);
      expect(st.total).toBe(FRAMES);
      expect(st.workers).toBe(sch.pool ? 2 : 1);
      const v = st.visits!;
      expect(v.rate).toBe(SETTLE.visitRate);
      expect(v.handed).toBe(Math.floor(SETTLE.visitRate * FRAMES + 1e-9));
      expect(v.unpaid).toBe(0);
      // Never more visits out than the frames observed had earned.
      expect(pass.over).toBe(0);
      // The fake counted the pass's visits up to the first tile made due at once.
      expect(pass.visits).toBeLessThanOrEqual(v.handed);
      expect(pass.visits).toBeGreaterThanOrEqual(v.handed - v.paidAtEnd);
      expect(v.finalRound).toBeGreaterThan(0);
    },
    20_000,
  );

  it('fewer tiles come due than the rate asks: the credit is carried and paid before the last round', async () => {
    // One visit comes due every 5 frames (0.2 per frame): half the rate.
    const { st } = await settleRun({
      seed: 9,
      visitWorkers: 2,
      visitMs: 3,
      answerMs: 2,
      pool: false,
      due: 10,
    });
    const v = st.visits!;
    expect(v.starved).toBeGreaterThan(0);
    expect(v.paidAtEnd).toBeGreaterThan(0);
    // What the pass could still pay with every tile due (one visit per tile, then nothing is due).
    expect(v.handed + v.unpaid).toBe(Math.floor(SETTLE.visitRate * FRAMES + 1e-9));
  }, 20_000);

  it('a Stop while answers wait to be observed: they are not observed, their buffers go back', async () => {
    const { st, count } = await settleRun({
      seed: 11,
      visitWorkers: 1,
      visitMs: 25,
      answerMs: 1,
      pool: true,
      stopAfterMs: 60,
    });
    expect(st.stopped).toBe(true);
    expect(st.fed).toBeLessThan(st.total);
    expect(count.releases).toBe(count.answers);
  }, 20_000);

  it('without a rate (the behaviour before) the visit count follows the timing', async () => {
    const fast = await settleRun({ ...SCHEDULES[0], rate: 0 });
    const slow = await settleRun({ ...SCHEDULES[1], rate: 0 });
    expect(fast.st.visits!.rate).toBe(0);
    expect(fast.pass.visits).not.toBe(slow.pass.visits);
  }, 20_000);
});
