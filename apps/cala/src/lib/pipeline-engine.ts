/**
 * The streaming preprocess + motion pipeline over a frame source, driven one
 * step at a time (see `pipeline-plan.ts` for the phases).
 *
 * Runs wherever the cala WASM module is initialized: in the frame worker for
 * the app, in Node for `scripts/real-data-check.mjs` and the tests. Buffers
 * are sized to one batch and reused. The motion warm-up frames are pushed into
 * the corrector one batch at a time and held, band-passed, inside WASM until
 * the template is built.
 */
import {
  MotionCorrector,
  MotionOptions,
  PreprocessConfig,
  PreprocessWarmup,
  SessionAligner,
} from './cala-wasm.ts';
import type { Preprocessor } from './cala-wasm.ts';
import type { FlatFieldApplied } from './flat-field.ts';
import type { FovProjections } from './fov-projection.ts';
import { ImagingSampler, type ImagingStats } from './imaging-stats.ts';
import { sessionBoundaries, type FramePixels, type FrameSourceInfo } from './frame-source.ts';
import {
  boundariesInBatch,
  NO_SESSION_HOOKS,
  referenceSpan,
  sessionStart,
  type SessionHooks,
  type SessionStart,
  type SessionTransform,
} from './session-boundary.ts';
import {
  isUnbounded,
  makePlan,
  PipelineCursor,
  type PipelineOptions,
  type PipelinePhase,
  type PipelinePlan,
  type PipelineStep,
} from './pipeline-plan.ts';
import {
  downsampleFrame,
  previewFactor,
  takeResidualPreview,
  type PreviewImage,
} from './preview.ts';
import type { CellsBatch, FastLoop } from './fast-loop.ts';
import { qcTransferables } from './qc.ts';

/** What a fast loop is built from (see `PipelineEngine`'s `fastLoop` option). */
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

/** What the engine needs from a `FrameSource`. */
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
  /** Preprocessing: front half (hot pixels, flicker, flattening, lines) plus back half (background, noise). */
  preprocessMs: number;
  motionMs: number;
  /** Preview downsampling and bookkeeping. */
  otherMs: number;
  /** Fast loop: library swap, trace solve and the forward copy to the slow loop. */
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
}

/**
 * Where motion correction runs: `webgpu`, or WASM because it was turned off
 * (`?gpu=0`), WebGPU is unavailable (no adapter, or settings it cannot run),
 * or the GPU failed mid-run.
 */
export type MotionBackend = 'webgpu' | 'wasm-off' | 'wasm-unavailable' | 'wasm-failed';

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
      /** Busy wall time of each pipeline stage (A, B, C) for this batch, ms (pipelined runs only). */
      stageBusyMs?: number[];
      /** Where motion correction ran for this batch (pipelined runs only; absent = single-worker WASM). */
      motionBackend?: MotionBackend;
      /** Traces of the batch (present when the engine runs a fast loop). */
      cells?: CellsBatch;
      /** The live source's counters after this batch (live runs only). */
      live?: LiveBatchInfo;
      /** A flat-field map took effect at this batch (pipelined runs only). */
      flatField?: FlatFieldApplied;
      /** FOV noise σ and background, about once a second of stream (History view). */
      imaging?: ImagingStats;
      /** This batch started a session of a Joint run (session fix on): what was done. */
      session?: SessionStart;
    }
  | {
      kind: 'done';
      /** Mean and max projections of the run (Extract with `CellsSettings.projection`). */
      projection?: FovProjections;
    };

/** Transferable buffers of a step result (for `postMessage`). */
export function transferablesOf(r: PipelineStepResult): ArrayBuffer[] {
  if (r.kind === 'done')
    return (r.projection?.spans ?? []).flatMap((s) => [
      s.mean.buffer as ArrayBuffer,
      s.max.buffer as ArrayBuffer,
    ]);
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
    ...(r.cells ? [r.cells.ids, r.cells.traces] : []),
    ...(r.cells?.signed ? [r.cells.signed] : []),
  ]
    .map((a) => a.buffer as ArrayBuffer)
    .concat(r.cells?.qc ? qcTransferables(r.cells.qc) : []);
}

