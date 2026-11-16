import { describe, expect, it } from 'vitest';
import {
  appFunnel,
  browserTimeline,
  cohortRetention,
  computeOverview,
  countryTable,
  eventMatrix,
  indexEvents,
  newVsReturning,
  overviewDeltas,
  referrerTable,
  sessionDuration,
  sessionsOverTime,
  tutorialRates,
} from '../lib/metrics.ts';
import { T0, day, event, session } from './helpers.ts';

describe('sessionDuration', () => {
  it('prefers the heartbeat, falls back to duration_seconds, drops outliers and junk', () => {
    expect(sessionDuration(session({ ended_at: new Date(T0 + 90_000).toISOString() }))).toBe(90);
    expect(sessionDuration(session({ duration_seconds: 45 }))).toBe(45);
    expect(
      sessionDuration(session({ ended_at: new Date(T0 + 20 * 3600_000).toISOString() })),
    ).toBeNull();
    expect(sessionDuration(session({ ended_at: 'junk', duration_seconds: NaN }))).toBeNull();
    expect(sessionDuration(session({ ended_at: new Date(T0).toISOString() }))).toBeNull();
  });
});

describe('computeOverview', () => {
  it('counts browsers by user_id, not per-tab anonymous_id', () => {
    const a1 = session({ user_id: 'A', anonymous_id: 't1' });
    const a2 = session({
      user_id: 'A',
      anonymous_id: 't2',
      created_at: new Date(day(1)).toISOString(),
    });
    const b = session({ user_id: 'B', is_anonymous: false });
    const o = computeOverview([a1, a2, b]);
    expect(o.sessions).toBe(3);
    expect(o.browsers).toBe(2);
    expect(o.signedIn).toBe(1);
    expect(o.returning).toBe(1); // A on two UTC days
    expect(o.returningRate).toBe(0.5);
  });

  it('same-day repeat visits are not returning', () => {
    const o = computeOverview([session({ user_id: 'A' }), session({ user_id: 'A' })]);
    expect(o.returning).toBe(0);
  });

  it('handles empty input and sessions without user_id', () => {
    const e = computeOverview([]);
    expect(e).toMatchObject({
      sessions: 0,
      browsers: 0,
      returningRate: null,
      medianDuration: null,
    });
    const o = computeOverview([session({ user_id: null })]);
    expect(o).toMatchObject({ sessions: 1, browsers: 0, noUserId: 1 });
  });

  it('uses the median duration so one forgotten tab does not skew it', () => {
    const mk = (s: number) => session({ ended_at: new Date(T0 + s * 1000).toISOString() });
    expect(computeOverview([mk(60), mk(60), mk(14_000)]).medianDuration).toBe(60);
  });

  it('computes deltas only with a previous period', () => {
    const cur = computeOverview([session(), session()]);
    const prev = computeOverview([session()]);
    expect(overviewDeltas(cur, prev).sessions).toEqual({ abs: 1, pct: 1 });
    expect(overviewDeltas(cur, null).sessions).toBeNull();
  });
});

describe('sessionsOverTime', () => {
  it('zero-fills gaps and splits by app', () => {
    const a = session({ app_name: 'catune', created_at: new Date(day(0)).toISOString() });
    const b = session({ app_name: 'cala', created_at: new Date(day(2)).toISOString() });
    const ts = sessionsOverTime([a, b], 'day', day(0, 0), day(3, 0));
    expect(ts.buckets).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(ts.series.find((s) => s.key === 'catune')!.values).toEqual([1, 0, 0]);
    expect(ts.series.find((s) => s.key === 'cala')!.values).toEqual([0, 0, 1]);
  });

  it('does not run away on all-time ranges (starts at the first session)', () => {
    const ts = sessionsOverTime([session()], 'day', 0, day(1, 0));
    expect(ts.buckets.length).toBeLessThan(5);
  });
});

