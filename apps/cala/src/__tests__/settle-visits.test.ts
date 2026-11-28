// @vitest-environment node
/**
 * The Final settle's visit rate (`SETTLE.visitRate`): with visit workers, the
 * settle's pass hands out `floor(rate x fed)` tile visits whatever the timing.
 *
 * The settle runs with the fakes of `settle-fixtures.ts`. Schedules vary the delays (visits much slower
 * than look-back answers, as when the slow worker's queue is long), the visit
 * workers (1, 2, 4) and the look-back workers (worker 0 on the recording with
 * its relay, or worker 0 plus a pool worker on the factors).
 */
import { describe, expect, it } from 'vitest';
import { SETTLE } from '../lib/settle.ts';
import { FRAMES, settleRun, type Schedule } from './settle-fixtures.ts';

const SCHEDULES: Schedule[] = [
  // Visits as fast as answers, one look-back worker (the recording's relay).
  { seed: 1, visitWorkers: 4, visitMs: 2, answerMs: 2, pool: false },
  // Visits far slower than answers (X1's shape: results wait behind look-back answers).
  { seed: 2, visitWorkers: 4, visitMs: 25, answerMs: 1, pool: false },
  { seed: 3, visitWorkers: 1, visitMs: 12, answerMs: 1, pool: false },
  { seed: 4, visitWorkers: 2, visitMs: 6, answerMs: 4, pool: false },
  // The settle on factors with a pool worker: two look-back workers, answers in either order.
  { seed: 5, visitWorkers: 4, visitMs: 2, answerMs: 3, pool: true },
  { seed: 6, visitWorkers: 4, visitMs: 25, answerMs: 1, pool: true },
  { seed: 7, visitWorkers: 1, visitMs: 10, answerMs: 2, pool: true },
];

describe('Final settle visit rate', () => {
  it.each(SCHEDULES)(
    'hands out floor(rate x fed) visits in the pass, never ahead of the frames (%o)',
    async (sch) => {
      const { st, pass, count } = await settleRun(sch);
      // Every answer was observed and its buffer went back.
      expect(count.releases).toBe(count.answers);
      expect(st.fed).toBe(st.total);
      expect(st.total).toBe(FRAMES);
      expect(st.workers).toBe(sch.pool ? 2 : 1);
      const v = st.visits!;
      expect(v.rate).toBe(SETTLE.visitRate);
      expect(v.handed).toBe(Math.floor(SETTLE.visitRate * FRAMES + 1e-9));
      expect(v.unpaid).toBe(0);
      // Never more visits out than the frames observed had earned.
      expect(pass.over).toBe(0);
      // The fake counted the pass's visits up to the first tile made due at once.
      expect(pass.visits).toBeLessThanOrEqual(v.handed);
      expect(pass.visits).toBeGreaterThanOrEqual(v.handed - v.paidAtEnd);
      expect(v.finalRound).toBeGreaterThan(0);
    },
    20_000,
  );

  it('fewer tiles come due than the rate asks: the credit is carried and paid before the last round', async () => {
    // One visit comes due every 5 frames (0.2 per frame): half the rate.
    const { st } = await settleRun({
      seed: 9,
      visitWorkers: 2,
      visitMs: 3,
      answerMs: 2,
      pool: false,
      due: 10,
    });
    const v = st.visits!;
    expect(v.starved).toBeGreaterThan(0);
    expect(v.paidAtEnd).toBeGreaterThan(0);
    // What the pass could still pay with every tile due (one visit per tile, then nothing is due).
    expect(v.handed + v.unpaid).toBe(Math.floor(SETTLE.visitRate * FRAMES + 1e-9));
  }, 20_000);

  it('a Stop while answers wait to be observed: they are not observed, their buffers go back', async () => {
    const { st, count } = await settleRun({
      seed: 11,
      visitWorkers: 1,
      visitMs: 25,
      answerMs: 1,
      pool: true,
      stopAfterMs: 60,
    });
    expect(st.stopped).toBe(true);
    expect(st.fed).toBeLessThan(st.total);
    expect(count.releases).toBe(count.answers);
  }, 20_000);

  it("accounts the settle's visits, its pool worker's answers and the slow worker's time in it to the Final settle", async () => {
    const { st, accounting: w } = await settleRun({ ...SCHEDULES[4] });
    const sum = (a: number[] | undefined) => (a ?? []).reduce((x, y) => x + y, 0);
    // Every visit result is 1 ms: the settle's visits are the ones handed out in it.
    expect(sum(w.settleVisitBusyMs)).toBeGreaterThanOrEqual(st.visits!.handed);
    expect(sum(w.settleVisitBusyMs)).toBeLessThanOrEqual(sum(w.visitBusyMs));
    // Every answer is 1 ms of solve; on factors the pool worker serves only the Final settle.
    expect(w.lookbackWorkerEndBusyMs![1]).toBeGreaterThan(0);
    expect(w.lookbackWorkerEndBusyMs![1]).toBe(w.lookbackWorkerBusyMs![1]);
    expect(w.settleBusyMs!.end).toBeGreaterThan(0);
    expect(w.settleBusyMs!.end).toBeLessThanOrEqual(w.busyMs.end);
    expect(w.settleBusyMs!.visit).toBeGreaterThan(0);
    expect(w.settleBusyMs!.visit).toBeLessThanOrEqual(w.busyMs.visit);
  }, 20_000);

  it('without a rate (the behaviour before) the visit count follows the timing', async () => {
    const fast = await settleRun({ ...SCHEDULES[0], rate: 0 });
    const slow = await settleRun({ ...SCHEDULES[1], rate: 0 });
    expect(fast.st.visits!.rate).toBe(0);
    expect(fast.pass.visits).not.toBe(slow.pass.visits);
  }, 20_000);
});
