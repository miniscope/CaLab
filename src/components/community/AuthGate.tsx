/**
 * Authentication gate for community features.
 * Shows GitHub/Google login buttons when unauthenticated,
 * user info with sign-out when authenticated.
 * Reads from the global community-store -- no props needed.
 */

import { Show } from 'solid-js';
import {
  user,
  authLoading,
  signInWithGitHub,
  signInWithGoogle,
  signOut,
} from '../../lib/community/community-store';

export function AuthGate() {
  return (
    <div class="auth-gate">
      <Show when={!authLoading()} fallback={<span class="auth-gate__loading">Loading...</span>}>
        <Show
          when={user()}
          fallback={
            <div class="auth-gate__login">
              <div class="auth-gate__buttons">
                <button
                  class="auth-gate__btn auth-gate__btn--github"
                  onClick={() => signInWithGitHub()}
                >
                  Sign in with GitHub
                </button>
                <button
                  class="auth-gate__btn auth-gate__btn--google"
                  onClick={() => signInWithGoogle()}
                >
                  Sign in with Google
                </button>
              </div>
              <p class="auth-gate__prompt">
                Sign in to share parameters with the community
              </p>
            </div>
          }
        >
          <div class="auth-gate__user-row">
            <span class="auth-gate__email">
              {user()?.email ?? 'Authenticated'}
            </span>
            <button
              class="auth-gate__btn auth-gate__btn--signout"
              onClick={() => signOut()}
            >
              Sign Out
            </button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
