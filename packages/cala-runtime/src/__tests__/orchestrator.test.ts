import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createRuntime,
  RuntimeStartupTimeoutError,
  RuntimeShutdownTimeoutError,
  type RuntimeConfig,
  type RuntimeController,
  type RuntimeSource,
  type RuntimeState,
  type RuntimeStatus,
} from '../orchestrator.ts';
import type { PipelineEvent, EventBusConfig } from '../events.ts';
import type { ChannelConfig } from '../types.ts';
import type { MutationQueueConfig } from '../mutation-queue.ts';
import type { SnapshotProtocolConfig } from '../asset-snapshot.ts';
import type {
  WorkerFactory,
  WorkerInbound,
  WorkerLike,
  WorkerOutbound,
  WorkerRole,
} from '../worker-protocol.ts';

// ---------------------------------------------------------------------------
// Fake-worker harness. Captures every postMessage the orchestrator sends and
// exposes `push()` so tests script-drive inbound messages without ever
// spinning a real `Worker`.
// ---------------------------------------------------------------------------
class FakeWorker implements WorkerLike {
  public readonly posted: WorkerInbound[] = [];
  public terminated = false;
  private readonly listeners = new Set<(ev: { data: WorkerOutbound }) => void>();

  constructor(public readonly role: WorkerRole) {}

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
}

class Harness {
  readonly workers = new Map<WorkerRole, FakeWorker>();

  factories(): Record<WorkerRole, WorkerFactory> {
    const make =
      (role: WorkerRole): WorkerFactory =>
      () => {
        const w = new FakeWorker(role);
        this.workers.set(role, w);
        return w;
      };
    return {
      decodePreprocess: make('decodePreprocess'),
      fit: make('fit'),
      extend: make('extend'),
      archive: make('archive'),
    };
  }

  get(role: WorkerRole): FakeWorker {
    const w = this.workers.get(role);
    if (!w) throw new Error(`worker ${role} not spawned`);
    return w;
  }

  pushReadyAll(): void {
    for (const [role, worker] of this.workers) {
      worker.push({ kind: 'ready', role });
    }
  }

  pushDoneAll(): void {
    for (const [role, worker] of this.workers) {
      worker.push({ kind: 'done', role });
    }
  }
}

const FRAME_CHANNEL: ChannelConfig = {
  slotBytes: 64,
  slotCount: 4,
  waitTimeoutMs: 50,
  pollIntervalMs: 1,
};
const RESIDUAL_CHANNEL: ChannelConfig = {
  slotBytes: 64,
  slotCount: 4,
  waitTimeoutMs: 50,
  pollIntervalMs: 1,
};
const MUTATION_QUEUE: MutationQueueConfig = { capacity: 8 };
const SNAPSHOT_PROTOCOL: SnapshotProtocolConfig = {
  ackTimeoutMs: 100,
  pendingCapacity: 1,
  pollIntervalMs: 1,
};
const EVENT_BUS: EventBusConfig = { capacity: 16, maxSubscribers: 4 };

function makeCfg(harness: Harness, overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    workerFactories: harness.factories(),
    frameChannel: FRAME_CHANNEL,
    residualChannel: RESIDUAL_CHANNEL,
    mutationQueue: MUTATION_QUEUE,
    snapshotProtocol: SNAPSHOT_PROTOCOL,
    eventBus: EVENT_BUS,
    startupTimeoutMs: 50,
    shutdownTimeoutMs: 50,
    ...overrides,
  };
}

function fakeSource(): RuntimeSource {
  return {
    kind: 'file',
    file: new File([new Uint8Array(4)], 'fake.avi'),
    frameSourceFactory: async () => null,
  };
}

