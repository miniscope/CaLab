// Supabase Edge Function: geo-session
// Receives session start data from client, resolves IP → country/region
// server-side (IP is never stored), inserts session, returns session_id.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SessionPayload {
  anonymous_id: string;
  app_name: 'catune' | 'carank';
  app_version?: string;
  screen_width?: number;
  screen_height?: number;
  user_agent_family?: string;
  referrer_domain?: string;
}

interface GeoResult {
  countryCode?: string;
  regionName?: string;
}

async function resolveGeo(ip: string): Promise<GeoResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,regionName`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return {};
    const data = await res.json();
    if (data.status !== 'success') return {};
    return { countryCode: data.countryCode, regionName: data.regionName };
  } catch {
    return {};
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body: SessionPayload = await req.json();

    if (!body.anonymous_id || !body.app_name) {
      return new Response(JSON.stringify({ error: 'anonymous_id and app_name are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve IP → country/region (IP never stored)
    const ip =
      req.headers.get('cf-connecting-ip') ||
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      '';
    const geo = ip ? await resolveGeo(ip) : {};

    // Extract auth user_id if present
    const authHeader = req.headers.get('authorization') ?? '';
    let userId: string | null = null;
    if (authHeader.startsWith('Bearer ')) {
      try {
        const payload = JSON.parse(atob(authHeader.split('.')[1]));
        userId = payload.sub ?? null;
      } catch {
        // Ignore malformed JWT
      }
    }

    // Insert session using service_role client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await supabase
      .from('analytics_sessions')
      .insert({
        anonymous_id: body.anonymous_id,
        user_id: userId,
        app_name: body.app_name,
        app_version: body.app_version ?? null,
        country_code: geo.countryCode ?? null,
        region: geo.regionName ?? null,
        screen_width: body.screen_width ?? null,
        screen_height: body.screen_height ?? null,
        user_agent_family: body.user_agent_family ?? null,
        referrer_domain: body.referrer_domain ?? null,
      })
      .select('id')
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ session_id: data.id }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
