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
import type { DeprecateReason } from './mutation-queue.ts';

/**
 * Shape of a mutation the main thread can author and hand to the fit
 * worker (Phase 6 task 13). Kept narrow on purpose: Phase 6 only ships
 * deprecation, since it needs no footprint payload and maps cleanly
 * onto a click-to-delete UI affordance. Register / merge from the UI
 * land with a Phase 7 footprint picker.
 */
export type UserMutation = { kind: 'deprecate'; id: number; reason: DeprecateReason };

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
  | { kind: 'request-archive-dump'; requestId: number }
  // Tiered timeseries query for a single named metric (design §9.1,
  // Phase 6 task 1). `requestId` correlates the request with the
  // matching `timeseries` reply. Unknown names return empty arrays,
  // not an error — the dashboard polls before any samples exist.
  | { kind: 'request-timeseries'; requestId: number; name: string }
  // Per-neuron structural event history (design §9.2, Phase 6 task 2).
  // Returns the archive's indexed copy of every birth / merge / split /
  // deprecate event the given neuron participates in. Empty list for
  // an unknown id — same contract as `request-timeseries`.
  | { kind: 'request-events-for-neuron'; requestId: number; neuronId: number }
  // Per-neuron footprint history query (design §9.3, Phase 6 task 3).
  // Returns every `(t, sparse A column)` snapshot the archive has
  // recorded for `neuronId`, ordered oldest→newest.
  | { kind: 'request-footprint-history'; requestId: number; neuronId: number }
  // Main-thread authored mutation (Phase 6 task 13). The orchestrator
  // forwards these to the fit worker so the UI can deprecate a
  // neuron, force a merge, etc. The worker pushes through the same
  // drain path an extend-generated mutation would take.
  | { kind: 'user-mutation'; mutation: UserMutation };

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
    }
  // Reply to `request-timeseries`. `l1*` arrays are the full-resolution
  // recent ring for `name`; `l2*` are downsampled older samples
  // (design §9.1 tiered retention). All arrays are fresh copies in
  // chronological order so the caller cannot mutate archive state.
  | {
      kind: 'timeseries';
      role: WorkerRole;
      requestId: number;
      name: string;
      l1Times: Float32Array;
      l1Values: Float32Array;
      l2Times: Float32Array;
      l2Values: Float32Array;
    }
  // Reply to `request-events-for-neuron`. `events` is a chronological
  // copy of the archive's per-neuron index for `neuronId`.
  | {
      kind: 'events-for-neuron';
      role: WorkerRole;
      requestId: number;
      neuronId: number;
      events: PipelineEvent[];
    }
  // Reply to `request-footprint-history`. `times` and the typed-array
  // payloads are parallel arrays of equal length (one entry per
  // stored snapshot, oldest→newest).
  | {
      kind: 'footprint-history';
      role: WorkerRole;
      requestId: number;
      neuronId: number;
      times: Float32Array;
      pixelIndices: Uint32Array[];
      values: Float32Array[];
    }
  // W1 preview frame for the dashboard viewer (design §12 frame panel,
  // Phase 5 exit). Strided like `frame-processed` so the post rate is
  // bounded even when W1 outruns the main-thread canvas; `pixels` is
  // an 8-bit grayscale projection of the preprocessed f32 frame
  // (post-autoscale) so the main thread can `putImageData` without
  // touching the SAB slot the fit worker is still reading.
  | {
      kind: 'frame-preview';
      role: WorkerRole;
      index: number;
      width: number;
      height: number;
      pixels: Uint8ClampedArray;
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