// Flushes pending microtasks so the orchestrator can observe queued
// ready-handshake + transition side-effects before the test continues.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createRuntime config validation', () => {
  it('rejects non-function workerFactories entries', () => {
    const harness = new Harness();
    const base = makeCfg(harness);
    expect(() =>
      createRuntime({
        ...base,
        workerFactories: {
          ...base.workerFactories,
          fit: undefined as unknown as WorkerFactory,
        },
      }),
    ).toThrow(/workerFactories\.fit/);
  });

  it('rejects non-positive startupTimeoutMs', () => {
    const harness = new Harness();
    expect(() => createRuntime(makeCfg(harness, { startupTimeoutMs: 0 }))).toThrow(
      /startupTimeoutMs/,
    );
  });

  it('rejects non-positive shutdownTimeoutMs', () => {
    const harness = new Harness();
    expect(() => createRuntime(makeCfg(harness, { shutdownTimeoutMs: -1 }))).toThrow(
      /shutdownTimeoutMs/,
    );
  });
});

describe('startup handshake', () => {
  it('posts init to all four workers on run()', async () => {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness));
    const runP = rt.run(fakeSource());

    // Each worker was spawned and received an init message.
    await flush();
    for (const role of ['decodePreprocess', 'fit', 'extend', 'archive'] as const) {
      const w = harness.get(role);
      expect(w.posted.length).toBeGreaterThanOrEqual(1);
      expect(w.posted[0].kind).toBe('init');
    }

    harness.pushReadyAll();
    await flush();
    // All four received `run` after readies.
    for (const role of ['decodePreprocess', 'fit', 'extend', 'archive'] as const) {
      expect(harness.get(role).posted.some((m) => m.kind === 'run')).toBe(true);
    }

    harness.pushDoneAll();
    await runP;
  });

  it('rejects with RuntimeStartupTimeoutError when any worker never acks ready', async () => {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness, { startupTimeoutMs: 20 }));

    const runP = rt.run(fakeSource());
    // Only three workers reply ready; the fourth (extend) stays silent.
    await flush();
    harness.get('decodePreprocess').push({ kind: 'ready', role: 'decodePreprocess' });
    harness.get('fit').push({ kind: 'ready', role: 'fit' });
    harness.get('archive').push({ kind: 'ready', role: 'archive' });

    await expect(runP).rejects.toBeInstanceOf(RuntimeStartupTimeoutError);
    expect(rt.state()).toBe('error');
    // Every spawned worker was hard-terminated on the failure path.
    for (const w of harness.workers.values()) {
      expect(w.terminated).toBe(true);
    }
  });
});

describe('lifecycle transitions', () => {
  it('idle → starting → running → stopping → stopped, observed by onStatus', async () => {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness));
    const states: RuntimeState[] = [];
    rt.onStatus((s) => {
      if (states[states.length - 1] !== s.state) states.push(s.state);
    });

    expect(rt.state()).toBe('idle');
    const runP = rt.run(fakeSource());
    await flush();
    expect(rt.state()).toBe('starting');

    harness.pushReadyAll();
    await flush();
    expect(rt.state()).toBe('running');

    const stopP = rt.stop();
    expect(rt.state()).toBe('stopping');

    harness.pushDoneAll();
    await stopP;
    await runP;
    expect(rt.state()).toBe('stopped');

    expect(states).toEqual(['starting', 'running', 'stopping', 'stopped']);
  });
});

