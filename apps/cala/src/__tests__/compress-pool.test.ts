import { describe, expect, it } from 'vitest';
import {
  compressPoolSize,
  helpersFor,
  WindowPool,
  type JobIO,
  parsePoolOverride,
  poolForRun,
  TilePool,
  type TileJob,
  type TileResult,
  type WindowIO,
} from '../lib/compress-pool.ts';
import type { WindowResult } from '../lib/factor-solve.ts';
import type { CoordinatorToHelper } from '../workers/compress-types.ts';

describe('compressPoolSize', () => {
  it('leaves Discover its cores and uses the freed ones after it', () => {
    expect(compressPoolSize(10, 4, 0)).toEqual({ discover: 1, after: 3, extract: 6 });
    expect(compressPoolSize(8, 3, 0)).toEqual({ discover: 1, after: 2, extract: 5 });
    expect(compressPoolSize(16, 4, 1)).toEqual({ discover: 4, after: 4, extract: 6 });
    expect(compressPoolSize(4, 0, 0)).toEqual({ discover: 1, after: 1, extract: 1 });
    expect(compressPoolSize(undefined, 0, 0)).toEqual({ discover: 1, after: 1, extract: 1 });
  });
  it('starts as many helpers as the largest width needs', () => {
    expect(helpersFor({ discover: 1, after: 3, extract: 6 })).toBe(6);
    expect(helpersFor({ discover: 1, after: 3 })).toBe(3);
    expect(helpersFor({ discover: 1, after: 3, extract: 1 })).toBe(2);
    expect(helpersFor({ discover: 1, after: 1, extract: 1 })).toBe(0);
  });
  it('reads ?debug&cpool=D,E', () => {
    expect(parsePoolOverride('2,4')).toEqual({ discover: 2, after: 4, extract: 4 });
    expect(parsePoolOverride('1,3,6')).toEqual({ discover: 1, after: 3, extract: 6 });
    expect(parsePoolOverride('1,3,7')).toBeNull();
    expect(parsePoolOverride('0,9')).toBeNull();
    expect(parsePoolOverride('x')).toBeNull();
    expect(parsePoolOverride(null)).toBeNull();
  });
  it('keeps one worker while a stream streams', () => {
    expect(poolForRun(true, { discover: 3, after: 4, extract: 6 })).toEqual({
      discover: 1,
      after: 4,
      extract: 6,
    });
    expect(poolForRun(false, { discover: 3, after: 4 })).toEqual({ discover: 3, after: 4 });
    expect(poolForRun(false, null)).toBeNull();
  });
});

// ---- the tile pool, with fake helpers and a fake compressor ----

/** The "factors" of a tile: a function of its seed, position and data only. */
function fakeBytes(raw: Int16Array, x0: number, y0: number, seed: number): Uint8Array {
  let sum = 0;
  for (const v of raw) sum = (sum * 31 + v) >>> 0;
  return new Uint8Array([seed & 255, (seed >>> 20) & 255, x0, y0, sum & 255, (sum >>> 8) & 255]);
}

const local = {
  compress(
    raw: Int16Array,
    _frames: number,
    x0: number,
    y0: number,
    _w: number,
    _h: number,
    seed: number,
  ) {
    return { rank: 1, toBytes: () => fakeBytes(raw, x0, y0, seed), free: () => {} };
  },
};

function jobsOf(window: number, n: number): TileJob[] {
  return Array.from({ length: n }, (_, i) => ({
    window,
    tile: i,
    frames: 3,
    x0: i * 2,
    y0: 1,
    w: 2,
    h: 2,
    seed: ((window << 20) ^ i) >>> 0,
  }));
}

function io(): WindowIO & { written: [number, Uint8Array][]; reads: number[] } {
  const written: [number, Uint8Array][] = [];
  const reads: number[] = [];
  return {
    written,
    reads,
    local,
    read(job, into) {
      reads.push(job.tile);
      for (let i = 0; i < into.length; i++) into[i] = job.window * 1000 + job.tile * 7 + i;
    },
    write(job, r: TileResult) {
      written.push([job.tile, r.bytes]);
    },
    yieldNow: () => Promise.resolve(),
  };
}

