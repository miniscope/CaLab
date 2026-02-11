// Reactive auth and community data signals.
// Subscribes to Supabase onAuthStateChange and pipes auth events
// into SolidJS signals for reactive UI updates.
// When Supabase is not configured, sets authLoading to false immediately.

import { createSignal } from 'solid-js';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '../supabase.ts';
import type { CommunitySubmission, FilterState } from './types.ts';

// --- Auth signals ---

const [user, setUser] = createSignal<User | null>(null);
const [session, setSession] = createSignal<Session | null>(null);
const [authLoading, setAuthLoading] = createSignal<boolean>(true);

// --- Community data signals ---

const [submissions, setSubmissions] = createSignal<CommunitySubmission[]>([]);
const [filters, setFilters] = createSignal<FilterState>({
  indicator: null,
  species: null,
  brainRegion: null,
});
const [browsing, setBrowsing] = createSignal<boolean>(false);
const [lastFetched, setLastFetched] = createSignal<number | null>(null);

// --- Auth initialization ---

if (supabase) {
  // Subscribe to auth state changes (no async in callback per Supabase docs)
  supabase.auth.onAuthStateChange((_event, sess) => {
    setSession(sess);
    setUser(sess?.user ?? null);
    setAuthLoading(false);
  });

  // Load initial session
  supabase.auth.getSession().then(({ data: { session: sess } }) => {
    setSession(sess);
    setUser(sess?.user ?? null);
    setAuthLoading(false);
  });
} else {
  // No Supabase configured -- mark auth as done immediately
  setAuthLoading(false);
}

// --- Auth actions ---

/** Sign in with GitHub OAuth. Redirects to GitHub and back. */
async function signInWithGitHub(): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: window.location.origin + (import.meta.env.BASE_URL || '/'),
    },
  });
  if (error) console.error('GitHub sign-in error:', error.message);
}

/** Sign in with Google OAuth. Redirects to Google and back. */
async function signInWithGoogle(): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + (import.meta.env.BASE_URL || '/'),
    },
  });
  if (error) console.error('Google sign-in error:', error.message);
}

/** Sign out of the current session (local scope only). */
async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut({ scope: 'local' });
}

// --- Exports ---

export {
  // Auth signals (getters)
  user,
  session,
  authLoading,
  // Community data signals (getters)
  submissions,
  filters,
  browsing,
  lastFetched,
  // Community data setters
  setSubmissions,
  setFilters,
  setBrowsing,
  setLastFetched,
  // Auth actions
  signInWithGitHub,
  signInWithGoogle,
  signOut,
};
