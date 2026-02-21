// Supabase queries for admin analytics data.
// All queries require admin role (enforced by RLS).

import { getSupabase } from '@calab/community';
import type {
  SessionRow,
  EventRow,
  SubmissionRow,
  AdminMetrics,
  GeoBreakdown,
  EventBreakdown,
  WeeklySession,
  DateRange,
} from './types.ts';

export async function fetchSessions(range: DateRange): Promise<SessionRow[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('analytics_sessions')
    .select('*')
    .gte('created_at', range.start)
    .lte('created_at', range.end + 'T23:59:59Z')
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
    .lte('created_at', range.end + 'T23:59:59Z')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as EventRow[];
}

export async function fetchSubmissions(): Promise<SubmissionRow[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('catune_submissions')
    .select('id, created_at, user_id, indicator, species, brain_region, data_source, app_version')
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

// --- Client-side aggregation ---

export function computeMetrics(sessions: SessionRow[], submissions: SubmissionRow[]): AdminMetrics {
  const uniqueUserIds = new Set(sessions.filter((s) => s.user_id).map((s) => s.user_id));
  return {
    totalSessions: sessions.length,
    uniqueUsers: uniqueUserIds.size,
    anonymousSessions: sessions.filter((s) => !s.user_id).length,
    totalSubmissions: submissions.length,
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
