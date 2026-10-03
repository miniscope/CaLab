import type { Accessor } from 'solid-js';
import { createEffect, createSignal, Show } from 'solid-js';
import { AuthMenu } from './AuthMenu.tsx';

export interface AuthMenuWrapperProps {
  user: Accessor<{ email?: string } | null>;
  loading: Accessor<boolean>;
  enabled: boolean;
  signInWithEmail: (email: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export function AuthMenuWrapper(props: AuthMenuWrapperProps) {
  const [email, setEmail] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Reset form state when user signs out
  createEffect(() => {
    if (!props.user()) {
      setSent(false);
      setError(null);
      setEmail('');
    }
  });

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const addr = email().trim();
    if (!addr) return;
    setSending(true);
    setError(null);
    const result = await props.signInWithEmail(addr);
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
      fallback={<p class="auth-menu__sent">Check your email for a sign-in link.</p>}
    >
      <form onSubmit={handleSubmit} class="auth-menu__form-fields">
        <input
          type="email"
          placeholder="you@lab.edu"
          value={email()}
          onInput={(e) => setEmail(e.currentTarget.value)}
          required
          class="auth-menu__input"
        />
        <button
          type="submit"
          class="btn-secondary btn-small auth-menu__submit"
          disabled={sending()}
        >
          {sending() ? 'Sending...' : 'Send Sign-In Link'}
        </button>
      </form>
      <Show when={error()}>
        <p class="auth-menu__error">{error()}</p>
      </Show>
    </Show>
  );

  return (
    <AuthMenu
      userEmail={props.user()?.email ?? null}
      loading={props.loading()}
      enabled={props.enabled}
      onSignOut={() => props.signOut()}
      signInForm={signInForm}
    />
  );
}
