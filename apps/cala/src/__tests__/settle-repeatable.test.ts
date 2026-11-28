// @vitest-environment node
/**
 * The Final settle of a repeatable run (`FinalSettleDriver`): answers observed in request order
 * and visit results applied at fixed frames-fed points in hand-out order, so the slow loop sees
 * the same calls in the same order whatever the timing of the look-back and visit workers.
 *
 * Runs use the fakes of `settle-fixtures.ts`: a look-back worker's traces depend on the request
 * it served before, and the fake loop's visits depend on which visits are out, so any order that
 * follows arrival shows up in the call log.
 */
import { describe, expect, it } from 'vitest';
import {
  SETTLE_VISIT_DEPTH,
  SETTLE_VISIT_HEADROOM,
  settleVisitLag,
} from '../lib/final-settle-driver.ts';
import { SETTLE } from '../lib/settle.ts';
import { FRAMES, settleRun, type Schedule } from './settle-fixtures.ts';

/** The same settle under several timings: seeds and the delays of answers and visit results. */
function timings(base: Omit<Schedule, 'seed' | 'visitMs' | 'answerMs'>): Schedule[] {
  return [
    { ...base, seed: 21, visitMs: 1, answerMs: 1 },
    { ...base, seed: 22, visitMs: 25, answerMs: 1 },
    { ...base, seed: 23, visitMs: 2, answerMs: 12 },
    { ...base, seed: 24, visitMs: 9, answerMs: 6 },
  ];
}

async function logs(schedules: Schedule[]): Promise<string[][]> {
  const out: string[][] = [];
  for (const sch of schedules) out.push((await settleRun(sch)).log);
  return out;
}

describe('repeatable Final settle', () => {
  it.each([
    { name: 'pooled on factors, 4 visit workers', pool: true, visitWorkers: 4 },
    { name: 'pooled on factors, 1 visit worker', pool: true, visitWorkers: 1 },
    { name: "the recording's relay, 2 visit workers", pool: false, visitWorkers: 2 },
  ])(
    'the slow loop gets the same calls in the same order under any timing ($name)',
    async ({ pool, visitWorkers }) => {
      const runs = await logs(timings({ pool, visitWorkers, repeatable: true }));
      for (const log of runs.slice(1)) expect(log).toEqual(runs[0]);
      // Every settle frame was observed, and visits were made.
      expect(runs[0].filter((c) => c.startsWith('o')).length).toBeGreaterThanOrEqual(2 * FRAMES);
      expect(runs[0].some((c) => c.startsWith('a'))).toBe(true);
    },
    60_000,
  );

  it('keeps the settle visit rate: floor(rate x fed) visits in the pass', async () => {
    for (const sch of timings({ pool: true, visitWorkers: 4, repeatable: true })) {
      const { st, pass, count } = await settleRun(sch);
      expect(count.releases).toBe(count.answers);
      expect(st.fed).toBe(FRAMES);
      expect(st.visits!.handed).toBe(Math.floor(SETTLE.visitRate * FRAMES + 1e-9));
      expect(pass.over).toBe(0);
    }
  }, 60_000);

  it('never holds or falls behind when visits come back at once', async () => {
    // 4 slots at a lag of 2 pieces keep up with the rate only if a slot freed at its due point
    // goes out again at once: handed out after the next piece instead, a slot makes a visit per
    // 3 pieces, under the rate, the visits owed pile up to the hold threshold and the rest is
    // paid at the end.
    for (const seed of [41, 42]) {
      const { st } = await settleRun({
        seed,
        visitWorkers: 4,
        visitMs: 0,
        visitInstant: true,
        answerMs: 1,
        pool: true,
        repeatable: true,
      });
      const v = st.visits!;
      expect(v.handed).toBe(Math.floor(SETTLE.visitRate * FRAMES + 1e-9));
      expect(v.holds).toBe(0);
      expect(v.owedMax).toBeLessThanOrEqual(Math.ceil(SETTLE.visitRate * SETTLE.observePiece));
      expect(v.paidAtEnd).toBe(0);
    }
  }, 60_000);

  it('queues visits on each worker and keeps the order when one worker is much slower', async () => {
    const slow = (sch: Schedule): Schedule => ({ ...sch, visitMsOf: (i) => (i === 0 ? 30 : 1) });
    const scheds = timings({ pool: true, visitWorkers: 4, repeatable: true }).map(slow);
    const runs = [];
    for (const sch of scheds) runs.push(await settleRun(sch));
    for (const r of runs.slice(1)) expect(r.log).toEqual(runs[0].log);
    for (const r of runs) {
      // A worker gets its next visit before its result is applied, up to its slots.
      expect(Math.max(...r.queuedMax)).toBe(SETTLE_VISIT_DEPTH);
      expect(r.st.visits!.handed).toBe(Math.floor(SETTLE.visitRate * FRAMES + 1e-9));
      expect(r.pass.over).toBe(0);
    }
  }, 60_000);

  it('without repeatable each visit worker has one visit at a time', async () => {
    for (const sch of timings({ pool: true, visitWorkers: 4 })) {
      const { queuedMax } = await settleRun(sch);
      expect(Math.max(...queuedMax)).toBe(1);
    }
  }, 60_000);

  it('without repeatable the order follows the timing (the fakes can tell)', async () => {
    const runs = await logs(timings({ pool: true, visitWorkers: 4 }));
    expect(runs.some((log) => JSON.stringify(log) !== JSON.stringify(runs[0]))).toBe(true);
  }, 60_000);

  it('a Stop while answers and visits are out still ends with every buffer back', async () => {
    const { st, count } = await settleRun({
      seed: 31,
      visitWorkers: 2,
      visitMs: 25,
      answerMs: 1,
      pool: true,
      repeatable: true,
      stopAfterMs: 60,
    });
    expect(st.stopped).toBe(true);
    expect(count.releases).toBe(count.answers);
  }, 20_000);
});

describe('settleVisitLag', () => {
  it('is whole pieces that let the slots keep up with the rate and a margin, at least one piece', () => {
    const p = SETTLE.observePiece;
    expect(settleVisitLag(8, 0.4)).toBe(4 * p);
    expect(settleVisitLag(4, 0.4)).toBe(2 * p);
    expect(settleVisitLag(2, 0.4)).toBe(p);
    expect(settleVisitLag(1, 0.4)).toBe(p);
    expect(settleVisitLag(4, 0)).toBe(p);
    for (const slots of [1, 2, 3, 4, 8])
      for (const rate of [0.1, 0.25, 0.4, 1]) {
        const lag = settleVisitLag(slots, rate);
        expect(lag % p).toBe(0);
        if (lag > p)
          expect(slots / lag).toBeGreaterThanOrEqual(rate * SETTLE_VISIT_HEADROOM - 1e-9);
      }
  });
});
