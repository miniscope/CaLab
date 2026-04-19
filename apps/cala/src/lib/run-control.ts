import { createSignal, type Accessor } from 'solid-js';
import { openAviUncompressed } from '@calab/io';
import type { FrameSource, FrameSourceMeta } from '@calab/io';
import {
  createRuntime,
  type RuntimeConfig,
  type RuntimeController,
  type RuntimeState,
  type UserMutation,
  type WorkerFactory,
  type WorkerLike,
  type WorkerOutbound,
  type WorkerRole,
} from '@calab/cala-runtime';
import { state, setRunState, setErrorMsg } from './data-store.ts';
import { recordFrameProcessed } from './dashboard-store.ts';
import {
  createDecodePreprocessWorker,
  createFitWorker,
  createExtendWorker,
  createArchiveWorker,
} from '../workers/index.ts';

// Ring / queue sizing defaults (design §7.1, §7.3, §13).
// Kept in one place so future tuning passes have a single knob per
// parameter. Values err conservative: depths large enough that a brief
// scheduler hiccup on any single worker doesn't instantly overflow.
const DEFAULT_FRAME_CHANNEL_SLOTS = 4;
const DEFAULT_RESIDUAL_CHANNEL_SLOTS = 4;
const DEFAULT_CHANNEL_WAIT_TIMEOUT_MS = 50;
const DEFAULT_CHANNEL_POLL_INTERVAL_MS = 1;
const DEFAULT_MUTATION_QUEUE_CAPACITY = 32;
const DEFAULT_SNAPSHOT_ACK_TIMEOUT_MS = 1000;
const DEFAULT_SNAPSHOT_PENDING_CAPACITY = 2;
const DEFAULT_SNAPSHOT_POLL_INTERVAL_MS = 5;
const DEFAULT_EVENT_BUS_CAPACITY = 1024;
const DEFAULT_EVENT_BUS_MAX_SUBSCRIBERS = 8;
const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
// f32 grayscale → 4 bytes per pixel.
const BYTES_PER_F32_PIXEL = 4;
// W1 preview cadence (design §12 frame panel). Strided so the canvas
// updates a few times per second even on a fast pipeline, without the
// main thread paying postMessage cost on every decode.
const DEFAULT_FRAME_PREVIEW_STRIDE = 2;
// Standard UCLA miniscope V3/V4 pixel size. Override by exposing a
// `pixelSizeUm` setting in the UI when the app gains recording-specific
// metadata (Phase 6+).
const DEFAULT_PIXEL_SIZE_UM = 2.0;

export type WorkerFactories = Record<WorkerRole, WorkerFactory>;

function defaultWorkerFactories(): WorkerFactories {
  // Real worker factories now that tasks 21-23 landed. Tests still
  // override this by passing an explicit `factories` to `startRun`.
  return {
    decodePreprocess: createDecodePreprocessWorker,
    fit: createFitWorker,
    extend: createExtendWorker,
    archive: createArchiveWorker,
  };
}

