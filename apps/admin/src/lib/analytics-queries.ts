// Supabase reads for the admin dashboard. RLS restricts every table here to
// the admin role. Every read is paged (see paging.ts): an unpaged select is
// silently cut at the project's max-rows (1000 by default).

import { getSupabase } from '@calab/community';
import type { CadeconSubmissionRow, EventRow, SessionRow, SubmissionRow } from './types.ts';
import type { TimeWindow } from './filters.ts';
import { fetchAllPages, type PagedResult } from './paging.ts';

export interface Dataset {
  sessions: SessionRow[];
  events: EventRow[];
  catune: SubmissionRow[];
  cadecon: CadeconSubmissionRow[];
  /** Tables whose read stopped at the row cap: totals are lower bounds. */
  truncated: string[];
  /** Events whose session is outside the loaded window (not attributable to an app). */
  orphanEvents: number;
  fetchedAt: number;
}

const SESSION_COLS =
  'id, created_at, anonymous_id, user_id, is_anonymous, app_name, app_version, country_code, region, screen_width, screen_height, user_agent_family, referrer_domain, ended_at, duration_seconds';
const EVENT_COLS = 'id, created_at, session_id, event_name, event_data';
const CATUNE_COLS =
  'id, created_at, user_id, indicator, species, brain_region, data_source, app_version, tau_rise, tau_decay, lambda, sampling_rate';
const CADECON_COLS =
  'id, created_at, user_id, indicator, species, brain_region, data_source, app_version, tau_rise, tau_decay, sampling_rate, median_alpha, median_pve, mean_event_rate, num_iterations, converged';

async function pagedByTime<T extends { id: string | number }>(
  table: string,
  columns: string,
  w: Pick<TimeWindow, 'fetchStart' | 'fetchEnd'>,
  maxRows?: number,
): Promise<PagedResult<T>> {
  const supabase = await getSupabase();
  if (!supabase) return { rows: [], truncated: false, pages: 0 };
  const from = new Date(w.fetchStart).toISOString();
  const to = new Date(w.fetchEnd).toISOString();
  return fetchAllPages<T>(
    async (a, b) => {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .gte('created_at', from)
        .lt('created_at', to)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(a, b);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as T[];
    },
    { key: (r) => String(r.id), maxRows },
  );
}

export async function fetchDataset(
  w: Pick<TimeWindow, 'fetchStart' | 'fetchEnd'>,
): Promise<Dataset> {
  const [sessions, events, catune, cadecon] = await Promise.all([
    pagedByTime<SessionRow>('analytics_sessions', SESSION_COLS, w),
    pagedByTime<EventRow>('analytics_events', EVENT_COLS, w, 400_000),
    pagedByTime<SubmissionRow>('catune_submissions', CATUNE_COLS, w),
    pagedByTime<CadeconSubmissionRow>('cadecon_submissions', CADECON_COLS, w),
  ]);
  const truncated = [
    sessions.truncated && 'sessions',
    events.truncated && 'events',
    catune.truncated && 'CaTune submissions',
    cadecon.truncated && 'CaDecon submissions',
  ].filter((x): x is string => !!x);
  const ids = new Set(sessions.rows.map((s) => s.id));
  return {
    sessions: sessions.rows,
    events: events.rows,
    catune: catune.rows,
    cadecon: cadecon.rows,
    truncated,
    orphanEvents: events.rows.filter((e) => !ids.has(e.session_id)).length,
    fetchedAt: Date.now(),
  };
}

export async function deleteSubmission(id: string): Promise<void> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('catune_submissions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteCadeconSubmission(id: string): Promise<void> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('cadecon_submissions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
