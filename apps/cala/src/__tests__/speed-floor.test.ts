// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  FLOOR,
  FLOOR_LADDER,
  FloorMeter,
  FloorTracker,
  NEED_RATE,
  floorText,
  snapToLadder,
  speedFloor,
  workCapacities,
  type FloorInputs,
} from '../lib/speed-floor.ts';
import { emptyLookbackWork, emptyWork, type WorkStatus } from '../lib/work-meter.ts';
import { LOOKBACK } from '../lib/slow-runner.ts';

const base: FloorInputs = {
  cap: 2,
  needRate: 2,
  needActive: 1,
  settleWorkers: 0,
  needFpsPerWorker: 95,
  settleFpsPerWorker: 95,
  slowLiveMs: 8.4,
  slowVisitMs: 2.5,
  slowNeedMs: 1.45,
  slowSettleMs: 4.6,
  visitWorkers: 4,
  visitMs: 20,
  maxFps: 300,
  measuredAt: 'paced',
};
const samara: FloorInputs = {
  ...base,
  needFpsPerWorker: 150,
  settleFpsPerWorker: 150,
  slowLiveMs: 5,
  slowVisitMs: 1,
  slowNeedMs: 0.6,
  slowSettleMs: 1.92,
};
const nulls: Partial<FloorInputs> = {
  needFpsPerWorker: null,
  settleFpsPerWorker: null,
  slowLiveMs: null,
  slowVisitMs: null,
  slowNeedMs: null,
  slowSettleMs: null,
  visitMs: null,
  maxFps: null,
};

describe('speedFloor: worked examples', () => {
  it('workshop, one worker taking turns: look-back, 21', () => {
    const e = speedFloor({ ...base, settleWorkers: 0 });
    expect(Math.abs(e.fps - 21)).toBeLessThanOrEqual(1);
    expect(e.limiting).toBe('look-back');
    expect(e.confidence).toBe('paced');
  });
  it('workshop, one settle worker: slow worker, 37', () => {
    const e = speedFloor({ ...base, settleWorkers: 1 });
    expect(Math.abs(e.fps - 37)).toBeLessThanOrEqual(1);
    expect(e.limiting).toBe('slow-worker');
    expect(e.seeAllFps).toBeGreaterThan(55);
  });
  it('Samara, S = 0: look-back, 34', () => {
    const e = speedFloor({ ...samara, settleWorkers: 0 });
    expect(Math.abs(e.fps - 34)).toBeLessThanOrEqual(1);
    expect(e.limiting).toBe('look-back');
    expect(e.terms.slowWorker).toBeCloseTo(77, 0);
  });
  it('Samara, S = 1: look-back, 68', () => {
    const e = speedFloor({ ...samara, settleWorkers: 1 });
    expect(Math.abs(e.fps - 68)).toBeLessThanOrEqual(1);
    expect(e.limiting).toBe('look-back');
  });
});

