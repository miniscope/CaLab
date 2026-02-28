// Supabase queries for admin analytics data.
// All queries require admin role (enforced by RLS).

import { getSupabase } from '@calab/community';
import type {
  SessionRow,
  EventRow,
  SubmissionRow,
  CadeconSubmissionRow,
  AdminMetrics,
  GeoBreakdown,
  EventBreakdown,
  WeeklySession,
  SourceBreakdown,
  AppBreakdown,
  ReferrerBreakdown,
  DateRange,
} from './types.ts';

/** Convert a date-only string (YYYY-MM-DD) to an end-of-day timestamp. */
function endOfDay(dateStr: string): string {
  return dateStr + 'T23:59:59Z';
}

export async function fetchSessions(range: DateRange): Promise<SessionRow[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('analytics_sessions')
    .select('*')
    .gte('created_at', range.start)
    .lte('created_at', endOfDay(range.end))
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as SessionRow[];
}

export async function fetchEvents(range: DateRange): Promise<EventRow[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('analytics_events')
    .select('*')
    .gte('created_at', range.start)
    .lte('created_at', endOfDay(range.end))
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as EventRow[];
}

export async function fetchSubmissions(range: DateRange): Promise<SubmissionRow[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('catune_submissions')
    .select(
      'id, created_at, user_id, indicator, species, brain_region, data_source, app_version, tau_rise, tau_decay, lambda, sampling_rate',
    )
    .gte('created_at', range.start)
    .lte('created_at', endOfDay(range.end))
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as SubmissionRow[];
}

export async function deleteSubmission(id: string): Promise<void> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Supabase not configured');

  const { error } = await supabase.from('catune_submissions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function fetchCadeconSubmissions(range: DateRange): Promise<CadeconSubmissionRow[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('cadecon_submissions')
    .select(
      'id, created_at, user_id, indicator, species, brain_region, data_source, app_version, tau_rise, tau_decay, sampling_rate, median_alpha, median_pve, mean_event_rate, num_iterations, converged',
    )
    .gte('created_at', range.start)
    .lte('created_at', endOfDay(range.end))
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as CadeconSubmissionRow[];
}

