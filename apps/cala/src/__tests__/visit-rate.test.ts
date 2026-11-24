import { describe, expect, it } from 'vitest';
import {
  effectivePace,
  VISIT_RATE,
  VisitRateGovernor,
  visitHoldText,
  visitRateCap,
  visitRateMode,
  type VisitRateMode,
  type VisitRateSample,
} from '../lib/visit-rate.ts';

describe('visit-rate helpers', () => {
  it('combines the user target with the hold', () => {
    expect(effectivePace(0, null)).toBe(0);
    expect(effectivePace(30, null)).toBe(30);
    expect(effectivePace(0, 80)).toBe(80);
    expect(effectivePace(30, 80)).toBe(30);
    expect(effectivePace(120, 80)).toBe(80);
  });

  it('picks the mode: URL off wins, a live stream keeps only the cap', () => {
    expect(visitRateMode(false, false)).toBe('on');
    expect(visitRateMode(false, true)).toBe('cap-only');
    expect(visitRateMode(true, false)).toBe('off');
    expect(visitRateMode(true, true)).toBe('off');
    expect(visitRateCap('on')).toBe(VISIT_RATE.cap);
    expect(visitRateCap('cap-only')).toBe(VISIT_RATE.cap);
    expect(visitRateCap('off')).toBe(0);
  });

  it('says the hold only while it binds', () => {
    expect(visitHoldText(null, 0)).toBeNull();
    expect(visitHoldText(80, 60)).toBeNull();
    expect(visitHoldText(42.4, 0)).toBe(
      `Held at 42 fps to keep refinement at ${VISIT_RATE.target} visits/frame`,
    );
    expect(visitHoldText(42.4, 60)).toContain('Held at 42 fps');
  });
});

/**
 * A simulated machine: the frame loop reads at `maxFps` unpaced (or the effective pace), and the
 * slow side makes visits at `capacity(fps)` per second (less when it also has more frames to
 * observe). The engine's cap (credit `cap` per observed frame) and demand (tiles due) are modelled.
 */
function simulate(o: {
  mode?: VisitRateMode;
  maxFps: number;
  capacity: (fps: number) => number;
  userFps?: number;
  /** Frames dropped for the slow loop at this read rate (share). */
  dropShare?: (fps: number) => number;
  demand?: boolean;
  seconds?: number;
  stepMs?: number;
}) {
  const gov = new VisitRateGovernor(o.mode ?? 'on');
  const step = o.stepMs ?? 250;
  const user = o.userFps ?? 0;
  let t = 0;
  let read = 0;
  let observed = 0;
  let visits = 0;
  let capped = 0;
  let credit = 0;
  const fpsLog: number[] = [];
  const seconds = o.seconds ?? 300;
  for (let i = 0; i < (seconds * 1000) / step; i++) {
    const pace = effectivePace(user, gov.fps);
    const fps = pace > 0 ? Math.min(pace, o.maxFps) : o.maxFps;
    fpsLog.push(fps);
    const dRead = (fps * step) / 1000;
    const dObs = dRead * (1 - (o.dropShare?.(fps) ?? 0));
    let dVisits = (o.capacity(fps) * step) / 1000;
    if (o.demand === false) dVisits = 0;
    if (o.mode !== 'off') {
      credit = Math.min(credit + VISIT_RATE.cap * dObs, 16 * VISIT_RATE.cap);
      if (dVisits > credit) {
        dVisits = credit;
        capped += dObs;
      }
      credit -= dVisits;
    }
    t += step;
    read += dRead;
    observed += dObs;
    visits += dVisits;
    const s: VisitRateSample = {
      now: t,
      framesRead: read,
      observed,
      visits,
      cappedFrames: capped,
      dueTiles: o.demand === false ? 0 : 5,
      userFps: user,
    };
    gov.update(s);
  }
  const tail = fpsLog.slice(-Math.round(60_000 / step));
  return { gov, summary: gov.summary(), tailFps: tail.reduce((a, b) => a + b, 0) / tail.length };
}

