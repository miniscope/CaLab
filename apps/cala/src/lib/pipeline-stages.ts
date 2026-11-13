/**
 * The per-frame pipeline cut into three stages that can run in three workers,
 * so batch N+1's decode + preprocessing overlaps batch N's motion correction
 * and batch N-1's trace solve:
 *
 *   FrontStage (A)  read, calibration, motion warm-up front half, preprocess front half,
 *                   flat-field apply (the estimator itself runs in a worker of its own)
 *   MotionStage (B) the motion corrector (template, warm-up, per-batch registration)
 *   BackStage (C)   preprocess back half (background, noise), fast loop (traces, slow feed)
 *
 * The stage order and every call are those of `PipelineEngine.step`, so the
 * results are bit-identical to the single-worker path (the test runs both).
 * Each piece of state lives in exactly one stage: the flicker reference in A,
 * the motion template in B, the background and noise map, the trace engine
 * and the library swaps in C. A and C hold separate `Preprocessor` objects,
 * which is safe because the front half only advances the flicker reference and
 * the back half everything else; C starts from A's calibrated state.
 *
 * Stages talk through `StageJob`s. Workers move them over `MessageChannel`s
 * (buffers transferred, a small credit-based pool per link); the stages
 * themselves are transport-free, so Node tests chain them directly.
 */
import {
  MotionCorrector,
  MotionOptions,
  Preprocessor,
  PreprocessConfig,
  PreprocessWarmup,
  SessionAligner,
} from './cala-wasm.ts';
import type { FastLoop } from './fast-loop.ts';
import { type FlatFieldApplied, type FlatFieldMap, type FlatFieldSource } from './flat-field.ts';
import type { FlatFieldSink } from './flat-field-runner.ts';
import { sessionBoundaries, type FramePixels } from './frame-source.ts';
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
  nextStep,
  type BatchPreviews,
  type FastLoopSetup,
  type FrameReader,
  type LiveBatchInfo,
  type MotionBackend,
  type PipelineStepResult,
  type StageTimings,
} from './pipeline-engine.ts';
import {
  makePlan,
  PipelineCursor,
  type PipelineOptions,
  type PipelinePlan,
  type PipelineStep,
} from './pipeline-plan.ts';
import { GpuMotion } from './gpu-motion.ts';
import {
  downsampleFrame,
  previewFactor,
  takeResidualPreview,
  type PreviewImage,
} from './preview.ts';
import { ImagingSampler } from './imaging-stats.ts';
import type { RunSpan } from './run-record.ts';

const now = (): number => performance.now();

/** Numbers per frame returned by `Preprocessor.frontFrames`; the last two are the flicker offset and gain. */
const FRONT_RECORD_STRIDE = 6;

/** Calibration A hands to B and C when its calibration phase ends. */
export interface StageCalibration {
  /** FOV mask: B registers inside it. */
  fovMask: Uint8Array;
  /** `Preprocessor.state()` at frame 0: C rebuilds its own back half from it. */
  preState: Uint8Array;
}

/** One pipeline step on its way through the stages. */
export interface StageJob {
  step: PipelineStep;
  /** Frames of the step's phase in total (setup progress). */
  total: number;
  calib?: StageCalibration;
  /** Pooled buffer from A (motion-warm-up and process steps): preprocessed, sensor coordinates. */
  front?: Float32Array;
  flickerOffset?: Float32Array;
  flickerGain?: Float32Array;
  raw?: PreviewImage;
  preprocessed?: PreviewImage;
  /** Pooled buffer from B (process steps): registered frames. */
  corrected?: Float32Array;
  dy?: Float32Array;
  dx?: Float32Array;
  quality?: Float32Array;
  flags?: Uint32Array;
  /** Preview of the last registered frame, before the back half. */
  before?: PreviewImage;
  /** Wall time per stage so far (the sums C reports are those of `PipelineEngine`). */
  timings: StageTimings;
  /** Busy wall time of each stage (A, B, C) for this step, ms. */
  busyMs: number[];
  /** Where stage B ran motion correction (set on process steps). */
  motionBackend?: MotionBackend;
  /** The live source's counters after this batch (live runs only). */
  live?: LiveBatchInfo;
  /** A flat-field map that took effect at this batch (process steps; see `FrontStage`). */
  flatField?: FlatFieldApplied;
  /** This batch starts session `index` (1-based) of a Joint run, with the session fix on. */
  session?: { index: number; frame: number };
  /** Replay: the session's recorded re-registration transform (set by A on the session's first batch). */
  sessionReplay?: SessionTransform;
  /** The session warp B applied to this batch's frames (absent: identity). */
  sessionTransform?: SessionTransform;
  /** B's estimate on the session's first batch: `SessionAligner.beginSession`'s values. */
  sessionAlign?: number[];
}