describe('speedFloor: properties', () => {
  it('is monotone: lower cap, more settle workers, faster slow worker never lower the floor', () => {
    for (const b of [base, samara]) {
      for (const S of [0, 1, 2]) {
        let prev = -1;
        for (const cap of [4, 2, 1, 0.5, 0]) {
          const f = speedFloor({ ...b, settleWorkers: S, cap }).fps;
          expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = f;
        }
      }
      let prev = -1;
      for (const S of [0, 1, 2, 3]) {
        const f = speedFloor({ ...b, settleWorkers: S }).fps;
        expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = f;
      }
      prev = Infinity;
      for (const scale of [0.5, 1, 1.5, 3]) {
        const f = speedFloor({
          ...b,
          settleWorkers: 1,
          slowLiveMs: b.slowLiveMs! * scale,
          slowVisitMs: b.slowVisitMs! * scale,
          slowNeedMs: b.slowNeedMs! * scale,
          slowSettleMs: b.slowSettleMs! * scale,
        }).fps;
        expect(f).toBeLessThanOrEqual(prev + 1e-9);
        prev = f;
      }
    }
  });

  it('cap 0 drops the settle terms; with no cell in need as well, the floor is seeAllFps', () => {
    const e = speedFloor({ ...base, settleWorkers: 1, cap: 0 });
    expect(e.terms.lookbackSettle).toBeNull();
    const e0 = speedFloor({ ...base, settleWorkers: 1, cap: 0, needActive: 0 });
    expect(e0.terms.lookbackNeed).toBeNull();
    expect(e0.terms.lookbackSettle).toBeNull();
    expect(e0.fps).toBe(e0.seeAllFps);
    const e1 = speedFloor({ ...base, settleWorkers: 0, cap: 0, needActive: 0 });
    expect(e1.fps).toBe(e1.seeAllFps);
    expect(e1.limiting).toBe('slow-worker');
  });

  it('all inputs null gives the prior', () => {
    const t = speedFloor({ ...base, ...nulls, settleWorkers: 0, measuredAt: 'none' });
    expect(t.fps).toBe(FLOOR.priorFps.turnTaking);
    expect(t.confidence).toBe('prior');
    const p = speedFloor({ ...base, ...nulls, settleWorkers: 1, measuredAt: 'none' });
    expect(p.fps).toBe(FLOOR.priorFps.pool);
    expect(p.confidence).toBe('prior');
  });

  it('a missing cost makes a term unknown, not zero', () => {
    const e = speedFloor({ ...base, settleWorkers: 1, slowSettleMs: null });
    expect(e.terms.slowWorker).toBeNull();
    expect(e.fps).toBeCloseTo(42.75, 1);
  });

  it('clamps to the hard minimum and to maxShare x maxFps, with the reason', () => {
    const low = speedFloor({ ...base, needFpsPerWorker: 10 });
    expect(low.fps).toBe(FLOOR.hardMinFps);
    expect(low.limiting).toBe('minimum');
    const m = speedFloor({ ...samara, settleWorkers: 1, maxFps: 50 });
    expect(m.fps).toBeCloseTo(45, 6);
    expect(m.limiting).toBe('max');
    expect(m.seeAllFps).toBeCloseTo(45, 6);
  });

  it('unpaced scales the slow-worker term and seeAllFps, not the look-back terms; paced scales nothing', () => {
    const paced = speedFloor({ ...base, settleWorkers: 1, measuredAt: 'paced' });
    const un = speedFloor({ ...base, settleWorkers: 1, measuredAt: 'unpaced' });
    expect(un.terms.slowWorker!).toBeCloseTo(paced.terms.slowWorker! * FLOOR.unpacedFactor, 9);
    expect(un.seeAllFps).toBeCloseTo(paced.seeAllFps * FLOOR.unpacedFactor, 6);
    expect(un.terms.lookbackNeed).toBe(paced.terms.lookbackNeed);
    expect(un.terms.lookbackSettle).toBe(paced.terms.lookbackSettle);
    expect(un.confidence).toBe('unpaced');
    expect(paced.confidence).toBe('paced');
  });

  it('a low visit term stays out of the minimum while visitsBind is false, but is in terms', () => {
    const inp = { ...samara, settleWorkers: 1, visitMs: 200 };
    const off = speedFloor(inp, { ...FLOOR, visitsBind: false });
    expect(off.terms.visits).toBeCloseTo(18, 6);
    expect(off.fps).toBeCloseTo(67.5, 6);
    const on = speedFloor(inp, { ...FLOOR, visitsBind: true });
    expect(on.fps).toBeCloseTo(18, 6);
    expect(on.limiting).toBe('visits');
  });
});

/** A snapshot pair shaped like the #462 run "60 fps, S = 1" (synthetic: 10 s, 60 fps). */
function pair(): [WorkStatus, WorkStatus] {
  const a = emptyWork(4);
  a.wallMs = 20_000;
  a.observedFrames = 1200;
  const b = emptyWork(4);
  b.wallMs = 30_000;
  b.observedFrames = 1800;
  // 11 ms per live frame: live + housekeep + publish.
  b.busyMs.live = 4800;
  b.busyMs.housekeep = 1000;
  b.busyMs.publish = 800;
  b.busyMs.visit = 900;
  b.visitBusyMs = [4000, 4000, 4000, 4000];
  // Need-driven: 3000 busy ms at 150 frames/s = 450 frames, 1.45 ms each on the slow worker.
  b.lookback.need = { ...emptyLookbackWork(), answers: 30, frames: 450, solveMs: 3000 };
  b.busyMs.need = 450 * 1.45;
  // Settle: 6000 ms at 150 frames/s = 900 frames, 4.6 ms each on the slow worker.
  b.lookback.csettle = { ...emptyLookbackWork(), answers: 60, frames: 900, solveMs: 6000 };
  b.busyMs.csettle = 900 * 4.6;
  b.settleWorkers = 1;
  return [a, b];
}

