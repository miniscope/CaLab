import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipelineEvent,
  PipelineMutation,
  WorkerInbound,
  WorkerOutbound,
} from '@calab/cala-runtime';
import { MutationQueue, SabRingChannel } from '@calab/cala-runtime';
import { createWorkerHarness, type WorkerHarness } from './worker-harness.ts';

interface FitTestHandles {
  mutationQueue: MutationQueue;
}

function getFitHandles(): FitTestHandles | undefined {
  return (globalThis as { __calaFitHandles?: FitTestHandles }).__calaFitHandles;
}

const FRAME_CHANNEL_SLOT_BYTES = 256;
const FRAME_CHANNEL_SLOT_COUNT = 64;
const FRAME_CHANNEL_WAIT_TIMEOUT_MS = 50;
const FRAME_CHANNEL_POLL_INTERVAL_MS = 1;
const PIXELS = 16;
const MUTATION_QUEUE_CAPACITY = 4;
const EVENT_BUS_CAPACITY = 16;
const EVENT_BUS_MAX_SUBSCRIBERS = 4;
const SNAPSHOT_ACK_TIMEOUT_MS = 50;
const SNAPSHOT_POLL_INTERVAL_MS = 1;
const SNAPSHOT_PENDING_CAPACITY = 1;

// Scripted Fitter behaviour. Each `step` call pops a program entry
// and lets the test assert per-frame outputs without reimplementing
// the WASM surface.
interface FitterProgramStep {
  throwMsg?: string;
  events?: PipelineEvent[];
  residual?: Float32Array;
}

interface MockFitter {
  stepCalls: Float32Array[];
  drainCalls: number;
  snapshotCalls: number;
  freed: boolean;
  epoch: bigint;
  mutationApplies: PipelineMutation[];
  eventsEmitted: PipelineEvent[];
}

const mockState = {
  constructFitterShouldThrow: null as Error | null,
  fitter: null as MockFitter | null,
  program: [] as FitterProgramStep[],
  autoResidual: new Float32Array(PIXELS),
  mutationsToDrain: [] as PipelineMutation[],
  // How many proposals the mock Extender claims per cycle. Lets
  // tests verify the `extend.proposed` metric emission without
  // dragging in real cala-core.
  nextCycleProposals: 0,
};

vi.mock('@calab/cala-core', () => {
  class Fitter {
    stepCalls: Float32Array[] = [];
    drainCalls = 0;
    snapshotCalls = 0;
    freed = false;
    private currentEpoch = 0n;
    private self: MockFitter;

    constructor(_height: number, _width: number, _cfgJson: string) {
      if (mockState.constructFitterShouldThrow) {
        throw mockState.constructFitterShouldThrow;
      }
      this.self = {
        stepCalls: this.stepCalls,
        drainCalls: 0,
        snapshotCalls: 0,
        freed: false,
        epoch: 0n,
        mutationApplies: [],
        eventsEmitted: [],
      };
      mockState.fitter = this.self;
    }

    epoch(): bigint {
      return this.currentEpoch;
    }

    numComponents(): number {
      return 0;
    }

    step(y: Float32Array): Float32Array {
      const copy = new Float32Array(y);
      this.stepCalls.push(copy);
      this.self.stepCalls = this.stepCalls;
      const program = mockState.program.shift();
      if (program?.throwMsg) throw new Error(program.throwMsg);
      return program?.residual ?? mockState.autoResidual;
    }

    // Stand-in for the wider fit_step surface (births / merges /
    // deprecates / metrics). The real WASM `Fitter.drainApply` pulls
    // one mutation at a time in FIFO order from its handle; we mirror
    // that cadence here so epoch advances once per worker pop.
    drainApply(): Uint32Array {
      this.drainCalls += 1;
      this.self.drainCalls = this.drainCalls;
      const next = mockState.mutationsToDrain.shift();
      if (next) {
        this.self.mutationApplies.push(next);
        this.currentEpoch += 1n;
        this.self.epoch = this.currentEpoch;
        return new Uint32Array([1, 0, 0]);
      }
      this.self.epoch = this.currentEpoch;
      return new Uint32Array([0, 0, 0]);
    }

    takeSnapshot(): { epoch(): bigint; numComponents(): number; pixels(): number; free(): void } {
      this.snapshotCalls += 1;
      this.self.snapshotCalls = this.snapshotCalls;
      const ep = this.currentEpoch;
      return {
        epoch: () => ep,
        numComponents: () => 0,
        pixels: () => PIXELS,
        free: () => {},
      };
    }

    free(): void {
      this.freed = true;
      this.self.freed = true;
    }
  }

  class MutationQueueHandle {
    private ms: PipelineMutation[] = [];
    constructor(_extendCfgJson: string) {}
    push(m: PipelineMutation): void {
      this.ms.push(m);
    }
    drainAll(): PipelineMutation[] {
      return this.ms.splice(0, this.ms.length);
    }
    free(): void {}
  }

  class Extender {
    public pushCalls: Float32Array[] = [];
    public cycleCalls = 0;
    constructor(
      _height: number,
      _width: number,
      _residualWindowLen: number,
      _extendCfgJson: string,
      _metadataJson: string,
    ) {}
    pushResidual(r: Float32Array): void {
      this.pushCalls.push(new Float32Array(r));
    }
    runCycle(_fitter: Fitter, _queue: MutationQueueHandle): number {
      this.cycleCalls += 1;
      return mockState.nextCycleProposals;
    }
    residualLen(): number {
      return this.pushCalls.length;
    }
  }

  return {
    initCalaCore: vi.fn(async () => {}),
    calaMemoryBytes: vi.fn(() => 1024 * 1024),
    Fitter,
    MutationQueueHandle,
    Extender,
    SnapshotHandle: class {},
  };
});

