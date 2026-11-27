import type { PipelineStepResult } from '../lib/pipeline-types.ts';

/** One batch result of the pipeline. */
export type StepBatch = Extract<PipelineStepResult, { kind: 'batch' }>;

/** A 1 x 1 preview image (the previews are never looked at unless a test says so). */
export const unitImage = (): StepBatch['previews']['raw'] => ({
  width: 1,
  height: 1,
  data: new Float32Array(1),
});

/**
 * A batch of `count` frames from `start`, all zero: no shift, no quality, no flags, no flicker,
 * 1 x 1 previews of its last frame, no time spent. `over` replaces any field.
 */
export function stepBatch(start: number, count: number, over: Partial<StepBatch> = {}): StepBatch {
  const image = unitImage();
  return {
    kind: 'batch',
    start,
    count,
    dy: new Float32Array(count),
    dx: new Float32Array(count),
    quality: new Float32Array(count),
    flags: new Uint32Array(count),
    flickerOffset: new Float32Array(count),
    flickerGain: new Float32Array(count),
    previews: { frame: start, raw: image, preprocessed: image, corrected: image, output: image },
    timings: { readMs: 0, preprocessMs: 0, motionMs: 0, otherMs: 0, traceMs: 0 },
    ...over,
  };
}
