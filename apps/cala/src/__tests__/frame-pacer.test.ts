// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FramePacer, PaceGate, PacedQueue, PACE_BATCH } from '../lib/frame-pacer.ts';

/**
 * A simulated frame worker: step requests are served one after another (the worker's queue is
 * serial), each passing the gate, then "processing" for `work(i)` ms. Returns the release times.
 */
async function simulate(
  gate: PaceGate,
  opts: {
    batches: number;
    work: (i: number) => number;
    /** Called with the batch index just after its release (for pause/target changes). */
    onRelease?: (i: number, t: number) => void;
  },
): Promise<number[]> {
  const times: number[] = [];
  // The worker's queue is serial: a request is read (gate, then work) before the next starts.
  let i = 0;
  const run = async () => {
    while (i < opts.batches) {
      if (!(await gate.enter())) return;
      const k = i++;
      const t = performance.now();
      times.push(t);
      opts.onRelease?.(k, t);
      await new Promise<void>((r) => setTimeout(r, opts.work(k)));
    }
  };
  await run();
  return times;
}

function intervals(t: number[]): number[] {
  return t.slice(1).map((v, i) => v - t[i]);
}

describe('FramePacer', () => {
  it('is unpaced by default and never due in the future', () => {
    const p = new FramePacer();
    expect(p.paced).toBe(false);
    expect(p.dueAt()).toBeLessThanOrEqual(0);
    p.setTarget(Infinity, 100);
    expect(p.paced).toBe(false);
    p.setTarget(0, 100);
    expect(p.dueAt()).toBeLessThanOrEqual(0);
    p.release(8, 5000);
    expect(p.released).toBe(0);
  });

  it('counts released frames cumulatively: a re-anchor restarts the count since the anchor, not the total', () => {
    const p = new FramePacer();
    p.setTarget(30, 0);
    p.release(8, 0);
    p.release(8, p.dueAt());
    expect(p.releasedTotal).toBe(16);
    // Far behind: dropped debt, re-anchor.
    p.release(8, p.dueAt() + 5000);
    expect(p.reanchors).toBe(1);
    expect(p.released).toBe(8);
    expect(p.releasedTotal).toBe(24);
    p.reset();
    expect(p.releasedTotal).toBe(0);
  });

  it('the gate reports the cumulative release count and the session it runs for', () => {
    let now = 0;
    const gate = new PaceGate({
      now: () => now,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    gate.begin(7);
    gate.setTarget(30);
    gate.pacer.release(8, now);
    gate.pacer.release(8, (now = gate.pacer.dueAt() + 5000));
    const s = gate.stats();
    expect(s.session).toBe(7);
    expect(s.released).toBe(16);
    expect(s.reanchors).toBe(1);
    gate.begin(8);
    expect(gate.stats()).toMatchObject({ session: 8, released: 0 });
  });

  it('keeps absolute deadlines and counts lateness only when it drops debt', () => {
    const p = new FramePacer();
    p.setTarget(30, 1000);
    expect(p.dueAt()).toBe(1000);
    p.release(8, 1000);
    expect(p.dueAt()).toBeCloseTo(1000 + 8000 / 30, 6);
    // 5 ms late (under the slack): repaid, no re-anchor.
    p.release(8, p.dueAt() + 5);
    expect(p.reanchors).toBe(0);
    expect(p.dueAt()).toBeCloseTo(1000 + 16000 / 30, 6);
    // A second late: dropped.
    const due = p.dueAt();
    p.release(8, due + 1000);
    expect(p.reanchors).toBe(1);
    expect(p.lateMs).toBeCloseTo(1000, 6);
    expect(p.dueAt()).toBeCloseTo(due + 1000 + 8000 / 30, 6);
  });
});

describe('PaceGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  const sim = async <T>(f: () => Promise<T>): Promise<T> => {
    const p = f();
    // Advance the fake clock until the simulation settles.
    let done = false;
    void p.finally(() => (done = true));
    while (!done) await vi.advanceTimersByTimeAsync(10);
    return p;
  };

  it('1. releases 1,000 batches at 30 fps evenly, with no drift', async () => {
    const gate = new PaceGate(undefined, PACE_BATCH);
    gate.begin();
    gate.setTarget(30);
    const period = (PACE_BATCH / 30) * 1000;
    // Processing between 0 and 200 ms, pseudo-random, always inside the period.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 200;
    const t = await sim(() => simulate(gate, { batches: 1000, work: rnd }));
    const iv = intervals(t);
    for (const v of iv) {
      expect(v).toBeGreaterThanOrEqual(0.9 * period);
      expect(Math.abs(v - period)).toBeLessThanOrEqual(0.02 * period + 10);
    }
    // 999 periods after the first release, give or take one batch.
    expect(Math.abs(t[999] - t[0] - 999 * period)).toBeLessThanOrEqual(period);
    expect(gate.pacer.reanchors).toBe(0);
  });

  it('2. pause for 5 s, resume: the interval across it is the pause, then one period each', async () => {
    const gate = new PaceGate();
    gate.begin();
    gate.setTarget(30);
    const period = (PACE_BATCH / 30) * 1000;
    const t = await sim(() =>
      simulate(gate, {
        batches: 40,
        work: () => 20,
        onRelease: (k) => {
          if (k === 19) {
            gate.pause();
            setTimeout(() => gate.resume(), 5000);
          }
        },
      }),
    );
    const iv = intervals(t);
    expect(iv[19]).toBeGreaterThanOrEqual(5000);
    expect(iv[19]).toBeLessThan(5000 + period + 20);
    for (const [i, v] of iv.entries()) if (i !== 19) expect(v).toBeGreaterThanOrEqual(0.9 * period);
    for (const v of iv.slice(20)) expect(Math.abs(v - period)).toBeLessThan(0.05 * period + 10);
  });

  it('3. target 30 -> 60 -> 15 changes the interval at the next release, with no burst or long gap', async () => {
    const gate = new PaceGate();
    gate.begin();
    gate.setTarget(30);
    const p30 = (PACE_BATCH / 30) * 1000;
    const p60 = (PACE_BATCH / 60) * 1000;
    const p15 = (PACE_BATCH / 15) * 1000;
    const t = await sim(() =>
      simulate(gate, {
        batches: 60,
        work: () => 10,
        onRelease: (k) => {
          if (k === 19) gate.setTarget(60);
          if (k === 39) gate.setTarget(15);
        },
      }),
    );
    const iv = intervals(t);
    expect(iv[10]).toBeCloseTo(p30, -1);
    // The first release after a change comes a new period after the last (never a burst), then one each.
    for (const v of iv.slice(19, 39)) expect(Math.abs(v - p60)).toBeLessThan(0.05 * p60 + 10);
    for (const v of iv.slice(39)) expect(Math.abs(v - p15)).toBeLessThan(0.05 * p15 + 10);
    expect(Math.max(...iv)).toBeLessThanOrEqual(p15 + p60 + 20);
    // Never two within 0.9 of the shorter of the two periods involved, except the re-anchor release.
    for (const v of iv.slice(19, 39)) expect(v).toBeGreaterThanOrEqual(0.9 * p60);
  });

  it('a short pause and rapid target changes (a slider drag) never release two batches close together', async () => {
    const gate = new PaceGate();
    gate.begin();
    gate.setTarget(30);
    const p = (PACE_BATCH / 120) * 1000; // the shortest period used below
    const t = await sim(() =>
      simulate(gate, {
        batches: 60,
        work: () => 5,
        onRelease: (k) => {
          if (k === 9) {
            gate.pause();
            setTimeout(() => gate.resume(), 20); // shorter than a period
          }
          if (k >= 30 && k < 50) gate.setTarget(30 + ((k * 37) % 90)); // 30..119 fps, every batch
        },
      }),
    );
    for (const v of intervals(t)) expect(v).toBeGreaterThanOrEqual(0.9 * p);
    // Several changes inside one period: the next release is still a period after the last.
    const g2 = new PaceGate();
    g2.begin();
    g2.setTarget(30);
    expect(await g2.enter()).toBe(true);
    const t0 = performance.now();
    g2.setTarget(60);
    g2.setTarget(45);
    g2.setTarget(30);
    expect(g2.pacer.dueAt()).toBeGreaterThanOrEqual(t0 + (PACE_BATCH / 30) * 1000 - 1);
  });

  it('4. overload then recovery: follows the processing, lateMs grows, no burst afterwards', async () => {
    const gate = new PaceGate();
    gate.begin();
    gate.setTarget(30);
    const period = (PACE_BATCH / 30) * 1000;
    const t = await sim(() =>
      simulate(gate, { batches: 80, work: (k) => (k >= 20 && k < 40 ? 400 : 50) }),
    );
    const iv = intervals(t);
    for (const v of iv.slice(20, 39)) expect(Math.abs(v - 400)).toBeLessThan(30);
    expect(gate.pacer.lateMs).toBeGreaterThan(1000);
    // Only the re-anchor release of the recovery may be early; check from the first even interval on.
    for (const v of iv.slice(41)) expect(v).toBeGreaterThanOrEqual(0.9 * period);
    expect(Math.abs(iv[70] - period)).toBeLessThan(0.05 * period + 10);
  });

  it('5. unpaced: enter returns at once and no timer is needed', async () => {
    const gate = new PaceGate();
    gate.begin();
    expect(gate.active).toBe(false);
    expect(gate.pacer.dueAt()).toBeLessThanOrEqual(0);
    expect(await gate.enter()).toBe(true);
    gate.setTarget(Infinity);
    expect(gate.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('6. pause with four requests in flight releases nothing until resume; stop releases none at all', async () => {
    const gate = new PaceGate();
    gate.begin();
    gate.setTarget(10);
    expect(await gate.enter()).toBe(true);
    const released: number[] = [];
    const answers: boolean[] = [];
    // Four requests arrive; the worker serves them one after another.
    const serve = async () => {
      for (let i = 0; i < 4; i++) {
        const ok = await gate.enter();
        answers.push(ok);
        if (ok) released.push(performance.now());
      }
    };
    const done = serve();
    gate.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(released).toHaveLength(0);
    gate.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(released).toHaveLength(2);
    // Stop with two requests still to come: the waiting one and every later one is cancelled.
    gate.stop();
    await done;
    expect(released).toHaveLength(2);
    expect(answers.slice(2)).toEqual([false, false]);
    expect(await gate.enter()).toBe(false);
    // A new run starts clean.
    gate.begin();
    gate.setTarget(10);
    expect(await gate.enter()).toBe(true);
  });

  it('openUp (finish early) releases a waiting request and all that follow', async () => {
    const gate = new PaceGate();
    gate.begin();
    gate.setTarget(1);
    await gate.enter();
    const next = gate.enter();
    gate.openUp();
    expect(await next).toBe(true);
    expect(await gate.enter()).toBe(true);
  });

  it('7. the wait at the gate adds nothing to the stage busy time', async () => {
    const gate = new PaceGate();
    gate.begin();
    gate.setTarget(30);
    let busy = 0;
    const stage = async (ms: number) => {
      const t0 = performance.now();
      await new Promise<void>((r) => setTimeout(r, ms));
      busy += performance.now() - t0;
    };
    const run = (async () => {
      for (let i = 0; i < 20; i++) {
        await gate.enter(); // entered before the stage's clock starts, as in the frame worker
        await stage(30);
      }
    })();
    let done = false;
    void run.finally(() => (done = true));
    while (!done) await vi.advanceTimersByTimeAsync(10);
    const period = (PACE_BATCH / 30) * 1000;
    expect(busy).toBeCloseTo(20 * 30, -1);
    // The wait is reported on its own: about (period - 30) per batch after the first.
    expect(gate.waitMs).toBeGreaterThan(19 * (period - 30) - 40);
    expect(gate.waitMs + busy).toBeGreaterThan(19 * period);
  });
});

/** The worker's queue with the gate in front of its steps (`PacedQueue`), with fake request handlers. */
describe('PacedQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  type Req = { type: 'step' | 'read' | 'start' | 'stop'; id: number };
  function rig() {
    const gate = new PaceGate();
    const log: string[] = [];
    const cancelled: number[] = [];
    let pipeline = 0; // the "pipeline" generation a step runs against
    const q = new PacedQueue<Req>({
      gate,
      isStep: (r) => r.type === 'step',
      run: async (r) => {
        await new Promise<void>((res) => setTimeout(res, 5));
        if (r.type === 'start') {
          gate.begin();
          pipeline++;
        }
        log.push(`${r.type}${r.id}@p${pipeline}@${Math.round(performance.now())}`);
      },
      cancelled: (r) => cancelled.push(r.id),
    });
    // As the worker's onmessage: starts and stops act at once on the gate, then queue.
    const send = (r: Req) => {
      if (r.type === 'start' || r.type === 'stop') q.cancelWaiting();
      q.push(r);
    };
    return { gate, q, log, cancelled, send };
  }

  it('a read answers promptly while a step is held at the gate', async () => {
    const { gate, log, send } = rig();
    send({ type: 'start', id: 1 });
    await vi.advanceTimersByTimeAsync(10);
    gate.setTarget(2); // a period of 4 s
    send({ type: 'step', id: 2 });
    await vi.advanceTimersByTimeAsync(10); // released at once (first)
    send({ type: 'step', id: 3 });
    gate.pause();
    send({ type: 'read', id: 4 });
    await vi.advanceTimersByTimeAsync(20);
    expect(log.some((l) => l.startsWith('read4'))).toBe(true);
    expect(log.some((l) => l.startsWith('step3'))).toBe(false);
  });

  it('restart while paused starts at once and old waiting steps never run against the new pipeline', async () => {
    const { gate, log, cancelled, send } = rig();
    send({ type: 'start', id: 1 });
    await vi.advanceTimersByTimeAsync(10);
    gate.setTarget(10);
    for (const id of [2, 3, 4, 5]) send({ type: 'step', id });
    gate.pause();
    await vi.advanceTimersByTimeAsync(100);
    const ran = log.filter((l) => l.startsWith('step')).length;
    send({ type: 'start', id: 6 });
    await vi.advanceTimersByTimeAsync(50);
    expect(log.some((l) => l.startsWith('start6@p2'))).toBe(true);
    expect(cancelled.length).toBeGreaterThanOrEqual(3);
    expect(log.filter((l) => l.startsWith('step')).length).toBe(ran);
    expect(log.some((l) => /^step\d@p2/.test(l))).toBe(false);
  });

  it("restart while running does not wait out the queued steps' periods", async () => {
    const { gate, log, send } = rig();
    send({ type: 'start', id: 1 });
    await vi.advanceTimersByTimeAsync(10);
    gate.setTarget(2);
    for (const id of [2, 3, 4, 5]) send({ type: 'step', id });
    await vi.advanceTimersByTimeAsync(100);
    const t = performance.now();
    send({ type: 'start', id: 6 });
    await vi.advanceTimersByTimeAsync(50);
    const s = log.find((l) => l.startsWith('start6'))!;
    expect(Number(s.split('@')[2]) - t).toBeLessThan(20);
  });

  it('stop with steps waiting cancels every one and runs none', async () => {
    const { gate, log, cancelled, send } = rig();
    send({ type: 'start', id: 1 });
    await vi.advanceTimersByTimeAsync(10);
    gate.setTarget(2);
    for (const id of [2, 3, 4, 5]) send({ type: 'step', id });
    await vi.advanceTimersByTimeAsync(10);
    const ran = log.filter((l) => l.startsWith('step')).length;
    send({ type: 'stop', id: 6 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cancelled).toEqual([3, 4, 5]);
    expect(log.filter((l) => l.startsWith('step')).length).toBe(ran);
  });

  it('stuck-held sequence: paused, pace off, resume, pace on releases again', async () => {
    const gate = new PaceGate();
    gate.begin();
    gate.setTarget(30);
    await gate.enter();
    gate.pause();
    gate.setTarget(0);
    gate.resume(); // the store always sends resume once a pace was set
    gate.setTarget(30);
    const next = gate.enter();
    await vi.advanceTimersByTimeAsync(400);
    expect(await next).toBe(true);
    // Paused unpaced, then a pace: the gate starts held.
    gate.setTarget(0);
    gate.pause();
    gate.setTarget(30);
    let got = false;
    void gate.enter().then(() => (got = true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toBe(false);
    gate.resume();
    await vi.advanceTimersByTimeAsync(400);
    expect(got).toBe(true);
  });
});