describe('epoch tracking', () => {
  async function bootRunning(): Promise<{ rt: RuntimeController; harness: Harness }> {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness));
    const runP = rt.run(fakeSource());
    await flush();
    harness.pushReadyAll();
    await flush();
    // Attach the run promise to rt so it can be awaited via stop() later.
    (rt as unknown as { __runP: Promise<void> }).__runP = runP;
    return { rt, harness };
  }

  it('starts at 0n', async () => {
    const { rt, harness } = await bootRunning();
    expect(rt.epoch()).toBe(0n);
    harness.pushDoneAll();
    await (rt as unknown as { __runP: Promise<void> }).__runP;
  });

  it('frame-processed does NOT advance epoch', async () => {
    const { rt, harness } = await bootRunning();
    const fit = harness.get('fit');
    fit.push({ kind: 'frame-processed', role: 'fit', index: 0, epoch: 0n });
    fit.push({ kind: 'frame-processed', role: 'fit', index: 1, epoch: 0n });
    fit.push({ kind: 'frame-processed', role: 'fit', index: 2, epoch: 0n });
    expect(rt.epoch()).toBe(0n);
    expect(rt.stats().framesProcessed).toBe(3);
    harness.pushDoneAll();
    await (rt as unknown as { __runP: Promise<void> }).__runP;
  });

  it('advances exactly once per mutation-applied', async () => {
    const { rt, harness } = await bootRunning();
    const fit = harness.get('fit');
    fit.push({ kind: 'mutation-applied', role: 'fit', epoch: 1n });
    expect(rt.epoch()).toBe(1n);
    fit.push({ kind: 'mutation-applied', role: 'fit', epoch: 2n });
    expect(rt.epoch()).toBe(2n);
    fit.push({ kind: 'mutation-applied', role: 'fit', epoch: 3n });
    expect(rt.epoch()).toBe(3n);
    expect(rt.stats().mutationsApplied).toBe(3n);
    harness.pushDoneAll();
    await (rt as unknown as { __runP: Promise<void> }).__runP;
  });

  it('is monotonic — out-of-order replay never decrements', async () => {
    const { rt, harness } = await bootRunning();
    const fit = harness.get('fit');
    fit.push({ kind: 'mutation-applied', role: 'fit', epoch: 5n });
    expect(rt.epoch()).toBe(5n);
    // A stale / replayed ack with an older epoch must not roll back.
    fit.push({ kind: 'mutation-applied', role: 'fit', epoch: 2n });
    expect(rt.epoch()).toBe(5n);
    fit.push({ kind: 'mutation-applied', role: 'fit', epoch: 6n });
    expect(rt.epoch()).toBe(6n);
    harness.pushDoneAll();
    await (rt as unknown as { __runP: Promise<void> }).__runP;
  });

  it('frames and mutations interleave without corrupting epoch', async () => {
    const { rt, harness } = await bootRunning();
    const fit = harness.get('fit');
    // §7.3 atomicity: between residual write and next frame, a
    // mutation may be applied. Test that interleaving keeps both
    // counters sane.
    fit.push({ kind: 'frame-processed', role: 'fit', index: 0, epoch: 0n });
    fit.push({ kind: 'mutation-applied', role: 'fit', epoch: 1n });
    fit.push({ kind: 'frame-processed', role: 'fit', index: 1, epoch: 1n });
    fit.push({ kind: 'frame-processed', role: 'fit', index: 2, epoch: 1n });
    fit.push({ kind: 'mutation-applied', role: 'fit', epoch: 2n });
    fit.push({ kind: 'frame-processed', role: 'fit', index: 3, epoch: 2n });

    expect(rt.epoch()).toBe(2n);
    expect(rt.stats().framesProcessed).toBe(4);
    expect(rt.stats().mutationsApplied).toBe(2n);
    harness.pushDoneAll();
    await (rt as unknown as { __runP: Promise<void> }).__runP;
  });
});

describe('stats aggregator', () => {
  it('exposes every drop counter from the underlying modules', async () => {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness));
    const runP = rt.run(fakeSource());
    await flush();
    harness.pushReadyAll();
    await flush();

    const s = rt.stats();
    expect(s.frameChannel.capacity).toBe(FRAME_CHANNEL.slotCount);
    expect(s.residualChannel.capacity).toBe(RESIDUAL_CHANNEL.slotCount);
    expect(s.mutationQueueCapacity).toBe(MUTATION_QUEUE.capacity);
    expect(s.mutationQueueDrops).toBe(0n);
    expect(s.eventBus.drops).toBe(0n);
    expect(s.eventBus.published).toBe(0n);
    expect(s.snapshotProtocol.issued).toBe(0n);
    expect(s.snapshotProtocol.fulfilled).toBe(0n);
    expect(s.snapshotProtocol.timedOut).toBe(0n);
    expect(s.framesProcessed).toBe(0);
    expect(s.mutationsApplied).toBe(0n);
    expect(s.epoch).toBe(0n);

    harness.pushDoneAll();
    await runP;
  });
});

