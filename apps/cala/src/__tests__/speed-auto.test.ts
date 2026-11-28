import { describe, expect, it } from 'vitest';
import {
  AUTO,
  AUTO_BUDGETS,
  AUTO_DEFAULT_BUDGET,
  AutoPolicy,
  budgetLabel,
  isAutoBudget,
  PauseClock,
} from '../lib/speed-auto.ts';
import { SpeedDriver, type PolicyInput } from '../lib/speed-schedule.ts';
import { parseSpeedSettings } from '../lib/speed-track.ts';

/** Five batches at Max with the same estimate, then the policy answers; returns the answer. */
const first = (p: AutoPolicy, o: Partial<PolicyInput> = {}) => {
  for (let k = 1; k < AUTO.minBatches; k++) p.target(input(0, 0, o));
  return p.target(input(0, 0, o));
};
const input = (frame: number, wallS: number, o: Partial<PolicyInput> = {}): PolicyInput => ({
  frame,
  totalFrames: 12000,
  floorFps: 60,
  seeAllFps: 135,
  maxFps: 200,
  wallS,
  ...o,
});

describe('Auto budget', () => {
  it('names the three choices, +100 % by default', () => {
    expect(AUTO_BUDGETS.map(budgetLabel)).toEqual(['+50 %', '+100 %', '+200 %']);
    expect(AUTO_DEFAULT_BUDGET).toBe(1);
    expect(isAutoBudget(2)).toBe(true);
    expect(isAutoBudget(3)).toBe(false);
    expect(parseSpeedSettings(JSON.stringify({ mode: 'auto', autoBudget: 2 }))).toMatchObject({
      mode: 'auto',
      autoBudget: 2,
    });
    expect(parseSpeedSettings(JSON.stringify({ autoBudget: 7 })).autoBudget).toBe(1);
  });

  it('sets the target so the run ends at (1 + share) x the Max time', () => {
    // 12000 frames at Max 200 fps: 60 s. +100 % is 120 s: 100 fps. +50 % is 90 s: 133 -> 120.
    // +200 % is 180 s: 66.7 -> the ladder step 60.
    const at = (share: number) => first(new AutoPolicy(share));
    expect(at(1)).toEqual({ fps: 100, phase: 'auto' });
    expect(at(0.5).fps).toBe(120);
    expect(at(2).fps).toBe(60);
  });

  it('runs at Max until the Max rate is known, and for a stream (no frame count)', () => {
    const p = new AutoPolicy(1);
    expect(p.target(input(0, 0, { maxFps: null }))).toEqual({ fps: 0, phase: 'auto-measure' });
    expect(p.current()).toBeNull();
    expect(p.target(input(10, 1, { totalFrames: 0 })).fps).toBe(0);
    for (let k = 0; k < AUTO.minBatches - 2; k++) p.target(input(100, 2));
    expect(p.target(input(100, 2)).phase).toBe('auto');
    expect(p.current()).toBe(100);
  });

  it('never goes below the floor, and says so', () => {
    const p = new AutoPolicy(2);
    expect(first(p, { floorFps: 80 }).fps).toBe(80);
    expect(p.decisions[0]).toMatchObject({ frame: 0, fps: 80, reason: 'floor', max_fps: 200 });
  });

  it('is Max when the budget needs Max or more, or the floor is at Max', () => {
    // Behind schedule: 100 s gone, 11000 frames left, 20 s of budget left.
    const behind = new AutoPolicy(1);
    first(behind);
    expect(behind.target(input(1000, 100))).toMatchObject({ fps: 0 });
    expect(behind.decisions[1].reason).toBe('max');
    // Out of budget.
    const over = new AutoPolicy(1);
    first(over);
    over.target(input(1000, 130));
    expect(over.decisions[1]).toMatchObject({ fps: 0, reason: 'over budget', left_s: 0 });
    // A floor at or above Max: nothing below Max helps.
    expect(first(new AutoPolicy(2), { floorFps: 250 }).fps).toBe(0);
  });

  it('counts the final settle estimate against the budget', () => {
    // 120 s budget, 20 s for the final settle: 100 s for 12000 frames = 120 fps.
    expect(first(new AutoPolicy(1, () => 20)).fps).toBe(120);
  });

  it('looks again every 2000 frames or 30 s, not in between', () => {
    const p = new AutoPolicy(1);
    first(p);
    // Far behind, but not due: the target stays.
    expect(p.target(input(1000, 29)).fps).toBe(100);
    expect(p.decisions).toHaveLength(1);
    // Due by frames.
    expect(p.target(input(2000, 40)).fps).toBe(120);
    // Due by time: 30 s after the last look (500 frames on).
    expect(p.target(input(2500, 73))).toMatchObject({ fps: 0 });
    expect(p.decisions.map((d) => d.frame)).toEqual([0, 2000, 2500]);
  });

  it('keeps a target against a small change (hysteresis)', () => {
    const p = new AutoPolicy(1.5);
    const k = { maxFps: 1000 };
    expect(first(p, k).fps).toBe(400);
    // Wants 450 (12.5 % up): kept.
    expect(p.target(input(2000, 7.3, k)).fps).toBe(400);
    expect(p.decisions).toHaveLength(1);
    // Wants 550: taken.
    expect(p.target(input(4000, 14, k)).fps).toBeGreaterThan(400);
    expect(p.decisions).toHaveLength(2);
    // A Max run stays Max against a wish within 15 % of it.
    const m = new AutoPolicy(0.5);
    expect(first(m, { maxFps: 100, floorFps: 100 }).fps).toBe(0);
    expect(m.target(input(2000, 48, { maxFps: 160, floorFps: 10 })).fps).toBe(0);
  });

  it('plugs into the driver: a change is reported once, source auto', () => {
    const d = new SpeedDriver(new AutoPolicy(1));
    expect(d.tick(input(0, 0, { maxFps: null }))).toEqual({ fps: 0, source: 'auto' });
    for (let k = 1; k < AUTO.minBatches; k++) expect(d.tick(input(8 * k, k))).toBeNull();
    const at = AUTO.minBatches;
    expect(d.tick(input(8 * at, at))).toEqual({ fps: 100, source: 'auto' });
    expect(d.tick(input(8 * at + 8, at + 1))).toBeNull();
  });

  it('keeps the first decision and the newest, a bounded list', () => {
    const p = new AutoPolicy(1);
    first(p);
    // Alternate between on schedule and out of budget so every look changes the target.
    for (let k = 1; k < 100; k++) {
      p.target(input(k * AUTO.evalFrames, k % 2 ? 1 : 1e6, { totalFrames: 1e6 }));
    }
    expect(p.decisions.length).toBeLessThanOrEqual(AUTO.maxDecisions);
    expect(p.decisions[0].frame).toBe(0);
    expect(p.decisions[p.decisions.length - 1].frame).toBeGreaterThan(90 * AUTO.evalFrames);
  });
});

