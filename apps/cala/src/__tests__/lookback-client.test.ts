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

  it('a pool started mid-run gets the run so far: begin, every row joined, the newest flat field', () => {
    const t = setup(null, 2);
    t.client.begin(1);
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
    expect(t.pools).toEqual([[1, 2]]);
    for (const w of [1, 2]) {
      const mine = t.sent.filter((x) => x.worker === w).map((x) => x.msg);
      expect(mine.map((m) => m.type)).toEqual(['connect', 'begin', 'rows', 'flat']);
      const r = mine[2] as Extract<MainToLookback, { type: 'rows' }>;
      expect(r.start).toBe(0);
      expect(Array.from(r.dy)).toEqual(Array.from({ length: 16 }, (_, k) => k));
    }
    // Each its own arrays.
    const joined = t.sent.filter((x) => x.worker > 0 && x.msg.type === 'rows');
    const bufs = joined.flatMap((x) => x.transfer);
    expect(new Set(bufs).size).toBe(bufs.length);
    // Once only; from now on the pool gets every message too.
    expect(t.client.startPool?.(1)).toBe(2);
    expect(t.pools).toHaveLength(1);
    rows(16, 8);
    expect(
      t.sent
        .filter((x) => x.msg.type === 'rows' && (x.msg as { start: number }).start === 16)
        .map((x) => x.worker),
    ).toEqual([0, 1, 2]);
    // A new run: only worker 0 until it goes below Max.
    t.client.reset(1);
    t.client.begin(2);
    rows(0, 8);
    expect(
      t.sent
        .filter((x) => x.msg.type === 'begin' && (x.msg as { session: number }).session === 2)
        .map((x) => x.worker),
    ).toEqual([0]);
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
    t.client.flatField(1, null);
    t.client.reset(1);
    expect(t.sent.filter((x) => x.msg.type === 'reset').map((x) => x.worker)).toEqual([0, 1, 2]);
    t.client.pace?.(60, false);
    expect(t.paces).toEqual([[60, false]]);
    t.client.dispose();
    expect(t.terminated).toEqual([0, 1, 2]);
  });
});
