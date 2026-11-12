import { describe, it, expect } from 'vitest';
import { RunEvents } from '../lib/run-events.ts';
import type { RunEvent } from '../lib/run-events.ts';

const ev = (t: number, kind: RunEvent['kind'], extra: Partial<RunEvent> = {}): RunEvent => ({
  frame: Math.round(t * 30),
  t,
  kind,
  ...extra,
});

describe('RunEvents', () => {
  it('keeps events in t order, inserting late ones in place', () => {
    const r = new RunEvents();
    r.push(ev(1, 'scale'));
    r.push(ev(3, 'pause'));
    r.push(ev(2, 'resume'));
    r.push(ev(3, 'warning'));
    expect(r.list().map((e) => e.kind)).toEqual(['scale', 'resume', 'pause', 'warning']);
  });

  it('between() is half-open [t0, t1) and ofKind() filters', () => {
    const r = new RunEvents();
    for (let i = 0; i < 10; i++) r.push(ev(i, i % 2 ? 'range' : 'setting'));
    expect(r.between(2, 5).map((e) => e.t)).toEqual([2, 3, 4]);
    expect(r.between(20, 30)).toEqual([]);
    expect(r.ofKind('range')).toHaveLength(5);
  });

  it('bumps version on push and clear', () => {
    const r = new RunEvents();
    const v0 = r.version();
    r.push(ev(0, 'pass'));
    expect(r.version()).toBeGreaterThan(v0);
    const v1 = r.version();
    r.clear();
    expect(r.version()).toBeGreaterThan(v1);
    expect(r.list()).toHaveLength(0);
  });

  it('folds old display-only flat-field events into hourly summaries, keeps the rest', () => {
    const r = new RunEvents({ maxEvents: 50, foldOlderThanS: 3600 });
    // newest event first, so the fold at the bound sees everything else as old
    r.push(ev(20000, 'setting'));
    r.push(ev(5, 'pass', { replay: true }));
    r.push(ev(10, 'scale', { key: 'd', from: 6, to: 8, replay: true }));
    r.push(ev(20, 'flatfield', { replay: true, to: 99 }));
    r.push(ev(30, 'warning', { detail: 'w' }));
    // 40 flat-field maps in hour 0 (every 60 s), changes 1..40
    for (let i = 0; i < 40; i++) r.push(ev(100 + i * 60, 'flatfield', { to: i + 1 }));
    // 20 in hour 1
    for (let i = 0; i < 20; i++) r.push(ev(3700 + i * 60, 'flatfield', { to: 2 }));
    const l = r.list();
    expect(l.length).toBeLessThanOrEqual(50);
    // Folding is lazy (runs when the bound is exceeded): summaries are hourly, nothing is lost.
    const maps = l.filter((e) => e.kind === 'flatfield' && !e.replay);
    const sums = maps.filter((e) => e.count !== undefined);
    expect(sums.length).toBeGreaterThan(0);
    for (const s of sums) {
      expect(s.t % 3600).toBe(0);
      expect(s.detail).toBe(`${s.count} maps`);
    }
    expect(maps.reduce((n, e) => n + (e.count ?? 1), 0)).toBe(60);
    expect(Math.max(...sums.map((e) => e.to as number))).toBeGreaterThan(2);
    // replay and non-flat-field events survive untouched
    expect(l.filter((e) => e.replay).map((e) => e.kind)).toEqual(['pass', 'scale', 'flatfield']);
    expect(l.find((e) => e.kind === 'warning')).toBeDefined();
    expect(l.find((e) => e.t === 20000)).toBeDefined();
    for (let i = 1; i < l.length; i++) expect(l[i].t).toBeGreaterThanOrEqual(l[i - 1].t);
  });

  it('never folds recent flat-field events', () => {
    const r = new RunEvents({ maxEvents: 5, foldOlderThanS: 86400 });
    for (let i = 0; i < 8; i++) r.push(ev(i * 60, 'flatfield', { to: 1 }));
    expect(r.list()).toHaveLength(8);
  });

  it('drops the oldest non-replay range/warning events when folding is not enough', () => {
    const r = new RunEvents({ maxEvents: 6, foldOlderThanS: 10 });
    r.push(ev(0, 'range'));
    r.push(ev(1, 'warning'));
    r.push(ev(2, 'range', { replay: true }));
    r.push(ev(3, 'scale', { replay: true }));
    r.push(ev(4, 'error'));
    r.push(ev(5, 'pause'));
    r.push(ev(6, 'resume'));
    r.push(ev(7, 'range'));
    const l = r.list();
    expect(l.length).toBeLessThanOrEqual(6);
    expect(l.some((e) => e.kind === 'scale')).toBe(true);
    expect(l.some((e) => e.kind === 'error')).toBe(true);
    expect(l.some((e) => e.replay && e.kind === 'range')).toBe(true);
    expect(l.find((e) => e.t === 0)).toBeUndefined();
  });

  it('bounds a large run and estimates bytes', () => {
    const r = new RunEvents({ maxEvents: 1000, foldOlderThanS: 3600 });
    for (let i = 0; i < 5000; i++) r.push(ev(i * 60, 'flatfield', { to: i % 7 }));
    expect(r.list().length).toBeLessThanOrEqual(1000);
    expect(r.bytes()).toBeGreaterThanOrEqual(64 * r.list().length);
  });

  it('toJSON round-trips', () => {
    const r = new RunEvents();
    r.push(
      ev(1, 'scale', { key: 'd', from: 6, to: '8', replay: true, data: { seq: 3, ok: true } }),
    );
    r.push(ev(2, 'gap', { detail: '412 frames missed' }));
    expect(JSON.parse(r.toJSON())).toEqual(r.list());
  });
});
