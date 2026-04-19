/**
 * Per-neuron footprint history for the archive worker (design §9.3).
 *
 * Implements the **storage** side of the hybrid log-spaced +
 * change-triggered scheme. Snapshots arrive from three sources:
 *
 *  1. Structural events — every birth / merge / split carries a
 *     `FootprintSnap` by design. We harvest from these for free.
 *  2. Periodic `footprint-snapshot` events that W2 emits on the
 *     log-spaced schedule (task 5).
 *  3. Change-triggered snapshots W2 decides to emit out of band.
 *
 * This store does not decide *when* to snapshot — that's a fit-side
 * policy. It only bounds memory, keeps chronological order, and
 * answers queries.
 *
 * Typed-array payloads are kept by reference (same contract as
 * `EventBus` subscribers). Size is bounded by
 * `maxNeurons` × `perNeuronLimit` ceiling.
 */
import type { FootprintSnap } from '@calab/cala-runtime';

export interface FootprintHistoryStoreConfig {
  /** Drop-oldest ring size per neuron id. */
  perNeuronLimit: number;
  /** Hard cap on distinct neurons tracked (drop-oldest by insertion). */
  maxNeurons: number;
}

export interface FootprintHistoryEntry {
  t: number;
  pixelIndices: Uint32Array;
  values: Float32Array;
}

function validateConfig(cfg: FootprintHistoryStoreConfig): void {
  const check = (name: keyof FootprintHistoryStoreConfig, v: number): void => {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`FootprintHistoryStoreConfig.${name} must be an integer ≥ 1 (got ${v})`);
    }
  };
  check('perNeuronLimit', cfg.perNeuronLimit);
  check('maxNeurons', cfg.maxNeurons);
}

export class FootprintHistoryStore {
  private readonly cfg: FootprintHistoryStoreConfig;
  private readonly byNeuron = new Map<number, FootprintHistoryEntry[]>();

  constructor(cfg: FootprintHistoryStoreConfig) {
    validateConfig(cfg);
    this.cfg = cfg;
  }

  record(neuronId: number, t: number, snap: FootprintSnap): void {
    let list = this.byNeuron.get(neuronId);
    if (!list) {
      if (this.byNeuron.size >= this.cfg.maxNeurons) {
        const oldest = this.byNeuron.keys().next().value;
        if (oldest !== undefined) this.byNeuron.delete(oldest);
      }
      list = [];
      this.byNeuron.set(neuronId, list);
    }
    if (list.length === this.cfg.perNeuronLimit) list.shift();
    list.push({ t, pixelIndices: snap.pixelIndices, values: snap.values });
  }

  /** Snapshot copy, oldest→newest. Empty array for unknown neurons. */
  query(neuronId: number): FootprintHistoryEntry[] {
    const list = this.byNeuron.get(neuronId);
    return list ? list.slice() : [];
  }

  knownIds(): number[] {
    return Array.from(this.byNeuron.keys());
  }
}
