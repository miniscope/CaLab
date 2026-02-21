// Auth gate: requires admin role. Shows sign-in form or access denied.

import { Show, type JSX, createSignal } from 'solid-js';
import { signInWithEmail, supabaseEnabled } from '@calab/community';
import { user, authLoading, isAdmin } from '../lib/admin-store.ts';

interface AdminGuardProps {
  children: JSX.Element;
}

export function AdminGuard(props: AdminGuardProps): JSX.Element {
  const [email, setEmail] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleSignIn = async () => {
    const addr = email().trim();
    if (!addr) return;
    setSending(true);
    setError(null);
    const result = await signInWithEmail(addr, window.location.href);
    if (result.error) {
      setError(result.error);
    } else {
      setSent(true);
    }
    setSending(false);
  };

  return (
    <Show
      when={!authLoading()}
      fallback={
        <div class="admin-guard">
          <div class="admin-guard__card">Loading...</div>
        </div>
      }
    >
      <Show
        when={supabaseEnabled}
        fallback={
          <div class="admin-guard">
            <div class="admin-guard__card">
              <h2>Configuration Required</h2>
              <p>Supabase environment variables are not configured.</p>
            </div>
          </div>
        }
      >
        <Show
          when={user()}
          fallback={
            <div class="admin-guard">
              <div class="admin-guard__card">
                <h2>CaLab Admin</h2>
                <p>Sign in with your admin account.</p>
                <Show
                  when={!sent()}
                  fallback={<p class="admin-guard__sent">Check your email for a sign-in link.</p>}
                >
                  <div class="admin-guard__form">
                    <input
                      type="email"
                      placeholder="admin@lab.edu"
                      value={email()}
                      onInput={(e) => setEmail(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSignIn();
                      }}
                    />
                    <button onClick={handleSignIn} disabled={sending()}>
                      {sending() ? 'Sending...' : 'Send Sign-In Link'}
                    </button>
                  </div>
                  <Show when={error()}>
                    <p class="admin-guard__error">{error()}</p>
                  </Show>
                </Show>
              </div>
            </div>
          }
        >
          <Show
            when={isAdmin()}
            fallback={
              <div class="admin-guard">
                <div class="admin-guard__card">
                  <h2>Access Denied</h2>
                  <p>Your account ({user()?.email}) does not have admin privileges.</p>
                </div>
              </div>
            }
          >
            {props.children}
          </Show>
        </Show>
      </Show>
    </Show>
  );
}
