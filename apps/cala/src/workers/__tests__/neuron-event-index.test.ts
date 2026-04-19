import { describe, expect, it } from 'vitest';
import type { PipelineEvent } from '@calab/cala-runtime';
import {
  NeuronEventIndex,
  neuronIdsForEvent,
  type NeuronEventIndexConfig,
} from '../neuron-event-index.ts';

const TEST_CFG: NeuronEventIndexConfig = {
  maxNeurons: 3,
  perNeuronLimit: 3,
};

function birth(t: number, id: number): PipelineEvent {
  return {
    kind: 'birth',
    t,
    id,
    patch: [0, 0],
    footprintSnap: { pixelIndices: new Uint32Array(), values: new Float32Array() },
  };
}

function merge(t: number, ids: number[], into: number): PipelineEvent {
  return {
    kind: 'merge',
    t,
    ids,
    into,
    footprintSnap: { pixelIndices: new Uint32Array(), values: new Float32Array() },
  };
}

function split(t: number, from: number, into: number[]): PipelineEvent {
  return {
    kind: 'split',
    t,
    from,
    into,
    footprintSnaps: into.map(() => ({
      pixelIndices: new Uint32Array(),
      values: new Float32Array(),
    })),
  };
}

function deprecate(t: number, id: number): PipelineEvent {
  return { kind: 'deprecate', t, id, reason: 'traceInactive' };
}

describe('neuronIdsForEvent', () => {
  it('returns the id for birth + deprecate', () => {
    expect(neuronIdsForEvent(birth(0, 7))).toEqual([7]);
    expect(neuronIdsForEvent(deprecate(0, 7))).toEqual([7]);
  });

  it('includes survivor and all merged ids for merge', () => {
    expect(neuronIdsForEvent(merge(0, [1, 2], 1)).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(neuronIdsForEvent(merge(0, [1, 2], 5)).sort((a, b) => a - b)).toEqual([1, 2, 5]);
  });

  it('includes source and every child for split', () => {
    expect(neuronIdsForEvent(split(0, 9, [10, 11])).sort((a, b) => a - b)).toEqual([9, 10, 11]);
  });

  it('returns an empty array for reject + metric', () => {
    expect(neuronIdsForEvent({ kind: 'reject', t: 0, at: [0, 0], reason: 'low-snr' })).toEqual([]);
    expect(neuronIdsForEvent({ kind: 'metric', t: 0, name: 'x', value: 1 })).toEqual([]);
  });
});

describe('NeuronEventIndex', () => {
  it('validates positive-int config', () => {
    expect(() => new NeuronEventIndex({ ...TEST_CFG, maxNeurons: 0 })).toThrow();
    expect(() => new NeuronEventIndex({ ...TEST_CFG, perNeuronLimit: -1 })).toThrow();
  });

  it('returns an empty list for an unknown id', () => {
    const idx = new NeuronEventIndex(TEST_CFG);
    expect(idx.query(42)).toEqual([]);
  });

  it('records events under every referenced neuron', () => {
    const idx = new NeuronEventIndex(TEST_CFG);
    idx.record(birth(1, 7));
    idx.record(merge(2, [7, 8], 7));
    expect(idx.query(7).map((e) => e.kind)).toEqual(['birth', 'merge']);
    expect(idx.query(8).map((e) => e.kind)).toEqual(['merge']);
  });

  it('ignores events with no neuron ids', () => {
    const idx = new NeuronEventIndex(TEST_CFG);
    idx.record({ kind: 'metric', t: 0, name: 'x', value: 1 });
    idx.record({ kind: 'reject', t: 0, at: [0, 0], reason: 'low-snr' });
    expect(idx.knownIds()).toEqual([]);
  });

  it('drops oldest event per neuron once perNeuronLimit is exceeded', () => {
    const idx = new NeuronEventIndex(TEST_CFG);
    for (let t = 0; t < TEST_CFG.perNeuronLimit + 1; t += 1) {
      idx.record(birth(t, 9));
    }
    const history = idx.query(9);
    expect(history.length).toBe(TEST_CFG.perNeuronLimit);
    expect(history[0].t).toBe(1); // t=0 evicted.
  });

  it('drops oldest-inserted neuron once maxNeurons is exceeded', () => {
    const idx = new NeuronEventIndex(TEST_CFG);
    idx.record(birth(1, 1));
    idx.record(birth(2, 2));
    idx.record(birth(3, 3));
    idx.record(birth(4, 4)); // Evicts neuron 1.
    expect(idx.knownIds().sort((a, b) => a - b)).toEqual([2, 3, 4]);
    expect(idx.query(1)).toEqual([]);
  });

  it('returns a copy the caller can mutate without affecting the index', () => {
    const idx = new NeuronEventIndex(TEST_CFG);
    idx.record(birth(1, 5));
    const snap = idx.query(5);
    snap.push(birth(999, 5));
    expect(idx.query(5).length).toBe(1);
  });
});
