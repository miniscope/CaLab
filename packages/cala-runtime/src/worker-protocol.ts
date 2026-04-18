/**
 * Orchestrator ↔ worker message protocol (design §7, Phase 5 Task 18).
 *
 * The four workers (W1 decode+preprocess, W2 fit, W3 extend, W4
 * archive) never talk to each other directly — they exchange data
 * through SAB channels and exchange control messages with the
 * orchestrator through `postMessage`. This module codifies the exact
 * shape of those control messages so worker authors (Phase 5 tasks
 * 21-23) and the orchestrator stay in lockstep.
 */

import type { PipelineEvent } from './events.ts';

/** The four workers the orchestrator spawns. Used as a tag in messages. */
export type WorkerRole = 'decodePreprocess' | 'fit' | 'extend' | 'archive';

/**
 * SAB handles and per-worker config posted with `init`. The decoder
 * worker additionally receives the caller-provided frame source (see
 * `RuntimeSource`) so it can open the input without touching
 * `@calab/io` from the runtime package.
 */
export interface WorkerInitPayload {
  role: WorkerRole;
  frameChannelBuffer: SharedArrayBuffer | ArrayBuffer;
  residualChannelBuffer: SharedArrayBuffer | ArrayBuffer;
  /**
   * Opaque, role-specific config bag the orchestrator forwards
   * untouched. Kept permissive so worker tasks can extend their own
   * config without coupling the runtime package to numerical details.
   */
  workerConfig: unknown;
}

/** Messages the orchestrator sends to a worker. */
export type WorkerInbound =
  | { kind: 'init'; payload: WorkerInitPayload }
  | { kind: 'run' }
  | { kind: 'stop' }
  | {
      kind: 'snapshot-ack';
      requestId: number;
      epoch: bigint;
      numComponents: number;
      pixels: number;
    }
  // Orchestrator forwards each fit-emitted `PipelineEvent` to the
  // archive worker (design §9.2). The archive-worker side replays
  // these onto its local `EventBus` so log append + metric snapshot
  // share one subscription path.
  | { kind: 'event'; event: PipelineEvent }
  // Main-thread dashboard (task 24) asks for a consistent dump of the
  // archive's in-memory event log and per-name metric snapshot.
  // `requestId` correlates each dump with the eventual reply.
  | { kind: 'request-archive-dump'; requestId: number };

/** Messages a worker sends back to the orchestrator. */
export type WorkerOutbound =
  | { kind: 'ready'; role: WorkerRole }
  | { kind: 'frame-processed'; role: WorkerRole; index: number; epoch: bigint }
  | { kind: 'mutation-applied'; role: WorkerRole; epoch: bigint }
  | { kind: 'snapshot-request'; role: WorkerRole; requestId: number }
  | { kind: 'event'; role: WorkerRole; event: PipelineEvent }
  | { kind: 'error'; role: WorkerRole; message: string }
  | { kind: 'done'; role: WorkerRole }
  // Archive worker reply to `request-archive-dump`. `events` is a
  // snapshot of the rolling log (oldest→newest); `metrics` is the
  // current per-name scalar snapshot (design §9.1 / §10).
  | {
      kind: 'archive-dump';
      role: WorkerRole;
      requestId: number;
      events: PipelineEvent[];
      metrics: Record<string, number>;
    };

/**
 * Minimal structural subtype of the DOM `Worker` that the orchestrator
 * actually needs. Keeping it narrow lets tests substitute a fake
 * harness without stubbing transferables / `onerror` / etc.
 */
export interface WorkerLike {
  postMessage(message: WorkerInbound): void;
  addEventListener(type: 'message', listener: (ev: { data: WorkerOutbound }) => void): void;
  removeEventListener(type: 'message', listener: (ev: { data: WorkerOutbound }) => void): void;
  terminate(): void;
}

/** Caller-provided factory invoked once per `run()`. */
export type WorkerFactory = () => WorkerLike;
