export interface SessionRow {
  id: string;
  created_at: string;
  anonymous_id: string;
  user_id: string | null;
  app_name: string;
  app_version: string | null;
  country_code: string | null;
  region: string | null;
  screen_width: number | null;
  screen_height: number | null;
  user_agent_family: string | null;
  referrer_domain: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface EventRow {
  id: number;
  created_at: string;
  session_id: string;
  event_name: string;
  event_data: Record<string, unknown>;
}

export interface SubmissionRow {
  id: string;
  created_at: string;
  user_id: string;
  indicator: string;
  species: string;
  brain_region: string;
  data_source: string;
  app_version: string | null;
}

export interface AdminMetrics {
  totalSessions: number;
  uniqueUsers: number;
  anonymousSessions: number;
  totalSubmissions: number;
}

export interface GeoBreakdown {
  country_code: string;
  region: string | null;
  count: number;
}

export interface EventBreakdown {
  event_name: string;
  count: number;
}

export interface WeeklySession {
  week: string;
  count: number;
}

export type AdminView = 'overview' | 'usage' | 'geography' | 'submissions' | 'export';

export interface DateRange {
  start: string;
  end: string;
}
