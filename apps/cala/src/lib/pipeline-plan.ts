/**
 * Batching plan of the streaming preprocess + motion pipeline. Pure, so it is
 * unit-tested without WASM.
 *
 * The pipeline walks the recording three times, each in small batches so the
 * whole movie is never in memory:
 *
 * 1. `calibrate`: the first `calibrationFrames` raw frames feed the
 *    preprocessing warm-up (FOV mask, hot pixels).
 * 2. `motion-warmup`: the first `motionWarmupFrames` frames, through the
 *    sensor-coordinate preprocessing, build the motion template (in the same
 *    intensity domain the corrector will later see).
 * 3. `process`: every frame from 0, in batches of `batchSize`: preprocessing
 *    front half, motion correction, back half.
 */
import { MAX_FRAMES_PER_READ } from './frame-source.ts';

export interface PipelineOptions {
  /** Frames per processing batch (one preview and one message each). */
  batchSize?: number;
  /** Raw frames for the preprocessing calibration. */
  calibrationFrames?: number;
  /** Preprocessed frames averaged into the motion warm-up template. */
  motionWarmupFrames?: number;
  /** Longest side of the preview images sent to the UI, px. */
  previewMaxSide?: number;
}

export const PIPELINE_DEFAULTS: Required<PipelineOptions> = {
  batchSize: 8,
  calibrationFrames: 200,
  // 100 preprocessed f32 frames are 144 MB at 600x600, held only until the
  // template is built; the Rust default of ~200 would double that.
  motionWarmupFrames: 100,
  previewMaxSide: 320,
};

export type PipelinePhase = 'calibrate' | 'motion-warmup' | 'process';

export interface PipelinePlan {
  frameCount: number;
  batchSize: number;
  calibrationFrames: number;
  motionWarmupFrames: number;
  previewMaxSide: number;
}

/** One unit of work: frames `[start, start + count)` of `phase`. */
export interface PipelineStep {
  phase: PipelinePhase;
  start: number;
  count: number;
  /** The last step of its phase (the stage is finalized after it). */
  last: boolean;
}

function positiveInt(name: string, v: number): number {
  if (!Number.isFinite(v) || v < 1) throw new RangeError(`${name} must be at least 1 (got ${v}).`);
  return Math.floor(v);
}

/** Resolve the options against a recording of `frameCount` frames. */
export function makePlan(frameCount: number, options: PipelineOptions = {}): PipelinePlan {
  const o = { ...PIPELINE_DEFAULTS, ...options };
  const n = positiveInt('frameCount', frameCount);
  return {
    frameCount: n,
    batchSize: Math.min(positiveInt('batchSize', o.batchSize), MAX_FRAMES_PER_READ),
    calibrationFrames: Math.min(positiveInt('calibrationFrames', o.calibrationFrames), n),
    motionWarmupFrames: Math.min(positiveInt('motionWarmupFrames', o.motionWarmupFrames), n),
    previewMaxSide: positiveInt('previewMaxSide', o.previewMaxSide),
  };
}

const PHASES: PipelinePhase[] = ['calibrate', 'motion-warmup', 'process'];

/** Frames of `phase` and the batch size it is read in. */
export function phaseSpan(plan: PipelinePlan, phase: PipelinePhase): [number, number] {
  switch (phase) {
    case 'calibrate':
      return [plan.calibrationFrames, MAX_FRAMES_PER_READ];
    case 'motion-warmup':
      return [plan.motionWarmupFrames, MAX_FRAMES_PER_READ];
    case 'process':
      return [plan.frameCount, plan.batchSize];
  }
}

/** Walks the plan one step at a time. */
export class PipelineCursor {
  private phaseIndex = 0;
  private at = 0;

  readonly plan: PipelinePlan;

  constructor(plan: PipelinePlan) {
    this.plan = plan;
  }

  /** The next step, or `null` once every frame has been processed. */
  next(): PipelineStep | null {
    while (this.phaseIndex < PHASES.length) {
      const phase = PHASES[this.phaseIndex];
      const [total, chunk] = phaseSpan(this.plan, phase);
      if (this.at < total) {
        const start = this.at;
        const count = Math.min(chunk, total - start);
        this.at += count;
        return { phase, start, count, last: this.at >= total };
      }
      this.phaseIndex++;
      this.at = 0;
    }
    return null;
  }

  get done(): boolean {
    return this.phaseIndex >= PHASES.length;
  }
}
