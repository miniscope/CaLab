/**
 * The streaming preprocess + motion pipeline over a frame source, driven one
 * step at a time (see `pipeline-plan.ts` for the phases).
 *
 * Runs wherever the cala WASM module is initialized: in the frame worker for
 * the app, in Node for `scripts/real-data-check.mjs` and the tests. Buffers
 * are sized to one batch and reused; the only larger allocation is the motion
 * warm-up stack, freed as soon as the template is built.
 */
import { MotionCorrector, MotionOptions, PreprocessConfig, PreprocessWarmup } from './cala-wasm.ts';
import type { Preprocessor } from './cala-wasm.ts';
import type { FramePixels, FrameSourceInfo } from './frame-source.ts';
import {
  makePlan,
  PipelineCursor,
  type PipelineOptions,
  type PipelinePhase,
  type PipelinePlan,
} from './pipeline-plan.ts';
import { downsampleFrame, previewFactor, type PreviewImage } from './preview.ts';

/** What the engine needs from a `FrameSource`. */
export interface FrameReader {
  readonly info: Pick<FrameSourceInfo, 'width' | 'height' | 'bitDepth' | 'frameCount' | 'fps'>;
  readFrames(start: number, count: number, out?: FramePixels): Promise<FramePixels>;
}

/** Wall time per stage for one step, ms. */
export interface StageTimings {
  readMs: number;
  /** Preprocessing: front half (hot pixels, flattening, lines) plus back half (background, noise). */
  preprocessMs: number;
  motionMs: number;
  /** Preview downsampling and bookkeeping. */
  otherMs: number;
}

/** The previews of one batch, all of its last frame. */
export interface BatchPreviews {
  /** Index of the frame shown. */
  frame: number;
  raw: PreviewImage;
  /** After hot pixels, glow flattening and line removal, before motion. */
  preprocessed: PreviewImage;
  /** After motion correction (same intensity domain as `preprocessed`). */
  corrected: PreviewImage;
  /** Final output: motion-corrected with the background floor removed. */
  output: PreviewImage;
}

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
      previews: BatchPreviews;
      timings: StageTimings;
    }
  | { kind: 'done' };

/** Transferable buffers of a step result (for `postMessage`). */
export function transferablesOf(r: PipelineStepResult): ArrayBuffer[] {
  if (r.kind !== 'batch') return [];
  const p = r.previews;
  return [
    r.dy,
    r.dx,
    r.quality,
    r.flags,
    p.raw.data,
    p.preprocessed.data,
    p.corrected.data,
    p.output.data,
  ].map((a) => a.buffer as ArrayBuffer);
}

const now = (): number => performance.now();

export class PipelineEngine {
  readonly plan: PipelinePlan;
  private readonly cursor: PipelineCursor;
  private readonly width: number;
  private readonly height: number;
  private readonly px: number;
  private readonly sixteen: boolean;
  private readonly factor: number;

  private warmup: PreprocessWarmup | null = null;
  private pre: Preprocessor | null = null;
  private motion: MotionCorrector | null = null;
  private motionWarm: Float32Array | null = null;

  private raw: FramePixels;
  private front: Float32Array;
  private corrected: Float32Array;
  private records: Float32Array | null = null;
  private disposed = false;

  private readonly reader: FrameReader;

  constructor(reader: FrameReader, options: PipelineOptions = {}) {
    this.reader = reader;
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
    try {
      this.warmup = new PreprocessWarmup(width, height, config);
    } finally {
      config.free();
    }
    // Read buffers sized for the larger of a read chunk and a batch.
    this.raw = this.sixteen ? new Uint16Array(0) : new Uint8Array(0);
    this.front = new Float32Array(0);
    this.corrected = new Float32Array(0);
  }

  get frameCount(): number {
    return this.plan.frameCount;
  }

  /** Run the next step. After the last batch, returns `{ kind: 'done' }`. */
  async step(): Promise<PipelineStepResult> {
    if (this.disposed) throw new Error('The pipeline was stopped.');
    const s = this.cursor.next();
    if (!s) return { kind: 'done' };

    const t0 = now();
    const raw = await this.readRaw(s.start, s.count);
    const t1 = now();
    const timings: StageTimings = { readMs: t1 - t0, preprocessMs: 0, motionMs: 0, otherMs: 0 };

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
      this.motionWarm ??= new Float32Array(this.plan.motionWarmupFrames * this.px);
      this.runFront(
        pre,
        raw,
        s.count,
        this.motionWarm.subarray(s.start * this.px, (s.start + s.count) * this.px),
      );
      const t2 = now();
      timings.preprocessMs = t2 - t1;
      if (s.last) {
        this.motion!.initializeF32(this.motionWarm);
        this.motionWarm = null;
        timings.motionMs = now() - t2;
      }
      return {
        kind: 'setup',
        phase: s.phase,
        done: s.start + s.count,
        total: this.plan.motionWarmupFrames,
        timings,
      };
    }

    // process
    const n = s.count * this.px;
    const front = this.grow('front', n);
    const corrected = this.grow('corrected', n);
    const motion = this.motion!;
    const len = motion.recordLen;
    if (!this.records || this.records.length < s.count * len)
      this.records = new Float32Array(this.plan.batchSize * len);
    const records = this.records.subarray(0, s.count * len);

    this.runFront(pre, raw, s.count, front);
    const t2 = now();
    motion.processF32(front, corrected, records);
    const t3 = now();
    const last = s.count - 1;
    const before = downsampleFrame(corrected, last, this.width, this.height, this.factor);
    const t4 = now();
    pre.backFrames(corrected, s.count);
    const t5 = now();

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
    const previews: BatchPreviews = {
      frame: s.start + last,
      raw: downsampleFrame(raw, last, this.width, this.height, this.factor),
      preprocessed: downsampleFrame(front, last, this.width, this.height, this.factor),
      corrected: before,
      output: downsampleFrame(corrected, last, this.width, this.height, this.factor),
    };
    const t6 = now();
    timings.preprocessMs = t2 - t1 + (t5 - t4);
    timings.motionMs = t3 - t2;
    timings.otherMs = t4 - t3 + (t6 - t5);
    return {
      kind: 'batch',
      start: s.start,
      count: s.count,
      dy,
      dx,
      quality,
      flags,
      previews,
      timings,
    };
  }

  /** Release the WASM objects. The engine is unusable afterwards. */
  dispose(): void {
    this.disposed = true;
    this.warmup?.free();
    this.pre?.free();
    this.motion?.free();
    this.warmup = this.pre = this.motion = null;
    this.motionWarm = null;
  }

  private finishCalibration(): void {
    const pre = this.warmup!.finish();
    this.warmup!.free();
    this.warmup = null;
    this.pre = pre;
    const opts = new MotionOptions();
    try {
      this.motion = new MotionCorrector(this.width, this.height, opts);
    } finally {
      opts.free();
    }
    this.motion.setFovMask(pre.fovMask());
  }

  private runFront(pre: Preprocessor, raw: FramePixels, count: number, out: Float32Array): void {
    if (this.sixteen) pre.frontFrames16(raw as Uint16Array, count, out);
    else pre.frontFrames(raw as Uint8Array, count, out);
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