function resetMockState(): void {
  mockState.constructFitterShouldThrow = null;
  mockState.fitter = null;
  mockState.program = [];
  mockState.autoResidual = new Float32Array(PIXELS);
  mockState.mutationsToDrain = [];
  mockState.nextCycleProposals = 0;
}

function makeFrameChannel(): SabRingChannel {
  return new SabRingChannel({
    slotBytes: FRAME_CHANNEL_SLOT_BYTES,
    slotCount: FRAME_CHANNEL_SLOT_COUNT,
    waitTimeoutMs: FRAME_CHANNEL_WAIT_TIMEOUT_MS,
    pollIntervalMs: FRAME_CHANNEL_POLL_INTERVAL_MS,
  });
}

function makeResidualChannel(): SabRingChannel {
  return new SabRingChannel({
    slotBytes: FRAME_CHANNEL_SLOT_BYTES,
    slotCount: FRAME_CHANNEL_SLOT_COUNT,
    waitTimeoutMs: FRAME_CHANNEL_WAIT_TIMEOUT_MS,
    pollIntervalMs: FRAME_CHANNEL_POLL_INTERVAL_MS,
  });
}

interface InitHandles {
  msg: WorkerInbound;
  frameChannel: SabRingChannel;
  residualChannel: SabRingChannel;
}

function makeInitMsg(overrides: Record<string, unknown> = {}): InitHandles {
  const frameChannel = makeFrameChannel();
  const residualChannel = makeResidualChannel();
  const msg: WorkerInbound = {
    kind: 'init',
    payload: {
      role: 'fit',
      frameChannelBuffer: frameChannel.sharedBuffer,
      residualChannelBuffer: residualChannel.sharedBuffer,
      workerConfig: {
        height: 4,
        width: 4,
        fitConfigJson: '{}',
        extendConfigJson: '{}',
        heartbeatStride: 2,
        snapshotStride: 2,
        mutationDrainMaxPerIteration: 8,
        eventBusCapacity: EVENT_BUS_CAPACITY,
        eventBusMaxSubscribers: EVENT_BUS_MAX_SUBSCRIBERS,
        snapshotAckTimeoutMs: SNAPSHOT_ACK_TIMEOUT_MS,
        snapshotPollIntervalMs: SNAPSHOT_POLL_INTERVAL_MS,
        snapshotPendingCapacity: SNAPSHOT_PENDING_CAPACITY,
        frameChannelSlotBytes: FRAME_CHANNEL_SLOT_BYTES,
        frameChannelSlotCount: FRAME_CHANNEL_SLOT_COUNT,
        frameChannelWaitTimeoutMs: FRAME_CHANNEL_WAIT_TIMEOUT_MS,
        frameChannelPollIntervalMs: FRAME_CHANNEL_POLL_INTERVAL_MS,
        mutationQueueCapacity: MUTATION_QUEUE_CAPACITY,
        vitalsStride: 2,
        ...overrides,
      },
    },
  };
  return { msg, frameChannel, residualChannel };
}

