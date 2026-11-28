// @vitest-environment node
/**
 * The settle governor (`SettleGovernor`): the Background settle's dose in re-read frames per
 * live frame, climbing with the live frames observed up to the cap, never reading a clock; the
 * bank and the frames that slip past it; and the readout.
 */
import { describe, expect, it } from 'vitest';
import { CSETTLE } from '../lib/settle.ts';
import { GOVERNOR, GOVERNOR_LIMIT_TEXT, SettleGovernor } from '../lib/settle-governor.ts';

/** Re-read frames earned by the first `n` live frames with a library at cap `cap`. */
function earned(n: number, cap: number): number {
  let s = 0;
  for (let k = 1; k <= n; k++) s += Math.min(cap, k / GOVERNOR.rampFrames);
  return s;
}

/** Live batches of `batch` frames until `frames` are observed; each whole chunk owed is spent at once. */
function feed(g: SettleGovernor, frames: number, batch = 8): number {
  let asked = 0;
  for (let done = 0; done < frames; done += batch) {
    g.liveFrames(Math.min(batch, frames - done), true);
    while (g.ready) {
      g.spend(CSETTLE.chunk);
      asked += CSETTLE.chunk;
    }
  }
  return asked;
}

function paced(cap: number = CSETTLE.rate, fps = 60): SettleGovernor {
  const g = new SettleGovernor(cap);
  g.setTarget(fps, false);
  return g;
}

describe('SettleGovernor', () => {
  it('is off at Max and with the cap Off: nothing is owed', () => {
    const max = new SettleGovernor(2);
    max.setTarget(0, false);
    max.liveFrames(800, true);
    expect(max.owed).toBe(0);
    expect(max.limit).toBe('off');
    const off = paced(0);
    off.liveFrames(800, true);
    expect(off.owed).toBe(0);
    expect(off.limit).toBe('cap-off');
  });

  it('owes nothing before the first library', () => {
    const g = paced();
    g.liveFrames(400, false);
    expect(g.owed).toBe(0);
    expect(g.rate).toBe(0);
    expect(g.limit).toBe('waiting');
  });

  it('earns the climbing dose per live frame, whatever the batching or the clock', () => {
    const a = paced();
    const b = paced();
    const askedA = feed(a, 600, 8);
    // Other batch sizes, and readout updates at arbitrary times, change nothing.
    for (const [i, n] of [3, 5, 8, 8, 1, 7].entries()) {
      b.update(i * 977, true);
      b.liveFrames(n, true);
    }
    const askedB = feed(b, 600 - 32, 16);
    expect(askedA + a.owed).toBeCloseTo(earned(600, 2), 6);
    expect(askedB + b.owed).toBeCloseTo(earned(600, 2), 6);
    expect(askedA).toBe(askedB);
  });

  it('climbs to the cap after cap x rampFrames live frames, then holds it', () => {
    const g = paced(1);
    feed(g, GOVERNOR.rampFrames - 1);
    g.update(0, true);
    g.update(GOVERNOR.checkMs, true);
    expect(g.limit).toBe('ramping');
    feed(g, 1);
    g.update(2 * GOVERNOR.checkMs, true);
    expect(g.limit).toBe('cap');
    // The dose as a rate at the target: 1 re-read frame per live frame at 60 fps.
    expect(g.rate).toBeCloseTo(60);
    const before = g.owed;
    g.liveFrames(8, true);
    expect(g.owed - before).toBeCloseTo(8);
  });

  it('a lower cap holds the dose down at once', () => {
    const g = paced(2);
    feed(g, 2 * GOVERNOR.rampFrames);
    g.setCap(0.5);
    const before = g.owed;
    g.liveFrames(8, true);
    expect(g.owed - before).toBeCloseTo(4);
  });

  it('starts the climb again after Max', () => {
    const g = paced();
    feed(g, 900);
    g.setTarget(0, false);
    expect(g.owed).toBe(0);
    g.setTarget(60, false);
    g.liveFrames(1, true);
    expect(g.owed).toBeCloseTo(1 / GOVERNOR.rampFrames);
  });

  it('drops nothing owed, and names who falls behind when the backlog passes the bank', () => {
    const g = paced();
    const bank = CSETTLE.chunk * CSETTLE.bankChunks;
    // Nothing is taken: everything earned stays owed.
    g.liveFrames(1000, true);
    expect(g.owed).toBeCloseTo(earned(1000, 2), 6);
    g.setBacklog(bank + 1);
    g.update(0, true);
    g.delivered(16, 900);
    g.update(GOVERNOR.checkMs, true);
    expect(g.limit).toBe('look-back');
    g.update(2 * GOVERNOR.checkMs, true);
    expect(g.limit).toBe('slow-worker');
    g.setBacklog(bank);
    g.update(3 * GOVERNOR.checkMs, true);
    expect(g.limit).toBe('cap');
    expect(g.status().backlog).toBe(bank);
  });

  it('reports the achieved live fps from the batches it saw', () => {
    const g = paced();
    for (let k = 1; k <= 40; k++) g.liveBatch((k * 8000) / 60, 8 * k);
    g.update(0, true);
    g.update((40 * 8000) / 60, true);
    expect(g.status().achieved).toBeCloseTo(60, 0);
    expect(g.status().capFps).toBeCloseTo(120, 0);
  });

  it('has words for every limit', () => {
    for (const v of Object.values(GOVERNOR_LIMIT_TEXT)) expect(v.length).toBeGreaterThan(0);
  });
});
