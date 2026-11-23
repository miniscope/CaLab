import { describe, expect, it, vi } from 'vitest';

const order = vi.fn();
const select = vi.fn(() => ({ order }));
const from = vi.fn(() => ({ select }));
vi.mock('../donation-auth.ts', () => ({
  getDonationSupabase: async () => ({ from }),
}));

import { listPublicDonations } from '../donation-service.ts';

describe('listPublicDonations', () => {
  it('reads the public view, newest first', async () => {
    order.mockResolvedValueOnce({ data: [{ id: 'x', dandi_path: 'sub-a/a.nwb' }], error: null });
    const rows = await listPublicDonations();
    expect(from).toHaveBeenCalledWith('cala_donations_public');
    expect(order).toHaveBeenCalledWith('published_at', { ascending: false });
    expect(rows).toEqual([{ id: 'x', dandi_path: 'sub-a/a.nwb' }]);
  });

  it('turns a database error into a DonationApiError', async () => {
    order.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(listPublicDonations()).rejects.toThrow('boom');
  });
});
