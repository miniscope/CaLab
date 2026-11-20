import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  DAY_MS,
  applySessionFilters,
  isDevSession,
  parseHash,
  resolveWindow,
  splitPeriods,
  toHash,
  utcDay,
  weekStart,
} from '../lib/filters.ts';
import { T0, session } from './helpers.ts';

describe('resolveWindow', () => {
  it('7d covers today and the 6 days before, with an equal previous period', () => {
    const w = resolveWindow({ ...DEFAULT_FILTERS, preset: '7d' }, T0);
    expect(utcDay(w.curEnd - DAY_MS)).toBe('2026-11-01');
    expect(utcDay(w.curStart)).toBe('2026-10-26');
    expect(w.curEnd - w.curStart).toBe(7 * DAY_MS);
    expect(w.prevEnd).toBe(w.curStart);
    expect(w.prevStart).toBe(w.curStart - 7 * DAY_MS);
    expect(w.fetchStart).toBe(w.prevStart);
  });

  it('all time has no previous period', () => {
    const w = resolveWindow({ ...DEFAULT_FILTERS, preset: 'all' }, T0);
    expect(w.prevStart).toBeNull();
    expect(w.curStart).toBe(0);
  });

  it('custom range is inclusive of the end day, and swaps reversed dates', () => {
    const f = {
      ...DEFAULT_FILTERS,
      preset: 'custom' as const,
      start: '2026-10-10',
      end: '2026-10-12',
    };
    const w = resolveWindow(f, T0);
    expect(w.curEnd - w.curStart).toBe(3 * DAY_MS);
    const r = resolveWindow({ ...f, start: '2026-10-12', end: '2026-10-10' }, T0);
    expect(r.curStart).toBe(w.curStart);
  });

  it('falls back to 30 days for an invalid custom range', () => {
    const w = resolveWindow({ ...DEFAULT_FILTERS, preset: 'custom', start: 'nope', end: '' }, T0);
    expect(w.curEnd - w.curStart).toBe(30 * DAY_MS);
  });

  it('includes a session at 23:59:59.999 of the last day (old endOfDay bug)', () => {
    const f = {
      ...DEFAULT_FILTERS,
      preset: 'custom' as const,
      start: '2026-10-10',
      end: '2026-10-12',
    };
    const w = resolveWindow(f, T0);
    const s = session({ created_at: '2026-10-12T23:59:59.999Z' });
    expect(splitPeriods([s], w).cur).toHaveLength(1);
  });
});

describe('weekStart', () => {
  it('is the UTC Monday, including for Sundays and just after midnight', () => {
    expect(weekStart(Date.parse('2026-11-01T12:00:00Z'))).toBe('2026-10-26'); // Sunday
    expect(weekStart(Date.parse('2026-11-02T00:00:01Z'))).toBe('2026-11-02'); // Monday
    expect(weekStart(Date.parse('2026-10-31T23:59:59Z'))).toBe('2026-10-26');
  });
});

describe('dev noise and filters', () => {
  it('detects dev versions and localhost referrers', () => {
    expect(isDevSession({ app_version: 'dev', referrer_domain: null })).toBe(true);
    expect(isDevSession({ app_version: '2.0.0', referrer_domain: 'localhost' })).toBe(true);
    expect(isDevSession({ app_version: '2.0.0', referrer_domain: 'printer.local' })).toBe(true);
    expect(isDevSession({ app_version: null, referrer_domain: 'localhost.example.com' })).toBe(
      false,
    );
    expect(isDevSession({ app_version: null, referrer_domain: null })).toBe(false);
  });

  it('applies app, version and dev filters', () => {
    const a = session({ app_name: 'catune', app_version: '1.0.0' });
    const b = session({ app_name: 'cala', app_version: '2.0.0' });
    const c = session({ app_name: 'cala', app_version: 'dev' });
    const all = [a, b, c];
    expect(applySessionFilters(all, DEFAULT_FILTERS)).toEqual([a, b]);
    expect(applySessionFilters(all, { ...DEFAULT_FILTERS, includeDev: true })).toHaveLength(3);
    expect(applySessionFilters(all, { ...DEFAULT_FILTERS, app: 'cala' })).toEqual([b]);
    expect(applySessionFilters(all, { ...DEFAULT_FILTERS, version: '1.0.0' })).toEqual([a]);
  });

  it('ignores rows with an unparseable timestamp when splitting periods', () => {
    const w = resolveWindow(DEFAULT_FILTERS, T0);
    const bad = session({ created_at: 'garbage' });
    expect(splitPeriods([bad], w)).toEqual({ cur: [], prev: [] });
  });
});

describe('URL state', () => {
  it('round-trips view and filters', () => {
    const f = {
      app: 'cala',
      preset: '90d' as const,
      start: '',
      end: '',
      version: '2.18.0',
      includeDev: true,
    };
    const h = toHash('cala', f);
    expect(h).toBe('#/cala?app=cala&range=90d&ver=2.18.0&dev=1');
    expect(parseHash(h)).toEqual({ view: 'cala', filters: f });
  });

  it('round-trips a custom range and omits defaults', () => {
    const f = {
      ...DEFAULT_FILTERS,
      preset: 'custom' as const,
      start: '2026-01-01',
      end: '2026-02-01',
    };
    expect(parseHash(toHash('users', f)).filters).toEqual(f);
    expect(toHash('overview', DEFAULT_FILTERS)).toBe('#/overview');
  });

  it('survives garbage: unknown view, bad app, bad range', () => {
    const s = parseHash('#/nope?app=<script>&range=2026-13-40..x&dev=maybe');
    expect(s.view).toBe('overview');
    expect(s.filters).toEqual(DEFAULT_FILTERS);
    expect(parseHash('').view).toBe('overview');
  });
});
