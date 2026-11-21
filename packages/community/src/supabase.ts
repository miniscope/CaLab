// Supabase client singleton with graceful degradation.
// When VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set,
// lazily loads the Supabase SDK and creates a client. Otherwise
// returns null -- community features are hidden and the app works offline.
//
// The SDK (~45KB gzipped) is only fetched when getSupabase() is first
// called, keeping the initial bundle smaller for offline-only users.

import type { SupabaseClient } from '@supabase/supabase-js';

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
export const supabaseUrl = env.VITE_SUPABASE_URL;
export const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials not configured. Community features will be disabled.');
}

export const supabaseEnabled: boolean = !!(supabaseUrl && supabaseAnonKey);

// Data donation may use a Supabase project of its own (VITE_DONATION_SUPABASE_URL /
// _ANON_KEY, see donation-auth.ts). Its sign-in links come back with this query
// flag; the community client must then leave the tokens in the URL alone.
export const donationSupabaseUrl = env.VITE_DONATION_SUPABASE_URL;
export const donationSupabaseAnonKey = env.VITE_DONATION_SUPABASE_ANON_KEY;
export const separateDonationProject: boolean = !!(donationSupabaseUrl && donationSupabaseAnonKey);
export const DONATION_AUTH_PARAM = 'donation_auth';

/** True on the page a donation sign-in link opens (separate donation project only). */
export function isDonationAuthReturn(): boolean {
  return (
    separateDonationProject &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has(DONATION_AUTH_PARAM)
  );
}

let clientPromise: Promise<SupabaseClient | null> | null = null;

/** Lazily load the Supabase SDK and return a client singleton. */
export function getSupabase(): Promise<SupabaseClient | null> {
  if (!supabaseUrl || !supabaseAnonKey) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(supabaseUrl!, supabaseAnonKey!, {
        auth: { detectSessionInUrl: !isDonationAuthReturn() },
      }),
    );
  }
  return clientPromise;
}
