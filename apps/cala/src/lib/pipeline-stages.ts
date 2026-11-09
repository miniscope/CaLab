/**
 * The per-frame pipeline cut into three stages that can run in three workers,
 * so batch N+1's decode + preprocessing overlaps batch N's motion correction
 * and batch N-1's trace solve:
 *
 *   FrontStage (A)  read, calibration, motion warm-up front half, preprocess front half
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
} from './cala-wasm.ts';
import type { FastLoop } from './fast-loop.ts';
import type { FramePixels } from './frame-source.ts';
import type {
  BatchPreviews,
  FastLoopSetup,
  FrameReader,
  PipelineStepResult,
  StageTimings,
} from './pipeline-engine.ts';
import {
  makePlan,
  PipelineCursor,
  type PipelineOptions,
  type PipelinePlan,
  type PipelineStep,
} from './pipeline-plan.ts';
import { downsampleFrame, previewFactor, type PreviewImage } from './preview.ts';

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

/** What a stage needs to know about the recording and the plan. */
export interface StageSetup {
  width: number;
  height: number;
  plan: PipelinePlan;
}

/** Stage A: read, calibrate, and run the preprocessing front half. */
export class FrontStage {
  readonly plan: PipelinePlan;
  /** What the fast loop in stage C is built from. */
  readonly fastSetup: FastLoopSetup;
  private readonly cursor: PipelineCursor;
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

  /**
   * `acquireFront` hands out a buffer of `plan.batchSize * width * height`
   * floats (waiting while stage B holds all of them: the backpressure).
   */
  constructor(
    private readonly reader: FrameReader,
    options: PipelineOptions,
    private readonly acquireFront: () => Promise<Float32Array>,
    flickerMode?: number,
  ) {
    const { width, height, bitDepth, frameCount, fps } = reader.info;
    this.plan = makePlan(frameCount, options);
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

  get setup(): StageSetup {
    return { width: this.width, height: this.height, plan: this.plan };
  }

  /** The next job, or `null` once every frame has been through. */
  async next(): Promise<StageJob | null> {
    const s = this.cursor.next();
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

    const frontRec = this.runFront(this.pre!, raw, s.count, frontView);
    const t2 = now();
    const last = s.count - 1;
    const flickerOffset = new Float32Array(s.count);
    const flickerGain = new Float32Array(s.count);
    for (let i = 0; i < s.count; i++) {
      flickerOffset[i] = frontRec[i * FRONT_RECORD_STRIDE + 4];
      flickerGain[i] = frontRec[i * FRONT_RECORD_STRIDE + 5];
    }
    const rawPreview = downsampleFrame(raw, last, this.width, this.height, this.factor);
    const preprocessed = downsampleFrame(frontView, last, this.width, this.height, this.factor);
    const t3 = now();
    timings.preprocessMs = t2 - t1b;
    timings.otherMs = t3 - t2;
    return {
      step: s,
      total: this.plan.frameCount,
      front,
      flickerOffset,
      flickerGain,
      raw: rawPreview,
      preprocessed,
      timings,
      busyMs: [t3 - t0 - (t1b - t1), 0, 0],
    };
  }

  dispose(): void {
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

  private async readRaw(start: number, count: number): Promise<FramePixels> {
    const n = count * this.px;
    if (this.raw.length < n) this.raw = this.sixteen ? new Uint16Array(n) : new Uint8Array(n);
    return this.reader.readFrames(start, count, this.raw.subarray(0, n));
  }
}

/** Stage B: the motion corrector. */
export class MotionStage {
  private motion: MotionCorrector | null = null;
  private records: Float32Array | null = null;
  private readonly px: number;
  private readonly factor: number;

  /** `acquireOut` hands out a buffer of `batchSize * width * height` floats (waits while C holds them all). */
  constructor(
    private readonly setup: StageSetup,
    private readonly acquireOut: () => Promise<Float32Array>,
  ) {
    this.px = setup.width * setup.height;
    this.factor = previewFactor(setup.width, setup.height, setup.plan.previewMaxSide);
  }

  /** Run the job's motion step (in place on the job). The `front` buffer is free afterwards. */
  async handle(job: StageJob): Promise<StageJob> {
    if (job.calib) this.initMotion(job.calib.fovMask);
    const s = job.step;
    if (s.phase === 'calibrate') return job;
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
      return job;
    }

    const corrected = await this.acquireOut();
    const t0 = now();
    const len = motion.recordLen;
    if (!this.records || this.records.length < s.count * len)
      this.records = new Float32Array(this.setup.plan.batchSize * len);
    const records = this.records.subarray(0, s.count * len);
    const out = corrected.subarray(0, n);
    motion.processF32(front, out, records);
    const t1 = now();
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
    return job;
  }

  dispose(): void {
    this.motion?.free();
    this.motion = null;
  }

  private initMotion(fovMask: Uint8Array): void {
    this.motion?.free();
    const opts = new MotionOptions();
    try {
      this.motion = new MotionCorrector(this.setup.width, this.setup.height, opts);
    } finally {
      opts.free();
    }
    this.motion.setFovMask(fovMask);
  }
}

/** Stage C: the preprocessing back half and the fast loop. */
export class BackStage {
  private pre: Preprocessor | null = null;
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
    pre.backFrames(corrected, s.count);
    const t1 = now();
    const cells = this.fast?.process(corrected, s.start, s.count, pre);
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
      ...(cells ? { cells } : {}),
    };
  }

  /** The recording ended: let the slow loop publish what it has. */
  end(): void {
    this.fast?.end();
  }

  dispose(): void {
    this.fast?.dispose();
    this.pre?.free();
    this.pre = null;
  }
}