/** Helpers whose tiles the test answers. */
function fakeHelpers(n: number) {
  const posted: { k: number; msg: CoordinatorToHelper }[] = [];
  const ports = Array.from({ length: n }, (_, k) => ({
    postMessage: (msg: CoordinatorToHelper) => posted.push({ k, msg }),
  }));
  const tiles = () =>
    posted.flatMap((p) => (p.msg.type === 'tile' ? [{ k: p.k, msg: p.msg }] : []));
  return { ports, posted, tiles };
}

function answer(pool: TilePool, t: { k: number; msg: CoordinatorToHelper }): void {
  if (t.msg.type !== 'tile') return;
  const m = t.msg;
  const raw = m.raw.subarray(0, m.frames * m.w * m.h);
  pool.onHelper(t.k, {
    type: 'tile-done',
    epoch: m.epoch,
    window: m.window,
    tile: m.tile,
    rank: 1,
    ms: 0,
    bytes: fakeBytes(raw, m.x0, m.y0, m.seed),
    raw: m.raw,
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Answer every tile posted, newest first, until `done` settles. */
async function answerReversed(
  pool: TilePool,
  h: ReturnType<typeof fakeHelpers>,
  done: Promise<unknown>,
): Promise<void> {
  let settled = false;
  void done.finally(() => (settled = true));
  let answered = 0;
  while (!settled) {
    await tick();
    const t = h.tiles();
    for (const x of t.slice(answered).reverse()) answer(pool, x);
    answered = t.length;
  }
}

/** A pool with manual timers. */
function poolWith(helpers: number) {
  const h = fakeHelpers(helpers);
  const timers: { fn: () => void; on: boolean }[] = [];
  const pool = new TilePool({
    helpers: h.ports,
    now: () => 0,
    setTimer: (fn) => {
      const t = { fn, on: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { on: boolean }).on = false;
    },
  });
  pool.begin(64);
  return { pool, h, timers };
}

describe('TilePool', () => {
  it('width 1 compresses every tile itself, in order (the old loop)', async () => {
    const { pool, h } = poolWith(2);
    pool.setWidth(1);
    const w = io();
    expect(await pool.compressWindow(jobsOf(0, 5), w)).toBe(true);
    expect(h.tiles()).toEqual([]);
    expect(w.written.map(([t]) => t)).toEqual([0, 1, 2, 3, 4]);
  });

  it('writes the same bytes for any width, whatever order the answers arrive in', async () => {
    const one = poolWith(0);
    const ref = io();
    await one.pool.compressWindow(jobsOf(4, 9), ref);

    const { pool, h } = poolWith(3);
    pool.setWidth(3);
    const w = io();
    const done = pool.compressWindow(jobsOf(4, 9), w);
    await answerReversed(pool, h, done);
    expect(await done).toBe(true);
    expect(h.tiles().length).toBeGreaterThan(0);
    expect(w.written.map(([t]) => t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(w.written).toEqual(ref.written);
  });

  it('redoes the tile of a helper that crashed and gives it nothing more', async () => {
    const { pool, h } = poolWith(1);
    pool.setWidth(2);
    const w = io();
    const done = pool.compressWindow(jobsOf(0, 4), w);
    await tick();
    expect(h.tiles().length).toBe(1);
    pool.lost(0);
    expect(await done).toBe(true);
    expect(w.written.map(([t]) => t)).toEqual([0, 1, 2, 3]);
    expect(h.tiles().length).toBe(1);
    expect(pool.width()).toBe(1);
  });

  it("a revived helper gets the run's compressor and takes tiles again", async () => {
    const { pool, h } = poolWith(1);
    pool.setWidth(2);
    pool.lost(0);
    expect(pool.width()).toBe(1);
    const posted: CoordinatorToHelper[] = [];
    pool.revive(0, { postMessage: (m: CoordinatorToHelper) => posted.push(m) });
    expect(posted).toEqual([{ type: 'init', quant: 64 }]);
    expect(pool.width()).toBe(2);
    const w = io();
    const done = pool.compressWindow(jobsOf(0, 4), w);
    await tick();
    expect(posted.filter((m) => m.type === 'tile').length).toBe(1);
    // The old port gets nothing more.
    expect(h.tiles().length).toBe(0);
    pool.reset();
    expect(await done).toBe(false);
  });

  it('treats a helper that cannot start as a crash', async () => {
    const { pool, h } = poolWith(1);
    pool.setWidth(2);
    const w = io();
    const done = pool.compressWindow(jobsOf(0, 3), w);
    await tick();
    pool.onHelper(0, { type: 'helper-error', message: 'no WASM' });
    expect(await done).toBe(true);
    expect(w.written.map(([t]) => t)).toEqual([0, 1, 2]);
    expect(h.tiles().length).toBe(1);
  });

  it('gives a helper up when its tile times out', async () => {
    const { pool, timers } = poolWith(1);
    pool.setWidth(2);
    const w = io();
    const done = pool.compressWindow(jobsOf(0, 3), w);
    await tick();
    const live = timers.filter((t) => t.on);
    expect(live.length).toBe(1);
    live[0].fn();
    expect(await done).toBe(true);
    expect(w.written.map(([t]) => t)).toEqual([0, 1, 2]);
  });

  it("fails the window on a tile's error and drops its later answers", async () => {
    const { pool, h } = poolWith(2);
    pool.setWidth(3);
    const w = io();
    const done = pool.compressWindow(jobsOf(0, 6), w);
    await tick();
    const [first, second] = h.tiles();
    if (first.msg.type !== 'tile') throw new Error('expected a tile');
    pool.onHelper(first.k, {
      type: 'tile-error',
      epoch: first.msg.epoch,
      window: first.msg.window,
      tile: first.msg.tile,
      message: 'SVD failed',
    });
    await expect(done).rejects.toThrow('SVD failed');
    const before = w.written.length;
    answer(pool, second);
    expect(w.written.length).toBe(before);
  });

  it('returns false on a reset and writes nothing of a late answer', async () => {
    const { pool, h } = poolWith(2);
    pool.setWidth(3);
    const w = io();
    const done = pool.compressWindow(jobsOf(0, 3), w);
    await tick();
    const out = h.tiles();
    expect(out.length).toBe(2);
    pool.reset();
    expect(await done).toBe(false);
    const before = w.written.length;
    for (const t of out) answer(pool, t);
    expect(w.written.length).toBe(before);
  });
});

// ---- the window pool, with fake helpers ----

describe('WindowPool', () => {
  const result = (index: number, projected = true): WindowResult => ({
    start: index * 10,
    count: 10,
    projected,
    traces: Float32Array.of(index),
  });

  function windowPoolWith(helpers: number) {
    const posted: { k: number; msg: CoordinatorToHelper }[] = [];
    const timers: { fn: () => void; on: boolean }[] = [];
    const pool = new WindowPool({
      helpers: Array.from({ length: helpers }, (_, k) => ({
        postMessage: (msg: CoordinatorToHelper) => posted.push({ k, msg }),
      })),
      setTimer: (fn) => {
        const t = { fn, on: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        (t as { on: boolean }).on = false;
      },
    });
    const windows = () =>
      posted.flatMap((p) => (p.msg.type === 'extract-window' ? [{ k: p.k, msg: p.msg }] : []));
    return { pool, posted, timers, windows };
  }

  function io(): JobIO & { emitted: number[]; here: number[] } {
    const emitted: number[] = [];
    const here: number[] = [];
    return {
      emitted,
      here,
      read: async (i) => Uint8Array.of(i),
      local: (i) => {
        here.push(i);
        return result(i, false);
      },
      emit: (i) => void emitted.push(i),
      yieldNow: () => Promise.resolve(),
    };
  }

  const answer = (pool: WindowPool, w: { k: number; msg: CoordinatorToHelper }): void => {
    if (w.msg.type !== 'extract-window') return;
    pool.onHelper(w.k, {
      type: 'window-done',
      job: w.msg.job,
      index: w.msg.index,
      ...result(w.msg.index),
    });
  };

  it('width 1: the compress worker solves every window, in order', async () => {
    const { pool, windows } = windowPoolWith(2);
    pool.setWidth(1);
    const x = io();
    expect(await pool.runJob(1, 4, x)).toBe(true);
    expect(windows()).toEqual([]);
    expect(x.emitted).toEqual([0, 1, 2, 3]);
  });

  it('width 3, answers in reverse: emitted in window order, once each', async () => {
    const { pool, windows } = windowPoolWith(3);
    pool.setWidth(3);
    pool.begin(1, Uint8Array.of(9), true, 4);
    const x = io();
    const done = pool.runJob(1, 7, x);
    let answered = 0;
    let settled = false;
    void done.finally(() => (settled = true));
    while (!settled) {
      await tick();
      const w = windows();
      for (const v of w.slice(answered).reverse()) answer(pool, v);
      answered = w.length;
    }
    expect(await done).toBe(true);
    expect(x.emitted).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(x.here).toEqual([]);
  });

  it('redoes the window of a crashed, failed or timed-out helper', async () => {
    for (const how of ['crash', 'start', 'timeout'] as const) {
      const { pool, windows, timers } = windowPoolWith(1);
      pool.setWidth(2);
      const x = io();
      const done = pool.runJob(1, 2, x);
      await tick();
      expect(windows().length).toBe(1);
      if (how === 'crash') pool.lost(0);
      else if (how === 'start') pool.onHelper(0, { type: 'helper-error', message: 'no WASM' });
      else timers.filter((t) => t.on)[0].fn();
      expect(await done).toBe(true);
      expect(x.emitted).toEqual([0, 1]);
      expect(x.here).toEqual([0, 1]);
    }
  });

  it('a helper revived during a job joins at its end (it has no library of the job)', async () => {
    const { pool } = windowPoolWith(1);
    pool.setWidth(2);
    pool.lost(0);
    pool.begin(1, Uint8Array.of(9), true, 4);
    const posted: CoordinatorToHelper[] = [];
    pool.revive(0, { postMessage: (m: CoordinatorToHelper) => posted.push(m) });
    expect(pool.width()).toBe(0);
    const x = io();
    expect(await pool.runJob(1, 2, x)).toBe(true);
    expect(x.here).toEqual([0, 1]);
    pool.end(1);
    expect(pool.width()).toBe(1);
    pool.begin(2, Uint8Array.of(9), true, 4);
    expect(posted.map((m) => m.type)).toEqual(['extract-begin']);
  });

  it("fails the job on a window's error and drops later answers", async () => {
    const { pool, windows } = windowPoolWith(2);
    pool.setWidth(2);
    const x = io();
    const done = pool.runJob(1, 4, x);
    await tick();
    const [first, second] = windows();
    if (first.msg.type !== 'extract-window') throw new Error('expected a window');
    pool.onHelper(first.k, {
      type: 'window-error',
      job: 1,
      index: first.msg.index,
      message: 'solve failed',
    });
    await expect(done).rejects.toThrow('solve failed');
    answer(pool, second);
    expect(x.emitted).toEqual([]);
  });

  it('returns false on a reset and emits nothing of a late answer', async () => {
    const { pool, windows } = windowPoolWith(2);
    pool.setWidth(2);
    const x = io();
    const done = pool.runJob(1, 4, x);
    await tick();
    const out = windows();
    pool.reset();
    expect(await done).toBe(false);
    for (const w of out) answer(pool, w);
    expect(x.emitted).toEqual([]);
  });
});
