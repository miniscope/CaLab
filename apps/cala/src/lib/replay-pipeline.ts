import type { CellsSettings } from '../workers/frame-types.ts';
import type { FlatFieldMap } from './flat-field.ts';
import type { PipelineClient } from './frame-client.ts';
import type { PipelinePlan } from './pipeline-plan.ts';
import type { RunRecord } from './run-record.ts';

/** Replay Discover's preprocessing and motion, using its newest flat field from frame 0. */
export function startReplayPipeline(
  client: PipelineClient,
  plan: PipelinePlan,
  cells: Omit<CellsSettings, 'qc'>,
  replay: { frames: number; record: RunRecord; flatField: FlatFieldMap | null },
): Promise<PipelinePlan> {
  return client.startPipeline(
    {
      batchSize: plan.batchSize,
      calibrationFrames: plan.calibrationFrames,
      motionWarmupFrames: plan.motionWarmupFrames,
      previewMaxSide: plan.previewMaxSide,
    },
    // Replay QC is computed from the saved traces, rather than an online monitor.
    { ...cells, qc: false },
    {
      frameCount: replay.frames,
      ...replay.record.snapshot(),
      ...(replay.flatField ? { flatField: replay.flatField } : {}),
    },
  );
}
