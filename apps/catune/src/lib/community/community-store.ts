// Reactive auth and community data signals.
// Subscribes to Supabase onAuthStateChange and pipes auth events
// into SolidJS signals for reactive UI updates.
// When Supabase is not configured, sets authLoading to false immediately.

import { createSignal } from 'solid-js';
import type { User } from '@supabase/supabase-js';
import {
  getSupabase,
  supabaseEnabled,
  fetchFieldOptions,
  INDICATOR_OPTIONS,
  SPECIES_OPTIONS,
  BRAIN_REGION_OPTIONS,
  MICROSCOPE_TYPE_OPTIONS,
  CELL_TYPE_OPTIONS,
} from '@calab/community';
import type { FieldOptions } from '@calab/community';

// --- Auth signals ---

const [user, setUser] = createSignal<User | null>(null);
const [authLoading, setAuthLoading] = createSignal<boolean>(true);

// --- Field options signals ---

const [fieldOptions, setFieldOptions] = createSignal<FieldOptions>({
  indicators: INDICATOR_OPTIONS,
  species: SPECIES_OPTIONS,
  brainRegions: BRAIN_REGION_OPTIONS,
  microscopeTypes: MICROSCOPE_TYPE_OPTIONS,
  cellTypes: CELL_TYPE_OPTIONS,
});
const [fieldOptionsLoading, setFieldOptionsLoading] = createSignal(false);
let fieldOptionsLoaded = false;

/**
 * Load canonical field options from Supabase.
 * Idempotent — only fetches once. Falls back to hardcoded arrays on failure.
 */
async function loadFieldOptions(): Promise<void> {
  if (fieldOptionsLoaded || fieldOptionsLoading()) return;
  if (!supabaseEnabled) return; // Keep fallback arrays

  setFieldOptionsLoading(true);
  try {
    const opts = await fetchFieldOptions();
    setFieldOptions(opts);
    fieldOptionsLoaded = true;
  } catch (err) {
    console.warn('Failed to load field options from DB, using fallback:', err);
  } finally {
    setFieldOptionsLoading(false);
  }
}

// --- Auth initialization ---

if (supabaseEnabled) {
  // Lazily load the SDK, then subscribe to auth events
  getSupabase().then((client) => {
    if (!client) {
      setAuthLoading(false);
      return;
    }

    // Subscribe to auth state changes (no async in callback per Supabase docs)
    client.auth.onAuthStateChange((_event, sess) => {
      setUser(sess?.user ?? null);
      setAuthLoading(false);
    });

    // Load initial session
    client.auth.getSession().then(({ data: { session: sess } }) => {
      setUser(sess?.user ?? null);
      setAuthLoading(false);
    });
  });
} else {
  // No Supabase configured -- mark auth as done immediately
  setAuthLoading(false);
}

// --- Auth actions ---

/** Sign in with email magic link. Sends a login link to the user's email. */
async function signInWithEmail(email: string): Promise<{ error: string | null }> {
  const client = await getSupabase();
  if (!client) return { error: 'Community features not configured' };
  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin + (import.meta.env.BASE_URL || '/'),
    },
  });
  if (error) {
    console.error('Email sign-in error:', error.message);
    return { error: error.message };
  }
  return { error: null };
}

/** Sign out of the current session (local scope only). */
async function signOut(): Promise<void> {
  const client = await getSupabase();
  if (!client) return;
  await client.auth.signOut({ scope: 'local' });
}

// --- Exports ---

export {
  // Auth signals (getters)
  user,
  authLoading,
  // Field options
  fieldOptions,
  fieldOptionsLoading,
  loadFieldOptions,
  // Auth actions
  signInWithEmail,
  signOut,
};
