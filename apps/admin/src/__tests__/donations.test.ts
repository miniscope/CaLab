// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DonationRow } from '@calab/community';
import { CalarawError, encodeCalarawChunk, type CalarawMeta } from '@calab/io';
import {
  buildPreview,
  canBenchmark,
  canReview,
  contrastStretch,
  countByStatus,
  fetchPresigned,
  filterDonations,
  formatBytes,
  formatCredit,
  formatDuration,
  headerMismatches,
  meanImage,
} from '../lib/donations.ts';

function donation(over: Partial<DonationRow> = {}): DonationRow {
  return {
    id: 'd1',
    user_id: 'u1',
    created_at: '2026-11-19T10:00:00Z',
    updated_at: '2026-11-19T10:00:00Z',
    status: 'uploaded',
    indicator: 'GCaMP6f',
    species: 'mouse',
    brain_region: 'CA1',
    scope: 'UCLA v4',
    fps: 20,
    width: 5,
    height: 4,
    n_frames: 7,
    bytes_per_pixel: 2,
    cala_version: '2.19.1',
    license: 'cc-by-4.0',
    rights_attested: true,
    protocol_attested: true,
    contact_ok: true,
    declared_bytes: 1234,
    n_chunks: 1,
    files: [{ name: 'frames-0000.calaraw.gz', bytes: 1234 }],
    in_benchmark: false,
    benchmark_note: null,
    review_note: null,
    ...over,
  };
}

describe('table helpers', () => {
  const rows = [
    donation({ id: 'a', status: 'uploaded' }),
    donation({ id: 'b', status: 'approved' }),
    donation({ id: 'c', status: 'uploaded' }),
  ];

  it('filters by status, all keeps every row', () => {
    expect(filterDonations(rows, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(filterDonations(rows, 'uploaded').map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterDonations(rows, 'ingested')).toEqual([]);
  });

  it('counts every status, including empty ones', () => {
    const c = countByStatus(rows);
    expect(c.uploaded).toBe(2);
    expect(c.approved).toBe(1);
    expect(c.withdrawn).toBe(0);
  });

  it('formats sizes in binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5.2 * 1024 ** 3)).toBe('5.2 GB');
    expect(formatBytes(null)).toBe('-');
    expect(formatBytes(-1)).toBe('-');
  });

  it('formats recording length', () => {
    expect(formatDuration(600, 20)).toBe('30 s');
    expect(formatDuration(24000, 20)).toBe('20 min');
    expect(formatDuration(1250, 20)).toBe('1 min 3 s');
    expect(formatDuration(10, 0)).toBe('-');
  });

  it('joins credit fields, skipping blanks', () => {
    expect(formatCredit({ credit_name: 'A. B.', credit_lab: 'Lab X' })).toBe('A. B., Lab X');
    expect(formatCredit({ credit_name: ' ', credit_lab: 'Lab X' })).toBe('Lab X');
    expect(formatCredit({ credit_name: null, credit_lab: undefined })).toBe('');
  });

  it('allows review only for uploaded, benchmark only for approved or ingested', () => {
    expect(canReview({ status: 'uploaded' })).toBe(true);
    expect(canReview({ status: 'approved' })).toBe(false);
    expect(canBenchmark({ status: 'approved' })).toBe(true);
    expect(canBenchmark({ status: 'ingested' })).toBe(true);
    expect(canBenchmark({ status: 'rejected' })).toBe(false);
  });
});

describe('image helpers', () => {
  it('averages frames per pixel, 16-bit included', () => {
    const m = meanImage([new Uint16Array([0, 65535, 10]), new Uint16Array([2, 65535, 20])]);
    expect(Array.from(m)).toEqual([1, 65535, 15]);
  });

  it('refuses no frames or frames of different size', () => {
    expect(() => meanImage([])).toThrow();
    expect(() => meanImage([new Uint8Array(2), new Uint8Array(3)])).toThrow();
  });

  it('stretches min..max to 0..255 opaque grey', () => {
    const { rgba, min, max } = contrastStretch(new Uint16Array([1000, 1500, 2000]));
    expect(min).toBe(1000);
    expect(max).toBe(2000);
    expect(Array.from(rgba)).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
  });

  it('renders a flat image black instead of dividing by zero', () => {
    const { rgba } = contrastStretch(new Uint8Array([7, 7]));
    expect(Array.from(rgba)).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });
});

describe('header check', () => {
  const h = { width: 5, height: 4, totalFrames: 7, bytesPerPixel: 2 as const, fps: 20 };

  it('is empty when the chunk agrees with the row', () => {
    expect(headerMismatches(h, donation())).toEqual([]);
  });

  it('lists each disagreeing field', () => {
    const out = headerMismatches(h, donation({ width: 6, n_frames: 8, fps: 30 }));
    expect(out).toEqual(['width: file 5, row 6', 'frames: file 7, row 8', 'fps: file 20, row 30']);
  });
});

describe('buildPreview', () => {
  const meta: CalarawMeta = {
    width: 5,
    height: 4,
    totalFrames: 7,
    bytesPerPixel: 2,
    predictor: 1,
    fps: 20,
  };
  const frame = (t: number) => Uint16Array.from({ length: 20 }, (_, i) => 1000 + 100 * i + t);

  it('decodes a 16-bit chunk into mean and first-frame images', async () => {
    const gz = (await encodeCalarawChunk(meta, 0, [frame(0), frame(2)])) as Uint8Array<ArrayBuffer>;
    const p = await buildPreview(gz, donation());
    expect(p.width).toBe(5);
    expect(p.height).toBe(4);
    expect(p.header.frames).toBe(2);
    expect(p.first.min).toBe(1000);
    expect(p.first.max).toBe(2900);
    expect(p.mean.min).toBe(1001);
    expect(p.mean.rgba.length).toBe(5 * 4 * 4);
    expect(p.mismatches).toEqual([]);
  });

  it('reports a chunk that disagrees with the row', async () => {
    const gz = (await encodeCalarawChunk(meta, 0, [frame(0)])) as Uint8Array<ArrayBuffer>;
    const p = await buildPreview(gz, donation({ bytes_per_pixel: 1 }));
    expect(p.mismatches).toEqual(['bytes per pixel: file 2, row 1']);
  });

  it('rejects bytes that are not a chunk', async () => {
    const junk = new Uint8Array([1, 2, 3, 4]);
    await expect(buildPreview(junk, donation())).rejects.toBeInstanceOf(CalarawError);
  });
});

describe('fetchPresigned', () => {
  const req = { url: 'https://r2.example/x', headers: { a: 'b' }, expires_in: 60 };

  it('returns the body and sends the presigned headers', async () => {
    let seen: RequestInit | undefined;
    const fake = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const out = await fetchPresigned(req, 10, fake);
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(seen?.headers).toEqual({ a: 'b' });
  });

  it('fails on an HTTP error or a body above the cap', async () => {
    const notFound = (async () => new Response('no', { status: 404 })) as typeof fetch;
    await expect(fetchPresigned(req, 10, notFound)).rejects.toThrow('404');
    const big = (async () => new Response(new Uint8Array(20))) as typeof fetch;
    await expect(fetchPresigned(req, 10, big)).rejects.toThrow('more than');
  });
});
