import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { DonationRow } from '@calab/community';

const api = vi.hoisted(() => ({
  listDonations: vi.fn(),
  reviewDonation: vi.fn(),
  setDonationBenchmark: vi.fn(),
  donationPreviewUrl: vi.fn(),
}));
vi.mock('@calab/community', () => ({
  ...api,
  DONATION_MAX_CHUNK_BYTES: 100 * 1024 * 1024,
  // One Supabase project for everything: no separate donation sign-in.
  separateDonationProject: false,
  donationUser: () => null,
  donationAuthLoading: () => false,
  signInForDonation: async () => ({ error: null }),
  signOutDonation: async () => {},
}));
// The sign-in UI is only shown for a separate donation project.
vi.mock('@calab/community-ui', () => ({ AuthGate: () => null }));

import { DonationsView } from '../components/DonationsView.tsx';

function row(over: Partial<DonationRow>): DonationRow {
  return {
    id: 'aaaaaaaa-0000',
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
    sharing: 'public',
    subject_id: 'm7',
    subject_sex: 'F',
    subject_age: 'P90D',
    session_date: '2026-11-20',
    genotype: null,
    dandi_path: null,
    published_at: null,
    rights_attested: true,
    protocol_attested: true,
    contact_ok: true,
    declared_bytes: 2048,
    n_chunks: 1,
    files: [{ name: 'frames-0000.calaraw.gz', bytes: 2048 }],
    in_benchmark: false,
    benchmark_note: null,
    review_note: null,
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const buttons = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll('button')).filter((b) => b.textContent?.trim() === text);

describe('DonationsView', () => {
  let el: HTMLDivElement;
  let dispose: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    api.listDonations.mockResolvedValue([
      row({ id: 'aaaaaaaa-0000', status: 'uploaded', scope: 'UCLA v4' }),
      row({ id: 'bbbbbbbb-0000', status: 'approved', scope: 'Inscopix' }),
    ]);
    api.reviewDonation.mockResolvedValue(undefined);
    el = document.createElement('div');
    document.body.appendChild(el);
    dispose = render(() => <DonationsView />, el);
    await flush();
  });

  afterEach(() => {
    dispose();
    el.remove();
  });

  it('shows the sharing column', () => {
    const headers = Array.from(el.querySelectorAll('thead th')).map((th) => th.textContent ?? '');
    expect(headers.some((h) => h.includes('Sharing'))).toBe(true);
  });

  it('lists uploaded donations by default and filters by status', async () => {
    expect(el.textContent).toContain('UCLA v4');
    expect(el.textContent).not.toContain('Inscopix');
    const select = el.querySelector('select') as HTMLSelectElement;
    select.value = 'all';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(el.textContent).toContain('Inscopix');
    expect(el.textContent).toContain('2.0 KB');
  });

  it('opens a drawer with review buttons and confirms before reject', async () => {
    (el.querySelector('tbody tr') as HTMLElement).click();
    await flush();
    expect(document.body.textContent).toContain('Donation aaaaaaaa');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    buttons(document.body, 'Reject')[0].click();
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(api.reviewDonation).not.toHaveBeenCalled();
    buttons(document.body, 'Approve')[0].click();
    await flush();
    expect(api.reviewDonation).toHaveBeenCalledWith('aaaaaaaa-0000', 'approve', undefined);
    expect(api.listDonations).toHaveBeenCalledTimes(2);
    confirmSpy.mockRestore();
  });

  it('shows the decode error when the preview is not a CALARAW chunk', async () => {
    (el.querySelector('tbody tr') as HTMLElement).click();
    await flush();
    api.donationPreviewUrl.mockResolvedValue({
      url: 'https://r2.example/x',
      headers: {},
      expires_in: 60,
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    buttons(document.body, 'Preview first chunk')[0].click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Preview failed'));
    fetchSpy.mockRestore();
  });
});
