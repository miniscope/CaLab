/**
 * Runtime orchestrator (design §7, Phase 5 Task 18).
 *
 * Ties channels, mutation queue, snapshot protocol, and event bus
 * together into a single `RuntimeController` that `apps/cala` drives.
 * Workers are spawned via caller-provided factories — keeps the
 * orchestrator harness-testable without real `Worker` instances.
 *
 * Epoch semantics mirror `crates/cala-core/src/fitting/pipeline.rs`:
 * the counter advances only when fit acks a mutation-apply, not on
 * every frame.
 */

import { SabRingChannel } from './channel.ts';
import { MutationQueue } from './mutation-queue.ts';
import { SnapshotProtocol } from './asset-snapshot.ts';
import { EventBus } from './events.ts';
import type { ChannelConfig, ChannelStats } from './types.ts';
import type { EventBusConfig, EventBusStats, PipelineEvent, Unsubscribe } from './events.ts';
import type { MutationQueueConfig } from './mutation-queue.ts';
import type { SnapshotProtocolConfig, SnapshotProtocolStats } from './asset-snapshot.ts';
import type {
  UserMutation,
  WorkerFactory,
  WorkerLike,
  WorkerOutbound,
  WorkerRole,
} from './worker-protocol.ts';

const WORKER_ROLES: readonly WorkerRole[] = ['decodePreprocess', 'fit', 'extend', 'archive'];

export type RuntimeState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface RuntimeStatus {
  state: RuntimeState;
  epoch: bigint;
  framesProcessed: number;
  error?: string;
}

export interface RuntimeStats {
  frameChannel: ChannelStats;
  residualChannel: ChannelStats;
  mutationQueueDrops: bigint;
  mutationQueueCapacity: number;
  eventBus: EventBusStats;
  snapshotProtocol: SnapshotProtocolStats;
  epoch: bigint;
  framesProcessed: number;
  mutationsApplied: bigint;
}

/**
 * Opaque handle the runtime forwards to the decoder worker on init.
 * The runtime does not read from it — it just wires `source.file` and
 * `source.frameSourceFactory` through to W1, which owns decoding.
 */
export interface RuntimeSource {
  kind: 'file';
  file: File;
  frameSourceFactory: unknown;
}

export interface RuntimeConfig {
  workerFactories: Record<WorkerRole, WorkerFactory>;
  frameChannel: ChannelConfig;
  residualChannel: ChannelConfig;
  mutationQueue: MutationQueueConfig;
  snapshotProtocol: SnapshotProtocolConfig;
  eventBus: EventBusConfig;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  twoPassMode?: boolean;
  /**
   * Role-specific opaque config forwarded verbatim in each worker's
   * `init` message. Everything numerical lives here so the
   * orchestrator itself stays free of tuning literals.
   */
  workerConfigs?: Partial<Record<WorkerRole, unknown>>;
}

export interface RuntimeController {
  run(source: RuntimeSource): Promise<void>;
  stop(): Promise<void>;
  state(): RuntimeState;
  onStatus(cb: (s: RuntimeStatus) => void): Unsubscribe;
  onEvent(cb: (e: PipelineEvent) => void): Unsubscribe;
  epoch(): bigint;
  stats(): RuntimeStats;
  /**
   * Forward a user-authored mutation to the fit worker (design §7.3,
   * Phase 6 task 13). Currently only `deprecate` is modeled — extend
   * still owns all structural `register` / `merge` proposals. Silent
   * no-op when the runtime isn't running.
   */
  pushUserMutation(m: UserMutation): void;
}

export class RuntimeStartupTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeStartupTimeoutError';
  }
}

export class RuntimeShutdownTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeShutdownTimeoutError';
  }
}

export class RuntimeWorkerError extends Error {
  constructor(
    public readonly role: WorkerRole,
    message: string,
  ) {
    super(`[${role}] ${message}`);
    this.name = 'RuntimeWorkerError';
  }
}

function validateConfig(cfg: RuntimeConfig): void {
  for (const role of WORKER_ROLES) {
    if (typeof cfg.workerFactories[role] !== 'function') {
      throw new Error(`RuntimeConfig.workerFactories.${role} must be a function`);
    }
  }
  if (!Number.isFinite(cfg.startupTimeoutMs) || cfg.startupTimeoutMs <= 0) {
    throw new Error(
      `RuntimeConfig.startupTimeoutMs must be a positive number (got ${cfg.startupTimeoutMs})`,
    );
  }
  if (!Number.isFinite(cfg.shutdownTimeoutMs) || cfg.shutdownTimeoutMs <= 0) {
    throw new Error(
      `RuntimeConfig.shutdownTimeoutMs must be a positive number (got ${cfg.shutdownTimeoutMs})`,
    );
  }
}

type StatusListener = (s: RuntimeStatus) => void;

