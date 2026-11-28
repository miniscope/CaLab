import { describe, expect, it } from 'vitest';
import { GOVERNOR } from '../lib/settle-governor.ts';
import {
  climbSeconds,
  CURVE_PRESETS,
  curveWords,
  limitPoints,
  MAX_CURVE_POINTS,
  MIN_STEP,
  minStepSeconds,
  normalizeCurve,
  planLine,
  presetCurve,
  resolveFps,
  sanitizeCurve,
  SpeedDriver,
  SpeedSchedule,
  steps,
  type PolicyInput,
  type SpeedCurve,
  type TargetPolicy,
} from '../lib/speed-schedule.ts';
import { CURVE_PRESET_IDS } from '../lib/speed-track.ts';

const live = { floorFps: 60, seeAllFps: 135 };
const plan = (o: Partial<Parameters<typeof normalizeCurve>[1]> = {}) => ({
  totalFrames: 12000,
  cap: 2,
  floorFps: 60,
  seeAllFps: 135,
  maxFps: 220,
  ...o,
});
const input = (frame: number, wallS = 0, o: Partial<PolicyInput> = {}): PolicyInput => ({
  frame,
  totalFrames: 1000,
  floorFps: 60,
  seeAllFps: 135,
  maxFps: 220,
  wallS,
  ...o,
});

describe('resolving a target', () => {
  it('maps Max to 0, numbers onto the track, symbols onto the ladder', () => {
    expect(resolveFps('max', live)).toBe(0);
    expect(resolveFps(45, live)).toBe(45);
    expect(resolveFps(5, live)).toBe(10);
    expect(resolveFps(900, live)).toBe(500);
    expect(resolveFps('floor', { floorFps: 67, seeAllFps: 1 })).toBe(60);
    expect(resolveFps('seeAll', live)).toBe(120);
    expect(resolveFps(NaN, live)).toBe(0);
  });
});

describe('sanitizing a curve', () => {
  it('sorts, clamps, drops junk, makes the first point 0 and lets the later of two at one place win', () => {
    expect(
      sanitizeCurve({
        points: [
          { at: 0.6, fps: 'floor' },
          { at: 0.2, fps: 80 },
          { at: 0.2, fps: 90 },
          { at: 2, fps: 'max' },
          { at: 0.4, fps: -3 },
          { at: NaN, fps: 30 },
          null,
        ],
      }),
    ).toEqual({
      points: [
        { at: 0, fps: 90 },
        { at: 0.6, fps: 'floor' },
        { at: 1, fps: 'max' },
      ],
    });
    expect(sanitizeCurve({ points: [] })).toBeNull();
    expect(sanitizeCurve(null)).toBeNull();
    expect(sanitizeCurve({ points: [{ at: 0, fps: 'warp' }] })).toBeNull();
  });

  it('cuts an authored curve at eight points', () => {
    const many = {
      points: Array.from({ length: 12 }, (_, i) => ({ at: i / 12, fps: 30 + i })),
    };
    expect(limitPoints(many).points).toHaveLength(MAX_CURVE_POINTS);
  });
});

describe('the minimum step', () => {
  it('is 20 s plus twice the settle climb, from the governor ramp', () => {
    expect(MIN_STEP.baseS).toBe(20);
    // Cap 2 is reached after 2 x 450 live frames: 15 s at 60 fps, 6.67 s at 135 fps.
    expect(climbSeconds(60, 2)).toBeCloseTo((2 * GOVERNOR.rampFrames) / 60);
    expect(minStepSeconds(60, 2)).toBeCloseTo(20 + 2 * 15);
    expect(minStepSeconds(135, 2)).toBeCloseTo(20 + (2 * 900) / 135);
    // The cap Off means nothing to climb to.
    expect(minStepSeconds(60, 0)).toBe(20);
  });
});

