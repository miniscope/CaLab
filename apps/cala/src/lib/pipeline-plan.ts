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
 *    sensor-coordinate preprocessing, are pushed batch by batch into the motion
 *    corrector's streaming warm-up (in the same intensity domain it will later
 *    see); the last batch builds the template.
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
  /**
   * Divide out the sensor gain map estimated online from the recording's own
   * motion (default on). Pipelined workers only: the single-worker
   * `PipelineEngine` ignores it (see the note there).
   */
  flatField?: boolean;
  /**
   * At a session boundary of a Joint run, re-register the new session and
   * carry the preprocessing state into it (default on; see
   * `session-boundary.ts`). Off: the run goes straight across.
   */
  sessionFix?: boolean;
}

export const PIPELINE_DEFAULTS: Required<PipelineOptions> = {
  batchSize: 8,
  calibrationFrames: 200,
  // The Rust default (~200). The corrector keeps these frames band-passed and
  // cropped inside WASM until the template is built, never as full f32 frames.
  motionWarmupFrames: 200,
  previewMaxSide: 320,
  flatField: true,
  sessionFix: true,
};

export type PipelinePhase = 'calibrate' | 'motion-warmup' | 'process';

export interface PipelinePlan {
  frameCount: number;
  batchSize: number;
  calibrationFrames: number;
  motionWarmupFrames: number;
  previewMaxSide: number;
  /**
   * First frames of sessions 1.. of a multi-session recording (empty for
   * one). A process batch never spans one: the batch before a boundary is
   * cut short, so each session starts a batch.
   */
  boundaries: number[];
  /** `PipelineOptions.sessionFix`. */
  sessionFix: boolean;
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

/** `frameCount` of a plan over a stream whose end is not known (a live source). */
export const UNBOUNDED = Infinity;

/**
 * Resolve the options against a recording of `frameCount` frames
 * (`UNBOUNDED`: a stream whose length is learnt only when it ends; see
 * `limitPlan`).
 */
export function makePlan(
  frameCount: number,
  options: PipelineOptions = {},
  boundaries: readonly number[] = [],
): PipelinePlan {
  const o = { ...PIPELINE_DEFAULTS, ...options };
  const n = frameCount === UNBOUNDED ? UNBOUNDED : positiveInt('frameCount', frameCount);
  return {
    boundaries: [...new Set(boundaries)]
      .filter((b) => Number.isInteger(b) && b > 0 && b < n)
      .sort((a, b) => a - b),
    sessionFix: o.sessionFix,
    frameCount: n,
    batchSize: Math.min(positiveInt('batchSize', o.batchSize), MAX_FRAMES_PER_READ),
    calibrationFrames: Math.min(positiveInt('calibrationFrames', o.calibrationFrames), n),
    motionWarmupFrames: Math.min(positiveInt('motionWarmupFrames', o.motionWarmupFrames), n),
    previewMaxSide: positiveInt('previewMaxSide', o.previewMaxSide),
  };
}

/** True for a plan over a stream whose end is not known yet. */
export function isUnbounded(plan: PipelinePlan): boolean {
  return plan.frameCount === UNBOUNDED;
}

/**
 * The stream ended after `frames` frames: bound the plan in place (the
 * warm-ups shrink with it when the stream was shorter than they are).
 */
export function limitPlan(plan: PipelinePlan, frames: number): void {
  const n = Math.max(0, Math.floor(frames));
  if (n >= plan.frameCount) return;
  plan.frameCount = n;
  plan.calibrationFrames = Math.min(plan.calibrationFrames, n);
  plan.motionWarmupFrames = Math.min(plan.motionWarmupFrames, n);
}

const PHASES: PipelinePhase[] = ['calibrate', 'motion-warmup', 'process'];

/** Frames of `phase` and the batch size it is read in. */
export function phaseSpan(plan: PipelinePlan, phase: PipelinePhase): [number, number] {
  switch (phase) {
    case 'calibrate':
      return [plan.calibrationFrames, MAX_FRAMES_PER_READ];
    case 'motion-warmup':
      return [plan.motionWarmupFrames, plan.batchSize];
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
        let count = Math.min(chunk, total - start);
        if (phase === 'process') {
          const next = this.plan.boundaries.find((b) => b > start);
          if (next !== undefined) count = Math.min(count, next - start);
        }
        this.at += count;
        return { phase, start, count, last: this.at >= total };
      }
      this.phaseIndex++;
      this.at = 0;
    }
    return null;
  }

  /**
   * The step `next()` would return, without advancing (a live source waits
   * for its frames first; the plan may be bounded in between, see `limit`).
   */
  peek(): PipelineStep | null {
    const { phaseIndex, at } = this;
    const step = this.next();
    this.phaseIndex = phaseIndex;
    this.at = at;
    return step;
  }

  /** The stream ended after `frames` frames (`limitPlan` on this cursor's plan). */
  limit(frames: number): void {
    limitPlan(this.plan, frames);
  }

  /**
   * End the recording at the current position (a stream stopped early):
   * every remaining step is dropped, whichever phase the cursor is in.
   */
  truncate(): void {
    this.phaseIndex = PHASES.length;
  }

  get done(): boolean {
    return this.phaseIndex >= PHASES.length;
  }
}
