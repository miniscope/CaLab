import type { FolderEntry, FrameSourceInfo, FramePixels } from '../lib/frame-source.ts';
import type { PipelineStepResult } from '../lib/pipeline-engine.ts';
import type { PipelineOptions, PipelinePlan } from '../lib/pipeline-plan.ts';
import type { FlatFieldMap } from '../lib/flat-field.ts';
import type { ReplayInput } from '../lib/pipeline-stages.ts';

/** Fast-loop settings of a pipeline run. */
export interface CellsSettings {
  /** Tags the run's messages to the slow worker and the main thread. */
  session: number;
  /** Run cell discovery (forward frames to the slow worker). */
  discover: boolean;
  /** Run online quality control on the traces (default on). */
  qc?: boolean;
  /**
   * A replay stage (Refine or Extract, see docs/stages.md): solve every frame
   * with this library (`TraceLibrary.toBytes()`). Without `refine` (Extract)
   * nothing goes to the slow loop.
   */
  library?: Uint8Array;
  /**
   * Refine (with `library`): feed the replayed frames to the slow loop of
   * this `session`, which keeps its state and may only refine footprints.
   */
  refine?: boolean;
  /** Batches in flight to the slow worker (default `FAST_LOOP_DEFAULTS.poolSize`). */
  forwardBuffers?: number;
  /** Feed the compress worker (default off; needs its port). */
  compress?: boolean;
  /** Return a residual preview with each batch (the residual view is shown). */
  residual?: boolean;
}

/** Main thread -> frame worker. `id` pairs a request with its response. */
export type FrameRequest =
  /** Entries carry their folder path as data: a File property would not survive structured clone. */
  | { type: 'open'; id: number; entries: FolderEntry[] }
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
      /** Pass 2: replay the recorded flicker and motion (pipelined workers only). */
      replay?: ReplayInput;
      /** Pass 1 flat field: a stored map of this sensor, in force from the first processed frame and seeding the estimator. */
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
  /**
   * `keepSlow`: keep the slow loop (Refine or Extract may follow; a Refine run
   * that is stopped publishes what it has) instead of dropping it.
   */
  | { type: 'pipeline-stop'; id: number; keepSlow?: boolean }
  /** The port to the slow worker (transferred). */
  | { type: 'connect-slow'; id: number; port: MessagePort }
  /** The port to the compress worker (transferred). */
  | { type: 'connect-compress'; id: number; port: MessagePort }
  /** Turn cell discovery on or off in the running pipeline. */
  | { type: 'set-discovery'; id: number; on: boolean }
  /** Return (or stop returning) the model residual preview in the running pipeline. */
  | { type: 'set-residual'; id: number; on: boolean }
  /** Pipelined run: the port to the motion worker (transferred). The frame worker then runs stage A only. */
  | { type: 'link'; id: number; down: MessagePort }
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
  | { type: 'error'; id: number; message: string };
