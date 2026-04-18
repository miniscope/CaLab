import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerInbound, WorkerOutbound } from '@calab/cala-runtime';
import { SabRingChannel } from '@calab/cala-runtime';
import type { FrameSource, FrameSourceMeta } from '@calab/io';
import { createWorkerHarness, type WorkerHarness } from './worker-harness.ts';

const FRAME_CHANNEL_SLOT_BYTES = 256;
const FRAME_CHANNEL_SLOT_COUNT = 64;
const FRAME_CHANNEL_WAIT_TIMEOUT_MS = 50;
const FRAME_CHANNEL_POLL_INTERVAL_MS = 1;

// Shared mock state so tests can script the decoder and preprocessor
// without re-importing the module under test each run.
interface MockFrameSource extends FrameSource {
  readFrameCalls: number[];
  closed: boolean;
}

interface MockPreprocessor {
  processFrameF32: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
  freed: boolean;
}

const mockState = {
  openShouldThrow: null as Error | null,
  preprocessShouldThrow: null as Error | null,
  constructPreprocessorShouldThrow: null as Error | null,
  meta: {
    width: 4,
    height: 4,
    frameCount: 5,
    fps: 30,
    channels: 1,
    bitDepth: 8,
  } satisfies FrameSourceMeta,
  frameSource: null as MockFrameSource | null,
  preprocessor: null as MockPreprocessor | null,
  processFrameDelayMs: 0,
};

vi.mock('@calab/io', () => ({
  openAviUncompressed: vi.fn(async (_file: File): Promise<FrameSource> => {
    if (mockState.openShouldThrow) throw mockState.openShouldThrow;
    const src: MockFrameSource = {
      readFrameCalls: [],
      closed: false,
      meta: () => mockState.meta,
      async readFrame(n: number) {
        src.readFrameCalls.push(n);
        if (mockState.processFrameDelayMs > 0) {
          await new Promise((r) => setTimeout(r, mockState.processFrameDelayMs));
        }
        const out = new Float32Array(mockState.meta.width * mockState.meta.height);
        out[0] = n;
        return out;
      },
      close() {
        src.closed = true;
      },
    };
    mockState.frameSource = src;
    return src;
  }),
}));

vi.mock('@calab/cala-core', () => {
  class Preprocessor {
    processFrameF32: ReturnType<typeof vi.fn>;
    free: ReturnType<typeof vi.fn>;
    freed = false;
    constructor() {
      if (mockState.constructPreprocessorShouldThrow) {
        throw mockState.constructPreprocessorShouldThrow;
      }
      this.processFrameF32 = vi.fn((input: Float32Array) => {
        if (mockState.preprocessShouldThrow) throw mockState.preprocessShouldThrow;
        const out = new Float32Array(input.length);
        out.set(input);
        out[0] += 1;
        return out;
      });
      this.free = vi.fn(() => {
        this.freed = true;
      });
      const self = this as unknown as MockPreprocessor;
      mockState.preprocessor = self;
    }
  }
  return {
    initCalaCore: vi.fn(async () => {}),
    Preprocessor,
  };
});

function resetMockState(): void {
  mockState.openShouldThrow = null;
  mockState.preprocessShouldThrow = null;
  mockState.constructPreprocessorShouldThrow = null;
  mockState.frameSource = null;
  mockState.preprocessor = null;
  mockState.processFrameDelayMs = 0;
  mockState.meta = {
    width: 4,
    height: 4,
    frameCount: 5,
    fps: 30,
    channels: 1,
    bitDepth: 8,
  };
}

function makeFrameChannel(): SabRingChannel {
  return new SabRingChannel({
    slotBytes: FRAME_CHANNEL_SLOT_BYTES,
    slotCount: FRAME_CHANNEL_SLOT_COUNT,
    waitTimeoutMs: FRAME_CHANNEL_WAIT_TIMEOUT_MS,
    pollIntervalMs: FRAME_CHANNEL_POLL_INTERVAL_MS,
  });
}

function makeResidualBuffer(): SharedArrayBuffer | ArrayBuffer {
  return makeFrameChannel().sharedBuffer;
}

