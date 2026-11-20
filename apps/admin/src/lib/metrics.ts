// Aggregations over already-filtered sessions/events. Pure functions only.
//
// Definitions (also in docs/analytics.md, "Admin app"):
//   browser   = distinct user_id (anonymous-auth or real). Per browser profile,
//               not per person; resets when site data is cleared.
//   signed-in = distinct user_id with is_anonymous = false.
//   returning = a browser with sessions on more than one UTC day in the data.
//   session duration = ended_at - created_at (heartbeat), else duration_seconds.

import type { EventRow, SessionRow } from './types.ts';
import { isDevSession, utcDay } from './filters.ts';
import {
  type Bucket,
  type Delta,
  bucketKey,
  bucketRange,
  countBy,
  delta,
  median,
  rank,
  shortHash,
  sortApps,
} from './stats.ts';

/** Sessions longer than this are tabs left open, not use; excluded from duration stats. */
export const MAX_SESSION_SECONDS = 4 * 3600;

export function sessionMs(s: SessionRow): number {
  return Date.parse(s.created_at);
}

export function sessionDuration(s: SessionRow): number | null {
  let d: number | null = null;
  if (s.ended_at) {
    const e = Date.parse(s.ended_at);
    const c = Date.parse(s.created_at);
    if (Number.isFinite(e) && Number.isFinite(c)) d = (e - c) / 1000;
  }
  if ((d === null || !(d > 0)) && typeof s.duration_seconds === 'number') d = s.duration_seconds;
  if (d === null || !Number.isFinite(d) || d <= 0 || d > MAX_SESSION_SECONDS) return null;
  return d;
}

// ---- event payload access (payloads are untrusted JSON) ----

