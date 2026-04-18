import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerInbound, WorkerOutbound } from '@calab/cala-runtime';
import { createWorkerHarness, type WorkerHarness } from './worker-harness.ts';

// Tiny stride so tests can observe heartbeats without waiting real time.
const TEST_HEARTBEAT_STRIDE_MS = 5;
const TEST_TICK_INTERVAL_MS = 1;

function makeInitMsg(overrides: Record<string, unknown> = {}): WorkerInbound {
  return {
    kind: 'init',
    payload: {
      role: 'extend',
      frameChannelBuffer: new ArrayBuffer(8),
      residualChannelBuffer: new ArrayBuffer(8),
      workerConfig: {
        heartbeatStrideMs: TEST_HEARTBEAT_STRIDE_MS,
        tickIntervalMs: TEST_TICK_INTERVAL_MS,
        ...overrides,
      },
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
  await import('../extend.worker.ts');
}

describe('extend worker (stub)', () => {
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
    expect(ready).toEqual({ kind: 'ready', role: 'extend' });
  });

  it('stop before run posts done without emitting any heartbeat', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'stop' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));
    expect(harness.posted.some((m) => m.kind === 'frame-processed')).toBe(false);
    expect(harness.posted.some((m) => m.kind === 'event')).toBe(false);
    // `done` is posted exactly once for the stop path.
    expect(harness.posted.filter((m) => m.kind === 'done').length).toBe(1);
  });

  it('run emits frame-processed heartbeats and a bus event after a new snapshot ack', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    // Heartbeats fire first; bus event only fires once a new snapshot
    // is observed (design §7.2 — extend advances epoch on ack).
    await runUntil(harness, (p) => p.some((m) => m.kind === 'frame-processed'));
    await harness.deliver({
      kind: 'snapshot-ack',
      requestId: 1,
      epoch: 3n,
      numComponents: 0,
      pixels: 0,
    });

    await runUntil(
      harness,
      (p) =>
        p.some((m) => m.kind === 'frame-processed') && p.some((m) => m.kind === 'event'),
    );

    const heartbeat = harness.posted.find((m) => m.kind === 'frame-processed');
    expect(heartbeat).toMatchObject({ kind: 'frame-processed', role: 'extend' });

    const eventMsg = harness.posted.find(
      (m): m is Extract<WorkerOutbound, { kind: 'event' }> => m.kind === 'event',
    );
    expect(eventMsg?.role).toBe('extend');
    expect(eventMsg?.event.kind).toBe('metric');
    if (eventMsg?.event.kind === 'metric') {
      expect(eventMsg.event.name).toBe('extend.heartbeat');
    }

    await harness.deliver({ kind: 'stop' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));
  });

  it('snapshot-ack advances lastObservedEpoch reported in subsequent heartbeats', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    await harness.deliver({ kind: 'run' });

    await runUntil(harness, (p) => p.some((m) => m.kind === 'frame-processed'));
    const beforeAck = harness.posted
      .filter(
        (m): m is Extract<WorkerOutbound, { kind: 'frame-processed' }> =>
          m.kind === 'frame-processed',
      )
      .pop();
    expect(beforeAck?.epoch).toBe(0n);

    await harness.deliver({
      kind: 'snapshot-ack',
      requestId: 1,
      epoch: 5n,
      numComponents: 0,
      pixels: 0,
    });

    await runUntil(harness, (p) => {
      const beats = p.filter(
        (m): m is Extract<WorkerOutbound, { kind: 'frame-processed' }> =>
          m.kind === 'frame-processed',
      );
      return beats.some((b) => b.epoch === 5n);
    });

    await harness.deliver({ kind: 'stop' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));
  });
});