const now = (): number => performance.now();

/** Numbers per frame returned by `Preprocessor.frontFrames`; the last two are the flicker offset and gain. */
const FRONT_RECORD_STRIDE = 6;

/**
 * The single-worker pipeline: the `?pipeline=0` fallback and the tests (the app
 * runs the pipelined stages of `pipeline-stages.ts`).
 *
 * It has NO sensor flat field (`PipelineOptions.flatField` is ignored here):
 * the estimator needs each batch's raw frames together with the shifts motion
 * correction finds for them, and pushing them and running the solve inside
 * `step()` would put the estimator's cost (about 0.3 s a minute natively, more
 * in WASM) on the frame path. The pipelined path hands them to a worker.
 */
export class PipelineEngine {
  readonly plan: PipelinePlan;
  private readonly cursor: PipelineCursor;
  /** First frames of sessions 1.. of a multi-session recording (empty for one). */
  private readonly boundaries: number[];
  /** Called at each session boundary (see `session-boundary.ts`); does nothing by default. */
  sessionHooks: SessionHooks = NO_SESSION_HOOKS;
  private readonly width: number;
  private readonly height: number;
  private readonly px: number;
  private readonly sixteen: boolean;
  private readonly factor: number;

  private warmup: PreprocessWarmup | null = null;
  private pre: Preprocessor | null = null;
  /**
   * A second preprocessor with the same calibration that only feeds the motion
   * warm-up: the flicker stage keeps a running reference, so the warm-up must
   * not advance the one that processes the recording from frame 0.
   */
  private warmupPre: Preprocessor | null = null;
  private motion: MotionCorrector | null = null;
  /** Session re-registration (Joint runs with boundaries and the session fix on). */
  private aligner: SessionAligner | null = null;

  private raw: FramePixels;
  private front: Float32Array;
  private corrected: Float32Array;
  private fovMask: Uint8Array | null = null;
  private readonly imaging = new ImagingSampler(() => this.fovMask);
  private records: Float32Array | null = null;
  private disposed = false;

  private readonly reader: FrameReader;
  private fast: FastLoop | null = null;

  /**
   * `flickerMode` overrides the global flicker correction (0 off, 1 additive,
   * 2 multiplicative, 3 both; default both), e.g. to time it. `fastLoop`
   * builds the trace solver run on every corrected batch (none: no traces).
   */
  constructor(
    reader: FrameReader,
    options: PipelineOptions = {},
    flickerMode?: number,
    fastLoop?: (setup: FastLoopSetup) => FastLoop,
  ) {
    this.reader = reader;
    const { width, height, bitDepth, frameCount, fps } = reader.info;
    this.boundaries = sessionBoundaries(reader.info);
    this.plan = makePlan(frameCount, options, this.boundaries);
    this.cursor = new PipelineCursor(this.plan);
    this.width = width;
    this.height = height;
    this.px = width * height;
    this.sixteen = bitDepth === 16;
    this.factor = previewFactor(width, height, this.plan.previewMaxSide);

    const config = new PreprocessConfig(fps ?? 0);
    config.warmupFrames = this.plan.calibrationFrames;
    if (flickerMode !== undefined) config.flickerMode = flickerMode;
    try {
      this.warmup = new PreprocessWarmup(width, height, config);
      this.fast =
        fastLoop?.({
          width,
          height,
          batchSize: this.plan.batchSize,
          cellDiameterPx: config.cellDiameterPx,
          flattenSigmaPx: config.flattenSigmaPx,
          fps: fps ?? 0,
        }) ?? null;
    } finally {
      config.free();
    }
    // Read buffers sized for the larger of a read chunk and a batch.
    this.raw = this.sixteen ? new Uint16Array(0) : new Uint8Array(0);
    this.front = new Float32Array(0);
    this.corrected = new Float32Array(0);
  }

  /** End the recording at the current position (finish early): the next step reports `done`. */
  truncate(): void {
    this.cursor.truncate();
  }