describe('workCapacities', () => {
  it('reads the look-back rate per worker and the slow worker per live frame from a #462-shaped pair', () => {
    const [a, b] = pair();
    const c = workCapacities(a, b)!;
    expect(c).not.toBeNull();
    expect(c.needFpsPerWorker).toBeGreaterThanOrEqual(140);
    expect(c.needFpsPerWorker).toBeLessThanOrEqual(160);
    expect(c.settleFpsPerWorker).toBeGreaterThanOrEqual(140);
    expect(c.settleFpsPerWorker).toBeLessThanOrEqual(160);
    expect(c.slowLiveMs).toBeGreaterThan(10);
    expect(c.slowLiveMs).toBeLessThan(12);
    expect(c.slowNeedMs).toBeCloseTo(1.45, 6);
    expect(c.slowSettleMs).toBeCloseTo(4.6, 6);
    expect(c.slowVisitMs).toBeCloseTo(1.5, 6);
    expect(c.visitWorkers).toBe(4);
    expect(c.visitMs).toBeCloseTo(16000 / 600, 6);
    expect(c.settleWorkers).toBe(1);
    expect(c.observedFrames).toBe(600);
  });

  it('is null for a pair too close, backwards, or without observed frames', () => {
    const [a, b] = pair();
    expect(workCapacities(a, { ...b, wallMs: a.wallMs + 2000 })).toBeNull();
    expect(workCapacities(b, a)).toBeNull();
    expect(workCapacities(a, { ...b, observedFrames: undefined })).toBeNull();
    expect(workCapacities(a, { ...b, observedFrames: a.observedFrames })).toBeNull();
  });

  it('skips the need rate when worker 0 was busy on need under 250 ms', () => {
    const [a, b] = pair();
    b.lookback.need.solveMs = 200;
    expect(workCapacities(a, b)!.needFpsPerWorker).toBeNull();
  });

  it('falls back for the settle figures: prior rate, then the need rate; end duty, then 0.55 x live', () => {
    const [a, b] = pair();
    b.lookback.csettle = emptyLookbackWork();
    b.busyMs.csettle = 0;
    const c = workCapacities(a, b, { priorSettleFps: 120 })!;
    expect(c.settleFpsPerWorker).toBe(120);
    expect(c.slowSettleMs).toBeCloseTo(0.55 * c.slowLiveMs!, 9);
    expect(workCapacities(a, b)!.settleFpsPerWorker).toBeCloseTo(150, 6);
    b.lookback.end = { ...emptyLookbackWork(), frames: 100, solveMs: 500 };
    b.busyMs.end = 460;
    expect(workCapacities(a, b)!.slowSettleMs).toBeCloseTo(4.6, 6);
  });

  it('reports no visit cost when the visit workers were saturated', () => {
    const [a, b] = pair();
    b.visitBusyMs = [9500, 9500, 9500, 9500];
    expect(workCapacities(a, b)!.visitMs).toBeNull();
  });

  it('feeds speedFloor end to end', () => {
    const [a, b] = pair();
    const c = workCapacities(a, b)!;
    const e = speedFloor({ ...base, ...c, settleWorkers: 1 });
    expect(e.confidence).toBe('paced');
    expect(e.fps).toBeGreaterThan(30);
  });
});

