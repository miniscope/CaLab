// Small pure helpers shared by every aggregation.

import { DAY_MS, utcDay, weekStart } from './filters.ts';

export function finite(values: Iterable<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  return out;
}

/** Linear-interpolated quantile; null for no finite values. */
export function quantile(values: Iterable<number | null | undefined>, q: number): number | null {
  const v = finite(values).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export function median(values: Iterable<number | null | undefined>): number | null {
  return quantile(values, 0.5);
}

/** Short stable label for an id (FNV-1a). Display only; not a security hash. */
export function shortHash(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

export function countBy<T>(items: Iterable<T>, key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export function rank(m: Map<string, number>): { key: string; count: number }[] {
  return Array.from(m, ([key, count]) => ({ key, count })).sort(
    (a, b) => b.count - a.count || a.key.localeCompare(b.key),
  );
}

export interface Delta {
  abs: number;
  /** Fractional change vs previous; null when previous is 0. */
  pct: number | null;
}

export function delta(cur: number | null, prev: number | null): Delta | null {
  if (cur === null || prev === null) return null;
  return { abs: cur - prev, pct: prev === 0 ? null : (cur - prev) / prev };
}

/** Compare dotted versions numerically; "dev" and non-numeric sort last. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10));
  const na = pa.every(Number.isFinite);
  const nb = pb.every(Number.isFinite);
  if (na !== nb) return na ? -1 : 1;
  if (!na) return a.localeCompare(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type Bucket = 'day' | 'week';

export function bucketKey(ms: number, bucket: Bucket): string {
  return bucket === 'day' ? utcDay(ms) : weekStart(ms);
}

/** Every bucket key from `startMs` to `endMs` (exclusive), gaps included. */
export function bucketRange(startMs: number, endMs: number, bucket: Bucket): string[] {
  const out: string[] = [];
  if (!(endMs > startMs)) return out;
  const step = bucket === 'day' ? DAY_MS : 7 * DAY_MS;
  let t = bucket === 'day' ? Math.floor(startMs / DAY_MS) * DAY_MS : Date.parse(weekStart(startMs));
  // Guard against runaway ranges (e.g. "all time" from 1970).
  let guard = 0;
  while (t < endMs && guard++ < 4000) {
    out.push(utcDay(t));
    t += step;
  }
  return out;
}

export interface HistBin {
  lo: number;
  hi: number;
  count: number;
  label: string;
}

/** Equal-width histogram over finite values; `bins` >= 1. Empty input -> []. */
export function histogram(values: Iterable<number | null | undefined>, bins = 10): HistBin[] {
  const v = finite(values);
  if (v.length === 0) return [];
  const min = Math.min(...v);
  const max = Math.max(...v);
  if (min === max) return [{ lo: min, hi: max, count: v.length, label: fmtNum(min) }];
  const width = (max - min) / bins;
  const out: HistBin[] = Array.from({ length: bins }, (_, i) => ({
    lo: min + i * width,
    hi: min + (i + 1) * width,
    count: 0,
    label: '',
  }));
  for (const x of v) out[Math.min(bins - 1, Math.floor((x - min) / width))].count++;
  for (const b of out) b.label = `${fmtNum(b.lo)}-${fmtNum(b.hi)}`;
  return out;
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1e6) return `${+(n / 1e6).toPrecision(3)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toPrecision(3)}K`;
  if (digits === 0 && Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { maximumFractionDigits: digits || (a < 10 ? 1 : 0) });
}

export function fmtPct(x: number | null | undefined, digits = 0): string {
  return x === null || x === undefined || !Number.isFinite(x)
    ? '-'
    : `${(x * 100).toFixed(digits)}%`;
}

export function fmtDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '-';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

const APP_ORDER = ['catune', 'cadecon', 'cala'];

/** Sort app slugs: CaTune, CaDecon, Cala first (stable stacking order), then the rest by name. */
export function sortApps(apps: Iterable<string>): string[] {
  const rank = (a: string) => {
    const i = APP_ORDER.indexOf(a);
    return i < 0 ? APP_ORDER.length : i;
  };
  return Array.from(apps).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
