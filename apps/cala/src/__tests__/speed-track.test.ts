import { describe, expect, it } from 'vitest';
import {
  belowFloorNote,
  fpsToPos,
  fpsToStep,
  floorWords,
  parseSpeedSettings,
  posToFps,
  roundFps,
  snapFps,
  SPEED_DEFAULTS,
  speedStatusText,
  stepToFps,
  TRACK_STEPS,
} from '../lib/speed-track.ts';
import type { GovernorStatus } from '../lib/settle.ts';

const gov = (o: Partial<GovernorStatus> = {}): GovernorStatus => ({
  rate: 122,
  limit: 'look-back',
  target: 80,
  paused: false,
  achieved: 80.1,
  capFps: 160,
  cap: 2,
  deliveredFps: 122,
  busy: 0.9,
  credit: 0,
  halvings: 0,
  slowHalvings: 0,
  ...o,
});

describe('track mapping', () => {
  it('maps the ends and is logarithmic', () => {
    expect(fpsToPos(10)).toBe(0);
    expect(fpsToPos(500)).toBe(1);
    // The geometric middle of 10 and 500 is the middle of the track.
    expect(fpsToPos(Math.sqrt(10 * 500))).toBeCloseTo(0.5, 12);
  });

  it('clamps to the fixed scale', () => {
    expect(fpsToPos(1)).toBe(0);
    expect(fpsToPos(5000)).toBe(1);
    expect(posToFps(-1)).toBeCloseTo(10, 9);
    expect(posToFps(2)).toBeCloseTo(500, 9);
    expect(posToFps(Number.NaN)).toBeCloseTo(10, 9);
  });

  it('round-trips', () => {
    for (const f of [10, 20, 33, 60, 120, 240, 500])
      expect(posToFps(fpsToPos(f))).toBeCloseTo(f, 9);
    expect(fpsToStep(10)).toBe(0);
    expect(fpsToStep(500)).toBe(TRACK_STEPS);
  });
});

describe('snapping', () => {
  it('rounds to readable numbers', () => {
    expect(roundFps(47.4)).toBe(47);
    expect(roundFps(132)).toBe(130);
    expect(roundFps(333)).toBe(330);
    expect(roundFps(2)).toBe(10);
    expect(roundFps(900)).toBe(500);
  });

  it('pulls onto a mark within a hair of it, not beyond', () => {
    expect(snapFps(61)).toBe(60);
    expect(snapFps(29.5)).toBe(30);
    expect(snapFps(70)).toBe(70);
    expect(snapFps(41, [20, 30, 60, 41])).toBe(41);
  });

  it('takes the floor as a mark too', () => {
    expect(snapFps(37.5, [20, 30, 60, 38])).toBe(38);
  });

  it('steps convert to snapped speeds', () => {
    expect(stepToFps(0)).toBe(10);
    expect(stepToFps(TRACK_STEPS)).toBe(500);
    expect(stepToFps(fpsToStep(60))).toBe(60);
  });
});

describe('persisted settings', () => {
  it('falls back to the defaults on nothing or junk', () => {
    expect(parseSpeedSettings(null)).toEqual(SPEED_DEFAULTS);
    expect(parseSpeedSettings('not json')).toEqual(SPEED_DEFAULTS);
    expect(parseSpeedSettings('7')).toEqual(SPEED_DEFAULTS);
  });

  it('keeps valid fields and replaces invalid ones one by one', () => {
    expect(parseSpeedSettings(JSON.stringify({ mode: 'fixed', fixedFps: 80, cap: 0.5 }))).toEqual({
      mode: 'fixed',
      fixedFps: 80,
      cap: 0.5,
    });
    expect(parseSpeedSettings(JSON.stringify({ mode: 'curve', fixedFps: 9999, cap: 3 }))).toEqual(
      SPEED_DEFAULTS,
    );
    expect(parseSpeedSettings(JSON.stringify({ mode: 'fixed', cap: 3 }))).toEqual({
      ...SPEED_DEFAULTS,
      mode: 'fixed',
    });
  });

  it('defaults to Max', () => {
    expect(SPEED_DEFAULTS.mode).toBe('max');
  });
});

describe('status text', () => {
  const base = { running: true, target: 80, floor: 60, governor: gov(), settleOn: true };

  it('says on target with the settle rate and limit', () => {
    const t = speedStatusText(base);
    expect(t).toContain('On target.');
    expect(t).toContain('122 re-read frames/s = 1.52 per live frame (cap 2)');
    expect(t).toContain('limited by: look-back');
  });

  it('names Discover when the target is missed', () => {
    const t = speedStatusText({ ...base, governor: gov({ achieved: 51 }) });
    expect(t).toContain('Achieved 51');
    expect(t).toContain('Discover is the limit');
    expect(t).not.toContain('On target');
  });

  it('says Background settle is off when the cap is off', () => {
    expect(speedStatusText({ ...base, settleOn: false })).toContain('Background settle is off');
  });

  it('has a line for Max and for a run that has not started', () => {
    expect(speedStatusText({ ...base, target: 0 })).toContain('Max');
    expect(speedStatusText({ ...base, running: false })).toContain('once it starts');
  });

  it('never calls below-Max settings experimental or warns about weak cells', () => {
    const all = [
      speedStatusText(base),
      speedStatusText({ ...base, running: false }),
      belowFloorNote(20, 60) ?? '',
    ].join(' ');
    expect(all).not.toMatch(/experimental|weak|warning/i);
  });
});

describe('below the floor', () => {
  it('notes only a target under the floor', () => {
    expect(belowFloorNote(40, 60)).toContain('No gain below 60');
    expect(belowFloorNote(60, 60)).toBeNull();
    expect(belowFloorNote(0, 60)).toBeNull();
    expect(belowFloorNote(40, null)).toBeNull();
  });
});

describe('floor words', () => {
  const est = (o: object) =>
    ({ limiting: 'look-back', confidence: 'paced', ...o }) as Parameters<
      typeof floorWords
    >[0]['estimate'];
  it('says about, and not measured, for the prior', () => {
    const w = floorWords({ fps: 20, published: null, prior: true, estimate: est({}) });
    expect(w.mark).toBe('about 20');
    expect(w.line).toContain('not measured yet');
  });
  it('names the limiting kind when measured', () => {
    const w = floorWords({ fps: 60, published: 60, prior: false, estimate: est({}) });
    expect(w.mark).toBe('floor 60');
    expect(w.line).toBe('Floor 60 fps: set by look-back (measured)');
  });
  it('is only "about" when measured at Max', () => {
    const w = floorWords({
      fps: 30,
      published: 30,
      prior: false,
      estimate: est({ confidence: 'unpaced', limiting: 'slow-worker' }),
    });
    expect(w.mark).toBe('about 30');
    expect(w.line).toContain('slow worker');
    expect(w.line).toContain('measured at Max');
  });
});