describe('FloorTracker', () => {
  const run = (tr: FloorTracker, from: number, evals: number, inp: FloorInputs, frozen = false) => {
    const changes: boolean[] = [];
    for (let e = 0; e < evals; e++) {
      const t = from + e * 5000;
      changes.push(tr.update(t, inp, frozen));
    }
    return changes;
  };
  // Look-back-limited, S = 0: floor = 0.9 x L / 4, so L = floor x 4 / 0.9.
  const at = (fps: number): FloorInputs => ({
    ...base,
    slowLiveMs: 1,
    slowVisitMs: 0,
    needFpsPerWorker: (fps * 4) / 0.9,
  });

  it('snaps down to the ladder', () => {
    expect(snapToLadder(68)).toBe(60);
    expect(snapToLadder(37)).toBe(30);
    expect(snapToLadder(34)).toBe(30);
    expect(snapToLadder(21)).toBe(20);
    expect(snapToLadder(3)).toBe(10);
    expect(snapToLadder(999)).toBe(300);
    expect(FLOOR_LADDER[0]).toBe(10);
  });

  it('publishes on the first evaluation, then ignores +-10% noise', () => {
    const tr = new FloorTracker();
    expect(run(tr, 0, 1, at(30))[0]).toBe(true);
    expect(tr.published).toBe(30);
    // Noise around 31: +-10 % never reaches 40 or drops below 25.
    let changed = false;
    for (let k = 0; k < 60; k++) {
      const f = 31 * (1 + (k % 2 === 0 ? 0.1 : -0.1));
      changed ||= tr.update(5000 * (k + 1), at(f));
    }
    expect(changed).toBe(false);
    expect(tr.published).toBe(30);
  });

  it('moves after three evaluations in a row past the next step, not before', () => {
    const tr = new FloorTracker({ ...FLOOR }, { averageMs: 1, evalEveryMs: 5000, confirm: 3 });
    run(tr, 0, 1, at(30));
    // Two ladder steps up (30 -> 50 is two steps: 40, 50).
    const ch = run(tr, 5000, 4, at(52));
    expect(ch).toEqual([false, false, true, false]);
    expect(tr.published).toBe(50);
    // And two steps down (50 -> 30).
    const down = run(tr, 30_000, 4, at(31));
    expect(down).toEqual([false, false, true, false]);
    expect(tr.published).toBe(30);
  });

  it('an interrupted run of evaluations does not count', () => {
    const tr = new FloorTracker({ ...FLOOR }, { averageMs: 1, evalEveryMs: 5000, confirm: 3 });
    run(tr, 0, 1, at(30));
    run(tr, 5000, 2, at(52));
    run(tr, 15_000, 1, at(31));
    expect(run(tr, 20_000, 2, at(52))).toEqual([false, false]);
    expect(tr.published).toBe(30);
  });

  it('is frozen while frozen: no change, no samples', () => {
    const tr = new FloorTracker({ ...FLOOR }, { averageMs: 1, evalEveryMs: 5000, confirm: 3 });
    run(tr, 0, 1, at(30));
    expect(run(tr, 5000, 10, at(100), true).some(Boolean)).toBe(false);
    expect(tr.published).toBe(30);
    // Two evaluations after the freeze are not enough; frozen ones did not count.
    expect(run(tr, 60_000, 2, at(100))).toEqual([false, false]);
    expect(tr.published).toBe(30);
  });

  it('averages the inputs over the window', () => {
    const tr = new FloorTracker();
    tr.update(0, at(20));
    tr.update(5000, at(40));
    // Averaged L gives a raw floor of 30, not the latest 40.
    expect(tr.estimate!.fps).toBeCloseTo(30, 6);
  });

  it('can be seeded from an earlier run', () => {
    const tr = new FloorTracker();
    tr.seed(68);
    expect(tr.published).toBe(60);
  });
});

describe('FloorMeter and floorText', () => {
  it('keeps NEED_RATE equal to LOOKBACK.rate', () => {
    expect(NEED_RATE).toBe(LOOKBACK.rate);
  });

  it('measures from a stream of snapshots, freezes without a library, and prints the readout', () => {
    const m = new FloorMeter();
    expect(floorText(m)).toMatch(/not measured/);
    const [a, b] = pair();
    const feed = (w: WorkStatus, haveLibrary: boolean) =>
      m.push({
        work: w,
        inNeed: 5,
        cap: 2,
        needRate: 2,
        target: 60,
        maxFps: 300,
        paused: false,
        haveLibrary,
      });
    feed(a, true);
    expect(feed(b, false)).toBe(false);
    expect(m.tracker.published).toBeNull();
    expect(feed(b, true)).toBe(false); // throttled: the same second
    expect(feed({ ...b, wallMs: b.wallMs + 1000 }, true)).toBe(true);
    expect(m.tracker.published).not.toBeNull();
    const text = floorText(m);
    expect(text).toMatch(/^floor \d+ fps/);
    expect(text).toMatch(/set by/);
    expect(text).toMatch(/measured/);
    // A run that restarts (wall time goes back) starts over.
    feed(a, true);
    expect(m.last).toBeNull();
  });
});

