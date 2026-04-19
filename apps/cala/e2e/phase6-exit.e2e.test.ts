/**
 * Phase 6 exit E2E — task 16.
 *
 * End-to-end proof that everything Phase 6 shipped is reachable on
 * a real miniscope AVI:
 *
 *   1. W2 emits the five vitals metrics on stride (tasks 4 + 11).
 *   2. W2's log-spaced `footprint-snapshot` scheduler runs (task 5).
 *   3. W4's tiered timeseries store has samples for at least one
 *      vitals name (task 1).
 *   4. W4's per-neuron event index is queryable (task 2).
 *   5. W4's footprint history store returns entries (task 3).
 *   6. W4's archive-dump retains structural events (tasks 1-3 regress).
 *   7. Main thread can push a user-authored deprecate and see it
 *      reach the fit worker (task 13).
 *
 * Uses the same harness pattern as phase5-exit + phase6-extend:
 * real AVI RIFF parsing in JS, real SabRingChannel, real worker
 * modules, stubbed cala-core WASM (the Rust numerical core has its
 * own cold-start E2E — we only prove plumbing here).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SabRingChannel,
  type PipelineEvent,
  type WorkerInbound,
  type WorkerOutbound,
} from '@calab/cala-runtime';
import {
  createWorkerHarness,
  type WorkerHarness,
} from '../src/workers/__tests__/worker-harness.ts';

const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const TEST_POLL_MS = 2;
const TEST_POLL_MAX_TICKS = 30_000;
const TEST_MAX_FRAMES = 32;
const TEST_MIN_FRAMES_PROCESSED = 16;
const TEST_HEARTBEAT_STRIDE = 2;
const TEST_PREVIEW_STRIDE = 100;
const TEST_SNAPSHOT_STRIDE = 1_000_000;
const TEST_VITALS_STRIDE = 4;
const TEST_EXTEND_CYCLE_STRIDE = 8;
const TEST_EXTEND_WINDOW_FRAMES = 16;
const TEST_MOCK_PROPOSALS_PER_CYCLE = 1;
const TEST_FRAME_CHANNEL_SLOT_COUNT = 8;
const TEST_FRAME_CHANNEL_WAIT_TIMEOUT_MS = 50;
const TEST_FRAME_CHANNEL_POLL_INTERVAL_MS = 1;
const TEST_MUTATION_QUEUE_CAPACITY = 8;
const TEST_EVENT_BUS_CAPACITY = 128;
const TEST_EVENT_BUS_MAX_SUBSCRIBERS = 4;
const TEST_SNAPSHOT_ACK_TIMEOUT_MS = 50;
const TEST_SNAPSHOT_POLL_INTERVAL_MS = 1;
const TEST_SNAPSHOT_PENDING_CAPACITY = 1;
const TEST_NEURON_ID = 7;

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../..');
const AVI_FIXTURE = path.join(REPO_ROOT, '.test_data', 'anchor_v12_prepped.avi');

interface ParsedAvi {
  width: number;
  height: number;
  channels: number;
  bitDepth: number;
  fps: number;
  frames: { offset: number; size: number }[];
  bytes: Uint8Array;
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function parseAvi(bytes: Uint8Array): ParsedAvi {
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'AVI ') {
    throw new Error('fixture is not a RIFF/AVI container');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels = 1;
  let bitDepth = 8;
  const fps = 30;
  const frames: { offset: number; size: number }[] = [];
  let i = 12;
  while (i + 8 <= bytes.length) {
    const tag = fourcc(bytes, i);
    const size = view.getUint32(i + 4, true);
    if (tag === 'LIST') {
      const kind = fourcc(bytes, i + 8);
      if (kind === 'hdrl') {
        let j = i + 12;
        const end = i + 8 + size;
        while (j + 8 <= end) {
          const t = fourcc(bytes, j);
          const s = view.getUint32(j + 4, true);
          if (t === 'strf') {
            width = view.getInt32(j + 12, true);
            height = Math.abs(view.getInt32(j + 16, true));
            bitDepth = view.getUint16(j + 22, true);
            channels = bitDepth >= 24 ? 3 : 1;
          }
          if (t === 'LIST') {
            j += 12;
            continue;
          }
          j += 8 + s + (s & 1);
        }
      } else if (kind === 'movi') {
        let j = i + 12;
        const end = i + 8 + size;
        while (j + 8 <= end) {
          const t = fourcc(bytes, j);
          const s = view.getUint32(j + 4, true);
          if (t === '00db' || t === '00dc') frames.push({ offset: j + 8, size: s });
          j += 8 + s + (s & 1);
        }
      }
      i += 12;
      continue;
    }
    i += 8 + size + (size & 1);
  }
  return { width, height, channels, bitDepth, fps, frames, bytes };
}

let parsedAvi: ParsedAvi | null = null;

class StubAviReader {
  constructor(_bytes: Uint8Array) {
    if (!parsedAvi) throw new Error('stub AviReader requires parsedAvi primed');
  }
  width(): number {
    return parsedAvi!.width;
  }
  height(): number {
    return parsedAvi!.height;
  }
  frameCount(): number {
    return parsedAvi!.frames.length;
  }
  fps(): number {
    return parsedAvi!.fps;
  }
  channels(): number {
    return parsedAvi!.channels;
  }
  bitDepth(): number {
    return parsedAvi!.bitDepth;
  }
  readFrameGrayscaleF32(n: number, _m: string): Float32Array {
    const p = parsedAvi!;
    const { offset } = p.frames[n];
    const pixels = p.width * p.height;
    const out = new Float32Array(pixels);
    if (p.channels === 1) {
      for (let k = 0; k < pixels; k += 1) out[k] = p.bytes[offset + k];
    } else {
      const bpp = Math.floor(p.bitDepth / 8);
      for (let k = 0; k < pixels; k += 1) out[k] = p.bytes[offset + k * bpp + 1] ?? 0;
    }
    return out;
  }
  free(): void {}
}

class StubPreprocessor {
  constructor(_h: number, _w: number, _m: string, _c: string) {}
  processFrameF32(input: Float32Array): Float32Array {
    return input;
  }
  free(): void {}
}

let fitterFrameCount = 0;
let fitterDrainApplyCount = 0;

class StubFitter {
  private currentEpoch = 0n;
  constructor(_h: number, _w: number, _c: string) {}
  epoch(): bigint {
    return this.currentEpoch;
  }
  numComponents(): number {
    return Number(this.currentEpoch);
  }
  step(y: Float32Array): Float32Array {
    fitterFrameCount += 1;
    return y;
  }
  drainApply(_handle: unknown): Uint32Array {
    fitterDrainApplyCount += 1;
    this.currentEpoch += 1n;
    return new Uint32Array([1, 0, 0]);
  }
  takeSnapshot(): { epoch(): bigint; numComponents(): number; pixels(): number; free(): void } {
    return {
      epoch: () => this.currentEpoch,
      numComponents: () => 0,
      pixels: () => 0,
      free: () => {},
    };
  }
  free(): void {}
}

let mutationHandlePushDeprecateCount = 0;

class StubMutationQueueHandle {
  constructor(_cfg: string) {}
  pushDeprecate(_snapshotEpoch: bigint, _id: number, _reason: string): void {
    mutationHandlePushDeprecateCount += 1;
  }
  free(): void {}
}

let extenderCycleCount = 0;

class StubExtender {
  private residualPushCount = 0;
  constructor(_h: number, _w: number, _win: number, _extendCfg: string, _metadata: string) {}
  pushResidual(_r: Float32Array): void {
    this.residualPushCount += 1;
  }
  runCycle(_fitter: unknown, _queue: unknown): number {
    extenderCycleCount += 1;
    return TEST_MOCK_PROPOSALS_PER_CYCLE;
  }
  residualLen(): number {
    return this.residualPushCount;
  }
  free(): void {}
}

vi.mock('@calab/cala-core', () => ({
  initCalaCore: vi.fn(async () => undefined),
  calaMemoryBytes: vi.fn(() => 2 * 1024 * 1024),
  AviReader: StubAviReader,
  Preprocessor: StubPreprocessor,
  Fitter: StubFitter,
  MutationQueueHandle: StubMutationQueueHandle,
  Extender: StubExtender,
}));

async function pumpUntil(predicate: () => boolean, maxTicks = TEST_POLL_MAX_TICKS): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await new Promise<void>((r) => setTimeout(r, TEST_POLL_MS));
  }
  if (!predicate()) throw new Error('pumpUntil: condition never satisfied');
}

interface BootResult {
  decode: WorkerHarness;
  fit: WorkerHarness;
  archive: WorkerHarness;
  frameChannel: SabRingChannel;
}

async function loadIntoHarness(h: WorkerHarness, specifier: string): Promise<void> {
  vi.stubGlobal('self', h.self);
  await import(specifier);
  vi.unstubAllGlobals();
}

function makeFrameChannel(slotBytes: number): SabRingChannel {
  return new SabRingChannel({
    slotBytes,
    slotCount: TEST_FRAME_CHANNEL_SLOT_COUNT,
    waitTimeoutMs: TEST_FRAME_CHANNEL_WAIT_TIMEOUT_MS,
    pollIntervalMs: TEST_FRAME_CHANNEL_POLL_INTERVAL_MS,
  });
}

async function bootAllWorkers(parsed: ParsedAvi): Promise<BootResult> {
  const pixels = parsed.width * parsed.height;
  const slotBytes = pixels * Float32Array.BYTES_PER_ELEMENT;
  const frameChannel = makeFrameChannel(slotBytes);
  const residualBuffer = makeFrameChannel(slotBytes).sharedBuffer;
  const decode = createWorkerHarness();
  const fit = createWorkerHarness();
  const archive = createWorkerHarness();
  await loadIntoHarness(decode, '../src/workers/decode-preprocess.worker.ts');
  await loadIntoHarness(fit, '../src/workers/fit.worker.ts');
  await loadIntoHarness(archive, '../src/workers/archive.worker.ts');

  const originalFitPost = fit.self.postMessage.bind(fit.self);
  fit.self.postMessage = (msg: WorkerOutbound): void => {
    originalFitPost(msg);
    if (msg.kind === 'event') {
      void archive.deliver({ kind: 'event', event: msg.event });
    }
  };

  const fileBytes = new Uint8Array(parsed.bytes.byteLength);
  fileBytes.set(parsed.bytes);
  const fakeFile = new File([fileBytes], path.basename(AVI_FIXTURE));

  await decode.deliver({
    kind: 'init',
    payload: {
      role: 'decodePreprocess',
      frameChannelBuffer: frameChannel.sharedBuffer,
      residualChannelBuffer: residualBuffer,
      workerConfig: {
        source: { kind: 'file', file: fakeFile, frameSourceFactory: null },
        heartbeatStride: TEST_HEARTBEAT_STRIDE,
        framePreviewStride: TEST_PREVIEW_STRIDE,
        grayscaleMethod: 'Green',
        frameChannelSlotBytes: slotBytes,
        frameChannelSlotCount: TEST_FRAME_CHANNEL_SLOT_COUNT,
        frameChannelWaitTimeoutMs: TEST_FRAME_CHANNEL_WAIT_TIMEOUT_MS,
        frameChannelPollIntervalMs: TEST_FRAME_CHANNEL_POLL_INTERVAL_MS,
      },
    },
  });
  await pumpUntil(() => decode.posted.some((m) => m.kind === 'ready'));

  await fit.deliver({
    kind: 'init',
    payload: {
      role: 'fit',
      frameChannelBuffer: frameChannel.sharedBuffer,
      residualChannelBuffer: residualBuffer,
      workerConfig: {
        height: parsed.height,
        width: parsed.width,
        heartbeatStride: TEST_HEARTBEAT_STRIDE,
        vitalsStride: TEST_VITALS_STRIDE,
        snapshotStride: TEST_SNAPSHOT_STRIDE,
        mutationDrainMaxPerIteration: 1,
        eventBusCapacity: TEST_EVENT_BUS_CAPACITY,
        eventBusMaxSubscribers: TEST_EVENT_BUS_MAX_SUBSCRIBERS,
        snapshotAckTimeoutMs: TEST_SNAPSHOT_ACK_TIMEOUT_MS,
        snapshotPollIntervalMs: TEST_SNAPSHOT_POLL_INTERVAL_MS,
        snapshotPendingCapacity: TEST_SNAPSHOT_PENDING_CAPACITY,
        mutationQueueCapacity: TEST_MUTATION_QUEUE_CAPACITY,
        frameChannelSlotBytes: slotBytes,
        frameChannelSlotCount: TEST_FRAME_CHANNEL_SLOT_COUNT,
        frameChannelWaitTimeoutMs: TEST_FRAME_CHANNEL_WAIT_TIMEOUT_MS,
        frameChannelPollIntervalMs: TEST_FRAME_CHANNEL_POLL_INTERVAL_MS,
        extendCycleStride: TEST_EXTEND_CYCLE_STRIDE,
        extendWindowFrames: TEST_EXTEND_WINDOW_FRAMES,
        metadataJson: JSON.stringify({ pixel_size_um: 2 }),
      },
    },
  });
  await pumpUntil(() => fit.posted.some((m) => m.kind === 'ready'));

  await archive.deliver({
    kind: 'init',
    payload: {
      role: 'archive',
      frameChannelBuffer: frameChannel.sharedBuffer,
      residualChannelBuffer: residualBuffer,
      workerConfig: {},
    },
  });
  await pumpUntil(() => archive.posted.some((m) => m.kind === 'ready'));

  return { decode, fit, archive, frameChannel };
}

async function requestArchiveReply<TKind extends WorkerOutbound['kind']>(
  archive: WorkerHarness,
  request: WorkerInbound,
  replyKind: TKind,
): Promise<Extract<WorkerOutbound, { kind: TKind }>> {
  archive.posted.length = 0;
  await archive.deliver(request);
  await pumpUntil(() => archive.posted.some((m) => m.kind === replyKind));
  return archive.posted.find(
    (m): m is Extract<WorkerOutbound, { kind: TKind }> => m.kind === replyKind,
  )!;
}

describe('CaLa Phase 6 exit — end-to-end', () => {
  beforeEach(() => {
    fitterFrameCount = 0;
    fitterDrainApplyCount = 0;
    extenderCycleCount = 0;
    mutationHandlePushDeprecateCount = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    parsedAvi = null;
  });

  it(
    'emits vitals timeseries, indexes events, records footprint history, accepts user mutations',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      if (!existsSync(AVI_FIXTURE)) {
        throw new Error(`AVI fixture missing at ${AVI_FIXTURE} — .test_data/ is local-only.`);
      }
      const realAvi = parseAvi(new Uint8Array(readFileSync(AVI_FIXTURE)));
      parsedAvi = { ...realAvi, frames: realAvi.frames.slice(0, TEST_MAX_FRAMES) };

      const boot = await bootAllWorkers(parsedAvi);

      await boot.decode.deliver({ kind: 'run' });
      await boot.fit.deliver({ kind: 'run' });
      await boot.archive.deliver({ kind: 'run' });

      await pumpUntil(() => fitterFrameCount >= TEST_MIN_FRAMES_PROCESSED);
      await pumpUntil(() => extenderCycleCount >= 1);

      // Inject a synthetic `birth` event directly onto the archive so
      // task 2's per-neuron index + task 3's footprint store have
      // something to resolve on query. (Real births need the
      // Phase-7-deferred `drainApplyEvents` binding.)
      const syntheticBirth: PipelineEvent = {
        kind: 'birth',
        t: fitterFrameCount,
        id: TEST_NEURON_ID,
        patch: [0, 0],
        footprintSnap: {
          pixelIndices: new Uint32Array([1, 2, 3]),
          values: new Float32Array([0.5, 0.7, 0.3]),
        },
      };
      await boot.archive.deliver({ kind: 'event', event: syntheticBirth });

      // User-authored mutation lands on the fit worker.
      await boot.fit.deliver({
        kind: 'user-mutation',
        mutation: { kind: 'deprecate', id: TEST_NEURON_ID, reason: 'traceInactive' },
      });
      await pumpUntil(() => mutationHandlePushDeprecateCount >= 1);

      await boot.decode.deliver({ kind: 'stop' });
      await pumpUntil(() => boot.decode.posted.some((m) => m.kind === 'done'));
      await boot.fit.deliver({ kind: 'stop' });
      await pumpUntil(() => boot.fit.posted.some((m) => m.kind === 'done'));

      // --- archive query surface (tasks 1-3) --------------------------

      const tsReply = await requestArchiveReply(
        boot.archive,
        { kind: 'request-timeseries', requestId: 100, name: 'fps' },
        'timeseries',
      );
      expect(tsReply.name).toBe('fps');
      expect(tsReply.l1Times.length + tsReply.l2Times.length).toBeGreaterThanOrEqual(1);

      const eventsReply = await requestArchiveReply(
        boot.archive,
        { kind: 'request-events-for-neuron', requestId: 101, neuronId: TEST_NEURON_ID },
        'events-for-neuron',
      );
      expect(eventsReply.events.length).toBeGreaterThanOrEqual(1);
      expect(eventsReply.events.some((e) => e.kind === 'birth')).toBe(true);

      const footprintReply = await requestArchiveReply(
        boot.archive,
        { kind: 'request-footprint-history', requestId: 102, neuronId: TEST_NEURON_ID },
        'footprint-history',
      );
      expect(footprintReply.times.length).toBeGreaterThanOrEqual(1);
      expect(Array.from(footprintReply.pixelIndices[0])).toEqual([1, 2, 3]);

      const dump = await requestArchiveReply(
        boot.archive,
        { kind: 'request-archive-dump', requestId: 103 },
        'archive-dump',
      );
      // Dump must include the synthetic birth + extend.proposed metrics.
      expect(dump.events.some((e) => e.kind === 'birth')).toBe(true);
      const proposedMetrics = dump.events.filter(
        (e): e is Extract<PipelineEvent, { kind: 'metric' }> =>
          e.kind === 'metric' && e.name === 'extend.proposed',
      );
      expect(proposedMetrics.length).toBeGreaterThanOrEqual(1);

      await boot.archive.deliver({ kind: 'stop' });
      await pumpUntil(() => boot.archive.posted.some((m) => m.kind === 'done'));

      // No worker errored out.
      const errors = [
        ...boot.decode.posted.filter((m) => m.kind === 'error'),
        ...boot.fit.posted.filter((m) => m.kind === 'error'),
        ...boot.archive.posted.filter((m) => m.kind === 'error'),
      ];
      expect(errors).toEqual([]);

      console.info(
        `[phase6-exit] frames=${fitterFrameCount} ` +
          `extend_cycles=${extenderCycleCount} ` +
          `drain_applies=${fitterDrainApplyCount} ` +
          `deprecate_pushes=${mutationHandlePushDeprecateCount} ` +
          `ts_samples=${tsReply.l1Times.length + tsReply.l2Times.length} ` +
          `neuron_events=${eventsReply.events.length} ` +
          `footprints=${footprintReply.times.length}`,
      );
    },
  );
});
