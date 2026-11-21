// Supabase Edge Function: donation
//
// Backend for raw data donations from browser cala
// (apps/cala/docs/data-donation.md). The only writer of `cala_donations`
// (migration 019, via the service role) and the only holder of the R2 keys:
// browsers and the lab server only ever see presigned URLs.
//
// POST JSON {action, ...}. Actions (client: packages/community/src/donation-service.ts):
//
//   donor (real, non-anonymous sign-in)
//     create       {meta, files}            -> {donation_id}
//     upload_url   {donation_id, name}      -> presigned PUT (content-length signed)
//     finish       {donation_id}            -> sizes + CALARAW1 headers checked, status uploaded
//     withdraw     {donation_id}            -> objects deleted, status withdrawn
//   admin (app_metadata.role = 'admin')
//     preview_url  {donation_id, name?}     -> presigned GET
//     review       {donation_id, decision, note} -> approve (move to approved/) or reject
//   lab ingest (x-ingest-token header, no user JWT)
//     ingest_list                           -> {donations: approved rows}
//     ingest_download_url {donation_id, name} -> presigned GET in approved/
//     ingest_done  {donation_id}            -> objects deleted, status ingested
//
// Objects: pending/<id>/<name> until approved, then approved/<id>/<name>.
//
// The handler is built from injected deps (createHandler) so tests run it
// against in-memory fakes; the Deno.serve wiring at the bottom plugs in
// supabase-js and an aws4fetch R2 client.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.103.3';
import { AwsClient } from 'npm:aws4fetch@1.0.20';

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

export type DonationStatus =
  | 'uploading'
  | 'uploaded'
  | 'approved'
  | 'rejected'
  | 'ingested'
  | 'withdrawn';

export interface DonationFile {
  name: string;
  bytes: number;
}

/** The donor-declared columns (DonationMeta in donation-service.ts). */
export interface DonationMeta {
  indicator: string;
  species: string;
  brain_region: string;
  scope: string;
  expression: string | null;
  preparation: string | null;
  behavior: string | null;
  depth_um: number | null;
  led_power: string | null;
  fps: number;
  width: number;
  height: number;
  n_frames: number;
  bytes_per_pixel: 1 | 2;
  cala_version: string;
  dataset_hash: string | null;
  license: 'cc-by-4.0' | 'lab-use-only';
  rights_attested: true;
  protocol_attested: true;
  contact_ok: boolean;
  credit_name: string | null;
  credit_lab: string | null;
  notes: string | null;
}

export interface NewDonation extends DonationMeta {
  user_id: string;
  status: DonationStatus;
  declared_bytes: number;
  n_chunks: number;
  files: DonationFile[];
}

export interface DonationRow extends NewDonation {
  id: string;
  created_at: string;
  updated_at: string;
  status: DonationStatus;
  in_benchmark: boolean;
  benchmark_note: string | null;
  review_note: string | null;
}

export interface PresignedRequest {
  url: string;
  headers: Record<string, string>;
  expires_in: number;
}

/** Statuses whose objects still occupy the bucket (count against the caps). */
export const OPEN_STATUSES: DonationStatus[] = ['uploading', 'uploaded', 'approved'];

// Keep in sync with packages/community/src/donation-service.ts.
export const DONATION_MAX_CHUNK_BYTES = 100 * 1024 * 1024;
export const DONATION_MAX_TIMESTAMPS_BYTES = 50 * 1024 * 1024;
export const DONATION_MAX_META_BYTES = 1024 * 1024;
export const DONATION_MAX_BYTES = 10 * 1024 ** 3;
export const DONATION_GLOBAL_CAP_BYTES = 200 * 1024 ** 3;
export const DONATION_MAX_OPEN_PER_USER = 2;
export const DONATION_STALE_HOURS = 48;
/** Stale uploads withdrawn per call (bounds the work of one request). */
const STALE_PER_CALL = 20;
export const DONATION_MAX_CHUNKS = 10000;

export const CHUNK_NAME = /^frames-(\d{4})\.calaraw\.gz$/;
export const TIMESTAMPS_NAME = 'timestamps.csv';
export const META_NAME = 'meta.json';
export const DEFAULT_PREVIEW_NAME = 'frames-0000.calaraw.gz';

export const PRESIGN_EXPIRES_S = 3600;
/** Compressed bytes fetched per chunk in `finish` to read its header. */
export const HEADER_RANGE_BYTES = 64 * 1024;
/** Largest request body accepted (a 10002-entry file list is ~400 kB). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Parallel object-store requests in finish / review / delete. */
const STORE_CONCURRENCY = 16;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DonationUser {
  id: string;
  isAnonymous: boolean;
  isAdmin: boolean;
}