/** One look-back worker (S = 0) doing both kinds: a ten-second pair with chosen busy times. */
function turnTaking(o: {
  obs: number;
  needBusy: number;
  needFrames: number;
  settleBusy: number;
  settleFrames: number;
}): [WorkStatus, WorkStatus] {
  const a = emptyWork(0);
  a.wallMs = 0;
  a.observedFrames = 0;
  const b = emptyWork(0);
  b.wallMs = 10_000;
  b.observedFrames = o.obs;
  b.settleWorkers = 0;
  b.busyMs.live = 2 * o.obs;
  b.busyMs.visit = 1 * o.obs;
  b.lookback.need = {
    ...emptyLookbackWork(),
    answers: 1,
    frames: o.needFrames,
    solveMs: o.needBusy,
  };
  b.lookback.csettle = {
    ...emptyLookbackWork(),
    answers: 1,
    frames: o.settleFrames,
    solveMs: o.settleBusy,
  };
  b.busyMs.need = 1.45 * o.needFrames;
  b.busyMs.csettle = 4.6 * o.settleFrames;
  return [a, b];
}

describe('S = 0 look-back rate when worker 0 gave little need time', () => {
  const floorOf = (pairs: [WorkStatus, WorkStatus], needActive: number) => {
    const c = workCapacities(...pairs)!;
    return speedFloor({
      ...base,
      ...c,
      needActive,
      settleWorkers: 0,
      slowLiveMs: 2,
      slowVisitMs: 1,
    });
  };
  it('paced at 10 fps with cells in need: look-back sets about 21, not the slow worker', () => {
    // 100 live frames, 300 ms of need work (under 20 % of the span), the rest settle: 95 frames/s.
    const e = floorOf(
      turnTaking({
        obs: 100,
        needBusy: 300,
        needFrames: 28.5,
        settleBusy: 2000,
        settleFrames: 190,
      }),
      1,
    );
    expect(e.terms.lookbackNeed).toBeCloseTo(21.4, 0);
    expect(e.limiting).toBe('look-back');
    expect(e.fps).toBeLessThan(25);
  });
  it('needActive 0.3 at 30 fps: the settle rate stands in below 250 ms of need time', () => {
    const e = floorOf(
      turnTaking({ obs: 300, needBusy: 100, needFrames: 9.5, settleBusy: 4000, settleFrames: 380 }),
      0.3,
    );
    expect(e.terms.lookbackNeed).toBeCloseTo((0.9 * 95) / 2.6, 0);
    expect(e.limiting).toBe('look-back');
  });
  it('no cells in need: the settle rate still gives the look-back term', () => {
    const e = floorOf(
      turnTaking({ obs: 300, needBusy: 0, needFrames: 0, settleBusy: 4000, settleFrames: 380 }),
      0,
    );
    expect(e.terms.lookbackNeed).toBeCloseTo((0.9 * 95) / 2, 0);
    expect(e.limiting).toBe('look-back');
  });
  it('combined frames over combined busy time when neither kind alone is long enough', () => {
    const [a, b] = turnTaking({
      obs: 100,
      needBusy: 150,
      needFrames: 14,
      settleBusy: 150,
      settleFrames: 14,
    });
    expect(workCapacities(a, b)!.needFpsPerWorker).toBeCloseTo((28 * 1000) / 300, 6);
  });
});

