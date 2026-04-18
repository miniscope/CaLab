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

// Snapshot protocol surface — extend→fit control channel for
// consistent views of `(Ã, W, M, epoch)`. See CALA_DESIGN §7.2.
export {
  SnapshotProtocol,
  SnapshotTimeoutError,
  SnapshotCapacityError,
  type SnapshotAck,
  type SnapshotRequest,
  type SnapshotProtocolConfig,
  type SnapshotProtocolStats,
} from './asset-snapshot.ts';

// PipelineEvent surface — compact event records emitted by fit for
// the archive worker. See CALA_DESIGN §9.2.
export {
  EventBus,
  EventBusSubscriberError,
  type PipelineEvent,
  type FootprintSnap,
  type EventBusConfig,
  type EventBusStats,
  type Unsubscribe,
} from './events.ts';

// Orchestrator surface — creates workers, wires channels, tracks
// epochs, owns two-pass toggle. See CALA_DESIGN §7.
export {
  createRuntime,
  RuntimeStartupTimeoutError,
  RuntimeShutdownTimeoutError,
  RuntimeWorkerError,
  type RuntimeConfig,
  type RuntimeController,
  type RuntimeSource,
  type RuntimeState,
  type RuntimeStatus,
  type RuntimeStats,
} from './orchestrator.ts';

export type {
  WorkerFactory,
  WorkerInbound,
  WorkerOutbound,
  WorkerInitPayload,
  WorkerLike,
  WorkerRole,
} from './worker-protocol.ts';