export interface DonationDb {
  insert(row: NewDonation): Promise<string>;
  get(id: string): Promise<DonationRow | null>;
  /**
   * Update a row only while its status is one of `from`. Returns false when
   * no row matched (status changed concurrently, or no such row).
   */
  transition(
    id: string,
    from: DonationStatus[],
    patch: { status: DonationStatus; review_note?: string | null },
  ): Promise<boolean>;
  countOpenByUser(userId: string): Promise<number>;
  /** Sum of declared_bytes over OPEN_STATUSES. */
  openDeclaredBytes(): Promise<number>;
  listByStatus(status: DonationStatus): Promise<DonationRow[]>;
}

export interface ObjectStore {
  presign(
    method: 'GET' | 'PUT',
    key: string,
    opts: { expiresIn: number; contentLength?: number },
  ): Promise<PresignedRequest>;
  /** Size in bytes, or null when the object does not exist. */
  head(key: string): Promise<number | null>;
  /** Bytes [start, end] (inclusive), clipped to the object. */
  getRange(key: string, start: number, end: number): Promise<Uint8Array>;
  copy(srcKey: string, dstKey: string): Promise<void>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

export interface DonationEnv {
  extraOrigins: string[];
  ingestToken: string | null;
  maxBytes: number;
  globalCapBytes: number;
  maxOpenPerUser: number;
  /** An upload still `uploading` after this many hours is withdrawn (its files deleted). */
  staleUploadHours: number;
}

export interface DonationDeps {
  db: DonationDb;
  store: ObjectStore;
  env: DonationEnv;
  resolveUser(authHeader: string | null): Promise<DonationUser | null>;
  /** Current time, ms since the epoch (tests pin it). Default `Date.now`. */
  now?: () => number;
  /** Tell the lab a donation is ready for review (absent: no notification). */
  notify?: (row: DonationRow) => Promise<void>;
}

function positiveIntEnv(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Read the config from environment variables (see supabase/README.md). */
export function readEnv(get: (k: string) => string | undefined): DonationEnv {
  const token = get('INGEST_TOKEN')?.trim() ?? '';
  return {
    extraOrigins: (get('DONATION_EXTRA_ORIGINS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    // A short token is as good as none: ingest stays disabled.
    ingestToken: token.length >= 32 ? token : null,
    maxBytes: positiveIntEnv(get('DONATION_MAX_BYTES'), DONATION_MAX_BYTES),
    globalCapBytes: positiveIntEnv(get('DONATION_GLOBAL_CAP_BYTES'), DONATION_GLOBAL_CAP_BYTES),
    maxOpenPerUser: positiveIntEnv(get('DONATION_MAX_OPEN_PER_USER'), DONATION_MAX_OPEN_PER_USER),
    staleUploadHours: positiveIntEnv(get('DONATION_STALE_HOURS'), DONATION_STALE_HOURS),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_ORIGINS = [
  'https://miniscope.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export function allowedOrigins(env: DonationEnv): Set<string> {
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...env.extraOrigins]);
}

export function corsHeaders(origin: string | null, env: DonationEnv): Record<string, string> {
  const allow = origin && allowedOrigins(env).has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-ingest-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

/** An error the handler turns into `{error}` with this HTTP status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

// ---------------------------------------------------------------------------
// Validation: meta and files
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

const isObject = (v: unknown): v is Body =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function requiredText(m: Body, key: string, max: number): string {
  const v = m[key];
  if (typeof v !== 'string' || v.trim().length === 0) fail(400, `meta.${key} is required`);
  if ((v as string).length > max) fail(400, `meta.${key} is longer than ${max} characters`);
  return v as string;
}

function optionalText(m: Body, key: string, max: number): string | null {
  const v = m[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') fail(400, `meta.${key} must be text`);
  if ((v as string).length > max) fail(400, `meta.${key} is longer than ${max} characters`);
  return v as string;
}

function intInRange(m: Body, key: string, min: number, max: number): number {
  const v = m[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    fail(400, `meta.${key} must be an integer in ${min}..${max}`);
  }
  return v as number;
}

const META_KEYS = new Set([
  'indicator',
  'species',
  'brain_region',
  'scope',
  'expression',
  'preparation',
  'behavior',
  'depth_um',
  'led_power',
  'fps',
  'width',
  'height',
  'n_frames',
  'bytes_per_pixel',
  'cala_version',
  'dataset_hash',
  'license',
  'rights_attested',
  'protocol_attested',
  'contact_ok',
  'credit_name',
  'credit_lab',
  'notes',
]);

/** Validate the donor's metadata against the 019 column constraints. */
export function validateMeta(raw: unknown): DonationMeta {
  if (!isObject(raw)) fail(400, 'meta must be an object');
  const m = raw as Body;
  for (const key of Object.keys(m)) {
    if (!META_KEYS.has(key)) fail(400, `meta.${key} is not a known field`);
  }

  let depth: number | null = null;
  if (m.depth_um !== undefined && m.depth_um !== null) {
    if (
      typeof m.depth_um !== 'number' ||
      !Number.isFinite(m.depth_um) ||
      m.depth_um < 0 ||
      m.depth_um > 10000
    ) {
      fail(400, 'meta.depth_um must be a number in 0..10000');
    }
    depth = m.depth_um as number;
  }
  if (typeof m.fps !== 'number' || !Number.isFinite(m.fps) || m.fps <= 0 || m.fps > 1000) {
    fail(400, 'meta.fps must be a number in (0, 1000]');
  }
  if (m.bytes_per_pixel !== 1 && m.bytes_per_pixel !== 2) {
    fail(400, 'meta.bytes_per_pixel must be 1 or 2');
  }
  if (m.license !== 'cc-by-4.0' && m.license !== 'lab-use-only') {
    fail(400, "meta.license must be 'cc-by-4.0' or 'lab-use-only'");
  }
  if (m.rights_attested !== true) fail(400, 'meta.rights_attested must be true');
  if (m.protocol_attested !== true) fail(400, 'meta.protocol_attested must be true');
  if (typeof m.contact_ok !== 'boolean') fail(400, 'meta.contact_ok must be true or false');

  return {
    indicator: requiredText(m, 'indicator', 128),
    species: requiredText(m, 'species', 128),
    brain_region: requiredText(m, 'brain_region', 128),
    scope: requiredText(m, 'scope', 128),
    expression: optionalText(m, 'expression', 128),
    preparation: optionalText(m, 'preparation', 128),
    behavior: optionalText(m, 'behavior', 256),
    depth_um: depth,
    led_power: optionalText(m, 'led_power', 64),
    fps: m.fps as number,
    width: intInRange(m, 'width', 1, 16384),
    height: intInRange(m, 'height', 1, 16384),
    n_frames: intInRange(m, 'n_frames', 1, 2147483647),
    bytes_per_pixel: m.bytes_per_pixel as 1 | 2,
    cala_version: requiredText(m, 'cala_version', 64),
    dataset_hash: optionalText(m, 'dataset_hash', 128),
    license: m.license as DonationMeta['license'],
    rights_attested: true,
    protocol_attested: true,
    contact_ok: m.contact_ok as boolean,
    credit_name: requiredText(m, 'credit_name', 100),
    credit_lab: requiredText(m, 'credit_lab', 100),
    notes: optionalText(m, 'notes', 1000),
  };
}

const formatBytes = (n: number): string =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GiB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MiB`
      : `${n} B`;

export const chunkName = (i: number): string => `frames-${String(i).padStart(4, '0')}.calaraw.gz`;

/**
 * Validate the declared file list: chunks frames-0000..frames-(n-1) without
 * gaps, optional timestamps.csv and meta.json, nothing else, exact sizes
 * within the per-file caps. Returns the list (in a canonical order), the
 * chunk count and the total size.
 */
export function validateFiles(
  raw: unknown,
  maxBytes: number,
): { files: DonationFile[]; nChunks: number; total: number } {
  if (!Array.isArray(raw) || raw.length === 0) fail(400, 'files must be a non-empty list');
  const list = raw as unknown[];
  if (list.length > DONATION_MAX_CHUNKS + 2) fail(413, 'too many files');

  const seen = new Map<string, number>();
  const chunkIdx = new Set<number>();
  for (const f of list) {
    if (!isObject(f)) fail(400, 'each file must be {name, bytes}');
    const file = f as Body;
    for (const key of Object.keys(file)) {
      if (key !== 'name' && key !== 'bytes') fail(400, `file field ${key} is not allowed`);
    }
    const { name, bytes } = file;
    if (typeof name !== 'string') fail(400, 'file name must be text');
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) {
      fail(400, `file ${name} must declare a positive integer size`);
    }
    if (seen.has(name as string)) fail(400, `file ${name} is listed twice`);

    const m = CHUNK_NAME.exec(name as string);
    let cap: number;
    if (m) {
      chunkIdx.add(Number(m[1]));
      cap = DONATION_MAX_CHUNK_BYTES;
    } else if (name === TIMESTAMPS_NAME) {
      cap = DONATION_MAX_TIMESTAMPS_BYTES;
    } else if (name === META_NAME) {
      cap = DONATION_MAX_META_BYTES;
    } else {
      cap = fail(400, `file name ${JSON.stringify(name)} is not allowed`);
    }
    if ((bytes as number) > cap) {
      fail(
        413,
        `file ${name} is ${formatBytes(bytes as number)}, above its ${formatBytes(cap)} cap`,
      );
    }
    seen.set(name as string, bytes as number);
  }

  const nChunks = chunkIdx.size;
  if (nChunks === 0) fail(400, 'a donation needs at least one frames-0000.calaraw.gz chunk');
  for (let i = 0; i < nChunks; i++) {
    if (!chunkIdx.has(i))
      fail(400, `chunk ${chunkName(i)} is missing (chunks must be contiguous from 0000)`);
  }

  const files: DonationFile[] = [];
  for (let i = 0; i < nChunks; i++)
    files.push({ name: chunkName(i), bytes: seen.get(chunkName(i))! });
  for (const extra of [TIMESTAMPS_NAME, META_NAME]) {
    if (seen.has(extra)) files.push({ name: extra, bytes: seen.get(extra)! });
  }
  const total = files.reduce((s, f) => s + f.bytes, 0);
  if (total > maxBytes) {
    fail(
      413,
      `donation is ${formatBytes(total)}, above the ${formatBytes(maxBytes)} per-donation cap`,
    );
  }
  return { files, nChunks, total };
}

// ---------------------------------------------------------------------------
// CALARAW1 header (byte layout: packages/io/src/calaraw.ts; re-implemented
// here so the edge function has no workspace imports)
// ---------------------------------------------------------------------------

export const CALARAW_MAGIC = 'CALARAW1';
export const CALARAW_HEADER_BYTES = 40;

export interface CalarawHeader {
  width: number;
  height: number;
  firstFrame: number;
  frames: number;
  totalFrames: number;
  bytesPerPixel: number;
  predictor: number;
  fps: number;
}

/** Parse and bounds-check a chunk header; throws Error with a reason. */
export function parseCalarawHeader(b: Uint8Array): CalarawHeader {
  if (b.length < CALARAW_HEADER_BYTES) throw new Error('truncated CALARAW1 header');
  for (let i = 0; i < 8; i++) {
    if (b[i] !== CALARAW_MAGIC.charCodeAt(i)) throw new Error('not a CALARAW1 chunk');
  }
  const v = new DataView(b.buffer, b.byteOffset, CALARAW_HEADER_BYTES);
  if (v.getUint16(30, true) !== 0) throw new Error('reserved header bytes are not 0');
  const h: CalarawHeader = {
    width: v.getUint32(8, true),
    height: v.getUint32(12, true),
    firstFrame: v.getUint32(16, true),
    frames: v.getUint32(20, true),
    totalFrames: v.getUint32(24, true),
    bytesPerPixel: v.getUint8(28),
    predictor: v.getUint8(29),
    fps: v.getFloat64(32, true),
  };
  if (h.width < 1 || h.width > 16384 || h.height < 1 || h.height > 16384) {
    throw new Error(`frame size ${h.width}x${h.height} out of range`);
  }
  if (h.bytesPerPixel !== 1 && h.bytesPerPixel !== 2) {
    throw new Error(`bytes per pixel ${h.bytesPerPixel} is not 1 or 2`);
  }
  if (h.predictor !== 0 && h.predictor !== 1) throw new Error(`unknown predictor ${h.predictor}`);
  if (!Number.isFinite(h.fps) || h.fps <= 0) throw new Error(`fps ${h.fps} is not positive`);
  if (h.frames < 1 || h.totalFrames < 1 || h.firstFrame + h.frames > h.totalFrames) {
    throw new Error(`chunk frames ${h.firstFrame}+${h.frames} do not fit ${h.totalFrames}`);
  }
  return h;
}

/** Input fed to the decompressor per step: bounds the work before we stop. */
const GUNZIP_SLICE = 512;

/**
 * Decompress just enough of a (possibly truncated) gzip stream to get
 * `want` bytes. Input goes in small slices and decompression stops as soon
 * as `want` bytes are out, so a highly compressible chunk is never inflated
 * in full (CPU time on the edge runtime is limited).
 */
export async function gunzipPrefix(gz: Uint8Array, want: number): Promise<Uint8Array> {
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) throw new Error('not a gzip file');
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;

  const reading = (async () => {
    try {
      while (got < want) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
      }
    } catch {
      // corrupt or truncated input: judged by `got` below
    } finally {
      // Stops the decompressor; pending writes reject (caught below).
      await reader.cancel().catch(() => {});
    }
  })();

  try {
    for (let off = 0; off < gz.length && got < want; off += GUNZIP_SLICE) {
      await writer.write(gz.slice(off, off + GUNZIP_SLICE));
    }
    // End of input: the readable ends (or errors, if truncated) so `reading` finishes.
    await writer.close();
  } catch {
    // cancelled after enough output, or corrupt input
  }
  await reading;

  if (got < want) throw new Error('could not decompress the CALARAW1 header');
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.subarray(0, want);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Run `fn` over `items` with at most `limit` in flight; rejects on the first error. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Constant-time string equality (compares SHA-256 digests, so length leaks nothing). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const pendingKey = (id: string, name: string): string => `pending/${id}/${name}`;
export const approvedKey = (id: string, name: string): string => `approved/${id}/${name}`;

function donationId(body: Body): string {
  const id = body.donation_id;
  if (typeof id !== 'string' || !UUID.test(id)) fail(400, 'donation_id must be a UUID');
  return (id as string).toLowerCase();
}

function declaredFile(row: DonationRow, name: unknown): DonationFile {
  if (typeof name !== 'string') fail(400, 'name must be text');
  const file = row.files.find((f) => f.name === name);
  if (!file) fail(404, `${name} is not a declared file of this donation`);
  return file!;
}

// ---------------------------------------------------------------------------
// finish: the uploaded objects match what was declared
// ---------------------------------------------------------------------------

/** Check sizes and chunk headers; throws HttpError(422) on the first mismatch. */
export async function verifyUpload(row: DonationRow, store: ObjectStore): Promise<void> {
  const sizes = await mapLimit(row.files, STORE_CONCURRENCY, (f) =>
    store.head(pendingKey(row.id, f.name)),
  );
  row.files.forEach((f, i) => {
    if (sizes[i] === null) fail(422, `${f.name} has not been uploaded`);
    if (sizes[i] !== f.bytes) fail(422, `${f.name} is ${sizes[i]} bytes, declared ${f.bytes}`);
  });

  const chunks = row.files.filter((f) => CHUNK_NAME.test(f.name));
  const headers = await mapLimit(chunks, STORE_CONCURRENCY, async (f) => {
    const head = await store.getRange(pendingKey(row.id, f.name), 0, HEADER_RANGE_BYTES - 1);
    try {
      return parseCalarawHeader(await gunzipPrefix(head, CALARAW_HEADER_BYTES));
    } catch (err) {
      return fail(422, `${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  let nextFrame = 0;
  headers.forEach((h, i) => {
    const name = chunks[i].name;
    if (h.width !== row.width || h.height !== row.height) {
      fail(422, `${name} is ${h.width}x${h.height}, declared ${row.width}x${row.height}`);
    }
    if (h.bytesPerPixel !== row.bytes_per_pixel) {
      fail(422, `${name} has ${h.bytesPerPixel} bytes per pixel, declared ${row.bytes_per_pixel}`);
    }
    if (h.totalFrames !== row.n_frames) {
      fail(422, `${name} says the recording has ${h.totalFrames} frames, declared ${row.n_frames}`);
    }
    if (Math.abs(h.fps - row.fps) > 1e-6 * Math.max(1, row.fps)) {
      fail(422, `${name} is at ${h.fps} fps, declared ${row.fps}`);
    }
    if (h.firstFrame !== nextFrame) {
      fail(422, `${name} starts at frame ${h.firstFrame}, expected ${nextFrame}`);
    }
    nextFrame += h.frames;
  });
  if (nextFrame !== row.n_frames) {
    fail(422, `the chunks hold ${nextFrame} frames, declared ${row.n_frames}`);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const DONOR_ACTIONS = new Set(['create', 'upload_url', 'finish', 'withdraw']);
const ADMIN_ACTIONS = new Set(['preview_url', 'review']);
const INGEST_ACTIONS = new Set(['ingest_list', 'ingest_download_url', 'ingest_done']);

export function createHandler(deps: DonationDeps): (req: Request) => Promise<Response> {
  const { db, store, env } = deps;
  const now = deps.now ?? Date.now;

  const deleteObjects = (keys: string[]) =>
    mapLimit(keys, STORE_CONCURRENCY, (k) => store.delete(k));
  const keysOf = (row: DonationRow, key: (id: string, name: string) => string) =>
    row.files.map((f) => key(row.id, f.name));

  async function loadOwned(body: Body, user: DonationUser): Promise<DonationRow> {
    const row = await db.get(donationId(body));
    // Someone else's donation looks exactly like a missing one.
    if (!row || row.user_id !== user.id) return fail(404, 'donation not found');
    return row;
  }

  async function load(body: Body): Promise<DonationRow> {
    const row = await db.get(donationId(body));
    if (!row) return fail(404, 'donation not found');
    return row;
  }

  function requireStatus(row: DonationRow, allowed: DonationStatus[]): void {
    if (!allowed.includes(row.status)) {
      fail(409, `donation is ${row.status}; this needs ${allowed.join(' or ')}`);
    }
  }

  async function transitionOrConflict(
    row: DonationRow,
    from: DonationStatus[],
    patch: { status: DonationStatus; review_note?: string | null },
  ): Promise<void> {
    if (!(await db.transition(row.id, from, patch))) {
      fail(409, 'donation status changed meanwhile; reload and try again');
    }
  }

  /**
   * Withdraw uploads that never finished (tab closed, upload abandoned), so
   * they stop holding the donor's open slot and the global cap. Runs on each
   * `create` and `ingest_list` (the lab's hourly cron); a few rows per call.
   */
  async function expireStaleUploads(): Promise<void> {
    const before = new Date(now() - env.staleUploadHours * 3_600_000).toISOString();
    const stale = (await db.listByStatus('uploading'))
      .filter((r) => r.created_at < before)
      .slice(0, STALE_PER_CALL);
    for (const row of stale) {
      const note = `upload not finished within ${env.staleUploadHours} h`;
      if (await db.transition(row.id, ['uploading'], { status: 'withdrawn', review_note: note })) {
        await deleteObjects(keysOf(row, pendingKey));
      }
    }
  }

  // ── donor ────────────────────────────────────────────────────────────────

  async function create(body: Body, user: DonationUser): Promise<Body> {
    const meta = validateMeta(body.meta);
    const { files, nChunks, total } = validateFiles(body.files, env.maxBytes);
    await expireStaleUploads();

    // Caps. Concurrent creates can overshoot by a request or two: these are
    // abuse and cost bounds, not exact quotas.
    const open = await db.countOpenByUser(user.id);
    if (open >= env.maxOpenPerUser) {
      fail(
        429,
        `you already have ${open} donation(s) in progress; at most ${env.maxOpenPerUser} may wait for review or ingest at a time`,
      );
    }
    const used = await db.openDeclaredBytes();
    if (used + total > env.globalCapBytes) {
      fail(507, 'donation storage is full right now; please try again in a few days');
    }

    const id = await db.insert({
      ...meta,
      user_id: user.id,
      status: 'uploading',
      declared_bytes: total,
      n_chunks: nChunks,
      files,
    });
    return { donation_id: id };
  }

  async function uploadUrl(body: Body, user: DonationUser): Promise<Body> {
    const row = await loadOwned(body, user);
    requireStatus(row, ['uploading']);
    const file = declaredFile(row, body.name);
    const signed = await store.presign('PUT', pendingKey(row.id, file.name), {
      expiresIn: PRESIGN_EXPIRES_S,
      contentLength: file.bytes,
    });
    return { ...signed };
  }

  async function finish(body: Body, user: DonationUser): Promise<Body> {
    const row = await loadOwned(body, user);
    if (row.status === 'uploaded') return { status: 'uploaded' }; // idempotent retry
    requireStatus(row, ['uploading']);
    await verifyUpload(row, store);
    await transitionOrConflict(row, ['uploading'], { status: 'uploaded' });
    // Best effort: a failed notification never fails the donation.
    if (deps.notify) {
      await deps
        .notify({ ...row, status: 'uploaded' })
        .catch((e) => console.error('donation notify failed:', e instanceof Error ? e.message : e));
    }
    return { status: 'uploaded' };
  }

  async function withdraw(body: Body, user: DonationUser): Promise<Body> {
    const row = await loadOwned(body, user);
    requireStatus(row, OPEN_STATUSES);
    // Status first, so no presign / review / ingest acts on it meanwhile.
    await transitionOrConflict(row, OPEN_STATUSES, { status: 'withdrawn' });
    await deleteObjects([...keysOf(row, pendingKey), ...keysOf(row, approvedKey)]);
    return { status: 'withdrawn' };
  }

  // ── admin ────────────────────────────────────────────────────────────────

  async function previewUrl(body: Body): Promise<Body> {
    const row = await load(body);
    requireStatus(row, ['uploaded', 'approved']);
    const file = declaredFile(row, body.name ?? DEFAULT_PREVIEW_NAME);
    const key = row.status === 'approved' ? approvedKey : pendingKey;
    return {
      ...(await store.presign('GET', key(row.id, file.name), { expiresIn: PRESIGN_EXPIRES_S })),
    };
  }

  async function review(body: Body): Promise<Body> {
    const row = await load(body);
    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      fail(400, "decision must be 'approve' or 'reject'");
    }
    const note =
      body.note === undefined || body.note === null || body.note === '' ? null : body.note;
    if (note !== null && (typeof note !== 'string' || note.length > 500)) {
      fail(400, 'note must be text of at most 500 characters');
    }
    requireStatus(row, ['uploaded']);

    if (decision === 'reject') {
      await transitionOrConflict(row, ['uploaded'], {
        status: 'rejected',
        review_note: note as string | null,
      });
      await deleteObjects(keysOf(row, pendingKey));
      return { status: 'rejected' };
    }

    // Copy first (status still uploaded); only then flip the status, so a
    // failed copy leaves a reviewable donation. If the donor withdrew in the
    // meantime, the copies are removed again.
    await mapLimit(row.files, STORE_CONCURRENCY, (f) =>
      store.copy(pendingKey(row.id, f.name), approvedKey(row.id, f.name)),
    );
    if (
      !(await db.transition(row.id, ['uploaded'], {
        status: 'approved',
        review_note: note as string | null,
      }))
    ) {
      await deleteObjects(keysOf(row, approvedKey));
      fail(409, 'donation status changed meanwhile; reload and try again');
    }
    await deleteObjects(keysOf(row, pendingKey));
    return { status: 'approved' };
  }

  // ── lab ingest ───────────────────────────────────────────────────────────

  async function ingest(action: string, body: Body): Promise<Body> {
    if (action === 'ingest_list') {
      await expireStaleUploads();
      return { donations: await db.listByStatus('approved') };
    }
    const row = await load(body);
    requireStatus(row, ['approved']);
    if (action === 'ingest_download_url') {
      const file = declaredFile(row, body.name);
      return {
        ...(await store.presign('GET', approvedKey(row.id, file.name), {
          expiresIn: PRESIGN_EXPIRES_S,
        })),
      };
    }
    // ingest_done: delete first so a failed delete can simply be retried.
    await deleteObjects(keysOf(row, approvedKey));
    await transitionOrConflict(row, ['approved'], { status: 'ingested' });
    return { status: 'ingested' };
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  async function dispatch(req: Request): Promise<Body> {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) fail(413, 'request body too large');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      fail(400, 'body must be JSON');
    }
    if (!isObject(body)) return fail(400, 'body must be a JSON object');
    const action = body.action;
    if (typeof action !== 'string') return fail(400, 'action is required');

    if (INGEST_ACTIONS.has(action)) {
      const token = req.headers.get('x-ingest-token');
      if (!env.ingestToken) fail(503, 'ingest is not configured');
      if (!token || !(await timingSafeEqual(token, env.ingestToken!))) {
        fail(401, 'invalid ingest token');
      }
      return await ingest(action, body);
    }
    if (!DONOR_ACTIONS.has(action) && !ADMIN_ACTIONS.has(action)) {
      fail(400, `unknown action ${JSON.stringify(action)}`);
    }

    const user = await deps.resolveUser(req.headers.get('authorization'));
    if (!user) fail(401, 'sign in to donate data');
    if (user!.isAnonymous) fail(403, 'sign in with your email to donate data');

    if (ADMIN_ACTIONS.has(action)) {
      if (!user!.isAdmin) fail(403, 'admin only');
      return action === 'review' ? await review(body) : await previewUrl(body);
    }
    switch (action) {
      case 'create':
        return await create(body, user!);
      case 'upload_url':
        return await uploadUrl(body, user!);
      case 'finish':
        return await finish(body, user!);
      default:
        return await withdraw(body, user!);
    }
  }

  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get('origin');
    const json = (payload: Body, status: number) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { ...corsHeaders(origin, env), 'Content-Type': 'application/json' },
      });

    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin, env) });
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (origin && !allowedOrigins(env).has(origin))
      return json({ error: 'origin not allowed' }, 403);

