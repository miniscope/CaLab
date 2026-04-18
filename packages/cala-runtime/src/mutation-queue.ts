/**
 * Bounded FIFO mutation queue with drop-oldest backpressure
 * (design §7.3, Phase 3 Task 9 / Phase 5 Task 16).
 *
 * TypeScript port of `crates/cala-core/src/extending/mutation.rs`. Single-
 * threaded harness stand-in for the real SAB ring that lands with the
 * orchestrator in Task 18 — semantics (FIFO, drop-oldest, epoch tagging,
 * drops counter) match the Rust source of truth field-for-field so fit-
 * side apply logic can be exercised without workers.
 */

/** Monotonic asset-state counter incremented by every mutation apply. */
export type Epoch = bigint;

/** Mirrors `crate::config::ComponentClass`. */
export type ComponentClass = 'cell' | 'slowBaseline' | 'neuropil';

/** Mirrors `crate::extending::mutation::DeprecateReason` (all four variants). */
export type DeprecateReason =
  | 'footprintCollapsed'
  | 'traceInactive'
  | 'mergedInto'
  | 'invalidApply';

/**
 * One self-contained change to the model state. Carries its own snapshot
 * epoch so fit can decide whether to apply or discard (Task 10). Mirrors
 * the Rust enum variants `Register`, `Merge`, `Deprecate`.
 */
export type PipelineMutation =
  | {
      type: 'register';
      snapshotEpoch: Epoch;
      class: ComponentClass;
      support: Uint32Array;
      values: Float32Array;
      trace: Float32Array;
    }
  | {
      type: 'merge';
      snapshotEpoch: Epoch;
      mergeIds: [number, number];
      class: ComponentClass;
      support: Uint32Array;
      values: Float32Array;
      trace: Float32Array;
    }
  | {
      type: 'deprecate';
      snapshotEpoch: Epoch;
      id: number;
      reason: DeprecateReason;
    };

/** Config for {@link MutationQueue}. Capacity is required and must be ≥ 1. */
export interface MutationQueueConfig {
  capacity: number;
}

/** Extracts the snapshot epoch from any mutation variant. */
export function snapshotEpoch(m: PipelineMutation): Epoch {
  return m.snapshotEpoch;
}

export class MutationQueue {
  private readonly cap: number;
  private readonly buf: PipelineMutation[] = [];
  private dropCount = 0n;

  constructor(cfg: MutationQueueConfig) {
    if (!Number.isInteger(cfg.capacity) || cfg.capacity < 1) {
      throw new RangeError(`capacity must be ≥ 1 (got ${cfg.capacity})`);
    }
    this.cap = cfg.capacity;
  }

  get capacity(): number {
    return this.cap;
  }

  get len(): number {
    return this.buf.length;
  }

  get isEmpty(): boolean {
    return this.buf.length === 0;
  }

  get isFull(): boolean {
    return this.buf.length === this.cap;
  }

  /** Total mutations dropped due to overflow since construction. */
  get drops(): bigint {
    return this.dropCount;
  }

  /**
   * Append a mutation. When the queue is at capacity, the oldest entry
   * is evicted and {@link drops} advances by 1 — matches Rust
   * `pop_front` + `saturating_add(1)` + `push_back`.
   */
  push(m: PipelineMutation): void {
    if (this.buf.length === this.cap) {
      this.buf.shift();
      this.dropCount += 1n;
    }
    this.buf.push(m);
  }

  /** Pop the oldest queued mutation, or `null` when empty. */
  pop(): PipelineMutation | null {
    return this.buf.shift() ?? null;
  }

  /** Drain the queue in FIFO order. Does not reset the drops counter. */
  drainAll(): PipelineMutation[] {
    return this.buf.splice(0, this.buf.length);
  }
}
