// Supabase client singleton with graceful degradation.
// When VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set,
// lazily loads the Supabase SDK and creates a client. Otherwise
// returns null -- community features are hidden and the app works offline.
//
// The SDK (~45KB gzipped) is only fetched when getSupabase() is first
// called, keeping the initial bundle smaller for offline-only users.

import type { SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase credentials not configured. Community features will be disabled.',
  );
}

export const supabaseEnabled: boolean = !!(supabaseUrl && supabaseAnonKey);

let clientPromise: Promise<SupabaseClient | null> | null = null;

/** Lazily load the Supabase SDK and return a client singleton. */
export function getSupabase(): Promise<SupabaseClient | null> {
  if (!supabaseUrl || !supabaseAnonKey) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(supabaseUrl!, supabaseAnonKey!),
    );
  }
  return clientPromise;
}