describe('VisitRateGovernor', () => {
  // A saturated Max run: 200 fps read, ~44 visits/s (0.22 per frame), more when slower.
  const capacity = (fps: number) => 60 - 0.08 * fps;

  it('holds a saturated Max run to the speed that keeps the target', () => {
    const { gov, summary, tailFps } = simulate({ maxFps: 200, capacity });
    expect(gov.fps).not.toBeNull();
    // Fixed point: capacity(f) / f = target.
    const fStar = 60 / (VISIT_RATE.target + 0.08);
    expect(tailFps).toBeGreaterThan(0.8 * fStar);
    expect(tailFps).toBeLessThan(1.2 * fStar);
    // Over the run the achieved rate sits at the target (above the floor), well below the cap.
    expect(summary.achieved_visits_per_frame).toBeGreaterThan(VISIT_RATE.floor);
    expect(summary.achieved_visits_per_frame!).toBeGreaterThan(0.85 * VISIT_RATE.target);
    expect(summary.achieved_visits_per_frame!).toBeLessThan(1.2 * VISIT_RATE.target);
    expect(summary.held_s).toBeGreaterThan(250);
    expect(summary.min_hold_fps).not.toBeNull();
    expect(summary.hold_changes.length).toBeGreaterThan(0);
  });

  it('counts dropped frames against the target (per frame read)', () => {
    // A third of the frames never reach the slow loop at speed; fewer when slower.
    const drop = (fps: number) => Math.max(0, Math.min(0.33, (fps - 120) / 240));
    const { summary } = simulate({ maxFps: 200, capacity, dropShare: drop });
    expect(summary.achieved_visits_per_frame!).toBeGreaterThan(0.85 * VISIT_RATE.target);
  });

  it('does not hold a paced run whose visits the cap limits', () => {
    // 30 fps with room for 140 visits/s: the cap (1 per frame) binds, nothing is behind.
    const { gov, summary } = simulate({ maxFps: 200, capacity: () => 140, userFps: 30 });
    expect(gov.fps).toBeNull();
    expect(summary.held_s).toBe(0);
    expect(summary.achieved_visits_per_frame!).toBeLessThanOrEqual(VISIT_RATE.cap + 1e-9);
    expect(summary.achieved_visits_per_frame!).toBeGreaterThan(0.9 * VISIT_RATE.cap);
  });

  it('does not hold when nothing is due', () => {
    const { gov } = simulate({ maxFps: 200, capacity, demand: false });
    expect(gov.fps).toBeNull();
  });

  it('keeps a user target that is already slow enough', () => {
    // 50 fps target: capacity 56/s gives 1.1 visits per frame (capped at 1): no hold.
    const { gov } = simulate({ maxFps: 200, capacity, userFps: 50 });
    expect(gov.fps).toBeNull();
  });

  it('slows a fast Fixed target that the visits cannot keep up with', () => {
    const { gov, tailFps } = simulate({ maxFps: 200, capacity, userFps: 180 });
    expect(gov.fps).not.toBeNull();
    expect(tailFps).toBeLessThan(180);
  });

  it('releases the hold once the user target is lower', () => {
    const gov = new VisitRateGovernor('on');
    let t = 0;
    let read = 0;
    let visits = 0;
    const feed = (fps: number, perFrame: number, user: number) => {
      t += 250;
      read += fps / 4;
      visits += (fps / 4) * perFrame;
      return gov.update({
        now: t,
        framesRead: read,
        observed: read,
        visits,
        cappedFrames: 0,
        dueTiles: 3,
        userFps: user,
      });
    };
    for (let i = 0; i < 40; i++) feed(200, 0.15, 0);
    expect(gov.fps).not.toBeNull();
    const held = gov.fps!;
    // The user picks a target below the hold: released.
    let released = false;
    for (let i = 0; i < 40; i++) if (feed(held / 2, 0.5, held / 2)?.fps === null) released = true;
    expect(released).toBe(true);
    expect(gov.fps).toBeNull();
  });

  it('cuts harder below the floor', () => {
    const gov = new VisitRateGovernor('on');
    let t = 0;
    let read = 0;
    let visits = 0;
    let change = null;
    for (let i = 0; i < 40 && !change; i++) {
      t += 250;
      read += 50;
      visits += 50 * 0.1;
      change = gov.update({
        now: t,
        framesRead: read,
        observed: read,
        visits,
        cappedFrames: 0,
        dueTiles: 2,
        userFps: 0,
      });
    }
    expect(change?.reason).toBe('below-floor');
    // Throughput 20 visits/s: 20 / 0.4 = 50 fps, cut to 37.5.
    expect(change!.fps).toBeCloseTo((20 / VISIT_RATE.target) * VISIT_RATE.floorCut, 5);
  });

  it('never holds in cap-only (live) or off mode, but still reports the rate', () => {
    for (const mode of ['cap-only', 'off'] as const) {
      const { gov, summary } = simulate({ mode, maxFps: 300, capacity });
      expect(gov.fps).toBeNull();
      expect(summary.mode).toBe(mode);
      expect(summary.held_s).toBe(0);
      expect(summary.achieved_visits_per_frame!).toBeLessThan(VISIT_RATE.floor + 0.05);
      expect(summary.below_floor_s).toBeGreaterThan(0);
      expect(summary.cap).toBe(mode === 'off' ? 0 : VISIT_RATE.cap);
    }
  });

  it('waits for the warm-up before acting', () => {
    const gov = new VisitRateGovernor('on');
    for (let i = 1; i <= 20; i++) {
      gov.update({
        now: i * 250,
        framesRead: i * 5,
        observed: i * 5,
        visits: 0,
        cappedFrames: 0,
        dueTiles: 5,
        userFps: 0,
      });
    }
    expect(gov.fps).toBeNull();
  });
});
