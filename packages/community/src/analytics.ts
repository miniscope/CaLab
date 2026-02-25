// Lightweight usage analytics.
// All calls no-op if Supabase is not configured or session init failed.
// Analytics never throws — all errors are silently caught.

import { getSupabase, supabaseEnabled, supabaseUrl, supabaseAnonKey } from './supabase.ts';

export type AnalyticsEventName =
  | 'file_imported'
  | 'demo_loaded'
  | 'parameters_submitted'
  | 'snapshot_pinned'
  | 'community_browser_opened'
  | 'submission_created'
  | 'ranking_completed'
  | 'tutorial_started'
  | 'tutorial_completed'
  | 'auth_signed_in'
  | 'auth_signed_out';

let sessionId: string | null = null;
let sessionEndRegistered = false;

function getAnonymousId(): string {
  let id = sessionStorage.getItem('calab_anon_id');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('calab_anon_id', id);
  }
  return id;
}

function detectBrowserFamily(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Safari/') && !ua.includes('Chrome')) return 'Safari';
  return 'Other';
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Initialize an analytics session by calling the geo-session Edge Function.
 * Stores the returned session_id for subsequent trackEvent calls.
 */
export async function initSession(
  appName: 'catune' | 'carank' | 'cadecon',
  appVersion?: string,
): Promise<void> {
  if (!supabaseEnabled) return;

  try {
    const supabase = await getSupabase();
    if (!supabase) return;

    const { data, error } = await supabase.functions.invoke('geo-session', {
      body: {
        anonymous_id: getAnonymousId(),
        app_name: appName,
        app_version: appVersion ?? null,
        screen_width: window.screen.width,
        screen_height: window.screen.height,
        user_agent_family: detectBrowserFamily(),
        referrer_domain: document.referrer ? extractDomain(document.referrer) : null,
      },
    });

    if (error || !data?.session_id) return;
    sessionId = data.session_id;

    // Register end listeners only after session is established
    registerSessionEndListeners();
    startHeartbeat();
  } catch {
    // Analytics init failed — silently continue
  }
}

/**
 * Track a high-level event within the current session.
 * No-ops if session was not initialized.
 */
export async function trackEvent(
  eventName: AnalyticsEventName,
  eventData?: Record<string, unknown>,
): Promise<void> {
  if (!supabaseEnabled || !sessionId) return;

  try {
    const supabase = await getSupabase();
    if (!supabase) return;

    await supabase.from('analytics_events').insert({
      session_id: sessionId,
      event_name: eventName,
      event_data: eventData ?? {},
    });
  } catch {
    // Event tracking failed — silently continue
  }
}

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Periodically update ended_at while the page is visible.
 * This ensures we have a recent timestamp even if the page-unload PATCH fails
 * (which browsers frequently abort).
 */
function startHeartbeat(): void {
  if (!supabaseUrl || !supabaseAnonKey || !sessionId) return;

  const tick = () => {
    if (!sessionId || document.visibilityState === 'hidden') return;
    try {
      fetch(`${supabaseUrl}/rest/v1/analytics_sessions?id=eq.${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseAnonKey!,
          Authorization: `Bearer ${supabaseAnonKey}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ ended_at: new Date().toISOString() }),
      });
    } catch {
      // Best-effort — ignore errors
    }
  };

  setInterval(tick, HEARTBEAT_INTERVAL_MS);
}

/**
 * Register event listeners for best-effort session end on tab close.
 * Uses visibilitychange + pagehide with keepalive fetch.
 *
 * NOTE: Uses raw fetch with keepalive instead of the Supabase SDK because
 * the SDK's async operations are not guaranteed to complete during page
 * unload (visibilitychange/pagehide). The keepalive flag on fetch ensures
 * the request outlives the page.
 */
function registerSessionEndListeners(): void {
  if (!supabaseEnabled || sessionEndRegistered) return;
  sessionEndRegistered = true;

  let ended = false;

  const handleEnd = () => {
    if (ended || !sessionId || !supabaseUrl || !supabaseAnonKey) return;
    ended = true;

    try {
      fetch(`${supabaseUrl}/rest/v1/analytics_sessions?id=eq.${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ ended_at: new Date().toISOString() }),
        keepalive: true,
      });
    } catch {
      // Best-effort — ignore errors
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') handleEnd();
  });
  document.addEventListener('pagehide', handleEnd);
}