    try {
      return json(await dispatch(req), 200);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('donation:', err);
      return json({ error: 'internal error' }, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Production deps: Supabase (service role) and Cloudflare R2 (S3 API)
// ---------------------------------------------------------------------------

export function supabaseDb(client: SupabaseClient): DonationDb {
  const table = () => client.from('cala_donations');
  const check = <T>(r: { data: T; error: { message: string } | null }): T => {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  };
  return {
    async insert(row) {
      return (check(await table().insert(row).select('id').single()) as { id: string }).id;
    },
    async get(id) {
      return check(await table().select('*').eq('id', id).maybeSingle()) as DonationRow | null;
    },
    async transition(id, from, patch) {
      const rows = check(await table().update(patch).eq('id', id).in('status', from).select('id'));
      return (rows?.length ?? 0) > 0;
    },
    async countOpenByUser(userId) {
      const r = await table()
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .in('status', OPEN_STATUSES);
      if (r.error) throw new Error(r.error.message);
      return r.count ?? 0;
    },
    async openDeclaredBytes() {
      return Number(check(await client.rpc('cala_donations_open_bytes')) ?? 0);
    },
    async listByStatus(status) {
      return check(
        await table().select('*').eq('status', status).order('created_at', { ascending: true }),
      ) as DonationRow[];
    },
  };
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * The 32-hex Cloudflare account ID out of whatever was pasted: the bare ID,
 * or the bucket's S3 API URL (`https://<id>.r2.cloudflarestorage.com/...`).
 */
export function r2AccountId(raw: string): string {
  const m = raw.trim().match(/(?:^|\/\/)([0-9a-f]{32})(?:$|\.r2\.cloudflarestorage\.com)/i);
  if (!m) throw new Error('R2_ACCOUNT_ID must be the 32-character Cloudflare account ID');
  return m[1].toLowerCase();
}

/** Cloudflare R2 through its S3 API, signed with aws4fetch (SigV4). */
export function r2Store(cfg: R2Config, fetchFn: typeof fetch = fetch): ObjectStore {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const base = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
  const url = (key: string) => `${base}/${key}`;
  const send = async (u: string, init: RequestInit): Promise<Response> =>
    await fetchFn(await aws.sign(u, init));
  const expectOk = async (res: Response, what: string) => {
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`R2 ${what} failed (${res.status})`);
    }
  };

  return {
    async presign(method, key, { expiresIn, contentLength }) {
      const u = new URL(url(key));
      u.searchParams.set('X-Amz-Expires', String(expiresIn));
      const headers: Record<string, string> = {};
      if (contentLength !== undefined) headers['content-length'] = String(contentLength);
      // signQuery: credentials in the URL; allHeaders: aws4fetch otherwise
      // drops content-length from the signature.
      const signed = await aws.sign(u.toString(), {
        method,
        headers,
        aws: { signQuery: true, allHeaders: true },
      });
      return { url: signed.url, headers, expires_in: expiresIn };
    },
    async head(key) {
      const res = await send(url(key), { method: 'HEAD' });
      if (res.status === 404) return null;
      await expectOk(res, `HEAD ${key}`);
      const len = res.headers.get('content-length');
      if (len === null) throw new Error(`R2 HEAD ${key}: no content-length`);
      return Number(len);
    },
    async getRange(key, start, end) {
      const res = await send(url(key), {
        method: 'GET',
        headers: { range: `bytes=${start}-${end}` },
      });
      await expectOk(res, `GET ${key}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // A server that ignores Range answers 200 with everything: clip.
      return bytes.subarray(0, end - start + 1);
    },
    async copy(srcKey, dstKey) {
      const res = await send(url(dstKey), {
        method: 'PUT',
        headers: { 'x-amz-copy-source': `/${cfg.bucket}/${srcKey}` },
      });
      await expectOk(res, `copy ${srcKey}`);
      // CopyObject can answer 200 with an <Error> body.
      const text = await res.text();
      if (text.includes('<Error>'))
        throw new Error(`R2 copy ${srcKey} failed: ${text.slice(0, 200)}`);
    },
    async delete(key) {
      const res = await send(url(key), { method: 'DELETE' });
      if (res.status === 404) {
        await res.body?.cancel();
        return;
      }
      await expectOk(res, `DELETE ${key}`);
      await res.body?.cancel();
    },
  };
}

/** Verify the bearer token with Supabase Auth (never trust the JWT body alone). */
export function supabaseResolveUser(client: SupabaseClient) {
  return async (authHeader: string | null): Promise<DonationUser | null> => {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    try {
      const { data, error } = await client.auth.getUser(authHeader.slice('Bearer '.length));
      if (error || !data.user) return null;
      return {
        id: data.user.id,
        isAnonymous: data.user.is_anonymous ?? false,
        isAdmin: data.user.app_metadata?.role === 'admin',
      };
    } catch {
      return null;
    }
  };
}

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// ---------------------------------------------------------------------------
// Notification email (Resend)
// ---------------------------------------------------------------------------

export interface NotifyConfig {
  apiKey: string;
  to: string[];
  from: string;
  /** Link to the admin app's Donations view (optional). */
  adminUrl: string | null;
}

/** Read the notification config; null (no emails) unless a key and recipients are set. */
export function readNotifyConfig(get: (k: string) => string | undefined): NotifyConfig | null {
  const apiKey = get('RESEND_API_KEY')?.trim() ?? '';
  const to = (get('DONATION_NOTIFY_EMAILS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
  if (!apiKey || to.length === 0) return null;
  return {
    apiKey,
    to,
    from: get('DONATION_NOTIFY_FROM')?.trim() || 'CaLab donations <onboarding@resend.dev>',
    adminUrl: get('DONATION_ADMIN_URL')?.trim() || null,
  };
}

/** The email's subject and text for a donation ready for review. No donor email address. */
export function notificationText(row: DonationRow, adminUrl: string | null) {
  const mb = (row.declared_bytes / 1e6).toFixed(0);
  const minutes = (row.n_frames / row.fps / 60).toFixed(1);
  const subject = `New cala donation: ${row.indicator}, ${row.brain_region} (${mb} MB)`;
  const lines = [
    'A new recording was donated and is waiting for review.',
    '',
    `Credit:     ${row.credit_name ?? '-'}, ${row.credit_lab ?? '-'}`,
    `Indicator:  ${row.indicator}`,
    `Species:    ${row.species}`,
    `Region:     ${row.brain_region}`,
    `Scope:      ${row.scope}`,
    `Recording:  ${row.width} x ${row.height}, ${row.n_frames} frames at ${row.fps} Hz (${minutes} min)`,
    `Size:       ${mb} MB in ${row.n_chunks} chunks`,
    `Contact OK: ${row.contact_ok ? 'yes' : 'no'}`,
    `Donation:   ${row.id}`,
  ];
  if (row.notes) lines.push('', `Notes: ${row.notes}`);
  if (adminUrl) lines.push('', `Review: ${adminUrl}`);
  return { subject, text: lines.join('\n') };
}

/** Send the notification through the Resend API. */
export function resendNotifier(
  cfg: NotifyConfig,
  fetchFn: typeof fetch = fetch,
): (row: DonationRow) => Promise<void> {
  return async (row) => {
    const { subject, text } = notificationText(row, cfg.adminUrl);
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: cfg.to, subject, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await res.body?.cancel().catch(() => {});
  };
}

if (import.meta.main) {
  const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const handler = createHandler({
    db: supabaseDb(supabase),
    store: r2Store({
      accountId: r2AccountId(requireEnv('R2_ACCOUNT_ID')),
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
      bucket: requireEnv('R2_BUCKET'),
    }),
    env: readEnv((k) => Deno.env.get(k)),
    resolveUser: supabaseResolveUser(supabase),
    notify: (() => {
      const cfg = readNotifyConfig((k) => Deno.env.get(k));
      return cfg ? resendNotifier(cfg) : undefined;
    })(),
  });
  Deno.serve(handler);
}