class Runtime implements RuntimeController {
  private readonly cfg: RuntimeConfig;
  private readonly statusListeners = new Set<StatusListener>();
  private readonly eventBus: EventBus;
  private readonly mutationQueue: MutationQueue;
  private readonly snapshotProtocol: SnapshotProtocol;

  private frameChannel: SabRingChannel | null = null;
  private residualChannel: SabRingChannel | null = null;
  private workers = new Map<WorkerRole, WorkerLike>();
  private workerListeners = new Map<WorkerRole, (ev: { data: WorkerOutbound }) => void>();

  private currentState: RuntimeState = 'idle';
  private currentEpoch = 0n;
  private frames = 0;
  private mutationsAppliedCount = 0n;
  private lastError?: string;

  private runDeferred: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private workersDoneCount = 0;
  private stopDeferred: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private stopHardTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cfg: RuntimeConfig) {
    validateConfig(cfg);
    this.cfg = cfg;
    this.eventBus = new EventBus(cfg.eventBus);
    this.mutationQueue = new MutationQueue(cfg.mutationQueue);
    this.snapshotProtocol = new SnapshotProtocol(cfg.snapshotProtocol);
  }

  state(): RuntimeState {
    return this.currentState;
  }

  epoch(): bigint {
    return this.currentEpoch;
  }

  onStatus(cb: StatusListener): Unsubscribe {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  onEvent(cb: (e: PipelineEvent) => void): Unsubscribe {
    return this.eventBus.subscribe(cb);
  }

  pushUserMutation(m: UserMutation): void {
    if (this.currentState !== 'running' && this.currentState !== 'starting') return;
    const fit = this.workers.get('fit');
    if (!fit) return;
    fit.postMessage({ kind: 'user-mutation', mutation: m });
  }

  stats(): RuntimeStats {
    const emptyChannelStats: ChannelStats = {
      framesWritten: 0,
      framesRead: 0,
      dropCount: 0,
      capacity: 0,
      inFlight: 0,
    };
    return {
      frameChannel: this.frameChannel?.stats() ?? emptyChannelStats,
      residualChannel: this.residualChannel?.stats() ?? emptyChannelStats,
      mutationQueueDrops: this.mutationQueue.drops,
      mutationQueueCapacity: this.mutationQueue.capacity,
      eventBus: this.eventBus.stats(),
      snapshotProtocol: this.snapshotProtocol.stats(),
      epoch: this.currentEpoch,
      framesProcessed: this.frames,
      mutationsApplied: this.mutationsAppliedCount,
    };
  }

  async run(source: RuntimeSource): Promise<void> {
    if (this.currentState !== 'idle' && this.currentState !== 'stopped') {
      throw new Error(`run() called from state '${this.currentState}'`);
    }

    this.resetPerRunState();
    this.transition('starting');

    try {
      this.frameChannel = new SabRingChannel(this.cfg.frameChannel);
      this.residualChannel = new SabRingChannel(this.cfg.residualChannel);
      await this.spawnAndHandshake(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.hardTerminateAll();
      this.transition('error');
      throw err;
    }

    this.transition('running');
    for (const worker of this.workers.values()) {
      worker.postMessage({ kind: 'run' });
    }

    return new Promise<void>((resolve, reject) => {
      this.runDeferred = { resolve, reject };
    });
    // TODO(phase 7): two-pass replay. When `cfg.twoPassMode` is set,
    // after the first pass resolves we re-open the file, seed fit
    // with the pass-1 `A`, and rerun with extend disabled.
  }

  async stop(): Promise<void> {
    if (
      this.currentState === 'idle' ||
      this.currentState === 'stopped' ||
      this.currentState === 'error'
    ) {
      return;
    }
    if (this.stopDeferred !== null) {
      return new Promise<void>((resolve, reject) => {
        const prev = this.stopDeferred!;
        this.stopDeferred = {
          resolve: () => {
            prev.resolve();
            resolve();
          },
          reject: (err) => {
            prev.reject(err);
            reject(err);
          },
        };
      });
    }

    this.transition('stopping');
    for (const worker of this.workers.values()) {
      worker.postMessage({ kind: 'stop' });
    }

    return new Promise<void>((resolve, reject) => {
      this.stopDeferred = { resolve, reject };
      this.stopHardTimer = setTimeout(() => {
        this.hardTerminateAll();
        const err = new RuntimeShutdownTimeoutError(
          `workers did not exit within ${this.cfg.shutdownTimeoutMs}ms`,
        );
        this.lastError = err.message;
        this.transition('error');
        const deferred = this.stopDeferred;
        this.stopDeferred = null;
        deferred?.reject(err);
        this.failRun(err);
      }, this.cfg.shutdownTimeoutMs);
    });
  }

  private resetPerRunState(): void {
    this.currentEpoch = 0n;
    this.frames = 0;
    this.mutationsAppliedCount = 0n;
    this.workersDoneCount = 0;
    this.lastError = undefined;
  }

  private async spawnAndHandshake(source: RuntimeSource): Promise<void> {
    const pending = new Set<WorkerRole>(WORKER_ROLES);
    let resolveReady: () => void;
    let rejectReady: (err: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    for (const role of WORKER_ROLES) {
      const worker = this.cfg.workerFactories[role]();
      const listener = (ev: { data: WorkerOutbound }): void => {
        const msg = ev.data;
        if (msg.kind === 'ready' && pending.has(role)) {
          pending.delete(role);
          if (pending.size === 0) resolveReady();
          return;
        }
        this.handleWorkerMessage(role, msg);
      };
      worker.addEventListener('message', listener);
      this.workers.set(role, worker);
      this.workerListeners.set(role, listener);
      worker.postMessage({
        kind: 'init',
        payload: {
          role,
          frameChannelBuffer: this.frameChannel!.sharedBuffer,
          residualChannelBuffer: this.residualChannel!.sharedBuffer,
          workerConfig: this.buildWorkerConfig(role, source),
        },
      });
    }

    const timeoutId = setTimeout(() => {
      if (pending.size === 0) return;
      rejectReady(
        new RuntimeStartupTimeoutError(
          `workers [${[...pending].join(', ')}] did not signal ready within ${this.cfg.startupTimeoutMs}ms`,
        ),
      );
    }, this.cfg.startupTimeoutMs);

    try {
      await readyPromise;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildWorkerConfig(role: WorkerRole, source: RuntimeSource): unknown {
    const override = this.cfg.workerConfigs?.[role];
    if (role === 'decodePreprocess') {
      // Structured-clone only the clonable fields of the source —
      // frameSourceFactory is an in-process hook, not a transferable.
      const clonable = { kind: source.kind, file: source.file };
      return { source: clonable, ...(override as object | undefined) };
    }
    return override ?? null;
  }

  private handleWorkerMessage(role: WorkerRole, msg: WorkerOutbound): void {
    switch (msg.kind) {
      case 'ready':
        // Late ready (after handshake) is ignored — already handled.
        return;
      case 'frame-processed':
        this.frames += 1;
        this.emitStatus();
        return;
      case 'mutation-applied':
        if (msg.epoch < this.currentEpoch) return; // enforce monotonicity
        this.currentEpoch = msg.epoch;
        this.mutationsAppliedCount += 1n;
        this.emitStatus();
        return;
      case 'snapshot-request': {
        const fit = this.workers.get('fit');
        if (!fit) return;
        const ack = {
          kind: 'snapshot-ack' as const,
          requestId: msg.requestId,
          epoch: this.currentEpoch,
          numComponents: 0,
          pixels: 0,
        };
        fit.postMessage(ack);
        // Extend is the snapshot consumer (design §7.2) — mirror the
        // ack so its epoch latch advances and its heartbeat can emit
        // the matching metric event.
        const extend = this.workers.get('extend');
        extend?.postMessage(ack);
        return;
      }
      case 'event': {
        this.eventBus.publish(msg.event);
        const archive = this.workers.get('archive');
        archive?.postMessage({ kind: 'event', event: msg.event });
        return;
      }
      case 'error': {
        const err = new RuntimeWorkerError(msg.role, msg.message);
        this.lastError = err.message;
        this.hardTerminateAll();
        this.transition('error');
        this.failRun(err);
        return;
      }
      case 'done':
        this.workersDoneCount += 1;
        if (this.workersDoneCount < WORKER_ROLES.length) return;
        if (this.stopDeferred !== null) {
          if (this.stopHardTimer !== null) {
            clearTimeout(this.stopHardTimer);
            this.stopHardTimer = null;
          }
          this.transition('stopped');
          const deferred = this.stopDeferred;
          this.stopDeferred = null;
          deferred.resolve();
          this.resolveRun();
        } else {
          this.transition('stopped');
          this.resolveRun();
        }
        return;
    }
  }

  private emitStatus(): void {
    const status: RuntimeStatus = {
      state: this.currentState,
      epoch: this.currentEpoch,
      framesProcessed: this.frames,
      error: this.lastError,
    };
    for (const cb of this.statusListeners) cb(status);
  }

  private transition(next: RuntimeState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.emitStatus();
  }

  private resolveRun(): void {
    const deferred = this.runDeferred;
    this.runDeferred = null;
    deferred?.resolve();
  }

  private failRun(err: Error): void {
    const deferred = this.runDeferred;
    this.runDeferred = null;
    deferred?.reject(err);
  }

  private hardTerminateAll(): void {
    for (const [role, worker] of this.workers) {
      const listener = this.workerListeners.get(role);
      if (listener) worker.removeEventListener('message', listener);
      try {
        worker.terminate();
      } catch {
        // best-effort — terminate() can throw on already-dead harness workers
      }
    }
    this.workers.clear();
    this.workerListeners.clear();
  }
}

export function createRuntime(cfg: RuntimeConfig): RuntimeController {
  return new Runtime(cfg);
}