export function evNum(e: EventRow, key: string): number | null {
  const v = e.event_data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function evStr(e: EventRow, key: string): string | null {
  const v = e.event_data?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export type EventIndex = Map<string, EventRow[]>;

/** Events grouped by session id, only for sessions in `sessions`. */
export function indexEvents(sessions: SessionRow[], events: EventRow[]): EventIndex {
  const ids = new Set(sessions.map((s) => s.id));
  const idx: EventIndex = new Map();
  for (const e of events) {
    if (!ids.has(e.session_id)) continue;
    const list = idx.get(e.session_id);
    if (list) list.push(e);
    else idx.set(e.session_id, [e]);
  }
  return idx;
}

export function eventsOf(sessions: SessionRow[], events: EventRow[]): EventRow[] {
  const ids = new Set(sessions.map((s) => s.id));
  return events.filter((e) => ids.has(e.session_id));
}

// ---- overview ----

export interface Overview {
  sessions: number;
  browsers: number;
  /** null when the database cannot tell signed-in from anonymous (no is_anonymous column). */
  signedIn: number | null;
  returning: number;
  /** returning / browsers; null when there are no browsers. */
  returningRate: number | null;
  medianDuration: number | null;
  /** Sessions without a user_id (pre-008 rows); not counted as browsers. */
  noUserId: number;
}

export function computeOverview(sessions: SessionRow[], anonKnown = true): Overview {
  const days = new Map<string, Set<string>>();
  const signed = new Set<string>();
  let noUserId = 0;
  for (const s of sessions) {
    if (!s.user_id) {
      noUserId++;
      continue;
    }
    let set = days.get(s.user_id);
    if (!set) days.set(s.user_id, (set = new Set()));
    const t = sessionMs(s);
    if (Number.isFinite(t)) set.add(utcDay(t));
    if (s.is_anonymous === false) signed.add(s.user_id);
  }
  let returning = 0;
  for (const set of days.values()) if (set.size > 1) returning++;
  return {
    sessions: sessions.length,
    browsers: days.size,
    signedIn: anonKnown ? signed.size : null,
    returning,
    returningRate: days.size > 0 ? returning / days.size : null,
    medianDuration: median(sessions.map(sessionDuration)),
    noUserId,
  };
}

export interface OverviewDeltas {
  sessions: Delta | null;
  browsers: Delta | null;
  signedIn: Delta | null;
  returningRate: Delta | null;
  medianDuration: Delta | null;
}

export function overviewDeltas(cur: Overview, prev: Overview | null): OverviewDeltas {
  if (!prev) {
    return {
      sessions: null,
      browsers: null,
      signedIn: null,
      returningRate: null,
      medianDuration: null,
    };
  }
  return {
    sessions: delta(cur.sessions, prev.sessions),
    browsers: delta(cur.browsers, prev.browsers),
    signedIn: delta(cur.signedIn, prev.signedIn),
    returningRate: delta(cur.returningRate, prev.returningRate),
    medianDuration: delta(cur.medianDuration, prev.medianDuration),
  };
}

// ---- time series ----

export interface Series {
  key: string;
  values: number[];
}

export interface TimeSeries {
  buckets: string[];
  series: Series[];
}

/** Sessions per bucket, one series per app (keys sorted), zero-filled. */
export function sessionsOverTime(
  sessions: SessionRow[],
  bucket: Bucket,
  startMs: number,
  endMs: number,
): TimeSeries {
  // "All time" starts at epoch 0; clamp to the first session instead.
  let lo = startMs;
  if (sessions.length > 0) {
    const first = Math.min(...sessions.map(sessionMs).filter(Number.isFinite));
    if (Number.isFinite(first) && first > lo) lo = first;
  }
  const buckets = bucketRange(lo, endMs, bucket);
  const pos = new Map(buckets.map((b, i) => [b, i]));
  const apps = sortApps(new Set(sessions.map((s) => s.app_name || 'unknown')));
  const data = new Map(apps.map((a) => [a, new Array<number>(buckets.length).fill(0)]));
  for (const s of sessions) {
    const t = sessionMs(s);
    if (!Number.isFinite(t)) continue;
    const i = pos.get(bucketKey(t, bucket));
    if (i !== undefined) data.get(s.app_name || 'unknown')![i]++;
  }
  return { buckets, series: apps.map((key) => ({ key, values: data.get(key)! })) };
}

export interface AppCard {
  app: string;
  sessions: number;
  browsers: number;
  medianDuration: number | null;
}

export function perAppCards(sessions: SessionRow[]): AppCard[] {
  const by = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const k = s.app_name || 'unknown';
    const l = by.get(k);
    if (l) l.push(s);
    else by.set(k, [s]);
  }
  return Array.from(by, ([app, list]) => {
    const o = computeOverview(list);
    return { app, sessions: o.sessions, browsers: o.browsers, medianDuration: o.medianDuration };
  }).sort((a, b) => b.sessions - a.sessions || a.app.localeCompare(b.app));
}

// ---- users ----

export interface FirstSeen {
  ms: number;
  sessionId: string;
  country: string | null;
  referrer: string | null;
}

/** Earliest session per browser in the given sessions. */
export function firstSeenByBrowser(sessions: SessionRow[]): Map<string, FirstSeen> {
  const m = new Map<string, FirstSeen>();
  for (const s of sessions) {
    if (!s.user_id) continue;
    const t = sessionMs(s);
    if (!Number.isFinite(t)) continue;
    const cur = m.get(s.user_id);
    if (!cur || t < cur.ms) {
      m.set(s.user_id, {
        ms: t,
        sessionId: s.id,
        country: s.country_code,
        referrer: s.referrer_domain,
      });
    }
  }
  return m;
}

export interface NewVsReturningPoint {
  bucket: string;
  new: number;
  returning: number;
}

/**
 * Active browsers per bucket split into "new" (first seen in that bucket) and
 * "returning" (first seen earlier). `all` is every session (so first-seen is
 * as early as the loaded data allows); `shown` are the ones plotted.
 */
export function newVsReturning(
  all: SessionRow[],
  shown: SessionRow[],
  bucket: Bucket,
  startMs: number,
  endMs: number,
): NewVsReturningPoint[] {
  const first = firstSeenByBrowser(all);
  const buckets = bucketRange(startMs, endMs, bucket);
  const active = new Map<string, Set<string>>(buckets.map((b) => [b, new Set()]));
  for (const s of shown) {
    if (!s.user_id) continue;
    const t = sessionMs(s);
    if (!Number.isFinite(t)) continue;
    active.get(bucketKey(t, bucket))?.add(s.user_id);
  }
  return buckets.map((b) => {
    let n = 0;
    let r = 0;
    for (const u of active.get(b)!) {
      const f = first.get(u);
      if (f && bucketKey(f.ms, bucket) === b) n++;
      else r++;
    }
    return { bucket: b, new: n, returning: r };
  });
}

export interface CohortRow {
  week: string;
  size: number;
  /** Fraction of the cohort active in week +k; null when week +k is in the future. */
  retention: (number | null)[];
}

/** Retention by first-seen week: share of the cohort with a session in week +k. */
export function cohortRetention(sessions: SessionRow[], nowMs: number, maxWeeks = 8): CohortRow[] {
  const first = firstSeenByBrowser(sessions);
  const activeWeeks = new Map<string, Set<string>>();
  for (const s of sessions) {
    if (!s.user_id) continue;
    const t = sessionMs(s);
    if (!Number.isFinite(t)) continue;
    let set = activeWeeks.get(s.user_id);
    if (!set) activeWeeks.set(s.user_id, (set = new Set()));
    set.add(bucketKey(t, 'week'));
  }
  const cohorts = new Map<string, string[]>();
  for (const [u, f] of first) {
    const w = bucketKey(f.ms, 'week');
    const l = cohorts.get(w);
    if (l) l.push(u);
    else cohorts.set(w, [u]);
  }
  const nowWeek = Date.parse(bucketKey(nowMs, 'week'));
  const WEEK = 7 * 86_400_000;
  return Array.from(cohorts, ([week, users]) => {
    const w0 = Date.parse(week);
    const retention: (number | null)[] = [];
    for (let k = 0; k <= maxWeeks; k++) {
      const wk = w0 + k * WEEK;
      if (wk > nowWeek) {
        retention.push(null);
        continue;
      }
      const key = utcDay(wk);
      let n = 0;
      for (const u of users) if (activeWeeks.get(u)?.has(key)) n++;
      retention.push(n / users.length);
    }
    return { week, size: users.length, retention };
  }).sort((a, b) => a.week.localeCompare(b.week));
}

export interface BrowserActivity {
  userId: string;
  hash: string;
  sessions: number;
  events: number;
  days: number;
  apps: string[];
  country: string | null;
  firstMs: number;
  lastMs: number;
  signedIn: boolean;
}

export function browserActivity(sessions: SessionRow[], events: EventRow[]): BrowserActivity[] {
  const evCount = countBy(events, (e) => e.session_id);
  const m = new Map<string, BrowserActivity & { dayset: Set<string>; appset: Set<string> }>();
  for (const s of sessions) {
    if (!s.user_id) continue;
    const t = sessionMs(s);
    if (!Number.isFinite(t)) continue;
    let b = m.get(s.user_id);
    if (!b) {
      b = {
        userId: s.user_id,
        hash: shortHash(s.user_id),
        sessions: 0,
        events: 0,
        days: 0,
        apps: [],
        country: s.country_code,
        firstMs: t,
        lastMs: t,
        signedIn: false,
        dayset: new Set(),
        appset: new Set(),
      };
      m.set(s.user_id, b);
    }
    b.sessions++;
    b.events += evCount.get(s.id) ?? 0;
    b.dayset.add(utcDay(t));
    b.appset.add(s.app_name);
    b.firstMs = Math.min(b.firstMs, t);
    b.lastMs = Math.max(b.lastMs, t);
    if (s.is_anonymous === false) b.signedIn = true;
  }
  return Array.from(m.values())
    .map(({ dayset, appset, ...b }) => ({ ...b, days: dayset.size, apps: [...appset].sort() }))
    .sort((a, b) => b.sessions - a.sessions || b.lastMs - a.lastMs);
}

export interface TimelineItem {
  ms: number;
  kind: 'session' | 'event';
  label: string;
  detail: string;
}

/** Chronological sessions and events of one browser, for the drawer. */
export function browserTimeline(
  userId: string,
  sessions: SessionRow[],
  events: EventRow[],
): TimelineItem[] {
  const mine = sessions.filter((s) => s.user_id === userId);
  const byId = new Map(mine.map((s) => [s.id, s]));
  const items: TimelineItem[] = [];
  for (const s of mine) {
    items.push({
      ms: sessionMs(s),
      kind: 'session',
      label: `${s.app_name} ${s.app_version ?? ''}`.trim(),
      detail: [s.country_code, s.user_agent_family, s.referrer_domain].filter(Boolean).join(' / '),
    });
  }
  for (const e of events) {
    const s = byId.get(e.session_id);
    if (!s) continue;
    items.push({
      ms: Date.parse(e.created_at),
      kind: 'event',
      label: e.event_name,
      detail: Object.entries(e.event_data ?? {})
        .slice(0, 6)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' '),
    });
  }
  return items.filter((i) => Number.isFinite(i.ms)).sort((a, b) => a.ms - b.ms);
}

