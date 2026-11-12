import { describe, it, expect } from 'vitest';
import {
  chooseTimeStep,
  timeTicks,
  formatElapsed,
  formatClock,
} from '../chart/time-axis-format.ts';
import { createTimeWindow, windowPresets } from '../chart/time-window.ts';

describe('chooseTimeStep', () => {
  it('picks the smallest step keeping ticks >= 55 px apart', () => {
    expect(chooseTimeStep(300, 500)).toBe(60);
    expect(chooseTimeStep(8 * 3600, 500)).toBe(3600);
    expect(chooseTimeStep(5 * 86400, 500)).toBe(86400);
  });
  it('extends to multiples of days for very long runs', () => {
    expect(chooseTimeStep(60 * 86400, 500)).toBeGreaterThan(2 * 86400);
    expect(chooseTimeStep(60 * 86400, 500) % 86400).toBe(0);
  });
  it('honours minPx', () => {
    expect(chooseTimeStep(300, 500, 200)).toBeGreaterThan(chooseTimeStep(300, 500, 55));
  });
});

describe('timeTicks', () => {
  it('5 min: m:ss', () => {
    const t = timeTicks(0, 300, 500);
    expect(t.map((x) => x.t)).toEqual([0, 60, 120, 180, 240, 300]);
    expect(t.map((x) => x.label)).toEqual(['0:00', '1:00', '2:00', '3:00', '4:00', '5:00']);
  });
  it('under 2 h switches to h:mm:ss once t >= 1 h', () => {
    const t = timeTicks(3300, 4000, 500);
    expect(t[0].label).toMatch(/^\d+:\d\d$/);
    expect(t[t.length - 1].label).toMatch(/^1:\d\d:\d\d$/);
  });
  it('8 h run: h:mm hourly', () => {
    const t = timeTicks(0, 8 * 3600, 500);
    expect(t[1].t - t[0].t).toBe(3600);
    expect(t[1].label).toBe('1:00');
    expect(t[0].label).toBe('0:00');
  });
  it('multi-day run viewed over hours: dD first tick then hh:mm', () => {
    const base = 2 * 86400 + 3600;
    const t = timeTicks(base, base + 8 * 3600, 500);
    expect(t[0].label).toBe('d2 01:00');
    expect(t[1].label).toBe('02:00');
    const m = timeTicks(2 * 86400, 2 * 86400 + 8 * 3600, 500);
    expect(m[0].label).toBe('d2');
  });
  it('5 d: day labels d0..d5 at 1 d steps', () => {
    const t = timeTicks(0, 5 * 86400, 500);
    expect(t.map((x) => x.label)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5']);
  });
  it('is empty for a degenerate window', () => {
    expect(timeTicks(5, 5, 500)).toEqual([]);
  });
});

describe('formatElapsed / formatClock', () => {
  it('formats m:ss, h:mm:ss, dD hh:mm:ss', () => {
    expect(formatElapsed(65)).toBe('1:05');
    expect(formatElapsed(3725)).toBe('1:02:05');
    expect(formatElapsed(2 * 86400 + 3 * 3600 + 10 * 60 + 5)).toBe('d2 03:10:05');
    expect(formatElapsed(90, 5 * 86400)).toBe('d0 00:01:30');
    expect(formatElapsed(NaN)).toBe('–');
  });
  it('formats a wall clock as weekday hh:mm:ss', () => {
    expect(formatClock(new Date(2026, 10, 10, 14, 20, 5).getTime())).toBe('Tue 14:20:05');
  });
});

describe('time window store', () => {
  it('resolves run, last and brush', () => {
    const w = createTimeWindow();
    expect(w.resolve(100, 300)).toEqual({ t0: 0, t1: 300 });
    w.setLast(60);
    expect(w.state.mode).toBe('last');
    expect(w.resolve(100, 300)).toEqual({ t0: 40, t1: 100 });
    expect(w.resolve(30, 300)).toEqual({ t0: 0, t1: 30 });
    w.setBrush(50, 20);
    expect(w.state.mode).toBe('brush');
    expect(w.resolve(100, 300)).toEqual({ t0: 20, t1: 50 });
    w.setRun();
    expect(w.state.mode).toBe('run');
    expect(w.resolve(100, 300)).toEqual({ t0: 0, t1: 300 });
  });
  it('tracks the inspected time', () => {
    const w = createTimeWindow();
    expect(w.inspected()).toBeNull();
    w.setInspected(12);
    expect(w.inspected()).toBe(12);
    w.clearInspected();
    expect(w.inspected()).toBeNull();
  });
  it('offers only presets shorter than the run', () => {
    expect(windowPresets(300).map((p) => p.label)).toEqual(['1 min']);
    expect(windowPresets(5 * 86400).map((p) => p.label)).toEqual([
      '24 h',
      '1 h',
      '10 min',
      '1 min',
    ]);
    expect(windowPresets(3600).map((p) => p.label)).toEqual(['10 min', '1 min']);
    expect(windowPresets(30)).toEqual([]);
  });
});
