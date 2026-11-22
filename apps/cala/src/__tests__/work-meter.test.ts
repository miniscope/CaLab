// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  addLookbackAnswer,
  DutyClock,
  emptyLookbackWork,
  emptyWork,
  MaxFpsEstimator,
  WindowMax,
  WorkRater,
  workRates,
  workText,
  type WorkStatus,
} from '../lib/work-meter.ts';
import { SlowRunner, type PublishedLibrary, type SlowLoopLike } from '../lib/slow-runner.ts';
import { createRunHistory } from '../lib/run-history.ts';
import type { LookbackToSlow, SlowToLookback } from '../workers/lookback-types.ts';
import type {
  FastToSlow,
  OwnerToVisit,
  SlowStatus,
  SlowToMain,
  VisitToOwner,
} from '../workers/slow-types.ts';

describe('DutyClock', () => {
  it('charges time to the open duty, nested spans to the inner one only', () => {
    let t = 0;
    const c = new DutyClock(['a', 'b'] as const, () => t);
    t = 5; // idle
    c.begin('a');
    t = 15; // a: 10
    c.begin('b');
    t = 18; // b: 3
    c.end();
    t = 20; // a: +2
    c.end();
    t = 100; // idle
    expect(c.snapshot()).toEqual({ a: 12, b: 3 });
  });

  it('a snapshot inside an open span counts it up to now, and span() closes on a throw', () => {
    let t = 0;
    const c = new DutyClock(['a'] as const, () => t);
    c.begin('a');
    t = 7;
    expect(c.snapshot().a).toBe(7);
    t = 9;
    c.end();
    expect(() =>
      c.span('a', () => {
        t = 14;
        throw new Error('x');
      }),
    ).toThrow('x');
    t = 50;
    expect(c.snapshot().a).toBe(14); // 9 + 5, nothing after the throw
    c.reset();
    expect(c.snapshot().a).toBe(0);
  });

  it('the sum of the buckets never exceeds the wall time', () => {
    let t = 0;
    const c = new DutyClock(['a', 'b'] as const, () => t);
    for (let i = 0; i < 50; i++) {
      t += i % 3;
      c.begin(i % 2 ? 'a' : 'b');
      t += 2;
      if (i % 5 === 0) {
        c.begin('a');
        t += 1;
        c.end();
      }
      c.end();
    }
    const s = c.snapshot();
    expect(s.a + s.b).toBeLessThanOrEqual(t);
  });
});

describe('WindowMax', () => {
  it('keeps the largest value of the last window and forgets older ones', () => {
    const w = new WindowMax(1000);
    w.push(0, 50);
    w.push(500, 8);
    expect(w.max(600)).toBe(50);
    expect(w.max(1001)).toBe(8);
    expect(w.max(1600)).toBe(0);
    // A negative value (clocks that disagree) is shown, not hidden as 0.
    w.push(2000, -3);
    expect(w.max(2100)).toBe(-3);
  });
});

function snap(wall: number, patch: (w: WorkStatus) => void): WorkStatus {
  const w = emptyWork(2);
  w.wallMs = wall;
  patch(w);
  return w;
}

