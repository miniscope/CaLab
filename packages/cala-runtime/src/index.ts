export { SabRingChannel, ChannelTimeoutError } from './channel.ts';
export type { ChannelConfig, ChannelStats, ChannelSlot } from './types.ts';
export { MutationQueue, snapshotEpoch } from './mutation-queue.ts';
export type {
  PipelineMutation,
  DeprecateReason,
  ComponentClass,
  Epoch,
  MutationQueueConfig,
} from './mutation-queue.ts';
// Surface stubs for modules that land in later tasks — see types.ts TODOs.
export type { Snapshot, PipelineEvent, Orchestrator, Todo } from './types.ts';