// ---- usage ----

export interface EventMatrix {
  apps: string[];
  rows: { event: string; total: number; byApp: number[] }[];
}

export function eventMatrix(sessions: SessionRow[], events: EventRow[]): EventMatrix {
  const appOf = new Map(sessions.map((s) => [s.id, s.app_name || 'unknown']));
  const apps = sortApps(new Set(appOf.values()));
  const ai = new Map(apps.map((a, i) => [a, i]));
  const rows = new Map<string, number[]>();
  for (const e of events) {
    const app = appOf.get(e.session_id);
    if (!app) continue;
    let r = rows.get(e.event_name);
    if (!r) rows.set(e.event_name, (r = new Array(apps.length).fill(0)));
    r[ai.get(app)!]++;
  }
  return {
    apps,
    rows: Array.from(rows, ([event, byApp]) => ({
      event,
      byApp,
      total: byApp.reduce((a, b) => a + b, 0),
    })).sort((a, b) => b.total - a.total || a.event.localeCompare(b.event)),
  };
}

export function eventsOverTime(
  sessions: SessionRow[],
  events: EventRow[],
  bucket: Bucket,
  startMs: number,
  endMs: number,
): TimeSeries {
  const appOf = new Map(sessions.map((s) => [s.id, s.app_name || 'unknown']));
  let lo = startMs;
  const times = events.map((e) => Date.parse(e.created_at)).filter(Number.isFinite);
  if (times.length > 0 && Math.min(...times) > lo) lo = Math.min(...times);
  const buckets = bucketRange(lo, endMs, bucket);
  const pos = new Map(buckets.map((b, i) => [b, i]));
  const apps = sortApps(new Set(appOf.values()));
  const data = new Map(apps.map((a) => [a, new Array<number>(buckets.length).fill(0)]));
  for (const e of events) {
    const app = appOf.get(e.session_id);
    const t = Date.parse(e.created_at);
    if (!app || !Number.isFinite(t)) continue;
    const i = pos.get(bucketKey(t, bucket));
    if (i !== undefined) data.get(app)![i]++;
  }
  return { buckets, series: apps.map((key) => ({ key, values: data.get(key)! })) };
}