describe('workRates', () => {
  it('turns two snapshots into shares of wall time; idle is what no duty claims', () => {
    const a = snap(1000, () => {});
    const b = snap(2000, (w) => {
      w.busyMs.live = 200;
      w.busyMs.visit = 100;
      w.busyMs.need = 50;
      w.busyMs.csettle = 100;
      w.busyMs.end = 50;
      w.busyMs.publish = 100;
      w.visitBusyMs = [900, 450];
      w.lookback.need = {
        ...emptyLookbackWork(),
        answers: 2,
        frames: 40,
        readMs: 100,
        preprocessMs: 300,
        solveMs: 100,
      };
      w.lookback.csettle = {
        ...emptyLookbackWork(),
        answers: 1,
        frames: 16,
        readMs: 100,
        preprocessMs: 200,
        solveMs: 100,
      };
      w.batchWait = { batches: 8, sumMs: 40, lastMs: 3, max1sMs: 11 };
    });
    const r = workRates(a, b)!;
    expect(r.slow.live).toBeCloseTo(0.2);
    expect(r.slow.idle).toBeCloseTo(0.4);
    const sum =
      r.slow.live +
      r.slow.visit +
      r.slow.need +
      r.slow.csettle +
      r.slow.end +
      r.slow.publish +
      r.slow.idle;
    expect(sum).toBeCloseTo(1);
    expect(r.visit).toEqual([0.9, 0.45]);
    expect(r.lookback.kinds.need.busy).toBeCloseTo(0.5);
    expect(r.lookback.kinds.need.framesPerS).toBeCloseTo(40);
    expect(r.lookback.kinds.need.msPerAnswer).toEqual({ read: 50, preprocess: 150, solve: 50 });
    expect(r.lookback.kinds.end.msPerAnswer.solve).toBe(0);
    expect(r.lookback.busy).toBeCloseTo(0.9);
    expect(r.batchWait).toEqual({ meanMs: 5, lastMs: 3, max1sMs: 11 });
    expect(workText(r, 212)).toContain('max ~212 fps');
  });

  it('is null when the clock did not advance, and the rater waits for a second and restarts with the run', () => {
    expect(
      workRates(
        snap(5, () => {}),
        snap(5, () => {}),
      ),
    ).toBeNull();
    const rater = new WorkRater(1000);
    expect(rater.push(snap(100, () => {}))).toBeNull();
    expect(rater.push(snap(600, () => {}))).toBeNull();
    expect(rater.push(snap(1200, () => {}))).not.toBeNull();
    expect(rater.push(snap(1500, () => {}))).toBeNull(); // reference moved to 1200
    expect(rater.push(snap(50, () => {}))).toBeNull(); // a new run
    expect(rater.push(snap(1100, () => {}))).not.toBeNull();
  });

  it('addLookbackAnswer sums an answer and tolerates a missing timing', () => {
    const w = emptyLookbackWork();
    addLookbackAnswer(w, 8, { readMs: 1, preprocessMs: 2, solveMs: 3, otherMs: 5, waitMs: 4 });
    addLookbackAnswer(w, 4);
    expect(w).toEqual({
      answers: 2,
      frames: 12,
      readMs: 1,
      preprocessMs: 2,
      solveMs: 3,
      otherMs: 5,
      waitMs: 4,
    });
  });
});

describe('WorkRater carry', () => {
  it('clamps a busy share at 1 and carries the excess into the next window', () => {
    const rater = new WorkRater(1000);
    rater.push(snap(0, () => {}));
    // 1.6 s of visit time credited in a 1 s window (the visit ended in it, but spanned two).
    const a = rater.push(
      snap(1000, (w) => {
        w.visitBusyMs = [1600, 0];
        w.lookback.need = { ...emptyLookbackWork(), answers: 1, frames: 8, readMs: 1500 };
        w.discarded = { ...emptyLookbackWork(), solveMs: 200 };
      }),
    )!;
    expect(a.visit[0]).toBe(1);
    expect(a.lookback.kinds.need.busy).toBe(1);
    expect(a.lookback.busy).toBe(1);
    // Nothing new: the carried 0.6 shows up next.
    const b = rater.push(
      snap(2000, (w) => {
        w.visitBusyMs = [1600, 0];
        w.lookback.need = { ...emptyLookbackWork(), answers: 1, frames: 8, readMs: 1500 };
        w.discarded = { ...emptyLookbackWork(), solveMs: 200 };
      }),
    )!;
    expect(b.visit[0]).toBeCloseTo(0.6);
    expect(b.lookback.kinds.need.busy).toBeCloseTo(0.5);
    expect(b.lookback.busy).toBeCloseTo(0.7);
    const c = rater.push(
      snap(3000, (w) => {
        w.visitBusyMs = [1600, 0];
      }),
    )!;
    expect(c.visit[0]).toBe(0);
  });

  it('counts discarded answers in the look-back busy share', () => {
    const r = workRates(
      snap(0, () => {}),
      snap(1000, (w) => {
        w.discarded = { ...emptyLookbackWork(), solveMs: 300 };
      }),
    )!;
    expect(r.lookback.busy).toBeCloseTo(0.3);
  });
});

describe('MaxFpsEstimator', () => {
  it('is frames over the busiest stage, over the last batches', () => {
    const e = new MaxFpsEstimator(2);
    expect(e.estimate()).toBe(0);
    // 8 frames per batch; stage 2 busiest at 40 ms a batch: 200 fps.
    expect(e.record(8, [10, 20, 40])).toBeCloseTo(200);
    e.record(8, [10, 20, 80]);
    expect(e.estimate()).toBeCloseTo((16 * 1000) / 120);
    e.record(8, [10, 20, 80]); // the first batch left the window
    expect(e.estimate()).toBeCloseTo(100);
    e.reset();
    expect(e.record(8, [0, 0, 0])).toBe(0);
  });
});

