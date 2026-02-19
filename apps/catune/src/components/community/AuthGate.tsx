/**
 * Authentication gate for community features.
 * Shows email sign-in form when unauthenticated,
 * user info with sign-out when authenticated.
 * Reads from the global community-store -- no props needed.
 */

import { Show, createSignal } from 'solid-js';
import { user, authLoading, signInWithEmail, signOut } from '../../lib/community/index.ts';

export function AuthGate() {
  const [email, setEmail] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const addr = email().trim();
    if (!addr) return;
    setSending(true);
    setError(null);
    const result = await signInWithEmail(addr);
    setSending(false);
    if (result.error) {
      setError(result.error);
    } else {
      setSent(true);
    }
  }

  return (
    <div class="auth-gate">
      <Show when={!authLoading()} fallback={<span class="auth-gate__loading">Loading...</span>}>
        <Show
          when={user()}
          fallback={
            <div class="auth-gate__login">
              <Show
                when={!sent()}
                fallback={
                  <p class="auth-gate__sent">
                    Check your email for a login link. Click it to sign in.
                  </p>
                }
              >
                <form class="auth-gate__form" onSubmit={handleSubmit}>
                  <input
                    class="auth-gate__input"
                    type="email"
                    placeholder="you@lab.edu"
                    value={email()}
                    onInput={(e) => setEmail(e.currentTarget.value)}
                    required
                  />
                  <button class="auth-gate__btn" type="submit" disabled={sending()}>
                    {sending() ? 'Sending...' : 'Sign in with Email'}
                  </button>
                </form>
                <Show when={error()}>
                  <p class="auth-gate__error">{error()}</p>
                </Show>
                <p class="auth-gate__prompt">Sign in to share parameters with the community</p>
              </Show>
            </div>
          }
        >
          <div class="auth-gate__user-row">
            <span class="auth-gate__email">{user()?.email ?? 'Authenticated'}</span>
            <button class="auth-gate__btn auth-gate__btn--signout" onClick={() => signOut()}>
              Sign Out
            </button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
