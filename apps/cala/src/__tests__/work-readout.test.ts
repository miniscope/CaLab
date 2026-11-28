import { describe, expect, it } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createWorkReadout } from '../lib/work-readout-store.ts';
import type { RunHistory } from '../lib/run-history.ts';
import { emptyWork, type WorkStatus } from '../lib/work-meter.ts';
import type { SlowStatus } from '../workers/slow-types.ts';

const status = (wallMs: number, busyLive = 0): SlowStatus => {
  const w: WorkStatus = emptyWork(2);
  w.wallMs = wallMs;
  w.busyMs.live = busyLive;
  return { accounting: w, version: 1, run: 1, frame: 0 } as unknown as SlowStatus;
};

/** A readout over a fake History that records what it is told. */
function setup() {
  const calls: string[] = [];
  const history = {
    workOpen: () => calls.push('open'),
    work: (_r: unknown, _m: number, kindsOnly?: boolean) =>
      calls.push(kindsOnly ? 'kinds' : 'work'),
    target: () => calls.push('target'),
    births: () => {},
  } as unknown as RunHistory;
  return createRoot(() => {
    const [st, setSt] = createSignal('running');
    const readout = createWorkReadout({
      clock: () => 0,
      status: st,
      processed: () => 0,
      runHistory: history,
      gatePace: () => 0,
      paceStats: () => null,
      visitMaxFps: () => null,
    });
    return { readout, setSt, calls };
  });
}

describe('work readout and History', () => {
  it('opens the first interval at the first snapshot and writes a reading each period', () => {
    const { readout, calls } = setup();
    readout.onStatus(status(0));
    expect(calls).toEqual(['open']);
    readout.onStatus(status(500));
    expect(calls.filter((c) => c === 'work')).toHaveLength(0);
    readout.onStatus(status(1000, 300));
    expect(calls.filter((c) => c === 'work')).toHaveLength(1);
    expect(calls.at(-1)).toBe('target');
  });

  it("closes Discover's last interval early, once, with the work by kind only", () => {
    const { readout, setSt, calls } = setup();
    readout.onStatus(status(0));
    readout.onStatus(status(1000, 300));
    setSt('done');
    calls.length = 0;
    // Too soon after the last reading: nothing yet.
    readout.onStatus(status(1100, 330));
    expect(calls).toEqual([]);
    readout.onStatus(status(1300, 360));
    expect(calls).toEqual(['kinds']);
    // Later readings (the Final settle) stay out of History.
    readout.onStatus(status(2400, 600));
    readout.onStatus(status(3400, 900));
    expect(calls).toEqual(['kinds']);
  });

  it('peeks at the open interval while Discover runs, writing nothing', () => {
    const { readout, setSt, calls } = setup();
    expect(readout.workPeek()).toBeNull();
    readout.onStatus(status(0));
    readout.onStatus(status(100, 50));
    // Shorter than the shortest interval shown.
    expect(readout.workPeek()).toBeNull();
    readout.onStatus(status(500, 200));
    expect(readout.workPeek()?.slow.live).toBeCloseTo(0.4);
    expect(calls.filter((c) => c !== 'open')).toEqual([]);
    // The peek did not close the interval: the reading still comes at the period.
    readout.onStatus(status(1000, 300));
    expect(calls.filter((c) => c === 'work')).toHaveLength(1);
    readout.onStatus(status(1400, 400));
    expect(readout.workPeek()?.slow.live).toBeCloseTo(0.25);
    setSt('done');
    expect(readout.workPeek()).toBeNull();
  });
});