/** Buffers a job carries, for `postMessage` (the pooled `front` / `corrected` included). */
export function jobTransferables(job: StageJob): ArrayBuffer[] {
  const arrays: (ArrayBufferView | undefined)[] = [
    job.front,
    job.corrected,
    job.flickerOffset,
    job.flickerGain,
    job.raw?.data,
    job.preprocessed?.data,
    job.dy,
    job.dx,
    job.quality,
    job.flags,
    job.before?.data,
    job.calib?.fovMask,
    job.calib?.preState,
  ];
  return arrays.filter((a) => a !== undefined).map((a) => a.buffer as ArrayBuffer);
}

/**
 * Pass 2: what pass 1 recorded about frames `[0, frameCount)`, so the stages
 * replay them instead of estimating (see `FrontStage` and `MotionStage`).
 */
export interface ReplayInput extends RunSpan {
  /** Frames to replay (the recorded ones, which may be fewer than the recording has). */
  frameCount: number;
  /**
   * The latest flat-field map of pass 1: the whole recording is corrected with
   * it from frame 0 (no estimation in pass 2). Absent: no flat field.
   */
  flatField?: FlatFieldMap;
}

/**
 * The flat field of one run. Pass 1: `sink` receives the raw batches (with
 * their shifts) for estimation; `initial` is a stored map in force from the
 * first processed frame (also the estimator's seed). Pass 2 takes its map from
 * `ReplayInput.flatField` instead.
 */
export interface FlatFieldRun {
  sink?: FlatFieldSink;
  initial?: FlatFieldMap;
  /** Tags the estimator run (echoed by its answers). */
  session?: number;
}

/** A batch whose raw frames wait for the shifts stage B is still finding. */
interface PendingRaw {
  raw: FramePixels;
  count: number;
}

/** Raw batches held for the estimator at most (the pipeline has ~4 batches in flight). */
const MAX_PENDING_RAW = 8;

/** What a stage needs to know about the recording and the plan. */
export interface StageSetup {
  width: number;
  height: number;
  plan: PipelinePlan;
  /** Pass 2: motion shifts come with the jobs and are applied, not estimated. */
  replay?: boolean;
}

/** Stage A: read, calibrate, and run the preprocessing front half. */
export class FrontStage {
  readonly plan: PipelinePlan;
  /** What the fast loop in stage C is built from. */
  readonly fastSetup: FastLoopSetup;
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
  /** Feeds the motion warm-up so the flicker reference of `pre` starts at frame 0. */
  private warmupPre: Preprocessor | null = null;
  private raw: FramePixels;
  /** Flat field: off, or a stored map and/or an estimator sink (see `FlatFieldRun`). */
  private readonly flatOn: boolean;
  private readonly flatSink: FlatFieldSink | undefined;
  private readonly flatInitial: FlatFieldMap | null;
  /** Raw batches by start, held (copied) until stage B's shifts for them arrive. */
  private readonly pendingRaw = new Map<number, PendingRaw>();
  /** The newest map from the estimator, applied at the next batch boundary. */
  private offered: { seq: number; map: FlatFieldMap } | null = null;
  /** A map in force from the first processed frame, reported with that batch. */
  private initialEvent: FlatFieldApplied | null = null;
  private flatApplied = false;

