// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createLookbackClient, type LookbackWorkerLike } from '../lib/lookback-client.ts';
import type { MainToLookback } from '../workers/lookback-types.ts';

function setup(blocked: string | null = null, pool = 0) {
  const sent: { msg: MainToLookback; transfer: Transferable[]; worker: number }[] = [];
  let workers = 0;
  const ports: unknown[] = [];
  const indices: number[] = [];
  const paces: [number, boolean][] = [];
  const caps: number[] = [];
  const pools: [number, number][] = [];
  const terminated: number[] = [];
  const client = createLookbackClient({
    slow: {
      connectLookback: (p, i) => {
        ports.push(p);
        indices.push(i ?? 0);
      },
      settlePace: (fps, paused) => paces.push([fps, paused]),
      settleCap: (cap) => caps.push(cap),
      settlePool: (session, workers) => pools.push([session, workers]),
    },
    pool,
    source: () => ({ entries: [] }),
    blocked: () => blocked,
    makeWorker: () => {
      const worker = workers++;
      return {
        postMessage: (msg: MainToLookback, transfer: Transferable[] = []) =>
          sent.push({ msg, transfer, worker }),
        terminate: () => terminated.push(worker),
        onmessage: null,
        onerror: null,
      } as unknown as LookbackWorkerLike;
    },
    makeChannel: () => ({ port1: {} as MessagePort, port2: {} as MessagePort }),
  });
  return {
    client,
    sent,
    ports,
    indices,
    paces,
    caps,
    pools,
    terminated,
    workers: () => workers,
  };
}

