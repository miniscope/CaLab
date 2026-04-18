import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipelineEvent,
  WorkerInbound,
  WorkerOutbound,
} from '@calab/cala-runtime';
import { createWorkerHarness, type WorkerHarness } from './worker-harness.ts';

// Small capacities keep drop-oldest behaviour observable in-test without
// arbitrary numbers leaking from production defaults.
const TEST_EVENT_RING_CAPACITY = 4;
const TEST_METRIC_WINDOW = 16;

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
    const outDump: WorkerOutbound = {
      kind: 'archive-dump',
      role: 'archive',
      requestId: 1,
      events: [],
      metrics: {},
    };
    expect(inEvent.kind).toBe('event');
    expect(inDumpReq.kind).toBe('request-archive-dump');
    expect(outDump.kind).toBe('archive-dump');
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
    await runUntil(
      harness,
      (p) => p.filter((m) => m.kind === 'archive-dump').length >= 2,
    );
    const dumps = harness.posted.filter(
      (m): m is Extract<WorkerOutbound, { kind: 'archive-dump' }> =>
        m.kind === 'archive-dump',
    );
    expect(dumps.map((d) => d.requestId)).toEqual([101, 202]);
    for (const d of dumps) {
      expect(d.role).toBe('archive');
      expect(Array.isArray(d.events)).toBe(true);
      expect(d.events.length).toBe(2);
      expect(d.metrics.fps).toBe(30);
    }
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
