/**
 * Deno tests for the donation edge function.
 *
 * The handler runs against in-memory fakes of the database and the object
 * store (createHandler deps); the R2 client is checked against a recording
 * fetch. RLS on cala_donations is covered by supabase/tests/rls/.
 *
 * Run with: deno test --allow-env --allow-net index.test.ts
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  CALARAW_HEADER_BYTES,
  createHandler,
  type DonationDb,
  type DonationEnv,
  type DonationFile,
  type DonationRow,
  type DonationStatus,
  type DonationUser,
  gunzipPrefix,
  type NewDonation,
  type ObjectStore,
  OPEN_STATUSES,
  parseCalarawHeader,
  r2Store,
  readEnv,
  timingSafeEqual,
} from './index.ts';

// ── fakes ──────────────────────────────────────────────────────────────────

class FakeDb implements DonationDb {
  rows = new Map<string, DonationRow>();
  private seq = 0;

  insert(row: NewDonation): Promise<string> {
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString();
    this.rows.set(id, {
      ...row,
      id,
      created_at: now,
      updated_at: now,
      in_benchmark: false,
      benchmark_note: null,
      review_note: null,
    });
    return Promise.resolve(id);
  }
  get(id: string): Promise<DonationRow | null> {
    const r = this.rows.get(id);
    return Promise.resolve(r ? structuredClone(r) : null);
  }
  transition(
    id: string,
    from: DonationStatus[],
    patch: { status: DonationStatus; review_note?: string | null },
  ): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || !from.includes(r.status)) return Promise.resolve(false);
    Object.assign(r, patch);
    return Promise.resolve(true);
  }
  countOpenByUser(userId: string): Promise<number> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (r) => r.user_id === userId && OPEN_STATUSES.includes(r.status),
      ).length,
    );
  }
  openDeclaredBytes(): Promise<number> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => OPEN_STATUSES.includes(r.status))
        .reduce((s, r) => s + r.declared_bytes, 0),
    );
  }
  listByStatus(status: DonationStatus): Promise<DonationRow[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.status === status));
  }
}

class FakeStore implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  presigned: { method: string; key: string; contentLength?: number }[] = [];

  presign(method: 'GET' | 'PUT', key: string, opts: { expiresIn: number; contentLength?: number }) {
    this.presigned.push({ method, key, contentLength: opts.contentLength });
    const headers: Record<string, string> = {};
    if (opts.contentLength !== undefined) headers['content-length'] = String(opts.contentLength);
    return Promise.resolve({
      url: `https://r2.test/${key}?X-Amz-Signature=fake`,
      headers,
      expires_in: opts.expiresIn,
    });
  }
  head(key: string) {
    return Promise.resolve(this.objects.get(key)?.length ?? null);
  }
  getRange(key: string, start: number, end: number) {
    const o = this.objects.get(key);
    if (!o) return Promise.reject(new Error('no such key'));
    return Promise.resolve(o.slice(start, end + 1));
  }
  copy(src: string, dst: string) {
    const o = this.objects.get(src);
    if (!o) return Promise.reject(new Error('no such key'));
    this.objects.set(dst, o.slice());
    return Promise.resolve();
  }
  delete(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

const ALICE: DonationUser = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  isAnonymous: false,
  isAdmin: false,
};
const BOB: DonationUser = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  isAnonymous: false,
  isAdmin: false,
};
const ADMIN: DonationUser = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  isAnonymous: false,
  isAdmin: true,
};
const GUEST: DonationUser = {
  id: 'dddddddd-0000-4000-8000-000000000004',
  isAnonymous: true,
  isAdmin: false,
};
const USERS: Record<string, DonationUser> = { alice: ALICE, bob: BOB, admin: ADMIN, guest: GUEST };

const INGEST_TOKEN = 'i'.repeat(40);
const ALLOWED_ORIGIN = 'http://localhost:5173';

function setup(envOverrides: Partial<DonationEnv> = {}) {
  const db = new FakeDb();
  const store = new FakeStore();
  const env: DonationEnv = {
    ...readEnv((k) => (k === 'INGEST_TOKEN' ? INGEST_TOKEN : undefined)),
    ...envOverrides,
  };
  const handler = createHandler({
    db,
    store,
    env,
    // "Bearer <name>" stands in for a verified Supabase session.
    resolveUser: (auth) =>
      Promise.resolve(auth ? (USERS[auth.replace('Bearer ', '')] ?? null) : null),
  });
  return { db, store, handler };
}

type Handler = (req: Request) => Promise<Response>;

function request(
  body: unknown,
  opts: {
    as?: string;
    origin?: string | null;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(opts.headers ?? {});
  if (opts.as) headers.set('authorization', `Bearer ${opts.as}`);
  if (opts.origin) headers.set('origin', opts.origin);
  return new Request('https://edge.local/donation', {
    method: opts.method ?? 'POST',
    headers,
    body: opts.method === 'OPTIONS' || opts.method === 'GET' ? null : JSON.stringify(body),
  });
}

async function call(
  handler: Handler,
  body: unknown,
  opts: Parameters<typeof request>[1] = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handler(request(body, opts));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ── CALARAW1 fixtures ──────────────────────────────────────────────────────

interface ChunkSpec {
  width: number;
  height: number;
  firstFrame: number;
  frames: number;
  totalFrames: number;
  bytesPerPixel: number;
  fps: number;
}

function calarawHeader(h: ChunkSpec): Uint8Array {
  const b = new Uint8Array(CALARAW_HEADER_BYTES);
  const v = new DataView(b.buffer);
  for (let i = 0; i < 8; i++) b[i] = 'CALARAW1'.charCodeAt(i);
  v.setUint32(8, h.width, true);
  v.setUint32(12, h.height, true);
  v.setUint32(16, h.firstFrame, true);
  v.setUint32(20, h.frames, true);
  v.setUint32(24, h.totalFrames, true);
  v.setUint8(28, h.bytesPerPixel);
  v.setUint8(29, 1);
  v.setFloat64(32, h.fps, true);
  return b;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A gzip CALARAW1 chunk with noisy frames (so it does not compress to nothing). */
