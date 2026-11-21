import { describe, expect, it } from 'vitest';
import { donationReturnUrl, tokensFromHash, urlWithoutDonationReturn } from '../donation-auth.ts';

describe('donation sign-in link helpers', () => {
  it('flags the return URL and drops any fragment, keeping other query params', () => {
    const u = new URL(donationReturnUrl('https://miniscope.github.io/CaLab/cala/?compress#x'));
    expect(u.pathname).toBe('/CaLab/cala/');
    expect(u.searchParams.get('compress')).toBe('');
    expect(u.searchParams.get('donation_auth')).toBe('1');
    expect(u.hash).toBe('');
  });

  it('reads both tokens from a magic-link fragment', () => {
    expect(tokensFromHash('#access_token=a.b.c&refresh_token=r1&type=magiclink')).toEqual({
      access_token: 'a.b.c',
      refresh_token: 'r1',
    });
    expect(tokensFromHash('#error=access_denied&error_description=expired')).toBeNull();
    expect(tokensFromHash('')).toBeNull();
  });

  it('cleans the flag and the tokens out of the URL afterwards', () => {
    expect(
      urlWithoutDonationReturn(
        'http://localhost:5173/?donation_auth=1&compress#access_token=a&refresh_token=b',
      ),
    ).toBe('http://localhost:5173/?compress=');
  });
});
