import { describe, it, expect } from 'vitest';
import {
  MutationQueue,
  snapshotEpoch,
  type PipelineMutation,
  type MutationQueueConfig,
} from '../mutation-queue.ts';

const CAP_SMALL: MutationQueueConfig = { capacity: 2 };
const CAP_MED: MutationQueueConfig = { capacity: 4 };
const CAP_LARGE: MutationQueueConfig = { capacity: 8 };
const CAP_OVERFLOW: MutationQueueConfig = { capacity: 4 };

function dep(id: number, epoch: bigint): PipelineMutation {
  return {
    type: 'deprecate',
    snapshotEpoch: epoch,
    id,
    reason: 'traceInactive',
  };
}

function reg(epoch: bigint): PipelineMutation {
  return {
    type: 'register',
    snapshotEpoch: epoch,
    class: 'cell',
    support: new Uint32Array([0, 1]),
    values: new Float32Array([0.5, 0.5]),
    trace: new Float32Array([0.0, 1.0, 2.0]),
  };
}

function merge(epoch: bigint, a: number, b: number): PipelineMutation {
  return {
    type: 'merge',
    snapshotEpoch: epoch,
    mergeIds: [a, b],
    class: 'neuropil',
    support: new Uint32Array([2, 3]),
    values: new Float32Array([0.5, 0.5]),
    trace: new Float32Array([1.0, 1.0, 1.0, 1.0, 1.0]),
  };
}

describe('MutationQueue config validation', () => {
  it('throws RangeError when capacity is 0', () => {
    expect(() => new MutationQueue({ capacity: 0 })).toThrow(RangeError);
    expect(() => new MutationQueue({ capacity: 0 })).toThrow(/capacity must be/);
  });

  it('throws RangeError when capacity is negative', () => {
    expect(() => new MutationQueue({ capacity: -1 })).toThrow(RangeError);
  });

  it('throws RangeError when capacity is not an integer', () => {
    expect(() => new MutationQueue({ capacity: 1.5 })).toThrow(RangeError);
  });
});

describe('MutationQueue initial state', () => {
  it('starts empty with configured capacity and zero drops', () => {
    const q = new MutationQueue(CAP_MED);
    expect(q.isEmpty).toBe(true);
    expect(q.isFull).toBe(false);
    expect(q.len).toBe(0);
    expect(q.capacity).toBe(CAP_MED.capacity);
    expect(q.drops).toBe(0n);
    expect(q.pop()).toBeNull();
  });
});

describe('MutationQueue push / pop FIFO', () => {
  it('push then pop returns the same element', () => {
    const q = new MutationQueue(CAP_MED);
    const m = dep(42, 7n);
    q.push(m);
    const out = q.pop();
    expect(out).toBe(m);
    expect(q.isEmpty).toBe(true);
  });

  it('push N, pop N preserves FIFO order (deprecate variant)', () => {
    const q = new MutationQueue(CAP_MED);
    q.push(dep(1, 10n));
    q.push(dep(2, 11n));
    q.push(dep(3, 12n));
    expect(q.len).toBe(3);
    expect(q.pop()!.snapshotEpoch).toBe(10n);
    expect(q.pop()!.snapshotEpoch).toBe(11n);
    expect(q.pop()!.snapshotEpoch).toBe(12n);
    expect(q.pop()).toBeNull();
    expect(q.drops).toBe(0n);
  });

  it('preserves FIFO across all three variants interleaved', () => {
    const q = new MutationQueue(CAP_LARGE);
    const a = reg(1n);
    const b = merge(2n, 0, 1);
    const c = dep(5, 3n);
    q.push(a);
    q.push(b);
    q.push(c);
    expect(q.pop()).toBe(a);
    expect(q.pop()).toBe(b);
    expect(q.pop()).toBe(c);
  });
});