async function chunk(h: ChunkSpec, seed = 1): Promise<Uint8Array> {
  const payload = new Uint8Array(h.width * h.height * h.bytesPerPixel * h.frames);
  let x = seed | 0 || 1;
  for (let i = 0; i < payload.length; i++) {
    // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    payload[i] = x & 0xff;
  }
  const raw = new Uint8Array(CALARAW_HEADER_BYTES + payload.length);
  raw.set(calarawHeader(h));
  raw.set(payload, CALARAW_HEADER_BYTES);
  return await gzip(raw);
}

const META = {
  indicator: 'GCaMP6f',
  species: 'mouse',
  brain_region: 'CA1',
  scope: 'UCLA v4',
  expression: 'AAV1-Syn-GCaMP6f',
  preparation: 'GRIN',
  behavior: 'open field',
  depth_um: 1200,
  led_power: '30%',
  fps: 20,
  width: 64,
  height: 48,
  n_frames: 30,
  bytes_per_pixel: 1,
  cala_version: '2.19.1',
  dataset_hash: 'abc123',
  license: 'cc-by-4.0',
  rights_attested: true,
  protocol_attested: true,
  contact_ok: true,
  credit_name: 'A. Donor',
  credit_lab: 'Some Lab',
  notes: null,
};

/** Two chunks (20 + 10 frames) matching META, plus a timestamps file. */
async function recording(): Promise<{ files: DonationFile[]; data: Record<string, Uint8Array> }> {
  const base = { width: 64, height: 48, totalFrames: 30, bytesPerPixel: 1, fps: 20 };
  const data: Record<string, Uint8Array> = {
    'frames-0000.calaraw.gz': await chunk({ ...base, firstFrame: 0, frames: 20 }, 1),
    'frames-0001.calaraw.gz': await chunk({ ...base, firstFrame: 20, frames: 10 }, 2),
    'timestamps.csv': new TextEncoder().encode('frame,t\n0,0.0\n'),
  };
  return { files: Object.entries(data).map(([name, b]) => ({ name, bytes: b.length })), data };
}

/** Create a donation as alice and "upload" its objects into the fake store. */
async function createAndUpload(env: ReturnType<typeof setup>) {
  const rec = await recording();
  const r = await call(
    env.handler,
    { action: 'create', meta: META, files: rec.files },
    { as: 'alice' },
  );
  assertEquals(r.status, 200, JSON.stringify(r.json));
  const id = r.json.donation_id as string;
  for (const [name, bytes] of Object.entries(rec.data))
    env.store.objects.set(`pending/${id}/${name}`, bytes);
  return { id, rec };
}

// ── HTTP surface ───────────────────────────────────────────────────────────

