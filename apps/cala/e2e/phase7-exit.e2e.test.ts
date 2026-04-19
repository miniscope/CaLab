/**
 * Phase 7 exit E2E — task 16.
 *
 * End-to-end proof that every Phase 7 pillar that touches wire
 * protocol is reachable on a real miniscope AVI:
 *
 *   1. `drainApplyEvents` emits real birth events that reach the
 *      archive worker's event log (T1-T3).
 *   2. W1 emits 3-stage preview streams tagged 'raw', 'hotPixel',
 *      'motion' (T5).
 *   3. W2 emits reconstruction preview tagged 'reconstruction' (T6).
 *   4. `trace-sample` events flow into the archive's neuron trace
 *      store and are queryable via `request-all-traces` (T8).
 *   5. `request-all-footprints` returns latest sparse-A per live id
 *      (T10).
 *   6. `buildCalaExportNpz` round-trips the archive reply through
 *      `parseNpz` with the expected CSC + K×T shapes (T15).
 *
 * Two-pass + run-mode toggle (originally T13/T14) were explicitly
 * descoped to Phase 8 — they need cross-worker Footprints state
 * transfer that's out of scope for this phase.
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
// NOTE: `@calab/io` + `../src/lib/export.ts` pull `@calab/cala-core`
// transitively via `avi-uncompressed.ts`. We `vi.mock` that module
// below, and vitest hoists the factory above this file's other
// top-level statements — so importing those two eagerly here
// triggers "Cannot access 'StubAviReader' before initialization"
// against the hoisted factory. Load them via dynamic import inside
// the test body instead, after the mock is in place.
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
const TEST_PREVIEW_STRIDE = 4;
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
// Stub trace amplitude each vitals tick so `trace-sample` events
// carry real numbers the archive can route through its per-neuron
// trace store.
const TEST_STUB_TRACE_VALUE = 0.42;

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

function fourcc(bytes: Uint8Array, i: number): string {
  return String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
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
  processFrameF32WithStages(input: Float32Array): Float32Array {
    const out = new Float32Array(input.length * 3);
    out.set(input, 0);
    out.set(input, input.length);
    out.set(input, input.length * 2);
    return out;
  }
  free(): void {}
}

let fitterFrameCount = 0;
let fitterDrainApplyCount = 0;

class StubFitter {
  private currentEpoch = 0n;
  private liveIds: number[] = [];
  constructor(_h: number, _w: number, _c: string) {}
  epoch(): bigint {
    return this.currentEpoch;
  }
  numComponents(): number {
    return this.liveIds.length;
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
  drainApplyEvents(_handle: unknown): {
    report: [number, number, number];
    events: Array<Record<string, unknown>>;
  } {
    fitterDrainApplyCount += 1;
    const id = Number(this.currentEpoch);
    this.currentEpoch += 1n;
    this.liveIds.push(id);
    return {
      report: [1, 0, 0],
      events: [
        {
          kind: 'birth',
          id,
          class: 'cell',
          support: [id, id + 1],
          values: [0.7, 0.3],
          patch: [0, id],
        },
      ],
    };
  }
  reconstructLastFrame(): Float32Array {
    // Phase 7 T6: emit a non-empty Float32Array so W2's preview path
    // posts a 'reconstruction' stage frame. Shape must match H·W.
    if (!parsedAvi) return new Float32Array(0);
    const out = new Float32Array(parsedAvi.width * parsedAvi.height);
    out.fill(0.1);
    return out;
  }
  componentIds(): Uint32Array {
    return Uint32Array.from(this.liveIds);
  }
  lastTrace(): Float32Array {
    const out = new Float32Array(this.liveIds.length);
    out.fill(TEST_STUB_TRACE_VALUE);
    return out;
  }
  takeSnapshot(): { epoch(): bigint; numComponents(): number; pixels(): number; free(): void } {
    return {
      epoch: () => this.currentEpoch,
      numComponents: () => this.liveIds.length,
      pixels: () => 0,
      free: () => {},
    };
  }
  free(): void {}
}

class StubMutationQueueHandle {
  constructor(_cfg: string) {}
  pushDeprecate(_snapshotEpoch: bigint, _id: number, _reason: string): void {}
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
  calaMemoryBytes: vi.fn(() => 3 * 1024 * 1024),
  drainApplyEventsTyped: (fitter: { drainApplyEvents: (q: unknown) => unknown }, queue: unknown) =>
    fitter.drainApplyEvents(queue),
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

  // Fit → Archive bus event forwarding (orchestrator's job in prod).
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
        // Phase 7 T6 — fit worker needs its own preview stride to
        // emit reconstruction frames. Reusing the same cadence as W1.
        framePreviewStride: TEST_PREVIEW_STRIDE,
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

describe('CaLa Phase 7 exit — end-to-end', () => {
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
    'emits real births, 4-stage previews, trace samples + exports a valid NPZ',
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

      // --- (T5) W1 3-stage preview streams -------------------------------
      const w1Previews = boot.decode.posted.filter(
        (m): m is Extract<WorkerOutbound, { kind: 'frame-preview' }> => m.kind === 'frame-preview',
      );
      const stages = new Set(w1Previews.map((p) => p.stage));
      expect(stages.has('raw')).toBe(true);
      expect(stages.has('hotPixel')).toBe(true);
      expect(stages.has('motion')).toBe(true);

      // --- (T6) W2 reconstruction preview --------------------------------
      const w2Previews = boot.fit.posted.filter(
        (m): m is Extract<WorkerOutbound, { kind: 'frame-preview' }> =>
          m.kind === 'frame-preview' && m.stage === 'reconstruction',
      );
      expect(w2Previews.length).toBeGreaterThanOrEqual(1);

      // --- (T1-T3) Real birth events published on the bus ----------------
      const busBirths = boot.fit.posted.filter(
        (m): m is Extract<WorkerOutbound, { kind: 'event' }> =>
          m.kind === 'event' && m.event.kind === 'birth',
      );
      expect(busBirths.length).toBeGreaterThanOrEqual(1);
      expect((busBirths[0].event as Extract<PipelineEvent, { kind: 'birth' }>).id).toBeDefined();

      await boot.decode.deliver({ kind: 'stop' });
      await pumpUntil(() => boot.decode.posted.some((m) => m.kind === 'done'));
      await boot.fit.deliver({ kind: 'stop' });
      await pumpUntil(() => boot.fit.posted.some((m) => m.kind === 'done'));

      // --- (T8) Traces landed in archive trace store ---------------------
      const tracesReply = await requestArchiveReply(
        boot.archive,
        { kind: 'request-all-traces', requestId: 200 },
        'all-traces',
      );
      expect(tracesReply.ids.length).toBeGreaterThanOrEqual(1);
      expect(tracesReply.values.length).toBe(tracesReply.ids.length);
      // Each traced id has at least one sample at the stubbed amplitude.
      for (const vs of tracesReply.values) {
        expect(vs.length).toBeGreaterThanOrEqual(1);
        expect(vs[0]).toBeCloseTo(TEST_STUB_TRACE_VALUE, 3);
      }

      // --- (T10) All live footprints via archive query --------------------
      const footprintsReply = await requestArchiveReply(
        boot.archive,
        { kind: 'request-all-footprints', requestId: 201 },
        'all-footprints',
      );
      expect(footprintsReply.ids.length).toBeGreaterThanOrEqual(1);
      expect(footprintsReply.pixelIndices.length).toBe(footprintsReply.ids.length);

      // --- (T15) Export NPZ round-trips through parseNpz ------------------
      const { buildCalaExportNpz } = await import('../src/lib/export.ts');
      const { parseNpz } = await import('@calab/io');
      const npz = buildCalaExportNpz({
        footprints: footprintsReply,
        traces: tracesReply,
        meta: { height: parsedAvi.height, width: parsedAvi.width },
      });
      const parsed = parseNpz(npz.buffer as ArrayBuffer);
      expect(parsed.arrays.A_data.data.length).toBeGreaterThanOrEqual(
        footprintsReply.ids.length, // at least one nnz per id
      );
      expect(Array.from(parsed.arrays.A_shape.data)).toEqual([
        parsedAvi.height * parsedAvi.width,
        footprintsReply.ids.length,
      ]);
      expect(parsed.arrays.C.shape[0]).toBe(tracesReply.ids.length);
      expect(parsed.arrays.height.data[0]).toBe(parsedAvi.height);
      expect(parsed.arrays.width.data[0]).toBe(parsedAvi.width);

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
        `[phase7-exit] frames=${fitterFrameCount} ` +
          `extend_cycles=${extenderCycleCount} ` +
          `drain_applies=${fitterDrainApplyCount} ` +
          `w1_previews=${w1Previews.length} ` +
          `w2_previews=${w2Previews.length} ` +
          `births=${busBirths.length} ` +
          `traced_ids=${tracesReply.ids.length} ` +
          `footprints=${footprintsReply.ids.length}`,
      );
    },
  );
});