export interface FunnelStep {
  label: string;
  /** Sessions that reached this step (a session counts once). */
  count: number;
}

export const FUNNEL_DEFS: Record<string, { label: string; events: string[] | null }[]> = {
  catune: [
    { label: 'Visited', events: null },
    { label: 'Loaded data or demo', events: ['file_imported', 'demo_loaded'] },
    { label: 'Tuned (parameters or pin)', events: ['parameters_submitted', 'snapshot_pinned'] },
    { label: 'Submitted', events: ['submission_created'] },
  ],
  cadecon: [
    { label: 'Visited', events: null },
    { label: 'Loaded data or demo', events: ['file_imported', 'demo_loaded'] },
    { label: 'Ran (ranking)', events: ['ranking_completed'] },
    { label: 'Submitted', events: ['submission_created'] },
  ],
};

/**
 * Session-level funnel for one app. Steps are not forced to be sequential: a
 * session counts at a step if it has any of that step's events. Each count is
 * capped by the previous so the funnel never widens.
 */
export function appFunnel(app: string, sessions: SessionRow[], idx: EventIndex): FunnelStep[] {
  const defs = FUNNEL_DEFS[app];
  if (!defs) return [];
  const mine = sessions.filter((s) => s.app_name === app);
  const steps: FunnelStep[] = [];
  let prev = mine;
  for (const d of defs) {
    const names = d.events;
    const next = names
      ? prev.filter((s) => (idx.get(s.id) ?? []).some((e) => names.includes(e.event_name)))
      : mine;
    steps.push({ label: d.label, count: next.length });
    prev = next;
  }
  return steps;
}

export interface TutorialRow {
  tutorial: string;
  started: number;
  completed: number;
}

export function tutorialRates(events: EventRow[]): { rows: TutorialRow[]; hasCompleted: boolean } {
  const m = new Map<string, TutorialRow>();
  let hasCompleted = false;
  for (const e of events) {
    if (e.event_name !== 'tutorial_started' && e.event_name !== 'tutorial_completed') continue;
    const id = evStr(e, 'tutorial_id') ?? 'unknown';
    let r = m.get(id);
    if (!r) m.set(id, (r = { tutorial: id, started: 0, completed: 0 }));
    if (e.event_name === 'tutorial_started') r.started++;
    else {
      r.completed++;
      hasCompleted = true;
    }
  }
  return { rows: Array.from(m.values()).sort((a, b) => b.started - a.started), hasCompleted };
}

