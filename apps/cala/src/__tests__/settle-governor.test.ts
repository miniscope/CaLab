// @vitest-environment node
/**
 * The settle governor (`SettleGovernor`, work-slider PR 5): the rate in
 * re-read frames per second, its three limits (cap, look-back supply, the
 * guard) and the limiting factor it reports.
 */
import { describe, expect, it } from 'vitest';
import { CSETTLE, GOVERNOR, SettleGovernor } from '../lib/settle.ts';

/**
 * A paced run: live batches of 8 frames at `fps` (sent on time, no wait),
 * `update` after each, and each whole chunk owed asked for and answered at
 * once unless `supply` (frames per second the settle workers deliver) is set.
 */
function drive(
  g: SettleGovernor,
  o: {
    fps: number;
    seconds: number;
    t0?: number;
    end0?: number;
    /** Live fps actually achieved (default `fps`). */
    achieved?: number;
    waitMs?: (t: number) => number;
    gapAt?: (t: number) => boolean;
    supply?: number;
    busyShare?: number;
    library?: boolean;
  },
): { t: number; end: number; asked: number } {
  const live = o.achieved ?? o.fps;
  const period = (8 * 1000) / live;
  let t = o.t0 ?? 0;
  let end = o.end0 ?? 0;
  let asked = 0;
  let supplyCredit = 0;
  const stop = t + o.seconds * 1000;
  while (t < stop) {
    t += period;
    end += 8;
    g.liveBatch(t, end, 8, o.waitMs?.(t) ?? 0, o.gapAt?.(t) ?? false);
    g.update(t, o.library ?? true);
    supplyCredit += o.supply !== undefined ? (o.supply * period) / 1000 : Infinity;
    while (g.ready && supplyCredit >= CSETTLE.chunk) {
      g.spend(CSETTLE.chunk);
      asked += CSETTLE.chunk;
      supplyCredit = Number.isFinite(supplyCredit) ? supplyCredit - CSETTLE.chunk : supplyCredit;
      g.delivered(
        CSETTLE.chunk,
        (o.busyShare ?? 0.5) * ((CSETTLE.chunk * 1000) / (o.supply ?? 1000)),
      );
    }
    if (Number.isFinite(supplyCredit)) supplyCredit = Math.min(supplyCredit, CSETTLE.chunk);
  }
  return { t, end, asked };
}

