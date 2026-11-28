import type { EventRow, SessionRow } from '../lib/types.ts';

let n = 0;
export const T0 = Date.UTC(2026, 10, 1, 12, 0, 0); // A Sunday, 12:00 UTC

export function session(over: Partial<SessionRow> = {}): SessionRow {
  n++;
  return {
    id: `s${n}`,
    created_at: new Date(T0).toISOString(),
    anonymous_id: `a${n}`,
    user_id: `u${n}`,
    is_anonymous: true,
    app_name: 'cala',
    app_version: '2.18.0',
    country_code: 'US',
    region: null,
    screen_width: 1440,
    screen_height: 900,
    user_agent_family: 'Chrome',
    referrer_domain: null,
    ended_at: null,
    duration_seconds: null,
    ...over,
  };
}

export function event(
  sessionId: string,
  name: string,
  data: Record<string, unknown> = {},
  atMs = T0,
): EventRow {
  n++;
  return {
    id: n,
    created_at: new Date(atMs).toISOString(),
    session_id: sessionId,
    event_name: name,
    event_data: data,
  };
}

export const day = (d: number, hour = 12) => T0 + d * 86_400_000 + (hour - 12) * 3_600_000;
