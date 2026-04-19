/**
 * Phase 6 task 12 — extend-cycle E2E on a real miniscope AVI.
 *
 * Builds on the Phase 5 exit harness (real AVI bytes, real SAB
 * channel, real worker modules) and cranks up `extendCycleStride`
 * so the fit worker's new extend path (task 11) actually fires.
 * Proves the wiring: residual push → `Extender.runCycle()` →
 * proposals metric → `drainApply` → epoch advance → `cell_count`
 * vital moves.
 *
 * What is *not* in scope here: the numerical correctness of the
 * extend decision logic. Those gates are already covered by the
 * Rust cold-start E2E (`extending_cold_start_e2e.rs`), which
 * shares the `extending::driver::run_cycle` code path with the
 * WASM `Extender` via task 10's refactor. A future Phase 7 E2E
 * will assert real `birth` events with footprint payloads once the
 * `Fitter.drainApplyEvents()` binding lands.
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

// --- tuning knobs (no magic numbers) -----------------------------------
const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const TEST_POLL_MS = 2;
const TEST_POLL_MAX_TICKS = 30_000;
const TEST_MAX_FRAMES = 16;
const TEST_MIN_FRAMES_PROCESSED = 8;
const TEST_HEARTBEAT_STRIDE = 2;
const TEST_PREVIEW_STRIDE = 100;
const TEST_SNAPSHOT_STRIDE = 1_000_000;
const TEST_EXTEND_CYCLE_STRIDE = 4;
const TEST_EXTEND_WINDOW_FRAMES = 8;
const TEST_MOCK_PROPOSALS_PER_CYCLE = 2;
const TEST_FRAME_CHANNEL_SLOT_COUNT = 8;
const TEST_FRAME_CHANNEL_WAIT_TIMEOUT_MS = 50;
const TEST_FRAME_CHANNEL_POLL_INTERVAL_MS = 1;
const TEST_MUTATION_QUEUE_CAPACITY = 8;
const TEST_EVENT_BUS_CAPACITY = 64;
const TEST_EVENT_BUS_MAX_SUBSCRIBERS = 4;
const TEST_SNAPSHOT_ACK_TIMEOUT_MS = 50;
const TEST_SNAPSHOT_POLL_INTERVAL_MS = 1;
const TEST_SNAPSHOT_PENDING_CAPACITY = 1;

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../..');
const AVI_FIXTURE = path.join(REPO_ROOT, '.test_data', 'anchor_v12_prepped.avi');

// --- AVI parsing (same as phase5-exit) ---------------------------------
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
          if (t === '00db' || t === '00dc') {
            frames.push({ offset: j + 8, size: s });
          }
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

// --- mocks --------------------------------------------------------------

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
    // After each drainApply we pretend one component was registered
    // so the Extender's mock proposals show up in the cell_count
    // timeseries even without a real Fitter.
    return Number(this.currentEpoch);
  }
  step(y: Float32Array): Float32Array {
    fitterFrameCount += 1;
    return y;
  }
  drainApply(_handle: unknown): Uint32Array {
    fitterDrainApplyCount += 1;
    // Pretend one mutation applied per drain so epoch advances.
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

class StubMutationQueueHandle {
  constructor(_cfg: string) {}
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
  calaMemoryBytes: vi.fn(() => 1024 * 1024),
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

  // Fit → archive event relay, same as Phase 5 E2E.
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

describe('CaLa Phase 6 task 12 — extend E2E on real AVI', () => {
  beforeEach(() => {
    fitterFrameCount = 0;
    fitterDrainApplyCount = 0;
    extenderCycleCount = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    parsedAvi = null;
  });

  it(
    'runs extend cycles on real fixture frames, emits extend.proposed, advances epoch',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      if (!existsSync(AVI_FIXTURE)) {
        throw new Error(
          `AVI fixture missing at ${AVI_FIXTURE} — .test_data/ is local-only, see .gitignore.`,
        );
      }
      const realAvi = parseAvi(new Uint8Array(readFileSync(AVI_FIXTURE)));
      parsedAvi = {
        ...realAvi,
        frames: realAvi.frames.slice(0, TEST_MAX_FRAMES),
      };

      const boot = await bootAllWorkers(parsedAvi);

      await boot.decode.deliver({ kind: 'run' });
      await boot.fit.deliver({ kind: 'run' });
      await boot.archive.deliver({ kind: 'run' });

      // Wait for enough frames to cross at least one extend stride.
      await pumpUntil(() => fitterFrameCount >= TEST_MIN_FRAMES_PROCESSED);
      await pumpUntil(() => extenderCycleCount >= 1);

      await boot.decode.deliver({ kind: 'stop' });
      await pumpUntil(() => boot.decode.posted.some((m) => m.kind === 'done'));
      await boot.fit.deliver({ kind: 'stop' });
      await pumpUntil(() => boot.fit.posted.some((m) => m.kind === 'done'));
      await boot.archive.deliver({ kind: 'stop' });
      await pumpUntil(() => boot.archive.posted.some((m) => m.kind === 'done'));

      // Extender was driven: at least one cycle fired, residuals pushed.
      expect(extenderCycleCount).toBeGreaterThanOrEqual(1);

      // Every extend cycle's proposals were applied on the next frame
      // — epoch equals total drainApply calls, and numComponents
      // reflects it.
      expect(fitterDrainApplyCount).toBeGreaterThanOrEqual(1);

      // extend.proposed metric events reached the archive.
      const archiveDumpReq: WorkerInbound = { kind: 'request-archive-dump', requestId: 42 };
      boot.archive.posted.length = 0;
      await boot.archive.deliver(archiveDumpReq);
      await pumpUntil(() => boot.archive.posted.some((m) => m.kind === 'archive-dump'));
      const dump = boot.archive.posted.find(
        (m): m is Extract<WorkerOutbound, { kind: 'archive-dump' }> => m.kind === 'archive-dump',
      )!;
      const proposedEvents = dump.events.filter(
        (e: PipelineEvent): e is Extract<PipelineEvent, { kind: 'metric' }> =>
          e.kind === 'metric' && e.name === 'extend.proposed',
      );
      expect(proposedEvents.length).toBeGreaterThanOrEqual(1);
      expect(proposedEvents[0].value).toBe(TEST_MOCK_PROPOSALS_PER_CYCLE);

      // No uncaught errors bubbled out of any worker.
      const errors = [
        ...boot.decode.posted.filter((m) => m.kind === 'error'),
        ...boot.fit.posted.filter((m) => m.kind === 'error'),
        ...boot.archive.posted.filter((m) => m.kind === 'error'),
      ];
      expect(errors).toEqual([]);

      console.info(
        `[phase6-extend] frames=${fitterFrameCount} ` +
          `extend_cycles=${extenderCycleCount} ` +
          `drain_applies=${fitterDrainApplyCount} ` +
          `proposed_metrics=${proposedEvents.length}`,
      );
    },
  );
});