describe('run history work series', () => {
  it('keeps the shares in bounded series', () => {
    const h = createRunHistory();
    h.reset({ fps: 30, live: false, frameCount: 300 });
    const r = workRates(
      snap(0, () => {}),
      snap(1000, (w) => {
        w.busyMs.live = 500;
        w.visitBusyMs = [800, 600];
      }),
    )!;
    h.work(r, 120);
    const hist = h.history();
    expect(hist.spec('work_live')).toBeDefined();
    expect(hist.spec('fast_max_fps')).toBeDefined();
  });
});

// ---- the slow runner's accounting ----

function lib(version: number): PublishedLibrary {
  return {
    version,
    ids: () => Uint32Array.of(1),
    centers: () => Float32Array.of(0, 0),
    radii: () => Float32Array.of(1),
    supportStarts: () => Uint32Array.of(0, 1),
    supportPixels: () => Uint32Array.of(0),
    footprintValues: () => Float32Array.of(1),
    toBytes: () => Uint8Array.of(version),
    free: vi.fn(),
  };
}

const INIT: Extract<FastToSlow, { type: 'init' }> = {
  type: 'init',
  session: 1,
  width: 2,
  height: 1,
  fov: Uint8Array.of(1, 1),
  noise: Float32Array.of(1, 1),
  cellDiameterPx: 10,
  flattenSigmaPx: 0,
  budget: 1,
};

function batch(start: number, sentAt?: number): Extract<FastToSlow, { type: 'frames' }> {
  return {
    type: 'frames',
    session: 1,
    start,
    count: 2,
    version: 0,
    cells: 0,
    frames: new Float32Array(4),
    traces: new Float32Array(0),
    ...(sentAt !== undefined ? { sentAt } : {}),
  };
}

function rig(opts: { visits?: number; lookback?: boolean } = {}) {
  let t = 0;
  let epoch = 1_000_000;
  const toMain: SlowToMain[] = [];
  const toLb: SlowToLookback[] = [];
  const toVisit: OwnerToVisit[][] = Array.from({ length: opts.visits ?? 0 }, () => []);
  let wanted = 0;
  const loop: SlowLoopLike = {
    observe: () => {
      t += 5; // each frame costs 5 ms
      return true;
    },
    step: () => undefined,
    finalize: () => lib(2),
    setNoise: () => {},
    takeJob: () => {
      t += 1;
      return Uint8Array.of(1);
    },
    applyJob: () => {
      t += 3;
    },
    housekeep: () => undefined,
    cellCount: 1,
    reservoirBytes: 0,
    stats: () => new Float64Array(17),
    free: () => {},
    lookbackNote: () => {
      wanted = 2;
    },
    lookbackTake: () => {
      const n = wanted;
      wanted = 0;
      return Float64Array.from(Array.from({ length: n }, (_, i) => [i, 0, 1, 7]).flat());
    },
    observeLookback: () => {
      t += 2;
      return true;
    },
    lookbackStats: () => new Float64Array(7),
  } as SlowLoopLike;
  const r = new SlowRunner({
    create: () => loop,
    toFast: { postMessage: () => {} },
    toMain: { postMessage: (m) => toMain.push(m) },
    visits: toVisit.map((q) => ({ postMessage: (m: OwnerToVisit) => q.push(m) })),
    ...(opts.lookback ? { lookback: { postMessage: (m: SlowToLookback) => toLb.push(m) } } : {}),
    now: () => t,
    epochNow: () => epoch,
    defer: (fn) => fn(),
    timer: () => () => {},
  });
  const last = (): SlowStatus => {
    const s = toMain.flatMap((m) => (m.type === 'status' ? [m.status] : [])).at(-1);
    if (!s) throw new Error('no status');
    return s;
  };
  return {
    r,
    toLb,
    toVisit,
    last,
    advance: (ms: number) => void (t += ms),
    setEpoch: (e: number) => void (epoch = e),
  };
}