Deno.test('OPTIONS answers CORS for an allowed origin, incl. x-ingest-token', async () => {
  const { handler } = setup();
  const res = await handler(request(null, { method: 'OPTIONS', origin: ALLOWED_ORIGIN }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assertStringIncludes(res.headers.get('access-control-allow-headers') ?? '', 'x-ingest-token');
  await res.body?.cancel();
});

Deno.test('non-POST is 405, disallowed origin is 403 with no ACAO', async () => {
  const { handler } = setup();
  const get = await handler(request(null, { method: 'GET' }));
  assertEquals(get.status, 405);
  await get.body?.cancel();
  const evil = await handler(
    request({ action: 'create' }, { origin: 'http://evil.example.com', as: 'alice' }),
  );
  assertEquals(evil.status, 403);
  assertEquals(evil.headers.get('access-control-allow-origin'), '');
  await evil.body?.cancel();
});

Deno.test('DONATION_EXTRA_ORIGINS adds allowed origins', async () => {
  const { handler } = setup({ extraOrigins: ['https://preview.example.com'] });
  const res = await handler(
    request(null, { method: 'OPTIONS', origin: 'https://preview.example.com' }),
  );
  assertEquals(res.headers.get('access-control-allow-origin'), 'https://preview.example.com');
  await res.body?.cancel();
});

Deno.test('bad JSON, missing and unknown actions are 400', async () => {
  const { handler } = setup();
  const bad = await handler(
    new Request('https://edge.local/donation', { method: 'POST', body: '{not json' }),
  );
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  assertEquals((await call(handler, {}, { as: 'alice' })).status, 400);
  assertEquals((await call(handler, { action: 'nope' }, { as: 'alice' })).status, 400);
});

Deno.test('no session is 401, anonymous session is 403', async () => {
  const { handler, db } = setup();
  const rec = await recording();
  const body = { action: 'create', meta: META, files: rec.files };
  assertEquals((await call(handler, body)).status, 401);
  const guest = await call(handler, body, { as: 'guest' });
  assertEquals(guest.status, 403);
  assertStringIncludes(guest.json.error as string, 'email');
  assertEquals(db.rows.size, 0);
});

// ── create ─────────────────────────────────────────────────────────────────

Deno.test('create stores the row with canonical files, totals and status uploading', async () => {
  const env = setup();
  const rec = await recording();
  const r = await call(
    env.handler,
    { action: 'create', meta: META, files: [...rec.files].reverse() },
    {
      as: 'alice',
      origin: ALLOWED_ORIGIN,
    },
  );
  assertEquals(r.status, 200);
  const row = env.db.rows.get(r.json.donation_id as string)!;
  assertEquals(row.user_id, ALICE.id);
  assertEquals(row.status, 'uploading');
  assertEquals(row.n_chunks, 2);
  assertEquals(
    row.declared_bytes,
    rec.files.reduce((s, f) => s + f.bytes, 0),
  );
  assertEquals(
    row.files.map((f) => f.name),
    ['frames-0000.calaraw.gz', 'frames-0001.calaraw.gz', 'timestamps.csv'],
  );
  assertEquals(row.indicator, 'GCaMP6f');
  assertEquals(row.notes, null);
});

Deno.test('create rejects bad metadata', async () => {
  const { handler } = setup();
  const files = [{ name: 'frames-0000.calaraw.gz', bytes: 100 }];
  const cases: [Record<string, unknown>, string][] = [
    [{ ...META, evil: 1 }, 'not a known field'],
    [{ ...META, indicator: '' }, 'indicator'],
    [{ ...META, species: 'x'.repeat(129) }, 'species'],
    [{ ...META, fps: 0 }, 'fps'],
    [{ ...META, fps: 1001 }, 'fps'],
    [{ ...META, width: 1.5 }, 'width'],
    [{ ...META, height: 16385 }, 'height'],
    [{ ...META, n_frames: 0 }, 'n_frames'],
    [{ ...META, bytes_per_pixel: 3 }, 'bytes_per_pixel'],
    [{ ...META, depth_um: -1 }, 'depth_um'],
    [{ ...META, license: 'mit' }, 'license'],
    [{ ...META, rights_attested: false }, 'rights_attested'],
    [{ ...META, protocol_attested: 'yes' }, 'protocol_attested'],
    [{ ...META, contact_ok: undefined }, 'contact_ok'],
    [{ ...META, notes: 'x'.repeat(1001) }, 'notes'],
    [{ ...META, credit_name: 'x'.repeat(101) }, 'credit_name'],
  ];
  for (const [meta, needle] of cases) {
    const r = await call(handler, { action: 'create', meta, files }, { as: 'alice' });
    assertEquals(r.status, 400, needle);
    assertStringIncludes(r.json.error as string, needle);
  }
  assertEquals(
    (await call(handler, { action: 'create', meta: null, files }, { as: 'alice' })).status,
    400,
  );
});

Deno.test('create rejects bad file lists', async () => {
  const { handler } = setup();
  const c = (name: string, bytes = 100) => ({ name, bytes });
  const cases: [unknown, number, string][] = [
    [[], 400, 'non-empty'],
    [[c('timestamps.csv')], 400, 'at least one'],
    [[c('frames-0001.calaraw.gz')], 400, 'frames-0000'],
    [[c('frames-0000.calaraw.gz'), c('frames-0002.calaraw.gz')], 400, 'frames-0001'],
    [[c('frames-0000.calaraw.gz'), c('frames-0000.calaraw.gz')], 400, 'twice'],
    [[c('frames-0000.calaraw.gz'), c('../etc/passwd')], 400, 'not allowed'],
    [[c('frames-0000.calaraw.gz'), c('movie.avi')], 400, 'not allowed'],
    [[c('frames-00000.calaraw.gz')], 400, 'not allowed'],
    [[c('frames-0000.calaraw.gz', 0)], 400, 'positive'],
    [[c('frames-0000.calaraw.gz', 1.5)], 400, 'positive'],
    [[{ name: 'frames-0000.calaraw.gz', bytes: 1, extra: true }], 400, 'not allowed'],
    [[c('frames-0000.calaraw.gz', 100 * 1024 * 1024 + 1)], 413, 'cap'],
    [[c('frames-0000.calaraw.gz'), c('timestamps.csv', 50 * 1024 * 1024 + 1)], 413, 'cap'],
    [[c('frames-0000.calaraw.gz'), c('meta.json', 1024 * 1024 + 1)], 413, 'cap'],
  ];
  for (const [files, status, needle] of cases) {
    const r = await call(handler, { action: 'create', meta: META, files }, { as: 'alice' });
    assertEquals(r.status, status, `${JSON.stringify(files).slice(0, 80)} -> ${r.json.error}`);
    assertStringIncludes(r.json.error as string, needle);
  }
});

Deno.test('create enforces the per-donation total cap', async () => {
  const { handler } = setup({ maxBytes: 250 });
  const files = [0, 1, 2].map((i) => ({ name: `frames-000${i}.calaraw.gz`, bytes: 100 }));
  const r = await call(handler, { action: 'create', meta: META, files }, { as: 'alice' });
  assertEquals(r.status, 413);
  assertStringIncludes(r.json.error as string, 'per-donation cap');
});

Deno.test('create enforces the per-user open-donation limit', async () => {
  const env = setup();
  const files = [{ name: 'frames-0000.calaraw.gz', bytes: 100 }];
  const body = { action: 'create', meta: META, files };
  assertEquals((await call(env.handler, body, { as: 'alice' })).status, 200);
  const second = await call(env.handler, body, { as: 'alice' });
  assertEquals(second.status, 200);
  const third = await call(env.handler, body, { as: 'alice' });
  assertEquals(third.status, 429);
  assertStringIncludes(third.json.error as string, 'at most 2');
  // Bob is unaffected; a finished (ingested) donation frees a slot.
  assertEquals((await call(env.handler, body, { as: 'bob' })).status, 200);
  env.db.rows.get(second.json.donation_id as string)!.status = 'ingested';
  assertEquals((await call(env.handler, body, { as: 'alice' })).status, 200);
});

Deno.test('create enforces the global bucket cap', async () => {
  const env = setup({ globalCapBytes: 1000 });
  const mk = (bytes: number) => ({
    action: 'create',
    meta: META,
    files: [{ name: 'frames-0000.calaraw.gz', bytes }],
  });
  assertEquals((await call(env.handler, mk(600), { as: 'alice' })).status, 200);
  const full = await call(env.handler, mk(401), { as: 'bob' });
  assertEquals(full.status, 507);
  assertStringIncludes(full.json.error as string, 'storage is full');
  assertEquals((await call(env.handler, mk(400), { as: 'bob' })).status, 200);
});

// ── upload_url ─────────────────────────────────────────────────────────────

Deno.test('upload_url presigns a PUT with the declared content-length, owner only', async () => {
  const env = setup();
  const rec = await recording();
  const id = (
    await call(env.handler, { action: 'create', meta: META, files: rec.files }, { as: 'alice' })
  ).json.donation_id as string;

  const ok = await call(
    env.handler,
    { action: 'upload_url', donation_id: id, name: 'frames-0001.calaraw.gz' },
    {
      as: 'alice',
    },
  );
  assertEquals(ok.status, 200);
  assertEquals(ok.json.expires_in, 3600);
  assertEquals(
    (ok.json.headers as Record<string, string>)['content-length'],
    String(rec.files[1].bytes),
  );
  assertEquals(env.store.presigned.at(-1), {
    method: 'PUT',
    key: `pending/${id}/frames-0001.calaraw.gz`,
    contentLength: rec.files[1].bytes,
  });

  // Not declared, someone else's, malformed id, unknown id.
  const undeclared = await call(
    env.handler,
    { action: 'upload_url', donation_id: id, name: 'meta.json' },
    {
      as: 'alice',
    },
  );
  assertEquals(undeclared.status, 404);
  const bob = await call(
    env.handler,
    { action: 'upload_url', donation_id: id, name: 'timestamps.csv' },
    {
      as: 'bob',
    },
  );
  assertEquals(bob.status, 404);
  assertEquals(
    (
      await call(
        env.handler,
        { action: 'upload_url', donation_id: 'x', name: 'a' },
        { as: 'alice' },
      )
    ).status,
    400,
  );
  assertEquals(
    (
      await call(
        env.handler,
        {
          action: 'upload_url',
          donation_id: '00000000-0000-4000-8000-999999999999',
          name: 'timestamps.csv',
        },
        { as: 'alice' },
      )
    ).status,
    404,
  );

  // Only while uploading.
  env.db.rows.get(id)!.status = 'uploaded';
  const late = await call(
    env.handler,
    { action: 'upload_url', donation_id: id, name: 'timestamps.csv' },
    {
      as: 'alice',
    },
  );
  assertEquals(late.status, 409);
});

// ── finish ─────────────────────────────────────────────────────────────────

Deno.test('finish checks sizes and CALARAW1 headers, then marks uploaded', async () => {
  const env = setup();
  const { id } = await createAndUpload(env);
  const r = await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
  assertEquals(r.status, 200, JSON.stringify(r.json));
  assertEquals(env.db.rows.get(id)!.status, 'uploaded');
  // Retry is harmless.
  assertEquals(
    (await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' })).status,
    200,
  );
  // Not bob's.
  assertEquals(
    (await call(env.handler, { action: 'finish', donation_id: id }, { as: 'bob' })).status,
    404,
  );
});

Deno.test('finish: a missing or wrong-size object is 422 and leaves status uploading', async () => {
  const env = setup();
  const { id } = await createAndUpload(env);
  env.store.objects.delete(`pending/${id}/timestamps.csv`);
  let r = await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
  assertEquals(r.status, 422);
  assertStringIncludes(r.json.error as string, 'timestamps.csv has not been uploaded');

  env.store.objects.set(`pending/${id}/timestamps.csv`, new Uint8Array(3));
  r = await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
  assertEquals(r.status, 422);
  assertStringIncludes(r.json.error as string, 'declared');
  assertEquals(env.db.rows.get(id)!.status, 'uploading');
});

Deno.test('finish: header mismatches are 422', async () => {
  const base = { width: 64, height: 48, totalFrames: 30, bytesPerPixel: 1, fps: 20 };
  const cases: [Partial<ChunkSpec>, string][] = [
    [{ width: 65 }, '65x48'],
    [{ bytesPerPixel: 2 }, 'bytes per pixel'],
    [{ totalFrames: 31 }, '31 frames'],
    [{ fps: 30 }, 'fps'],
    [{ firstFrame: 19 }, 'expected 20'],
    [{ frames: 9 }, 'hold 29 frames'],
  ];
  for (const [change, needle] of cases) {
    const env = setup();
    const { id } = await createAndUpload(env);
    // Replace chunk 1 (frames 20..29) by a variant, keeping the declared size honest.
    const bad = await chunk({ ...base, firstFrame: 20, frames: 10, ...change }, 2);
    env.store.objects.set(`pending/${id}/frames-0001.calaraw.gz`, bad);
    env.db.rows.get(id)!.files[1].bytes = bad.length;
    const r = await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
    assertEquals(r.status, 422, `${JSON.stringify(change)} -> ${r.json.error}`);
    assertStringIncludes(r.json.error as string, needle);
    assertEquals(env.db.rows.get(id)!.status, 'uploading');
  }
});

Deno.test('finish: non-gzip and non-CALARAW1 chunks are 422', async () => {
  for (const [bytes, needle] of [
    [new TextEncoder().encode('just some text that is not gzip at all'), 'not a gzip file'],
    [await gzip(new TextEncoder().encode('NOTCALAR'.repeat(10))), 'not a CALARAW1 chunk'],
    [await gzip(new Uint8Array(10)), 'could not decompress'],
  ] as const) {
    const env = setup();
    const { id } = await createAndUpload(env);
    env.store.objects.set(`pending/${id}/frames-0000.calaraw.gz`, bytes);
    env.db.rows.get(id)!.files[0].bytes = bytes.length;
    const r = await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
    assertEquals(r.status, 422);
    assertStringIncludes(r.json.error as string, needle);
  }
});

Deno.test('gunzipPrefix reads a header from a truncated range of a large chunk', async () => {
  // ~1.5 MB of noise: the 64 KiB range is a truncated gzip stream.
  const big = await chunk({
    width: 512,
    height: 512,
    firstFrame: 0,
    frames: 6,
    totalFrames: 6,
    bytesPerPixel: 1,
    fps: 20,
  });
  assert(big.length > 128 * 1024);
  const h = parseCalarawHeader(await gunzipPrefix(big.subarray(0, 64 * 1024), 40));
  assertEquals([h.width, h.height, h.frames], [512, 512, 6]);
  // Highly compressible payload: still stops after the header.
  const zeros = new Uint8Array(40 + 16 * 1024 * 1024);
  zeros.set(
    calarawHeader({
      width: 4096,
      height: 4096,
      firstFrame: 0,
      frames: 1,
      totalFrames: 1,
      bytesPerPixel: 1,
      fps: 5,
    }),
  );
  const z = await gzip(zeros);
  const hz = parseCalarawHeader(await gunzipPrefix(z.subarray(0, 64 * 1024), 40));
  assertEquals(hz.width, 4096);
  await assertRejects(() => gunzipPrefix(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]), 40));
});

// ── withdraw ───────────────────────────────────────────────────────────────

Deno.test(
  'withdraw deletes objects and marks withdrawn; owner only; not after ingest',
  async () => {
    const env = setup();
    const { id } = await createAndUpload(env);
    assertEquals(
      (await call(env.handler, { action: 'withdraw', donation_id: id }, { as: 'bob' })).status,
      404,
    );
    assertEquals(
      (await call(env.handler, { action: 'withdraw', donation_id: id }, { as: 'admin' })).status,
      404,
    );
    const r = await call(env.handler, { action: 'withdraw', donation_id: id }, { as: 'alice' });
    assertEquals(r.status, 200);
    assertEquals(env.db.rows.get(id)!.status, 'withdrawn');
    assertEquals(env.store.keys(), []);
    assertEquals(
      (await call(env.handler, { action: 'withdraw', donation_id: id }, { as: 'alice' })).status,
      409,
    );

    const other = await createAndUpload(env);
    env.db.rows.get(other.id)!.status = 'ingested';
    assertEquals(
      (await call(env.handler, { action: 'withdraw', donation_id: other.id }, { as: 'alice' }))
        .status,
      409,
    );
  },
);

Deno.test('withdraw of an approved donation deletes approved/ objects', async () => {
  const env = setup();
  const { id } = await createAndUpload(env);
  await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
  await call(
    env.handler,
    { action: 'review', donation_id: id, decision: 'approve', note: null },
    { as: 'admin' },
  );
  assert(env.store.keys().every((k) => k.startsWith('approved/')));
  assertEquals(
    (await call(env.handler, { action: 'withdraw', donation_id: id }, { as: 'alice' })).status,
    200,
  );
  assertEquals(env.store.keys(), []);
});

// ── admin ──────────────────────────────────────────────────────────────────

Deno.test('preview_url and review are admin only', async () => {
  const env = setup();
  const { id } = await createAndUpload(env);
  await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
  for (const body of [
    { action: 'preview_url', donation_id: id },
    { action: 'review', donation_id: id, decision: 'approve', note: null },
  ]) {
    assertEquals((await call(env.handler, body, { as: 'alice' })).status, 403);
    assertEquals((await call(env.handler, body)).status, 401);
  }
  assertEquals(env.db.rows.get(id)!.status, 'uploaded');
});

Deno.test('preview_url presigns a GET in the current prefix, default first chunk', async () => {
  const env = setup();
  const { id } = await createAndUpload(env);
  // Not previewable while still uploading.
  assertEquals(
    (await call(env.handler, { action: 'preview_url', donation_id: id }, { as: 'admin' })).status,
    409,
  );
  await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });

  const r = await call(env.handler, { action: 'preview_url', donation_id: id }, { as: 'admin' });
  assertEquals(r.status, 200);
  assertEquals(env.store.presigned.at(-1), {
    method: 'GET',
    key: `pending/${id}/frames-0000.calaraw.gz`,
    contentLength: undefined,
  });
  await call(
    env.handler,
    { action: 'preview_url', donation_id: id, name: 'timestamps.csv' },
    { as: 'admin' },
  );
  assertEquals(env.store.presigned.at(-1)!.key, `pending/${id}/timestamps.csv`);
  assertEquals(
    (
      await call(
        env.handler,
        { action: 'preview_url', donation_id: id, name: 'meta.json' },
        { as: 'admin' },
      )
    ).status,
    404,
  );

  await call(
    env.handler,
    { action: 'review', donation_id: id, decision: 'approve', note: 'ok' },
    { as: 'admin' },
  );
  await call(env.handler, { action: 'preview_url', donation_id: id }, { as: 'admin' });
  assertEquals(env.store.presigned.at(-1)!.key, `approved/${id}/frames-0000.calaraw.gz`);
});

