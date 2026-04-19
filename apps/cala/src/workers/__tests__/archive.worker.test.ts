import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineEvent, WorkerInbound, WorkerOutbound } from '@calab/cala-runtime';
import { createWorkerHarness, type WorkerHarness } from './worker-harness.ts';

// Small capacities keep drop-oldest behaviour observable in-test without
// arbitrary numbers leaking from production defaults.
const TEST_EVENT_RING_CAPACITY = 4;
const TEST_METRIC_WINDOW = 16;
// Tiered timeseries sizing that makes L1 eviction + L2 emission
// reachable in a handful of appends (see timeseries-store.test.ts).
const TEST_TS_L1_CAPACITY = 4;
const TEST_TS_L2_CAPACITY = 8;
const TEST_TS_L2_STRIDE = 2;

function makeInitMsg(overrides: Record<string, unknown> = {}): WorkerInbound {
  return {
    kind: 'init',
    payload: {
      role: 'archive',
      frameChannelBuffer: new ArrayBuffer(8),
      residualChannelBuffer: new ArrayBuffer(8),
      workerConfig: {
        eventRingCapacity: TEST_EVENT_RING_CAPACITY,
        metricWindow: TEST_METRIC_WINDOW,
        timeseriesL1Capacity: TEST_TS_L1_CAPACITY,
        timeseriesL2Capacity: TEST_TS_L2_CAPACITY,
        timeseriesL2Stride: TEST_TS_L2_STRIDE,
        ...overrides,
      },
    },
  };
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

async function runUntil(
  harness: WorkerHarness,
  predicate: (posted: WorkerOutbound[]) => boolean,
  maxTicks = 1000,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate(harness.posted)) return;
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  if (!predicate(harness.posted)) {
    throw new Error('runUntil timed out');
  }
}

async function loadWorker(harness: WorkerHarness): Promise<void> {
  vi.stubGlobal('self', harness.self);
  await import('../archive.worker.ts');
}

// Type-level guard for the protocol extension this task adds.
// Failure to compile here means the inbound `event` /
// `request-archive-dump` or outbound `archive-dump` variants
// regressed — breaking the archive worker contract with the
// orchestrator and task 24's dashboard client.
describe('worker-protocol archive extension compiles', () => {
  it('accepts the new inbound and outbound variants', () => {
    const inEvent: WorkerInbound = {
      kind: 'event',
      event: { kind: 'metric', t: 0, name: 'x', value: 1 },
    };
    const inDumpReq: WorkerInbound = { kind: 'request-archive-dump', requestId: 1 };
    const inTsReq: WorkerInbound = { kind: 'request-timeseries', requestId: 2, name: 'fps' };
    const inNeuronReq: WorkerInbound = {
      kind: 'request-events-for-neuron',
      requestId: 3,
      neuronId: 5,
    };
    const outDump: WorkerOutbound = {
      kind: 'archive-dump',
      role: 'archive',
      requestId: 1,
      events: [],
      metrics: {},
    };
    const outTs: WorkerOutbound = {
      kind: 'timeseries',
      role: 'archive',
      requestId: 2,
      name: 'fps',
      l1Times: new Float32Array(0),
      l1Values: new Float32Array(0),
      l2Times: new Float32Array(0),
      l2Values: new Float32Array(0),
    };
    const outNeuron: WorkerOutbound = {
      kind: 'events-for-neuron',
      role: 'archive',
      requestId: 3,
      neuronId: 5,
      events: [],
    };
    expect(inEvent.kind).toBe('event');
    expect(inDumpReq.kind).toBe('request-archive-dump');
    expect(inTsReq.kind).toBe('request-timeseries');
    expect(inNeuronReq.kind).toBe('request-events-for-neuron');
    expect(outDump.kind).toBe('archive-dump');
    expect(outTs.kind).toBe('timeseries');
    expect(outNeuron.kind).toBe('events-for-neuron');
  });
});

