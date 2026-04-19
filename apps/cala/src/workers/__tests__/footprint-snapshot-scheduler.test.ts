import { describe, expect, it } from 'vitest';
import type { FootprintSnap } from '@calab/cala-runtime';
import {
  FootprintSnapshotScheduler,
  type FootprintSnapshotSchedulerConfig,
} from '../footprint-snapshot-scheduler.ts';

const TEST_CFG: FootprintSnapshotSchedulerConfig = { maxTrackedNeurons: 4 };

function snap(px: number, v: number): FootprintSnap {
  return { pixelIndices: new Uint32Array([px]), values: new Float32Array([v]) };
}

describe('FootprintSnapshotScheduler', () => {
  it('rejects non-positive maxTrackedNeurons', () => {
    expect(() => new FootprintSnapshotScheduler({ maxTrackedNeurons: 0 })).toThrow();
    expect(() => new FootprintSnapshotScheduler({ maxTrackedNeurons: -1 })).toThrow();
  });

  it('emits at ages 1, 2, 4, 8, ... after birth', () => {
    const sched = new FootprintSnapshotScheduler(TEST_CFG);
    sched.onBirth(7, 10, snap(1, 0.1));

    // age=1 at t=11 → fires. nextAge advances to 2.
    expect(sched.tick(11).map((d) => d.t)).toEqual([11]);
    // age=2 at t=12 → fires (age ≥ nextAge=2). nextAge → 4.
    expect(sched.tick(12).map((d) => d.t)).toEqual([12]);
    // age=3 at t=13 → no fire (3 < 4).
    expect(sched.tick(13)).toEqual([]);
    // age=4 at t=14 → fires. nextAge → 8.
    expect(sched.tick(14).map((d) => d.t)).toEqual([14]);
    // t=17, age=7 → no fire.
    expect(sched.tick(17)).toEqual([]);
    // t=18, age=8 → fires.
    expect(sched.tick(18).map((d) => d.t)).toEqual([18]);
  });

  it('tracks multiple neurons independently', () => {
    const sched = new FootprintSnapshotScheduler(TEST_CFG);
    sched.onBirth(1, 0, snap(1, 1));
    sched.onBirth(2, 5, snap(2, 2));
    // Both hit nextAge=1 when frame is one past their respective births.
    const due = sched.tick(6);
    const ids = due.map((d) => d.neuronId).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2]);
  });

  it('onMutationFootprint refreshes the cached snap without resetting the schedule', () => {
    const sched = new FootprintSnapshotScheduler(TEST_CFG);
    sched.onBirth(7, 0, snap(1, 0.1));
    sched.tick(1); // advances nextAge from 1 to 2
    sched.onMutationFootprint(7, 5, snap(9, 0.9));
    // Next scheduled fire is at age=2 → t=2; we already passed it, so
    // the next tick with age ≥ 2 (t=5, age=5) fires and carries the
    // refreshed footprint rather than the original birth snap.
    const due = sched.tick(5);
    expect(due.length).toBe(1);
    expect(Array.from(due[0].footprint.pixelIndices)).toEqual([9]);
  });

  it('onDeprecate removes a neuron so no further snapshots fire', () => {
    const sched = new FootprintSnapshotScheduler(TEST_CFG);
    sched.onBirth(7, 0, snap(1, 1));
    sched.onDeprecate(7);
    expect(sched.tick(1)).toEqual([]);
    expect(sched.trackedIds()).toEqual([]);
  });

  it('drops oldest-inserted neuron once maxTrackedNeurons is exceeded', () => {
    const sched = new FootprintSnapshotScheduler({ maxTrackedNeurons: 2 });
    sched.onBirth(1, 0, snap(1, 1));
    sched.onBirth(2, 0, snap(2, 2));
    sched.onBirth(3, 0, snap(3, 3)); // Evicts 1.
    expect(sched.trackedIds().sort((a, b) => a - b)).toEqual([2, 3]);
  });
});
