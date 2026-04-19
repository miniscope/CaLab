import { describe, expect, it } from 'vitest';
import { TimeseriesStore, type TimeseriesStoreConfig } from '../timeseries-store.ts';

// Small capacities keep tier transitions observable without relying on
// production defaults.
const TEST_L1: TimeseriesStoreConfig = {
  l1Capacity: 4,
  l2Capacity: 3,
  l2Stride: 2,
  maxNames: 4,
};

describe('TimeseriesStore', () => {
  it('rejects non-positive config values', () => {
    expect(() => new TimeseriesStore({ ...TEST_L1, l1Capacity: 0 })).toThrow();
    expect(() => new TimeseriesStore({ ...TEST_L1, l2Stride: -1 })).toThrow();
    expect(() => new TimeseriesStore({ ...TEST_L1, maxNames: 0 })).toThrow();
  });

  it('returns empty arrays for an unknown name', () => {
    const store = new TimeseriesStore(TEST_L1);
    const q = store.query('missing');
    expect(q.l1Times.length).toBe(0);
    expect(q.l1Values.length).toBe(0);
    expect(q.l2Times.length).toBe(0);
    expect(q.l2Values.length).toBe(0);
  });

  it('keeps L1 in chronological order while it is still filling', () => {
    const store = new TimeseriesStore(TEST_L1);
    store.append('fps', 0, 10);
    store.append('fps', 1, 20);
    store.append('fps', 2, 30);
    const q = store.query('fps');
    expect(Array.from(q.l1Times)).toEqual([0, 1, 2]);
    expect(Array.from(q.l1Values)).toEqual([10, 20, 30]);
    expect(q.l2Times.length).toBe(0);
  });

  it('evicts oldest L1 samples into the L2 block accumulator', () => {
    const store = new TimeseriesStore(TEST_L1);
    // l1Capacity=4, l2Stride=2: the first two L1 evictions (samples 0
    // and 1 below) aggregate into a single L2 sample at t=0.5.
    for (let i = 0; i < 6; i += 1) {
      store.append('fps', i, i * 10);
    }
    const q = store.query('fps');
    // L1 holds the newest 4 samples in order.
    expect(Array.from(q.l1Times)).toEqual([2, 3, 4, 5]);
    expect(Array.from(q.l1Values)).toEqual([20, 30, 40, 50]);
    // L2 has one averaged block from evicted samples (0, 10) → mean 5 at t=0.5.
    expect(Array.from(q.l2Times)).toEqual([0.5]);
    expect(Array.from(q.l2Values)).toEqual([5]);
  });

  it('drops oldest L2 sample once L2 capacity is exceeded', () => {
    const store = new TimeseriesStore(TEST_L1);
    // Need l1Capacity + l2Stride * (l2Capacity + 1) = 4 + 2*4 = 12 appends
    // to produce 4 L2 emissions (one more than l2Capacity=3).
    for (let i = 0; i < 12; i += 1) {
      store.append('fps', i, i);
    }
    const q = store.query('fps');
    expect(q.l2Times.length).toBe(TEST_L1.l2Capacity);
    // Oldest L2 block (from samples 0+1, mean 0.5 at t=0.5) has been
    // evicted; remaining blocks cover samples 2+3, 4+5, 6+7.
    expect(Array.from(q.l2Times)).toEqual([2.5, 4.5, 6.5]);
    expect(Array.from(q.l2Values)).toEqual([2.5, 4.5, 6.5]);
  });

  it('wraps L1 ring correctly so query returns a contiguous chronological slice', () => {
    const store = new TimeseriesStore(TEST_L1);
    for (let i = 0; i < TEST_L1.l1Capacity * 2 + 1; i += 1) {
      store.append('fps', i, i);
    }
    const q = store.query('fps');
    // Regardless of internal head position, the returned array is
    // strictly monotonically increasing in t.
    for (let i = 1; i < q.l1Times.length; i += 1) {
      expect(q.l1Times[i]).toBeGreaterThan(q.l1Times[i - 1]);
    }
  });

  it('tracks each name independently', () => {
    const store = new TimeseriesStore(TEST_L1);
    store.append('a', 0, 1);
    store.append('b', 0, 100);
    store.append('a', 1, 2);
    expect(Array.from(store.query('a').l1Values)).toEqual([1, 2]);
    expect(Array.from(store.query('b').l1Values)).toEqual([100]);
    expect(store.names().sort()).toEqual(['a', 'b']);
  });

  it('drops oldest-inserted name once maxNames is reached', () => {
    const store = new TimeseriesStore({ ...TEST_L1, maxNames: 2 });
    store.append('a', 0, 1);
    store.append('b', 0, 2);
    store.append('c', 0, 3); // Evicts 'a'.
    expect(store.names().sort()).toEqual(['b', 'c']);
    expect(store.query('a').l1Times.length).toBe(0);
  });
});
