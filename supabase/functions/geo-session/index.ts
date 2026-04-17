// Supabase Edge Function: geo-session
// Receives session start data from client, resolves client country/region
// from the Cloudflare edge headers (no outbound IP lookup, IP never stored),
// inserts session, returns session_id.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Origins allowed to call this function. Additional origins (e.g. preview
 * deploys) can be added via the `GEO_SESSION_EXTRA_ORIGINS` env var as a
 * comma-separated list.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://miniscope.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function allowedOrigins(): Set<string> {
  const extra = Deno.env.get('GEO_SESSION_EXTRA_ORIGINS') ?? '';
  const extras = extra
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extras]);
}

function corsHeaders(origin: string | null): Record<string, string> {
  // Echo the request origin only when it's on the allowlist — prevents the
  // previous `*` from letting arbitrary third-party pages trigger sessions
  // via a victim's browser.
  const allow = origin && allowedOrigins().has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

interface SessionPayload {
  anonymous_id: string;
  app_name: 'catune' | 'carank' | 'cadecon';
  app_version?: string;
  screen_width?: number;
  screen_height?: number;
  user_agent_family?: string;
  referrer_domain?: string;
}

/**
 * Read the client's country/region from Cloudflare edge headers. Supabase's
 * function gateway sits behind CF, so cf-ipcountry is always populated for
 * real requests. Falls back to empty if the header is missing (local dev,
 * non-CF deployment).
 *
 * Previously this made an outbound `http://ip-api.com/json/...` call over
 * plaintext HTTP — an unnecessary dependency and a MITM-poisonable channel.
 */
function resolveGeo(req: Request): { countryCode: string | null; regionName: string | null } {
  const country = req.headers.get('cf-ipcountry');
  const region = req.headers.get('cf-region');
  return {
    countryCode: country && country !== 'XX' && country !== 'T1' ? country : null,
    regionName: region ?? null,
  };
}

interface ResolvedUser {
  id: string | null;
  isAnonymous: boolean;
}

/**
 * Resolve the authenticated user via a verified Supabase session, not by
 * parsing the JWT payload directly. The previous implementation did
 * `JSON.parse(atob(...))` on the bearer token body — if the gateway ever
 * shipped with verify_jwt disabled (or a future config flip), `sub` could
 * be forged by any caller.
 *
 * Returns both the user id and whether the account is anonymous (Supabase
 * sets `is_anonymous: true` on accounts created via `signInAnonymously`).
 * The flag is stored on the session row so the admin UI can distinguish
 * anonymous visitors from logged-in users even though both now carry a
 * non-null `user_id`.
 */
async function resolveUser(authHeader: string | null): Promise<ResolvedUser> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { id: null, isAnonymous: false };
  }
  const token = authHeader.slice('Bearer '.length);
  try {
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data } = await userClient.auth.getUser();
    return {
      id: data.user?.id ?? null,
      isAnonymous: data.user?.is_anonymous ?? false,
    };
  } catch {
    return { id: null, isAnonymous: false };
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(origin) });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405, origin);
  }

  // Reject disallowed origins early so we don't do any work for an origin
  // the browser will refuse to read the response from anyway.
  if (origin && !allowedOrigins().has(origin)) {
    return jsonResponse({ error: 'origin not allowed' }, 403, origin);
  }

  try {
    const body: SessionPayload = await req.json();

    if (!body.anonymous_id || !body.app_name) {
      return jsonResponse({ error: 'anonymous_id and app_name are required' }, 400, origin);
    }

    const geo = resolveGeo(req);
    const user = await resolveUser(req.headers.get('authorization'));

    // Require a verified user (anonymous or real). Without one, RLS on
    // the sessions table would block every subsequent client write
    // (heartbeat, event inserts, pagehide), so creating a bare session
    // row would just produce silent orphans.
    if (!user.id) {
      return jsonResponse({ error: 'authentication required' }, 401, origin);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await supabase
      .from('analytics_sessions')
      .insert({
        anonymous_id: body.anonymous_id,
        user_id: user.id,
        is_anonymous: user.isAnonymous,
        app_name: body.app_name,
        app_version: body.app_version ?? null,
        country_code: geo.countryCode,
        region: geo.regionName,
        screen_width: body.screen_width ?? null,
        screen_height: body.screen_height ?? null,
        user_agent_family: body.user_agent_family ?? null,
        referrer_domain: body.referrer_domain ?? null,
      })
      .select('id')
      .single();

    if (error) {
      return jsonResponse({ error: error.message }, 500, origin);
    }

    return jsonResponse({ session_id: data.id }, 200, origin);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : 'Internal error' },
      500,
      origin,
    );
  }
});