  /**
   * `acquireFront` hands out a buffer of `plan.batchSize * width * height`
   * floats (waiting while stage B holds all of them: the backpressure).
   */
  constructor(
    private readonly reader: FrameReader,
    options: PipelineOptions,
    private readonly acquireFront: () => Promise<Float32Array>,
    flickerMode?: number,
    /** Pass 2: replay the recorded flicker and motion over the first `replay.frameCount` frames. */
    private readonly replay?: ReplayInput,
    /** Pass 1: the sensor flat field (estimator sink, stored map). Pass 2 uses `replay.flatField`. */
    private readonly flat?: FlatFieldRun,
  ) {
    const { width, height, bitDepth, frameCount: recorded, fps } = reader.info;
    const frameCount = replay ? replay.frameCount : recorded;
    if (replay && (replay.frameCount < 1 || replay.frameCount > recorded))
      throw new RangeError(
        `The replay (Refine, Extract) covers ${replay.frameCount} frames of a recording of ${recorded}.`,
      );
    for (const k of ['dy', 'dx', 'flags', 'flickerOffset', 'flickerGain'] as const)
      if (replay && replay[k].length < replay.frameCount)
        throw new RangeError(`Replay: the recorded ${k} has fewer values than frames.`);
    this.flatOn = options.flatField !== false;
    this.flatSink = this.flatOn && !replay ? flat?.sink : undefined;
    this.flatInitial = this.flatOn ? ((replay ? replay.flatField : flat?.initial) ?? null) : null;
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
      this.fastSetup = {
        width,
        height,
        batchSize: this.plan.batchSize,
        cellDiameterPx: config.cellDiameterPx,
        flattenSigmaPx: config.flattenSigmaPx,
        fps: fps ?? 0,
      };
    } finally {
      config.free();
    }
    this.raw = this.sixteen ? new Uint16Array(0) : new Uint8Array(0);
  }

  /** End the recording here: `next()` returns `null` from now on (pass 1 finished early). */
  truncate(): void {
    this.cursor.truncate();
  }

  get setup(): StageSetup {
    return {
      width: this.width,
      height: this.height,
      plan: this.plan,
      ...(this.replay ? { replay: true } : {}),
    };
  }

  /** The next job, or `null` once every frame has been through. */
  async next(): Promise<StageJob | null> {
    const s = await nextStep(this.cursor, this.reader);
    if (!s) return null;
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
      let calib: StageCalibration | undefined;
      if (s.last) calib = this.finishCalibration();
      const t2 = now();
      timings.preprocessMs = t2 - t1;
      return {
        step: s,
        total: this.plan.calibrationFrames,
        ...(calib ? { calib } : {}),
        timings,
        busyMs: [t2 - t0, 0, 0],
      };
    }

    // Waiting for a free buffer is backpressure, not work: it is not timed.
    const front = await this.acquireFront();
    const t1b = now();
    const frontView = front.subarray(0, s.count * this.px);
    if (s.phase === 'motion-warmup') {
      this.runFront(this.warmupPre ?? this.pre!, raw, s.count, frontView);
      if (s.last) {
        this.warmupPre?.free();
        this.warmupPre = null;
      }
      const t2 = now();
      timings.preprocessMs = t2 - t1b;
      return {
        step: s,
        total: this.plan.motionWarmupFrames,
        front,
        timings,
        busyMs: [t2 - t0 - (t1b - t1), 0, 0],
      };
    }

    const bs = boundariesInBatch(this.plan.boundaries, s.start, s.count);
    for (const b of bs) this.sessionHooks.onSessionBoundary(b.index, b.frame);
    // The plan starts every session with a batch (see `PipelinePlan.boundaries`).
    const session = this.plan.sessionFix ? bs.find((b) => b.frame === s.start) : undefined;
    const rp = this.replay;
    // A replay applies the recorded flicker; pass 1 re-seats the reference on the new session.
    if (session && !rp) this.pre!.beginSessionFront();
    const sessionReplay = session && rp ? rp.sessionTransforms?.[session.index] : undefined;
    // A new flat-field map takes effect here, between batches, never mid-batch.
    const flatField = this.takeFlatField(s.start);
    const frontRec = rp
      ? this.runFrontReplay(this.pre!, raw, s.count, frontView, s.start)
      : this.runFront(this.pre!, raw, s.count, frontView);
    const t2 = now();
    const last = s.count - 1;
    const flickerOffset = new Float32Array(s.count);
    const flickerGain = new Float32Array(s.count);
    for (let i = 0; i < s.count; i++) {
      flickerOffset[i] = frontRec[i * FRONT_RECORD_STRIDE + 4];
      flickerGain[i] = frontRec[i * FRONT_RECORD_STRIDE + 5];
    }
    // Pass 2: the recorded shifts travel with the job (copies: the job's buffers are transferred).
    const shifts = rp
      ? {
          dy: rp.dy.slice(s.start, s.start + s.count),
          dx: rp.dx.slice(s.start, s.start + s.count),
          flags: Uint32Array.from(rp.flags.subarray(s.start, s.start + s.count)),
        }
      : {};
    // The estimator needs the raw frames with the shifts stage B will find: keep one copy
    // (a memcpy) until they come back, unless the estimator has fallen behind.
    if (this.flatSink && this.flatSink.ready()) {
      if (this.pendingRaw.size >= MAX_PENDING_RAW) {
        const oldest = this.pendingRaw.keys().next().value;
        if (oldest !== undefined) this.pendingRaw.delete(oldest);
      }
      this.pendingRaw.set(s.start, { raw: raw.slice(0, s.count * this.px), count: s.count });
    }
    const rawPreview = downsampleFrame(raw, last, this.width, this.height, this.factor);
    const preprocessed = downsampleFrame(frontView, last, this.width, this.height, this.factor);
    const t3 = now();
    timings.preprocessMs = t2 - t1b;
    timings.otherMs = t3 - t2;
    const live = this.reader.liveInfo?.();
    return {
      step: s,
      total: this.plan.frameCount,
      front,
      flickerOffset,
      flickerGain,
      ...shifts,
      raw: rawPreview,
      preprocessed,
      timings,
      busyMs: [t3 - t0 - (t1b - t1), 0, 0],
      ...(live ? { live } : {}),
      ...(flatField ? { flatField } : {}),
      ...(session ? { session } : {}),
      ...(sessionReplay ? { sessionReplay: [...sessionReplay] as SessionTransform } : {}),
    };
  }

  /**
   * Stage B found the rigid shifts of the batch that starts at `start`: hand
   * the batch's raw frames and the shifts to the estimator. Dropped (never
   * waited for) when the estimator's queue is full. `session`: the session
   * warp B applied first; its translation is part of each frame's shift
   * (the estimator maps raw frames to tissue by shifts), and a session with
   * a rotation is not fed to the estimator at all (the sensor map from the
   * frames before stays in force).
   */
  onShifts(start: number, dy: Float32Array, dx: Float32Array, session?: SessionTransform): void {
    const pending = this.pendingRaw.get(start);
    if (!pending) return;
    this.pendingRaw.delete(start);
    const sink = this.flatSink;
    if (!sink || !sink.ready()) return;
    if (session && session[0] !== 0) return;
    if (session) {
      dy = dy.map((v) => v + session[1]);
      dx = dx.map((v) => v + session[2]);
    }
    sink.push({
      session: this.flat?.session ?? 0,
      start,
      count: pending.count,
      raw: pending.raw,
      dy,
      dx,
    });
  }

  /** The estimator produced a map: it is applied at the next batch boundary (the newest wins). */
  offerFlatField(seq: number, map: FlatFieldMap): void {
    if (this.flatOn && !this.replay && this.pre) this.offered = { seq, map };
  }

  private takeFlatField(start: number): FlatFieldApplied | undefined {
    const initial = this.initialEvent;
    if (initial) {
      this.initialEvent = null;
      return { ...initial, frame: start };
    }
    const o = this.offered;
    if (!o) return undefined;
    this.offered = null;
    this.setFlatField(this.pre!, o.map);
    const first = !this.flatApplied;
    this.flatApplied = true;
    return { frame: start, seq: o.seq, source: 'estimate', first };
  }

  private setFlatField(pre: Preprocessor, map: FlatFieldMap): void {
    pre.setFlatField(map.gain, map.offset.length > 0 ? map.offset : undefined, map.dark);
  }

  dispose(): void {
    this.flatSink?.stop();
    this.pendingRaw.clear();
    this.offered = null;
    this.warmup?.free();
    this.pre?.free();
    this.warmupPre?.free();
    this.warmup = this.pre = this.warmupPre = null;
  }

  private finishCalibration(): StageCalibration {
    const pre = this.warmup!.finish();
    this.warmupPre = this.warmup!.finish();
    this.warmup!.free();
    this.warmup = null;
    this.pre = pre;
    // A stored (or, in pass 2, the final) map is in force from the first processed frame:
    // on the motion warm-up's front half too, so the template is built from corrected frames.
    const initial = this.flatInitial;
    if (initial) {
      this.setFlatField(pre, initial);
      this.setFlatField(this.warmupPre, initial);
      this.flatApplied = true;
      const source: FlatFieldSource = this.replay ? 'replay' : 'cache';
      this.initialEvent = { frame: 0, seq: 0, source, first: true };
    }
    this.flatSink?.start({
      session: this.flat?.session ?? 0,
      width: this.width,
      height: this.height,
      fovMask: pre.fovMask(),
      fps: this.fastSetup.fps,
      sixteen: this.sixteen,
      ...(this.flat?.initial ? { seed: this.flat.initial } : {}),
    });
    return { fovMask: pre.fovMask(), preState: pre.state() };
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

  /** `runFront` with the flicker recorded for frames from `start` (no estimate, no state). */
  private runFrontReplay(
    pre: Preprocessor,
    raw: FramePixels,
    count: number,
    out: Float32Array,
    start: number,
  ): Float64Array {
    const rp = this.replay!;
    const offset = rp.flickerOffset.subarray(start, start + count);
    const gain = rp.flickerGain.subarray(start, start + count);
    if (this.sixteen) return pre.frontFramesReplay16(raw as Uint16Array, count, offset, gain, out);
    return pre.frontFramesReplay(raw as Uint8Array, count, offset, gain, out);
  }

  private async readRaw(start: number, count: number): Promise<FramePixels> {
    const n = count * this.px;
    if (this.raw.length < n) this.raw = this.sixteen ? new Uint16Array(n) : new Uint8Array(n);
    return this.reader.readFrames(start, count, this.raw.subarray(0, n));
  }
}

