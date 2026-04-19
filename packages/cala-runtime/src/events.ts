/**
 * Pipeline event bus (design §9.2, Phase 5 Task 17).
 *
 * Fit publishes compact `PipelineEvent` records; the archive worker
 * (and any UI-side debug sinks) subscribes. Drop-oldest under
 * pressure — archive is cosmetic, never functional, per §9.2.
 *
 * This is an in-process fan-out for now. The fit→archive boundary
 * crosses workers in Task 18; that swap replaces the internal ring
 * with a SAB-backed transport while keeping this public API stable.
 */

import type { DeprecateReason } from './mutation-queue.ts';

/**
 * Sparse footprint payload attached to structural events (design §9.3):
 * `(pixel_idx, value)` pairs. Typed arrays travel by reference here;
 * the SAB-backed transport in Task 18 will copy them into the event
 * ring for cross-worker delivery.
 */
export interface FootprintSnap {
  pixelIndices: Uint32Array;
  values: Float32Array;
}

/** Tagged union of every event variant the fit worker emits. */
export type PipelineEvent =
  | {
      kind: 'birth';
      t: number;
      id: number;
      patch: [number, number];
      footprintSnap: FootprintSnap;
    }
  | {
      kind: 'merge';
      t: number;
      ids: number[];
      into: number;
      footprintSnap: FootprintSnap;
    }
  | {
      kind: 'split';
      t: number;
      from: number;
      into: number[];
      footprintSnaps: FootprintSnap[];
    }
  | {
      kind: 'deprecate';
      t: number;
      id: number;
      reason: DeprecateReason;
    }
  | {
      kind: 'reject';
      t: number;
      at: [number, number];
      reason: string;
    }
  | {
      kind: 'metric';
      t: number;
      name: string;
      value: number;
    }
  // Periodic footprint snapshot emitted by fit (§9.3 log-spaced +
  // change-triggered schedule). Structural events already carry a
  // footprint; this variant covers the "quiet" frames where a neuron
  // hasn't merged/split but the scrubber still wants morph data.
  | {
      kind: 'footprint-snapshot';
      t: number;
      neuronId: number;
      footprint: FootprintSnap;
    };

export type Unsubscribe = () => void;

export interface EventBusConfig {
  /** Drop-oldest ring size. Events past this are discarded + counted. */
  capacity: number;
  /** Hard cap on concurrent subscribers. */
  maxSubscribers: number;
}

export interface EventBusStats {
  published: bigint;
  delivered: bigint;
  drops: bigint;
  subscribers: number;
}

export class EventBusSubscriberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventBusSubscriberError';
  }
}

function validateConfig(cfg: EventBusConfig): void {
  if (!Number.isInteger(cfg.capacity) || cfg.capacity < 1) {
    throw new Error(`EventBusConfig.capacity must be an integer ≥ 1 (got ${cfg.capacity})`);
  }
  if (!Number.isInteger(cfg.maxSubscribers) || cfg.maxSubscribers < 1) {
    throw new Error(
      `EventBusConfig.maxSubscribers must be an integer ≥ 1 (got ${cfg.maxSubscribers})`,
    );
  }
}

type Listener = (e: PipelineEvent) => void;

export class EventBus {
  private readonly cfg: EventBusConfig;
  private readonly subscribers = new Set<Listener>();
  private readonly buffer: PipelineEvent[] = [];
  private publishedCount = 0n;
  private deliveredCount = 0n;
  private dropCount = 0n;
  private closed = false;

  constructor(cfg: EventBusConfig) {
    validateConfig(cfg);
    this.cfg = cfg;
  }

  /**
   * Fit side. Fan-out to all subscribers synchronously. If no
   * subscriber drains, the internal ring fills and starts dropping
   * oldest. Once closed, `publish` is a no-op.
   */
  publish(e: PipelineEvent): void {
    if (this.closed) return;
    this.publishedCount += 1n;

    if (this.subscribers.size > 0) {
      // Hot stream: live subscribers get the event directly; no
      // buffering needed. Drop counter stays untouched.
      for (const cb of this.subscribers) {
        cb(e);
        this.deliveredCount += 1n;
      }
      return;
    }

    // No subscribers yet — buffer into the drop-oldest ring so
    // `stats().drops` reflects backpressure.
    if (this.buffer.length === this.cfg.capacity) {
      this.buffer.shift();
      this.dropCount += 1n;
    }
    this.buffer.push(e);
  }

  /**
   * Archive / main-thread side. Callback is invoked for every future
   * `publish`. Buffered events (from before any subscriber existed)
   * are NOT replayed — the bus is a hot stream per §9.2. Returns an
   * unsubscribe handle that is safe to call more than once.
   */
  subscribe(cb: Listener): Unsubscribe {
    if (this.closed) {
      throw new EventBusSubscriberError('cannot subscribe to a closed EventBus');
    }
    if (this.subscribers.size >= this.cfg.maxSubscribers) {
      throw new EventBusSubscriberError(
        `maxSubscribers ${this.cfg.maxSubscribers} reached (${this.subscribers.size} active)`,
      );
    }
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  stats(): EventBusStats {
    return {
      published: this.publishedCount,
      delivered: this.deliveredCount,
      drops: this.dropCount,
      subscribers: this.subscribers.size,
    };
  }

  /** Drops all subscribers and renders further `publish` calls inert. */
  close(): void {
    this.closed = true;
    this.subscribers.clear();
  }
}
