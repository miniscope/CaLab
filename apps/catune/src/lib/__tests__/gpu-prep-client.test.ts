/**
 * gpu-prep-client stall watchdog: a prep worker that stops answering must not
 * leave requests pending forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SolverParams } from '@calab/core';
import { GPU_STARTUP_TIMEOUT_MS } from '@calab/compute';
import { createGpuPrepClient } from '../gpu-prep-client.ts';
import type { GpuPrepInbound } from '../../workers/gpu-prep-types.ts';

const PARAMS: SolverParams = {
  tauRise: 0.02,
  tauDecay: 0.4,
  lambda: 0.5,
  fs: 30,
  filterEnabled: false,
  convMode: 'banded',
};

interface FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  posted: GpuPrepInbound[];
  terminated: boolean;
  send(data: unknown): void;
}

/** Workers that only do what the test tells them to. */
function makeWorkers() {
  const workers: FakeWorker[] = [];
  const create = (): Worker => {
    const w: FakeWorker = {
      onmessage: null,
      onerror: null,
      posted: [],
      terminated: false,
      send(data) {
        w.onmessage?.({ data } as MessageEvent);
      },
    };
    workers.push(w);
    return {
      get onmessage() {
        return w.onmessage;
      },
      set onmessage(f) {
        w.onmessage = f;
      },
      get onerror() {
        return w.onerror;
      },
      set onerror(f) {
        w.onerror = f;
      },
      postMessage: (msg: GpuPrepInbound) => w.posted.push(msg),
      terminate: () => (w.terminated = true),
    } as unknown as Worker;
  };
  return { workers, create };
}

describe('gpu-prep-client: stall timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects a request the worker never answers, and replaces the worker', async () => {
    const { workers, create } = makeWorkers();
    const client = createGpuPrepClient(create);
    const p = client.workingTrace(0, 0, new Float32Array(4), PARAMS);
    const settled = vi.fn();
    p.then(settled, settled);
    workers[0].send({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0].posted).toHaveLength(1); // sent, never answered

    await vi.advanceTimersByTimeAsync(GPU_STARTUP_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toThrow(/no progress in 10000 ms/);
    expect(workers[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // nothing left armed

    // The failed entry is not cached; the next request starts a fresh worker.
    const q = client.workingTrace(0, 0, new Float32Array(4), PARAMS);
    expect(workers).toHaveLength(2);
    workers[1].send({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    const msg = workers[1].posted[0];
    workers[1].send({ type: 'prepped', id: msg.id, working: new Float32Array([1, 2]) });
    await expect(q).resolves.toEqual(new Float32Array([1, 2]));
    client.dispose();
  });

  it('rejects requests when the worker never reports ready', async () => {
    const { workers, create } = makeWorkers();
    const client = createGpuPrepClient(create, 100);
    const p = client.reference(new Float32Array(4), PARAMS);
    const rejected = expect(p).rejects.toThrow(/no progress in 100 ms/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(workers[0].posted).toHaveLength(0);
    // A late ready from the replaced worker does not post the dropped request.
    workers[0].send({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0].posted).toHaveLength(0);
    client.dispose();
  });

  it('does not time out a slow queue that keeps making progress', async () => {
    const { workers, create } = makeWorkers();
    const client = createGpuPrepClient(create, 100);
    const ps = [0, 1, 2].map((c) => client.workingTrace(c, 0, new Float32Array(4), PARAMS));
    workers[0].send({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    const posted = workers[0].posted;
    expect(posted).toHaveLength(3);
    // Answer one every 80 ms: 240 ms in total, but never 100 ms of silence.
    for (const msg of posted) {
      await vi.advanceTimersByTimeAsync(80);
      workers[0].send({ type: 'prepped', id: msg.id, working: new Float32Array([msg.id]) });
    }
    const results = await Promise.all(ps);
    expect(results.map((r) => r[0])).toEqual(posted.map((m) => m.id));
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  });

  it('dispose rejects pending requests and clears the watchdog', async () => {
    const { create } = makeWorkers();
    const client = createGpuPrepClient(create, 100);
    const p = client.workingTrace(-1, 0, new Float32Array(4), PARAMS);
    client.dispose();
    await expect(p).rejects.toThrow('disposed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