Deno.test('review approve moves objects to approved/ and stores the note', async () => {
  const env = setup();
  const { id, rec } = await createAndUpload(env);
  // Only uploaded donations can be reviewed.
  assertEquals(
    (
      await call(
        env.handler,
        { action: 'review', donation_id: id, decision: 'approve' },
        { as: 'admin' },
      )
    ).status,
    409,
  );
  await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
  const r = await call(
    env.handler,
    { action: 'review', donation_id: id, decision: 'approve', note: 'nice' },
    {
      as: 'admin',
    },
  );
  assertEquals(r.status, 200);
  const row = env.db.rows.get(id)!;
  assertEquals(row.status, 'approved');
  assertEquals(row.review_note, 'nice');
  assertEquals(env.store.keys(), rec.files.map((f) => `approved/${id}/${f.name}`).sort());
  assertEquals(
    env.store.objects.get(`approved/${id}/frames-0000.calaraw.gz`),
    rec.data['frames-0000.calaraw.gz'],
  );
});

Deno.test('review reject deletes objects; bad decision or note is 400', async () => {
  const env = setup();
  const { id } = await createAndUpload(env);
  await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
  assertEquals(
    (
      await call(
        env.handler,
        { action: 'review', donation_id: id, decision: 'maybe' },
        { as: 'admin' },
      )
    ).status,
    400,
  );
  assertEquals(
    (
      await call(
        env.handler,
        { action: 'review', donation_id: id, decision: 'reject', note: 'x'.repeat(501) },
        {
          as: 'admin',
        },
      )
    ).status,
    400,
  );
  const r = await call(
    env.handler,
    { action: 'review', donation_id: id, decision: 'reject', note: 'not imaging' },
    {
      as: 'admin',
    },
  );
  assertEquals(r.status, 200);
  assertEquals(env.db.rows.get(id)!.status, 'rejected');
  assertEquals(env.db.rows.get(id)!.review_note, 'not imaging');
  assertEquals(env.store.keys(), []);
});

