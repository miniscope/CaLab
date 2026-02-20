import { createSignal, Show } from 'solid-js';
import { AuthMenu } from '@calab/ui';
import { user, authLoading } from '../lib/auth-store.ts';
import { signInWithEmail, signOut, supabaseEnabled } from '@calab/community';

export function AuthMenuWrapper() {
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

  const signInForm = (
    <Show
      when={!sent()}
      fallback={
        <p style={{ margin: '0', 'font-size': '0.8rem', color: 'var(--text-secondary)' }}>
          Check your email for a sign-in link.
        </p>
      }
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
      >
        <input
          type="email"
          placeholder="you@lab.edu"
          value={email()}
          onInput={(e) => setEmail(e.currentTarget.value)}
          required
          style={{
            padding: '6px 8px',
            border: '1px solid var(--border-default)',
            'border-radius': 'var(--radius-sm)',
            'font-size': '0.8rem',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          class="btn-secondary btn-small"
          disabled={sending()}
          style={{ width: '100%' }}
        >
          {sending() ? 'Sending...' : 'Send Sign-In Link'}
        </button>
      </form>
      <Show when={error()}>
        <p style={{ margin: '0', 'font-size': '0.75rem', color: 'var(--error)' }}>{error()}</p>
      </Show>
    </Show>
  );

  return (
    <AuthMenu
      userEmail={user()?.email ?? null}
      loading={authLoading()}
      enabled={supabaseEnabled}
      onSignOut={() => signOut()}
      signInForm={signInForm}
    />
  );
}
