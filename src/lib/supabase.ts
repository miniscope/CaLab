// Supabase client singleton with graceful degradation.
// When VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set,
// exports a live Supabase client. Otherwise exports null --
// community features are hidden and the app works offline.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase credentials not configured. Community features will be disabled.',
  );
}

export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

export const supabaseEnabled: boolean = supabase !== null;