describe('Auto budget use', () => {
  it('is unknown until the budget is worked out, then counts the time since the first look', () => {
    const p = new AutoPolicy(1);
    expect(p.budgetUse(5)).toBeNull();
    first(p);
    // 12000 frames at Max 200 fps is 60 s; +100 % is a 120 s budget, from wall 0.
    expect(p.budgetUse(30)).toEqual({ usedS: 30, budgetS: 120 });
    // Reading it changes nothing.
    expect(p.current()).toBe(100);
    expect(p.decisions).toHaveLength(1);
  });
});

describe('Auto measures Max before it trusts it', () => {
  it('holds Max until five unpaced batches, ignoring a slow warm-up reading less than that', () => {
    const p = new AutoPolicy(1);
    for (let k = 0; k < AUTO.minBatches - 1; k++)
      expect(p.target(input(0, 0, { maxFps: 50 }))).toEqual({ fps: 0, phase: 'auto-measure' });
    expect(p.current()).toBeNull();
    expect(p.target(input(0, 0, { maxFps: 200 })).fps).toBe(100);
  });

  it('keeps the Max it measured while paced, and lets it only rise', () => {
    const p = new AutoPolicy(1);
    first(p);
    expect(p.current()).toBe(100);
    // Settling contention reads Max low while paced: no feedback toward the floor.
    expect(p.target(input(2000, 20, { maxFps: 60 })).fps).toBe(100);
    expect(p.decisions.every((d) => d.max_fps === 200)).toBe(true);
    // A higher reading is taken: 12000 frames at 400 fps is 30 s, budget 60 s, 8000 left in 40 s.
    expect(p.target(input(4000, 20, { maxFps: 400 })).fps).toBe(200);
    expect(p.decisions[p.decisions.length - 1].max_fps).toBe(400);
  });

  it('reads Max afresh while it is running at Max', () => {
    const p = new AutoPolicy(1);
    first(p, { floorFps: 250 });
    expect(p.current()).toBe(0);
    p.target(input(2000, 10, { maxFps: 100, floorFps: 10 }));
    expect(p.decisions[p.decisions.length - 1].max_fps).toBe(100);
  });
});

describe('PauseClock', () => {
  it('leaves paused time out, open pauses included', () => {
    const c = new PauseClock();
    expect(c.now(1000)).toBe(1000);
    c.pause(2000);
    expect(c.now(5000)).toBe(2000);
    c.resume(5000);
    expect(c.now(6000)).toBe(3000);
    c.pause(7000);
    c.pause(7500);
    c.resume(9000);
    expect(c.now(10000)).toBe(5000);
    c.reset();
    expect(c.now(10000)).toBe(10000);
  });
});