// ── lab ingest ─────────────────────────────────────────────────────────────

async function approved(env: ReturnType<typeof setup>) {
  const { id, rec } = await createAndUpload(env);
  await call(env.handler, { action: 'finish', donation_id: id }, { as: 'alice' });
  await call(
    env.handler,
    { action: 'review', donation_id: id, decision: 'approve' },
    { as: 'admin' },
  );
  return { id, rec };
}

const ingestAs = (token: string) => ({ headers: { 'x-ingest-token': token } });

Deno.test('ingest actions need the right token; a user session is not enough', async () => {
  const env = setup();
  await approved(env);
  assertEquals((await call(env.handler, { action: 'ingest_list' })).status, 401);
  assertEquals((await call(env.handler, { action: 'ingest_list' }, { as: 'admin' })).status, 401);
  assertEquals(
    (await call(env.handler, { action: 'ingest_list' }, ingestAs('i'.repeat(39) + 'x'))).status,
    401,
  );
  assertEquals((await call(env.handler, { action: 'ingest_list' }, ingestAs('short'))).status, 401);
  // The ingest token does not unlock donor/admin actions.
  assertEquals(
    (await call(env.handler, { action: 'preview_url', donation_id: 'x' }, ingestAs(INGEST_TOKEN)))
      .status,
    401,
  );
});

