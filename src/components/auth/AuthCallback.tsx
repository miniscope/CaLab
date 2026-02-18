import { Show } from 'solid-js';
import { user, authLoading } from '../../lib/community/community-store.ts';

/**
 * Lightweight page shown when a Supabase magic-link redirects here.
 * The Supabase client (initialized in community-store) automatically
 * parses the hash fragment and stores the session in localStorage,
 * which the original tab picks up via cross-tab storage events.
 */
export function AuthCallback() {
  return (
    <div class="auth-callback">
      <div class="auth-callback__card">
        <Show
          when={!authLoading()}
          fallback={
            <p class="auth-callback__status">Verifying your sign-in...</p>
          }
        >
          <Show
            when={user()}
            fallback={
              <>
                <h2 class="auth-callback__heading auth-callback__heading--error">
                  Sign-in failed
                </h2>
                <p class="auth-callback__text">
                  The link may have expired. Please return to CaTune and
                  request a new sign-in link.
                </p>
              </>
            }
          >
            {(u) => (
              <>
                <div class="auth-callback__icon">&#10003;</div>
                <h2 class="auth-callback__heading">You're signed in</h2>
                <p class="auth-callback__email">{u().email}</p>
                <p class="auth-callback__text">
                  You can close this tab and return to the CaTune tab
                  where you requested sign-in. Your session is already active there.
                </p>
              </>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
