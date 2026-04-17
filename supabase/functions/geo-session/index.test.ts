/**
 * Deno tests for the geo-session edge function.
 *
 * Cover the request handler error paths and the pure helper functions. The
 * Supabase-authenticated happy path (insert into analytics_sessions + return
 * a session id) requires a live Supabase project and is exercised by the
 * RLS integration suite under supabase/tests/rls/.
 *
 * Run with: deno test --allow-env --allow-net
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { allowedOrigins, corsHeaders, handleRequest, resolveGeo } from './index.ts';

// ── helpers ────────────────────────────────────────────────────────────────

function makeRequest(
  method: string,
  opts?: {
    origin?: string | null;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Request {
  const headers = new Headers(opts?.headers ?? {});
  if (opts?.origin !== undefined && opts.origin !== null) {
    headers.set('origin', opts.origin);
  }
  return new Request('https://edge.local/geo-session', {
    method,
    headers,
    body: opts?.body === undefined ? null : JSON.stringify(opts.body),
  });
}

async function responseJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const ALLOWED_ORIGIN = 'http://localhost:5173';
const DISALLOWED_ORIGIN = 'http://evil.example.com';

// ── pure helpers ───────────────────────────────────────────────────────────

Deno.test('allowedOrigins includes the hardcoded defaults', () => {
  Deno.env.delete('GEO_SESSION_EXTRA_ORIGINS');
  const origins = allowedOrigins();
  assertEquals(origins.has('https://miniscope.github.io'), true);
  assertEquals(origins.has('http://localhost:5173'), true);
  assertEquals(origins.has('http://127.0.0.1:5173'), true);
});

Deno.test('allowedOrigins merges GEO_SESSION_EXTRA_ORIGINS entries', () => {
  Deno.env.set(
    'GEO_SESSION_EXTRA_ORIGINS',
    'https://preview1.example.com, https://preview2.example.com',
  );
  try {
    const origins = allowedOrigins();
    assertEquals(origins.has('https://preview1.example.com'), true);
    assertEquals(origins.has('https://preview2.example.com'), true);
  } finally {
    Deno.env.delete('GEO_SESSION_EXTRA_ORIGINS');
  }
});

Deno.test('allowedOrigins ignores blank GEO_SESSION_EXTRA_ORIGINS entries', () => {
  Deno.env.set('GEO_SESSION_EXTRA_ORIGINS', ' , ,');
  try {
    // Previously the trim-empty-filter would have produced an empty-string
    // entry that would silently match any incoming origin with no Origin
    // header. Assert that the final set only contains the hardcoded defaults.
    const origins = allowedOrigins();
    assertEquals(origins.has(''), false);
  } finally {
    Deno.env.delete('GEO_SESSION_EXTRA_ORIGINS');
  }
});

Deno.test('corsHeaders echoes an allowed origin', () => {
  Deno.env.delete('GEO_SESSION_EXTRA_ORIGINS');
  const headers = corsHeaders(ALLOWED_ORIGIN);
  assertEquals(headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
  assertEquals(headers.Vary, 'Origin');
  assertStringIncludes(headers['Access-Control-Allow-Methods'], 'POST');
  assertStringIncludes(headers['Access-Control-Allow-Methods'], 'OPTIONS');
});

Deno.test('corsHeaders leaves allow-origin empty for disallowed origin', () => {
  const headers = corsHeaders(DISALLOWED_ORIGIN);
  assertEquals(headers['Access-Control-Allow-Origin'], '');
});

Deno.test('corsHeaders leaves allow-origin empty for null origin', () => {
  const headers = corsHeaders(null);
  assertEquals(headers['Access-Control-Allow-Origin'], '');
});

Deno.test('resolveGeo reads country and region from Cloudflare headers', () => {
  const req = makeRequest('POST', {
    headers: { 'cf-ipcountry': 'US', 'cf-region': 'California' },
  });
  assertEquals(resolveGeo(req), { countryCode: 'US', regionName: 'California' });
});

Deno.test("resolveGeo treats CF's XX and T1 sentinel country codes as null", () => {
  for (const sentinel of ['XX', 'T1']) {
    const req = makeRequest('POST', { headers: { 'cf-ipcountry': sentinel } });
    assertEquals(resolveGeo(req).countryCode, null);
  }
});

Deno.test('resolveGeo returns null country/region when CF headers are missing', () => {
  const req = makeRequest('POST');
  assertEquals(resolveGeo(req), { countryCode: null, regionName: null });
});

// ── handleRequest: error paths ─────────────────────────────────────────────

Deno.test('OPTIONS preflight returns 200 with CORS headers', async () => {
  const res = await handleRequest(makeRequest('OPTIONS', { origin: ALLOWED_ORIGIN }));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), 'ok');
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
});

Deno.test('OPTIONS from disallowed origin returns 200 with empty allow-origin', async () => {
  const res = await handleRequest(makeRequest('OPTIONS', { origin: DISALLOWED_ORIGIN }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), '');
});

Deno.test('GET returns 405 method not allowed', async () => {
  const res = await handleRequest(makeRequest('GET', { origin: ALLOWED_ORIGIN }));
  assertEquals(res.status, 405);
  assertEquals((await responseJson(res)).error, 'method not allowed');
});

Deno.test('POST from disallowed origin returns 403', async () => {
  const res = await handleRequest(
    makeRequest('POST', {
      origin: DISALLOWED_ORIGIN,
      body: { anonymous_id: 'x', app_name: 'catune' },
    }),
  );
  assertEquals(res.status, 403);
  assertEquals((await responseJson(res)).error, 'origin not allowed');
});

Deno.test('POST without origin header is accepted (server-to-server path)', async () => {
  const res = await handleRequest(
    makeRequest('POST', { body: { anonymous_id: 'x', app_name: 'catune' } }),
  );
  // Origin guard is skipped → validation runs, auth fails → 401
  assertEquals(res.status, 401);
});

Deno.test('POST missing anonymous_id returns 400', async () => {
  const res = await handleRequest(
    makeRequest('POST', { origin: ALLOWED_ORIGIN, body: { app_name: 'catune' } }),
  );
  assertEquals(res.status, 400);
  assertStringIncludes((await responseJson(res)).error as string, 'required');
});

Deno.test('POST missing app_name returns 400', async () => {
  const res = await handleRequest(
    makeRequest('POST', { origin: ALLOWED_ORIGIN, body: { anonymous_id: 'x' } }),
  );
  assertEquals(res.status, 400);
});

Deno.test('POST with valid body but no Authorization header returns 401', async () => {
  const res = await handleRequest(
    makeRequest('POST', {
      origin: ALLOWED_ORIGIN,
      body: { anonymous_id: 'abc', app_name: 'catune' },
    }),
  );
  assertEquals(res.status, 401);
  assertEquals((await responseJson(res)).error, 'authentication required');
});

Deno.test('POST with non-Bearer Authorization header returns 401', async () => {
  const res = await handleRequest(
    makeRequest('POST', {
      origin: ALLOWED_ORIGIN,
      headers: { authorization: 'Basic notbearer' },
      body: { anonymous_id: 'abc', app_name: 'catune' },
    }),
  );
  assertEquals(res.status, 401);
});