/** What `MotionStage.handleStaged` returns: the stage is free again, the job completes later. */
export interface StagedJob {
  /** Resolves with the finished job (corrected frames filled in). */
  finish: Promise<StageJob>;
}

/** Stage B: the motion corrector. */
export class MotionStage {
  private motion: MotionCorrector | null = null;
  private records: Float32Array | null = null;
  private readonly px: number;
  private readonly factor: number;
  private gpu: GpuMotion | null = null;
  private gpuReady = false;
  private gpuFailed = false;
  private filtered: Float32Array | null = null;
  /** Session re-registration (Joint runs with boundaries and the session fix on). */
  private aligner: SessionAligner | null = null;
  private fovMask: Uint8Array | null = null;

  /**
   * `acquireOut` hands out a buffer of `batchSize * width * height` floats (waits while C holds them all).
   * `gpuMotion`: use WebGPU for the prefilter and warp when available (falls back to WASM).
   */
  constructor(
    private readonly setup: StageSetup,
    private readonly acquireOut: () => Promise<Float32Array>,
    private readonly gpuMotion = false,
  ) {
    this.px = setup.width * setup.height;
    this.factor = previewFactor(setup.width, setup.height, setup.plan.previewMaxSide);
  }

  /** True when the process steps run on the GPU (after the first one has started). */
  get usingGpu(): boolean {
    return this.gpuReady;
  }

