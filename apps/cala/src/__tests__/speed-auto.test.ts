import { describe, expect, it } from 'vitest';
import {
  AUTO,
  AUTO_BUDGETS,
  AUTO_DEFAULT_BUDGET,
  AutoPolicy,
  budgetLabel,
  isAutoBudget,
} from '../lib/speed-auto.ts';
import { SpeedDriver, type PolicyInput } from '../lib/speed-schedule.ts';
import { parseSpeedSettings } from '../lib/speed-track.ts';

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
    const at = (share: number) => new AutoPolicy(share).target(input(0, 0));
    expect(at(1)).toEqual({ fps: 100, phase: 'auto' });
    expect(at(0.5).fps).toBe(120);
    expect(at(2).fps).toBe(60);
  });

  it('runs at Max until the Max rate is known, and for a stream (no frame count)', () => {
    const p = new AutoPolicy(1);
    expect(p.target(input(0, 0, { maxFps: null }))).toEqual({ fps: 0, phase: 'auto-measure' });
    expect(p.current()).toBeNull();
    expect(p.target(input(10, 1, { totalFrames: 0 })).fps).toBe(0);
    expect(p.target(input(100, 2)).phase).toBe('auto');
    expect(p.current()).toBe(100);
  });

  it('never goes below the floor, and says so', () => {
    const p = new AutoPolicy(2);
    expect(p.target(input(0, 0, { floorFps: 80 })).fps).toBe(80);
    expect(p.decisions[0]).toMatchObject({ frame: 0, fps: 80, reason: 'floor', max_fps: 200 });
  });

  it('is Max when the budget needs Max or more, or the floor is at Max', () => {
    // Behind schedule: 100 s gone, 11000 frames left, 20 s of budget left.
    const behind = new AutoPolicy(1);
    behind.target(input(0, 0));
    expect(behind.target(input(1000, 100))).toMatchObject({ fps: 0 });
    expect(behind.decisions[1].reason).toBe('max');
    // Out of budget.
    const over = new AutoPolicy(1);
    over.target(input(0, 0));
    over.target(input(1000, 130));
    expect(over.decisions[1]).toMatchObject({ fps: 0, reason: 'over budget', left_s: 0 });
    // A floor at or above Max: nothing below Max helps.
    expect(new AutoPolicy(2).target(input(0, 0, { floorFps: 250 })).fps).toBe(0);
  });

  it('counts the final settle estimate against the budget', () => {
    // 120 s budget, 20 s for the final settle: 100 s for 12000 frames = 120 fps.
    expect(new AutoPolicy(1, () => 20).target(input(0, 0)).fps).toBe(120);
  });

  it('looks again every 2000 frames or 30 s, not in between', () => {
    const p = new AutoPolicy(1);
    p.target(input(0, 0));
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
    expect(p.target(input(0, 0, k)).fps).toBe(400);
    // Wants 450 (12.5 % up): kept.
    expect(p.target(input(2000, 7.3, k)).fps).toBe(400);
    expect(p.decisions).toHaveLength(1);
    // Wants 550: taken.
    expect(p.target(input(4000, 14, k)).fps).toBeGreaterThan(400);
    expect(p.decisions).toHaveLength(2);
    // A Max run stays Max against a wish within 15 % of it.
    const m = new AutoPolicy(0.5);
    expect(m.target(input(0, 0, { maxFps: 100, floorFps: 100 })).fps).toBe(0);
    expect(m.target(input(2000, 48, { maxFps: 160, floorFps: 10 })).fps).toBe(0);
  });

  it('plugs into the driver: a change is reported once, source auto', () => {
    const d = new SpeedDriver(new AutoPolicy(1));
    expect(d.tick(input(0, 0, { maxFps: null }))).toEqual({ fps: 0, source: 'auto' });
    expect(d.tick(input(8, 1))).toEqual({ fps: 100, source: 'auto' });
    expect(d.tick(input(16, 2))).toBeNull();
  });

  it('keeps the first decision and the newest, a bounded list', () => {
    const p = new AutoPolicy(1);
    p.target(input(0, 0));
    // Alternate between on schedule and out of budget so every look changes the target.
    for (let k = 1; k < 100; k++) {
      p.target(input(k * AUTO.evalFrames, k % 2 ? 1 : 1e6, { totalFrames: 1e6 }));
    }
    expect(p.decisions.length).toBeLessThanOrEqual(AUTO.maxDecisions);
    expect(p.decisions[0].frame).toBe(0);
    expect(p.decisions[p.decisions.length - 1].frame).toBeGreaterThan(90 * AUTO.evalFrames);
  });
});
