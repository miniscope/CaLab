import { initCalaCore, Preprocessor } from '@calab/cala-core';
import { openAviUncompressed } from '@calab/io';
import type { FrameSource, GrayscaleMethod } from '@calab/io';
import {
  SabRingChannel,
  type WorkerInbound,
  type WorkerInitPayload,
  type WorkerOutbound,
  type ChannelConfig,
} from '@calab/cala-runtime';
import { quantizeToU8 } from '../lib/frame-preview.ts';

// Heartbeat cadence: post a `frame-processed` beat every N frames so
// the orchestrator can update status without being spammed every frame.
// Overridable via `workerConfig.heartbeatStride` (design §7.1, no magic
// numbers rule: every tuning knob lives in config or in a named const).
const DEFAULT_HEARTBEAT_STRIDE = 8;
// Preview cadence for the dashboard's SingleFrameViewer (design §12,
// Phase 5). The preview is a u8 grayscale snapshot of the processed
// frame — cheap to post, cheap to render with putImageData. Disabled
// (stride ≤ 0) unless the app explicitly opts in through workerConfig.
const DEFAULT_FRAME_PREVIEW_STRIDE = 0;
const DEFAULT_GRAYSCALE_METHOD: GrayscaleMethod = 'Green';
const DEFAULT_METADATA_JSON = '{}';
const DEFAULT_PREPROCESS_CONFIG_JSON = '{}';
const DEFAULT_FRAME_CHANNEL_WAIT_TIMEOUT_MS = 1000;
const DEFAULT_FRAME_CHANNEL_POLL_INTERVAL_MS = 1;
// Slot count the orchestrator sized the SAB channel with. The worker
// does not allocate — it only needs slotCount for the view.
const FRAME_CHANNEL_SLOT_COUNT_FALLBACK = 4;

const ROLE = 'decodePreprocess' as const;

interface WorkerGlobalScope {
  postMessage(msg: WorkerOutbound): void;
  onmessage: ((ev: MessageEvent<WorkerInbound>) => void) | null;
}

interface DecodePreprocessWorkerConfig {
  source: { kind: 'file'; file: File };
  heartbeatStride?: number;
  framePreviewStride?: number;
  metadataJson?: string;
  preprocessConfigJson?: string;
  grayscaleMethod?: GrayscaleMethod;
  frameChannelSlotBytes?: number;
  frameChannelSlotCount?: number;
  frameChannelWaitTimeoutMs?: number;
  frameChannelPollIntervalMs?: number;
}

// Route through `self` when present so `vi.stubGlobal('self', harness)`
// picks us up; falls back to `globalThis` for environments that don't
// alias them (older node test harnesses).
const workerSelf = ((globalThis as unknown as { self?: WorkerGlobalScope }).self ??
  (globalThis as unknown as WorkerGlobalScope)) as WorkerGlobalScope;

interface RuntimeHandles {
  frameSource: FrameSource;
  preprocessor: Preprocessor;
  frameChannel: SabRingChannel;
  heartbeatStride: number;
  framePreviewStride: number;
  grayscaleMethod: GrayscaleMethod;
  frameCount: number;
  width: number;
  height: number;
}

let handles: RuntimeHandles | null = null;
let running = false;
let stopRequested = false;
let donePosted = false;
let loopPromise: Promise<void> | null = null;

function post(msg: WorkerOutbound): void {
  workerSelf.postMessage(msg);
}

function postError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  post({ kind: 'error', role: ROLE, message });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function parseConfig(raw: unknown): DecodePreprocessWorkerConfig {
  const cfg = asRecord(raw);
  const source = asRecord(cfg.source);
  const file = source.file;
  if (!(file instanceof File)) {
    throw new Error('workerConfig.source.file must be a File');
  }
  return {
    source: { kind: 'file', file },
    heartbeatStride: typeof cfg.heartbeatStride === 'number' ? cfg.heartbeatStride : undefined,
    framePreviewStride:
      typeof cfg.framePreviewStride === 'number' ? cfg.framePreviewStride : undefined,
    metadataJson: typeof cfg.metadataJson === 'string' ? cfg.metadataJson : undefined,
    preprocessConfigJson:
      typeof cfg.preprocessConfigJson === 'string' ? cfg.preprocessConfigJson : undefined,
    grayscaleMethod:
      cfg.grayscaleMethod === 'Green' || cfg.grayscaleMethod === 'Luminance'
        ? cfg.grayscaleMethod
        : undefined,
    frameChannelSlotBytes:
      typeof cfg.frameChannelSlotBytes === 'number' ? cfg.frameChannelSlotBytes : undefined,
    frameChannelSlotCount:
      typeof cfg.frameChannelSlotCount === 'number' ? cfg.frameChannelSlotCount : undefined,
    frameChannelWaitTimeoutMs:
      typeof cfg.frameChannelWaitTimeoutMs === 'number' ? cfg.frameChannelWaitTimeoutMs : undefined,
    frameChannelPollIntervalMs:
      typeof cfg.frameChannelPollIntervalMs === 'number'
        ? cfg.frameChannelPollIntervalMs
        : undefined,
  };
}

