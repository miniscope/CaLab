// Pure helpers for the Donations view (apps/cala/docs/data-donation.md, phase 4):
// table filters and formatting, and the preview's mean image and contrast stretch.

import type { DonationRow, DonationStatus, PresignedRequest } from '@calab/community';
import { decodeCalarawChunk } from '@calab/io';

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export type StatusFilter = DonationStatus | 'all';

/** Statuses in lifecycle order, for the filter and the counts. */
export const DONATION_STATUSES: readonly DonationStatus[] = [
  'uploading',
  'uploaded',
  'approved',
  'rejected',
  'ingested',
  'withdrawn',
];

export function filterDonations(rows: readonly DonationRow[], status: StatusFilter): DonationRow[] {
  return status === 'all' ? [...rows] : rows.filter((r) => r.status === status);
}

export function countByStatus(rows: readonly DonationRow[]): Record<DonationStatus, number> {
  const counts = Object.fromEntries(DONATION_STATUSES.map((s) => [s, 0])) as Record<
    DonationStatus,
    number
  >;
  for (const r of rows) if (r.status in counts) counts[r.status] += 1;
  return counts;
}

/** Bytes in binary units with one decimal above KB ("1.5 GB"). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${units[u]}`;
}

/** Recording length from frames and fps ("12 min 30 s"). */
export function formatDuration(nFrames: number, fps: number): string {
  if (!(fps > 0) || !(nFrames >= 0)) return '-';
  const s = Math.round(nFrames / fps);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

export function formatCredit(r: Pick<DonationRow, 'credit_name' | 'credit_lab'>): string {
  return [r.credit_name, r.credit_lab].filter((x) => x && x.trim()).join(', ');
}

/** Only an uploaded donation can be approved or rejected (the edge function enforces it too). */
export function canReview(r: Pick<DonationRow, 'status'>): boolean {
  return r.status === 'uploaded';
}

/** The benchmark flag is meaningful once the lab has (or will have) the data. */
export function canBenchmark(r: Pick<DonationRow, 'status'>): boolean {
  return r.status === 'approved' || r.status === 'ingested';
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** What a decoded chunk header says, in the fields a row declares. */
export interface PreviewHeader {
  width: number;
  height: number;
  totalFrames: number;
  bytesPerPixel: 1 | 2;
  fps: number;
}

/** Differences between the first chunk's header and the donor's declared metadata. */
export function headerMismatches(
  h: PreviewHeader,
  r: Pick<DonationRow, 'width' | 'height' | 'n_frames' | 'bytes_per_pixel' | 'fps'>,
): string[] {
  const out: string[] = [];
  const pairs: [string, number, number][] = [
    ['width', h.width, r.width],
    ['height', h.height, r.height],
    ['frames', h.totalFrames, r.n_frames],
    ['bytes per pixel', h.bytesPerPixel, r.bytes_per_pixel],
  ];
  for (const [name, file, row] of pairs) {
    if (file !== row) out.push(`${name}: file ${file}, row ${row}`);
  }
  if (Math.abs(h.fps - r.fps) > 1e-6 * Math.max(1, Math.abs(r.fps))) {
    out.push(`fps: file ${h.fps}, row ${r.fps}`);
  }
  return out;
}

/** Per-pixel mean of equally sized frames (8- or 16-bit). */
export function meanImage(frames: readonly ArrayLike<number>[]): Float64Array {
  if (frames.length === 0) throw new Error('no frames to average');
  const n = frames[0].length;
  const sum = new Float64Array(n);
  for (const f of frames) {
    if (f.length !== n) throw new Error(`frame has ${f.length} pixels, not ${n}`);
    for (let i = 0; i < n; i++) sum[i] += f[i];
  }
  for (let i = 0; i < n; i++) sum[i] /= frames.length;
  return sum;
}

/** Opaque grey RGBA plus the pixel range that was mapped to 0..255. */
export interface StretchedImage {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  min: number;
  max: number;
}

/**
 * Map pixels to opaque grey RGBA, stretching min..max to 0..255 so 16-bit
 * frames that use a small part of their range are visible. A flat image is
 * black.
 */
export function contrastStretch(pixels: ArrayLike<number>): StretchedImage {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const g = span > 0 ? Math.round(((pixels[i] - min) / span) * 255) : 0;
    rgba[4 * i] = g;
    rgba[4 * i + 1] = g;
    rgba[4 * i + 2] = g;
    rgba[4 * i + 3] = 255;
  }
  return { rgba, min: pixels.length ? min : 0, max: pixels.length ? max : 0 };
}

/**
 * GET a presigned URL into memory, refusing bodies above `maxBytes` (the
 * largest chunk the edge function accepts). `fetchFn` is injectable for tests.
 */
export async function fetchPresigned(
  req: PresignedRequest,
  maxBytes: number,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetchFn(req.url, { method: 'GET', headers: req.headers });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`file is ${formatBytes(declared)}, more than ${formatBytes(maxBytes)}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error(`file is ${formatBytes(bytes.length)}, more than ${formatBytes(maxBytes)}`);
  }
  return bytes;
}

/** A rendered preview of one chunk. */
export interface DonationPreview {
  header: PreviewHeader & { firstFrame: number; frames: number; predictor: number };
  width: number;
  height: number;
  /** Mean over the chunk's frames, contrast-stretched. */
  mean: StretchedImage;
  /** First frame of the chunk, contrast-stretched. */
  first: StretchedImage;
  /** Header fields that disagree with the row. */
  mismatches: string[];
}

/**
 * Decode one CALARAW1 chunk file and build the mean image and first frame.
 * The decoder rejects malformed chunks with a CalarawError, which propagates.
 */
export async function buildPreview(
  gz: Uint8Array<ArrayBuffer>,
  row: Pick<DonationRow, 'width' | 'height' | 'n_frames' | 'bytes_per_pixel' | 'fps'>,
): Promise<DonationPreview> {
  const { header, frames } = await decodeCalarawChunk(gz);
  return {
    header,
    width: header.width,
    height: header.height,
    mean: contrastStretch(meanImage(frames)),
    first: contrastStretch(frames[0]),
    mismatches: headerMismatches(header, row),
  };
}