Deno.test('ingest is disabled when INGEST_TOKEN is unset or too short', async () => {
  for (const token of [undefined, 'too-short']) {
    const env = setup({
      ingestToken: readEnv((k) => (k === 'INGEST_TOKEN' ? token : undefined)).ingestToken,
    });
    const r = await call(env.handler, { action: 'ingest_list' }, ingestAs(token ?? ''));
    assertEquals(r.status, 503);
  }
});

Deno.test('ingest_list, ingest_download_url, ingest_done', async () => {
  const env = setup();
  const { id, rec } = await approved(env);
  await createAndUpload(env); // a second, still uploading: not listed

  const list = await call(env.handler, { action: 'ingest_list' }, ingestAs(INGEST_TOKEN));
  assertEquals(list.status, 200);
  const rows = list.json.donations as DonationRow[];
  assertEquals(
    rows.map((r) => r.id),
    [id],
  );
  assertEquals(rows[0].files.length, rec.files.length);

  const dl = await call(
    env.handler,
    { action: 'ingest_download_url', donation_id: id, name: 'frames-0001.calaraw.gz' },
    ingestAs(INGEST_TOKEN),
  );
  assertEquals(dl.status, 200);
  assertEquals(env.store.presigned.at(-1)!.key, `approved/${id}/frames-0001.calaraw.gz`);
  assertEquals(
    (
      await call(
        env.handler,
        { action: 'ingest_download_url', donation_id: id, name: 'x.bin' },
        ingestAs(INGEST_TOKEN),
      )
    ).status,
    404,
  );

  const done = await call(
    env.handler,
    { action: 'ingest_done', donation_id: id },
    ingestAs(INGEST_TOKEN),
  );
  assertEquals(done.status, 200);
  assertEquals(env.db.rows.get(id)!.status, 'ingested');
  assert(env.store.keys().every((k) => !k.includes(id)));
  assertEquals(
    (await call(env.handler, { action: 'ingest_done', donation_id: id }, ingestAs(INGEST_TOKEN)))
      .status,
    409,
  );
});

