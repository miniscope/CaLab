// Schema probe: the admin reads analytics tables with select('*'), so a column
// that the deployed database lacks (an unapplied migration) shows up as a key
// missing from the returned rows. We report it instead of failing, and the
// metrics that need it degrade to "n/a".

import type { EventRow, SessionRow } from './types.ts';

/** Columns the admin reads, and the migration that adds each (003 unless noted). */
export const SESSION_COLUMNS_USED: Record<string, string> = {
  id: '003',
  created_at: '003',
  anonymous_id: '003',
  user_id: '003',
  is_anonymous: '008',
  app_name: '003',
  app_version: '003',
  country_code: '003',
  region: '003',
  screen_width: '003',
  screen_height: '003',
  user_agent_family: '003',
  referrer_domain: '003',
  ended_at: '003',
  duration_seconds: '003',
};
export const EVENT_COLUMNS_USED: Record<string, string> = {
  id: '003',
  created_at: '003',
  session_id: '003',
  event_name: '003',
  event_data: '003',
};

export interface SchemaReport {
  missingSessions: string[];
  missingEvents: string[];
  /** True unless the sessions we have lack is_anonymous. */
  anonKnown: boolean;
  messages: string[];
}

export function missingColumns(rows: readonly object[], expected: Iterable<string>): string[] {
  if (rows.length === 0) return [];
  const first = rows[0];
  return Array.from(expected).filter((c) => !(c in first));
}

export function probeSchema(sessions: SessionRow[], events: EventRow[]): SchemaReport {
  const missingSessions = missingColumns(sessions, Object.keys(SESSION_COLUMNS_USED));
  const missingEvents = missingColumns(events, Object.keys(EVENT_COLUMNS_USED));
  const messages: string[] = [];
  for (const c of missingSessions) {
    messages.push(
      c === 'is_anonymous'
        ? 'analytics_sessions.is_anonymous is missing on this database (migration 008): signed-in vs anonymous cannot be told apart.'
        : `analytics_sessions.${c} is missing on this database (migration ${SESSION_COLUMNS_USED[c]}): breakdowns that use it show Unknown.`,
    );
  }
  for (const c of missingEvents) {
    messages.push(
      `analytics_events.${c} is missing on this database (migration ${EVENT_COLUMNS_USED[c]}): views that use it are incomplete.`,
    );
  }
  return {
    missingSessions,
    missingEvents,
    anonKnown: !missingSessions.includes('is_anonymous'),
    messages,
  };
}