describe('merging short steps', () => {
  const c = (...p: [number, SpeedCurve['points'][number]['fps']][]): SpeedCurve => ({
    points: p.map(([at, fps]) => ({ at, fps })),
  });

  it('leaves a curve of long steps alone', () => {
    const r = normalizeCurve(c([0, 'max'], [0.5, 60]), plan());
    expect(r.merged).toBe(0);
    expect(r.curve.points).toHaveLength(2);
  });

  it('drops a paced step shorter than its minimum and lets the one before it run on', () => {
    // 60 fps from 90 %: 1200 frames = 20 s, under its 50 s.
    const r = normalizeCurve(c([0, 'max'], [0.5, 50], [0.9, 60]), plan());
    expect(r.merged).toBe(1);
    expect(r.curve.points).toEqual([
      { at: 0, fps: 'max' },
      { at: 0.5, fps: 50 },
    ]);
  });

  it('drops a short first step and starts the next at 0', () => {
    const r = normalizeCurve(c([0, 60], [0.1, 'max']), plan());
    expect(r.curve.points).toEqual([{ at: 0, fps: 'max' }]);
  });

  it('never merges a Max step: there is no pacer to re-anchor and no governor to climb', () => {
    const r = normalizeCurve(c([0, 'max'], [0.02, 100]), plan({ totalFrames: 2000 }));
    // The 100 fps step is 1960 frames = 19.6 s, under its 20 + 2 x 25 s, so it goes; the Max step stays.
    expect(r.curve.points).toEqual([{ at: 0, fps: 'max' }]);
    expect(normalizeCurve(c([0, 'max'], [0.9, 'floor']), plan()).curve.points[0]).toEqual({
      at: 0,
      fps: 'max',
    });
  });

  it('merges a chain and always keeps one step', () => {
    const r = normalizeCurve(
      c([0, 60], [0.25, 80], [0.5, 100], [0.75, 120]),
      plan({ totalFrames: 600 }),
    );
    expect(r.curve.points).toHaveLength(1);
    expect(r.merged).toBe(3);
  });

  it('counts a step paced above Max at Max speed (when Max is known)', () => {
    const slow = plan({ totalFrames: 7000, maxFps: 50 });
    // 120 fps asked, 50 reached: 3500 / 50 = 70 s, over its 56 s (20 + 2 x 900 / 50); at 120 fps
    // it would be 29 s, under its 35 s.
    expect(normalizeCurve(c([0, 60], [0.5, 120]), slow).merged).toBe(0);
    expect(
      normalizeCurve(c([0, 60], [0.5, 120]), plan({ totalFrames: 7000, maxFps: null })).merged,
    ).toBe(1);
  });

  it('judges a symbol by what it resolves to now', () => {
    const r = normalizeCurve(
      c([0, 'max'], [0.5, 'floor']),
      plan({ floorFps: 30, totalFrames: 4800 }),
    );
    // 2400 frames at 30 fps = 80 s: exactly its minimum (20 + 2 x 900 / 30 = 80 s) is met.
    expect(r.merged).toBe(0);
    expect(
      normalizeCurve(c([0, 'max'], [0.5, 'floor']), plan({ floorFps: 30, totalFrames: 600 }))
        .merged,
    ).toBe(1);
  });
});

describe('presets', () => {
  it('has the design two, in points a schedule can follow', () => {
    expect(CURVE_PRESET_IDS).toEqual(['find-fast', 'step-down']);
    expect(CURVE_PRESETS['find-fast'].curve.points).toEqual([
      { at: 0, fps: 'max' },
      { at: 0.5, fps: 'floor' },
    ]);
    expect(CURVE_PRESETS['step-down'].curve.points).toEqual([
      { at: 0, fps: 'max' },
      { at: 0.33, fps: 'seeAll' },
      { at: 0.66, fps: 'floor' },
    ]);
    for (const id of CURVE_PRESET_IDS) {
      expect(sanitizeCurve(presetCurve(id))).toEqual(presetCurve(id));
    }
    // A copy: editing it does not change the preset.
    presetCurve('find-fast').points[0].fps = 5;
    expect(CURVE_PRESETS['find-fast'].curve.points[0].fps).toBe('max');
  });

  it('read in words', () => {
    expect(curveWords(presetCurve('find-fast'), live)).toBe('Max to 50 %, then the floor (60)');
    expect(curveWords(presetCurve('step-down'), live)).toBe(
      'Max to 33 %, every frame seen (120) to 66 %, then the floor (60)',
    );
    expect(curveWords({ points: [{ at: 0, fps: 40 }] }, live)).toBe('40 fps');
  });
});

