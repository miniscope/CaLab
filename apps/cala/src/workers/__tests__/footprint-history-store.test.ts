import { describe, expect, it } from 'vitest';
import type { FootprintSnap } from '@calab/cala-runtime';
import {
  FootprintHistoryStore,
  type FootprintHistoryStoreConfig,
} from '../footprint-history-store.ts';

const TEST_CFG: FootprintHistoryStoreConfig = {
  perNeuronLimit: 3,
  maxNeurons: 3,
};

function snap(px: number, v: number): FootprintSnap {
  return { pixelIndices: new Uint32Array([px]), values: new Float32Array([v]) };
}

describe('FootprintHistoryStore', () => {
  it('validates positive-int config', () => {
    expect(() => new FootprintHistoryStore({ ...TEST_CFG, perNeuronLimit: 0 })).toThrow();
    expect(() => new FootprintHistoryStore({ ...TEST_CFG, maxNeurons: -1 })).toThrow();
  });

  it('returns an empty array for an unknown id', () => {
    const store = new FootprintHistoryStore(TEST_CFG);
    expect(store.query(7)).toEqual([]);
  });

  it('records snapshots in chronological order per neuron', () => {
    const store = new FootprintHistoryStore(TEST_CFG);
    store.record(7, 1, snap(1, 0.1));
    store.record(7, 2, snap(2, 0.2));
    store.record(8, 2, snap(10, 1));
    expect(store.query(7).map((e) => e.t)).toEqual([1, 2]);
    expect(Array.from(store.query(8)[0].pixelIndices)).toEqual([10]);
  });

  it('drops oldest snapshot per neuron once perNeuronLimit is reached', () => {
    const store = new FootprintHistoryStore(TEST_CFG);
    for (let t = 0; t < TEST_CFG.perNeuronLimit + 1; t += 1) {
      store.record(5, t, snap(t, t));
    }
    const hist = store.query(5);
    expect(hist.length).toBe(TEST_CFG.perNeuronLimit);
    expect(hist[0].t).toBe(1); // t=0 evicted.
  });

  it('drops oldest-inserted neuron once maxNeurons is reached', () => {
    const store = new FootprintHistoryStore(TEST_CFG);
    store.record(1, 0, snap(1, 1));
    store.record(2, 0, snap(2, 2));
    store.record(3, 0, snap(3, 3));
    store.record(4, 0, snap(4, 4)); // Evicts neuron 1.
    expect(store.knownIds().sort((a, b) => a - b)).toEqual([2, 3, 4]);
    expect(store.query(1)).toEqual([]);
  });

  it('returns snapshots by reference so the caller can inspect typed-array payloads', () => {
    const store = new FootprintHistoryStore(TEST_CFG);
    const s = snap(42, 0.9);
    store.record(5, 1, s);
    const out = store.query(5)[0];
    // Keeps the original typed arrays — no copy, no structural clone.
    expect(out.pixelIndices).toBe(s.pixelIndices);
    expect(out.values).toBe(s.values);
  });
});
