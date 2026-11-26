import { describe, expect, it } from 'vitest';
import {
  effectivePace,
  heldMaxFps,
  VISIT_RATE,
  VisitRateGovernor,
  visitHoldText,
  maxRepeatText,
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

  it('lowers Max to what the visits allow, never raises it', () => {
    expect(heldMaxFps(300, null)).toBe(300);
    expect(heldMaxFps(300, 150)).toBe(150);
    expect(heldMaxFps(120, 150)).toBe(120);
    expect(heldMaxFps(0, null)).toBe(0);
    expect(heldMaxFps(0, 150)).toBe(150);
    expect(heldMaxFps(300, 0)).toBe(300);
    expect(heldMaxFps(Number.NaN, null)).toBe(0);
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
      // The engine banks at most 16 frames' credit between visits; a step spans many frames.
      credit = Math.min(credit, 16 * VISIT_RATE.cap) + VISIT_RATE.cap * dObs;
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
  // A saturated Max run: 200 fps read, ~24 visits/s (0.12 per frame), more when slower.
  const capacity = (fps: number) => 40 - 0.08 * fps;

  it('holds a saturated Max run to the speed that keeps the target', () => {
    const { gov, summary, tailFps } = simulate({ maxFps: 200, capacity });
    expect(gov.fps).not.toBeNull();
    // Fixed point: capacity(f) / f = target.
    const fStar = 40 / (VISIT_RATE.target + 0.08);
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

  it('gives the held speed as Max, not the fast loop top speed', () => {
    const { gov, tailFps } = simulate({ maxFps: 200, capacity });
    const fStar = 40 / (VISIT_RATE.target + 0.08);
    const vmax = gov.visitMaxFps;
    expect(vmax).not.toBeNull();
    // Close to the speed the run actually settles at, and well under the fast loop's 200 fps.
    expect(vmax!).toBeGreaterThan(0.85 * fStar);
    expect(vmax!).toBeLessThan(1.15 * fStar);
    expect(heldMaxFps(200, vmax)).toBeCloseTo(vmax!, 9);
    expect(Math.abs(heldMaxFps(200, vmax) - tailFps) / tailFps).toBeLessThan(0.2);
  });

  it('gives the held speed as Max for a fast Fixed target the visits cannot keep up with', () => {
    const { gov } = simulate({ maxFps: 300, capacity, userFps: 250 });
    const fStar = 40 / (VISIT_RATE.target + 0.08);
    expect(gov.visitMaxFps!).toBeGreaterThan(0.85 * fStar);
    expect(gov.visitMaxFps!).toBeLessThan(1.15 * fStar);
  });

  it('has no visit Max for a paced run the cap limits (its throughput is not its capacity)', () => {
    // 30 fps, room for 140 visits/s: throughput 0.2 x 30 = 6/s would read as 40 fps.
    const { gov } = simulate({ maxFps: 200, capacity: () => 140, userFps: 30 });
    expect(gov.visitMaxFps).toBeNull();
    expect(heldMaxFps(200, gov.visitMaxFps)).toBe(200);
  });

  it('raises the visit Max when the run later reads faster and keeps up', () => {
    const gov = new VisitRateGovernor('on');
    let t = 0;
    let read = 0;
    let visits = 0;
    const feed = (fps: number, perFrame: number, user: number) => {
      t += 250;
      read += fps / 4;
      visits += (fps / 4) * perFrame;
      gov.update({
        now: t,
        framesRead: read,
        observed: read,
        visits,
        cappedFrames: 0,
        dueTiles: 3,
        userFps: user,
      });
    };
    // Behind at 200 fps: 0.1 visits/frame, 20 visits/s -> 133 fps.
    for (let i = 0; i < 40; i++) feed(200, 0.1, 0);
    expect(gov.visitMaxFps!).toBeCloseTo(20 / VISIT_RATE.target, 0);
    // Later the visits keep up at 180 fps: the estimate follows up.
    for (let i = 0; i < 80; i++) feed(180, 0.2, 0);
    expect(gov.visitMaxFps!).toBeGreaterThan(170);
  });

  it('raises a hold below minWindowFrames fps once the visits allow it', () => {
    // Held at 5 fps (fewer than minWindowFrames frames per 1 s window) with visits to spare:
    // windows must stay open until they hold enough frames, or the hold can never rise.
    const gov = new VisitRateGovernor('on');
    let t = 0;
    let read = 0;
    let visits = 0;
    const feed = (fps: number, perSec: number) => {
      t += 100;
      read += fps / 10;
      visits += perSec / 10;
      gov.update({
        now: t,
        framesRead: Math.floor(read),
        observed: Math.floor(read),
        visits: Math.floor(visits),
        cappedFrames: 0,
        dueTiles: 3,
        userFps: 0,
      });
    };
    // Behind at 200 fps (1 visit/s): held down to the floor cut, below minWindowFrames fps.
    for (let i = 0; i < 40; i++) feed(gov.fps ?? 200, 1);
    expect(gov.fps!).toBeLessThan(VISIT_RATE.minWindowFrames);
    // The visits become cheap (30/s): the hold rises to where they keep the target.
    for (let i = 0; i < 1200; i++) feed(gov.fps ?? 200, 30);
    expect(gov.fps ?? Infinity).toBeGreaterThan(0.8 * (30 / VISIT_RATE.target));
  });

  it('counts dropped frames against the target (per frame read)', () => {
    // A third of the frames never reach the slow loop at speed; fewer when slower.
    const drop = (fps: number) => Math.max(0, Math.min(0.33, (fps - 120) / 240));
    const { summary } = simulate({ maxFps: 200, capacity, dropShare: drop });
    expect(summary.achieved_visits_per_frame!).toBeGreaterThan(0.85 * VISIT_RATE.target);
  });

  it('slows a run whose dropped frames keep it under the target while the cap binds', () => {
    // Visits to spare (the cap binds per observed frame), but at speed half the frames are
    // dropped, so unheld the run sits at 0.5 x cap per frame read (the floor), under the target.
    // Held, the drops fall to about 1 - dropMargin x target / cap and the rate rises to about
    // dropMargin x target.
    const drop = (fps: number) => Math.max(0, Math.min(0.5, (fps - 80) / 200));
    const { gov, summary } = simulate({ maxFps: 200, capacity: () => 500, dropShare: drop });
    expect(summary.held_s).toBeGreaterThan(0);
    expect(gov.summary().min_hold_fps!).toBeLessThan(200);
    expect(summary.achieved_visits_per_frame!).toBeGreaterThan(0.8 * VISIT_RATE.target);
  });

  it('does not hold a paced run whose visits the cap limits', () => {
    // 30 fps with room for 140 visits/s: the cap binds, nothing is behind.
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
    // 50 fps target: capacity 36/s gives 0.72 visits per frame (capped): no hold.
    const { gov } = simulate({ maxFps: 200, capacity, userFps: 50 });
    expect(gov.fps).toBeNull();
  });

  it('slows a fast Fixed target that the visits cannot keep up with', () => {
    // 250 fps target: about 20 visits/s, 0.08 per frame, under the target.
    const { gov, tailFps } = simulate({ maxFps: 300, capacity, userFps: 250 });
    expect(gov.fps).not.toBeNull();
    expect(tailFps).toBeLessThan(250);
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
    for (let i = 0; i < 40; i++) feed(200, 0.1, 0);
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
      visits += 50 * 0.05;
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
    // Throughput 10 visits/s: 10 / target fps, cut by floorCut.
    expect(change!.fps).toBeCloseTo((10 / VISIT_RATE.target) * VISIT_RATE.floorCut, 5);
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
      // Max stays the fast loop's own (the behaviour before).
      expect(gov.visitMaxFps).toBeNull();
      expect(heldMaxFps(300, gov.visitMaxFps)).toBe(300);
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

describe('VisitRateGovernor with the cap at the target', () => {
  it('does not hold a paced run pinned at the cap, though the engine counts one capped frame per batch', () => {
    const k = { ...VISIT_RATE, cap: VISIT_RATE.target };
    const gov = new VisitRateGovernor('on', k);
    let read = 0;
    let observed = 0;
    let capped = 0;
    // 30 fps, batches of 8 every 267 ms; a few frames dropped; every batch's credit spent.
    for (let i = 1; i <= 400; i++) {
      read += 8;
      observed += 7.8;
      const visits = Math.floor(observed * k.cap);
      capped += 1;
      gov.update({
        now: i * 267,
        framesRead: read,
        observed,
        visits,
        cappedFrames: capped,
        dueTiles: 20,
        userFps: 30,
      });
    }
    expect(gov.fps).toBeNull();
    expect(gov.summary().held_s).toBe(0);
  });
});

describe('VisitRateGovernor with whole visits at low paced rates', () => {
  // At 0.15 a 1 s window holds only a handful of visits (4.5 at 30 fps, 2.4 at the 16-frame
  // minimum): rounding a window's visits down must not read as behind while the cap binds.
  for (const fps of [16, 20, 24, 30, 45, 60]) {
    it(`does not hold a ${fps} fps paced run pinned at the cap`, () => {
      const gov = new VisitRateGovernor('on');
      const batch = 8;
      const dt = (batch / fps) * 1000;
      let read = 0;
      let observed = 0;
      let capped = 0;
      for (let i = 1; i <= 2000; i++) {
        read += batch;
        observed += batch - (i % 7 === 0 ? 1 : 0);
        // Every batch spends its whole visits; the engine counts one capped frame per hand-out.
        const visits = Math.floor(observed * VISIT_RATE.cap);
        capped += 1;
        gov.update({
          now: i * dt,
          framesRead: read,
          observed,
          visits,
          cappedFrames: capped,
          dueTiles: 20,
          userFps: fps,
        });
      }
      expect(gov.fps).toBeNull();
      expect(gov.summary().held_s).toBe(0);
      expect(gov.summary().achieved_visits_per_frame!).toBeGreaterThan(VISIT_RATE.target);
    });
  }

  it('still holds a paced run whose visits fall behind the target (not the cap)', () => {
    // 60 fps target, the workers manage 6 visits/s (0.1 per frame): behind, the cap does not bind.
    const gov = new VisitRateGovernor('on');
    const dt = (8 / 60) * 1000;
    let read = 0;
    for (let i = 1; i <= 2000; i++) {
      read += 8;
      gov.update({
        now: i * dt,
        framesRead: read,
        observed: read,
        visits: Math.floor((i * dt * 6) / 1000),
        cappedFrames: 0,
        dueTiles: 20,
        userFps: 60,
      });
    }
    expect(gov.fps).not.toBeNull();
    expect(gov.fps!).toBeLessThan(60);
  });
});

describe('maxRepeatText', () => {
  it('notes run-to-run differences only at Max (user fps 0)', () => {
    expect(maxRepeatText(0)).toBe(
      'Results can differ slightly between runs at Max; set a target fps for repeatable runs.',
    );
    expect(maxRepeatText(30)).toBeNull();
  });
});