  /** Where the process steps run (meaningful once the first one has started). */
  get motionBackend(): MotionBackend {
    if (this.gpuReady) return 'webgpu';
    if (!this.gpuMotion) return 'wasm-off';
    return this.gpuFailed ? 'wasm-failed' : 'wasm-unavailable';
  }

  /** Run the job's motion step to completion (in place on the job). The `front` buffer is free afterwards. */
  async handle(job: StageJob): Promise<StageJob> {
    const staged = await this.handleStaged(job);
    return staged.finish;
  }

  /**
   * Run the step up to the point where the next job may start: on the GPU
   * path that is after the shifts are estimated and the warp is queued (the
   * `front` buffer is free then); the warp readback finishes in `finish`.
   * On the CPU path `finish` is already resolved.
   */
  async handleStaged(job: StageJob): Promise<StagedJob> {
    if (job.calib) await this.initMotion(job.calib.fovMask);
    const s = job.step;
    if (s.phase === 'calibrate') return { finish: Promise.resolve(job) };
    const motion = this.motion;
    if (!motion) throw new Error('The motion stage was not calibrated.');
    const n = s.count * this.px;
    const front = job.front!.subarray(0, n);
    if (s.phase === 'motion-warmup') {
      const t0 = now();
      if (s.start === 0) motion.warmupBegin();
      motion.warmupPushF32(front);
      if (s.last) motion.warmupFinish();
      const dt = now() - t0;
      job.timings.motionMs = dt;
      job.busyMs[1] = dt;
      return { finish: Promise.resolve(job) };
    }
    if (this.gpu && !this.gpuReady && motion.recordLen === 4) {
      this.gpuReady = this.gpu.setup(motion.prefilterParams());
    }
    job.motionBackend = this.motionBackend;
    this.sessionWarp(job, front);
    if (this.setup.replay) return this.replayShifts(job, motion, front);
    if (this.gpu && this.gpuReady) return this.processGpu(job, motion, front);
    return { finish: Promise.resolve(await this.processCpu(job, motion, front)) };
  }