async function handleInit(payload: WorkerInitPayload): Promise<void> {
  await initCalaCore();
  const cfg = parseConfig(payload.workerConfig);

  const frameSource = await openAviUncompressed(cfg.source.file);
  const meta = frameSource.meta();
  const pixels = meta.width * meta.height;
  const defaultSlotBytes = pixels * Float32Array.BYTES_PER_ELEMENT;

  const preprocessor = new Preprocessor(
    meta.height,
    meta.width,
    cfg.metadataJson ?? DEFAULT_METADATA_JSON,
    cfg.preprocessConfigJson ?? DEFAULT_PREPROCESS_CONFIG_JSON,
  );

  const channelCfg: ChannelConfig = {
    slotBytes: cfg.frameChannelSlotBytes ?? defaultSlotBytes,
    slotCount: cfg.frameChannelSlotCount ?? FRAME_CHANNEL_SLOT_COUNT_FALLBACK,
    waitTimeoutMs: cfg.frameChannelWaitTimeoutMs ?? DEFAULT_FRAME_CHANNEL_WAIT_TIMEOUT_MS,
    pollIntervalMs: cfg.frameChannelPollIntervalMs ?? DEFAULT_FRAME_CHANNEL_POLL_INTERVAL_MS,
    sharedBuffer: payload.frameChannelBuffer,
  };
  const frameChannel = new SabRingChannel(channelCfg);

  handles = {
    frameSource,
    preprocessor,
    frameChannel,
    heartbeatStride: cfg.heartbeatStride ?? DEFAULT_HEARTBEAT_STRIDE,
    framePreviewStride: cfg.framePreviewStride ?? DEFAULT_FRAME_PREVIEW_STRIDE,
    grayscaleMethod: cfg.grayscaleMethod ?? DEFAULT_GRAYSCALE_METHOD,
    frameCount: meta.frameCount,
    width: meta.width,
    height: meta.height,
  };

  post({ kind: 'ready', role: ROLE });
}

async function decodeLoop(h: RuntimeHandles): Promise<void> {
  const pixels = h.width * h.height;
  for (let i = 0; i < h.frameCount; i += 1) {
    if (stopRequested) return;
    const frame = await h.frameSource.readFrame(i, h.grayscaleMethod);
    if (stopRequested) return;
    const wantPreview = h.framePreviewStride > 0 && (i + 1) % h.framePreviewStride === 0;
    if (wantPreview) {
      // Preview stride — call the stage-capturing variant so we can
      // post raw / hotPixel / motion previews for the 4-canvas panel
      // (design §12, Phase 7 task 5). Output layout:
      //   [final || hotPixel || motion]
      const combined = h.preprocessor.processFrameF32WithStages(frame);
      const finalFrame = combined.subarray(0, pixels);
      const hotPixelFrame = combined.subarray(pixels, 2 * pixels);
      const motionFrame = combined.subarray(2 * pixels, 3 * pixels);
      // Fit reads the post-preprocess frame from the SAB slot. Write
      // `finalFrame` (motion-corrected, post-denoise when on) so the
      // hot path sees the same data it always did.
      h.frameChannel.writeSlot(finalFrame, 0n);
      post({
        kind: 'frame-preview',
        role: ROLE,
        index: i,
        width: h.width,
        height: h.height,
        stage: 'raw',
        pixels: quantizeToU8(frame),
      });
      post({
        kind: 'frame-preview',
        role: ROLE,
        index: i,
        width: h.width,
        height: h.height,
        stage: 'hotPixel',
        pixels: quantizeToU8(hotPixelFrame),
      });
      post({
        kind: 'frame-preview',
        role: ROLE,
        index: i,
        width: h.width,
        height: h.height,
        stage: 'motion',
        pixels: quantizeToU8(motionFrame),
      });
    } else {
      const processed = h.preprocessor.processFrameF32(frame);
      h.frameChannel.writeSlot(processed, 0n);
    }
    // Epoch is fit-owned; W1 tags SAB slots with 0n. Fit does not
    // rely on this tag for demux — it advances its own epoch on
    // mutation-applied acks (design §7.3).
    if ((i + 1) % h.heartbeatStride === 0) {
      post({ kind: 'frame-processed', role: ROLE, index: i, epoch: 0n });
    }
  }
}

function cleanup(): void {
  if (!handles) return;
  try {
    handles.frameSource.close();
  } catch {
    // close is best-effort; already-closed sources throw in some impls
  }
  try {
    handles.preprocessor.free();
  } catch {
    // free is best-effort — wasm may already be torn down
  }
  handles = null;
}

function postDoneOnce(): void {
  if (donePosted) return;
  donePosted = true;
  post({ kind: 'done', role: ROLE });
}

async function handleRun(): Promise<void> {
  if (!handles) {
    postError(new Error("'run' received before successful 'init'"));
    return;
  }
  if (running) return;
  running = true;
  stopRequested = false;
  donePosted = false;
  const h = handles;
  try {
    await decodeLoop(h);
    postDoneOnce();
  } catch (err) {
    postError(err);
  } finally {
    running = false;
    cleanup();
  }
}

async function handleStop(): Promise<void> {
  stopRequested = true;
  if (loopPromise) await loopPromise;
  postDoneOnce();
  cleanup();
}

workerSelf.onmessage = (ev: MessageEvent<WorkerInbound>): void => {
  const msg = ev.data;
  switch (msg.kind) {
    case 'init':
      handleInit(msg.payload).catch(postError);
      return;
    case 'run':
      loopPromise = handleRun();
      return;
    case 'stop':
      handleStop().catch(postError);
      return;
    case 'snapshot-ack':
      // W1 has no snapshot participation — ignored.
      return;
  }
};
