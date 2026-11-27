import type {
  FolderEntry,
  FrameSourceInfo,
  FramePixels,
  SessionInput,
} from '../lib/frame-source.ts';
import type { PipelineStepResult } from '../lib/pipeline-types.ts';
import type { PipelineOptions, PipelinePlan } from '../lib/pipeline-plan.ts';
import type { FlatFieldMap } from '../lib/flat-field.ts';
import type { FrameView } from '../lib/preview.ts';
import type { PaceStats } from '../lib/frame-pacer.ts';
import type { ReplayInput } from '../lib/pipeline-stages.ts';
import type { RunCells } from '../lib/run-cells.ts';
import type { CompressTiling } from './compress-types.ts';

/**
 * Fast-loop settings of a pipeline run, with the slow loop's run options (`RunCells`; the trace
 * worker normalizes them and adds `sessionStarts` from the plan, `lib/run-cells.ts`).
 */
export interface CellsSettings extends Omit<RunCells, 'sessionStarts'> {
  /** Tags the run's messages to the slow worker and the main thread. */
  session: number;
  /** Run cell discovery (forward frames to the slow worker). */
  discover: boolean;
  /** Run online quality control on the traces (default on). */
  qc?: boolean;
  /**
   * The replay stage (Extract, see docs/stages.md): solve every frame
   * with this library (`TraceLibrary.toBytes()`). Nothing goes to the slow loop.
   */
  library?: Uint8Array;
  /** Batches in flight to the slow worker (default `FAST_LOOP_DEFAULTS.poolSize`). */
  forwardBuffers?: number;
  /** Feed the compress worker (default off; needs its port). */
  compress?: boolean;
  /** With `compress`: how the frames are cut into tiles (default plain). */
  compressTiling?: CompressTiling;
  /** With `compress`: compress workers while the recording runs and after its end (default one and one). */
  compressPool?: { discover: number; after: number };
  /** With `compress`: the cap on window files waiting for compression, bytes (`?debug&cbacklog`). */
  compressBacklogCap?: number;
  /** With `compress`: Extract on factors on rebuilt frames (`?debug&fextract=0`). */
  compressFrameExtract?: boolean;
  /** With `compress`: a recording on the GPU route (the default) compresses its windows on the GPU (`CompressInit.gpu`). */
  compressGpu?: boolean;
  /** With `compressGpu`: windows the CPU compresses too, to check the GPU's factors (`?debug&gpucheck=N`). */
  compressGpuCheck?: number;
  /** Return a residual preview with each batch (the residual view is shown). */
  residual?: boolean;
  /** Return the signed (unclipped) traces with each batch (Extract; `CellsBatch.signed`). */
  signed?: boolean;
  /**
   * Keep the mean and max projections of every frame and return them with the
   * `done` step (Extract, for the export).
   */
  projection?: boolean;
}

/** A probed session: its info, or the error opening it. */
export type SessionProbeResult = { info: FrameSourceInfo } | { error: string };

/**
 * Main thread -> pipeline workers. `id` pairs a request with its response. The frame worker takes
 * all but `connect-slow`, `connect-compress`, `release-compress`, `set-discovery` and
 * `set-residual`, which go to the trace worker (`frame-client.ts`).
 */
export type FrameRequest =
  /** Entries carry their folder path as data: a File property would not survive structured clone. */
  | { type: 'open'; id: number; entries: FolderEntry[] }
  /** Open several sessions as one recording, in order (a Joint run; `FrameSource.openSessions`). */
  | { type: 'open-sessions'; id: number; sessions: SessionInput[] }
  /** Read each session's headers and sidecars for the session list, without keeping any open. */
  | { type: 'probe'; id: number; sessions: SessionInput[] }
  /** Connect to a live source (`lib/live-source.ts`) at a WebSocket URL. */
  | { type: 'open-live'; id: number; url: string }
  /** `count` consecutive frames from global index `start` (one for a single frame). */
  | { type: 'read'; id: number; start: number; count: number }
  /** Set up the preprocess + motion pipeline over the open recording (replaces any running one). */
  | {
      type: 'pipeline-start';
      id: number;
      options: PipelineOptions;
      cells?: CellsSettings;
      /** Extract: replay the recorded flicker and motion. */
      replay?: ReplayInput;
      /** Discover's flat field: a stored map of this sensor, in force from the first processed frame and seeding the estimator. */
      flat?: { seed?: FlatFieldMap };
    }
  /** Stop reading at the current position: the next step reports the end of the recording. */
  | { type: 'pipeline-truncate'; id: number }
  /**
   * Run one pipeline step and answer with its result. The main thread keeps
   * at most a couple of these outstanding, which is the backpressure: the
   * worker never runs ahead of what the UI has asked for.
   */
  | { type: 'pipeline-step'; id: number }
  /** Free the pipeline's WASM state. */
  | { type: 'pipeline-stop'; id: number }
  /** The port to the slow worker (transferred). */
  | { type: 'connect-slow'; id: number; port: MessagePort }
  /** The port to the compress worker (transferred). */
  | { type: 'connect-compress'; id: number; port: MessagePort }
  /**
   * Trace worker, answered at once: the run is stopped or replaced, so a batch
   * waiting for room in the GPU compressor's ring goes on without the run's
   * factors, and none waits again.
   */
  | { type: 'release-compress'; id: number }
  /** Turn cell discovery on or off in the running pipeline. */
  | { type: 'set-discovery'; id: number; on: boolean }
  /** Return (or stop returning) the model residual preview in the running pipeline. */
  | { type: 'set-residual'; id: number; on: boolean }
  /**
   * Smooth playback (`lib/playback.ts`), answered at once: preview this view of every frame of the
   * batches from now on (null: the last frame only). Held across pipeline starts.
   */
  | { type: 'set-frame-preview'; id: number; view: FrameView | null }
  /** The port to the motion worker (transferred), sent once when the client is created. */
  | { type: 'link'; id: number; down: MessagePort }
  /**
   * Smooth pacing (`lib/frame-pacer.ts`), answered at once, not in the queue: `fps` sets the
   * target (0: unpaced; a recording's Discover run only), `paused` holds or resumes the gate
   * at the first stage so batches already requested are not released while paused.
   */
  | { type: 'pace'; id: number; fps?: number; paused?: boolean }
  /** The port to the flat-field worker (transferred; see `workers/flat-field-worker.ts`). */
  | { type: 'link-flat'; id: number; port: MessagePort };

/** A request before the client stamps it with an `id` (distributes over the union). */
export type FrameRequestBody = FrameRequest extends infer R
  ? R extends FrameRequest
    ? Omit<R, 'id'>
    : never
  : never;

/** Frame worker -> main thread. */
export type FrameResponse =
  | { type: 'opened'; id: number; info: FrameSourceInfo }
  /** One entry per probed session: its info, or why it could not be opened. */
  | { type: 'probed'; id: number; results: SessionProbeResult[] }
  | {
      type: 'frames';
      id: number;
      start: number;
      count: number;
      /** `count * width * height` samples; `Uint16Array` for 16-bit. Transferred, not copied. */
      pixels: FramePixels;
    }
  | { type: 'pipeline-ready'; id: number; plan: PipelinePlan }
  /** Buffers inside `step` are transferred, not copied. */
  | { type: 'pipeline-step'; id: number; step: PipelineStepResult }
  | { type: 'pipeline-stopped'; id: number }
  | { type: 'ok'; id: number }
  /** Unsolicited (`id` -1): the pace gate's readouts, about once a second while paced. */
  | { type: 'pace-stats'; id: number; stats: PaceStats }
  | { type: 'error'; id: number; message: string };
