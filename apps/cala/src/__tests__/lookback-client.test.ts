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
  const terminated: number[] = [];
  const client = createLookbackClient({
    slow: {
      connectLookback: (p, i) => {
        ports.push(p);
        indices.push(i ?? 0);
      },
      settlePace: (fps, paused) => paces.push([fps, paused]),
    },
    workers: 1 + pool,
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
  return { client, sent, ports, indices, paces, terminated, workers: () => workers };
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

  it('a pool: S + 1 workers, each wired by index and fed its own copies', () => {
    const t = setup(null, 2);
    expect(t.client.begin(1)).toBe(true);
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