describe('SpeedSchedule', () => {
  const s = new SpeedSchedule(presetCurve('step-down'));

  it('finds the step a frame is in, at the boundaries', () => {
    expect(s.stepAt(0, 1000)).toBe(0);
    expect(s.stepAt(329, 1000)).toBe(0);
    expect(s.stepAt(330, 1000)).toBe(1);
    expect(s.stepAt(659, 1000)).toBe(1);
    expect(s.stepAt(660, 1000)).toBe(2);
    expect(s.stepAt(1000, 1000)).toBe(2);
    expect(s.stepAt(5, 0)).toBe(0);
  });

  it('gives the resolved target and the step as the phase', () => {
    expect(s.target(input(100))).toEqual({ fps: 0, phase: 'step0' });
    expect(s.target(input(400))).toEqual({ fps: 120, phase: 'step1' });
    expect(s.target(input(900))).toEqual({ fps: 60, phase: 'step2' });
    expect(s.source).toBe('curve');
  });

  it('needs a point', () => {
    expect(() => new SpeedSchedule({ points: [] })).toThrow();
  });

  it('lists the steps with their ends', () => {
    expect(steps(presetCurve('find-fast'), live)).toEqual([
      { from: 0, to: 0.5, fps: 0 },
      { from: 0.5, to: 1, fps: 60 },
    ]);
  });
});

describe('SpeedDriver', () => {
  it('applies the first target, then only changes', () => {
    const d = new SpeedDriver(new SpeedSchedule(presetCurve('find-fast')));
    expect(d.tick(input(0, 0))).toEqual({ fps: 0, source: 'curve' });
    expect(d.tick(input(100, 1))).toBeNull();
    expect(d.tick(input(499, 5))).toBeNull();
    expect(d.tick(input(500, 6))).toEqual({ fps: 60, source: 'curve' });
    expect(d.tick(input(600, 7))).toBeNull();
  });

  it('applies a new step at once, whatever the hold', () => {
    const d = new SpeedDriver(new SpeedSchedule(presetCurve('step-down')), 15);
    d.tick(input(0, 0));
    expect(d.tick(input(330, 0.1))?.fps).toBe(120);
    expect(d.tick(input(660, 0.2))?.fps).toBe(60);
  });

  it('holds a symbol that moves inside a step, and one republish is one change', () => {
    const d = new SpeedDriver(new SpeedSchedule({ points: [{ at: 0, fps: 'floor' }] }), 15);
    expect(d.tick(input(0, 0, { floorFps: 40 }))?.fps).toBe(40);
    // The floor rises to 60: held for 15 s from the last change, then applied once.
    expect(d.tick(input(10, 5, { floorFps: 62 }))).toBeNull();
    expect(d.tick(input(20, 14.9, { floorFps: 62 }))).toBeNull();
    expect(d.tick(input(30, 15, { floorFps: 62 }))).toEqual({ fps: 60, source: 'curve' });
    expect(d.tick(input(40, 16, { floorFps: 62 }))).toBeNull();
    expect(d.tick(input(50, 60, { floorFps: 62 }))).toBeNull();
    // Raw jitter inside one ladder step changes nothing.
    expect(d.tick(input(60, 90, { floorFps: 71 }))).toBeNull();
  });

  it('is not a change when a new step has the same target', () => {
    const d = new SpeedDriver(
      new SpeedSchedule({
        points: [
          { at: 0, fps: 60 },
          { at: 0.5, fps: 60 },
        ],
      }),
    );
    expect(d.tick(input(0))?.fps).toBe(60);
    expect(d.tick(input(600))).toBeNull();
  });

  it('drives any policy: a stand-in for Auto uses the same path and names its own source', () => {
    let state = 'search';
    const auto: TargetPolicy = {
      source: 'auto',
      target: () =>
        state === 'search' ? { fps: 0, phase: 'search' } : { fps: 45, phase: 'settle' },
    };
    const d = new SpeedDriver(auto);
    expect(d.tick(input(0, 0))).toEqual({ fps: 0, source: 'auto' });
    state = 'settle';
    expect(d.tick(input(1, 1))).toEqual({ fps: 45, source: 'auto' });
  });
});

describe('the plan for the strip', () => {
  it('is a step line over the recording with Max as 0', () => {
    expect(planLine(presetCurve('find-fast'), live)).toEqual([
      { x: 0, fps: 0 },
      { x: 0.5, fps: 0 },
      { x: 0.5, fps: 60 },
      { x: 1, fps: 60 },
    ]);
  });
});