describe('SlowRunner accounting', () => {
  it('live batches are busy time, the rest of the wall is idle, and the inbox wait is measured', () => {
    const x = rig();
    x.r.handle(INIT);
    x.advance(100); // idle
    x.setEpoch(1_000_040);
    x.r.handle(batch(0, 1_000_000)); // waited 40 ms; 2 frames x 5 ms
    const w = x.last().accounting!;
    expect(w.busyMs.live).toBe(10);
    expect(w.wallMs).toBe(110);
    expect(w.batchWait.batches).toBe(1);
    expect(w.batchWait.lastMs).toBe(40);
    expect(w.batchWait.max1sMs).toBe(40);
    const busy = Object.values(w.busyMs).reduce((a, b) => a + b, 0);
    expect(busy).toBeLessThanOrEqual(w.wallMs);
  });

  it('a batch from an older sender (no send time) adds no wait', () => {
    const x = rig();
    x.r.handle(INIT);
    x.r.handle(batch(0));
    expect(x.last().accounting!.batchWait.batches).toBe(0);
  });

  it('visit hand-out and apply are visit time, and each visit worker reports its busy ms', () => {
    const x = rig({ visits: 2 });
    x.r.handle(INIT);
    x.r.handle(batch(0)); // hands a visit to each worker: takeJob 1 ms each, inside the batch
    expect(x.toVisit[0].some((m) => m.type === 'job')).toBe(true);
    const before = x.last().accounting!;
    expect(before.busyMs.visit).toBe(2);
    expect(before.busyMs.live).toBe(10);
    x.r.handleVisit(1, {
      type: 'result',
      session: 1,
      bytes: Uint8Array.of(0),
      ms: 40,
    } satisfies VisitToOwner);
    x.r.handle(batch(2));
    const w = x.last().accounting!;
    expect(w.visitBusyMs[0]).toBe(0);
    expect(w.visitBusyMs[1]).toBe(40);
    expect(w.busyMs.visit).toBeGreaterThanOrEqual(2 + 3);
  });

  it('look-back answers add their time to the slow worker by kind and keep the worker timing', () => {
    const x = rig({ lookback: true });
    x.r.handle({ ...INIT, lookback: true });
    x.r.handle(batch(0)); // asks for 2 frames (need-driven)
    const req = x.toLb.find((m) => m.type === 'request') as Extract<
      SlowToLookback,
      { type: 'request' }
    >;
    const reply: LookbackToSlow = {
      type: 'frames',
      session: 1,
      id: req.id,
      version: 3,
      count: 2,
      cells: 1,
      frames: new Float32Array(4),
      traces: new Float32Array(2),
      timing: { readMs: 6, preprocessMs: 30, solveMs: 9, otherMs: 2, waitMs: 1 },
    };
    x.r.handleLookback(reply);
    x.r.handle(batch(2));
    const w = x.last().accounting!;
    expect(w.lookback.need).toEqual({
      answers: 1,
      frames: 2,
      readMs: 6,
      preprocessMs: 30,
      solveMs: 9,
      otherMs: 2,
      waitMs: 1,
    });
    expect(w.lookback.csettle.answers).toBe(0);
    expect(w.busyMs.need).toBe(4); // two observeLookback calls of 2 ms
  });

  it('a stale answer is counted as discarded, housekeeping and set-up have their own duties', () => {
    const x = rig({ lookback: true });
    x.r.handle({ ...INIT, lookback: true });
    x.r.handleLookback({
      type: 'frames',
      session: 1,
      id: 999,
      version: 1,
      count: 3,
      cells: 1,
      frames: new Float32Array(6),
      traces: new Float32Array(3),
      timing: { readMs: 1, preprocessMs: 2, solveMs: 3, otherMs: 0, waitMs: 0 },
    });
    x.r.handle(batch(0));
    const w = x.last().accounting!;
    expect(w.discarded).toMatchObject({ answers: 1, frames: 3, solveMs: 3 });
    expect(w.lookback.need.answers).toBe(0);
    expect(w.busyMs.housekeep).toBe(0);
    expect(w.busyMs.setup).toBe(0);
  });

  it('a new session starts the accounting from zero', () => {
    const x = rig();
    x.r.handle(INIT);
    x.r.handle(batch(0));
    x.r.handle({ ...INIT, session: 2 });
    x.r.handle({ ...batch(0), session: 2 });
    const w = x.last().accounting!;
    expect(w.busyMs.live).toBe(10);
    expect(w.wallMs).toBe(10);
  });
});
