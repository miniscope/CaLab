import type { Accessor } from 'solid-js';
import { Show } from 'solid-js';

export interface AuthCallbackProps {
  user: Accessor<{ email?: string } | null>;
  loading: Accessor<boolean>;
}

/**
 * Lightweight page shown when a Supabase magic-link redirects here.
 * The Supabase client automatically parses the hash fragment and stores
 * the session in localStorage, which the original tab picks up via
 * cross-tab storage events.
 */
export function AuthCallback(props: AuthCallbackProps) {
  return (
    <div class="auth-callback">
      <div class="auth-callback__card">
        <Show
          when={!props.loading()}
          fallback={<p class="auth-callback__status">Verifying your sign-in...</p>}
        >
          <Show
            when={props.user()}
            fallback={
              <>
                <h2 class="auth-callback__heading auth-callback__heading--error">Sign-in failed</h2>
                <p class="auth-callback__text">
                  The link may have expired. Please return to CaLab and request a new sign-in link.
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
                  You can close this tab and return to the CaLab tab where you requested sign-in.
                  Your session is already active there.
                </p>
              </>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
