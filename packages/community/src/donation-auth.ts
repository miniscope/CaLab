// Sign-in and client for data donation (apps/cala/docs/data-donation.md).
//
// Donations can live in a Supabase project of their own, apart from the
// community project (analytics, CaTune / CaDecon submissions): set
// VITE_DONATION_SUPABASE_URL and VITE_DONATION_SUPABASE_ANON_KEY. Then the
// donor signs in to that project separately, with its own stored session
// (`storageKey`). Without them, donation uses the community client and its
// sign-in, exactly as before.

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createSignal } from 'solid-js';
import { realUser, signInWithEmail, signOut } from './auth.ts';
import { authLoading, user } from './community-store.ts';
import {
  DONATION_AUTH_PARAM,
  donationSupabaseAnonKey,
  donationSupabaseUrl,
  getSupabase,
  isDonationAuthReturn,
  separateDonationProject,
  supabaseEnabled,
} from './supabase.ts';

export { isDonationAuthReturn, separateDonationProject };

/** Donation is offered when either project is configured. */
export const donationEnabled: boolean = separateDonationProject || supabaseEnabled;

const STORAGE_KEY = 'calab-donation-auth';

/**
 * The address the page was opened with, read when this module loads: an app
 * that routes by the URL fragment (the admin app's `#/donations`) rewrites it
 * right after, which would drop a sign-in link's `#access_token=...`.
 */
const landingHref = typeof window === 'undefined' ? '' : window.location.href;

let clientPromise: Promise<SupabaseClient | null> | null = null;

/** The Supabase client donations use (the community client unless a separate project is set). */
export function getDonationSupabase(): Promise<SupabaseClient | null> {
  if (!separateDonationProject) return getSupabase();
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(async ({ createClient }) => {
      const client = createClient(donationSupabaseUrl!, donationSupabaseAnonKey!, {
        // The tokens of a donation sign-in link are taken in `consumeReturn`,
        // only when the link carries DONATION_AUTH_PARAM.
        auth: { storageKey: STORAGE_KEY, detectSessionInUrl: false },
      });
      await consumeReturn(client);
      return client;
    });
  }
  return clientPromise;
}

/** Tokens from a sign-in link's URL fragment (`#access_token=...&refresh_token=...`). */
export function tokensFromHash(
  hash: string,
): { access_token: string; refresh_token: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const access = p.get('access_token');
  const refresh = p.get('refresh_token');
  return access && refresh ? { access_token: access, refresh_token: refresh } : null;
}

/** `href` without the donation sign-in flag, and without the fragment if it holds sign-in data. */
export function urlWithoutDonationReturn(href: string): string {
  const u = new URL(href);
  u.searchParams.delete(DONATION_AUTH_PARAM);
  if (/(^#|&)(access_token|refresh_token|error)=/.test(u.hash)) u.hash = '';
  return u.toString();
}

/** Why a sign-in link did not sign in: Supabase's own message from the link, if any. */
export function linkError(href: string): string | null {
  const u = new URL(href);
  const fromHash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const msg =
    fromHash.get('error_description') ??
    u.searchParams.get('error_description') ??
    fromHash.get('error') ??
    u.searchParams.get('error');
  if (msg) return msg.replace(/\+/g, ' ');
  if (u.searchParams.has('code'))
    return 'the link uses the PKCE code flow, which this page does not handle';
  return null;
}

const [returnError, setReturnError] = createSignal<string | null>(null);

/** Why the last donation sign-in link failed (null: it did not, or none was used). */
export function donationAuthError(): string | null {
  return returnError();
}

async function consumeReturn(client: SupabaseClient): Promise<void> {
  if (!isDonationAuthReturn()) return;
  const href = landingHref || window.location.href;
  const tokens = tokensFromHash(new URL(href).hash);
  if (tokens) {
    const { error } = await client.auth.setSession(tokens);
    if (error) setReturnError(error.message);
  } else {
    setReturnError(linkError(href) ?? 'the link carried no sign-in tokens');
  }
  if (returnError()) console.error('Donation sign-in failed:', returnError());
  // Clean the live URL (which may carry the app's own route fragment by now).
  window.history.replaceState(null, '', urlWithoutDonationReturn(window.location.href));
}

/** Where a donation sign-in link should return: this page, flagged for the donation client. */
export function donationReturnUrl(href: string): string {
  const u = new URL(href);
  u.hash = '';
  u.searchParams.set(DONATION_AUTH_PARAM, '1');
  return u.toString();
}

// --- Reactive state (separate project only; otherwise the community store) ---

const [donationUserSignal, setDonationUser] = createSignal<User | null>(null);
const [donationLoadingSignal, setDonationLoading] = createSignal(true);
let started = false;

/** Start following the donation sign-in. Idempotent; call at app start so a sign-in link is consumed. */
export function initDonationAuth(): void {
  if (!separateDonationProject || started) return;
  started = true;
  void getDonationSupabase().then((client) => {
    if (!client) {
      setDonationLoading(false);
      return;
    }
    client.auth.onAuthStateChange((_event, session) => {
      setDonationUser(realUser(session?.user));
      setDonationLoading(false);
    });
    void client.auth.getSession().then(({ data: { session } }) => {
      setDonationUser(realUser(session?.user));
      setDonationLoading(false);
    });
  });
}

/** The donor signed in for donations (real, non-anonymous), or null. */
export function donationUser(): User | null {
  if (!separateDonationProject) return user();
  initDonationAuth();
  return donationUserSignal();
}

/** True until the donation sign-in state is known. */
export function donationAuthLoading(): boolean {
  if (!separateDonationProject) return authLoading();
  initDonationAuth();
  return donationLoadingSignal();
}

/** Email a sign-in link for donating. */
export async function signInForDonation(email: string): Promise<{ error: string | null }> {
  if (!separateDonationProject) return signInWithEmail(email);
  const client = await getDonationSupabase();
  if (!client) return { error: 'Donation is not configured' };
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: donationReturnUrl(window.location.href) },
  });
  if (error) {
    console.error('Donation sign-in error:', error.message);
    return { error: error.message };
  }
  return { error: null };
}

/** Sign out of the donation session (local scope). */
export async function signOutDonation(): Promise<void> {
  if (!separateDonationProject) return signOut();
  const client = await getDonationSupabase();
  await client?.auth.signOut({ scope: 'local' });
}