// ── helpers ────────────────────────────────────────────────────────────────

Deno.test('timingSafeEqual', async () => {
  assertEquals(await timingSafeEqual('abc', 'abc'), true);
  assertEquals(await timingSafeEqual('abc', 'abd'), false);
  assertEquals(await timingSafeEqual('abc', 'abcd'), false);
});

Deno.test('readEnv parses caps and origins, ignoring junk', () => {
  const env = readEnv(
    (k) =>
      ({
        DONATION_MAX_BYTES: '1000',
        DONATION_GLOBAL_CAP_BYTES: 'lots',
        DONATION_MAX_OPEN_PER_USER: '5',
        DONATION_EXTRA_ORIGINS: ' https://a.example , ,https://b.example',
      })[k],
  );
  assertEquals(env.maxBytes, 1000);
  assertEquals(env.globalCapBytes, 200 * 1024 ** 3);
  assertEquals(env.maxOpenPerUser, 5);
  assertEquals(env.extraOrigins, ['https://a.example', 'https://b.example']);
  assertEquals(env.ingestToken, null);
});

// ── R2 client ──────────────────────────────────────────────────────────────

const R2 = {
  accountId: 'acct',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  bucket: 'donations',
};

Deno.test('r2Store.presign: SigV4 query signature that covers content-length', async () => {
  const store = r2Store(R2, () => Promise.reject(new Error('presign must not fetch')));
  const put = await store.presign('PUT', 'pending/x/frames-0000.calaraw.gz', {
    expiresIn: 3600,
    contentLength: 1234,
  });
  const u = new URL(put.url);
  assertEquals(u.origin, 'https://acct.r2.cloudflarestorage.com');
  assertEquals(u.pathname, '/donations/pending/x/frames-0000.calaraw.gz');
  assertMatch(u.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
  assertEquals(u.searchParams.get('X-Amz-Expires'), '3600');
  assertEquals(u.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host');
  assertStringIncludes(u.searchParams.get('X-Amz-Credential') ?? '', '/auto/s3/aws4_request');
  assertEquals(put.headers, { 'content-length': '1234' });
  assertEquals(put.expires_in, 3600);

  // A different length gives a different signature.
  const other = await store.presign('PUT', 'pending/x/frames-0000.calaraw.gz', {
    expiresIn: 3600,
    contentLength: 1235,
  });
  assert(
    new URL(other.url).searchParams.get('X-Amz-Signature') !==
      u.searchParams.get('X-Amz-Signature'),
  );

  const get = new URL(
    (await store.presign('GET', 'approved/x/meta.json', { expiresIn: 3600 })).url,
  );
  assertEquals(get.searchParams.get('X-Amz-SignedHeaders'), 'host');
});

Deno.test('r2Store requests: head, range, copy, delete', async () => {
  const seen: Request[] = [];
  const fakeFetch = (input: RequestInfo | URL): Promise<Response> => {
    const req = input as Request;
    seen.push(req);
    if (req.method === 'HEAD') {
      return Promise.resolve(
        req.url.endsWith('/missing')
          ? new Response(null, { status: 404 })
          : new Response(null, { status: 200, headers: { 'content-length': '42' } }),
      );
    }
    if (req.method === 'GET')
      return Promise.resolve(new Response(new Uint8Array(100), { status: 200 }));
    if (req.method === 'PUT')
      return Promise.resolve(new Response('<CopyObjectResult/>', { status: 200 }));
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  const store = r2Store(R2, fakeFetch as typeof fetch);
  assertEquals(await store.head('pending/x/a'), 42);
  assertEquals(await store.head('missing'), null);
  assertEquals((await store.getRange('pending/x/a', 0, 9)).length, 10);
  assertEquals(seen.at(-1)!.headers.get('range'), 'bytes=0-9');
  await store.copy('pending/x/a', 'approved/x/a');
  const copy = seen.at(-1)!;
  assertEquals(copy.method, 'PUT');
  assertEquals(copy.url, 'https://acct.r2.cloudflarestorage.com/donations/approved/x/a');
  assertEquals(copy.headers.get('x-amz-copy-source'), '/donations/pending/x/a');
  assertStringIncludes(copy.headers.get('authorization') ?? '', 'x-amz-copy-source');
  await store.delete('pending/x/a');
  assertEquals(seen.at(-1)!.method, 'DELETE');
  assert(
    seen.every((r) => r.method === 'HEAD' || r.method === 'GET' || r.headers.has('authorization')),
  );
});

Deno.test('r2Store.copy surfaces an <Error> body on 200', async () => {
  const store = r2Store(R2, (() =>
    Promise.resolve(
      new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 200 }),
    )) as typeof fetch);
  await assertRejects(() => store.copy('a', 'b'), Error, 'NoSuchKey');
});