  /**
   * Session re-registration, before the per-frame corrector: on a session's
   * first batch, estimate its transform (pass 1) or install the recorded one
   * (a replay; none recorded: identity), then warp every frame of the
   * session by it in place.
   */
  private sessionWarp(job: StageJob, front: Float32Array): void {
    const a = this.aligner;
    if (!a) return;
    if (job.session) {
      const t = job.sessionReplay;
      if (t) a.setTransform(t[0], t[1], t[2]);
      else if (this.setup.replay) a.setTransform(0, 0, 0);
      else job.sessionAlign = Array.from(a.beginSession(front, this.fovMask!));
    }
    if (a.isIdentity) return;
    a.warpF32(front);
    const t = a.transform();
    job.sessionTransform = [t[0], t[1], t[2]];
  }

  /**
   * Pass 2: warp the frames by the shifts pass 1 recorded (`job.dy`, `job.dx`,
   * `job.flags`), without estimating them. Same warp as pass 1 (the GPU one
   * when it ran there), so the registered frames are the same.
   */
  private async replayShifts(
    job: StageJob,
    motion: MotionCorrector,
    front: Float32Array,
  ): Promise<StagedJob> {
    const s = job.step;
    const n = s.count * this.px;
    const len = motion.recordLen;
    if (len !== 4 || !job.dy || !job.dx || !job.flags)
      throw new Error('The replay (Refine, Extract) uses rigid shifts only.');
    const records = new Float32Array(s.count * len);
    for (let i = 0; i < s.count; i++) {
      records[i * len] = job.dy[i];
      records[i * len + 1] = job.dx[i];
      records[i * len + 3] = job.flags[i];
    }
    const corrected = await this.acquireOut();
    const t0 = now();
    const out = corrected.subarray(0, n);
    if (this.gpu && this.gpuReady) {
      try {
        const { done } = await this.gpu.warpFrames(front, job.dy, job.dx, s.count, out);
        const t1 = now();
        const finish = done.then(() => {
          this.finishJob(job, corrected, records, t0, now());
          job.busyMs[1] = t1 - t0 + (now() - t1);
          return job;
        });
        return { finish };
      } catch (err) {
        console.warn('WebGPU warp failed; falling back to WASM.', err);
        this.gpu?.destroy();
        this.gpu = null;
        this.gpuReady = false;
        this.gpuFailed = true;
        job.motionBackend = this.motionBackend;
      }
    }
    motion.applyF32(front, records, out);
    this.finishJob(job, corrected, records, t0, now());
    return { finish: Promise.resolve(job) };
  }

  private async processCpu(
    job: StageJob,
    motion: MotionCorrector,
    front: Float32Array,
    pooled?: Float32Array,
  ): Promise<StageJob> {
    const s = job.step;
    const n = s.count * this.px;
    const corrected = pooled ?? (await this.acquireOut());
    const t0 = now();
    const len = motion.recordLen;
    if (!this.records || this.records.length < s.count * len)
      this.records = new Float32Array(this.setup.plan.batchSize * len);
    const records = this.records.subarray(0, s.count * len);
    const out = corrected.subarray(0, n);
    motion.processF32(front, out, records);
    const t1 = now();
    this.finishJob(job, corrected, records, t0, t1);
    return job;
  }

