// Schema fingerprint: which migrations the production database has applied.
// Migrations are applied by hand (no supabase_migrations table), so a skipped
// file is otherwise invisible. The check list mirrors
// supabase/migrations/019_schema_fingerprint.sql and the table in
// supabase/README.md; keep the three in sync.
//
// Everything here degrades to "unknown": a missing function (019 not applied),
// a non-admin caller or a network error never throws into the dashboard.

import { getSupabase } from '@calab/community';

export interface FingerprintCheck {
  key: string;
  migration: string;
  label: string;
  /** Optional migrations (performance only) are reported but never count as missing. */
  optional?: boolean;
}

export const FINGERPRINT_CHECKS: readonly FingerprintCheck[] = [
  { key: '003_analytics_tables', migration: '003', label: 'analytics tables exist' },
  { key: '004_is_admin_function', migration: '004', label: 'is_admin() function' },
  { key: '006_cadecon_table', migration: '006', label: 'cadecon_submissions table' },
  { key: '008_is_anonymous_column', migration: '008', label: 'analytics_sessions.is_anonymous' },
  { key: '008_event_data_size_check', migration: '008', label: 'event_data size check' },
  { key: '008_session_time_checks', migration: '008', label: 'session time checks' },
  {
    key: '008_permissive_policies_removed',
    migration: '008',
    label: 'open insert/update policies removed',
  },
  {
    key: '008_events_insert_policy',
    migration: '008',
    label: 'events insert (own session) policy',
  },
  { key: '009_catune_tau_bounds', migration: '009', label: 'CaTune tau bounds tightened' },
  { key: '010_public_views', migration: '010', label: '*_public views exist' },
  { key: '010_owner_read_policy', migration: '010', label: 'owner/admin submission read policy' },
  { key: '011_views_select_only', migration: '011', label: '*_public views are SELECT-only' },
  { key: '012_no_anonymous_submissions', migration: '012', label: 'anonymous submissions blocked' },
  { key: '013_session_cap_trigger', migration: '013', label: 'per-session event cap trigger' },
  {
    key: '013_client_session_insert_removed',
    migration: '013',
    label: 'client session insert removed',
  },
  { key: '014_payload_checks', migration: '014', label: 'submission payload checks' },
  { key: '015_app_name_slug_check', migration: '015', label: 'app_name slug check (allows cala)' },
  { key: '016_cadecon_max_firing_rate', migration: '016', label: 'cadecon max_firing_rate' },
  { key: '017_event_name_shape_check', migration: '017', label: 'event_name shape check' },
  {
    key: '018_admin_read_indexes',
    migration: '018',
    label: 'admin read indexes',
    optional: true,
  },
];

export type CheckState = 'ok' | 'missing' | 'unknown';

export interface FingerprintRow extends FingerprintCheck {
  state: CheckState;
}

export interface FingerprintReport {
  /** 'unavailable': the function is not installed (019) or could not be called. */
  status: 'ok' | 'unavailable';
  rows: FingerprintRow[];
  missing: FingerprintRow[];
  reason: string | null;
}

/** Turn whatever the RPC returned into a report; never throws. */
export function buildReport(data: unknown, reason: string | null = null): FingerprintReport {
  const obj =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const rows = FINGERPRINT_CHECKS.map((c): FingerprintRow => {
    const v = obj ? obj[c.key] : undefined;
    return { ...c, state: v === true ? 'ok' : v === false ? 'missing' : 'unknown' };
  });
  return {
    status: obj ? 'ok' : 'unavailable',
    rows,
    missing: rows.filter((r) => r.state === 'missing' && !r.optional),
    reason: obj ? null : (reason ?? 'unexpected response'),
  };
}

type RpcClient = {
  rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function fetchFingerprint(client?: RpcClient | null): Promise<FingerprintReport> {
  try {
    const sb = client ?? ((await getSupabase()) as unknown as RpcClient | null);
    if (!sb) return buildReport(null, 'Supabase is not configured');
    const { data, error } = await sb.rpc('schema_fingerprint');
    if (error) return buildReport(null, error.message);
    return buildReport(data);
  } catch (e) {
    return buildReport(null, e instanceof Error ? e.message : String(e));
  }
}