describe('floor details', () => {
  it('reports the prior as limiting "prior"; measuredAt none is not trusted', () => {
    const e = speedFloor({ ...base, ...nulls, settleWorkers: 0, measuredAt: 'none' });
    expect(e.limiting).toBe('prior');
    const m = speedFloor({ ...base, settleWorkers: 1, measuredAt: 'none' });
    expect(m.confidence).toBe('prior');
    expect(m.limiting).toBe('prior');
    expect(m.fps).toBe(FLOOR.priorFps.pool);
  });

  it('flags a floor above Max (the hard minimum above a slow Max)', () => {
    expect(speedFloor({ ...base, maxFps: 8 }).aboveMax).toBe(true);
    expect(speedFloor({ ...base, maxFps: 300 }).aboveMax).toBe(false);
    expect(speedFloor({ ...base, maxFps: null }).aboveMax).toBe(false);
  });

  it('steps down for any raw below the published step, snapped to the ladder', () => {
    const tr = new FloorTracker({ ...FLOOR }, { averageMs: 1, evalEveryMs: 5000, confirm: 3 });
    const at = (fps: number): FloorInputs => ({
      ...base,
      slowLiveMs: 1,
      slowVisitMs: 0,
      needFpsPerWorker: (fps * 4) / 0.9,
    });
    tr.update(0, at(30));
    expect(tr.published).toBe(30);
    const ch = [5000, 10_000, 15_000].map((t) => tr.update(t, at(29)));
    expect(ch).toEqual([false, false, true]);
    expect(tr.published).toBe(25);
  });

  it('does not publish the prior', () => {
    const tr = new FloorTracker();
    tr.update(0, { ...base, ...nulls, settleWorkers: 0, measuredAt: 'none' });
    expect(tr.published).toBeNull();
    expect(tr.estimate!.confidence).toBe('prior');
  });
});

describe('FloorMeter regimes, throttle, display', () => {
  const feedOf = (w: WorkStatus, over: Partial<Parameters<FloorMeter['push']>[0]> = {}) => ({
    work: w,
    inNeed: 5,
    cap: 2,
    needRate: 2,
    target: 60,
    maxFps: 300,
    paused: false,
    haveLibrary: true,
    ...over,
  });
  const at = (w: WorkStatus, wall: number, obs: number): WorkStatus => ({
    ...w,
    wallMs: wall,
    observedFrames: obs,
  });

  it('shows the prior before any measurement and flags above Max', () => {
    const m = new FloorMeter();
    const d = m.display();
    expect(d.prior).toBe(true);
    expect(d.fps).toBe(FLOOR.priorFps.turnTaking);
    expect(floorText(m)).toMatch(/about 20 fps \(not measured yet\)/);
    const [a, b] = pair();
    m.push(feedOf(a, { maxFps: 8 }));
    expect(m.display().aboveMax).toBe(true);
    void b;
  });

  it('throttles to one reading a second', () => {
    const m = new FloorMeter();
    const [a, b] = pair();
    m.push(feedOf(a));
    const v = m.version;
    expect(m.due(a.wallMs + 500)).toBe(false);
    m.push(feedOf(at(b, a.wallMs + 500, 1300)));
    expect(m.version).toBe(v);
    expect(m.due(a.wallMs + 1000)).toBe(true);
  });

  it('a target change, even between two paced values, starts a new regime', () => {
    const m = new FloorMeter();
    const [a, b] = pair();
    m.push(feedOf(a, { target: 60 }));
    m.push(feedOf(b, { target: 60 }));
    expect(m.last?.measuredAt).toBe('paced');
    m.push(feedOf(at(b, b.wallMs + 1000, 1860), { target: 30 }));
    // The old snapshots are gone: nothing to measure from yet.
    const before = m.version;
    m.push(feedOf(at(b, b.wallMs + 7000, 2200), { target: 30 }));
    expect(m.version).toBe(before + 1);
    // Paced for the whole new span, measured only inside it.
    expect(m.last?.measuredAt).toBe('paced');
    m.push(feedOf(at(b, b.wallMs + 8000, 2300), { target: 0 }));
    m.push(feedOf(at(b, b.wallMs + 14_000, 2700), { target: 0 }));
    expect(m.last?.measuredAt).toBe('unpaced');
  });

  it('freezes during a Refine run', () => {
    const m = new FloorMeter();
    const [a, b] = pair();
    m.push(feedOf(a, { run: 2 }));
    m.push(feedOf(b, { run: 2 }));
    expect(m.tracker.published).toBeNull();
  });
});