  private async processGpu(
    job: StageJob,
    motion: MotionCorrector,
    front: Float32Array,
  ): Promise<StagedJob> {
    const gpu = this.gpu!;
    const s = job.step;
    const n = s.count * this.px;
    const len = motion.recordLen;
    const corrected = await this.acquireOut();
    const t0 = now();
    const geo = motion.prefilterParams();
    const fpx = geo[2] * geo[3];
    if (!this.filtered || this.filtered.length < s.count * fpx)
      this.filtered = new Float32Array(this.setup.plan.batchSize * fpx);
    const filtered = this.filtered.subarray(0, s.count * fpx);
    let slot;
    try {
      ({ slot } = await gpu.prefilter(front, s.count, filtered));
    } catch (err) {
      // Device lost or out of memory before any state changed: finish on the CPU from here on.
      console.warn('WebGPU motion failed; falling back to WASM.', err);
      this.gpu?.destroy();
      this.gpu = null;
      this.gpuReady = false;
      this.gpuFailed = true;
      job.motionBackend = this.motionBackend;
      return { finish: this.processCpu(job, motion, front, corrected) };
    }
    const records = new Float32Array(s.count * len);
    motion.estimateF32Prefiltered(front, filtered, records);
    const dy = new Float32Array(s.count);
    const dx = new Float32Array(s.count);
    for (let i = 0; i < s.count; i++) {
      dy[i] = records[i * len];
      dx[i] = records[i * len + 1];
    }
    const out = corrected.subarray(0, n);
    const warped = gpu.warp(slot, dy, dx, s.count, out);
    const t1 = now();
    const finish = warped.then(() => {
      const t2 = now();
      this.finishJob(job, corrected, records, t0, t2);
      job.busyMs[1] = t1 - t0 + (now() - t2);
      return job;
    });
    return { finish };
  }

  /** Fill the job's motion results from `records` (and downsample the preview). */
  private finishJob(
    job: StageJob,
    corrected: Float32Array,
    records: Float32Array,
    t0: number,
    t1: number,
  ): void {
    const s = job.step;
    const n = s.count * this.px;
    const len = records.length / s.count;
    const out = corrected.subarray(0, n);
    const before = downsampleFrame(
      out,
      s.count - 1,
      this.setup.width,
      this.setup.height,
      this.factor,
    );
    const dy = new Float32Array(s.count);
    const dx = new Float32Array(s.count);
    const quality = new Float32Array(s.count);
    const flags = new Uint32Array(s.count);
    for (let i = 0; i < s.count; i++) {
      dy[i] = records[i * len];
      dx[i] = records[i * len + 1];
      quality[i] = records[i * len + 2];
      flags[i] = records[i * len + 3];
    }
    // The reference of an upcoming session boundary: this session's last registered frames.
    const ref =
      this.aligner && !this.setup.replay
        ? referenceSpan(this.setup.plan.boundaries, s.start, s.count)
        : null;
    if (ref) this.aligner!.pushReference(out.subarray(ref.from * this.px, ref.to * this.px));
    const t2 = now();
    job.corrected = corrected;
    job.dy = dy;
    job.dx = dx;
    job.quality = quality;
    job.flags = flags;
    job.before = before;
    job.timings.motionMs = t1 - t0;
    job.timings.otherMs += t2 - t1;
    job.busyMs[1] = t2 - t0;
  }

  dispose(): void {
    this.motion?.free();
    this.motion = null;
    this.aligner?.free();
    this.aligner = null;
    this.gpu?.destroy();
    this.gpu = null;
    this.gpuReady = false;
  }

  private async initMotion(fovMask: Uint8Array): Promise<void> {
    this.motion?.free();
    const opts = new MotionOptions();
    try {
      this.motion = new MotionCorrector(this.setup.width, this.setup.height, opts);
    } finally {
      opts.free();
    }
    this.motion.setFovMask(fovMask);
    this.aligner?.free();
    const plan = this.setup.plan;
    this.aligner =
      plan.sessionFix && plan.boundaries.length > 0
        ? new SessionAligner(this.setup.width, this.setup.height)
        : null;
    this.fovMask = fovMask;
    this.gpuReady = false;
    if (this.gpuMotion && !this.gpu) {
      this.gpu = await GpuMotion.create(
        this.setup.width,
        this.setup.height,
        this.setup.plan.batchSize,
      );
    }
  }
}

/** Stage C: the preprocessing back half and the fast loop. */
export class BackStage {
  private pre: Preprocessor | null = null;
  private fovMask: Uint8Array | null = null;
  private readonly imaging = new ImagingSampler(() => this.fovMask);
  private readonly px: number;
  private readonly factor: number;

