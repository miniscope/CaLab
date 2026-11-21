// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createLookbackClient, type LookbackWorkerLike } from '../lib/lookback-client.ts';
import type { MainToLookback } from '../workers/lookback-types.ts';

function setup(blocked: string | null = null) {
  const sent: { msg: MainToLookback; transfer: Transferable[] }[] = [];
  let workers = 0;
  const ports: unknown[] = [];
  const client = createLookbackClient({
    slow: { connectLookback: (p) => ports.push(p) },
    source: () => ({ entries: [] }),
    blocked: () => blocked,
    makeWorker: () => {
      workers++;
      return {
        postMessage: (msg: MainToLookback, transfer: Transferable[] = []) =>
          sent.push({ msg, transfer }),
        terminate() {},
        onmessage: null,
        onerror: null,
      } as unknown as LookbackWorkerLike;
    },
    makeChannel: () => ({ port1: {} as MessagePort, port2: {} as MessagePort }),
  });
  return { client, sent, ports, workers: () => workers };
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
});