describe('SettleGovernor', () => {
  it('is off at Max: no credit, whatever the cap', () => {
    const g = new SettleGovernor(2);
    g.setTarget(0, false);
    const r = drive(g, { fps: 200, seconds: 10 });
    expect(r.asked).toBe(0);
    expect(g.limit).toBe('off');
    expect(g.rate).toBe(0);
  });

  it('sends no settle read before the first library', () => {
    const g = new SettleGovernor(2);
    g.setTarget(60, false);
    const r = drive(g, { fps: 60, seconds: 10, library: false });
    expect(r.asked).toBe(0);
    expect(g.limit).toBe('waiting');
    expect(g.owed).toBe(0);
  });

  it('ramps up by 8 frames/s a second, to the cap x achieved fps', () => {
    const g = new SettleGovernor(2);
    g.setTarget(60, false);
    // Checks about once a second (each at least `checkMs` after the last batch's check).
    const r0 = drive(g, { fps: 60, seconds: 5.5 });
    expect(g.limit).toBe('ramping');
    expect(g.rate).toBe(5 * GOVERNOR.stepFps);
    const r1 = drive(g, { fps: 60, seconds: 20, t0: r0.t, end0: r0.end });
    expect(g.limit).toBe('cap');
    expect(g.rate).toBeCloseTo(120, 0);
    // The rate is what is asked for.
    const r = drive(g, { fps: 60, seconds: 10, t0: r1.t, end0: r1.end });
    expect(r.asked / 10).toBeGreaterThan(110);
    expect(r.asked / 10).toBeLessThan(130);
  });

  it('halves on a batch wait over half a batch period, then names the slow worker', () => {
    const g = new SettleGovernor(2);
    g.setTarget(60, false);
    let r = drive(g, { fps: 60, seconds: 20 });
    expect(g.rate).toBeCloseTo(120, 0);
    // Half a batch period at 60 fps is 67 ms: 60 ms is fine, 80 ms is not.
    r = drive(g, { fps: 60, seconds: 2, t0: r.t, end0: r.end, waitMs: () => 60 });
    expect(g.limit).toBe('cap');
    const before = g.rate;
    let once = false;
    r = drive(g, {
      fps: 60,
      seconds: 1.05,
      t0: r.t,
      end0: r.end,
      waitMs: () => (once ? 0 : ((once = true), 80)),
    });
    expect(g.rate).toBeCloseTo(before / 2, 6);
    expect(g.limit).toBe('backing-off');
    r = drive(g, { fps: 60, seconds: 2, t0: r.t, end0: r.end });
    expect(g.limit).toBe('slow-worker');
    expect(g.status().slowHalvings).toBe(1);
    // No trouble for longer than `recentMs`: back to the cap.
    drive(g, { fps: 60, seconds: 15, t0: r.t, end0: r.end });
    expect(g.limit).toBe('cap');
  });

  it('halves on a forward-pool drop', () => {
    const g = new SettleGovernor(2);
    g.setTarget(30, false);
    const r = drive(g, { fps: 30, seconds: 12 });
    const before = g.rate;
    expect(before).toBeCloseTo(60, 0);
    let once = false;
    drive(g, {
      fps: 30,
      seconds: 1.1,
      t0: r.t,
      end0: r.end,
      gapAt: () => (once ? false : ((once = true), true)),
    });
    expect(g.rate).toBeCloseTo(before / 2, 6);
    expect(g.status().halvings).toBe(1);
  });

  it('halves while the achieved fps is under 97 % of the target; at 0 Discover is the limit, probing every 5 s', () => {
    const g = new SettleGovernor(2);
    g.setTarget(60, false);
    let r = drive(g, { fps: 60, seconds: 20 });
    expect(g.rate).toBeCloseTo(120, 0);
    // 96 % of the target: halved once a second down to 0.
    r = drive(g, { fps: 60, achieved: 57.6, seconds: 12, t0: r.t, end0: r.end });
    expect(g.rate).toBeLessThanOrEqual(GOVERNOR.stepFps);
    r = drive(g, { fps: 60, achieved: 57.6, seconds: 3, t0: r.t, end0: r.end });
    expect(g.limit).toBe('discover');
    // A probe of one step at most every 5 s: little is asked meanwhile.
    const p = drive(g, { fps: 60, achieved: 57.6, seconds: 20, t0: r.t, end0: r.end });
    expect(p.asked).toBeLessThan(20 * GOVERNOR.stepFps * 0.5);
    expect(g.limit).toBe('discover');
    // 98 % is within the guard: it climbs again.
    drive(g, { fps: 60, achieved: 58.8, seconds: 10, t0: p.t, end0: p.end });
    expect(g.rate).toBeGreaterThan(GOVERNOR.stepFps * 5);
  });

  it('a stall (no batch for a while) counts as below the target', () => {
    const g = new SettleGovernor(2);
    g.setTarget(60, false);
    const r = drive(g, { fps: 60, seconds: 20 });
    const before = g.rate;
    g.update(r.t + 1500, true);
    g.update(r.t + 2600, true);
    expect(g.rate).toBeLessThan(before);
  });

  it('a pause is not trouble: nothing earned or halved meanwhile, the window restarts on resume', () => {
    const g = new SettleGovernor(2);
    g.setTarget(60, false);
    const r = drive(g, { fps: 60, seconds: 20 });
    const before = g.rate;
    g.spend(g.owed);
    g.setTarget(60, true);
    for (let t = r.t; t < r.t + 10_000; t += 100) g.update(t, true);
    expect(g.rate).toBe(before);
    expect(g.owed).toBe(0);
    g.setTarget(60, false);
    drive(g, { fps: 60, seconds: 3, t0: r.t + 10_000, end0: r.end });
    expect(g.rate).toBeCloseTo(before, 0);
  });

  it('the bank full with busy settle workers: look-back is the limit, at what they deliver', () => {
    const g = new SettleGovernor(2);
    g.setTarget(120, false);
    drive(g, { fps: 120, seconds: 40, supply: 110, busyShare: 0.95 });
    expect(g.limit).toBe('look-back');
    expect(g.rate).toBeGreaterThan(80);
    expect(g.rate).toBeLessThan(140);
  });

  it('the bank full with idle settle workers: the slow worker is the limit', () => {
    const g = new SettleGovernor(2);
    g.setTarget(120, false);
    drive(g, { fps: 120, seconds: 40, supply: 110, busyShare: 0.3 });
    expect(g.limit).toBe('slow-worker');
  });

  it('banks at most four chunks', () => {
    const g = new SettleGovernor(2);
    g.setTarget(60, false);
    let t = 0;
    let end = 0;
    for (; t < 30_000; t += 133) {
      end += 8;
      g.liveBatch(t, end, 8, 0, false);
      g.update(t, true);
    }
    expect(g.owed).toBe(CSETTLE.chunk * CSETTLE.bankChunks);
  });
});