  /** `fast`: the trace solver and slow-loop feed (none: no traces). It is owned (disposed) here. */
  constructor(
    private readonly setup: StageSetup,
    readonly fast: FastLoop | null,
  ) {
    this.px = setup.width * setup.height;
    this.factor = previewFactor(setup.width, setup.height, setup.plan.previewMaxSide);
  }

  /** Finish the job into the step result. Its `corrected` buffer is free afterwards. */
  handle(job: StageJob): PipelineStepResult {
    if (job.calib) {
      this.pre?.free();
      this.pre = Preprocessor.fromState(job.calib.preState);
      this.fovMask = job.calib.fovMask;
    }
    const s = job.step;
    const t = job.timings;
    if (s.phase !== 'process') {
      return {
        kind: 'setup',
        phase: s.phase,
        done: s.start + s.count,
        total: job.total,
        timings: t,
      };
    }
    const pre = this.pre;
    if (!pre) throw new Error('The back stage was not calibrated.');
    const t0 = now();
    const n = s.count * this.px;
    const corrected = job.corrected!.subarray(0, n);
    const session = job.session ? this.beginSession(pre, job, corrected) : undefined;
    // Pixels the shift moved in from outside the FOV mask are missing data:
    // they stay out of the noise map and background (see backFramesRegistered).
    pre.backFramesRegistered(corrected, s.count, job.dy!, job.dx!);
    const t1 = now();
    const cells = this.fast?.process(corrected, s.start, s.count, pre, {
      dy: job.dy!,
      dx: job.dx!,
    });
    const imaging = this.imaging.sample(pre, s.start, s.count);
    const t2 = now();
    const output = downsampleFrame(
      corrected,
      s.count - 1,
      this.setup.width,
      this.setup.height,
      this.factor,
    );
    const t3 = now();
    t.preprocessMs += t1 - t0;
    t.traceMs = t2 - t1;
    t.otherMs += t3 - t2;
    job.busyMs[2] = t3 - t0;
    const previews: BatchPreviews = {
      frame: s.start + s.count - 1,
      raw: job.raw!,
      preprocessed: job.preprocessed!,
      corrected: job.before!,
      output,
    };
    const residual = takeResidualPreview(cells, this.setup.width, this.setup.height, this.factor);
    if (residual) previews.residual = residual;
    return {
      kind: 'batch',
      start: s.start,
      count: s.count,
      dy: job.dy!,
      dx: job.dx!,
      quality: job.quality!,
      flags: job.flags!,
      flickerOffset: job.flickerOffset!,
      flickerGain: job.flickerGain!,
      previews,
      timings: t,
      stageBusyMs: job.busyMs,
      ...(job.motionBackend ? { motionBackend: job.motionBackend } : {}),
      ...(cells ? { cells } : {}),
      ...(job.live ? { live: job.live } : {}),
      ...(job.flatField ? { flatField: job.flatField } : {}),
      ...(imaging ? { imaging } : {}),
      ...(session ? { session } : {}),
    };
  }

  /**
   * A session starts with this batch: validate its pixels against the FOV
   * mask as B's session warp moved it, and carry the background floor and
   * noise map into the new session (fitted on this batch).
   */
  private beginSession(pre: Preprocessor, job: StageJob, corrected: Float32Array): SessionStart {
    const t = job.sessionTransform ?? [0, 0, 0];
    if (job.sessionTransform) {
      const a = new SessionAligner(this.setup.width, this.setup.height);
      try {
        a.setTransform(t[0], t[1], t[2]);
        pre.setSourceMask(a.sourceMask(this.fovMask!));
      } finally {
        a.free();
      }
    } else pre.setSourceMask(new Uint8Array(0));
    return sessionStart(
      job,
      t,
      pre.beginSessionBack(corrected, job.step.count, job.dy!, job.dx!, true, true),
    );
  }

  /** The recording ended: let the slow loop publish what it has. */
  end(): void {
    this.fast?.end();
  }

  /** `keepSlow`: see `FastLoop.dispose`. */
  dispose(keepSlow = false): void {
    this.fast?.dispose(keepSlow);
    this.pre?.free();
    this.pre = null;
  }
}
