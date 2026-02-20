// Shared auth helpers for any CaLab app.
// Wraps Supabase auth with graceful degradation when not configured.

import type { User } from '@supabase/supabase-js';
import { getSupabase, supabaseEnabled } from './supabase.ts';

export type { User };

export interface AuthState {
  user: User | null;
  loading: boolean;
}

/**
 * Subscribe to Supabase auth state changes.
 * Returns an unsubscribe function. If Supabase is not configured,
 * immediately calls the callback with { user: null, loading: false }
 * and returns a no-op unsubscribe.
 */
export function subscribeAuth(callback: (state: AuthState) => void): () => void {
  if (!supabaseEnabled) {
    callback({ user: null, loading: false });
    return () => {};
  }

  let unsubscribe = () => {};

  // Fire-and-forget: SDK loads lazily, then subscribes to auth events
  void getSupabase().then((client) => {
    if (!client) {
      callback({ user: null, loading: false });
      return;
    }

    // Subscribe to auth state changes
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      callback({ user: session?.user ?? null, loading: false });
    });

    unsubscribe = () => subscription.unsubscribe();

    // Load initial session
    client.auth.getSession().then(({ data: { session } }) => {
      callback({ user: session?.user ?? null, loading: false });
    });
  });

  return () => unsubscribe();
}

/** Sign in with email magic link. */
export async function signInWithEmail(
  email: string,
  redirectTo?: string,
): Promise<{ error: string | null }> {
  const client = await getSupabase();
  if (!client) return { error: 'Community features not configured' };

  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo:
        redirectTo ??
        window.location.origin + ((import.meta.env as Record<string, string>).BASE_URL || '/'),
    },
  });

  if (error) {
    console.error('Email sign-in error:', error.message);
    return { error: error.message };
  }
  return { error: null };
}

/** Sign out of the current session (local scope only). */
export async function signOut(): Promise<void> {
  const client = await getSupabase();
  if (!client) return;
  await client.auth.signOut({ scope: 'local' });
}
