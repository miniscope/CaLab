/**
 * Shared wire types for the CaLa browser runtime.
 *
 * This file enumerates the full §7 surface area so the module layout is
 * visible even for pieces that land in later tasks. See
 * `.planning/CALA_DESIGN.md §7` for the authoritative description.
 */

export interface ChannelConfig {
  slotBytes: number;
  slotCount: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  sharedBuffer?: SharedArrayBuffer | ArrayBuffer;
}

export interface ChannelStats {
  framesWritten: number;
  framesRead: number;
  dropCount: number;
  capacity: number;
  inFlight: number;
}

export interface ChannelSlot {
  data: Uint8Array;
  epoch: bigint;
}

// MutationQueue surface — bounded drop-oldest ring used by the extend
// worker to publish PipelineMutation records to the fit worker. Single-
// threaded for now; cross-worker SAB backing lands with the orchestrator
// in task 18. See CALA_DESIGN §7.3.
export {
  MutationQueue,
  snapshotEpoch,
  type PipelineMutation,
  type DeprecateReason,
  type ComponentClass,
  type Epoch,
  type MutationQueueConfig,
} from './mutation-queue.ts';

// TODO(task 17): Snapshot surface — copy-on-write asset view protocol that
// gives the extend worker a consistent `A, W, M` at an epoch boundary.
// See CALA_DESIGN §7.2.
export type Snapshot = Todo<'Snapshot'>;

// TODO(task 17): PipelineEvent surface — compact event records emitted by
// fit for the archive worker. See CALA_DESIGN §9.2.
export type PipelineEvent = Todo<'PipelineEvent'>;

// TODO(task 18): Orchestrator surface — creates workers, wires channels,
// tracks epochs, owns two-pass toggle. See CALA_DESIGN §7.
export type Orchestrator = Todo<'Orchestrator'>;

export type Todo<K extends string> = { readonly __todo: K };
