// Client for data donation (apps/cala/docs/data-donation.md).
//
// Every write goes through the `donation` edge function
// (supabase/functions/donation), which holds the R2 keys and the service role:
// the browser never writes `cala_donations` and only ever sees presigned URLs.
// Reads of `cala_donations` go straight to the table; RLS returns the donor's
// own rows, or every row for an admin (migration 020).

import { getDonationSupabase } from './donation-auth.ts';

export type DonationStatus =
  'uploading' | 'uploaded' | 'approved' | 'rejected' | 'ingested' | 'withdrawn' | 'published';

export type DonationLicense = 'cc-by-4.0' | 'lab-use-only';
/** Public on DANDI, or CaLab only. */
export type DonationSharing = 'public' | 'lab';
export type SubjectSex = 'M' | 'F' | 'U' | 'O';

/** What the donor declares about the recording; also the row's columns. */
export interface DonationMeta {
  indicator: string;
  species: string;
  brain_region: string;
  scope: string;
  expression?: string | null;
  preparation?: string | null;
  behavior?: string | null;
  depth_um?: number | null;
  led_power?: string | null;
  fps: number;
  width: number;
  height: number;
  n_frames: number;
  bytes_per_pixel: 1 | 2;
  cala_version: string;
  dataset_hash?: string | null;
  rights_attested: boolean;
  protocol_attested: boolean;
  contact_ok: boolean;
  credit_name?: string | null;
  credit_lab?: string | null;
  notes?: string | null;
  sharing: DonationSharing;
  /** The donor's own label for the animal: letters, digits, dashes. */
  subject_id: string;
  subject_sex: SubjectSex;
  /** ISO 8601 duration, e.g. P90D. */
  subject_age: string;
  /** YYYY-MM-DD. */
  session_date: string;
  genotype?: string | null;
}

/** One object of a donation, with its exact size in bytes. */
export interface DonationFile {
  name: string;
  bytes: number;
}

export interface DonationRow extends DonationMeta {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  status: DonationStatus;
  declared_bytes: number;
  n_chunks: number;
  files: DonationFile[];
  in_benchmark: boolean;
  benchmark_note: string | null;
  review_note: string | null;
  license: DonationLicense;
  dandi_path: string | null;
  published_at: string | null;
}

/** A presigned request: send it exactly as given. */
export interface PresignedRequest {
  url: string;
  headers: Record<string, string>;
  expires_in: number;
}

// Caps, mirrored from the edge function so the UI can refuse early. The
// edge function is the authority; keep these in sync with
// supabase/functions/donation/index.ts.
export const DONATION_MAX_CHUNK_BYTES = 100 * 1024 * 1024;
export const DONATION_MAX_TIMESTAMPS_BYTES = 50 * 1024 * 1024;
export const DONATION_MAX_META_BYTES = 1024 * 1024;
export const DONATION_MAX_BYTES = 10 * 1024 ** 3;
export const DONATION_CHUNK_NAME = /^frames-\d{4}\.calaraw\.gz$/;

export class DonationApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'DonationApiError';
    this.status = status;
  }
}

async function requireClient() {
  const client = await getDonationSupabase();
  if (!client) throw new DonationApiError('Donation is not configured');
  return client;
}

/** Call one action of the `donation` edge function as the signed-in user. */
async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const client = await requireClient();
  const { data, error } = await client.functions.invoke('donation', {
    body: { action, ...body },
  });
  if (error) {
    // FunctionsHttpError carries the Response; the function answers {error}.
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      let message = error.message;
      try {
        const payload = (await context.json()) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {
        // not JSON: keep the SDK's message
      }
      throw new DonationApiError(message, context.status);
    }
    throw new DonationApiError(error.message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Donor
// ---------------------------------------------------------------------------

/** Register a donation; the edge function checks the caps. Returns its id. */
export async function createDonation(meta: DonationMeta, files: DonationFile[]): Promise<string> {
  const r = await call<{ donation_id: string }>('create', { meta, files });
  return r.donation_id;
}

/** A presigned PUT for one declared file of a donation that is still uploading. */
export function donationUploadUrl(donationId: string, name: string): Promise<PresignedRequest> {
  return call<PresignedRequest>('upload_url', { donation_id: donationId, name });
}

/**
 * PUT `bytes` to a presigned URL. `content-length` is signed into the URL but
 * is a forbidden header for `fetch`: the browser sends the body's real length
 * itself, which is what the signature checks, so it is left out here.
 */
export async function putPresigned(req: PresignedRequest, bytes: Uint8Array): Promise<void> {
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== 'content-length'),
  );
  if (bytes.byteLength !== Number(req.headers['content-length'] ?? bytes.byteLength)) {
    throw new DonationApiError(
      `file is ${bytes.byteLength} bytes, the upload URL was signed for ${req.headers['content-length']}`,
    );
  }
  const res = await fetch(req.url, {
    method: 'PUT',
    headers,
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  if (!res.ok) throw new DonationApiError(`upload failed (${res.status})`, res.status);
}

/** Ask the edge function to check the uploaded files; status becomes `uploaded`. */
export async function finishDonation(donationId: string): Promise<void> {
  await call('finish', { donation_id: donationId });
}

/** Withdraw a donation that is not yet ingested; its files are deleted. */
export async function withdrawDonation(donationId: string): Promise<void> {
  await call('withdraw', { donation_id: donationId });
}

/** The signed-in user's donations (RLS), newest first. Admins get every row. */
export async function listDonations(): Promise<DonationRow[]> {
  const client = await requireClient();
  const { data, error } = await client
    .from('cala_donations')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new DonationApiError(error.message);
  return (data as DonationRow[]) ?? [];
}

/** A published public donation as the public view shows it (no sign-in needed). */
export interface PublicDonation {
  id: string;
  published_at: string;
  indicator: string;
  species: string;
  brain_region: string;
  expression: string | null;
  preparation: string | null;
  behavior: string | null;
  scope: string;
  fps: number;
  width: number;
  height: number;
  n_frames: number;
  bytes_per_pixel: 1 | 2;
  depth_um: number | null;
  subject_sex: SubjectSex;
  subject_age: string;
  genotype: string | null;
  credit_name: string | null;
  credit_lab: string | null;
  dandi_path: string;
}

/** Published public donations (view cala_donations_public), newest first. */
export async function listPublicDonations(): Promise<PublicDonation[]> {
  const client = await requireClient();
  const { data, error } = await client
    .from('cala_donations_public')
    .select('*')
    .order('published_at', { ascending: false });
  if (error) throw new DonationApiError(error.message);
  return (data as PublicDonation[]) ?? [];
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** A presigned GET for one file of a donation (default: the first chunk). */
export function donationPreviewUrl(donationId: string, name?: string): Promise<PresignedRequest> {
  return call<PresignedRequest>('preview_url', { donation_id: donationId, name });
}

/** Approve (files move to `approved/`) or reject (files deleted) an uploaded donation. */
export async function reviewDonation(
  donationId: string,
  decision: 'approve' | 'reject',
  note?: string,
): Promise<void> {
  await call('review', { donation_id: donationId, decision, note: note ?? null });
}

/** Mark whether a donation is in the benchmark set (admin column grant, migration 020). */
export async function setDonationBenchmark(
  donationId: string,
  inBenchmark: boolean,
  note: string | null,
): Promise<void> {
  const client = await requireClient();
  const { error } = await client
    .from('cala_donations')
    .update({ in_benchmark: inBenchmark, benchmark_note: note })
    .eq('id', donationId);
  if (error) throw new DonationApiError(error.message);
}