function makeInitMsg(overrides: Record<string, unknown> = {}): WorkerInbound {
  const frameChannel = makeFrameChannel();
  return {
    kind: 'init',
    payload: {
      role: 'decodePreprocess',
      frameChannelBuffer: frameChannel.sharedBuffer,
      residualChannelBuffer: makeResidualBuffer(),
      workerConfig: {
        source: {
          kind: 'file',
          file: new File([new Uint8Array(4)], 'fake.avi'),
          frameSourceFactory: null,
        },
        heartbeatStride: 2,
        metadataJson: '{"pixel_size_um":2.0}',
        preprocessConfigJson: '{}',
        grayscaleMethod: 'Green',
        frameChannelSlotBytes: FRAME_CHANNEL_SLOT_BYTES,
        frameChannelSlotCount: FRAME_CHANNEL_SLOT_COUNT,
        frameChannelWaitTimeoutMs: FRAME_CHANNEL_WAIT_TIMEOUT_MS,
        frameChannelPollIntervalMs: FRAME_CHANNEL_POLL_INTERVAL_MS,
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
    // Yield a macrotask so setTimeout-backed mocks can fire.
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  if (!predicate(harness.posted)) {
    throw new Error('runUntil timed out');
  }
}

async function loadWorker(harness: WorkerHarness): Promise<void> {
  vi.stubGlobal('self', harness.self);
  await import('../decode-preprocess.worker.ts');
}

describe('decode-preprocess worker', () => {
  beforeEach(() => {
    resetMockState();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('responds to init with ready after opening source and building preprocessor', async () => {
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));
    const ready = harness.posted.find((m) => m.kind === 'ready');
    expect(ready).toEqual({ kind: 'ready', role: 'decodePreprocess' });
    expect(mockState.frameSource).not.toBeNull();
    expect(mockState.preprocessor).not.toBeNull();
  });

  it('posts error when openAviUncompressed fails during init', async () => {
    mockState.openShouldThrow = new Error('bad avi header');
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg());
    await runUntil(harness, (p) => p.some((m) => m.kind === 'error'));
    const err = harness.posted.find((m) => m.kind === 'error');
    expect(err).toMatchObject({ kind: 'error', role: 'decodePreprocess' });
    expect((err as { message: string }).message).toMatch(/bad avi header/);
    expect(harness.posted.some((m) => m.kind === 'ready')).toBe(false);
  });

  it('posts error when Preprocessor constructor rejects config JSON', async () => {
    mockState.constructPreprocessorShouldThrow = new Error('preprocess cfg parse');
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg({ preprocessConfigJson: '{invalid}' }));
    await runUntil(harness, (p) => p.some((m) => m.kind === 'error'));
    const err = harness.posted.find((m) => m.kind === 'error');
    expect((err as { message: string }).message).toMatch(/preprocess cfg parse/);
  });

  it('run drives decode→preprocess loop and emits throttled frame-processed heartbeats', async () => {
    mockState.meta = { ...mockState.meta, frameCount: 6 };
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg({ heartbeatStride: 3 }));
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    await harness.deliver({ kind: 'run' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));

    expect(mockState.frameSource!.readFrameCalls).toEqual([0, 1, 2, 3, 4, 5]);
    expect(mockState.preprocessor!.processFrameF32).toHaveBeenCalledTimes(6);

    const heartbeats = harness.posted.filter((m) => m.kind === 'frame-processed');
    // With stride=3 over 6 frames, beats fire after frames 2 and 5 (0-indexed).
    expect(heartbeats.length).toBe(2);
    const last = heartbeats[heartbeats.length - 1];
    expect(last).toMatchObject({ kind: 'frame-processed', role: 'decodePreprocess', index: 5 });

    expect(harness.posted.some((m) => m.kind === 'done')).toBe(true);
  });

  it('stop cooperatively aborts the loop and signals done without completing all frames', async () => {
    mockState.meta = { ...mockState.meta, frameCount: 50 };
    mockState.processFrameDelayMs = 1;
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg({ heartbeatStride: 1 }));
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    await harness.deliver({ kind: 'run' });
    // Let a few frames land before stopping.
    await runUntil(harness, (p) => p.filter((m) => m.kind === 'frame-processed').length >= 1);
    await harness.deliver({ kind: 'stop' });

    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));
    expect(mockState.frameSource!.readFrameCalls.length).toBeLessThan(50);
    expect(mockState.frameSource!.closed).toBe(true);
    expect(mockState.preprocessor!.freed).toBe(true);
  });

  it('posts error when preprocess throws mid-loop and stops processing further frames', async () => {
    mockState.meta = { ...mockState.meta, frameCount: 4 };
    mockState.preprocessShouldThrow = new Error('nan in frame');
    const harness = createWorkerHarness();
    await loadWorker(harness);
    await harness.deliver(makeInitMsg({ heartbeatStride: 1 }));
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    await harness.deliver({ kind: 'run' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'error'));
    const err = harness.posted.find((m) => m.kind === 'error');
    expect((err as { message: string }).message).toMatch(/nan in frame/);
    // Loop exits after error → only one readFrame call should have happened.
    expect(mockState.frameSource!.readFrameCalls.length).toBeLessThanOrEqual(1);
  });

  it('writes preprocessed frames into the SAB frame channel', async () => {
    mockState.meta = { ...mockState.meta, frameCount: 2 };
    const harness = createWorkerHarness();
    await loadWorker(harness);
    const initMsg = makeInitMsg({ heartbeatStride: 1 });
    await harness.deliver(initMsg);
    await runUntil(harness, (p) => p.some((m) => m.kind === 'ready'));

    await harness.deliver({ kind: 'run' });
    await runUntil(harness, (p) => p.some((m) => m.kind === 'done'));

    const readerChannel = new SabRingChannel({
      slotBytes: FRAME_CHANNEL_SLOT_BYTES,
      slotCount: FRAME_CHANNEL_SLOT_COUNT,
      waitTimeoutMs: FRAME_CHANNEL_WAIT_TIMEOUT_MS,
      pollIntervalMs: FRAME_CHANNEL_POLL_INTERVAL_MS,
      sharedBuffer:
        initMsg.kind === 'init' ? initMsg.payload.frameChannelBuffer : makeResidualBuffer(),
    });
    const slot0 = readerChannel.readSlot();
    const slot1 = readerChannel.readSlot();
    expect(slot0).not.toBeNull();
    expect(slot1).not.toBeNull();
    const view0 = new Float32Array(slot0!.data.buffer, slot0!.data.byteOffset, 16);
    const view1 = new Float32Array(slot1!.data.buffer, slot1!.data.byteOffset, 16);
    // Mock preprocessor: out[0] = input[0] + 1; input[0] = frameIndex.
    expect(view0[0]).toBe(1);
    expect(view1[0]).toBe(2);
  });
});