export async function deleteCadeconSubmission(id: string): Promise<void> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Supabase not configured');

  const { error } = await supabase.from('cadecon_submissions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Client-side aggregation helpers

export function computeMetrics(
  sessions: SessionRow[],
  submissions: Pick<SubmissionRow, 'data_source'>[],
): AdminMetrics {
  const uniqueUserIds = new Set(sessions.filter((s) => s.user_id).map((s) => s.user_id));

  // Average session duration derived from ended_at - created_at
  const durations = sessions
    .filter((s) => s.ended_at)
    .map((s) =>
      Math.round((new Date(s.ended_at!).getTime() - new Date(s.created_at).getTime()) / 1000),
    )
    .filter((d) => d > 0);
  const avgSeconds =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const avgMinutes = avgSeconds / 60;
  const avgDurationMinutes =
    avgMinutes >= 1 ? `${avgMinutes.toFixed(1)} min` : `${avgSeconds.toFixed(0)} sec`;

  // Top referrer domain
  const refCounts = new Map<string, number>();
  for (const s of sessions) {
    const domain = s.referrer_domain || 'Direct';
    refCounts.set(domain, (refCounts.get(domain) ?? 0) + 1);
  }
  let topReferrer = 'N/A';
  let maxRef = 0;
  for (const [domain, count] of refCounts) {
    if (count > maxRef) {
      maxRef = count;
      topReferrer = domain;
    }
  }

  return {
    totalSessions: sessions.length,
    uniqueUsers: uniqueUserIds.size,
    anonymousSessions: sessions.filter((s) => !s.user_id).length,
    totalSubmissions: submissions.length,
    avgDurationMinutes,
    topReferrer,
  };
}

export function computeGeoBreakdown(sessions: SessionRow[]): GeoBreakdown[] {
  const map = new Map<string, GeoBreakdown>();
  for (const s of sessions) {
    const key = `${s.country_code ?? 'Unknown'}|${s.region ?? ''}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, {
        country_code: s.country_code ?? 'Unknown',
        region: s.region ?? null,
        count: 1,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

export function computeEventBreakdown(events: EventRow[]): EventBreakdown[] {
  const map = new Map<string, number>();
  for (const e of events) {
    map.set(e.event_name, (map.get(e.event_name) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([event_name, count]) => ({ event_name, count }))
    .sort((a, b) => b.count - a.count);
}

export function computeWeeklySessions(sessions: SessionRow[]): WeeklySession[] {
  const map = new Map<string, number>();
  for (const s of sessions) {
    const date = new Date(s.created_at);
    // Get Monday of the week
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(date);
    monday.setDate(diff);
    const week = monday.toISOString().slice(0, 10);
    map.set(week, (map.get(week) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([week, count]) => ({ week, count }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

export function computeSourceBreakdown(
  submissions: Pick<SubmissionRow, 'data_source'>[],
): SourceBreakdown[] {
  const map = new Map<string, number>();
  for (const s of submissions) {
    const source = s.data_source || 'unknown';
    map.set(source, (map.get(source) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([data_source, count]) => ({ data_source, count }))
    .sort((a, b) => b.count - a.count);
}

export function computeAppBreakdown(sessions: SessionRow[]): AppBreakdown[] {
  const map = new Map<string, number>();
  for (const s of sessions) {
    const app = s.app_name || 'unknown';
    map.set(app, (map.get(app) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([app_name, count]) => ({ app_name, count }))
    .sort((a, b) => b.count - a.count);
}

export function computeReferrerBreakdown(sessions: SessionRow[]): ReferrerBreakdown[] {
  const map = new Map<string, number>();
  for (const s of sessions) {
    const domain = s.referrer_domain || 'Direct';
    map.set(domain, (map.get(domain) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([referrer_domain, count]) => ({ referrer_domain, count }))
    .sort((a, b) => b.count - a.count);
}

/** Flag CaDecon submission IDs as outliers using the IQR method (1.5x IQR from Q1/Q3). */
export function computeCadeconOutliers(submissions: CadeconSubmissionRow[]): Set<string> {
  if (submissions.length < 4) return new Set();

  const outlierIds = new Set<string>();
  const fields = ['tau_rise', 'tau_decay', 'sampling_rate'] as const;

  for (const field of fields) {
    const values = submissions.map((s) => s[field]).filter((v): v is number => v != null);
    if (values.length < 4) continue;

    values.sort((a, b) => a - b);
    const q1 = values[Math.floor(values.length * 0.25)];
    const q3 = values[Math.floor(values.length * 0.75)];
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;

    for (const s of submissions) {
      const v = s[field];
      if (v != null && (v < lower || v > upper)) {
        outlierIds.add(s.id);
      }
    }
  }

  return outlierIds;
}

/** Flag submission IDs as outliers using the IQR method (1.5x IQR from Q1/Q3). */
export function computeOutliers(submissions: SubmissionRow[]): Set<string> {
  if (submissions.length < 4) return new Set();

  const outlierIds = new Set<string>();
  const fields = ['tau_rise', 'tau_decay', 'lambda', 'sampling_rate'] as const;

  for (const field of fields) {
    const values = submissions.map((s) => s[field]).filter((v): v is number => v != null);
    if (values.length < 4) continue;

    values.sort((a, b) => a - b);
    const q1 = values[Math.floor(values.length * 0.25)];
    const q3 = values[Math.floor(values.length * 0.75)];
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;

    for (const s of submissions) {
      const v = s[field];
      if (v != null && (v < lower || v > upper)) {
        outlierIds.add(s.id);
      }
    }
  }

  return outlierIds;
}
