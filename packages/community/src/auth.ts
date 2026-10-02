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
 * Return `user` only if it is a real (non-anonymous) account.
 *
 * Every app calls `signInAnonymously()` at load so analytics writes carry a
 * verified JWT. Those anonymous-auth users are not "signed in" from the
 * product's point of view: the database refuses their community submissions
 * (migration 012), so the UI must keep showing the email sign-in prompt.
 */
export function realUser(user: User | null | undefined): User | null {
  return user && !user.is_anonymous ? user : null;
}

/**
 * Subscribe to Supabase auth state changes.
 * Returns an unsubscribe function. If Supabase is not configured,
 * immediately calls the callback with { user: null, loading: false }
 * and returns a no-op unsubscribe.
 *
 * Anonymous-auth sessions are reported as `user: null` (see `realUser`).
 */
export function subscribeAuth(callback: (state: AuthState) => void): () => void {
  if (!supabaseEnabled) {
    callback({ user: null, loading: false });
    return () => {};
  }

  let unsubscribe = () => {};
  let disposed = false;

  // Fire-and-forget: SDK loads lazily, then subscribes to auth events
  void getSupabase().then((client) => {
    if (!client) {
      if (!disposed) callback({ user: null, loading: false });
      return;
    }

    // Subscribe to auth state changes
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      if (!disposed) callback({ user: realUser(session?.user), loading: false });
    });

    // If cleanup was called before the promise resolved, unsubscribe immediately
    if (disposed) {
      subscription.unsubscribe();
      return;
    }

    unsubscribe = () => subscription.unsubscribe();

    // Load initial session
    client.auth.getSession().then(({ data: { session } }) => {
      if (!disposed) callback({ user: realUser(session?.user), loading: false });
    });
  });

  return () => {
    disposed = true;
    unsubscribe();
  };
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
        window.location.origin +
          ((import.meta as unknown as { env: Record<string, string> }).env.BASE_URL || '/'),
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