export interface LatestFramePreview {
  index: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

// Signal (not store) because the preview updates every few frames and
// fine-grained store reactivity is wasted overhead — the viewer
// re-renders the whole canvas per update regardless.
const [latestFrameSignal, setLatestFrameSignal] = createSignal<LatestFramePreview | null>(null);

export const latestFrame: Accessor<LatestFramePreview | null> = latestFrameSignal;

function buildConfig(meta: FrameSourceMeta, factories: WorkerFactories): RuntimeConfig {
  const frameBytes = meta.width * meta.height * BYTES_PER_F32_PIXEL;
  return {
    workerFactories: factories,
    frameChannel: {
      slotBytes: frameBytes,
      slotCount: DEFAULT_FRAME_CHANNEL_SLOTS,
      waitTimeoutMs: DEFAULT_CHANNEL_WAIT_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_CHANNEL_POLL_INTERVAL_MS,
    },
    residualChannel: {
      slotBytes: frameBytes,
      slotCount: DEFAULT_RESIDUAL_CHANNEL_SLOTS,
      waitTimeoutMs: DEFAULT_CHANNEL_WAIT_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_CHANNEL_POLL_INTERVAL_MS,
    },
    mutationQueue: { capacity: DEFAULT_MUTATION_QUEUE_CAPACITY },
    snapshotProtocol: {
      ackTimeoutMs: DEFAULT_SNAPSHOT_ACK_TIMEOUT_MS,
      pendingCapacity: DEFAULT_SNAPSHOT_PENDING_CAPACITY,
      pollIntervalMs: DEFAULT_SNAPSHOT_POLL_INTERVAL_MS,
    },
    eventBus: {
      capacity: DEFAULT_EVENT_BUS_CAPACITY,
      maxSubscribers: DEFAULT_EVENT_BUS_MAX_SUBSCRIBERS,
    },
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    workerConfigs: {
      decodePreprocess: {
        framePreviewStride: DEFAULT_FRAME_PREVIEW_STRIDE,
        metadataJson: JSON.stringify({ pixel_size_um: DEFAULT_PIXEL_SIZE_UM }),
      },
      fit: {
        height: meta.height,
        width: meta.width,
        // Shared with W1's metadata: extend's `RecordingMetadata`
        // parser (task 11) needs `pixel_size_um` to translate the
        // neuron-diameter gate into pixels.
        metadataJson: JSON.stringify({ pixel_size_um: DEFAULT_PIXEL_SIZE_UM }),
      },
    },
  };
}

// Opaque thunk the runtime passes to the decoder worker (design §7).
// `RuntimeConfig.sources.frameSourceFactory` is typed `unknown`, so we
// build it here as a plain function that returns a `FrameSource` and
// cast to `unknown` at the `RuntimeSource` boundary.
type FrameSourceFactory = (file: File) => Promise<FrameSource>;
const frameSourceFactory: FrameSourceFactory = openAviUncompressed;

let currentRuntime: RuntimeController | null = null;
let currentUnsubscribe: (() => void) | null = null;
// Captured per-run so the main thread can construct an ArchiveClient
// against the archive worker and so we can read W1's frame-preview
// posts. Cleared on run end.
let currentArchiveWorker: WorkerLike | null = null;
let currentPreviewDetach: (() => void) | null = null;
let currentFitDetach: (() => void) | null = null;

export interface StartOptions {
  factories?: WorkerFactories;
}

export function currentArchiveWorkerForClient(): WorkerLike | null {
  return currentArchiveWorker;
}

function wrapFactories(base: WorkerFactories): WorkerFactories {
  const wrap =
    (role: WorkerRole, inner: WorkerFactory): WorkerFactory =>
    () => {
      const worker = inner();
      if (role === 'archive') {
        currentArchiveWorker = worker;
      }
      if (role === 'decodePreprocess') {
        // Main-thread listener for W1 frame-preview posts. Runs
        // alongside the orchestrator's own listener — neither
        // interferes with the other. Frame index + epoch for the
        // dashboard counter come from the fit worker's
        // `frame-processed` (below) since W1 has no view of the fit
        // pipeline's epoch and hardcodes 0.
        const listener = (ev: { data: WorkerOutbound }): void => {
          const msg = ev.data;
          if (msg.kind === 'frame-preview') {
            setLatestFrameSignal({
              index: msg.index,
              width: msg.width,
              height: msg.height,
              pixels: msg.pixels,
            });
            return;
          }
        };
        worker.addEventListener('message', listener);
        currentPreviewDetach = () => worker.removeEventListener('message', listener);
      }
      if (role === 'fit') {
        // Fit is the only worker that knows the real pipeline epoch,
        // so the dashboard frame/epoch label is driven from its
        // heartbeat. W1's `frame-processed` is ignored here.
        const listener = (ev: { data: WorkerOutbound }): void => {
          const msg = ev.data;
          if (msg.kind === 'frame-processed') {
            recordFrameProcessed(msg.index, msg.epoch);
          }
        };
        worker.addEventListener('message', listener);
        currentFitDetach = () => worker.removeEventListener('message', listener);
      }
      return worker;
    };
  return {
    decodePreprocess: wrap('decodePreprocess', base.decodePreprocess),
    fit: wrap('fit', base.fit),
    extend: wrap('extend', base.extend),
    archive: wrap('archive', base.archive),
  };
}

export async function startRun(opts: StartOptions = {}): Promise<void> {
  if (currentRuntime !== null) {
    throw new Error('run already in progress');
  }
  const file = state.file;
  const meta = state.meta;
  if (file === null || meta === null) {
    throw new Error('no file loaded');
  }

  setErrorMsg(null);
  setRunState('starting');

  const baseFactories = opts.factories ?? defaultWorkerFactories();
  const factories = wrapFactories(baseFactories);
  const cfg = buildConfig(meta, factories);
  const rt = createRuntime(cfg);
  currentRuntime = rt;
  currentUnsubscribe = rt.onStatus((status) => {
    setRunState(status.state);
    if (status.error !== undefined) setErrorMsg(status.error);
  });

  const source = {
    kind: 'file' as const,
    file,
    frameSourceFactory: frameSourceFactory as unknown,
  };

  try {
    await rt.run(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setErrorMsg(msg);
    setRunState('error');
    throw err;
  } finally {
    currentUnsubscribe?.();
    currentUnsubscribe = null;
    currentRuntime = null;
    currentPreviewDetach?.();
    currentPreviewDetach = null;
    currentFitDetach?.();
    currentFitDetach = null;
    currentArchiveWorker = null;
  }
}

export async function stopRun(): Promise<void> {
  const rt = currentRuntime;
  if (rt === null) return;
  await rt.stop();
}

export function currentRunState(): RuntimeState {
  return state.runState;
}

// Test-only hook so the lifecycle test can inspect whether the
// runtime handle has been released.
export function __hasActiveRuntimeForTests(): boolean {
  return currentRuntime !== null;
}

/**
 * Forward a user-authored mutation (Phase 6 task 13) to the fit
 * worker via the runtime controller. No-op if nothing is running.
 */
export function pushUserMutation(m: UserMutation): void {
  currentRuntime?.pushUserMutation(m);
}