describe('MutationQueue drop-oldest overflow', () => {
  it('drops oldest element when pushing onto full queue', () => {
    const q = new MutationQueue(CAP_SMALL);
    q.push(dep(1, 1n));
    q.push(dep(2, 2n));
    expect(q.isFull).toBe(true);
    q.push(dep(3, 3n));
    expect(q.drops).toBe(1n);
    expect(q.len).toBe(CAP_SMALL.capacity);

    const first = q.pop()!;
    expect(first.type).toBe('deprecate');
    if (first.type === 'deprecate') {
      expect(first.id).toBe(2);
    }
  });

  it('increments drops once per overflow push', () => {
    const q = new MutationQueue(CAP_SMALL);
    q.push(dep(1, 1n));
    q.push(dep(2, 2n));
    q.push(dep(3, 3n));
    q.push(dep(4, 4n));
    q.push(dep(5, 5n));
    expect(q.drops).toBe(3n);
    expect(q.len).toBe(CAP_SMALL.capacity);
  });

  it('does not increment drops when queue has room', () => {
    const q = new MutationQueue(CAP_MED);
    q.push(dep(1, 1n));
    q.push(dep(2, 2n));
    expect(q.drops).toBe(0n);
  });
});

describe('MutationQueue drainAll', () => {
  it('returns all elements in FIFO order and empties the queue', () => {
    const q = new MutationQueue(CAP_LARGE);
    for (let i = 0; i < 5; i++) {
      q.push(dep(i, BigInt(i)));
    }
    const drained = q.drainAll();
    expect(drained.length).toBe(5);
    drained.forEach((m, i) => {
      expect(m.snapshotEpoch).toBe(BigInt(i));
    });
    expect(q.isEmpty).toBe(true);
    expect(q.drops).toBe(0n);
  });

  it('preserves drops counter across drainAll', () => {
    const q = new MutationQueue(CAP_SMALL);
    q.push(dep(1, 1n));
    q.push(dep(2, 2n));
    q.push(dep(3, 3n));
    q.drainAll();
    expect(q.drops).toBe(1n);
    expect(q.isEmpty).toBe(true);
    q.push(dep(4, 4n));
    q.push(dep(5, 5n));
    q.push(dep(6, 6n));
    expect(q.drops).toBe(2n);
  });
});

describe('snapshotEpoch helper', () => {
  it('extracts epoch from register variant', () => {
    const m: PipelineMutation = {
      type: 'register',
      snapshotEpoch: 42n,
      class: 'cell',
      support: new Uint32Array([0, 1]),
      values: new Float32Array([0.5, 0.5]),
      trace: new Float32Array([0.0, 1.0, 2.0]),
    };
    expect(snapshotEpoch(m)).toBe(42n);
  });

  it('extracts epoch from merge variant', () => {
    const m: PipelineMutation = {
      type: 'merge',
      snapshotEpoch: 7n,
      mergeIds: [3, 4],
      class: 'neuropil',
      support: new Uint32Array([2, 3]),
      values: new Float32Array([0.5, 0.5]),
      trace: new Float32Array(5).fill(1.0),
    };
    expect(snapshotEpoch(m)).toBe(7n);
  });

  it('extracts epoch from deprecate variant', () => {
    const m: PipelineMutation = {
      type: 'deprecate',
      snapshotEpoch: 100n,
      id: 2,
      reason: 'footprintCollapsed',
    };
    expect(snapshotEpoch(m)).toBe(100n);
  });
});

describe('DeprecateReason round-trip', () => {
  it('all four reasons flow through the queue unchanged', () => {
    const reasons = ['footprintCollapsed', 'traceInactive', 'mergedInto', 'invalidApply'] as const;
    const q = new MutationQueue(CAP_LARGE);
    for (const reason of reasons) {
      q.push({
        type: 'deprecate',
        snapshotEpoch: 1n,
        id: 0,
        reason,
      });
    }
    const drained = q.drainAll();
    expect(drained.length).toBe(reasons.length);
    drained.forEach((m, i) => {
      expect(m.type).toBe('deprecate');
      if (m.type === 'deprecate') {
        expect(m.reason).toBe(reasons[i]);
      }
    });
  });
});

// Mirrors Rust test: mutation_queue_handles_many_overflows
// (crates/cala-core/tests/extending_mutation.rs).
describe('Rust parity: many overflows', () => {
  it('1000 pushes into capacity-4 queue leaves last 4, drops = 996', () => {
    const q = new MutationQueue(CAP_OVERFLOW);
    const total = 1000;
    for (let i = 0; i < total; i++) {
      q.push(dep(i, BigInt(i)));
    }
    expect(q.len).toBe(CAP_OVERFLOW.capacity);
    expect(q.drops).toBe(BigInt(total - CAP_OVERFLOW.capacity));

    const ids = q.drainAll().map((m) => {
      if (m.type !== 'deprecate') throw new Error('expected deprecate');
      return m.id;
    });
    expect(ids).toEqual([996, 997, 998, 999]);
  });
});