describe('onEvent', () => {
  it('forwards worker-emitted PipelineEvents to subscribers', async () => {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness));
    const events: PipelineEvent[] = [];
    const unsub = rt.onEvent((e) => events.push(e));

    const runP = rt.run(fakeSource());
    await flush();
    harness.pushReadyAll();
    await flush();

    const birth: PipelineEvent = {
      kind: 'birth',
      t: 5,
      id: 1,
      patch: [0, 0],
      footprintSnap: {
        pixelIndices: new Uint32Array([0, 1]),
        values: new Float32Array([0.5, 0.5]),
      },
    };
    const metric: PipelineEvent = { kind: 'metric', t: 6, name: 'fps', value: 60 };

    harness.get('fit').push({ kind: 'event', role: 'fit', event: birth });
    harness.get('fit').push({ kind: 'event', role: 'fit', event: metric });

    expect(events.length).toBe(2);
    expect(events[0]).toBe(birth);
    expect(events[1]).toBe(metric);

    unsub();
    harness.get('fit').push({ kind: 'event', role: 'fit', event: metric });
    expect(events.length).toBe(2);

    harness.pushDoneAll();
    await runP;
  });
});

describe('graceful + hard shutdown', () => {
  it('stop() resolves when all workers reply done', async () => {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness));
    const runP = rt.run(fakeSource());
    await flush();
    harness.pushReadyAll();
    await flush();

    const stopP = rt.stop();
    // `stop` was posted to every worker.
    for (const role of ['decodePreprocess', 'fit', 'extend', 'archive'] as const) {
      expect(harness.get(role).posted.some((m) => m.kind === 'stop')).toBe(true);
    }

    harness.pushDoneAll();
    await stopP;
    await runP;
    expect(rt.state()).toBe('stopped');
  });

  it('hard-terminates after shutdownTimeoutMs if no worker replies done', async () => {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness, { shutdownTimeoutMs: 15 }));
    const runP = rt.run(fakeSource());
    await flush();
    harness.pushReadyAll();
    await flush();

    const stopP = rt.stop();
    await expect(stopP).rejects.toBeInstanceOf(RuntimeShutdownTimeoutError);
    await expect(runP).rejects.toBeInstanceOf(RuntimeShutdownTimeoutError);
    for (const w of harness.workers.values()) {
      expect(w.terminated).toBe(true);
    }
    expect(rt.state()).toBe('error');
  });
});

describe('twoPassMode flag', () => {
  it('round-trips through config', () => {
    const harness = new Harness();
    const cfg = makeCfg(harness, { twoPassMode: true });
    expect(cfg.twoPassMode).toBe(true);
    // Construction accepts the flag even though pass-2 is deferred.
    const rt = createRuntime(cfg);
    expect(rt.state()).toBe('idle');
  });
});

describe('onStatus emits frame + epoch updates', () => {
  it('delivers incrementally updating framesProcessed and epoch', async () => {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness));
    const statuses: RuntimeStatus[] = [];
    rt.onStatus((s) => statuses.push({ ...s }));

    const runP = rt.run(fakeSource());
    await flush();
    harness.pushReadyAll();
    await flush();

    const fit = harness.get('fit');
    fit.push({ kind: 'frame-processed', role: 'fit', index: 0, epoch: 0n });
    fit.push({ kind: 'mutation-applied', role: 'fit', epoch: 1n });

    const lastFrame = statuses.findLast((s) => s.framesProcessed === 1);
    expect(lastFrame).toBeDefined();
    const lastEpoch = statuses.findLast((s) => s.epoch === 1n);
    expect(lastEpoch).toBeDefined();

    harness.pushDoneAll();
    await runP;
  });
});

describe('spurious run() guard', () => {
  it('rejects concurrent run() while already running', async () => {
    const harness = new Harness();
    const rt = createRuntime(makeCfg(harness));
    const runP = rt.run(fakeSource());
    await flush();
    harness.pushReadyAll();
    await flush();

    await expect(rt.run(fakeSource())).rejects.toThrow(/run\(\) called from state 'running'/);

    harness.pushDoneAll();
    await runP;
  });
});

// vi.useRealTimers() guard so leaked timers from one test don't bleed
// into the next suite's budget.
beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
