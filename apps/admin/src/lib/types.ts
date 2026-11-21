export interface SessionRow {
  id: string;
  created_at: string;
  anonymous_id: string;
  user_id: string | null;
  /** Absent (undefined) when the database lacks migration 008's column; never assume a value. */
  is_anonymous?: boolean | null;
  app_name: string;
  app_version: string | null;
  country_code: string | null;
  region: string | null;
  screen_width: number | null;
  screen_height: number | null;
  user_agent_family: string | null;
  referrer_domain: string | null;
  ended_at: string | null;
  duration_seconds?: number | null;
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
  tau_rise: number;
  tau_decay: number;
  lambda: number;
  sampling_rate: number;
}

export interface CadeconSubmissionRow {
  id: string;
  created_at: string;
  user_id: string;
  indicator: string;
  species: string;
  brain_region: string;
  data_source: string;
  app_version: string;
  tau_rise: number;
  tau_decay: number;
  sampling_rate: number;
  median_alpha: number | null;
  median_pve: number | null;
  mean_event_rate: number | null;
  num_iterations: number;
  converged: boolean;
}

export type AdminView =
  'overview' | 'cala' | 'users' | 'geography' | 'usage' | 'submissions' | 'donations' | 'export';

export const ADMIN_VIEWS: readonly AdminView[] = [
  'overview',
  'cala',
  'users',
  'geography',
  'usage',
  'submissions',
  'donations',
  'export',
];
