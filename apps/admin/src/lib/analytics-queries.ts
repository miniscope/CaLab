// Supabase reads for the admin dashboard. RLS restricts every table here to
// the admin role. Reads are keyset-paged (see paging.ts) by loader.ts.

import { getSupabase } from '@calab/community';
import type { CadeconSubmissionRow, EventRow, SessionRow, SubmissionRow } from './types.ts';
import type { Cursor } from './paging.ts';
import { PAGE_SIZE } from './paging.ts';

type SupabaseLike = Pick<NonNullable<Awaited<ReturnType<typeof getSupabase>>>, 'from'>;

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

export type TableName = 'sessions' | 'events' | 'catune' | 'cadecon';

export const TABLES: Record<TableName, { table: string; columns: string; label: string }> = {
  sessions: {
    table: 'analytics_sessions',
    label: 'Sessions',
    columns:
      // select('*'): never name a column the deployed schema may lack (008's
      // is_anonymous was missing in production). lib/schema.ts reports what is absent.
      '*',
  },
  events: {
    table: 'analytics_events',
    label: 'Events',
    columns: '*',
  },
  catune: {
    table: 'catune_submissions',
    label: 'CaTune submissions',
    columns:
      'id, created_at, user_id, indicator, species, brain_region, data_source, app_version, tau_rise, tau_decay, lambda, sampling_rate',
  },
  cadecon: {
    table: 'cadecon_submissions',
    label: 'CaDecon submissions',
    columns:
      'id, created_at, user_id, indicator, species, brain_region, data_source, app_version, tau_rise, tau_decay, sampling_rate, median_alpha, median_pve, mean_event_rate, num_iterations, converged',
  },
};

export interface TimeRange {
  from: number;
  to: number;
}

export type PageFn = (cursor: Cursor | null, signal: AbortSignal) => Promise<never[]>;

/** Where pages come from: Supabase in production, an in-memory table in fixture mode. */
export interface PageSource {
  pageFn(table: TableName, range: TimeRange): PageFn;
}

/**
 * Keyset page query: created_at in [from, to), strictly after the cursor in
 * (created_at desc, id desc). Ties on created_at are resolved by id, so
 * identical timestamps are neither skipped nor repeated.
 */
export function supabaseSource(supabase: SupabaseLike | null, pageSize = PAGE_SIZE): PageSource {
  return {
    pageFn(name, range) {
      const { table, columns } = TABLES[name];
      return async (cursor, signal) => {
        if (!supabase) return [];
        let q = supabase
          .from(table)
          .select(columns)
          .gte('created_at', new Date(range.from).toISOString())
          .lt('created_at', new Date(range.to).toISOString());
        if (cursor) {
          const c = cursor.created_at;
          q = q.or(`created_at.lt.${c},and(created_at.eq.${c},id.lt.${cursor.id})`);
        }
        const { data, error } = await q
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(pageSize)
          .abortSignal(signal);
        if (error) throw new Error(error.message);
        return (data ?? []) as unknown as never[];
      };
    },
  };
}

export async function liveSource(): Promise<PageSource> {
  return supabaseSource(await getSupabase());
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