describe('look-back client', () => {
  it('beginFactors starts worker 0 on the factors, connects it once and never starts a pool', () => {
    const t = setup(null, 2);
    const factors = {
      folder: 'run-a',
      windows: [{ index: 0, start: 0, frames: 600 }],
      width: 4,
      height: 3,
    };
    t.client.beginFactors!(7, factors);
    expect(t.workers()).toBe(1);
    expect(t.sent.at(-1)!.msg).toEqual({ type: 'begin', session: 7, source: { factors } });
    expect(t.ports).toHaveLength(1);
    expect(t.client.startPool!(7)).toBe(0);
    expect(t.workers()).toBe(1);
    t.client.reset(7);
    expect(t.sent.at(-1)!.msg).toEqual({ type: 'reset', session: 7 });
  });

  it("a late reset of a stream's factor run leaves the next run's look-back alone", () => {
    const t = setup(null, 2);
    t.client.beginFactors!(7, { folder: 'run-a', windows: [], width: 4, height: 3 });
    expect(t.client.begin(8)).toBe(true);
    t.client.reset(7);
    expect(t.sent.at(-1)!.msg).toEqual({ type: 'reset', session: 7 });
    // Run 8 is still the client's: its pool can start.
    expect(t.client.startPool!(8)).toBe(2);
  });

  it('starts nothing while blocked', () => {
    const t = setup('Look-back needs a recording on disk.');
    expect(t.client.blocked()).toMatch(/recording on disk/);
    expect(t.client.begin(1)).toBe(false);
    expect(t.workers()).toBe(0);
    expect(t.ports).toHaveLength(0);
  });

  it('starts one worker, wires it to the slow worker, and copies the rows it sends', () => {
    const t = setup();
    expect(t.client.begin(1)).toBe(true);
    expect(t.client.begin(2)).toBe(true);
    expect(t.workers()).toBe(1);
    expect(t.ports).toHaveLength(1);
    expect(t.sent.map((s) => s.msg.type)).toEqual(['connect', 'begin', 'begin']);
    const dy = Float32Array.of(1, 2);
    t.client.rows(2, 8, dy, dy, [0, 1], dy, dy);
    const rows = t.sent.at(-1)!;
    expect(rows.msg).toMatchObject({ type: 'rows', session: 2, start: 8 });
    // The step's arrays stay usable on the main thread: copies are transferred.
    expect(rows.transfer).toHaveLength(5);
    expect(rows.transfer).not.toContain(dy.buffer);
    expect(dy.length).toBe(2);
  });

  it("`final` goes to worker 0 only (the end settle's), and only for the current run", () => {
    const t = setup(null, 1);
    t.client.begin(3);
    t.client.startPool?.(3);
    t.client.final?.(2);
    t.client.final?.(3);
    const finals = t.sent.filter((s) => s.msg.type === 'final');
    expect(finals.map((s) => [s.worker, s.msg])).toEqual([[0, { type: 'final', session: 3 }]]);
  });

  it('a pool: no pool worker until the run goes below Max', () => {
    const t = setup(null, 2);
    expect(t.client.begin(1)).toBe(true);
    const dy = Float32Array.of(1, 2);
    t.client.rows(1, 0, dy, dy, [0, 1], dy, dy);
    expect(t.workers()).toBe(1);
    expect(t.pools).toEqual([]);
    // Another session's run cannot start it; without a pool size nothing starts.
    expect(t.client.startPool?.(2)).toBe(0);
    expect(t.workers()).toBe(1);
    const none = setup(null, 0);
    none.client.begin(1);
    expect(none.client.startPool?.(1)).toBe(0);
    expect(none.workers()).toBe(1);
    expect(none.pools).toEqual([]);
  });

  it('a pool started mid-run gets the run so far: begin, params, every row joined, the newest flat field', () => {
    const t = setup(null, 2);
    t.client.begin(1);
    t.client.params(1, 'P');
    expect(t.sent.filter((x) => x.msg.type === 'params').map((x) => x.worker)).toEqual([0]);
    const rows = (start: number, n: number) => {
      const a = Float32Array.from({ length: n }, (_, k) => start + k);
      t.client.rows(1, start, a, a, new Uint8Array(n), a, a);
    };
    rows(0, 8);
    rows(8, 8);
    const map = { gain: new Float32Array(1) } as never;
    t.client.flatField(1, map);
    expect(t.client.startPool?.(1)).toBe(2);
    expect(t.workers()).toBe(3);
    expect(t.indices).toEqual([0, 1, 2]);
    // The slow worker hears of them only once they have a back state (they could not serve before).
    expect(t.pools).toEqual([]);
    for (const w of [1, 2]) {
      const mine = t.sent.filter((x) => x.worker === w).map((x) => x.msg);
      expect(mine.map((m) => m.type)).toEqual(['connect', 'begin', 'params', 'rows', 'flat']);
      expect(mine[2]).toEqual({ type: 'params', session: 1, params: 'P' });
      const r = mine[3] as Extract<MainToLookback, { type: 'rows' }>;
      expect(r.start).toBe(0);
      expect(Array.from(r.dy)).toEqual(Array.from({ length: 16 }, (_, k) => k));
    }
    // Each its own arrays.
    const joined = t.sent.filter((x) => x.worker > 0 && x.msg.type === 'rows');
    const bufs = joined.flatMap((x) => x.transfer);
    expect(new Set(bufs).size).toBe(bufs.length);
    // Once only; from now on the pool gets every message too.
    expect(t.client.startPool?.(1)).toBe(2);
    t.client.backState(1, { frame: 16, state: Uint8Array.of(1) } as never);
    expect(t.pools).toEqual([[1, 2]]);
    t.client.backState(1, { frame: 32, state: Uint8Array.of(1) } as never);
    expect(t.pools).toHaveLength(1);
    rows(16, 8);
    expect(
      t.sent
        .filter((x) => x.msg.type === 'rows' && (x.msg as { start: number }).start === 16)
        .map((x) => x.worker),
    ).toEqual([0, 1, 2]);
    // A new run: only worker 0 until it goes below Max (the pool ended with the last run).
    t.client.reset(1);
    expect(t.terminated).toEqual([1, 2]);
    t.client.begin(2);
    rows(0, 8);
    expect(
      t.sent
        .filter((x) => x.msg.type === 'begin' && (x.msg as { session: number }).session === 2)
        .map((x) => x.worker),
    ).toEqual([0]);
  });

  it('a Joint run: session warps go to every worker, and a pool started later gets them before its rows', () => {
    const t = setup(null, 1);
    t.client.begin(1);
    const dy = Float32Array.of(0, 0);
    t.client.rows(1, 0, dy, dy, [0, 0], dy, dy);
    t.client.session!(1, 1, [1.5, 2, -1]);
    t.client.rows(1, 2, dy, dy, [0, 0], dy, dy);
    expect(t.sent.filter((s) => s.worker === 0).map((s) => s.msg.type)).toEqual([
      'connect',
      'begin',
      'rows',
      'session',
      'rows',
    ]);
    expect(t.sent.at(-2)!.msg).toEqual({
      type: 'session',
      session: 1,
      index: 1,
      transform: [1.5, 2, -1],
    });
    expect(t.client.startPool!(1)).toBe(1);
    const pool = t.sent.filter((s) => s.worker === 1).map((s) => s.msg);
    expect(pool.map((m) => m.type)).toEqual(['connect', 'begin', 'session', 'rows']);
    expect(pool[2]).toMatchObject({ type: 'session', index: 1, transform: [1.5, 2, -1] });
    // From now on both workers hear of the next session.
    t.client.session!(1, 2, [0, 1, 1]);
    expect(t.sent.slice(-2).map((s) => [s.worker, s.msg.type])).toEqual([
      [0, 'session'],
      [1, 'session'],
    ]);
  });

  it('a pool started between two snapshots gets the newest back state before it is announced', () => {
    const t = setup(null, 1);
    t.client.begin(1);
    const dy = Float32Array.of(0, 0);
    t.client.rows(1, 0, dy, dy, [0, 0], dy, dy);
    // Session 0's last snapshot (at the join, frame 48), then the pool starts before session 1's first.
    const state = Uint8Array.of(1, 2, 3);
    t.client.backState(1, { frame: 48, state });
    expect(t.client.startPool!(1)).toBe(1);
    const pool = t.sent.filter((s) => s.worker === 1).map((s) => s.msg);
    expect(pool.map((m) => m.type)).toEqual(['connect', 'begin', 'rows', 'back-state']);
    expect(pool[1]).toMatchObject({ type: 'begin', prune: true });
    expect(pool[3]).toMatchObject({ type: 'back-state', frame: 48 });
    expect(Array.from((pool[3] as { state: Uint8Array }).state)).toEqual([1, 2, 3]);
    // Worker 0's begin keeps every session's state.
    expect(t.sent.find((s) => s.worker === 0 && s.msg.type === 'begin')!.msg).not.toHaveProperty(
      'prune',
    );
    // Announced at the next snapshot (session 1's first), as before.
    expect(t.pools).toEqual([]);
    t.client.backState(1, { frame: 56, state: Uint8Array.of(4) });
    expect(t.pools).toEqual([[1, 1]]);
  });

  it('the cap goes to the slow worker', () => {
    const t = setup();
    t.client.cap?.(0.5);
    expect(t.caps).toEqual([0.5]);
  });

  it('a pool: S + 1 workers, each wired by index and fed its own copies', () => {
    const t = setup(null, 2);
    expect(t.client.begin(1)).toBe(true);
    t.client.startPool?.(1);
    expect(t.workers()).toBe(3);
    expect(t.indices).toEqual([0, 1, 2]);
    const dy = Float32Array.of(1, 2);
    t.client.rows(1, 0, dy, dy, [0, 1], dy, dy);
    const rows = t.sent.filter((x) => x.msg.type === 'rows');
    expect(rows.map((x) => x.worker)).toEqual([0, 1, 2]);
    // No buffer is transferred twice.
    const bufs = rows.flatMap((x) => x.transfer);
    expect(new Set(bufs).size).toBe(bufs.length);
    const state = Uint8Array.of(1, 2, 3);
    t.client.backState(1, { frame: 5, state } as never);
    const bs = t.sent.filter((x) => x.msg.type === 'back-state');
    expect(bs.map((x) => x.worker)).toEqual([0, 1, 2]);
    const states = bs.map((x) => (x.msg as Extract<MainToLookback, { type: 'back-state' }>).state);
    expect(new Set(states.map((x) => x.buffer)).size).toBe(3);
    expect(states.every((x) => Array.from(x).join() === '1,2,3')).toBe(true);
    expect(t.pools).toEqual([[1, 2]]);
    t.client.flatField(1, null);
    // The run ends: worker 0 is reset and kept, the pool is ended.
    t.client.reset(1);
    expect(t.sent.filter((x) => x.msg.type === 'reset').map((x) => x.worker)).toEqual([0]);
    expect(t.terminated).toEqual([1, 2]);
    t.client.pace?.(60, false);
    expect(t.paces).toEqual([[60, false]]);
    t.client.dispose();
    expect(t.terminated).toEqual([1, 2, 0]);
  });

  it('a Max run after a paced one holds no pool; a later paced run starts fresh ones', () => {
    const t = setup(null, 1);
    t.client.begin(1);
    t.client.startPool?.(1);
    t.client.reset(1);
    // At Max: one worker only, nothing for the pool.
    t.client.begin(2);
    const dy = Float32Array.of(1);
    t.client.rows(2, 0, dy, dy, [0], dy, dy);
    t.client.backState(2, { frame: 1, state: Uint8Array.of(1) } as never);
    t.client.reset(2);
    expect(t.workers()).toBe(2);
    expect(t.terminated).toEqual([1]);
    expect(t.sent.filter((x) => x.worker === 1).map((x) => x.msg.type)).toEqual([
      'connect',
      'begin',
    ]);
    // Paced again: a new worker, wired by index 1 again, given the run so far.
    t.client.begin(3);
    t.client.rows(3, 0, dy, dy, [0], dy, dy);
    expect(t.client.startPool?.(3)).toBe(1);
    expect(t.workers()).toBe(3);
    expect(t.indices).toEqual([0, 1, 1]);
    expect(t.sent.filter((x) => x.worker === 2).map((x) => x.msg.type)).toEqual([
      'connect',
      'begin',
      'rows',
    ]);
  });

  it('a pool started after the last snapshot never joins: the slow worker sends it nothing', () => {
    const t = setup(null, 1);
    t.client.begin(1);
    t.client.backState(1, { frame: 256, state: Uint8Array.of(1) } as never);
    t.client.startPool?.(1);
    // No back state follows before the run ends.
    t.client.reset(1);
    expect(t.pools).toEqual([]);
    // A back state of another run does not announce it either.
    t.client.begin(2);
    t.client.backState(2, { frame: 256, state: Uint8Array.of(1) } as never);
    expect(t.pools).toEqual([]);
  });

  it('the Final settle on factors at Max: the pool opens the factors and joins at once, once', () => {
    const factors = { folder: 'run-a', windows: [], width: 4, height: 3 };
    const t = setup(null, 1);
    t.client.begin(1);
    const dy = Float32Array.of(1, 2);
    t.client.rows(1, 0, dy, dy, [0, 1], dy, dy);
    // Another session's settle starts nothing.
    expect(t.client.startFactorPool!(2, factors)).toBe(0);
    expect(t.workers()).toBe(1);
    expect(t.client.startFactorPool!(1, factors)).toBe(1);
    expect(t.workers()).toBe(2);
    expect(t.indices).toEqual([0, 1]);
    // The pool worker opens the factors (nothing Discover recorded) and is announced at once.
    const toPool = t.sent.filter((s) => s.worker === 1).map((s) => s.msg);
    expect(toPool).toEqual([
      { type: 'connect', port: expect.anything() },
      { type: 'begin', session: 1, source: { factors }, prune: true },
    ]);
    expect(t.pools).toEqual([[1, 1]]);
    // Once per run, and a later back state does not announce it again.
    expect(t.client.startFactorPool!(1, factors)).toBe(1);
    t.client.backState(1, { frame: 256, state: Uint8Array.of(1) } as never);
    expect(t.workers()).toBe(2);
    expect(t.pools).toEqual([[1, 1]]);
  });

  it('the final library is out: the pool ends (the slow worker hears 0), and a later run starts afresh', () => {
    const factors = { folder: 'run-a', windows: [], width: 4, height: 3 };
    const t = setup(null, 1);
    t.client.begin(1);
    expect(t.client.endPool!(1)).toBe(0);
    t.client.startFactorPool!(1, factors);
    // Another session's end does nothing.
    expect(t.client.endPool!(2)).toBe(0);
    expect(t.client.endPool!(1)).toBe(1);
    expect(t.terminated).toEqual([1]);
    expect(t.pools).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect(t.client.endPool!(1)).toBe(0);
    // The run's reset terminates nothing more; worker 0 stays for the page.
    t.client.reset(1);
    expect(t.terminated).toEqual([1]);
    // A restart's settle gets a fresh pool worker, wired by its index again.
    t.client.begin(2);
    expect(t.client.startFactorPool!(2, factors)).toBe(1);
    expect(t.workers()).toBe(3);
    expect(t.indices).toEqual([0, 1, 1]);
    expect(t.pools.at(-1)).toEqual([2, 1]);
  });

  it('the Final settle on factors after a pool started below Max: the running pool serves it', () => {
    const t = setup(null, 1);
    t.client.begin(1);
    expect(t.client.startPool!(1)).toBe(1);
    const begins = t.sent.filter((s) => s.msg.type === 'begin').length;
    expect(
      t.client.startFactorPool!(1, { folder: 'run-a', windows: [], width: 4, height: 3 }),
    ).toBe(1);
    expect(t.sent.filter((s) => s.msg.type === 'begin')).toHaveLength(begins);
    // No pool on a machine without one, nor on a live stream's factor run.
    const none = setup(null, 0);
    none.client.begin(1);
    expect(none.client.startFactorPool!(1, { folder: 'f', windows: [], width: 1, height: 1 })).toBe(
      0,
    );
    expect(none.workers()).toBe(1);
    const stream = setup(null, 1);
    stream.client.beginFactors!(3, { folder: 'f', windows: [], width: 1, height: 1 });
    expect(
      stream.client.startFactorPool!(3, { folder: 'f', windows: [], width: 1, height: 1 }),
    ).toBe(0);
    expect(stream.workers()).toBe(1);
  });
});
