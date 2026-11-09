/**
 * Messages between the pipeline stage workers (see `lib/pipeline-stages.ts`):
 * frame worker (A) -> motion worker (B) -> trace worker (C), each link a
 * `MessageChannel` the main thread wires up. Jobs flow downstream; pooled
 * buffers flow back upstream as `free` acks. C answers the main thread
 * directly with the `pipeline-step` response of the request that started the
 * job, so the request ids pair up as in the single-worker path.
 */
import type { CellsSettings } from './frame-types.ts';
import type { FastLoopSetup } from '../lib/pipeline-engine.ts';
import type { StageJob, StageSetup } from '../lib/pipeline-stages.ts';

/** Downstream (A -> B -> C). `epoch` changes at every pipeline start. */
export type StageMsg =
  | {
      type: 'start';
      epoch: number;
      id: number;
      setup: StageSetup;
      fast: FastLoopSetup;
      cells?: CellsSettings;
    }
  | { type: 'job'; epoch: number; id: number; job: StageJob }
  /** The recording is exhausted: C answers the request `id` with `done`. */
  | { type: 'end'; epoch: number; id: number }
  | { type: 'stop'; epoch: number };

/** Upstream: a pooled buffer is free again. */
export interface StageFree {
  type: 'free';
  epoch: number;
  buffer: Float32Array;
}

/** Main thread -> motion / trace worker: their ports. */
export interface StageLink {
  type: 'stage-link';
  up: MessagePort;
  /** The motion worker's port to the trace worker. */
  down?: MessagePort;
}