describe('new vs returning and cohorts', () => {
  const s = (u: string, d: number) =>
    session({ user_id: u, created_at: new Date(day(d)).toISOString() });

  it('classifies a browser as new only in its first bucket', () => {
    const all = [s('A', 0), s('A', 1), s('B', 1)];
    const r = newVsReturning(all, all, 'day', day(0, 0), day(2, 0));
    expect(r).toEqual([
      { bucket: '2026-11-01', new: 1, returning: 0 },
      { bucket: '2026-11-02', new: 1, returning: 1 },
    ]);
  });

  it('treats a browser first seen before the plotted window as returning', () => {
    const all = [s('A', -5), s('A', 0)];
    const r = newVsReturning(all, [all[1]], 'day', day(0, 0), day(1, 0));
    expect(r[0]).toMatchObject({ new: 0, returning: 1 });
  });

  it('computes retention by first-seen week with null for future weeks', () => {
    const now = day(8); // second week after cohort week of Oct 26
    const all = [s('A', 0), s('A', 8), s('B', 0)];
    const rows = cohortRetention(all, now, 3);
    expect(rows).toHaveLength(1); // A and B both first seen in the week of 10-26
    const c = rows[0];
    expect(c.size).toBe(2);
    expect(c.retention[0]).toBe(1);
    expect(c.retention[1]).toBe(0);
    expect(c.retention[2]).toBe(0.5); // A returns in the week of 11-09
    expect(c.retention[3]).toBeNull();
  });

  it('is empty for no sessions', () => {
    expect(cohortRetention([], T0)).toEqual([]);
  });
});

describe('funnels and events', () => {
  it('app funnel counts a session once per step and never widens', () => {
    const a = session({ app_name: 'catune' });
    const b = session({ app_name: 'catune' });
    const c = session({ app_name: 'catune' });
    const evs = [
      event(a.id, 'demo_loaded'),
      event(a.id, 'snapshot_pinned'),
      event(a.id, 'snapshot_pinned'),
      event(a.id, 'submission_created'),
      event(b.id, 'file_imported'),
      event(c.id, 'submission_created'), // submitted without loading: not counted
    ];
    const steps = appFunnel('catune', [a, b, c], indexEvents([a, b, c], evs));
    expect(steps.map((x) => x.count)).toEqual([3, 2, 1, 1]);
    expect(appFunnel('unknown-app', [a], new Map())).toEqual([]);
  });

  it('event matrix drops orphan events and splits by app', () => {
    const a = session({ app_name: 'cala' });
    const m = eventMatrix([a], [event(a.id, 'x'), event(a.id, 'x'), event('gone', 'x')]);
    expect(m.rows).toEqual([{ event: 'x', total: 2, byApp: [2] }]);
  });

  it('tutorial rates tolerate missing ids and no completions', () => {
    const r = tutorialRates([
      event('s', 'tutorial_started', { tutorial_id: 'intro' }),
      event('s', 'tutorial_started'),
    ]);
    expect(r.hasCompleted).toBe(false);
    expect(r.rows.map((x) => x.tutorial).sort()).toEqual(['intro', 'unknown']);
  });
});

describe('referrers, geography, timeline', () => {
  it('attributes first touch to the earliest session of each browser', () => {
    const first = session({
      user_id: 'A',
      referrer_domain: 'google.com',
      created_at: new Date(day(0)).toISOString(),
    });
    const later = session({
      user_id: 'A',
      referrer_domain: null,
      created_at: new Date(day(3)).toISOString(),
    });
    const rows = referrerTable([first, later], [first, later]);
    expect(rows.find((r) => r.referrer === 'google.com')).toMatchObject({
      sessions: 1,
      firstTouch: 1,
    });
    expect(rows.find((r) => r.referrer === 'Direct')).toMatchObject({ sessions: 1, firstTouch: 0 });
  });

  it('counts first-seen-in-country from all sessions but only in-scope browsers', () => {
    const a0 = session({
      user_id: 'A',
      country_code: 'DE',
      created_at: new Date(day(-10)).toISOString(),
    });
    const a1 = session({
      user_id: 'A',
      country_code: 'US',
      created_at: new Date(day(0)).toISOString(),
    });
    const rows = countryTable([a1], [a0, a1]);
    expect(rows.find((r) => r.country === 'US')).toMatchObject({ sessions: 1, firstSeen: 0 });
    expect(rows.find((r) => r.country === 'DE')).toMatchObject({ sessions: 0, firstSeen: 1 });
  });

  it('builds a chronological per-browser timeline and ignores other browsers', () => {
    const mine = session({ user_id: 'A' });
    const other = session({ user_id: 'B' });
    const items = browserTimeline(
      'A',
      [mine, other],
      [
        event(other.id, 'x', {}, T0 + 5),
        event(mine.id, 'run_started', { stage: 'discover' }, T0 + 10),
      ],
    );
    expect(items.map((i) => i.kind)).toEqual(['session', 'event']);
    expect(items[1].detail).toBe('stage=discover');
  });
});
