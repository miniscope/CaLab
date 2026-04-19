import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PipelineEvent, WorkerInbound, WorkerLike, WorkerOutbound } from '@calab/cala-runtime';
import {
  createArchiveClient,
  DEFAULT_DUMP_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type ArchiveClient,
} from '../archive-client.ts';

class FakeWorker implements WorkerLike {
  public readonly posted: WorkerInbound[] = [];
  public terminated = false;
  private readonly listeners = new Set<(ev: { data: WorkerOutbound }) => void>();

  postMessage(message: WorkerInbound): void {
    this.posted.push(message);
  }

  addEventListener(_type: 'message', listener: (ev: { data: WorkerOutbound }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (ev: { data: WorkerOutbound }) => void): void {
    this.listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
    this.listeners.clear();
  }

  push(msg: WorkerOutbound): void {
    for (const l of [...this.listeners]) l({ data: msg });
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function metricEvent(t: number, name: string, value: number): PipelineEvent {
  return { kind: 'metric', t, name, value };
}

function birthEvent(t: number, id: number): PipelineEvent {
  return {
    kind: 'birth',
    t,
    id,
    patch: [0, 0],
    footprintSnap: {
      pixelIndices: new Uint32Array([id]),
      values: new Float32Array([1]),
    },
  };
}

describe('cala archive-client', () => {
  let worker: FakeWorker;
  let client: ArchiveClient;

  beforeEach(() => {
    worker = new FakeWorker();
    client = createArchiveClient(worker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    client.dispose();
  });

  it('requestDump posts request-archive-dump and resolves with matching requestId reply', async () => {
    const promise = client.requestDump();

    // First posted message should be a request-archive-dump with a numeric requestId.
    expect(worker.posted.length).toBe(1);
    const req = worker.posted[0];
    expect(req.kind).toBe('request-archive-dump');
    const requestId = (req as { requestId: number }).requestId;
    expect(Number.isFinite(requestId)).toBe(true);

    const events = [birthEvent(1, 1), metricEvent(2, 'residual', 0.5)];
    worker.push({
      kind: 'archive-dump',
      role: 'archive',
      requestId,
      events,
      metrics: { residual: 0.5 },
    });

    const dump = await promise;
    expect(dump.events).toEqual(events);
    expect(dump.metrics).toEqual({ residual: 0.5 });
  });

  it('correlates concurrent requests via requestId', async () => {
    const p1 = client.requestDump();
    const p2 = client.requestDump();
    const p3 = client.requestDump();

    expect(worker.posted.length).toBe(3);
    const ids = worker.posted.map((m) => (m as { requestId: number }).requestId);
    expect(new Set(ids).size).toBe(3); // monotonic, distinct

    // Resolve in reverse order — each promise must get its own reply.
    worker.push({
      kind: 'archive-dump',
      role: 'archive',
      requestId: ids[2],
      events: [metricEvent(3, 'three', 3)],
      metrics: { three: 3 },
    });
    worker.push({
      kind: 'archive-dump',
      role: 'archive',
      requestId: ids[0],
      events: [metricEvent(1, 'one', 1)],
      metrics: { one: 1 },
    });
    worker.push({
      kind: 'archive-dump',
      role: 'archive',
      requestId: ids[1],
      events: [metricEvent(2, 'two', 2)],
      metrics: { two: 2 },
    });

    const [d1, d2, d3] = await Promise.all([p1, p2, p3]);
    expect(d1.metrics).toEqual({ one: 1 });
    expect(d2.metrics).toEqual({ two: 2 });
    expect(d3.metrics).toEqual({ three: 3 });
  });

  it('rejects the pending dump when no reply arrives before DEFAULT_DUMP_TIMEOUT_MS', async () => {
    const promise = client.requestDump();
    // Attach rejection handler synchronously so the eventual rejection
    // after advanceTimersByTime has a listener — avoids unhandled-rejection noise.
    const caught = promise.catch((err: unknown) => err);
    vi.advanceTimersByTime(DEFAULT_DUMP_TIMEOUT_MS + 1);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toMatch(/Abort|Timeout/);
  });

  it('ignores archive-dump replies with unknown requestId', async () => {
    const promise = client.requestDump();
    const requestId = (worker.posted[0] as { requestId: number }).requestId;

    // Stray reply with an unknown id — must not resolve the pending promise.
    worker.push({
      kind: 'archive-dump',
      role: 'archive',
      requestId: requestId + 9999,
      events: [],
      metrics: {},
    });

    // Resolve with the real id — promise should still resolve cleanly.
    worker.push({
      kind: 'archive-dump',
      role: 'archive',
      requestId,
      events: [birthEvent(4, 4)],
      metrics: { real: 1 },
    });

    const dump = await promise;
    expect(dump.metrics).toEqual({ real: 1 });
  });

  it('startPolling invokes the callback at DEFAULT_POLL_INTERVAL_MS cadence; stopPolling halts', async () => {
    const received: number[] = [];
    client.startPolling((dump) => {
      received.push(dump.events.length);
    });

    // First tick: driver posts a request immediately on start.
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.posted.length).toBe(1);
    let reqId = (worker.posted[0] as { requestId: number }).requestId;
    worker.push({
      kind: 'archive-dump',
      role: 'archive',
      requestId: reqId,
      events: [birthEvent(1, 1)],
      metrics: {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(received.length).toBe(1);

    // Second tick at the poll interval.
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    expect(worker.posted.length).toBe(2);
    reqId = (worker.posted[1] as { requestId: number }).requestId;
    worker.push({
      kind: 'archive-dump',
      role: 'archive',
      requestId: reqId,
      events: [birthEvent(2, 2), birthEvent(3, 3)],
      metrics: {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(received.length).toBe(2);
    expect(received[1]).toBe(2);

    client.stopPolling();
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 3);
    // No new posts after stopPolling.
    expect(worker.posted.length).toBe(2);
  });

  it('dispose removes listeners and rejects any in-flight requestDump', async () => {
    const p = client.requestDump();
    const caught = p.catch((err: unknown) => err);
    expect(worker.listenerCount()).toBeGreaterThan(0);

    client.dispose();
    expect(worker.listenerCount()).toBe(0);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toMatch(/Abort|Dispose/);
  });

  it('requestTimeseries posts request-timeseries and resolves with typed-array payloads', async () => {
    const promise = client.requestTimeseries('fps');
    expect(worker.posted.length).toBe(1);
    const req = worker.posted[0] as { kind: string; requestId: number; name: string };
    expect(req.kind).toBe('request-timeseries');
    expect(req.name).toBe('fps');

    worker.push({
      kind: 'timeseries',
      role: 'archive',
      requestId: req.requestId,
      name: 'fps',
      l1Times: new Float32Array([0, 1, 2]),
      l1Values: new Float32Array([30, 29, 30]),
      l2Times: new Float32Array([]),
      l2Values: new Float32Array([]),
    });

    const reply = await promise;
    expect(reply.name).toBe('fps');
    expect(Array.from(reply.l1Times)).toEqual([0, 1, 2]);
    expect(Array.from(reply.l1Values)).toEqual([30, 29, 30]);
  });

  it('requestEventsForNeuron posts request-events-for-neuron and resolves with the event list', async () => {
    const promise = client.requestEventsForNeuron(42);
    const req = worker.posted[0] as {
      kind: string;
      requestId: number;
      neuronId: number;
    };
    expect(req.kind).toBe('request-events-for-neuron');
    expect(req.neuronId).toBe(42);

    const events = [birthEvent(1, 42)];
    worker.push({
      kind: 'events-for-neuron',
      role: 'archive',
      requestId: req.requestId,
      neuronId: 42,
      events,
    });
    expect(await promise).toEqual(events);
  });

  it('requestFootprintHistory pairs times with parallel typed-array payloads', async () => {
    const promise = client.requestFootprintHistory(9);
    const req = worker.posted[0] as {
      kind: string;
      requestId: number;
      neuronId: number;
    };
    expect(req.kind).toBe('request-footprint-history');
    expect(req.neuronId).toBe(9);

    worker.push({
      kind: 'footprint-history',
      role: 'archive',
      requestId: req.requestId,
      neuronId: 9,
      times: new Float32Array([1, 5]),
      pixelIndices: [new Uint32Array([1]), new Uint32Array([3, 4])],
      values: [new Float32Array([0.5]), new Float32Array([0.1, 0.2])],
    });

    const history = await promise;
    expect(history.length).toBe(2);
    expect(history[0].t).toBe(1);
    expect(Array.from(history[1].pixelIndices)).toEqual([3, 4]);
    expect(Array.from(history[1].values)).toEqual([0.10000000149011612, 0.20000000298023224]);
  });

  it('onEvent delivers PipelineEvent messages posted by the worker', () => {
    const received: PipelineEvent[] = [];
    const unsub = client.onEvent((e) => {
      received.push(e);
    });

    const e1 = birthEvent(7, 7);
    worker.push({ kind: 'event', role: 'archive', event: e1 });
    expect(received).toEqual([e1]);

    unsub();
    worker.push({
      kind: 'event',
      role: 'archive',
      event: metricEvent(8, 'after-unsub', 0),
    });
    expect(received.length).toBe(1);
  });
});
