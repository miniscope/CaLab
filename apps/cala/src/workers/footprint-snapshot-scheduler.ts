/**
 * Log-spaced footprint-snapshot scheduler for the fit worker
 * (design §9.3, Phase 6 task 5).
 *
 * Implements the **log-spaced floor** of the §9.3 hybrid scheme: for
 * each tracked neuron, emit a snapshot at ages 1, 2, 4, 8, 16, ...
 * frames after birth. The **change-triggered** branch (ε > 0.05 Frob
 * drift) is left as a TODO — it needs per-frame access to the
 * current `A` column, which requires a new wasm-bindgen accessor on
 * `Fitter`. Until that lands, the log-spaced schedule is fed with
 * the last footprint attached to a mutation event (register / merge
 * / split), which is accurate at birth and at every structural event
 * but stale between them. Good enough to populate the scrubber UI
 * and exercise the archive's footprint store.
 *
 * Structural events (birth / merge / split) already carry full
 * snapshots and are stored on the archive side (task 3). This
 * scheduler only adds the *quiet-period* floor.
 */
import type { FootprintSnap } from '@calab/cala-runtime';

export interface FootprintSnapshotSchedulerConfig {
  /** Drop-oldest cap on tracked neurons. */
  maxTrackedNeurons: number;
}

export interface FootprintDueSnapshot {
  neuronId: number;
  t: number;
  footprint: FootprintSnap;
}

interface TrackedNeuron {
  birthFrame: number;
  nextAge: number;
  lastSnap: FootprintSnap;
}

function validateConfig(cfg: FootprintSnapshotSchedulerConfig): void {
  if (!Number.isInteger(cfg.maxTrackedNeurons) || cfg.maxTrackedNeurons < 1) {
    throw new Error(
      `FootprintSnapshotSchedulerConfig.maxTrackedNeurons must be ≥ 1 (got ${cfg.maxTrackedNeurons})`,
    );
  }
}

export class FootprintSnapshotScheduler {
  private readonly cfg: FootprintSnapshotSchedulerConfig;
  private readonly byNeuron = new Map<number, TrackedNeuron>();

  constructor(cfg: FootprintSnapshotSchedulerConfig) {
    validateConfig(cfg);
    this.cfg = cfg;
  }

  /** Start tracking a newly born neuron. Called on `register` mutations. */
  onBirth(neuronId: number, t: number, snap: FootprintSnap): void {
    this.upsert(neuronId, {
      birthFrame: t,
      nextAge: 1,
      lastSnap: snap,
    });
  }

  /**
   * Refresh the cached footprint for a neuron that already exists
   * (merge survivor, split child, or any other structural change).
   * If the id isn't tracked yet, treats it as a birth at `t`.
   */
  onMutationFootprint(neuronId: number, t: number, snap: FootprintSnap): void {
    const existing = this.byNeuron.get(neuronId);
    if (existing) {
      existing.lastSnap = snap;
      return;
    }
    this.upsert(neuronId, { birthFrame: t, nextAge: 1, lastSnap: snap });
  }

  /** Stop tracking a deprecated neuron. No-op if absent. */
  onDeprecate(neuronId: number): void {
    this.byNeuron.delete(neuronId);
  }

  /**
   * Advance schedules to frame `t`. Returns every (neuron, snap)
   * pair that becomes due at this frame and bumps its `nextAge` to
   * the next power of two.
   */
  tick(t: number): FootprintDueSnapshot[] {
    const due: FootprintDueSnapshot[] = [];
    for (const [neuronId, state] of this.byNeuron) {
      const age = t - state.birthFrame;
      if (age >= state.nextAge) {
        due.push({ neuronId, t, footprint: state.lastSnap });
        state.nextAge *= 2;
      }
    }
    return due;
  }

  trackedIds(): number[] {
    return Array.from(this.byNeuron.keys());
  }

  private upsert(neuronId: number, value: TrackedNeuron): void {
    if (!this.byNeuron.has(neuronId) && this.byNeuron.size >= this.cfg.maxTrackedNeurons) {
      const oldest = this.byNeuron.keys().next().value;
      if (oldest !== undefined) this.byNeuron.delete(oldest);
    }
    this.byNeuron.set(neuronId, value);
  }
}
