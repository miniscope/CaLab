// Global filters (app, date range, version, dev noise) and their URL form.
// All dates are UTC: sessions are stamped in UTC by the database, and bucketing
// in the viewer's zone would shift a session across days between admins.

import type { AdminView, SessionRow } from './types.ts';
import { ADMIN_VIEWS } from './types.ts';

export type Preset = '7d' | '30d' | '90d' | 'all' | 'custom';

export interface Filters {
  /** 'all' or an app slug. */
  app: string;
  preset: Preset;
  /** Inclusive UTC days (YYYY-MM-DD); only read when preset is 'custom'. */
  start: string;
  end: string;
  /** 'all' or an exact app_version. */
  version: string;
  includeDev: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  app: 'all',
  preset: '30d',
  start: '',
  end: '',
  version: 'all',
  includeDev: false,
};

export const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseDay(s: string): number | null {
  if (!DAY_RE.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) && utcDay(ms) === s ? ms : null;
}

/** Monday (UTC) of the week containing `ms`, as YYYY-MM-DD. */
export function weekStart(ms: number): string {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return utcDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
}

export interface TimeWindow {
  /** Half-open [curStart, curEnd) in epoch ms. */
  curStart: number;
  curEnd: number;
  /** Equal-length period right before; null for "all time". */
  prevStart: number | null;
  prevEnd: number | null;
  /** Span to fetch: previous period start (or current start) to curEnd. */
  fetchStart: number;
  fetchEnd: number;
}

export function resolveWindow(f: Filters, nowMs: number): TimeWindow {
  const tomorrow = Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS;
  let curStart: number;
  let curEnd = tomorrow;
  let all = false;
  if (f.preset === 'all') {
    curStart = 0;
    all = true;
  } else if (f.preset === 'custom') {
    const a = parseDay(f.start);
    const b = parseDay(f.end);
    if (a === null || b === null) {
      curStart = tomorrow - 30 * DAY_MS;
    } else {
      curStart = Math.min(a, b);
      curEnd = Math.max(a, b) + DAY_MS;
    }
  } else {
    const days = f.preset === '7d' ? 7 : f.preset === '90d' ? 90 : 30;
    curStart = tomorrow - days * DAY_MS;
  }
  const len = curEnd - curStart;
  const prevStart = all ? null : curStart - len;
  const prevEnd = all ? null : curStart;
  return {
    curStart,
    curEnd,
    prevStart,
    prevEnd,
    fetchStart: prevStart ?? curStart,
    fetchEnd: curEnd,
  };
}

const LOCAL_REFERRER = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|.*\.local)$/i;

/** Developer noise: local builds report version "dev"; localhost referrers. */
export function isDevSession(s: Pick<SessionRow, 'app_version' | 'referrer_domain'>): boolean {
  if (s.app_version === 'dev') return true;
  return !!s.referrer_domain && LOCAL_REFERRER.test(s.referrer_domain);
}

export function applySessionFilters(sessions: SessionRow[], f: Filters): SessionRow[] {
  return sessions.filter(
    (s) =>
      (f.app === 'all' || s.app_name === f.app) &&
      (f.version === 'all' || s.app_version === f.version) &&
      (f.includeDev || !isDevSession(s)),
  );
}

export interface Periods {
  cur: SessionRow[];
  prev: SessionRow[];
}

export function splitPeriods(sessions: SessionRow[], w: TimeWindow): Periods {
  const cur: SessionRow[] = [];
  const prev: SessionRow[] = [];
  for (const s of sessions) {
    const t = Date.parse(s.created_at);
    if (!Number.isFinite(t)) continue;
    if (t >= w.curStart && t < w.curEnd) cur.push(s);
    else if (w.prevStart !== null && w.prevEnd !== null && t >= w.prevStart && t < w.prevEnd) {
      prev.push(s);
    }
  }
  return { cur, prev };
}

export function rangeLabel(f: Filters, w: TimeWindow): string {
  if (f.preset === 'all') return 'all time';
  return `${utcDay(w.curStart)} to ${utcDay(w.curEnd - DAY_MS)} UTC`;
}

// URL state: #/<view>?app=cala&range=30d&ver=2.18.0&dev=1

export interface UrlState {
  view: AdminView;
  filters: Filters;
}

export function parseHash(hash: string): UrlState {
  const raw = hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const view = (ADMIN_VIEWS as readonly string[]).includes(path) ? (path as AdminView) : 'overview';
  const q = new URLSearchParams(query);
  const filters: Filters = { ...DEFAULT_FILTERS };
  const app = q.get('app');
  if (app && /^[a-z][a-z0-9_-]{1,31}$/.test(app)) filters.app = app;
  const range = q.get('range');
  if (range === '7d' || range === '30d' || range === '90d' || range === 'all') {
    filters.preset = range;
  } else if (range) {
    const [a, b] = range.split('..');
    if (a && b && parseDay(a) !== null && parseDay(b) !== null) {
      filters.preset = 'custom';
      filters.start = a;
      filters.end = b;
    }
  }
  const ver = q.get('ver');
  if (ver && ver.length <= 40) filters.version = ver;
  filters.includeDev = q.get('dev') === '1';
  return { view, filters };
}

export function toHash(view: AdminView, f: Filters): string {
  const q = new URLSearchParams();
  if (f.app !== 'all') q.set('app', f.app);
  if (f.preset === 'custom') q.set('range', `${f.start}..${f.end}`);
  else if (f.preset !== DEFAULT_FILTERS.preset) q.set('range', f.preset);
  if (f.version !== 'all') q.set('ver', f.version);
  if (f.includeDev) q.set('dev', '1');
  const qs = q.toString();
  return `#/${view}${qs ? `?${qs}` : ''}`;
}