  /** The fast loop, when the engine runs one. */
  get fastLoop(): FastLoop | null {
    return this.fast;
  }

  get frameCount(): number {
    return this.plan.frameCount;
  }

  /** Run the next step. After the last batch, returns `{ kind: 'done' }`. */
  async step(): Promise<PipelineStepResult> {
    if (this.disposed) throw new Error('The pipeline was stopped.');
    const s = await nextStep(this.cursor, this.reader);
    if (!s) {
      this.fast?.end();
      return { kind: 'done' };
    }

    const t0 = now();
    const raw = await this.readRaw(s.start, s.count);
    const t1 = now();
    const timings: StageTimings = {
      readMs: t1 - t0,
      preprocessMs: 0,
      motionMs: 0,
      otherMs: 0,
      traceMs: 0,
    };

    if (s.phase === 'calibrate') {
      const w = this.warmup!;
      if (this.sixteen) w.pushFrames16(raw as Uint16Array, s.count);
      else w.pushFrames(raw as Uint8Array, s.count);
      if (s.last) this.finishCalibration();
      timings.preprocessMs = now() - t1;
      return {
        kind: 'setup',
        phase: s.phase,
        done: s.start + s.count,
        total: this.plan.calibrationFrames,
        timings,
      };
    }

    const pre = this.pre!;
    if (s.phase === 'motion-warmup') {
      const motion = this.motion!;
      if (s.start === 0) motion.warmupBegin();
      const front = this.grow('front', s.count * this.px);
      this.runFront(this.warmupPre ?? pre, raw, s.count, front);
      const t2 = now();
      timings.preprocessMs = t2 - t1;
      motion.warmupPushF32(front);
      if (s.last) {
        motion.warmupFinish();
        this.warmupPre?.free();
        this.warmupPre = null;
      }
      timings.motionMs = now() - t2;
      return {
        kind: 'setup',
        phase: s.phase,
        done: s.start + s.count,
        total: this.plan.motionWarmupFrames,
        timings,
      };
    }

    // process
    const bs = boundariesInBatch(this.plan.boundaries, s.start, s.count);
    for (const b of bs) this.sessionHooks.onSessionBoundary(b.index, b.frame);
    // The same steps as stages A, B and C of `pipeline-stages.ts`, in order.
    const session = this.aligner ? bs.find((b) => b.frame === s.start) : undefined;
    if (session) pre.beginSessionFront();
    const n = s.count * this.px;
    const front = this.grow('front', n);
    const corrected = this.grow('corrected', n);
    const motion = this.motion!;
    const len = motion.recordLen;
    if (!this.records || this.records.length < s.count * len)
      this.records = new Float32Array(this.plan.batchSize * len);
    const records = this.records.subarray(0, s.count * len);

    const frontRec = this.runFront(pre, raw, s.count, front);
    const t2 = now();
    let sessionAlign: number[] | undefined;
    let sessionTransform: SessionTransform | undefined;
    const aligner = this.aligner;
    if (aligner) {
      if (session) sessionAlign = Array.from(aligner.beginSession(front, this.fovMask!));
      if (!aligner.isIdentity) {
        aligner.warpF32(front);
        const t = aligner.transform();
        sessionTransform = [t[0], t[1], t[2]];
      }
    }
    motion.processF32(front, corrected, records);
    const ref = aligner ? referenceSpan(this.plan.boundaries, s.start, s.count) : null;
    if (ref) aligner!.pushReference(corrected.subarray(ref.from * this.px, ref.to * this.px));
    const t3 = now();
    const last = s.count - 1;
    const before = downsampleFrame(corrected, last, this.width, this.height, this.factor);
    const dy = new Float32Array(s.count);
    const dx = new Float32Array(s.count);
    for (let i = 0; i < s.count; i++) {
      dy[i] = records[i * len];
      dx[i] = records[i * len + 1];
    }
    const t4 = now();
    let sessionStarted: SessionStart | undefined;
    if (session) {
      const t = sessionTransform ?? [0, 0, 0];
      if (sessionTransform) pre.setSourceMask(aligner!.sourceMask(this.fovMask!));
      else pre.setSourceMask(new Uint8Array(0));
      const fit = pre.beginSessionBack(corrected, s.count, dy, dx, true, true);
      sessionStarted = sessionStart({ session, ...(sessionAlign ? { sessionAlign } : {}) }, t, fit);
    }
    // Pixels the shift moved in from outside the FOV mask are missing data.
    pre.backFramesRegistered(corrected, s.count, dy, dx);
    const t5 = now();
    const cells = this.fast?.process(corrected, s.start, s.count, pre, { dy, dx });
    const imaging = this.imaging.sample(pre, s.start, s.count);
    const t5b = now();

    const quality = new Float32Array(s.count);
    const flags = new Uint32Array(s.count);
    const flickerOffset = new Float32Array(s.count);
    const flickerGain = new Float32Array(s.count);
    for (let i = 0; i < s.count; i++) {
      flickerOffset[i] = frontRec[i * FRONT_RECORD_STRIDE + 4];
      flickerGain[i] = frontRec[i * FRONT_RECORD_STRIDE + 5];
      quality[i] = records[i * len + 2];
      flags[i] = records[i * len + 3];
    }
    const previews: BatchPreviews = {
      frame: s.start + last,
      raw: downsampleFrame(raw, last, this.width, this.height, this.factor),
      preprocessed: downsampleFrame(front, last, this.width, this.height, this.factor),
      corrected: before,
      output: downsampleFrame(corrected, last, this.width, this.height, this.factor),
    };
    const residual = takeResidualPreview(cells, this.width, this.height, this.factor);
    if (residual) previews.residual = residual;
    const t6 = now();
    timings.preprocessMs = t2 - t1 + (t5 - t4);
    timings.motionMs = t3 - t2;
    timings.traceMs = t5b - t5;
    timings.otherMs = t4 - t3 + (t6 - t5b);
    const live = this.reader.liveInfo?.();
    return {
      kind: 'batch',
      start: s.start,
      count: s.count,
      dy,
      dx,
      quality,
      flags,
      flickerOffset,
      flickerGain,
      previews,
      timings,
      ...(cells ? { cells } : {}),
      ...(live ? { live } : {}),
      ...(imaging ? { imaging } : {}),
      ...(sessionStarted ? { session: sessionStarted } : {}),
    };
  }