describe('archive worker', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('responds to init with ready', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    const ready = harness.posted.find((m) => m.kind === 'ready');
    expect(ready).toEqual({ kind: 'ready', role: 'archive' });
  });

  it('appends events to the log and drops oldest once capacity is reached', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    // Push capacity + 2 events; the first two should be dropped.
    for (let i = 0; i < TEST_EVENT_RING_CAPACITY + 2; i += 1) {
      await harness.deliver({ kind: 'event', event: birthEvent(i, i) });
    }

    await harness.deliver({ kind: 'request-archive-dump', requestId: 7 });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'archive-dump'));
    const dump = harness.posted.find((m) => m.kind === 'archive-dump') as Extract<
      WorkerOutbound,
      { kind: 'archive-dump' }
    >;
    expect(dump.requestId).toBe(7);
    expect(dump.events.length).toBe(TEST_EVENT_RING_CAPACITY);
    // Oldest two (ids 0, 1) should have been evicted; newest ids should remain.
    const ids = dump.events
      .filter((e): e is Extract<PipelineEvent, { kind: 'birth' }> => e.kind === 'birth')
      .map((e) => e.id);
    expect(ids).toEqual([2, 3, 4, 5]);
  });

  it('updates the per-name metric snapshot from metric events', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await harness.deliver({ kind: 'event', event: metricEvent(1, 'residual_l2', 0.5) });
    await harness.deliver({ kind: 'event', event: metricEvent(2, 'cell_count', 12) });
    // Overwrite is last-writer-wins for a given name.
    await harness.deliver({ kind: 'event', event: metricEvent(3, 'residual_l2', 0.2) });

    await harness.deliver({ kind: 'request-archive-dump', requestId: 42 });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'archive-dump'));
    const dump = harness.posted.find((m) => m.kind === 'archive-dump') as Extract<
      WorkerOutbound,
      { kind: 'archive-dump' }
    >;
    expect(dump.metrics).toEqual({ residual_l2: 0.2, cell_count: 12 });
  });

  it('request-archive-dump returns the right shape and correlates requestId', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await harness.deliver({ kind: 'event', event: birthEvent(1, 1) });
    await harness.deliver({ kind: 'event', event: metricEvent(2, 'fps', 30) });

    await harness.deliver({ kind: 'request-archive-dump', requestId: 101 });
    await harness.deliver({ kind: 'request-archive-dump', requestId: 202 });
    await runUntil(harness, (p) => p.filter((m) => m.kind === 'archive-dump').length >= 2);
    const dumps = harness.posted.filter(
      (m): m is Extract<WorkerOutbound, { kind: 'archive-dump' }> => m.kind === 'archive-dump',
    );
    expect(dumps.map((d) => d.requestId)).toEqual([101, 202]);
    for (const d of dumps) {
      expect(d.role).toBe('archive');
      expect(Array.isArray(d.events)).toBe(true);
      expect(d.events.length).toBe(2);
      expect(d.metrics.fps).toBe(30);
    }
  });

  it('request-timeseries returns an empty reply for an unknown name', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await harness.deliver({ kind: 'request-timeseries', requestId: 51, name: 'nope' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'timeseries'));
    const reply = harness.posted.find((m) => m.kind === 'timeseries') as Extract<
      WorkerOutbound,
      { kind: 'timeseries' }
    >;
    expect(reply.requestId).toBe(51);
    expect(reply.name).toBe('nope');
    expect(reply.l1Times.length).toBe(0);
    expect(reply.l2Times.length).toBe(0);
  });

  it('request-timeseries returns L1 samples appended from metric events', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await harness.deliver({ kind: 'event', event: metricEvent(0, 'fps', 10) });
    await harness.deliver({ kind: 'event', event: metricEvent(1, 'fps', 20) });
    await harness.deliver({ kind: 'event', event: metricEvent(2, 'fps', 30) });

    await harness.deliver({ kind: 'request-timeseries', requestId: 60, name: 'fps' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'timeseries'));
    const reply = harness.posted.find((m) => m.kind === 'timeseries') as Extract<
      WorkerOutbound,
      { kind: 'timeseries' }
    >;
    expect(Array.from(reply.l1Times)).toEqual([0, 1, 2]);
    expect(Array.from(reply.l1Values)).toEqual([10, 20, 30]);
    expect(reply.l2Times.length).toBe(0);
  });

  it('request-events-for-neuron returns every structural event the neuron participates in', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await harness.deliver({ kind: 'event', event: birthEvent(1, 7) });
    await harness.deliver({
      kind: 'event',
      event: {
        kind: 'merge',
        t: 2,
        ids: [7, 8],
        into: 7,
        footprintSnap: {
          pixelIndices: new Uint32Array([7]),
          values: new Float32Array([1]),
        },
      },
    });
    await harness.deliver({
      kind: 'event',
      event: { kind: 'deprecate', t: 3, id: 7, reason: 'traceInactive' },
    });
    // Unrelated neuron — must not appear in the reply for id 7.
    await harness.deliver({ kind: 'event', event: birthEvent(4, 99) });

    await harness.deliver({ kind: 'request-events-for-neuron', requestId: 70, neuronId: 7 });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'events-for-neuron'));
    const reply = harness.posted.find((m) => m.kind === 'events-for-neuron') as Extract<
      WorkerOutbound,
      { kind: 'events-for-neuron' }
    >;
    expect(reply.neuronId).toBe(7);
    expect(reply.events.map((e) => e.kind)).toEqual(['birth', 'merge', 'deprecate']);
  });

  it('harvests footprint history from birth events + periodic footprint-snapshot', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await harness.deliver({ kind: 'event', event: birthEvent(1, 12) });
    await harness.deliver({
      kind: 'event',
      event: {
        kind: 'footprint-snapshot',
        t: 5,
        neuronId: 12,
        footprint: {
          pixelIndices: new Uint32Array([3, 4, 5]),
          values: new Float32Array([0.7, 0.8, 0.9]),
        },
      },
    });

    await harness.deliver({ kind: 'request-footprint-history', requestId: 80, neuronId: 12 });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'footprint-history'));
    const reply = harness.posted.find((m) => m.kind === 'footprint-history') as Extract<
      WorkerOutbound,
      { kind: 'footprint-history' }
    >;
    expect(reply.neuronId).toBe(12);
    expect(Array.from(reply.times)).toEqual([1, 5]);
    expect(reply.pixelIndices.length).toBe(2);
    expect(Array.from(reply.pixelIndices[1])).toEqual([3, 4, 5]);
    // Float32 round-trip: tolerant compare avoids spurious precision diffs.
    const vs = Array.from(reply.values[1]);
    expect(vs[0]).toBeCloseTo(0.7, 5);
    expect(vs[1]).toBeCloseTo(0.8, 5);
    expect(vs[2]).toBeCloseTo(0.9, 5);
  });

  it('request-footprint-history returns empty arrays for an unknown neuron', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await harness.deliver({ kind: 'request-footprint-history', requestId: 81, neuronId: 999 });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'footprint-history'));
    const reply = harness.posted.find((m) => m.kind === 'footprint-history') as Extract<
      WorkerOutbound,
      { kind: 'footprint-history' }
    >;
    expect(reply.times.length).toBe(0);
    expect(reply.pixelIndices.length).toBe(0);
    expect(reply.values.length).toBe(0);
  });

  it('request-events-for-neuron returns an empty list for an unknown id', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await harness.deliver({ kind: 'request-events-for-neuron', requestId: 71, neuronId: 999 });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'events-for-neuron'));
    const reply = harness.posted.find((m) => m.kind === 'events-for-neuron') as Extract<
      WorkerOutbound,
      { kind: 'events-for-neuron' }
    >;
    expect(reply.events).toEqual([]);
  });

  it('request-timeseries surfaces L2 downsampling once L1 overflows', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    // l1Capacity=4, l2Stride=2 → 6 metric events leave 4 in L1 and 1
    // averaged sample in L2.
    for (let i = 0; i < 6; i += 1) {
      await harness.deliver({ kind: 'event', event: metricEvent(i, 'fps', i * 10) });
    }
    await harness.deliver({ kind: 'request-timeseries', requestId: 61, name: 'fps' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'timeseries'));
    const reply = harness.posted.find((m) => m.kind === 'timeseries') as Extract<
      WorkerOutbound,
      { kind: 'timeseries' }
    >;
    expect(Array.from(reply.l1Times)).toEqual([2, 3, 4, 5]);
    expect(Array.from(reply.l2Values)).toEqual([5]);
  });

  it('stop posts done exactly once even if events arrive after stop', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await harness.deliver({ kind: 'event', event: metricEvent(1, 'a', 1) });
    await harness.deliver({ kind: 'stop' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));

    // Post-stop events must not mutate state or trigger further `done`.
    await harness.deliver({ kind: 'event', event: metricEvent(2, 'a', 99) });
    const doneCount = harness.posted.filter((m) => m.kind === 'done').length;
    expect(doneCount).toBe(1);
  });
});
