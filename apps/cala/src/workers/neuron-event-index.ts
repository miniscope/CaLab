/**
 * Per-neuron structural-event index for the archive worker
 * (design §9.2).
 *
 * The archive's flat event ring is great for the scrolling feed but
 * useless for "show me everything that happened to neuron 47" queries
 * — those walks are O(ring) and miss evicted history. This index
 * keeps, per neuron id, a small drop-oldest list of the birth /
 * merge / split / deprecate events the neuron participates in.
 *
 * Events are kept by reference (typed-array payloads live once in the
 * original `PipelineEvent`). Memory is bounded by `maxNeurons` and
 * `perNeuronLimit` — no magic numbers, everything caller-supplied.
 */
import type { PipelineEvent } from '@calab/cala-runtime';

export interface NeuronEventIndexConfig {
  /** Hard cap on distinct neurons tracked (drop-oldest by insertion). */
  maxNeurons: number;
  /** Drop-oldest ring size per neuron id. */
  perNeuronLimit: number;
}

function validateConfig(cfg: NeuronEventIndexConfig): void {
  const check = (name: keyof NeuronEventIndexConfig, v: number): void => {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`NeuronEventIndexConfig.${name} must be an integer ≥ 1 (got ${v})`);
    }
  };
  check('maxNeurons', cfg.maxNeurons);
  check('perNeuronLimit', cfg.perNeuronLimit);
}

/**
 * Returns the neuron ids an event involves, or an empty array for
 * events that aren't tied to specific neurons (`reject`, `metric`).
 */
export function neuronIdsForEvent(e: PipelineEvent): number[] {
  switch (e.kind) {
    case 'birth':
      return [e.id];
    case 'merge':
      // `into` is one of the merged ids in practice but we record it
      // on every merge target so queries for the survivor still land.
      return e.ids.includes(e.into) ? e.ids : [...e.ids, e.into];
    case 'split':
      return [e.from, ...e.into];
    case 'deprecate':
      return [e.id];
    case 'reject':
    case 'metric':
    case 'footprint-snapshot':
      // Periodic footprint snapshots are indexed by the footprint
      // store (§9.3), not the structural-event history.
      return [];
  }
}

export class NeuronEventIndex {
  private readonly cfg: NeuronEventIndexConfig;
  private readonly byNeuron = new Map<number, PipelineEvent[]>();

  constructor(cfg: NeuronEventIndexConfig) {
    validateConfig(cfg);
    this.cfg = cfg;
  }

  /** Index the event under every neuron it references. No-op otherwise. */
  record(e: PipelineEvent): void {
    const ids = neuronIdsForEvent(e);
    for (const id of ids) {
      let list = this.byNeuron.get(id);
      if (!list) {
        if (this.byNeuron.size >= this.cfg.maxNeurons) {
          const oldest = this.byNeuron.keys().next().value;
          if (oldest !== undefined) this.byNeuron.delete(oldest);
        }
        list = [];
        this.byNeuron.set(id, list);
      }
      if (list.length === this.cfg.perNeuronLimit) list.shift();
      list.push(e);
    }
  }

  /** Snapshot copy of the indexed history for `id`, oldest→newest. */
  query(id: number): PipelineEvent[] {
    const list = this.byNeuron.get(id);
    return list ? list.slice() : [];
  }

  /** Distinct neuron ids currently indexed (test introspection). */
  knownIds(): number[] {
    return Array.from(this.byNeuron.keys());
  }
}