export interface ReferrerRow {
  referrer: string;
  sessions: number;
  /** Browsers whose first session came from this referrer. */
  firstTouch: number;
}

export function referrerTable(sessions: SessionRow[], all: SessionRow[]): ReferrerRow[] {
  const label = (r: string | null) => r || 'Direct';
  const total = countBy(sessions, (s) => label(s.referrer_domain));
  const activeFirst = new Map<string, number>();
  const inScope = new Set(sessions.map((s) => s.user_id).filter(Boolean) as string[]);
  const fs = firstSeenByBrowser(all);
  for (const [u, f] of fs) {
    if (!inScope.has(u)) continue;
    const k = label(f.referrer);
    activeFirst.set(k, (activeFirst.get(k) ?? 0) + 1);
  }
  const keys = new Set([...total.keys(), ...activeFirst.keys()]);
  return Array.from(keys, (referrer) => ({
    referrer,
    sessions: total.get(referrer) ?? 0,
    firstTouch: activeFirst.get(referrer) ?? 0,
  })).sort((a, b) => b.sessions - a.sessions || a.referrer.localeCompare(b.referrer));
}

export function screenClass(w: number | null): string {
  if (w === null || !Number.isFinite(w) || w <= 0) return 'Unknown';
  if (w < 600) return 'Phone (<600)';
  if (w < 1024) return 'Tablet (600-1023)';
  if (w < 1920) return 'Laptop (1024-1919)';
  return 'Large (1920+)';
}

export function browserMix(sessions: SessionRow[]) {
  return rank(countBy(sessions, (s) => s.user_agent_family || 'Unknown'));
}

export function screenMix(sessions: SessionRow[]) {
  return rank(countBy(sessions, (s) => screenClass(s.screen_width)));
}

// ---- geography ----

export interface GeoRow {
  country: string;
  sessions: number;
  browsers: number;
  /** Browsers whose first session was in this country. */
  firstSeen: number;
  byApp: Record<string, number>;
}

export function countryTable(sessions: SessionRow[], all: SessionRow[]): GeoRow[] {
  const rows = new Map<string, GeoRow & { b: Set<string> }>();
  const get = (c: string) => {
    let r = rows.get(c);
    if (!r)
      rows.set(
        c,
        (r = { country: c, sessions: 0, browsers: 0, firstSeen: 0, byApp: {}, b: new Set() }),
      );
    return r;
  };
  for (const s of sessions) {
    const r = get(s.country_code || 'Unknown');
    r.sessions++;
    r.byApp[s.app_name] = (r.byApp[s.app_name] ?? 0) + 1;
    if (s.user_id) r.b.add(s.user_id);
  }
  const inScope = new Set(sessions.map((s) => s.user_id).filter(Boolean) as string[]);
  for (const [u, f] of firstSeenByBrowser(all)) {
    if (inScope.has(u)) get(f.country || 'Unknown').firstSeen++;
  }
  return Array.from(rows.values())
    .map(({ b, ...r }) => ({ ...r, browsers: b.size }))
    .sort((a, b) => b.sessions - a.sessions || a.country.localeCompare(b.country));
}

export interface RegionRow {
  country: string;
  region: string;
  sessions: number;
}

export function regionTable(sessions: SessionRow[]): RegionRow[] {
  const m = new Map<string, RegionRow>();
  for (const s of sessions) {
    const country = s.country_code || 'Unknown';
    const region = s.region || '(none)';
    const k = `${country}|${region}`;
    const r = m.get(k);
    if (r) r.sessions++;
    else m.set(k, { country, region, sessions: 1 });
  }
  return Array.from(m.values()).sort((a, b) => b.sessions - a.sessions);
}

export function countryName(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

// ---- misc ----

export function discoverApps(sessions: SessionRow[]): string[] {
  return sortApps(new Set(sessions.map((s) => s.app_name).filter(Boolean)));
}

export function discoverVersions(sessions: SessionRow[], app: string): string[] {
  return Array.from(
    new Set(
      sessions
        .filter((s) => app === 'all' || s.app_name === app)
        .map((s) => s.app_version)
        .filter((v): v is string => !!v),
    ),
  );
}

export function devSessionCount(sessions: SessionRow[]): number {
  return sessions.filter(isDevSession).length;
}

const APP_LABELS: Record<string, string> = { catune: 'CaTune', cadecon: 'CaDecon', cala: 'Cala' };
export function appLabel(app: string): string {
  return APP_LABELS[app] ?? app;
}