async function runUntil(
  harness: WorkerHarness,
  predicate: (posted: WorkerOutbound[]) => boolean,
  maxTicks = 2000,
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
  await import('../fit.worker.ts');
}

function writeFrameToChannel(channel: SabRingChannel, value: number): void {
  const payload = new Float32Array(PIXELS);
  payload[0] = value;
  channel.writeSlot(payload, 0n);
}

describe('fit worker', () => {
  beforeEach(() => {
    resetMockState();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('responds to init with ready after binding fitter, channel, mutation queue, snapshot + event handles', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg().msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    const ready = harness.posted.find((m) => m.kind === 'ready');
    expect(ready).toEqual({ kind: 'ready', role: 'fit' });
    expect(mockState.fitter).not.toBeNull();
  });

  it('posts error when Fitter constructor rejects fit config JSON', async () => {
    mockState.constructFitterShouldThrow = new Error('fit cfg parse');
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg({ fitConfigJson: '{invalid}' }).msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'error'));
    const err = harness.posted.find((m) => m.kind === 'error');
    expect(err).toMatchObject({ kind: 'error', role: 'fit' });
    expect((err as { message: string }).message).toMatch(/fit cfg parse/);
    expect(harness.posted.some((m) => m.kind === 'ready')).toBe(false);
  });

  it('run drives fit step per frame and emits throttled frame-processed heartbeats', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    const init = makeInitMsg({ heartbeatStride: 2, snapshotStride: 1000 });
    await harness.deliver(init.msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    // Prime the channel with 4 frames, then close it by delivering 'stop'
    // once the worker has drained them. The fit worker's read loop yields
    // between frames so we can feed it between ticks.
    for (let i = 0; i < 4; i += 1) {
      writeFrameToChannel(init.frameChannel, i);
    }
    await harness.deliver({ kind: 'run' });
    await runUntil(harness, (p) => p.filter((m) => m.kind === 'frame-processed').length >= 2);
    await harness.deliver({ kind: 'stop' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));

    expect(mockState.fitter!.stepCalls.length).toBeGreaterThanOrEqual(4);
    const heartbeats = harness.posted.filter((m) => m.kind === 'frame-processed');
    // heartbeatStride = 2 → beat after frames at indices 1 and 3.
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(heartbeats[0]).toMatchObject({ kind: 'frame-processed', role: 'fit', index: 1 });
  });

  it('emits a birth pipeline event on the bus when a register mutation is drained', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    const init = makeInitMsg({ heartbeatStride: 1, snapshotStride: 1000 });
    await harness.deliver(init.msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    const fitHandles = getFitHandles();
    expect(fitHandles).toBeDefined();
    fitHandles!.mutationQueue.push({
      type: 'register',
      snapshotEpoch: 0n,
      class: 'cell',
      support: new Uint32Array([1, 2]),
      values: new Float32Array([0.9, 0.6]),
      trace: new Float32Array([0.1, 0.2]),
    });
    writeFrameToChannel(init.frameChannel, 0);

    await harness.deliver({ kind: 'run' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'event' && m.event.kind === 'birth'));
    await harness.deliver({ kind: 'stop' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));

    const eventMsg = harness.posted.find(
      (m): m is Extract<WorkerOutbound, { kind: 'event' }> =>
        m.kind === 'event' && m.event.kind === 'birth',
    );
    expect(eventMsg).toBeDefined();
    expect(eventMsg!.role).toBe('fit');
    expect(eventMsg!.event.kind).toBe('birth');
  });

  it('drains the mutation queue each iteration and posts mutation-applied with monotonic epoch', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    const init = makeInitMsg({ heartbeatStride: 100, snapshotStride: 1000 });
    await harness.deliver(init.msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    const fitHandles = getFitHandles();
    expect(fitHandles).toBeDefined();
    // One mutation per frame, drained into the WASM-side handle so
    // each applied mutation bumps the fitter's epoch.
    mockState.mutationsToDrain = [
      { type: 'deprecate', snapshotEpoch: 0n, id: 7, reason: 'traceInactive' },
      { type: 'deprecate', snapshotEpoch: 1n, id: 9, reason: 'mergedInto' },
    ];
    fitHandles!.mutationQueue.push({
      type: 'deprecate',
      snapshotEpoch: 0n,
      id: 7,
      reason: 'traceInactive',
    });
    fitHandles!.mutationQueue.push({
      type: 'deprecate',
      snapshotEpoch: 1n,
      id: 9,
      reason: 'mergedInto',
    });
    writeFrameToChannel(init.frameChannel, 0);

    await harness.deliver({ kind: 'run' });
    await runUntil(harness, (p) => p.filter((m) => m.kind === 'mutation-applied').length >= 2);
    await harness.deliver({ kind: 'stop' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));

    const applied = harness.posted.filter(
      (m): m is Extract<WorkerOutbound, { kind: 'mutation-applied' }> =>
        m.kind === 'mutation-applied',
    );
    expect(applied.length).toBeGreaterThanOrEqual(2);
    expect(applied[0].epoch).toBe(1n);
    expect(applied[1].epoch).toBe(2n);
  });

  it('takes a snapshot every snapshot_stride frames and posts snapshot-request with the captured epoch', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    const init = makeInitMsg({ heartbeatStride: 100, snapshotStride: 2 });
    await harness.deliver(init.msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    // Seed a mutation so epoch advances before the first snapshot.
    mockState.mutationsToDrain = [
      { type: 'deprecate', snapshotEpoch: 0n, id: 1, reason: 'traceInactive' },
    ];
    for (let i = 0; i < 4; i += 1) writeFrameToChannel(init.frameChannel, i);

    await harness.deliver({ kind: 'run' });
    await runUntil(harness, (p) => p.filter((m) => m.kind === 'snapshot-request').length >= 2);
    await harness.deliver({ kind: 'stop' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));

    const snaps = harness.posted.filter(
      (m): m is Extract<WorkerOutbound, { kind: 'snapshot-request' }> =>
        m.kind === 'snapshot-request',
    );
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    // Snapshot cadence monotonic: each ack should carry a non-decreasing requestId.
    for (let i = 1; i < snaps.length; i += 1) {
      expect(snaps[i].requestId).toBeGreaterThan(snaps[i - 1].requestId);
    }
    expect(mockState.fitter!.snapshotCalls).toBeGreaterThanOrEqual(2);
  });

  it('stop mid-loop halts further fit_step calls, posts done, frees the fitter exactly once', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    const init = makeInitMsg({ heartbeatStride: 1, snapshotStride: 1000 });
    await harness.deliver(init.msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    for (let i = 0; i < 3; i += 1) writeFrameToChannel(init.frameChannel, i);

    await harness.deliver({ kind: 'run' });
    await runUntil(harness, (p) => p.filter((m) => m.kind === 'frame-processed').length >= 1);
    await harness.deliver({ kind: 'stop' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));

    const stepsAtStop = mockState.fitter!.stepCalls.length;
    // After 'done', no more fit work should happen.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(mockState.fitter!.stepCalls.length).toBe(stepsAtStop);
    expect(mockState.fitter!.freed).toBe(true);
    // free posted exactly once: counting 'done' messages stays at 1.
    expect(harness.posted.filter((m) => m.kind === 'done').length).toBe(1);
  });

  it('drives the Extender each frame and emits extend.proposed metric on cycle stride', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    const init = makeInitMsg({
      heartbeatStride: 1,
      snapshotStride: 1000,
      vitalsStride: 1000,
      extendCycleStride: 2,
      extendWindowFrames: 4,
      metadataJson: JSON.stringify({ pixel_size_um: 2 }),
    });
    await harness.deliver(init.msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    mockState.program = [{}, {}, {}, {}];
    mockState.nextCycleProposals = 3;
    for (let i = 0; i < 4; i += 1) writeFrameToChannel(init.frameChannel, i);

    await harness.deliver({ kind: 'run' });
    await runUntil(
      harness,
      (p) =>
        p.filter(
          (m) =>
            m.kind === 'event' && m.event.kind === 'metric' && m.event.name === 'extend.proposed',
        ).length >= 2,
    );

    const proposedEvents = harness.posted
      .filter(
        (m): m is Extract<WorkerOutbound, { kind: 'event' }> =>
          m.kind === 'event' &&
          m.event.kind === 'metric' &&
          (m.event as Extract<PipelineEvent, { kind: 'metric' }>).name === 'extend.proposed',
      )
      .map((m) => m.event as Extract<PipelineEvent, { kind: 'metric' }>);
    expect(proposedEvents.length).toBeGreaterThanOrEqual(2);
    expect(proposedEvents[0].value).toBe(3);
  });

  it('emits log-spaced footprint-snapshot events after a birth mutation', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    // Drive the scheduler by pushing a register mutation on frame 0
    // (caches a footprint), then advance the fit loop through several
    // frames so ages 1, 2, 4 fire.
    const init = makeInitMsg({ heartbeatStride: 1, snapshotStride: 1000, vitalsStride: 1000 });
    await harness.deliver(init.msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    mockState.program = [{}, {}, {}, {}, {}];
    mockState.mutationsToDrain = [
      {
        type: 'register',
        snapshotEpoch: 1n,
        class: 'cell',
        support: new Uint32Array([2, 3]),
        values: new Float32Array([0.4, 0.5]),
        trace: new Float32Array([0]),
      },
    ];
    // Mutation has to be visible when the worker pops it on frame 0.
    const handles = getFitHandles();
    expect(handles).toBeDefined();
    handles!.mutationQueue.push(mockState.mutationsToDrain.shift()!);

    for (let i = 0; i < 5; i += 1) writeFrameToChannel(init.frameChannel, i);

    await harness.deliver({ kind: 'run' });
    await runUntil(
      harness,
      (p) =>
        p.filter((m) => m.kind === 'event' && m.event.kind === 'footprint-snapshot').length >= 2,
    );

    const snaps = harness.posted
      .filter(
        (m): m is Extract<WorkerOutbound, { kind: 'event' }> =>
          m.kind === 'event' && m.event.kind === 'footprint-snapshot',
      )
      .map((m) => m.event as Extract<PipelineEvent, { kind: 'footprint-snapshot' }>);
    // At least the first log-spaced firing should appear; payloads
    // should carry the cached footprint from the register mutation.
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(Array.from(snaps[0].footprint.pixelIndices)).toEqual([2, 3]);
  });

  it('emits the five vitals metrics on the vitalsStride cadence', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    // vitalsStride=2 → vitals emit on frame index 1 and 3 (every
    // second frame counting from 1). Residuals below let us verify
    // residual_l2 comes through with the right magnitude.
    const init = makeInitMsg({ heartbeatStride: 1, snapshotStride: 1000, vitalsStride: 2 });
    await harness.deliver(init.msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    mockState.program = [
      { residual: new Float32Array([3, 4]) }, // L2 = 5
      { residual: new Float32Array([1, 0]) }, // L2 = 1
      { residual: new Float32Array([0, 2]) }, // L2 = 2
      { residual: new Float32Array([0, 0]) }, // L2 = 0
    ];
    for (let i = 0; i < 4; i += 1) writeFrameToChannel(init.frameChannel, i);

    await harness.deliver({ kind: 'run' });
    await runUntil(
      harness,
      (p) => p.filter((m) => m.kind === 'event' && m.event.kind === 'metric').length >= 10,
    );

    const metrics = harness.posted
      .filter(
        (m): m is Extract<WorkerOutbound, { kind: 'event' }> =>
          m.kind === 'event' && m.event.kind === 'metric',
      )
      .map((m) => m.event as Extract<PipelineEvent, { kind: 'metric' }>);

    // Exactly five metrics per stride firing.
    const names = metrics.map((m) => m.name);
    expect(names).toContain('cell_count');
    expect(names).toContain('fps');
    expect(names).toContain('memory_bytes');
    expect(names).toContain('residual_l2');
    expect(names).toContain('extend_queue_depth');

    // residual_l2 at t=1 is from the second step (L2 of [1,0] = 1).
    const firstResidual = metrics.find((m) => m.name === 'residual_l2');
    expect(firstResidual).toBeDefined();
    expect(firstResidual!.value).toBeCloseTo(1, 5);
    // memory_bytes reflects the mocked calaMemoryBytes return value.
    const mem = metrics.find((m) => m.name === 'memory_bytes');
    expect(mem!.value).toBe(1024 * 1024);
  });

  it('posts error when fit_step throws mid-loop and still frees the fitter', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    const init = makeInitMsg({ heartbeatStride: 1, snapshotStride: 1000 });
    await harness.deliver(init.msg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    mockState.program = [{}, { throwMsg: 'nan trace' }];
    writeFrameToChannel(init.frameChannel, 0);
    writeFrameToChannel(init.frameChannel, 1);

    await harness.deliver({ kind: 'run' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'error'));

    const err = harness.posted.find((m) => m.kind === 'error');
    expect((err as { message: string }).message).toMatch(/nan trace/);
    expect(mockState.fitter!.freed).toBe(true);
  });
});
