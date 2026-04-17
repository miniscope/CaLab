// Lightweight usage analytics.
// All calls no-op if Supabase is not configured or session init failed.
// Analytics never throws — all errors are silently caught.
//
// After the 008 RLS lockdown, writes require a verified auth.uid(). We
// sign in anonymously (Supabase's built-in anonymous auth) before the
// first session write so every insert / update carries a JWT whose `sub`
// matches the session's owner column.

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
// Cached access token for the raw-fetch heartbeat / pagehide paths. Kept
// in module state so the pagehide handler (which can't await) has a
// current token to send. Refreshed via `onAuthStateChange` below.
let cachedAccessToken: string | null = null;
let authStateSubscribed = false;

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
 * Ensure a Supabase auth session exists (real user or anonymous) and
 * cache the access token. Returns the access token, or null if auth is
 * unavailable / sign-in fails.
 *
 * If the user is already signed in (real account), reuse that session.
 * Otherwise call `signInAnonymously` to get a short-lived anon user.
 */
async function ensureAuth(): Promise<string | null> {
  if (!supabaseEnabled) return null;
  const supabase = await getSupabase();
  if (!supabase) return null;

  if (!authStateSubscribed) {
    authStateSubscribed = true;
    supabase.auth.onAuthStateChange((_event, session) => {
      cachedAccessToken = session?.access_token ?? null;
    });
  }

  const { data: existing } = await supabase.auth.getSession();
  if (existing.session) {
    cachedAccessToken = existing.session.access_token;
    return cachedAccessToken;
  }

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.session) return null;
  cachedAccessToken = data.session.access_token;
  return cachedAccessToken;
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
    const token = await ensureAuth();
    if (!token) return;

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
    const token = cachedAccessToken;
    if (!token) return;
    try {
      fetch(`${supabaseUrl}/rest/v1/analytics_sessions?id=eq.${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseAnonKey!,
          Authorization: `Bearer ${token}`,
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
    const token = cachedAccessToken;
    if (!token) return;
    ended = true;

    try {
      fetch(`${supabaseUrl}/rest/v1/analytics_sessions?id=eq.${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${token}`,
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