  /** Release the WASM objects. The engine is unusable afterwards. */
  dispose(): void {
    this.disposed = true;
    this.fast?.dispose();
    this.fast = null;
    this.warmup?.free();
    this.pre?.free();
    this.warmupPre?.free();
    this.motion?.free();
    this.aligner?.free();
    this.warmup = this.pre = this.warmupPre = this.motion = this.aligner = null;
  }

  private finishCalibration(): void {
    const pre = this.warmup!.finish();
    this.warmupPre = this.warmup!.finish();
    this.warmup!.free();
    this.warmup = null;
    this.pre = pre;
    const opts = new MotionOptions();
    try {
      this.motion = new MotionCorrector(this.width, this.height, opts);
    } finally {
      opts.free();
    }
    this.fovMask = pre.fovMask();
    this.motion.setFovMask(this.fovMask);
    if (this.plan.sessionFix && this.plan.boundaries.length > 0)
      this.aligner = new SessionAligner(this.width, this.height);
  }

  private runFront(
    pre: Preprocessor,
    raw: FramePixels,
    count: number,
    out: Float32Array,
  ): Float64Array {
    if (this.sixteen) return pre.frontFrames16(raw as Uint16Array, count, out);
    return pre.frontFrames(raw as Uint8Array, count, out);
  }

  private async readRaw(start: number, count: number): Promise<FramePixels> {
    const n = count * this.px;
    if (this.raw.length < n) this.raw = this.sixteen ? new Uint16Array(n) : new Uint8Array(n);
    return this.reader.readFrames(start, count, this.raw.subarray(0, n));
  }

  private grow(which: 'front' | 'corrected', n: number): Float32Array {
    if (this[which].length < n) this[which] = new Float32Array(this.plan.batchSize * this.px);
    return this[which].subarray(0, n);
  }
}
