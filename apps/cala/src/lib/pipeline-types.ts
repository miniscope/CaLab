/**
 * Types shared by the pipeline stages (`pipeline-stages.ts`), their workers and
 * the stores that consume step results, plus `nextStep` and `transferablesOf`.
 */
import type { FlatFieldApplied } from './flat-field.ts';
import type { FovProjections } from './fov-projection.ts';
import type { ImagingStats } from './imaging-stats.ts';
import type { FramePixels, FrameSourceInfo } from './frame-source.ts';
import type { SessionStart } from './session-boundary.ts';
import {
  isUnbounded,
  PipelineCursor,
  type PipelinePhase,
  type PipelineStep,
} from './pipeline-plan.ts';
import type { FramePreviews, FrameView, PreviewImage } from './preview.ts';
import type { CellsBatch } from './fast-loop.ts';
import { qcTransferables } from './qc.ts';

/** What a fast loop is built from (`FrontStage.fastSetup`). */
export interface FastLoopSetup {
  width: number;
  height: number;
  batchSize: number;
  /** The preprocessing's flattening settings (the slow loop must match them). */
  cellDiameterPx: number;
  flattenSigmaPx: number;
  /** Frame rate of the recording (0 when unknown). */
  fps: number;
}

/** A live source's view of the batch just read (see `lib/live-source.ts`). */
export interface LiveBatchInfo {
  /** Frames received from the acquisition side so far. */
  received: number;
  /** Frames received but dropped here (queue full, out of order). */
  dropped: number;
  /** Frames the acquisition side never delivered. */
  missed: number;
  /** Frames received and not yet read by the pipeline. */
  queued: number;
  /** Wall time from the arrival of the batch's last frame to the end of its read, ms. */
  lagMs: number;
}

/** What the pipeline needs from a `FrameSource`. */
export interface FrameReader {
  readonly info: Pick<
    FrameSourceInfo,
    'width' | 'height' | 'bitDepth' | 'frameCount' | 'fps' | 'sessions'
  >;
  readFrames(start: number, count: number, out?: FramePixels): Promise<FramePixels>;
  /**
   * Live source: resolves once frames below `end` can be read, with
   * `UNBOUNDED`, or with the stream's final frame count once it has ended.
   */
  waitFor?(end: number): Promise<number>;
  /** Live source: stats of the batch just read. */
  liveInfo?(): LiveBatchInfo;
}

/**
 * The cursor's next step. On an unbounded plan the reader is asked to wait
 * for the step's frames first; when the stream ended before them, the plan
 * is bounded to the frames it has and the step shrinks or goes away.
 */
export async function nextStep(
  cursor: PipelineCursor,
  reader: FrameReader,
): Promise<PipelineStep | null> {
  if (!reader.waitFor || !isUnbounded(cursor.plan)) return cursor.next();
  const peek = cursor.peek();
  if (!peek) return null;
  const total = await reader.waitFor(peek.start + peek.count);
  if (Number.isFinite(total)) cursor.limit(total);
  return cursor.next();
}

/** Wall time per stage for one step, ms. */
export interface StageTimings {
  readMs: number;
  /** Stage A: the front half of preprocessing (with the flat-field apply). */
  preprocessMs: number;
  motionMs: number;
  /** Preview downsampling and bookkeeping. */
  otherMs: number;
  /** Stage C: the back half of preprocessing and the fast loop (one fused call when there is a library). */
  traceMs: number;
}

/** The previews of one batch, all of its last frame. */
export interface BatchPreviews {
  /** Index of the frame shown. */
  frame: number;
  raw: PreviewImage;
  /** After hot pixels, flicker, glow flattening and line removal, before motion. */
  preprocessed: PreviewImage;
  /** After motion correction (same intensity domain as `preprocessed`). */
  corrected: PreviewImage;
  /** Final output: motion-corrected with the background floor removed. */
  output: PreviewImage;
  /** What the cell model leaves unexplained in `output` (only while asked for; see `FastLoop.setResidual`). */
  residual?: PreviewImage;
  /**
   * One view of every frame of the batch, when smooth playback asked for it
   * (display only; the four images above stay the last frame's).
   */
  frames?: FramePreviews;
  /**
   * Set by the store while it plays `frames`: the batch's own last-frame image of the played view
   * (the view's image above is then the frame being shown). The display range is fitted from this.
   */
  fit?: Partial<Record<FrameView, PreviewImage>>;
}

