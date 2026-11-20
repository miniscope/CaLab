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
  /** `keepSlow`: see `pipeline-stop`. */
  | { type: 'stop'; epoch: number; keepSlow?: boolean };

/** Upstream: a pooled buffer is free again. */
export interface StageFree {
  type: 'free';
  epoch: number;
  buffer: Float32Array;
}

/**
 * Upstream, B -> A: the rigid shifts stage B found for the process batch that
 * starts at `start`. Stage A keeps that batch's raw frames until they arrive
 * and sends both to the flat-field estimator (`lib/flat-field-runner.ts`).
 */
export interface StageShifts {
  type: 'shifts';
  epoch: number;
  start: number;
  dy: Float32Array;
  dx: Float32Array;
  /** The session warp applied before these shifts (absent: identity). */
  session?: [number, number, number];
}

/** Main thread -> motion / trace worker: their ports. */
export interface StageLink {
  type: 'stage-link';
  up: MessagePort;
  /** Motion worker: use WebGPU for the prefilter and warp when available (default true). */
  gpu?: boolean;
  /** The motion worker's port to the trace worker. */
  down?: MessagePort;
}