/**
 * Where motion correction runs: `webgpu`, or WASM because it was turned off
 * (`?gpu=0`), WebGPU is unavailable (no adapter, or settings it cannot run),
 * or the GPU failed mid-run.
 */
export type MotionBackend = 'webgpu' | 'wasm-off' | 'wasm-unavailable' | 'wasm-failed';

/** What one pipeline step yields: setup progress, a processed batch, or the end of the run. */
export type PipelineStepResult =
  | {
      kind: 'setup';
      phase: Exclude<PipelinePhase, 'process'>;
      /** Frames of this phase done so far, and its total. */
      done: number;
      total: number;
      timings: StageTimings;
    }
  | {
      kind: 'batch';
      start: number;
      count: number;
      /** Rigid registering shift per frame, px. */
      dy: Float32Array;
      dx: Float32Array;
      /** Correlation peak quality per frame. */
      quality: Float32Array;
      /** `FLAG_*` bits of the motion record per frame. */
      flags: Uint32Array;
      /** Global flicker removed per frame: additive offset `a_t` (grey levels). */
      flickerOffset: Float32Array;
      /** ... and relative gain `m_t` (the frame was scaled by `1 + m_t`). */
      flickerGain: Float32Array;
      previews: BatchPreviews;
      timings: StageTimings;
      /** Busy wall time of each pipeline stage (A, B, C) for this batch, ms. */
      stageBusyMs?: number[];
      /** Where motion correction ran for this batch. */
      motionBackend?: MotionBackend;
      /** Traces of the batch (present when stage C runs a fast loop). */
      cells?: CellsBatch;
      /** The live source's counters after this batch (live runs only). */
      live?: LiveBatchInfo;
      /** A flat-field map took effect at this batch. */
      flatField?: FlatFieldApplied;
      /** FOV noise σ and background, about once a second of stream (History view). */
      imaging?: ImagingStats;
      /** This batch started a session of a Joint run (session fix on): what was done. */
      session?: SessionStart;
      /**
       * Discover of a Joint run: a within-session sample of the boundary
       * correlation's null, completed with this batch (`boundary-flags.ts`).
       */
      boundaryNull?: number;
      /** Look-back runs: the back half's state after this batch, now and then (`BackStage`). */
      backState?: BackStateSnapshot;
    }
  | {
      kind: 'done';
      /** Mean and max projections of the run (Extract with `CellsSettings.projection`). */
      projection?: FovProjections;
      /** Look-back runs: the back half's state after the last batch. */
      backState?: BackStateSnapshot;
    };

/** `Preprocessor.state()` of the live back half (stage C) after stream frame `frame`. */
export interface BackStateSnapshot {
  frame: number;
  state: Uint8Array;
}

/** Transferable buffers of a step result (for `postMessage`). */
export function transferablesOf(r: PipelineStepResult): ArrayBuffer[] {
  if (r.kind === 'done')
    return (r.projection?.spans ?? [])
      .flatMap((s) => [s.mean.buffer as ArrayBuffer, s.max.buffer as ArrayBuffer])
      .concat(r.backState ? [r.backState.state.buffer as ArrayBuffer] : []);
  if (r.kind !== 'batch') return [];
  const p = r.previews;
  return [
    r.dy,
    r.dx,
    r.quality,
    r.flags,
    r.flickerOffset,
    r.flickerGain,
    p.raw.data,
    p.preprocessed.data,
    p.corrected.data,
    p.output.data,
    ...(p.frames ? [p.frames.data] : []),
    ...(r.cells ? [r.cells.ids, r.cells.traces] : []),
    ...(r.cells?.signed ? [r.cells.signed] : []),
    ...(r.backState ? [r.backState.state] : []),
  ]
    .map((a) => a.buffer as ArrayBuffer)
    .concat(r.cells?.qc ? qcTransferables(r.cells.qc) : []);
}
